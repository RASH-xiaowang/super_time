/**
 * 社交图谱面板 — Obsidian 风格重设计
 * 顶部工具条 + 头像节点图谱画布 + 右侧折叠控制面板(统计/选中详情/圈子聚焦/筛选/外观/布局)。
 *
 * 另含**知识图谱**（variant='knowledge'）：节点与连线**全部来自知识库** ——
 * 笔记节点 + `[[链接]]` 边 + 未解析目标的 stub 虚线节点，不含任何通讯录数据。
 * 与「笔记库」同属知识库入口，由 WechatDataPanel 的 MergedSections 分段切换。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGetAvatar, apiGetGraph, apiGetKnowledgeGraph } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { GraphSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import type { KnowledgeSnapshot } from '../types.ts'
import { buildGraph, buildKnowledgeNetwork, communityColor, connectedEdgesOf, DEFAULT_GRAPH_SETTINGS, defaultNodeLimit, eligibleCandidateCount, groupCommunities, localGraph, sharedGroupNames, type BuiltGraph, type GNode, type GraphSettings } from './graph-model.ts'
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor.tsx'
import { GraphRail } from './GraphRail.tsx'
import { GraphExportMenu } from './GraphExportMenu.tsx'
import { GraphNodeMenuController } from './GraphNodeMenuController.tsx'
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas.tsx'
import { ActionNoticeLine, useActionNotice } from './use-action-notice.tsx'
import { useGraphNodeMenu } from './use-graph-node-menu.ts'
import { useGraphNoteActions } from './use-graph-note-actions.ts'
import { useGraphNodeSearch } from './use-graph-node-search.ts'
import { useGraphDetailRequest } from './use-graph-detail-request.ts'
import { useGraphExportActions } from './use-graph-export-actions.ts'
import { readableOn } from '../utils/theme-color.ts'
import { PanelHeader, Select } from '../ui/kit.tsx'
import { toggleThemeMode, useThemeMode } from '../theme.ts'
import css from './graph.module.css'
import kitCss from '../ui/kit.module.css'
import { useWechatDataUpdated } from './hooks.tsx'
import { NOTES_UPDATED_EVENT } from '../notes-events.ts'
import { SOCIAL_SCOPE, kbCacheKey, kbScope, useKbScope } from './kb-scope.ts'
import { PHONE_QUERY, useMediaQuery } from '../ui/use-media-query.ts'

function Slider({ label, value, min, max, step, onChange, fmt, disabled }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt?: (v: number) => string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className={css.ctlRow} data-disabled={disabled || undefined}>
      <span className={css.ctlLabel}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => { onChange(Number(e.target.value)) }} className={css.ctlRange} disabled={disabled || undefined} />
      <span className={css.ctlValue}>{fmt ? fmt(value) : String(value)}</span>
    </label>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button type="button" className={css.ctlToggle} data-on={checked || undefined} onClick={() => { onChange(!checked) }}>
      <span className={css.ctlTrack}><i className={css.ctlKnob} /></span>
      <span>{label}</span>
    </button>
  )
}

/**
 * 知识图谱里的那五类节点：它们都是**库里的内容**，不是通讯录里的对象。
 * 两处判定共用这一份名单（选中去查头像、详情里的「查看聊天」）—— 之前两处各写一串
 * `!== 'note' && !== 'stub' && …`，加一类就漏一处，于是拿 `ent:person:张三` 去查头像。
 */
const KNOWLEDGE_KINDS = new Set<GNode['kind']>(['note', 'stub', 'file', 'section', 'entity'])

/**
 * 社交关系图谱加载画面 — 微信风格：一行旋转指示 + 两行说明。
 * （旧版是旋转光环 + 脉动核心 + 环绕节点的装饰动画，属本次改版删除项。）
 */
function GraphLoading(): React.JSX.Element {
  return (
    <div className={css.graphLoading} aria-busy="true">
      <span className={css.graphLoadingSpinner} aria-hidden="true" />
      <div className={css.graphLoadingLabel}>正在构建社交关系图谱…</div>
      <div className={css.graphLoadingSub}>正在加载节点 · 连线 · 圈子</div>
    </div>
  )
}

/**
 * Render the social graph panel.
 * @param props - optional cross-panel chat opener (查看聊天).
 * @returns the graph element tree.
 */
export function GraphPanel({ variant = 'social', onOpenChat }: {
  /** 'social' = 我的人脉（好友/群组）；'knowledge' = 我的笔记（节点只来自知识库）。 */
  variant?: 'social' | 'knowledge'
  onOpenChat?: (username: string) => void
}): React.JSX.Element {
  // 当前知识库：切换器挂在合并外壳的分段条上，不是本组件的父级 —— 走订阅而不是 props。
  const { kbId, kbs } = useKbScope()
  /** 提示语里的库名（多库之后「这张图是空的」必须说清是哪张）。 */
  const kbLabel = useMemo(() => {
    const name = kbs.find(k => k.id === kbId)?.name
    return name ? `「${name}」` : ''
  }, [kbs, kbId])
  /* 2026-10-03 推广：社交图谱与知识图谱**各用一个 useFreshData**，刻意分开 ——
     知识侧失败只静默保持旧值，不能把社交面板带进错误态（源码原有设计）。
     打开（或换库）即查最新，查询失败才回退缓存并由 hook 标注「以下为本地缓存（可能不是最新）」。 */
  const fetchGraph = useCallback(() => apiGetGraph(), [])
  const { data, loading: graphLoading, error: graphError, reload: reloadGraph } = useFreshData<GraphSnapshot>('graph', fetchGraph)
  /** 知识图谱快照（笔记 / stub / wiki 边）。与社交图谱分开加载：它是叠加维度，
   *  取不到时社交侧必须照常可用，所以单独 try/catch、不共用 error 状态。 */
  const fetchKnowledge = useCallback(() => apiGetKnowledgeGraph(kbId), [kbId])
  const { data: knowledge, reload: reloadKnowledge } = useFreshData<KnowledgeSnapshot>(kbCacheKey('kb-graph', kbId), fetchKnowledge)
  /** 笔记编辑器：open + 待编辑内容（id 为空表示新建）。 */
  const [noteEditor, setNoteEditor] = useState<{ open: boolean; id?: number; title?: string; body?: string }>({ open: false })
  const [settings, setSettings] = useState<GraphSettings>(() => ({
    ...DEFAULT_GRAPH_SETTINGS,
    // 知识图谱入口默认进「知识网络」；社交图谱入口默认进「好友网络」（DEFAULT 已是 people）。
    ...(variant === 'knowledge' ? { mode: 'knowledge' as const } : {}),
  }))
  /**
   * 主题直接跟随全局 theme.ts。
   *
   * 此前图谱有一套独立的 dark 状态（持久化在 'graph-theme' + 面板 data-dark），
   * 与全局主题互不相干 —— 于是"应用切到浅色、图谱画布仍是深色"，
   * 而面板 CSS 早已改用 --nm-* 令牌，两套轴必然打架。
   * 现在画布配色与面板 CSS 用同一个真相源。
   */
  const themeMode = useThemeMode()
  const dark = themeMode === 'dark'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null); const { notice: actionNotice, flash: flashActionNotice } = useActionNotice()
  /**
   * 参数面板是否展开。
   *
   * 初值按视口定：**手机上默认收起**（画布全宽，参数面板是浮层、展开会盖住大半张图），
   * 桌面默认展开（屏幕宽，浮层只占右侧 300px，不挡事）。
   * 用 `useState(() => …)` 惰性初始化而不是 `useEffect` 同步 —— 后者会在首帧先渲染成
   * 「展开」再跳成「收起」，手机上能看到一次闪动。
   */
  const isPhone = useMediaQuery(PHONE_QUERY)
  const [railOpen, setRailOpen] = useState(() => !isPhone)
  /**
   * 跨断点时同步一次（桌面 → 手机：收起；手机 → 桌面：展开）。
   *
   * 为什么需要：`useState` 的惰性初值只在**首次挂载**求值。用户在桌面打开图谱
   * （浮层展开）后把窗口缩到手机宽度，浮层会继续展开、盖住大半张画布 —— 而手机档
   * 的默认就是收起。这里只在 `isPhone` **翻转**时同步，用户手动收起/展开不受影响
   * （`prev` 只在翻转的那一次被覆盖）。
   */
  const prevPhoneRef = useRef(isPhone)
  useEffect(() => {
    if (prevPhoneRef.current === isPhone) return
    prevPhoneRef.current = isPhone
    setRailOpen(!isPhone)
  }, [isPhone])
  // 固定节点(画布锚点;布局/拖拽联动都不移动)
  const [pinned, setPinned] = useState<Set<string>>(() => new Set())
  // 圈子聚焦:选中一个圈子高亮,其余淡出(null=关闭)
  const [focusCommunity, setFocusCommunity] = useState<number | null>(null)
  const [hoverCommunity, setHoverCommunity] = useState<number | null>(null)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  const nodeMenu = useGraphNodeMenu()
  /** 详情页切换请求：节点已选中但右侧停在参数页时，仍然能通过右键“查看详情”切回去。 */
  const detailRequest = useGraphDetailRequest()
  // 选中详情头像
  const [selAvatar, setSelAvatar] = useState('')
  /** 数据已加载标记(稳定引用,避免 load 依赖 data 造成无限重拉循环)。 */
  const dataRef = useRef<GraphSnapshot | null>(data)
  /** 搜索词状态必须先于切库 effect 声明；命中列表仍依赖稍后构建的图。 */
  const [searchText, setSearchText] = useState('')
  const clearSearch = useCallback((): void => { setSearchText('') }, [])
  // 海报导出选择:风格 + 比例
  const [posterStyle, setPosterStyle] = useState<'light' | 'dark' | 'neon'>('dark')
  const [posterRatio, setPosterRatio] = useState<'1:1' | '3:4' | '16:9'>('1:1')
  const canvasRef = useRef<GraphCanvasHandle | null>(null)
  const patch = (p: Partial<GraphSettings>): void => { setSettings(prev => ({ ...prev, ...p })) }
  /** 切换全局主题（不再是图谱私有轴）。颜色过渡的触发条件 / 时长 / 缓动 / 范围见 theme.ts 文件头。 */
  const toggleTheme = (): void => { toggleThemeMode() }
  // nodeLimit 是「自动 30%」：比较默认状态时把两者都归一为哨兵 250，否则一进页面就显示「非默认」。
  const isDefaultSettings = JSON.stringify({ ...settings, nodeLimit: DEFAULT_GRAPH_SETTINGS.nodeLimit }) === JSON.stringify(DEFAULT_GRAPH_SETTINGS)
  const restoreDefaults = (): void => {
    setSettings({
      ...DEFAULT_GRAPH_SETTINGS,
      nodeLimit: defaultNodeLimit(eligibleCandidateCount(data, settings)),
      ...(variant === 'knowledge' ? { mode: 'knowledge' as const } : {}),
    })
    setPinned(new Set())
    setFocusCommunity(null)
    setHoverCommunity(null)
    setSelectedId(null)
  }
  /** `dataRef` 与 hook 的 data 同步（原用途：防「load 依赖 data」造成无限重拉）。 */
  useEffect(() => { dataRef.current = data }, [data])
  /** 面板自身 loading/error 对齐（本面板别处也在写它们）。 */
  useEffect(() => {
    if (!graphLoading) setLoading(false)
    if (graphError !== null) setError(graphError)
  }, [graphLoading, graphError])
  /** 载入后默认显示「候选总人数 × 30%」；必须等 data 落地（首屏 null 会先算成 1 耗掉哨兵）。 */
  useEffect(() => {
    if (!data) return
    setSettings(prev => prev.nodeLimit === DEFAULT_GRAPH_SETTINGS.nodeLimit
      ? { ...prev, nodeLimit: defaultNodeLimit(eligibleCandidateCount(data, prev)) }
      : prev)
  }, [data])
  /** 既有调用点（重查）原样可用。 */
  const load = reloadGraph

  /** 知识图谱单独加载：失败只静默保持旧值（或空），不把社交图谱面板带进错误态。
   *  `kbId` 是依赖：换库就是换图，必须重取；缓存键也带库 id，两者一起才不串库。 */
  /** 既有调用点原样可用（换库时 hook 的 key 变化会自动重取）。 */
  const loadKnowledge = reloadKnowledge

  // 两个加载器分成两个 effect：`load`（通讯录图谱）与库无关，并在一起的话每次切库
  // 都会白拉一次社交图谱（那是几百毫秒级的大快照）。
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadKnowledge() }, [loadKnowledge])

  // 切库：选中 / 固定 / 圈子聚焦 / 搜索装的都是**某一张图**上的位置与状态，换库就是换图。
  // 节点 id 里不带库前缀（设计如此），所以不清就会串：选中 id 在新库里恰好存在时，
  // 右侧详情显示的是别的库的笔记；固定集合则会把只属于旧图的节点钉在新图上。
  useEffect(() => {
    setSelectedId(null)
    setPinned(new Set())
    setFocusCommunity(null)
    setHoverCommunity(null)
    setHoverNodeId(null)
    nodeMenu.clear()
    clearSearch()
  }, [kbId, nodeMenu.clear, clearSearch])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => {
    if (!data) void load()
    if (!knowledge) void loadKnowledge()
  })

  const isKnowledgeMode = variant === 'knowledge'
  /**
   * 坐标落盘的作用域：社交图谱与**每个知识库**各占一份（`'social'` / `'kb:<id>'`）。
   *
   * 拼法来自 `kb-scope.ts`（那句「不得手写 'kb:' + id」的铁律），这里只做选择。
   * 为什么由面板算而不是画布自己推：画布拿到的是 `BuiltGraph`，节点 id 里没有库标识，
   * 而两个视图共用同一个 `GraphCanvas` —— 只有这里知道现在是哪一个。
   */
  const positionScope = isKnowledgeMode ? kbScope(kbId) : SOCIAL_SCOPE

  // 笔记增删改后重载知识快照：图谱的节点与边**就是**这份快照的投影 ——
  // `buildKnowledgeNetwork` 在下方 useMemo 里按 `knowledge` 重建，所以刷新快照即刷新节点。
  // 只在知识视图下重载：社交视图不消费这份数据。
  useWechatDataUpdated(() => {
    if (isKnowledgeMode) void loadKnowledge()
  }, NOTES_UPDATED_EVENT)

  // 性能:buildGraph 只随「结构参数」(模式/上限/阈值/仅好友)重建;
  // 外观参数(大小/粗细/标签等)由画布逐帧读取,拖动滑杆不再触发全量图重建
  const graph = useMemo<BuiltGraph>(
    () => (isKnowledgeMode ? buildKnowledgeNetwork(knowledge, settings) : buildGraph(data, settings)),
    [data, knowledge, isKnowledgeMode, settings.mode, settings.nodeLimit, settings.minCommon, settings.friendsOnly, settings.remarkClass, settings.firstChar],
  )
  // 深度过滤:有选中节点时以它为锚,否则自动锚定「我」——深度滑杆无需先选中即可生效。
  // 知识网络没有「我」节点,退到第一个节点作锚(否则 localGraph 会返回空图)。
  const depthAnchor = useMemo(
    () => selectedId ?? (graph.nodes.some(n => n.id === 'self') ? 'self' : graph.nodes[0]?.id ?? 'self'),
    [selectedId, graph],
  )
  const displayGraph = useMemo<BuiltGraph>(() => {
    if (settings.depth > 0) return localGraph(graph, depthAnchor, settings.depth)
    return graph
  }, [graph, depthAnchor, settings.depth])
  const selected = useMemo(() => graph.nodes.find(n => n.id === selectedId) ?? null, [graph, selectedId])
  // 洞察:最亲近(亲密度=消息量)、圈子概览(按成员数降序)、选中详情(共同群/相连关系)。
  // 知识模式下「重要性」换成连接度(出链+反链),否则会按消息量给笔记排序、毫无意义。
  const topFriends = useMemo(() => [...graph.nodes]
    .filter(n => n.kind !== 'self' && n.kind !== 'stub')
    .sort((a, b) => (isKnowledgeMode
      ? ((b.backLinks ?? 0) + (b.outLinks ?? 0)) - ((a.backLinks ?? 0) + (a.outLinks ?? 0)) || b.weight - a.weight
      : (b.intimacy ?? 0) - (a.intimacy ?? 0) || b.weight - a.weight))
    .slice(0, 5), [graph, isKnowledgeMode])
  const communities = useMemo(() => groupCommunities(graph), [graph])
  const selectedConnections = useMemo(() => (selectedId ? connectedEdgesOf(graph, selectedId) : []), [graph, selectedId])
  const selectedGroupNames = useMemo(() => (selected ? sharedGroupNames(selected, data?.group_names) : []), [selected, data])
  // 同班级名册:key 来自后端(全库盘点),成员里可能有人被「仅显示好友」或节点上限挡在图外,
  // 所以还要标出「本视图内可见」的那部分 —— 这正是「同前缀却没有连线」的答案所在
  const selectedClass = useMemo(() => {
    const key = selected?.remarkGroup
    if (!key) return null
    const roster = data?.remark_groups?.find(g => g.key === key)
    const members = roster?.members ?? []
    const visible = new Set(graph.nodes.map(n => n.id))
    return {
      key,
      total: roster?.total ?? members.length,
      visibleCount: members.filter(m => visible.has(m.username)).length,
      members: members.map(m => ({ ...m, visible: visible.has(m.username) })),
    }
  }, [selected, data, graph])

  // 选中详情头像(「我」用 self wxid 查)。知识节点没有头像，也不该拿
  // 'note:1' / 'kb:xxx' 这种伪用户名去查 getAvatar —— 文档实体层的
  // 'file:37' / 'doc:简介' / 'ent:person:张三' 同理，五个前缀都要在这里挡掉。
  useEffect(() => {
    if (selected && KNOWLEDGE_KINDS.has(selected.kind)) { setSelAvatar(''); return }
    const user = selectedId === 'self' ? (data?.self ?? '') : selectedId ?? ''
    if (!user || user === 'self') { setSelAvatar(''); return }
    let alive = true
    void apiGetAvatar({ username: user })
      .then((r) => { if (alive) setSelAvatar(r.data || r.url || '') })
      .catch(() => { if (alive) setSelAvatar('') })
    return () => { alive = false }
  }, [selectedId, data, selected])

  const togglePin = useCallback((id: string): void => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  /** 聚焦节点周围 1 跳(深度过滤 + 居中)。 */
  const focusNode = useCallback((id: string): void => {
    setSelectedId(id)
    patch({ depth: 1 })
    canvasRef.current?.centerOn(id)
  }, [])
  const openNodeDetails = useCallback((node: GNode): void => {
    setSelectedId(node.id)
    setRailOpen(true)
    detailRequest.show()
  }, [detailRequest])
  const setMode = (mode: GraphSettings['mode']): void => {
    setFocusCommunity(null)
    patch({ mode })
  }

  // 图谱快照只带 excerpt（列表用），编辑需要完整正文，因此打开编辑器时按 id 回查一次 getNotes。
  const { openEditor: openNoteEditor, remove: removeNote } = useGraphNoteActions({
    kbId,
    selectedId,
    onSelectedCleared: () => { setSelectedId(null) },
    onReload: loadKnowledge,
    onError: setError,
    flash: flashActionNotice,
    onEditor: setNoteEditor,
  })

  /** 侧栏只列「最相关」的几篇：按连接度降序，避免把几百篇笔记铺进窄栏。 */
  const topNotes = useMemo(() => (knowledge?.notes ?? [])
    .slice()
    .sort((a, b) => (b.backLinks + b.outLinks) - (a.backLinks + a.outLinks) || b.updatedAt - a.updatedAt)
    .slice(0, 6), [knowledge])

  const nodeSearch = useGraphNodeSearch(graph, searchText, setSearchText, clearSearch)

  const locateSearch = (id: string): void => {
    setSelectedId(id)
    canvasRef.current?.centerOn(id)
  }

  const { exporting, exportSvg: doExportSvg, exportPng: doExportPng, exportPoster: doExportPoster } = useGraphExportActions({
    canvasRef,
    posterStyle,
    posterRatio,
  })

  const focusCommunityRow = focusCommunity !== null ? communities.find(c => c.id === focusCommunity) ?? null : null

  return (
    <div className={css.panel}>
      <PanelHeader
        title={isKnowledgeMode
          ? '知识图谱 · 知识网络'
          : (settings.mode === 'groups' ? '社交图谱 · 群组网络' : '社交图谱 · 好友网络')}
        desc={selected ? selected.label + ' · ' + String(selected.intimacy ?? selected.weight) + ' 条消息' : `${graph.nodes.length} 节点 · ${graph.edges.length} 连线 · ${graph.communityCount} 圈子`}
        actions={(
          <>
            <div className={css.searchWrap}>
              {/* 搜索只覆盖「当前这张图」的节点（社交图谱与知识图谱彼此独立），
              且最多给出 8 个候选 —— 不说清会让用户以为「搜不到 = 数据里没有」。 */}
          <input
            type="text"
            value={nodeSearch.search}
            onChange={(e) => { nodeSearch.setSearch(e.target.value) }}
            placeholder="搜索节点…"
            title="仅搜索当前图谱的节点（好友 / 群组 / 知识各自独立），最多给出 8 个候选"
            aria-label="搜索节点（仅当前图谱，最多 8 个候选）"
            className={css.searchInput}
          />
              {nodeSearch.hits.length > 0 && (
                <div className={css.searchDrop}>
                  {nodeSearch.hits.map(hit => (
                    <button key={hit.id} type="button" className={css.searchHit} onClick={() => { locateSearch(hit.id); nodeSearch.clear() }}>{hit.label}<span className={css.searchHitId}>{hit.id}</span></button>
                  ))}
                </div>
              )}
              {nodeSearch.terms && nodeSearch.hits.length === 0 && (
                <div className={css.searchDrop}><span className={css.searchEmpty}>无匹配节点</span></div>
              )}
            </div>
            <button type="button" className={css.chip} onClick={() => { void load() }}>{loading ? '刷新中…' : '刷新'}</button>
            {/* 导出相关的 5 个控件收进一个「导出」下拉（2026-10-17 用户要求「压缩这里的空间」）。
                改前它们平铺在页头，加上搜索/刷新/主题/适应视图/选中节点共 9 个控件，
                在 1230px 宽下换行成两排。组件在 `GraphExportMenu.tsx`。 */}
            <GraphExportMenu
              isKnowledgeMode={isKnowledgeMode}
              posterStyle={posterStyle}
              posterRatio={posterRatio}
              exporting={exporting}
              onStyle={setPosterStyle}
              onRatio={setPosterRatio}
              onPoster={() => { void doExportPoster() }}
              onSvg={() => { void doExportSvg() }}
              onPng={() => { void doExportPng() }}
            />
            <button type="button" className={css.chip} onClick={toggleTheme}>{dark ? '浅色' : '深色'}</button>
            <button type="button" className={css.chip} onClick={() => { canvasRef.current?.fitView() }}>适应视图</button>
            <button type="button" className={css.chip} data-on={selectedId !== null} onClick={() => { setSelectedId(null) }}>{selectedId ? '清除选中' : '选中节点'}</button>
          </>
        )}
      /><ActionNoticeLine notice={actionNotice} />
      <div className={css.statBar}>
        <div className={css.statBox}><span className={css.statNum}>{graph.nodes.length}</span><span className={kitCss.textCaption}>节点</span></div>
        <div className={css.statBox}><span className={css.statNum}>{graph.edges.length}</span><span className={kitCss.textCaption}>连线</span></div>
        <div className={css.statBox}><span className={css.statNum}>{graph.communityCount}</span><span className={kitCss.textCaption}>圈子</span></div>
        {isKnowledgeMode ? (
          <>
            <div className={css.statBox}><span className={css.statNum}>{knowledge?.summary.noteCount ?? (graph.kindCounts.note ?? 0)}</span><span className={kitCss.textCaption}>笔记</span></div>
            <div className={css.statBox}><span className={css.statNum}>{knowledge?.summary.stubCount ?? (graph.kindCounts.stub ?? 0)}</span><span className={kitCss.textCaption}>待补笔记</span></div>
            {/* 文档实体层：读不到快照时退回数图上的节点，与上面两格同一口径 */}
            <div className={css.statBox}><span className={css.statNum}>{knowledge?.summary.fileCount ?? (graph.kindCounts.file ?? 0)}</span><span className={kitCss.textCaption}>文件</span></div>
            <div className={css.statBox}><span className={css.statNum}>{knowledge?.summary.sectionCount ?? (graph.kindCounts.section ?? 0)}</span><span className={kitCss.textCaption}>章节</span></div>
            <div className={css.statBox} title="模型从文件里抽出的实体（推断层，不是文档里写着的）"><span className={css.statNum}>{knowledge?.summary.entityCount ?? (graph.kindCounts.entity ?? 0)}</span><span className={kitCss.textCaption}>模型实体</span></div>
          </>
        ) : (
          <>
            <div className={css.statBox}><span className={css.statNum}>{(graph.kindCounts.person ?? 0)}</span><span className={kitCss.textCaption}>联系人</span></div>
            <div className={css.statBox}><span className={css.statNum}>{(graph.kindCounts.group ?? 0)}</span><span className={kitCss.textCaption}>群聊</span></div>
          </>
        )}
      </div>

      <div className={css.body}>
        <div className={css.stage}>
          {loading && !data && !knowledge && <GraphLoading />}
          {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
          {!loading && !error && (data || knowledge) && graph.nodes.length === 0 && (
            <div className={kitCss.emptyInline}>
              {isKnowledgeMode
                ? `知识库${kbLabel}里还没有可显示的节点。点右侧「＋ 新建笔记」写下第一篇，或在「微信问答」的回答下点「沉淀为笔记」。`
                : '当前条件下没有可显示的节点。试试提高节点上限，或关闭「仅好友」。'}
            </div>
          )}
          {(data || knowledge) && graph.nodes.length > 0 && (
            <>
              <GraphCanvas
                ref={canvasRef}
                graph={displayGraph}
                positionScope={positionScope}
                dark={dark}
                selectedId={selectedId}
                onSelect={setSelectedId}
                settings={settings}
                selfUsername={data?.self ?? undefined}
                pinnedIds={pinned}
                focusCommunity={focusCommunity}
                hoverCommunity={hoverCommunity}
                hoverNodeId={hoverNodeId}
                onHoverNode={setHoverNodeId}
                onOpenChat={onOpenChat}
                onFocusNode={focusNode}
                onNodeContextMenu={(id, position) => {
                  const node = graph.nodes.find(n => n.id === id)
                  if (node) nodeMenu.open(node, position)
                }}
                hideMinimap={railOpen}
              />
              <GraphNodeMenuController
                target={nodeMenu.target}
                knowledge={isKnowledgeMode}
                pinned={pinned}
                onOpenChat={onOpenChat}
                onClose={nodeMenu.close}
                onDetails={openNodeDetails}
                onFocus={focusNode}
                onTogglePin={togglePin}
                onEditNote={(id) => { void openNoteEditor(id) }}
                onCreateNote={() => { setNoteEditor({ open: true }) }}
                onDeleteNote={(node) => { void removeNote(Number(node.id.slice(5)), node.label) }}
              />
              <div className={css.legend}>
                {isKnowledgeMode ? (
                  <>
                    <span><i className={css.legendDotNote} />紫圆 = 笔记</span>
                    <span><i className={css.legendLine} />灰线 = [[链接]]</span>
                    <span><i className={css.legendLine} />虚线圆 = 尚未创建的笔记</span>
                    {/* 文档实体层：这三类节点是后加的，图例必须补上 —— 光看图分不出
                        「灰蓝的小点是待补笔记还是章节」。最后一格尤其要紧：虚线在这一层
                        表示「模型说的」，用户据此决定能不能把它当引用依据。 */}
                    <span><i className={css.legendDotFile} />绿圆 = 文件</span>
                    <span><i className={css.legendDotSection} />灰圆 = 章节</span>
                    <span><i className={css.legendDotEntity} />琥珀圆 = 模型抽出的实体</span>
                    <span><i className={css.legendLineAmberDash} />虚线 = 推断的关系（文档里没写着）</span>
                    <span><i className={css.legendBar} />半径 = 连接度</span>
                  </>
                ) : (
                  <>
                    <span><i className={css.legendDot} />颜色 = 圈子(社区)</span>
                    <span><i className={css.legendLine} />灰线 = 共同群数</span>
                    <span><i className={css.legendLineGold} />金虚线 = 同备注编号</span>
                    <span><i className={css.legendLineBlueDash} />蓝虚线 = 首字相同</span>
                    <span><i className={css.legendLineBlue} />蓝实线 = 与我亲密度</span>
                    <span><i className={css.legendBar} />半径 = 消息量</span>
                  </>
                )}
              </div>
            </>
          )}

          {/* 折叠/展开按钮：收起时它是唯一的入口，所以**始终渲染**（展开时由 CSS 让位给浮层标题栏）。
              必须放在 `.stage` **里面** —— 它是 `position: absolute`，而 `.stage` 是最近的定位祖先
              （`.body` / `.panel` 都没有 `position: relative`）。放在 `.stage` 外面会一路往上找到
              视口，按钮就飘到屏幕顶部、压住手机档的全局搜索条（2026-10-16 实测踩到）。 */}
          <button
            type="button"
            className={css.railToggle}
            data-open={railOpen || undefined}
            onClick={() => { setRailOpen(v => !v) }}
            aria-label={railOpen ? '收起参数面板' : '展开参数面板'}
            aria-expanded={railOpen}
          >⚙ 参数</button>

          {railOpen && (
            <GraphRail
              graph={graph}
              isKnowledgeMode={isKnowledgeMode}
              selected={selected}
              detailRequest={detailRequest.request}
              selAvatar={selAvatar}
              selectedGroupNames={selectedGroupNames}
              selectedClass={selectedClass}
              selectedConnections={selectedConnections}
              communities={communities}
              focusCommunity={focusCommunity}
              topFriends={topFriends}
              topNotes={topNotes}
              knowledge={knowledge}
              settings={settings}
              isDefaultSettings={isDefaultSettings}
              pinned={pinned}
              patch={patch}
              setMode={setMode}
              selectNode={(id) => { setSelectedId(id); canvasRef.current?.centerOn(id) }}
              clearSelection={() => { setSelectedId(null) }}
              focusNode={focusNode}
              togglePin={togglePin}
              setFocusCommunity={setFocusCommunity}
              setHoverCommunity={setHoverCommunity}
              openNoteEditor={(id) => { if (id !== undefined) void openNoteEditor(id) }}
              removeNote={(id, title) => { void removeNote(id, title) }}
              newNote={() => { setNoteEditor({ open: true }) }}
              relayout={() => { canvasRef.current?.relayout() }}
              clearPinned={() => { setPinned(new Set()) }}
              restoreDefaults={restoreDefaults}
              runAnimation={() => { canvasRef.current?.runAnimation() }}
              onOpenChat={onOpenChat}
              onClose={() => { setRailOpen(false) }}
            />
          )}
        </div>
      </div>

      {/* 笔记编辑器（新建 / 编辑）。保存/删除后统一重载知识图谱，让画布立刻反映变化。 */}
      <KnowledgeNoteEditor
        kbId={kbId}
        open={noteEditor.open}
        {...(noteEditor.id !== undefined ? { noteId: noteEditor.id } : {})}
        initialTitle={noteEditor.title ?? ''}
        initialBody={noteEditor.body ?? ''}
        onClose={() => { setNoteEditor({ open: false }) }}
        onSaved={() => { void loadKnowledge(); setNoteEditor({ open: false }) }}
      />
    </div>
  )
}
