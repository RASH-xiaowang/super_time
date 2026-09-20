/**
 * 通讯录面板 — React 版，忠实迁移 WeChatPanel 的 contacts 页签：分类统计
 * （联系人/群聊/公众号/服务号/企业微信/群成员/系统/已删除）、拼音首字母
 * 分组、搜索、资料卡（群主/群成员数/所在群/签名/类型）、TA的朋友圈、
 * 发消息、复制用户名、CSV 导出。数据经 DSH 后端 Remote（contact.db 完整语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { apiExportCsv, apiGetAvatar, apiGetContact360, apiGetContacts, apiSaveFileDialog } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import { cacheBounded } from '../utils/misc.ts'
import { avatarColors } from '../utils/format.ts'
import { cspSafeSrc } from '../utils/url.ts'
import type { Contact360Snapshot, WechatContact as ContactRow } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Drawer, SearchInput, Segmented, Toolbar } from '../ui/kit.tsx'
import { ExportHistoryDialog } from './ExportHistoryDialog.tsx'
import css from './contacts.module.css'
import kitCss from '../ui/kit.module.css'

const CATS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'friend', label: '联系人' },
  { key: 'group', label: '群聊' },
  { key: 'official', label: '公众号' },
  { key: 'service', label: '服务号' },
  { key: 'enterprise', label: '企业微信' },
  { key: 'member', label: '群成员' },
  { key: 'system', label: '系统' },
  { key: 'deleted', label: '已删除' },
]

function displayName(c: ContactRow): string {
  return c.displayName
}

/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtTs(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 类型标签：优先后端 local_type_label，其次按用户名模式推断。 */
function typeLabel(c: ContactRow): string {
  if (c.localTypeLabel) return c.localTypeLabel
  if (c.username.endsWith('@chatroom')) return '群聊'
  if (c.username.startsWith('gh_')) return '公众号'
  if (c.username.includes('@openim')) return '企业微信'
  return '联系人'
}

/** 头像缓存。 */
const avatarCache = new Map<string, string | null>()
/** 头像缓存上限：模块级缓存生命周期等于渲染进程，必须设上限（值为 base64 data URL）。 */
const AVATAR_CACHE_MAX = 300

/**
 * Render the contacts panel.
 * @param props - onNavigate to jump tabs; onOpenChat to open a session;
 *   onOpenMoments to jump to a member's timeline.
 * @returns the contacts element tree.
 */
export function ContactsPanel({ onNavigate, onOpenChat, onOpenMoments, seedQuery }: {
  onNavigate?: (tab: string) => void
  onOpenChat?: (username: string) => void
  onOpenMoments?: (username: string) => void
  /** 全局搜索命中「联系人」时带过来的关键词（带 nonce，同一个词连点两次也能重新种入）。 */
  seedQuery?: { q: string; nonce: number }
}): React.JSX.Element {
  const [contacts, setContacts] = useState<readonly ContactRow[]>([])
  const [stats, setStats] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')

  // 全局搜索的命中直接跳到本面板时，把关键词一起带过来（否则用户得重新输一遍）。
  useEffect(() => {
    if (!seedQuery) return
    setSearch(seedQuery.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery?.nonce])
  const [cat, setCat] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<ContactRow | null>(null)
  const [profile360, setProfile360] = useState<Contact360Snapshot | null>(null)
  const [profile360Loading, setProfile360Loading] = useState(false)
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 4000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice(4000)
  const [exporting, setExporting] = useState(false)
  /** 导出记录弹窗开关（入口在工具栏的「导出记录」按钮）。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const jumpToLetter = useCallback((letter: string): void => {
    scrollRef.current?.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' })
  }, [])

  const pager = usePagedList<ContactRow>({
    pageSize: 200,
    fetchPage: async (offset, limit) => {
      // 分类过滤必须交给后端（在分页之前过滤）。此前是在渲染层对**已分页**的
      // 结果再 filter：全局排序（字母 + 全拼）的前 200 条里若恰好没有该类目，
      // 页签看着就是空的 —— "联系人 (282)" 却显示"暂无联系人"。
      const env = await apiGetContacts({ limit, offset, category: cat })
      setStats(env.stats ?? {})
      return { items: env.contacts, total: env.total }
    },
  })

  const searching = search.trim() !== ''
  // 普通浏览：分页逐页加载；搜索时一次性拉全量（用户主动操作），保证跨页搜索结果完整。
  // 搜索与浏览都带上当前分类 —— 后端在分页之前过滤，`total` 才是该视图的真实条数。
  //
  // `searching` 与 `cat` 合成一个 effect：两者都是「筛选条件」，变化时都应当**回到第一页
  // 并回到顶部**（内容真的变了，回到顶部是预期行为）。先前拆成两个 effect 会导致
  // 挂载时连续 reset 两次，而且第二个 effect 无谓地多触发一轮取数。
  useEffect(() => {
    if (searching) {
      let cancelled = false
      setLoading(true)
      setError(null)
      void apiGetContacts({ category: cat })
        .then((env) => {
          if (cancelled) return
          setContacts(env.contacts)
          setStats(env.stats ?? {})
          setTotal(env.total)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, cat, pager.reset])

  useEffect(() => {
    if (searching) return
    setContacts(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [searching, pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => scrollRef.current)

  // 数据落地后安静刷新（有渲染缓存时不闪整页），使新联系/群名及时可见。
  // 用 `pager.refresh()`（非破坏性，会按**已加载条数**重取）而不是 `reset()`：
  // `reset()` 会同步清空列表 → 容器高度塌陷 → 浏览器把 scrollTop 钳到 0，
  // 于是实时同步每约 10 秒就把正在往下翻的用户**弹回顶部**。
  useWechatDataUpdated(() => { if (!searching) pager.refresh() })

  // 打开资料卡时异步拉取跨域社交画像（消息/朋友圈/资金/共同群）。
  useEffect(() => {
    if (!profile) { setProfile360(null); return }
    let alive = true
    setProfile360Loading(true)
    void apiGetContact360(profile.username)
      .then((r) => { if (alive) setProfile360(r) })
      .catch(() => { /* 画像失败不影响资料卡 */ })
      .finally(() => { if (alive) setProfile360Loading(false) })
    return () => { alive = false }
  }, [profile])

  const notify = (text: string): void => {
    flash(text)
  }

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    // 分类已由后端在分页之前过滤（`cat` 只作为请求参数），这里不再重复按 category 过滤 ——
    // 在这里过滤等于对**已分页**的结果再筛，正是"页签有数据却空白"的根因。
    const filtered = contacts.filter((c) => {
      if (!q) return true
      // 第 85 轮：加上备注拼音（remarkQuanPin）—— 界面上显示的是备注名，
      // 而此前只索引昵称拼音，实测 280 个有备注的联系人里 270 人搜不到自己显示出来的名字。
      return [displayName(c), c.username, c.alias ?? '', c.remark, c.quanPin ?? '', c.remarkQuanPin ?? ''].some(v => v.toLowerCase().includes(q))
    })
    const map = new Map<string, ContactRow[]>()
    for (const c of filtered) {
      const k = c.initial || '#'
      const arr = map.get(k) ?? []
      arr.push(c)
      map.set(k, arr)
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])))
  }, [contacts, search])

  const doExport = async (): Promise<void> => {
    // 先让用户选路径：此前是后端把文件写死在 `<数据根>/exports/` 下、界面只回报一个
    // 用户既没选过也很难找到的路径。默认文件名带上当前分类与日期，便于区分多次导出。
    const catLabel = CATS.find(c => c.key === cat)?.label ?? '全部'
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    const picked = await apiSaveFileDialog({
      defaultName: `通讯录-${catLabel}-${stamp}.csv`,
      title: '导出通讯录',
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
    })
    if (picked.canceled || !picked.path) return // 用户取消：静默返回，不报「失败」
    setExporting(true)
    try {
      // 带上 category：导出的内容与当前页签看到的范围一致。
      const r = await apiExportCsv({ kind: 'contacts', dest: picked.path, category: cat })
      notify(`已导出 ${r.count} 个联系人 → ${r.path}`)
    } catch (e) {
      notify('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const copyUsername = async (c: ContactRow): Promise<void> => {
    try {
      await navigator.clipboard.writeText(c.username)
      notify('已复制用户名 ' + c.username)
    } catch { notify('复制失败') }
  }

  const sendMessage = (c: ContactRow): void => {
    if (onOpenChat) {
      onOpenChat(c.username)
      return
    }
    void copyUsername(c)
    onNavigate?.('chats')
  }

  return (
    <div className={css.panel}>
      <Toolbar
        left={(
          <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索昵称 / 备注 / 微信号 / 全拼" ariaLabel="搜索联系人" />
        )}
        right={(
          <>
            <Segmented
              options={CATS.map((c) => {
                // 页签计数一律取全量口径的 stats（含 all）—— `total` 现在是**当前类目**的条数，
                // 拿它当「全部」的计数会把「全部(2150)」显示成「全部(282)」。
                const n = c.key === 'all' ? (stats.all ?? total) : (stats[c.key] ?? 0)
                return { value: c.key, label: `${c.label}${n > 0 ? ` (${n})` : ''}` }
              })}
              value={cat}
              onChange={(v) => { setCat(v) }}
              ariaLabel="联系人分类"
            />
            <button type="button" className={css.catBtn} onClick={() => { void doExport() }} disabled={exporting}>{exporting ? '导出中…' : '导出 CSV'}</button>
            {/* 导出记录：入口与「导出」放在一起。
                原先挂在「设置 → 高级设置」里 —— 那是低频维护分组，而导出是通讯录这一屏
                的动作；用户在这里点完导出，查看结果/重新导出应当就在同一处。 */}
            <button
              type="button"
              className={css.catBtn}
              data-open-export-history=""
              onClick={() => { setHistoryOpen(true) }}
              title="查看历史导出：打开文件、复制路径、按原参数重新导出、清理"
            >导出记录</button>
          </>
        )}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      <div className={css.indexBar} aria-hidden="false">
        {grouped.map(([letter]) => (
          <button key={letter} type="button" className={css.indexLetter} onClick={() => { jumpToLetter(letter) }} aria-label={'跳到字母 ' + (letter === '#' ? '其他' : letter)}>{letter === '#' ? '其' : letter}</button>
        ))}
      </div>
      <div className={css.scroll} ref={scrollRef}>
        {loading && <ListSkeleton rows={12} />}
        {error && <div className={kitCss.error} role="alert">{error}</div>}
        {!loading && !error && grouped.length === 0 && <div className={kitCss.emptyInline}>暂无联系人</div>}
        {!loading && !error && grouped.map(([letter, list]) => (
          <div key={letter} className={css.group} data-letter={letter}>
            {/* `#` 是「没有任何拼音可依」的兜底桶（微信只为加过好友的联系人写拼音首字母，
                群成员常常两列全空）。标成「其他」而不是让用户以为分组坏了。 */}
            <div className={css.letterHd}>{letter === '#' ? '其他' : letter}（{list.length}）</div>
            {/* 多列网格：分组头独占一行，组内联系人按 `flex: 1 1 240px` 自动排 3–5 列。
                原先单列全宽时，每行只有「36px 头像 + 名字 + 类型」，右侧整片空白。 */}
            <div className={css.list}>
              {list.map(c => (<ContactRowItem key={c.username} c={c} onOpen={() =>{  setProfile(c) }} />))}
            </div>
          </div>
        ))}
        {!loading && !error && !searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </div>

      {/* 资料卡抽屉 */}
      <Drawer open={profile !== null} onClose={() => { setProfile(null) }} title={profile ? displayName(profile) : '联系人资料'} width={460}>
        {profile && (
          <>
            <div className={css.profileHd}>
              <ContactAvatar c={profile} size={56} />
              <div className={css.profileNames}>
                <div className={css.profileName}>{displayName(profile)}</div>
                <div className={css.profileType}>{typeLabel(profile)}</div>
              </div>
            </div>
            <div className={css.profileRow}><span>微信号</span><code>{profile.username}</code></div>
            {profile.alias && <div className={css.profileRow}><span>别名</span><span>{profile.alias}</span></div>}
            {profile.remark && <div className={css.profileRow}><span>备注</span><span>{profile.remark}</span></div>}
            {profile.nickName && profile.nickName !== profile.displayName && (
              <div className={css.profileRow}><span>昵称</span><span>{profile.nickName}</span></div>
            )}
            {profile.description && <div className={css.profileRow}><span>签名</span><span>{profile.description}</span></div>}
            {profile.memberCount != null && <div className={css.profileRow}><span>群成员数</span><span>{profile.memberCount} 人</span></div>}
            {profile.owner && <div className={css.profileRow}><span>群主</span><span>{profile.owner}</span></div>}
            {profile.groupName && (
              <div className={css.profileRow}>
                <span>所在群</span>
                <button type="button" className={css.linkBtn} onClick={() => { setProfile(null); onOpenChat?.(profile.groupUsername ?? '') }}>{profile.groupName}</button>
              </div>
            )}
            {profile360Loading && <div className={css.profileRow}><span>画像</span><span>统计中…</span></div>}
            {profile360 && (
              <>
                <div className={css.profileSection}>社交画像</div>
                <div className={css.profileRow}><span>消息</span><span>{profile360.messages.count.toLocaleString()} 条{profile360.messages.lastTime ? ` · 最近 ${fmtTs(profile360.messages.lastTime)}` : ''}</span></div>
                {profile360.messages.firstTime ? (
                  <div className={css.profileRow}><span>认识</span><span>{fmtTs(profile360.messages.firstTime)}</span></div>
                ) : null}
                <div className={css.profileRow}><span>朋友圈</span><span>{profile360.moments.count.toLocaleString()} 条</span></div>
                <div className={css.profileRow}>
                  <span>资金往来</span>
                  <span>转账 {profile360.funds.transfers} · 红包 {profile360.funds.redpackets}</span>
                </div>
                {profile360.commonGroups.length > 0 && (
                  <div className={css.profileRow}>
                    <span>共同群</span>
                    <span className={css.commonGroups}>
                      {profile360.commonGroups.map(g => (
                        <button
                          key={g.username}
                          type="button"
                          className={css.groupChip}
                          onClick={() => { setProfile(null); onOpenChat?.(g.username) }}
                          title={`${g.name} · ${g.memberCount} 人`}
                        >
                          {g.name} ({g.memberCount})
                        </button>
                      ))}
                    </span>
                  </div>
                )}
              </>
            )}
            <div className={css.profileActions}>
              <button type="button" className={css.catBtn} onClick={() => { void copyUsername(profile) }}>复制用户名</button>
              {onOpenMoments && <button type="button" className={css.catBtn} onClick={() => { setProfile(null); onOpenMoments(profile.username) }}>TA 的朋友圈</button>}
              <button type="button" className={css.catBtn} onClick={() => { setProfile(null); sendMessage(profile) }}>发消息</button>
            </div>
          </>
        )}
      </Drawer>

      {/* 导出记录弹窗。入口在工具栏「导出记录」按钮 —— 与「导出 CSV」同处，
          用户导完就地能查结果/重新导出/清理，不必再跳设置。
          默认预筛「通讯录」，与本屏上下文一致（可在下拉里改回「全部」）。 */}
      <ExportHistoryDialog open={historyOpen} onClose={() => { setHistoryOpen(false) }} initialKind="contacts" />
    </div>
  )
}

/** 联系人行（含懒加载头像）。 */
function ContactRowItem({ c, onOpen }: { c: ContactRow; onOpen: () => void }): React.JSX.Element {
  // 次要行补上有信息量的字段（此前只有类型，多列网格下右半格是空的）：
  //   群聊 → 类型 + 成员数（"群聊 · 486 人"）
  //   其余 → 类型 + 微信号（长了会按 CSS 省略号截断）
  const meta = c.memberCount != null && c.memberCount > 0
    ? `${typeLabel(c)} · ${c.memberCount} 人`
    : (c.username ? `${typeLabel(c)} · ${c.username}` : typeLabel(c))
  return (
    <div key={c.username} className={css.contactItem} {...clickableKey(onOpen)}>
      <LazyMount placeholder={<div className={`${css.avatar} ${css.avatarPlaceholder}`}>…</div>} rootMargin="400px 0px">
        <ContactAvatar c={c} size={34} />
      </LazyMount>
      <div className={css.contactInfo}>
        <span className={css.contactName} title={displayName(c)}>{displayName(c)}</span>
        <span className={css.contactMeta} title={meta}>{meta}</span>
      </div>
    </div>
  )
}

/** 联系人头像（head_image 数据 / 远程 URL / 首字母占位）。 */
function ContactAvatar({ c, size }: { c: ContactRow; size: number }): React.JSX.Element {
  const key = c.username || displayName(c) || ''
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!key) return
    // 快照里的 avatarUrl 只有**被 CSP 放行**时才能直接当 src（实测 1,994 个里 400 个是 http，
    // 直接用会产生 CSP 违规）。为空的（http/空）**不能就此返回** —— 掉到下一行走后端解析，
    // 那里会先给本地离线头像（head_image.db），其次才是 https 远端 URL。
    const safe = cspSafeSrc(c.avatarUrl)
    if (safe) { setSrc(safe); return }
    const cached = avatarCache.get(key)
    if (cached !== undefined) { setSrc(cached); return }
    apiGetAvatar({ username: key })
      .then((r) => {
        const v = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null
        cacheBounded(avatarCache, key, v, AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(v)
      })
      .catch(() => { cacheBounded(avatarCache, key, null, AVATAR_CACHE_MAX); if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  }, [key, c.avatarUrl])
  if (src) {
    return <img src={src} alt="" className={`${css.avatarImg} ${css.avatarImgRound}`} width={size} height={size} loading="lazy" />
  }
  const letter = displayName(c).slice(0, 1).toUpperCase()
  // 第 88 轮：底色 + 文字色一起由 avatarColors 给（白字在 hsl(h 45% 55%) 上 360 个色相只有 57 个达标）
  const av = avatarColors(c.username || displayName(c))
  return <div className={css.avatar} style={{ width: size, height: size, background: av.background, color: av.color }}>{letter}</div>
}
