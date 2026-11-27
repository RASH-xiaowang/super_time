/**
 * 表情面板 — 个人表情包 / 其他表情包 / 表情商店 三个分区。
 *
 * ## 2026-10-17 重做（用户：「分为个人表情包和其他表情包」）
 *
 * 改前只有一个「全部 / 自定义 / 表情包」三页签，其中「自定义」= 用户自己收藏的表情，
 * 「表情包」= 表情商店的包名列表。用户要的是：
 *   · **个人表情包** —— 只包含自己的表情（`kNonStoreEmoticonTable`）；
 *   · **其他表情包** —— 收集其他群聊或个人发送的任何表情（从消息库扫出来的）。
 *
 * 现在三个页签：
 *   · `mine`    个人表情包：`custom`（用户收藏的，顺序与微信一致）
 *   · `others`  其他表情包：`others`（消息库里出现、但自己没收藏的，按出现次数降序）
 *   · `packages` 表情商店：`packages`（包名 + 表情数）
 *
 * 搜索对三个页签都生效（按 caption / MD5 / 包名）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { copyTextToClipboard } from '../utils/misc.ts'
import { ListSentinel, ListSkeleton, ProgressiveListSpacer, useLazySentinel, usePagedList, useProgressiveList, useTransientNotice } from './hooks.tsx'
import { apiGetEmoticons } from '../api.ts'
import type { EmoticonsSnapshot, EmoticonItem } from '@deepseek-ai/dsh-wechat-data/types'
import { EmptyMaybeSyncing, SearchInput, Select, Toolbar } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import kitCss from '../ui/kit.module.css'
import { PackageCell } from './asset-ui.tsx'
import { EmoticonVirtualGrid } from './emoticon-grid.tsx'

/** 三个页签。 */
type EmoTab = 'mine' | 'others' | 'packages'

/**
 * Render the emoticons panel.
 * @returns the emoticons element tree.
 */
export function EmoticonsPanel(): React.JSX.Element {
  const [custom, setCustom] = useState<readonly EmoticonItem[]>([])
  const [others, setOthers] = useState<readonly EmoticonItem[]>([])
  const [othersTotal, setOthersTotal] = useState(0)
  const [packages, setPackages] = useState<EmoticonsSnapshot['packages']>([])
  const [total, setTotal] = useState(0)
  // 自定义表情的顺序来源：'wechat' = 按 kFavEmoticonOrderTable（微信里的自定义排序），
  // 'builtin' = 该表缺失/失败时退化为收藏表内置顺序。只在确有其实时才在前端声明。
  const [orderedBy, setOrderedBy] = useState<EmoticonsSnapshot['orderedBy']>(undefined)
  const [tab, setTab] = useState<EmoTab>('mine')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()

  const [othersLoaded, setOthersLoaded] = useState(false)
  const [othersLoading, setOthersLoading] = useState(false)

  const pager = usePagedList<EmoticonItem>({
    pageSize: 200,
    fetchPage: async (offset, limit) => {
      // 个人表情不带消息库扫描。那次扫描只在用户打开「其他表情包」时发生。
      const env = await apiGetEmoticons({ limit, offset, includeOthers: false })
      setPackages(env.packages)
      setTotal(env.total)
      setOrderedBy(env.orderedBy)
      return { items: env.custom, total: env.total }
    },
  })

  const searching = search.trim() !== ''
  // 普通浏览：分页逐页加载；搜索时一次性拉取 2000 条（用户主动操作），保证跨页搜索结果完整。
  useEffect(() => {
    if (searching) {
      let cancelled = false
      setLoading(true)
      setError(null)
      void apiGetEmoticons({ limit: 2000, includeOthers: false })
        .then((env) => {
          if (cancelled) return
          setCustom(env.custom)
          setPackages(env.packages)
          setTotal(env.total)
          setOrderedBy(env.orderedBy)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, pager.reset])

  // 「其他表情」要扫全部分片，打开面板时不算；切到这一档再算，算过就留在本次挂载里。
  useEffect(() => {
    if (tab !== 'others' || othersLoaded) return undefined
    let cancelled = false
    setOthersLoading(true)
    void apiGetEmoticons({ limit: 1, offset: 0, includeOthers: true })
      .then((env) => {
        if (cancelled) return
        setOthers(env.others ?? [])
        setOthersTotal(env.othersTotal ?? env.others?.length ?? 0)
        setOthersLoaded(true)
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setOthersLoading(false) })
    return () => { cancelled = true }
  }, [tab, othersLoaded])

  useEffect(() => {
    if (searching) return
    setCustom(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [searching, pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, undefined, undefined, pager.items.length)

  const notify = (text: string): void => {
    flash(text)
  }

  const q = useMemo(() => search.trim().toLowerCase(), [search])
  /** 按 caption / MD5 过滤一组表情。 */
  const filterEmo = (list: readonly EmoticonItem[]): readonly EmoticonItem[] => {
    if (!q) return list
    return list.filter(e => e.md5.toLowerCase().includes(q) || (e.caption ?? '').toLowerCase().includes(q))
  }
  const filteredMine = useMemo(() => filterEmo(custom), [custom, q])
  const filteredOthers = useMemo(() => filterEmo(others), [others, q])
  const filteredPackages = useMemo(() => {
    if (!q) return packages
    return packages.filter(p => p.name.toLowerCase().includes(q))
  }, [packages, q])

  const shown = tab === 'mine' ? filteredMine : tab === 'others' ? filteredOthers : []
  const othersCaption = othersLoaded ? String(othersTotal) : (othersLoading ? '统计中' : '…')
  const busy = loading || (tab === 'others' && othersLoading && !othersLoaded)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const windowKey = `${tab}\u0000${q}`
  const { start: pkgStart, count: pkgCount, beforeHeight: pkgBefore, sentinelRef: pkgSentinel, topSentinelRef: pkgTopSentinel } = useProgressiveList(
    tab === 'packages' ? filteredPackages.length : 0,
    150,
    { maxCount: 300, resetKey: windowKey, listRef: gridRef },
  )

  const copyMd5 = (md5: string): void => {
    void copyTextToClipboard(md5).then((ok) => { notify(ok ? '已复制 MD5: ' + md5.slice(0, 8) + '…' : '复制失败') })
  }

  return (
    <div className={css.panel}>
      {/* 页头与「个人/其他/表情商店」三层分类合并成一条工具栏：搜索 + 二级下拉。
          这样不会出现「顶部分段条 + 面板内页签」两层并排的观感。 */}
      <Toolbar
        left={(
          <>
            <SearchInput
              className={css.searchGrow}
              value={search}
              onChange={setSearch}
              placeholder="搜索表情名称 / MD5 / 表情包名"
              ariaLabel="搜索表情"
            />
            <span className={kitCss.textCaption}>
              {busy && custom.length === 0 && tab !== 'others'
                ? '正在加载…（后端启动同步期间首次查询约需 20-30 秒）'
                : `个人 ${String(searching ? custom.length : (total || custom.length))} · 其他 ${othersCaption} · 表情包 ${String(packages.length)}${orderedBy === 'wechat' ? ' · 顺序与微信一致' : ''}`}
            </span>
          </>
        )}
        right={(
          <Select
            value={tab}
            onChange={(v) => { setTab(v as EmoTab) }}
            ariaLabel="表情分类"
            options={[
              { value: 'mine', label: `个人表情包 (${searching ? filteredMine.length : total || filteredMine.length})` },
              { value: 'others', label: `其他表情包 (${othersLoaded ? filteredOthers.length : '…'})` },
              { value: 'packages', label: `表情商店 (${filteredPackages.length})` },
            ]}
          />
        )}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">⚠️ 表情数据加载失败（{error}）</div>}
      {tab !== 'packages' && (busy ? <div className={css.emoScroll}><ListSkeleton rows={10} grid /></div>
        : shown.length === 0 ? (
          <div className={css.emoScroll}>
            <EmptyMaybeSyncing
              text={q ? '未找到相关表情' : tab === 'mine' ? '暂无个人表情' : '暂无其他表情'}
            />
          </div>
        ) : (
          <EmoticonVirtualGrid
            items={shown}
            onCopy={copyMd5}
            footer={!searching && tab === 'mine' && pager.hasMore ? <ListSentinel refFn={loadMoreRef} /> : null}
          />
        ))}
      {tab === 'packages' && (
      <div ref={gridRef} className={css.grid}>
        {busy && <ListSkeleton rows={10} grid />}
        {!busy && !error && filteredPackages.length === 0 && (
          <EmptyMaybeSyncing
            text={q ? '未找到相关表情包' : '暂无表情包'}
          />
        )}
        {!busy && !error && <ProgressiveListSpacer height={pkgBefore} topSentinelRef={pkgTopSentinel} />}
        {!busy && !error && filteredPackages.slice(pkgStart, pkgCount).map((p, idx) => (
          <PackageCell key={p.name} name={p.name} count={p.count} itemIndex={pkgStart + idx} />
        ))}
        {!busy && !error && filteredPackages.length > pkgCount && <ListSentinel refFn={pkgSentinel} />}
      </div>
      )}
    </div>
  )
}
