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
import { useEffect, useMemo, useState } from 'react'
import { copyTextToClipboard } from '../utils/misc.ts'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList, useTransientNotice } from './hooks.tsx'
import { apiGetEmoticons } from '../api.ts'
import type { EmoticonsSnapshot, EmoticonItem } from '@deepseek-ai/dsh-wechat-data/types'
import { EmptyMaybeSyncing, SearchInput, Select, Toolbar } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import kitCss from '../ui/kit.module.css'
import { EmoticonCell, PackageCell } from './asset-ui.tsx'

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

  const pager = usePagedList<EmoticonItem>({
    pageSize: 200,
    fetchPage: async (offset, limit) => {
      const env = await apiGetEmoticons({ limit, offset })
      setPackages(env.packages)
      setTotal(env.total)
      setOrderedBy(env.orderedBy)
      // `others` 只在第一页返回（后端只在 offset === 0 时扫消息库）。
      if (offset === 0) {
        setOthers(env.others ?? [])
        setOthersTotal(env.othersTotal ?? 0)
      }
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
      void apiGetEmoticons({ limit: 2000 })
        .then((env) => {
          if (cancelled) return
          setCustom(env.custom)
          setPackages(env.packages)
          setTotal(env.total)
          setOrderedBy(env.orderedBy)
          setOthers(env.others ?? [])
          setOthersTotal(env.othersTotal ?? 0)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, pager.reset])

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
  const { count: emoCount, sentinelRef: emoSentinel } = useProgressiveList(shown.length, 150)
  const { count: pkgCount, sentinelRef: pkgSentinel } = useProgressiveList(tab === 'packages' ? filteredPackages.length : 0, 150)

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
              {loading && custom.length === 0
                ? '正在加载…（后端启动同步期间首次查询约需 20-30 秒）'
                : `个人 ${String(custom.length)} · 其他 ${String(othersTotal)} · 表情包 ${String(packages.length)}${orderedBy === 'wechat' ? ' · 顺序与微信一致' : ''}`}
            </span>
          </>
        )}
        right={(
          <Select
            value={tab}
            onChange={(v) => { setTab(v as EmoTab) }}
            ariaLabel="表情分类"
            options={[
              { value: 'mine', label: `个人表情包 (${filteredMine.length})` },
              { value: 'others', label: `其他表情包 (${filteredOthers.length})` },
              { value: 'packages', label: `表情商店 (${filteredPackages.length})` },
            ]}
          />
        )}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      <div className={css.grid}>
        {loading && <ListSkeleton rows={10} grid />}
        {error && <div className={kitCss.error} role="alert">⚠️ 表情数据加载失败（{error}）</div>}

        {/* 个人表情包 / 其他表情包：都是表情网格。 */}
        {!loading && !error && tab !== 'packages' && shown.length === 0 && (
          <EmptyMaybeSyncing
            text={q ? '未找到相关表情' : tab === 'mine' ? '暂无个人表情' : '暂无其他表情'}
            note={q
              ? '换个关键词再试；表情按名称与 MD5 匹配。'
              : tab === 'mine'
                ? '个人表情来自微信「我收藏的表情」：没收藏过，或刚启动后台仍在同步（首次约 1–2 分钟）时都会是空的。'
                : '其他表情来自聊天记录里别人发过的表情。取到图后会永久保存到本地缓存，下次打开直接显示。'}
          />
        )}
        {!loading && !error && tab !== 'packages' && shown.slice(0, emoCount).map((e: EmoticonItem) => (
          <EmoticonCell key={e.md5} e={e} onCopy={copyMd5} />
        ))}
        {!loading && !error && tab !== 'packages' && shown.length > emoCount && <ListSentinel refFn={emoSentinel} />}
        {/* 个人表情还有下一页时才挂分页哨兵；「其他表情」是一次性返回的完整列表。 */}
        {!loading && !error && tab === 'mine' && !searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}

        {/* 表情商店：包名 + 表情数。 */}
        {!loading && !error && tab === 'packages' && filteredPackages.length === 0 && (
          <EmptyMaybeSyncing
            text={q ? '未找到相关表情包' : '暂无表情包'}
            note={q
              ? '换个关键词再试；表情包按名称匹配。'
              : '表情包来自微信「表情商店」的本地缓存：没下载/收藏过表情包，或刚启动后台仍在同步（首次约 1–2 分钟）时都会是空的。'}
          />
        )}
        {!loading && !error && tab === 'packages' && filteredPackages.slice(0, pkgCount).map(p => (
          <PackageCell key={p.name} name={p.name} count={p.count} />
        ))}
        {!loading && !error && tab === 'packages' && filteredPackages.length > pkgCount && <ListSentinel refFn={pkgSentinel} />}
      </div>
    </div>
  )
}
