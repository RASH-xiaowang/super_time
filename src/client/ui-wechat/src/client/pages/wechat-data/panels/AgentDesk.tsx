/**
 * AI 队友：静默、额度、记忆、承诺和主动提案。
 *
 * 提案默认停在本页。「只标记采纳」只记反馈；「Webhook 发送」会经消息列表规则投递正文，可能由下游发送到微信。
 * 群聊夹了知识库的回复会停在消息列表的草稿里，由你单条重发。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, PanelHeader } from '../ui/kit.tsx'
import {
  apiAddAgentPromise,
  apiDeleteAgentMemory,
  apiGetAgentDesk,
  apiSaveAgentControl,
  apiSendAgentDraft,
  apiSendAgentProposal,
  apiSetAgentProposalStatus,
  apiWriteAgentMemory,
  type AgentDeskSnapshot,
} from '../api-agent-desk.ts'
import { runtimeCapabilities } from '../api-core.ts'
import css from './agent-desk.module.css'

function stamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleString()
}

export function AgentDeskPanel(): React.JSX.Element {
  const [desk, setDesk] = useState<AgentDeskSnapshot | null>(null)
  const [error, setError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const desktop = runtimeCapabilities().isDesktop
  const [memory, setMemory] = useState('')
  const [promise, setPromise] = useState('')
  const [due, setDue] = useState('')
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd] = useState('')
  const [hourCap, setHourCap] = useState('80')
  const [dayCap, setDayCap] = useState('400')
  const [proactiveHourCap, setProactiveHourCap] = useState('1')
  const [cooldownMin, setCooldownMin] = useState('0')
  const [sendTarget, setSendTarget] = useState('文件传输助手')

  const reload = useCallback(async () => {
    try {
      const next = await apiGetAgentDesk()
      setDesk(next)
      setQuietStart(next.control.quietStart)
      setQuietEnd(next.control.quietEnd)
      setHourCap(String(next.control.hourCap))
      setDayCap(String(next.control.dayCap))
      setProactiveHourCap(String(next.control.proactiveHourCap))
      setCooldownMin(String(Math.round(next.control.cooldownMs / 60000)))
      setError('')
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI 队友读取失败')
      return false
    }
  }, [])

  useEffect(() => { if (desktop) void reload() }, [desktop, reload])

  const runAction = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (!desktop || running.current) return
    running.current = true
    setBusy(true)
    setError('')
    setActionNotice(label + '…')
    try {
      await action()
      if (!await reload()) setActionNotice(label + '已完成，但列表刷新失败')
    } catch (e) {
      setActionNotice('')
      setError(e instanceof Error ? e.message : label + '失败')
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const saveQuiet = async (): Promise<void> => {
    const hours = Number(hourCap)
    const days = Number(dayCap)
    const proactive = Number(proactiveHourCap)
    const minutes = Number(cooldownMin)
    await runAction('保存设置', async () => {
    await apiSaveAgentControl({
      quietStart,
      quietEnd,
      hourCap: Number.isFinite(hours) ? hours : 80,
      dayCap: Number.isFinite(days) ? days : 400,
      proactiveHourCap: Number.isFinite(proactive) ? proactive : 1,
      cooldownMs: Number.isFinite(minutes) ? Math.max(0, minutes) * 60000 : 0,
    })
    setActionNotice('设置已保存')
    })
  }

  if (!desktop) return <Card><p>AI 队友仅桌面 IPC 可用，浏览器及远程交接会话不调用这些接口。</p></Card>
  return (
    <div className={css.stack} aria-busy={busy}>
      <PanelHeader
        title="AI 队友"
        desc="对方发来的消息仍由会话里的 AI 回复处理。这里管静默、记忆，以及那些不该直接发到微信的主动提案。"
        actions={(
          <Button disabled={busy} size="sm" variant="outline" onClick={() => { void reload() }}>刷新</Button>
        )}
      />
      {error !== '' && <p role="alert">{error}</p>}
      {actionNotice !== '' && <p role="status" aria-live="polite">{actionNotice}</p>}
      {desk !== null && (
        <>
          <Card>
            <div className={css.row}>
              <Button disabled={busy}
                size="sm"
                variant={desk.control.killed ? 'primary' : 'outline'}
                onClick={() => { void runAction('更新紧急停止', async () => { await apiSaveAgentControl({ killed: !desk.control.killed }); setActionNotice('紧急停止状态已保存') }) }}
              >
                {desk.control.killed ? '已紧急停止，点击恢复' : '紧急停止自动回复'}
              </Button>
              <span className={css.meta}>
                主动提案保持草稿。每小时最多 {desk.control.hourCap} 条自动回复，每天 {desk.control.dayCap} 条。
                调度对账差额 {desk.reconcile.delta}。
              </span>
            </div>
            <div className={css.row}>
              <label className={css.field}>
                静默开始
                <input value={quietStart} placeholder="22:00" onChange={(event) => { setQuietStart(event.target.value) }} />
              </label>
              <label className={css.field}>
                静默结束
                <input value={quietEnd} placeholder="07:00" onChange={(event) => { setQuietEnd(event.target.value) }} />
              </label>
              <label className={css.field}>
                每小时上限
                <input value={hourCap} onChange={(event) => { setHourCap(event.target.value) }} />
              </label>
              <label className={css.field}>
                每天上限
                <input value={dayCap} onChange={(event) => { setDayCap(event.target.value) }} />
              </label>
              <label className={css.field}>
                主动每小时
                <input value={proactiveHourCap} onChange={(event) => { setProactiveHourCap(event.target.value) }} />
              </label>
              <label className={css.field}>
                冷却（分钟）
                <input value={cooldownMin} onChange={(event) => { setCooldownMin(event.target.value) }} />
              </label>
              <Button disabled={busy} size="sm" variant="primary" onClick={() => { void saveQuiet() }}>保存</Button>
            </div>
            <div className={css.row}>
              <Button disabled={busy}
                size="sm"
                variant={desk.control.handoff ? 'primary' : 'outline'}
                onClick={() => { void runAction('更新人工接管', async () => { await apiSaveAgentControl({ handoff: !desk.control.handoff }); setActionNotice('人工接管设置已保存') }) }}
              >
                {desk.control.handoff ? '已转人工，点击恢复自动回复' : '转人工'}
              </Button>
              <Button disabled={busy}
                size="sm"
                variant={desk.control.shadow ? 'outline' : 'primary'}
                onClick={() => { void runAction('更新提案模式', async () => { await apiSaveAgentControl({ shadow: !desk.control.shadow }); setActionNotice('提案模式已保存') }) }}
              >
                {desk.control.shadow ? '主动提案保持草稿' : '主动提案标为可发送'}
              </Button>
            </div>
            <p className={css.meta}>
              群聊一旦勾了知识库，回复会留在消息列表，备注是「草稿待确认」。确认后用 Webhook 发出：文本带 target 和 message，群里 @ 带 mention，附件走 attachments，任务结果查 jobs。
            </p>
          </Card>
          <Card>
            <h3>待发送草稿</h3>
            <ul className={css.list}>
              {desk.drafts.map((item) => (
                <li key={item.id} className={css.item}>
                  <span>{item.chatName || item.targetName}：{item.text}</span>
                  <Button disabled={busy} size="sm" variant="primary" onClick={() => {
                    void runAction('发送草稿', async () => { await apiSendAgentDraft(item.id); setActionNotice('草稿已交给 Webhook') })
                  }}>用 Webhook 发送</Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3>记住</h3>
            <div className={css.row}>
              <label className={css.field}>
                新的事实
                <input value={memory} maxLength={500} onChange={(event) => { setMemory(event.target.value) }} />
              </label>
              <Button disabled={busy} size="sm" variant="primary" onClick={() => {
                void runAction('写入记忆', async () => { await apiWriteAgentMemory(memory); setMemory(''); setActionNotice('记忆已写入') })
              }}>记住</Button>
            </div>
            <ul className={css.list}>
              {desk.memories.map((item) => (
                <li key={item.id} className={css.item}>
                  <span>{item.text}{item.status === 'disputed' ? '（与另一条记忆冲突）' : ''}</span>
                  <Button disabled={busy} size="sm" variant="ghost" onClick={() => { void runAction('删除记忆', async () => { await apiDeleteAgentMemory(item.id); setActionNotice('记忆已删除') }) }}>删除</Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3>承诺</h3>
            <div className={css.row}>
              <label className={css.field}>
                要跟进的事
                <input value={promise} maxLength={300} onChange={(event) => { setPromise(event.target.value) }} />
              </label>
              <label className={css.field}>
                到期时间
                <input type="datetime-local" value={due} onChange={(event) => { setDue(event.target.value) }} />
              </label>
              <Button disabled={busy} size="sm" variant="primary" onClick={() => {
                const at = new Date(due).getTime()
                void runAction('保存承诺', async () => { await apiAddAgentPromise(promise, at); setPromise(''); setActionNotice('承诺已记下') })
              }}>记下</Button>
            </div>
            <ul className={css.list}>
              {desk.promises.map((item) => (
                <li key={item.id}>{item.text} · {stamp(item.dueAt)}</li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3>提案</h3>
            <label className={css.field}>
              发送目标
              <input value={sendTarget} onChange={(event) => { setSendTarget(event.target.value) }} />
            </label>
            <ul className={css.list}>
              {desk.proposals.map((item) => (
                <li key={item.id} className={css.item}>
                  <span>
                    {item.body || '（没有正文）'}
                    <span className={css.meta}> {item.decision} · {item.reasonCode} · {item.status}</span>
                  </span>
                  {item.status === 'open' && (
                    <span className={css.row}>
                      <Button disabled={busy} size="sm" variant="primary" onClick={() => {
                        void runAction('发送提案', async () => { await apiSendAgentProposal(item.id, sendTarget); setActionNotice('提案已交给 Webhook') })
                      }}>Webhook 发送</Button>
                      <Button disabled={busy} size="sm" variant="outline" onClick={() => { void runAction('标记采纳', async () => {
                        await apiSetAgentProposalStatus(item.id, 'accepted'); setActionNotice('只标记采纳已完成，未发送消息')
                      }) }}>只标记采纳</Button>
                      <Button disabled={busy} size="sm" variant="ghost" onClick={() => { void runAction('忽略提案', async () => {
                        await apiSetAgentProposalStatus(item.id, 'dismissed')
                        setActionNotice('已忽略提案')
                      }) }}>忽略</Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3>审计</h3>
            <ul className={css.list}>
              {desk.audit.map((item) => (
                <li key={item.id} className={css.meta}>{stamp(item.createdAt)} · {item.action} · {item.summary}</li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  )
}
