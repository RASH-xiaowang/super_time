
/**
 * 朋友圈的一条动态卡片（M21 第二十五刀自 moments-panel.tsx 拆出）。
 *
 * 原先是面板里 `g.items.map((m) => { …局部 const… return (…卡片…) })` 的整体；这里把那段
 * 原样搬成一个组件 —— 局部 const 随之进来（它们都是从 `m` 与道具派生的），JSX 一字未改。
 * 面板侧只剩 `<MomentsCard key={m.tid} … />`（唯一的结构性改动：`key` 从根 div 挪到组件调用处，
 * 列表里的 key 语义不变）。
 *
 * 为什么不把这里的 state 一起挪进来：`expandedTextByCard` / `commentCounts` /
 * `videoSrcs` 等都是**按 tid 索引的整列表状态**，卡片只是读写其中一格；挪进来会变成「每张卡一份」,
 * 语义就变了（例如「展开全部」之类的跨卡操作会失效）。
 *
 * ## 为什么图片那一路不拿 CDN 地址顶着（2026-10-08）
 *
 * 卡片原先是 `src={dataSrc || proxyableSrcAllowHttp(im.thumb, im.url)}`，意思是
 * 「后端还没回话时先拿 CDN 地址顶着，失败还有 `fallbackSrc` 兜底」。**那条兜底在原理上永远画不出图**：
 * 朋友圈 CDN 返回的是 WxIsaac64 **密文**（真机实测：响应头恒为 `x-enc: 1`，头四字节 `ce 6c e7 d1`），
 * 必须经 `sns-keystream.ts` 解密才是一张图片。于是只要 `dataSrc` 还没到（首次进入、懒加载
 * 还没触发、或取图失败），那一格必然走 `failed` 分支显示「图片加载失败」；而 `snsErrs` 尚未
 * 记上原因时冒出来的是**「本地缓存未找到」** —— 把用户指向完全错误的方向（真实原因是
 * 「这条兜底地址根本不是图片」，与本机缓存无关）。
 *
 * 正确分工：CDN 的 url/token/seed 只在**后端**用（`mediaKeySpec` 带着它们去取，见
 * `moments-media.ts` 与 `remotes/media.ts` 的四路排序），界面这一侧只认解好的字节。
 * 取不到就如实说取不到（`empty` 分支带真实原因），而不是拿一个注定渲染失败的地址去骗一次 `<img>`。
 * 接线由 `sns-image-integrity-guard.spec.ts` 钉住，变异登记 M407。
 *
 * ## 同一条规矩的另外三处（2026-10-09 一并清掉）
 *
 * 上面那条兜底在 2026-10-08 只从**图片格**上删掉了，同一个文件里还有三处同形态的，
 * 以及 `moments-portals.tsx` 里五处，全都因为同一件事而画不出图：交给 `<img src>` 的
 * 是**密文地址**，而库里这些地址又几乎全是 `http://`（实测 3219 条里只有 9 条 https，
 * 而 `proxyableSrc` 只收 `https:`/`data:`/`blob:`）⇒ 那些 `|| proxyableSrc(...)` 兜底
 * 绝大多数时候**恒为空串**，等于「没有来源也假装有来源」；少数命中 https 的则是密文，
 * 必然走 `failed`。四处分别是：
 *
 *   · `coverSrc`（文章封面用的是本动态的**首图**，thumb/url 同样是密文）；
 *   · 视频封面（实测封面密文头 `4f 44 5a d8`）；
 *   · 评论图（`img.thumb`/`img.url`，实测**裸地址 5/5 返 HTTP 400**，因为缺 `token`）；
 *   · 详情浮层里的同三处（见 `moments-portals.tsx` 文件头）。
 *
 * 评论图那一处还多一层：它必须带 `url`/`token`/`seed` 去后端才取得到图，所以这里
 * 把 `mediaKeySpec` 登记补齐（实测 `sns-comment-image-probe.manual.spec.ts`：裸地址
 * 5/5 返 400、`snsCdnUrl` 补 token 后 5/5 返 200）。批处理那一侧的门也从 `kind === 'img'`
 * 放宽成 `kind !== 'video'`（`moments-media.ts`）—— 否则评论图又被关在门外，且**不报错**。
 * 接线由 `sns-image-integrity-guard.spec.ts` 钉住，变异登记 M417–M427。
 */
import { Fragment } from 'react'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey } from '../ui/kit.tsx'
import { imgKey, replyTarget } from './moments-support.tsx'
import { fmtCommentTimeSec } from '../utils/format.ts'
import { MomentsAvatar } from './moments-support.tsx'
import { RemoteImg, localImageSrc } from './remote-img.tsx'
import type { SnsVideoRef, ViewerState } from './moments-portals.tsx'
import { videoCoverKey } from './moments-media.ts'
import type { MediaKeySpec } from './moments-media.ts'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'

/** 图片/视频的离线解码请求描述定义在媒体层（`moments-media.ts`），卡片只是往那张表里登记。 */

export interface MomentsCardProps {
  m: MomentItem
  privacy: boolean
  snsImgs: Record<string, string>
  /** 取图失败的原因（key → 后端原因）；缺省时退回原来的固定文案。 */
  snsErrs?: Record<string, string>
  articleCovers: Record<string, string>
  expandedTextByCard: Set<string>
  expandedSocialByCard: Set<string>
  commentCounts: Record<string, number>
  commentSortByCard: Record<string, 'asc' | 'desc'>
  onlyMineComments: boolean
  selfUsername: string | null
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

/**
 * 「这一格没有可显示的图」的占位。
 *
 * 为什么单独做：微信库里存的媒体地址**大量是 `http://`**（实测朋友圈 1,125 张里 1,104 张），
 * 而代理只取 https（按设计丢弃 http），这时 `src` 会是空串；若本机也没解出这张图，
 * RemoteImg 就停在 `empty` 并返回 null ⇒ 用户看到一个**没有任何文字的空框**，无从判断。
 * 这里把原因写出来。定义在组件外，避免卡片函数变长（函数行数棘轮只许变小）。
 *
 * 2026-10-08 用户选定 **C：两条都试** —— `src` 先给本机解密结果（`dataSrc`，命中即显示、不需联网），没有才试 CDN（http 已放行，4 秒超时）；`fallbackSrc` 仍是本机解密结果。
 * 为什么不接 `token`：已实测 9 种用法（原样 / `?token` / `?token&key` / thumb / https / 匿名参数 / 路径段 / Referer+UA / Cookie）**全部 HTTP 400**（用**最新**动态测的），接上不改变结果。因此当地址是 http（代理按设计只取 https）或代理取不到时，这一格会显示上面的说明，而**不会**用本机解密结果顶替。
 */
function MomentNoSource({ hint, detail }: { hint: string; detail?: string }): React.JSX.Element {
  return (
    <div className={css.imgFallback}>
      <div className={css.imgFallbackContent}>
        <span className={css.imgFallbackIcon}>🖼</span>
        <span className={css.imgFallbackText}>本机没有这张图</span>
        <span className={css.imgFallbackHint} title={detail}>
          {hint}
          {detail ? '（' + detail + '）' : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * 评论图的取图接线。
 *
 * `url`/`token`/`seed` 缺一不可：实测裸 `<url>`（不带 `token`/`idx=1`）5/5 返 HTTP 400、
 * 0 字节，而补上 token 后 5/5 返 200（`sns-comment-image-probe.manual.spec.ts`）。
 * 有则传、没有就不传 —— 这样后端在缺件时仍能回落到本机 md5 解密那条老路。
 */
function commentImageSpec(img: { md5?: string; url?: string; token?: string; seed?: string; thumb?: string }): MediaKeySpec {
  return {
    md5: img.md5 ?? '',
    kind: 'comment',
    ...(img.url ? { url: img.url } : {}),
    ...(img.token ? { token: img.token } : {}),
    ...(img.seed ? { seed: img.seed } : {}),
    ...(img.thumb ? { thumb: img.thumb } : {}),
  }
}


export function MomentsCard({
  m, privacy, snsImgs, snsErrs,
  articleCovers, expandedTextByCard, expandedSocialByCard,
  commentCounts, commentSortByCard, onlyMineComments,
  selfUsername,
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
  const coverSrc = (cover && imgKey(cover) && snsImgs[imgKey(cover)]) || (m.link_url && articleCovers[m.link_url]) || ''
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
              if (key) mediaKeySpec.current.set(key, { md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id, kind: 'img', url: im.url, token: im.token, seed: im.key })
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
                  {/* 只喂**后端解出来的 data URL**；理由与实测见文件头「为什么不用 CDN 地址顶着」。 */}
                  <RemoteImg
                    src={dataSrc ?? ''}
                    empty={<MomentNoSource hint={(key && snsErrs?.[key]) || '正在取原图…'} detail={key ? ('md5=' + (im.md5 || '无') + ' id=' + String(im.id ?? '无')) : '这条媒体没有 md5/id，无法定位'} />}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className={css.img}
                    pending={<div className={css.imgFallback}>加载中</div>}
                    failed={(
                      <div className={css.imgFallback}>
                        <div className={css.imgFallbackContent}>
                          <span className={css.imgFallbackIcon}>🖼</span>
                          <span className={css.imgFallbackText}>图片加载失败</span>
                          <span className={css.imgFallbackHint}>{(key && snsErrs?.[key]) || '本地缓存未找到'}</span>
                        </div>
                      </div>
                    )}
                  />
                </div>
              )
            })}
          </div>
        )}
        {m.videos.length > 0 && (
          <div className={css.videos}>
            {m.videos.map((v, vi) => {
              const vk = videoCoverKey(v)
  const vCover = vk ? snsImgs[vk] : undefined
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
                        poster={localImageSrc(vCover)}
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
                      {/* 取不到就什么都不画，下面的 ▶ 与时长照常显示（原来靠 onError 隐藏图片，效果一样） */}
                      <RemoteImg className={css.videoCover} src={vCover} alt="" loading="lazy" decoding="async" />
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
                {/* .linkCover 是固定 60×60 的框：隐藏图片只会留下一个**没有意义的空格子**
                    （实测共享文章封面里有 3 个 mmbiz.qpic.cn 的图 400，页面上就是 3 个空方块），
                    所以取不到时画 🔗 占位。与评论图/朋友圈图的失败口径一致。 */}
                <RemoteImg
                  src={coverSrc}
                  alt=""
                  failed={<span className={css.linkCoverFallback} title="封面来自公众号 CDN，原链接已失效">🔗</span>}
                />
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
                    <div key={ci} className={css.comment}
                      /* 「哪一格该去本机解码」是 IntersectionObserver 按 DOM 上的 data-sns-key 认的，
                         所以这两个属性必须挂在一个**永远在 DOM 里**的节点上：RemoteImg 在代理回话之前
                         画的是占位而不是 <img>，挂在它身上就等于这一格永远不会被观察到。 */
                      data-sns-key={c.image?.md5 || undefined}
                      data-sns-md5={c.image?.md5 || undefined}
                    >
                      <span className={css.commentName} title={'只看 ' + (c.nickname || c.username)} {...clickableKey(() => { setAuthorFilter(c.nickname || c.username || null) }, { stopPropagation: true })}>{c.nickname || c.username || '未知'}</span>
                      {c.to_username && c.to_username !== m.username && (
                        <span className={css.commentReply}>回复 {c.to_nickname || c.to_username}{target ? '：' : ''}</span>
                      )}
                      {target && <span className={kitCss.textCaption}>“{target.content.slice(0, 40)}”</span>}
                      <span className={css.commentText}>{c.content || ''}</span>
                      {c.image && (() => {
                        const img = c.image
                        const cdata = (img.md5 && snsImgs[img.md5]) || ''
                        // 补上 token 后 5/5 返 200。之前这里只登记 md5，后端拿不到地址可取。
                        if (img.md5) mediaKeySpec.current.set(img.md5, commentImageSpec(img))
                        if (cdata) return (
                          <RemoteImg
                            src={cdata}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className={css.commentImg}
                            failed={<span className={css.commentImgFallback}>[图]</span>}
                            {...clickableKey(() => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }) }, { label: '查看大图' })}
                          />
                        )
                        // 连地址都没有：留一个 [图] 记号（评论里确实存在只剩文字的图片评论）
                        return <span className={css.commentImgFallback}>[图]</span>
                      })()}
                      {c.ts > 0 && <span className={css.commentTime}>{fmtCommentTimeSec(c.ts)}</span>}
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
