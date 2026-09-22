
/**
 * 朋友圈的一条动态卡片（M21 第二十五刀自 moments-panel.tsx 拆出）。
 *
 * 原先是面板里 `g.items.map((m) => { …局部 const… return (…卡片…) })` 的整体；这里把那段
 * 原样搬成一个组件 —— 局部 const 随之进来（它们都是从 `m` 与道具派生的），JSX 一字未改。
 * 面板侧只剩 `<MomentsCard key={m.tid} … />`（唯一的结构性改动：`key` 从根 div 挪到组件调用处，
 * 列表里的 key 语义不变）。
 *
 * 为什么不把这里的 state 一起挪进来：`expandedTextByCard` / `commentCounts` / `failedImgs` /
 * `videoSrcs` 等都是**按 tid 索引的整列表状态**，卡片只是读写其中一格；挪进来会变成「每张卡一份」,
 * 语义就变了（例如「展开全部」之类的跨卡操作会失效）。
 */
import { Fragment } from 'react'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey } from '../ui/kit.tsx'
import { fmtCommentTime, imgKey, replyTarget } from './moments-support.tsx'
import { MomentsAvatar } from './moments-support.tsx'
import { cspSafeSrc } from '../utils/url.ts'
import type { SnsVideoRef, ViewerState } from './moments-portals.tsx'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'

/** 图片/视频的离线解码请求描述（与面板里 `mediaKeySpec` 的 Map 值同构）。 */
export interface MediaKeySpec { md5: string; timelineId?: string; mediaId?: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }

export interface MomentsCardProps {
  m: MomentItem
  privacy: boolean
  snsImgs: Record<string, string>
  articleCovers: Record<string, string>
  expandedTextByCard: Set<string>
  expandedSocialByCard: Set<string>
  commentCounts: Record<string, number>
  commentSortByCard: Record<string, 'asc' | 'desc'>
  onlyMineComments: boolean
  selfUsername: string | null
  failedImgs: Set<string>
  setFailedImgs: React.Dispatch<React.SetStateAction<Set<string>>>
  videoSrcs: Record<string, string>
  videoMeta: Record<string, { w: number; h: number }>
  setVideoMeta: React.Dispatch<React.SetStateAction<Record<string, { w: number; h: number }>>>
  videoFailed: Set<string>
  videoErr: Map<string, string>
  mediaKeySpec: React.MutableRefObject<Map<string, MediaKeySpec>>
  setViewer: (v: ViewerState | null) => void
  setDetail: React.Dispatch<React.SetStateAction<{ m: MomentItem } | null>>
  setAuthorFilter: React.Dispatch<React.SetStateAction<string | null>>
  setOnlyMineComments: React.Dispatch<React.SetStateAction<boolean>>
  setCommentCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  setCommentSortByCard: React.Dispatch<React.SetStateAction<Record<string, 'asc' | 'desc'>>>
  toggleText: (tid: string) => void
  toggleSocial: (tid: string) => void
  copyText: (text: string) => void
  loadVideo: (vk: string, v: SnsVideoRef) => void
  saveVideo: (v: SnsVideoRef) => void
  fullscreenVideo: (tile: Element | null) => void
  closeVideo: (vk: string) => void
}

export function MomentsCard({
  m, privacy, snsImgs,
  articleCovers, expandedTextByCard, expandedSocialByCard,
  commentCounts, commentSortByCard, onlyMineComments,
  selfUsername, failedImgs, setFailedImgs,
  videoSrcs, videoMeta, setVideoMeta,
  videoFailed, videoErr, mediaKeySpec,
  setViewer, setDetail, setAuthorFilter,
  setOnlyMineComments, setCommentCounts, setCommentSortByCard,
  toggleText, toggleSocial, copyText,
  loadVideo, saveVideo, fullscreenVideo,
  closeVideo,
}: MomentsCardProps): React.JSX.Element {
  const cover = m.images[0]
  const isArticle = m.contentType === 3
  const coverSrc = (cover && imgKey(cover) && snsImgs[imgKey(cover)]) || (m.link_url && articleCovers[m.link_url]) || cspSafeSrc(cover?.thumb, cover?.url)
  const textExpanded = expandedTextByCard.has(m.tid)
  const socialExpanded = expandedSocialByCard.has(m.tid)
  const commentShown = commentCounts[m.tid] ?? 5
  const commentSort = commentSortByCard[m.tid] ?? 'asc'
  let commentList = commentSort === 'desc' ? [...m.comments].reverse() : m.comments
  if (onlyMineComments && selfUsername) commentList = commentList.filter(c => c.username === selfUsername)
  const visibleComments = commentList.slice(0, Math.min(commentShown, commentList.length))
  return (
    <div className={[css.card, privacy ? css.blurCard : ''].filter(Boolean).join(' ')}>
      <div className={css.avatarClick} title="查看详情" {...clickableKey(() => { setDetail({ m }) })}>
        <MomentsAvatar username={m.username} name={m.author || '?'} />
      </div>
      <div className={css.body}>
        <div className={css.meta} title="查看详情" {...clickableKey(() => { setDetail({ m }) })}>
          <span className={css.author}>{m.author || '未知'}</span>
          {m.is_self && <span className={css.selfTag}>我</span>}
        </div>
        {m.text && (
          <div className={css.content}>
            {textExpanded || m.text.length <= 200 ? m.text : m.text.slice(0, 200) + '…'}
            {m.text.length > 200 && (<button type="button" className={css.textToggle} onClick={() => { toggleText(m.tid) }}>{textExpanded ? '收起' : '展开'}</button>)}
          </div>
        )}
        {m.images.length > 0 && !isArticle && (
          <div className={[css.images, m.images.length === 1 ? css.imagesSingle : ''].filter(Boolean).join(' ')}>
            {m.images.map((im, ii) => {
              const key = imgKey(im)
              const dataSrc = key ? snsImgs[key] : undefined
              const fk = m.tid + ':' + String(ii)
              const failed = failedImgs.has(fk)
              if (key) mediaKeySpec.current.set(key, { md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id, kind: 'img' })
              const haveSrc = !!(dataSrc || cspSafeSrc(im.thumb, im.url))
              return (
                <div key={fk}
                  className={css.imgWrap}
                  {...clickableKey(() => { setViewer({ images: m.images, index: ii, author: m.author }) })}
                  title="点击查看大图"
                  data-sns-key={key || undefined}
                  data-sns-md5={im.md5 || undefined}
                  data-sns-tid={im.timelineId || undefined}
                  data-sns-mid={im.id || undefined}
                >
                  {haveSrc && (!failed || dataSrc) ? (
                    <img
                      key={dataSrc ? 'd' : 'c'}
                      src={dataSrc || cspSafeSrc(im.thumb, im.url)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      className={css.img}
                      onError={() => {
                        // 如果当前src是CDN URL（非data URL），标记为失败
                        // 避免反复尝试无法访问的CDN URL
                        const currentSrc = dataSrc || cspSafeSrc(im.thumb, im.url)
                        if (!currentSrc.startsWith('data:')) {
                          setFailedImgs(prev => new Set(prev).add(fk))
                        }
                      }}
                    />
                  ) : (
                    <div className={css.imgFallback}>
                      {failed ? (
                        <div className={css.imgFallbackContent}>
                          <span className={css.imgFallbackIcon}>🖼</span>
                          <span className={css.imgFallbackText}>图片加载失败</span>
                          <span className={css.imgFallbackHint}>本地缓存未找到</span>
                        </div>
                      ) : '加载中'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {m.videos.length > 0 && (
          <div className={css.videos}>
            {m.videos.map((v, vi) => {
              const vk = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
              const vCover = (vk ? snsImgs[vk] : undefined) || cspSafeSrc(v.thumb)
              if (vk) mediaKeySpec.current.set(vk, { md5: v.md5 || '', timelineId: v.timelineId, mediaId: v.id, kind: 'video', seed: v.key, thumb: v.thumb })
              const src = vk ? videoSrcs[vk] : undefined
              const playing = !!src
              const meta = vk ? videoMeta[vk] : undefined
              return (
                <div key={vi} className={[css.videoTile, playing ? css.videoTilePlaying : ''].filter(Boolean).join(' ')} title={v.url || v.md5 || ''}
                  data-sns-key={vk || undefined}
                  data-sns-md5={v.md5 || undefined}
                  data-sns-tid={v.timelineId || undefined}
                  data-sns-mid={v.id || undefined}
                  style={playing && meta ? { ['--video-ar' as string]: `${meta.w} / ${meta.h}` } : undefined}
                  {...(playing ? {} : clickableKey(() => { loadVideo(vk, v) }, { label: '播放视频' }))}
                >
                  {playing ? (
                    <>
                      <video
                        className={css.videoPlayer}
                        src={src}
                        controls
                        autoPlay
                        poster={vCover || ''}
                        onLoadedMetadata={(e) => {
                          const el = e.currentTarget
                          if (!vk || !el.videoWidth || !el.videoHeight) return
                          setVideoMeta((prev) => (prev[vk]?.w === el.videoWidth ? prev : { ...prev, [vk]: { w: el.videoWidth, h: el.videoHeight } }))
                        }}
                      />
                      <div className={css.videoActions}>
                        <button type="button" className={css.videoActBtn} title="保存视频" onClick={(e) => { e.stopPropagation(); saveVideo(v) }}>⭳</button>
                        <button type="button" className={css.videoActBtn} title="全屏" onClick={(e) => { e.stopPropagation(); fullscreenVideo(e.currentTarget.parentElement?.parentElement ?? null) }}>⛶</button>
                        <button type="button" className={css.videoActBtn} title="收起" onClick={(e) => { e.stopPropagation(); if (vk) closeVideo(vk) }}>✕</button>
                      </div>
                    </>
                  ) : vCover ? (
                    <>
                      <img className={css.videoCover} src={vCover} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(e) => {
                        // 如果当前src是CDN URL（非data URL），隐藏图片
                        if (!vCover.startsWith('data:')) {
                          e.currentTarget.style.display = 'none'
                        }
                      }} />
                      <span className={css.videoPlayBadge}>▶</span>
                      {v.duration > 0 && <span className={css.videoDur}>{Math.round(v.duration)}s</span>}
                    </>
                  ) : (
                    <>
                      {videoFailed.has(vk) ? (
                        <span className={css.videoMissing} title={videoErr.get(vk) || '朋友圈视频要在微信里播放过才会缓存到本机'}>
                          本机未缓存<em>微信里播一次后可看</em>
                        </span>
                      ) : (
                        <span className={css.videoBadge}>▶</span>
                      )}
                      {v.duration > 0 && <span className={css.videoDur}>{Math.round(v.duration)}s</span>}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {m.link_title && (
          <div className={css.linkCard}>
            {cover ? (
              <div className={css.linkCover}>
                {failedImgs.has('cover:' + m.tid)
                  ? <span className={css.linkCoverFallback} title="封面来自公众号 CDN，原链接已失效">🔗</span>
                  : <img
                    key={coverSrc.startsWith('data:') ? 'd' : 'c'}
                    src={coverSrc}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={() => {
                      // 原来是直接把 <img> 设成 display:none —— 但 .linkCover 是固定 60×60 的框，
                      // 隐藏图片只会留下一个**没有意义的空格子**（实测共享文章封面里
                      // 有 3 个 mmbiz.qpic.cn 的图 400，页面上就是 3 个空方块）。
                      // 改成标记失败并渲染占位图标，与评论图/朋友圈图的失败口径一致。
                      if (!coverSrc.startsWith('data:')) {
                        setFailedImgs(prev => new Set(prev).add('cover:' + m.tid))
                      }
                    }}
                  />}
              </div>
            ) : null}
            <div className={css.linkBody}>
              {/* 标题被 2 行截断（.linkTitle 的 line-clamp），所以必须给全文入口：
                  第 60 轮把「纵向截断但无 title」并入截断巡检后，这里立刻被抓出来
                  （视频号长标题可见 45px、实际 67px，用户无法拿到全文）。 */}
              {m.link_url
                ? <a className={css.linkTitle} href={m.link_url} target="_blank" rel="noopener noreferrer" title={m.link_title}>{m.link_title}</a>
                : <span className={css.linkTitle} title={m.link_title}>{m.link_title}</span>}
              <div className={kitCss.textMeta}>{m.sourceNickName ? '公众号 · ' + m.sourceNickName : (m.contentType === 28 ? '视频号' : '链接')}</div>
            </div>
          </div>
        )}
        {m.location && (
          <div className={css.tags}>
            <span className={kitCss.textMeta}>📍 {m.location}</span>
          </div>
        )}
        {(m.likes.length > 0 || m.comments.length > 0) && (
          <div className={css.social}>
            {m.likes.length > 0 && (
              <div className={css.likesRow}>
                <span className={css.likesCount}>❤ {m.likes.length}</span>
                <span className={css.likeNames}>
                  {(() => {
                    const names = socialExpanded ? m.likes : m.likes.slice(0, 8)
                    return names.map((l, idx) => (
                      <Fragment key={idx}>
                        <span className={css.clickableName} title={'只看 ' + (l.nickname || l.username)} {...clickableKey(() => { setAuthorFilter(l.nickname || l.username || null) }, { stopPropagation: true })}>{l.nickname || l.username || '未知'}</span>
                        {idx < names.length - 1 ? '、' : null}
                      </Fragment>
                    ))
                  })()}
                  {!socialExpanded && m.likes.length > 8 ? ' 等' : ''}
                  {m.likes.length > 8 && (
                    <button type="button" className={css.textToggle} onClick={() => { toggleSocial(m.tid) }}>{socialExpanded ? '收起' : '展开全部 ' + String(m.likes.length) + ' 人'}</button>
                  )}
                </span>
              </div>
            )}
            {m.comments.length > 0 && (
              <div className={css.comments}>
                {m.comments.length > 1 && (
                  <div className={css.commentsHead}>
                    <span className={css.commentsTitle}>评论 {m.comments.length}</span>
                    <div className={css.commentsHeadActs}>
                      {selfUsername && (
                        <button type="button" className={css.textToggle} data-on={onlyMineComments || undefined} onClick={() => { setOnlyMineComments(v => !v) }}>仅看我的</button>
                      )}
                      <button type="button" className={css.textToggle} onClick={() => { setCommentSortByCard(prev => ({ ...prev, [m.tid]: commentSort === 'asc' ? 'desc' : 'asc' })) }}>{commentSort === 'asc' ? '最新在前' : '最早在前'}</button>
                      <button type="button" className={css.textToggle} onClick={() => { copyText(m.comments.map(c => ((c.nickname || c.username) + '：' + (c.content || '')).trim()).join('\n')) }}>复制</button>
                    </div>
                  </div>
                )}
                {visibleComments.map((c, ci) => {
                  const target = replyTarget(m, c)
                  return (
                    <div key={ci} className={css.comment}>
                      <span className={css.commentName} title={'只看 ' + (c.nickname || c.username)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{c.nickname || c.username || '未知'}</span>
                      {c.to_username && c.to_username !== m.username && (
                        <span className={css.commentReply}>回复 {c.to_nickname || c.to_username}{target ? '：' : ''}</span>
                      )}
                      {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                      <span className={css.commentText}>{c.content || ''}</span>
                      {c.image && (() => {
                        const img = c.image
                        const cdata = (img.md5 && snsImgs[img.md5]) || ''
                        const cfk = m.tid + ':c' + String(ci)
                        const cfailed = failedImgs.has(cfk)
                        if (img.md5) mediaKeySpec.current.set(img.md5, { md5: img.md5, kind: 'comment' })
                        if (cdata || cspSafeSrc(img.thumb, img.url)) return (
                          <img
                            key={cdata ? 'd' : 'c'}
                            src={cdata || cspSafeSrc(img.thumb, img.url)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            className={css.commentImg}
                            data-sns-key={img.md5 || undefined}
                            data-sns-md5={img.md5 || undefined}
                            {...clickableKey(() => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }) }, { label: '查看大图' })}
                            onError={() => {
                              // 如果当前src是CDN URL（非data URL），标记为失败
                              const currentSrc = cdata || cspSafeSrc(img.thumb, img.url)
                              if (!currentSrc.startsWith('data:')) {
                                setFailedImgs(prev => new Set(prev).add(cfk))
                              }
                            }}
                          />
                        )
                        return !cfailed ? <span className={css.commentImgFallback}>[图]</span> : null
                      })()}
                      {c.ts > 0 && <span className={css.commentTime}>{fmtCommentTime(c.ts)}</span>}
                    </div>
                  )
                })}
                {m.comments.length > commentShown && (
                  <button type="button" className={css.textToggle} onClick={() => { setCommentCounts(prev => ({ ...prev, [m.tid]: Math.min(m.comments.length, commentShown + 10) })) }}>
                    加载更多评论（剩余 {String(m.comments.length - commentShown)} 条）
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className={css.timeRow}>
          <span className={kitCss.textMeta}>{m.time}</span>
          {m.is_self && <span className={css.delIcon}>🗑</span>}
        </div>
      </div>
    </div>
  )
}
