/**
 * 一位好友的全部本机内容：和他的聊天、他发出的图片、他的朋友圈。
 *
 * 计数来自整段会话和整份朋友圈；列表按页往前翻，直到没有更早的记录。
 * 这样第一屏就能看到最近在说什么，也不会把更早的内容悄悄截掉。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageTypeStat, MomentItem, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { apiAnalyzePortraitPersonality, apiGetMessages, apiGetMoments, apiReadPortraitPersonality, peekPortraitPersonality, type PortraitPersonalityResult } from '../api.ts'
import { ErrorState, LoadingState } from '../ui/kit.tsx'
import { MessageImage } from './chats-media.tsx'
import { OvSection } from './overview-parts.tsx'
import { fmtDateTimeSec } from '../utils/format.ts'
import css from './portraits.module.css'

const MESSAGE_PAGE = 40
const MOMENT_PAGE = 20

interface MessagePage {
  messages: WechatMessage[]
  total: number
  hasMore: boolean
  cursor?: number
  cursorLocalId?: number
  typeStats: MessageTypeStat[]
}

interface MomentPage {
  moments: MomentItem[]
  total: number
}

function messageText(message: WechatMessage): string {
  const text = (message.displayText || message.strContent || message.msgContent || '').replace(/\s+/g, ' ').trim()
  if (text !== '') return text
  return message.renderLabel || message.typeLabel || '一条消息'
}

const PORTRAIT_SECTION_TITLES = ['这个人', '说话方式', '在意什么', '和人相处', '生活画面', '言行是否一致', '性格观察', '还不能确定']

function portraitBlocks(text: string): Array<{ title: string; body: string }> | null {
  const found = PORTRAIT_SECTION_TITLES
    .map((title) => ({ title, at: text.indexOf(title) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at)
  if (found.length < 2) return null
  return found.flatMap((item, index) => {
    const start = item.at + item.title.length
    const next = found[index + 1]
    const end = next !== undefined ? next.at : text.length
    const body = text.slice(start, end).replace(/^[\s:：\-—.、]+/, '').trim()
    return body === '' ? [] : [{ title: item.title, body }]
  })
}
function brief(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 72 ? `${clean.slice(0, 72)}…` : clean
}

function isImageMessage(message: WechatMessage): boolean {
  return message.renderType === 'image' || message.type === 3
}

function imageCount(stats: readonly MessageTypeStat[]): number {
  return stats.filter((row) => row.type === 3 || row.label === '图片').reduce((sum, row) => sum + row.count, 0)
}

function PortraitPersonaSection({
  personaLoading,
  personaRefresh,
  persona,
  personaError,
  onRefresh,
}: {
  personaLoading: boolean
  personaRefresh: boolean
  persona: PortraitPersonalityResult | null
  personaError: string | null
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <OvSection
      canvasId="portrait-persona"
      zone="分析"
      icon="insight"
      title="人物性格"
      action={!personaLoading && (persona || personaError) ? (
        <button type="button" className={css.moreBtn} onClick={onRefresh}>重新分析</button>
      ) : (
        <span>{persona?.cached === true ? '已保存在本机' : '根据图片、聊天、朋友圈'}</span>
      )}
    >
      {personaLoading && (
        <LoadingState label={personaRefresh ? '正在根据聊天、图片和朋友圈生成…' : '正在读取已保存的人物性格…'} />
      )}
      {!personaLoading && personaError && (
        <ErrorState message="人物性格没有生成" detail={personaError} onRetry={onRefresh} />
      )}
      {!personaLoading && persona && (
        <>
          {(() => {
            const blocks = portraitBlocks(persona.text)
            if (blocks === null) return <p className={css.personalityText}>{persona.text}</p>
            return (
              <div className={css.personaList}>
                {blocks.map((block) => (
                  <section key={block.title} className={css.personaItem}>
                    <h4>{block.title}</h4>
                    <p>{block.body}</p>
                  </section>
                ))}
              </div>
            )
          })()}
          <p className={css.feedEmpty}>
            {persona.cached === true
              ? `已从本机读取${persona.savedAt ? `（${fmtDateTimeSec(persona.savedAt)}）` : ''}。点「重新分析」会再生成并覆盖这份存档。`
              : persona.savedAt
                ? `已保存在本机（${fmtDateTimeSec(persona.savedAt)}），下次打开直接读取。`
                : '这是根据聊天、图片画面和朋友圈做的观察，不是心理鉴定。语气、实时肢体和材料里没出现的经历不会被写进去。'}
          </p>
        </>
      )}
    </OvSection>
  )
}

/** 好友内容：聊天、对方图片、朋友圈。卡片始终展开，换人后直接推测当前这位好友。 */
export function CustomerContentFeed({ username }: {
  username: string
}): React.JSX.Element {
  const [messages, setMessages] = useState<MessagePage | null>(null)
  const [moments, setMoments] = useState<MomentPage | null>(null)
  const [messageError, setMessageError] = useState<string | null>(null)
  const [momentError, setMomentError] = useState<string | null>(null)
  const [messageLoading, setMessageLoading] = useState(true)
  const [momentLoading, setMomentLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadingMoments, setLoadingMoments] = useState(false)
  const [persona, setPersona] = useState<PortraitPersonalityResult | null>(null)
  const [personaLoading, setPersonaLoading] = useState(false)
  const [personaRefresh, setPersonaRefresh] = useState(false)
  const [personaError, setPersonaError] = useState<string | null>(null)
  const personaStarted = useRef(false)
  const personaGen = useRef(0)

  const loadMessages = useCallback(async (cursor?: { sortSeq: number; localId: number }): Promise<void> => {
    const older = cursor !== undefined
    if (older) setLoadingOlder(true)
    else setMessageLoading(true)
    setMessageError(null)
    try {
      const snap = await apiGetMessages({
        talker: username,
        limit: MESSAGE_PAGE,
        fresh: true,
        ...(cursor ? { cursor: cursor.sortSeq, cursorLocalId: cursor.localId } : {}),
      })
      setMessages((prev) => ({
        messages: older && prev ? [...snap.messages, ...prev.messages] : snap.messages,
        total: snap.total,
        hasMore: snap.hasMore === true,
        ...(snap.cursor !== undefined ? { cursor: snap.cursor } : {}),
        ...(snap.cursorLocalId !== undefined ? { cursorLocalId: snap.cursorLocalId } : {}),
        typeStats: snap.typeStats ?? prev?.typeStats ?? [],
      }))
    } catch (error: unknown) {
      setMessageError(error instanceof Error ? error.message : String(error))
    } finally {
      setMessageLoading(false)
      setLoadingOlder(false)
    }
  }, [username])

  const loadMoments = useCallback(async (offset: number): Promise<void> => {
    const older = offset > 0
    if (older) setLoadingMoments(true)
    else setMomentLoading(true)
    setMomentError(null)
    try {
      const snap = await apiGetMoments({ author: username, offset, limit: MOMENT_PAGE })
      setMoments((prev) => ({
        moments: older && prev ? [...prev.moments, ...snap.moments] : snap.moments,
        total: snap.total,
      }))
    } catch (error: unknown) {
      setMomentError(error instanceof Error ? error.message : String(error))
    } finally {
      setMomentLoading(false)
      setLoadingMoments(false)
    }
  }, [username])

  const startPersona = useCallback((refresh = false): void => {
    if (!refresh && personaStarted.current) return
    personaStarted.current = true
    const gen = personaGen.current + 1
    personaGen.current = gen
    if (refresh) {
      setPersona(null)
      setPersonaRefresh(true)
      setPersonaLoading(true)
      setPersonaError(null)
      void apiAnalyzePortraitPersonality(username)
        .then((result) => { if (personaGen.current === gen) setPersona(result) })
        .catch((error: unknown) => {
          if (personaGen.current === gen) setPersonaError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => { if (personaGen.current === gen) setPersonaLoading(false) })
      return
    }
    const remembered = peekPortraitPersonality(username)
    if (remembered !== undefined) {
      setPersona(remembered)
      setPersonaLoading(false)
      setPersonaError(null)
      return
    }
    setPersonaRefresh(false)
    setPersonaLoading(true)
    setPersonaError(null)
    void apiReadPortraitPersonality(username)
      .then((result) => {
        if (personaGen.current !== gen) return
        if (result.error === 'miss') {
          setPersonaRefresh(true)
          return apiAnalyzePortraitPersonality(username)
        }
        setPersona(result)
        return undefined
      })
      .then((generated) => {
        if (personaGen.current === gen && generated !== undefined) setPersona(generated)
      })
      .catch((error: unknown) => {
        if (personaGen.current === gen) setPersonaError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => { if (personaGen.current === gen) setPersonaLoading(false) })
  }, [username])

  useEffect(() => {
    const remembered = peekPortraitPersonality(username)
    setMessages(null)
    setMoments(null)
    setPersona(remembered ?? null)
    setPersonaError(null)
    setPersonaLoading(remembered === undefined)
    personaStarted.current = false
    startPersona()
    void loadMessages()
    void loadMoments(0)
  }, [loadMessages, loadMoments, startPersona])

  const theirImages = (messages?.messages ?? []).filter((message) => message.isSender !== 1 && isImageMessage(message))
  const shownImages = theirImages.slice(-36)
  const pictures = messages ? imageCount(messages.typeStats) : 0
  const latest = messages?.messages[messages.messages.length - 1]
  const latestMoment = moments?.moments[0]

  return (
    <>
      <OvSection canvasId="portrait-digest" zone="概览" icon="relation" title="这个好友">
        <p className={css.digest}>
          {messageLoading ? '正在读取和他的聊天…' : `一对一聊天 ${String(messages?.total ?? 0)} 条`}
          {pictures > 0 ? `，其中图片消息 ${String(pictures)} 条` : ''}
          {momentLoading ? '。朋友圈读取中…' : `。朋友圈 ${String(moments?.total ?? 0)} 条`}
          {latest ? `。最近一条：${brief(messageText(latest))}` : ''}
          {latestMoment?.text ? `。最近一条朋友圈：${brief(latestMoment.text)}` : ''}
        </p>
      </OvSection>

      <PortraitPersonaSection
        personaLoading={personaLoading}
        personaRefresh={personaRefresh}
        persona={persona}
        personaError={personaError}
        onRefresh={() => { startPersona(true) }}
      />

      <OvSection
        canvasId="portrait-images"
        zone="内容"
        icon="moments"
        title="对方发出的图片"
        action={<span>{theirImages.length > 0 ? `已纳入 ${String(theirImages.length)} 张，展示最近 ${String(shownImages.length)} 张` : '随聊天记录出现'}</span>}
      >
        {theirImages.length === 0 ? (
          <p className={css.feedEmpty}>当前已载入的聊天里还没有对方发出的图片。继续加载更早的记录后，新出现的图片会补在这里。</p>
        ) : (
          <div className={css.imageGrid}>
            {shownImages.map((message) => (
              <div key={message.localId} className={css.imageCell}>
                <MessageImage m={message} selfName={username} />
              </div>
            ))}
          </div>
        )}
      </OvSection>

      <OvSection
        canvasId="portrait-messages"
        zone="内容"
        icon="chat"
        title="聊天记录"
        action={<span>{messages ? `${String(messages.messages.length)} / ${String(messages.total)}` : '读取中'}</span>}
      >
        {messageLoading && messages === null && <LoadingState label="正在读取聊天记录…" />}
        {messageError && <ErrorState message="聊天记录读取失败" detail={messageError} onRetry={() => { void loadMessages() }} />}
        {messages && messages.messages.length === 0 && !messageError && (
          <p className={css.feedEmpty}>本机没有和这位好友的一对一聊天记录。</p>
        )}
        {messages && messages.messages.length > 0 && (
          <ol className={css.msgList}>
            {messages.messages.map((message) => (
              <li key={message.localId} className={css.msgRow} data-self={message.isSender === 1 || undefined}>
                <span className={css.msgWho}>{message.isSender === 1 ? '我' : '对方'}</span>
                <span className={css.msgTime}>{fmtDateTimeSec(message.createTime, '')}</span>
                <span className={css.msgText}>{messageText(message)}</span>
              </li>
            ))}
          </ol>
        )}
        {messages?.hasMore === true && messages.cursor !== undefined && messages.cursorLocalId !== undefined && (
          <button
            type="button"
            className={css.moreBtn}
            disabled={loadingOlder}
            onClick={() => { void loadMessages({ sortSeq: messages.cursor ?? 0, localId: messages.cursorLocalId ?? 0 }) }}
          >
            {loadingOlder ? '正在加载更早的记录…' : '加载更早的聊天记录'}
          </button>
        )}
      </OvSection>

      <OvSection
        canvasId="portrait-moments"
        zone="内容"
        icon="moments"
        title="朋友圈"
        action={<span>{moments ? `${String(moments.moments.length)} / ${String(moments.total)}` : '读取中'}</span>}
      >
        {momentLoading && moments === null && <LoadingState label="正在读取朋友圈…" />}
        {momentError && <ErrorState message="朋友圈读取失败" detail={momentError} onRetry={() => { void loadMoments(0) }} />}
        {moments && moments.moments.length === 0 && !momentError && (
          <p className={css.feedEmpty}>本机朋友圈库里没有这位好友发布的内容。</p>
        )}
        {moments && moments.moments.length > 0 && (
          <ol className={css.momentList}>
            {moments.moments.map((moment) => (
              <li key={moment.tid} className={css.momentRow}>
                <span className={css.msgTime}>{moment.time || fmtDateTimeSec(moment.ts, '')}</span>
                <span className={css.msgText}>{moment.text.trim() || '（这条朋友圈没有文字）'}</span>
                <span className={css.momentMeta}>
                  {[
                    moment.media_count > 0 ? `${String(moment.media_count)} 个媒体` : '',
                    moment.media_desc,
                    moment.location,
                    moment.videos.length > 0 ? `${String(moment.videos.length)} 个视频` : '',
                  ].filter((part) => part !== '').join(' · ')}
                </span>
              </li>
            ))}
          </ol>
        )}
        {moments && moments.moments.length < moments.total && (
          <button
            type="button"
            className={css.moreBtn}
            disabled={loadingMoments}
            onClick={() => { void loadMoments(moments.moments.length) }}
          >
            {loadingMoments ? '正在加载更早的朋友圈…' : '加载更早的朋友圈'}
          </button>
        )}
      </OvSection>
    </>
  )
}
