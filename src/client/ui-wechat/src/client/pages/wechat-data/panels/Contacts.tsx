/**
 * 通讯录面板 — 微信桌面端风格：36px 工具行（标题 / 搜索 / 筛选 / 更多）、
 * 5 个分类分段（其余分类进「筛选」菜单）、字母索引（列表 >50 条时显示）、
 * 多列联系人网格、资料抽屉（群主/群成员数/所在群/签名/类型）、TA 的朋友圈、
 * 发消息、复制用户名、CSV 导出与导出记录。数据经 DSH 后端 Remote（contact.db 完整语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { apiExportCsv, apiGetAvatarBatched, apiGetContact360, apiGetContacts, apiSaveFileDialog } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import { cacheBounded, copyTextToClipboard } from '../utils/misc.ts'
import { avatarColors } from '../utils/format.ts'
import { localImageSrc } from './remote-img.tsx'
import type { Contact360Snapshot, WechatContact as ContactRow } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Drawer, EmptyMaybeSyncing, LinkButton, SearchInput, Segmented } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { ExportHistoryDialog } from './ExportHistoryDialog.tsx'
import { useAvatarPrewarm } from './contacts-avatar-prewarm.ts'
import css from './contacts.module.css'
import kitCss from '../ui/kit.module.css'

/**
 * 联系人的全部互斥分类（后端 `category` 口径）。
 * 「全部 / 联系人 / 群聊 / 公众号」在主分段里常驻；其余 5 类收进「筛选」菜单 ——
 * 它们合计占比低，平铺会把工具行挤成两行。
 */
const OTHER_CATS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'service', label: '服务号' },
  { key: 'enterprise', label: '企业微信' },
  { key: 'member', label: '群成员' },
  { key: 'system', label: '系统' },
  { key: 'deleted', label: '已删除' },
]
const OTHER_KEYS = new Set(OTHER_CATS.map(c => c.key))
/** 主分段：4 个常用分类 + 一个「其它」入口（点开筛选菜单）。 */
const VISIBLE_CATS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'friend', label: '联系人' },
  { key: 'group', label: '群聊' },
  { key: 'official', label: '公众号' },
  { key: 'other', label: '其它' },
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
/** 头像缓存上限（模块级缓存生命周期 = 渲染进程，必须设上限；值同时是**预热条数**上限）。 */
const AVATAR_CACHE_MAX = 300

/** 字母索引只在列表足够长时才出现（短列表上它只是装饰）。 */
const INDEX_MIN_ROWS = 50

/** 工具行里的下拉菜单标号。 */
type ToolMenu = 'filter' | 'more' | null

/** 工具行：标题 + 搜索 + 分类分段 + 筛选 + 更多（窄窗允许换行）。 */
function ContactsToolbar(props: {
  search: string
  onSearch: (v: string) => void
  total: number
  cat: string
  catValue: string
  segOptions: ReadonlyArray<{ value: string; label: string }>
  stats: Record<string, number>
  exporting: boolean
  onSegChange: (v: string) => void
  onCat: (key: string) => void
  onExport: () => void
  onOpenHistory: () => void
}): React.JSX.Element {
  const { search, onSearch, total, cat, catValue, segOptions, stats, exporting, onSegChange, onCat, onExport, onOpenHistory } = props
  const [menu, setMenu] = useState<ToolMenu>(null)
  const toolRef = useRef<HTMLDivElement | null>(null)
  // 点外面 / 按 Esc 关闭菜单（浮层不关会一直挡着列表）。
  useEffect(() => {
    if (menu === null) return
    const onDown = (e: MouseEvent): void => {
      if (toolRef.current !== null && !toolRef.current.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])
  return (
    <div className={css.toolRow} ref={toolRef}>
      <span className={css.toolTitle}>通讯录</span>
      <SearchInput value={search} onChange={onSearch} placeholder="搜索昵称 / 备注 / 微信号 / 全拼" ariaLabel="搜索联系人" className={css.toolSearch} />
      <span className={css.toolCount}>共 {total.toLocaleString()} 人</span>
      <span className={css.toolSpacer} />
      <div
        className={css.segWrap}
        /* 「其它」既是当前分类的聚合显示、也是筛选菜单的入口。
           Radix 单选分段在「点已选中项」时不会再回调 onChange —— 落进「其它」之后
           想换另一个低频分类时，靠这里补一次菜单开关。 */
        onClickCapture={(e) => {
          if (catValue !== 'other') return
          const btn = (e.target as HTMLElement).closest('button')
          if (btn?.textContent?.startsWith('其它') === true) setMenu(m => (m === 'filter' ? null : 'filter'))
        }}
      >
        <Segmented
          options={segOptions}
          value={catValue}
          /* 'other' 只是筛选菜单的入口，不直接改分类（菜单项才是真正的分类）。 */
          onChange={(v) => { if (v === 'other') setMenu(m => (m === 'filter' ? null : 'filter')); else onSegChange(v) }}
          ariaLabel="联系人分类"
        />
      </div>
      <div className={css.menuWrap}>
        <button
          type="button"
          className={css.toolBtn}
          aria-haspopup="menu"
          aria-expanded={menu === 'filter'}
          data-on={OTHER_KEYS.has(cat) || undefined}
          onClick={() => { setMenu(m => m === 'filter' ? null : 'filter') }}
        >筛选 ▾</button>
        {menu === 'filter' && (
          <div className={css.menu} role="menu" aria-label="更多联系人分类">
            <div className={css.menuLabel}>更多分类</div>
            {OTHER_CATS.map(c => (
              <button
                key={c.key}
                type="button"
                role="menuitemradio"
                aria-checked={cat === c.key}
                className={css.menuItem}
                data-on={cat === c.key || undefined}
                onClick={() => { onCat(c.key); setMenu(null) }}
              >
                <span>{c.label}</span>
                <span className={css.menuCount}>{stats[c.key] ?? 0}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={css.menuWrap}>
        <button
          type="button"
          className={css.toolBtn}
          aria-haspopup="menu"
          aria-expanded={menu === 'more'}
          onClick={() => { setMenu(m => m === 'more' ? null : 'more') }}
        >更多 ▾</button>
        {menu === 'more' && (
          <div className={css.menu} role="menu" aria-label="通讯录更多操作">
            <button
              type="button"
              role="menuitem"
              className={css.menuItem}
              onClick={() => { setMenu(null); onExport() }}
              disabled={exporting}
              {...desktopActionProps()}
            >{exporting ? '导出中…' : desktopAction() ? '导出 CSV（仅电脑）' : '导出 CSV'}</button>
            {/* 导出记录：与「导出」同处，用户导完就地能查结果/重新导出/清理。 */}
            <button
              type="button"
              role="menuitem"
              className={css.menuItem}
              data-open-export-history=""
              title="查看历史导出：打开文件、复制路径、按原参数重新导出、清理"
              onClick={() => { setMenu(null); onOpenHistory() }}
              {...desktopActionProps()}
            >{desktopAction() ? '导出记录（仅电脑）' : '导出记录'}</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 资料抽屉（kit Drawer：实色白底、1px 边框、无模糊）。 */
function ContactProfileDrawer(props: {
  profile: ContactRow | null
  profile360: Contact360Snapshot | null
  profile360Loading: boolean
  onClose: () => void
  onCopyUsername: (c: ContactRow) => void
  onOpenChat?: ((username: string) => void) | undefined
  onOpenMoments?: ((username: string) => void) | undefined
  onSendMessage: (c: ContactRow) => void
}): React.JSX.Element {
  const { profile, profile360, profile360Loading, onClose, onCopyUsername, onOpenChat, onOpenMoments, onSendMessage } = props
  return (
    <Drawer open={profile !== null} onClose={onClose} title={profile ? displayName(profile) : '联系人资料'} width={460}>
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
              <LinkButton onClick={() => { onClose(); onOpenChat?.(profile.groupUsername ?? '') }}>{profile.groupName}</LinkButton>
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
                        onClick={() => { onClose(); onOpenChat?.(g.username) }}
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
            <button type="button" className={css.catBtn} onClick={() => { onCopyUsername(profile) }}>复制用户名</button>
            {onOpenMoments && <button type="button" className={css.catBtn} onClick={() => { onClose(); onOpenMoments(profile.username) }}>TA 的朋友圈</button>}
            <button type="button" className={css.catBtn} onClick={() => { onClose(); onSendMessage(profile) }}>发消息</button>
          </div>
        </>
      )}
    </Drawer>
  )
}

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
  /** 导出记录弹窗开关（入口收在工具行的「更多」菜单里）。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const jumpToLetter = useCallback((letter: string): void => {
    scrollRef.current?.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' })
  }, [])

  const pager = usePagedList<ContactRow>({
    pageSize: 200, maxItems: 1000,
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
  // `searching` 与 `cat` 合成一个 effect：两者都是「筛选条件」，变化时都应当**回到第一页并回到顶部**。
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

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => scrollRef.current, pager.items.length)
  useAvatarPrewarm(contacts, avatarCache, AVATAR_CACHE_MAX, !searching)
  // 数据落地后安静刷新：用 `pager.refresh()`（非破坏性）而不是 `reset()`，否则实时同步
  // 每约 10 秒会把正在往下翻的用户弹回顶部。
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
      // 加上备注拼音（remarkQuanPin）—— 界面上显示的是备注名，只索引昵称拼音时，
      // 实测 280 个有备注的联系人里 270 人搜不到自己显示出来的名字。
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

  /** 当前分类的显示值：其余 5 类在分段上统一显示为「其它」。 */
  const catValue = OTHER_KEYS.has(cat) ? 'other' : cat
  /** 「其它」分段上的计数 = 菜单里 5 类之和。 */
  const otherCount = useMemo(() => OTHER_CATS.reduce((sum, c) => sum + (stats[c.key] ?? 0), 0), [stats])
  /** 当前落在「其它」里的具体分类名（用于分段文案，避免用户不知道自己在看什么）。 */
  const otherActiveLabel = OTHER_KEYS.has(cat) ? (OTHER_CATS.find(c => c.key === cat)?.label ?? '') : ''
  const segOptions = useMemo(() => VISIBLE_CATS.map((c) => {
    // 页签计数一律取全量口径的 stats —— `total` 现在是**当前类目**的条数。
    const n = c.key === 'all' ? (stats.all ?? total) : c.key === 'other' ? otherCount : (stats[c.key] ?? 0)
    const label = c.key === 'other' && otherActiveLabel ? `其它 · ${otherActiveLabel}` : c.label
    return { value: c.key, label: `${label}${n > 0 ? ` (${n})` : ''}` }
  }), [stats, total, otherCount, otherActiveLabel])

  /** 分段点击：'other' 只是筛选菜单的入口，不直接改分类。 */
  const onSegChange = (v: string): void => {
    if (v === 'other') return
    setCat(v)
  }

  const doExport = async (): Promise<void> => {
    // 先让用户选路径：默认文件名带上当前分类与日期，便于区分多次导出。
    const catLabel = cat === 'all' ? '全部' : (OTHER_CATS.find(c => c.key === cat)?.label ?? (cat === 'friend' ? '联系人' : cat === 'group' ? '群聊' : '公众号'))
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
    // 走共享助手：异步 API 被拒（窗口失焦、权限被挡）时它还会试 `execCommand` 那条退路，
    // 而 `ok===false` 才真的是「没复制上」—— 直接 catch `writeText` 会把退路丢掉。
    const ok = await copyTextToClipboard(c.username)
    notify(ok ? '已复制用户名 ' + c.username : '复制失败')
  }

  const sendMessage = (c: ContactRow): void => {
    if (onOpenChat) {
      onOpenChat(c.username)
      return
    }
    void copyUsername(c)
    onNavigate?.('chats')
  }

  // 字母索引只对足够长的列表有意义；搜索态下它也没用（结果集已经很小）。
  const showIndex = !searching && total > INDEX_MIN_ROWS

  return (
    <div className={css.panel}>
      <ContactsToolbar
        search={search} onSearch={setSearch} total={total}
        cat={cat} catValue={catValue} segOptions={segOptions} stats={stats}
        exporting={exporting}
        onSegChange={onSegChange} onCat={setCat}
        onExport={() => { void doExport() }}
        onOpenHistory={() => { setHistoryOpen(true) }}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      {showIndex && (
        <div className={css.indexBar} aria-hidden="false">
          {grouped.map(([letter]) => (
            <button key={letter} type="button" className={css.indexLetter} onClick={() => { jumpToLetter(letter) }} aria-label={'跳到字母 ' + (letter === '#' ? '其他' : letter)}>{letter === '#' ? '其' : letter}</button>
          ))}
        </div>
      )}
      <div className={css.scroll} ref={scrollRef}>
        {/* 骨架必须与真实栅格同形（U3）：真实内容是 `.list` 的多列网格
            （`repeat(auto-fill, minmax(240px, 1fr))`，实测排 3–5 列），
            而单列行模式会让骨架先铺一列、数据到了再散成多列 —— 看起来像"布局跳了一下"。
            列宽下限与 `.list` 逐字对齐，`consistency-r7.wiring.spec.ts` 钉着这个等式。 */}
        {loading && <ListSkeleton rows={12} grid minCol={240} />}
        {error && <div className={kitCss.error} role="alert">{error}</div>}
        {!loading && !error && grouped.length === 0 && <EmptyMaybeSyncing text="暂无联系人" />}
        {!loading && !error && grouped.map(([letter, list]) => (
          <div key={letter} className={css.group} data-letter={letter}>
            {/* `#` 是「没有任何拼音可依」的兜底桶（微信只为加过好友的联系人写拼音首字母，
                群成员常常两列全空）。标成「其他」而不是让用户以为分组坏了。 */}
            <div className={css.letterHd}>{letter === '#' ? '其他' : letter}（{list.length}）</div>
            <div className={css.list}>
              {list.map(c => (<ContactRowItem key={c.username} c={c} onOpen={() =>{  setProfile(c) }} />))}
            </div>
          </div>
        ))}
        {!loading && !error && !searching && (pager.capped ? <CapNote loaded={contacts.length} total={total} /> : pager.hasMore && <ListSentinel refFn={loadMoreRef} />)}
      </div>

      <ContactProfileDrawer
        profile={profile} profile360={profile360} profile360Loading={profile360Loading}
        onClose={() => { setProfile(null) }}
        onCopyUsername={(c) => { void copyUsername(c) }}
        onOpenChat={onOpenChat}
        onOpenMoments={onOpenMoments}
        onSendMessage={sendMessage}
      />

      {/* 导出记录弹窗。入口收在工具行「更多」里 —— 与「导出 CSV」同处；
          手机态**不挂载**（真机量到：弹窗即使关着，挂载时也会打一次 `getExportHistory` ——
          分页器不看 `open`，而那不在远程白名单里）。 */}
      {!desktopAction() && <ExportHistoryDialog open={historyOpen} onClose={() => { setHistoryOpen(false) }} initialKind="contacts" />}
    </div>
  )
}

/** 「已加载前 N 位」提示条（触到 `usePagedList` 的 `maxItems` 上界时显示）。 */
function CapNote({ loaded, total }: { loaded: number; total: number }): React.JSX.Element {
  return <div className={css.capNote} role="status">已加载前 {loaded} 位（共 {total} 位）。要找人请用上方搜索。</div>
}

/** 联系人行（含懒加载头像）。 */
function ContactRowItem({ c, onOpen }: { c: ContactRow; onOpen: () => void }): React.JSX.Element {
  // 次要行补上有信息量的字段：群聊 → 类型 + 成员数；其余 → 类型 + 微信号（CSS 省略号截断）。
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
    // 快照里的 avatarUrl 只有**本机地址**才能直接当 src：远程地址不许由渲染层自己去要（M23 ——
    // 那两个出网开关管不到 `<img>` 自己发的请求）。命中不了时**继续往下走** `apiGetAvatarBatched`，
    // 那一层会把远程地址交给后端代理（本机离线头像优先，其次代理远端图；都拿不到才算没有头像）。
    const local = localImageSrc(c.avatarUrl)
    if (local) { setSrc(local); return }
    const cached = avatarCache.get(key)
    if (cached !== undefined) { setSrc(cached); return }
    // 走攒批队列：一屏 N 个联系人合成一次 `getAvatarsLocal`，而不是 N 次 `getAvatar`。
    // 通讯录一屏最多 1000 行（`maxItems`），逐张发就是 1000 次 RPC。
    apiGetAvatarBatched({ username: key })
      .then((r) => {
        const v = r.kind === 'data' ? (r.data ?? null) : null
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
  // 底色 + 文字色一起由 avatarColors 给（白字在 hsl(h 45% 55%) 上 360 个色相只有 57 个达标）
  const av = avatarColors(c.username || displayName(c))
  return <div className={css.avatar} style={{ width: size, height: size, background: av.background, color: av.color }}>{letter}</div>
}
