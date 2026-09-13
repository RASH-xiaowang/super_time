/**
 * 社交图谱面板 — Obsidian 风格重设计
 * 顶部工具条 + 头像节点图谱画布 + 右侧折叠控制面板(统计/选中详情/圈子聚焦/筛选/外观/布局)。
 *
 * 另含**知识网络 / 融合视图**：笔记节点 + `[[链接]]` 边 + 未解析目标的 stub 虚线节点；
 * 融合视图再把笔记的来源会话（AI 问答沉淀）叠进同一张图，把「知识」和「人」接起来。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { apiDeleteNote, apiGetAvatar, apiGetGraph, apiGetKnowledgeGraph, apiGetNotes, readRenderCache, writeRenderCache } from '../api.ts'
import type { GraphSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import type { KnowledgeSnapshot } from '../types.ts'
import { buildGraph, buildKnowledgeNetwork, communityColor, connectedEdgesOf, DEFAULT_GRAPH_SETTINGS, groupCommunities, localGraph, sharedGroupNames, type BuiltGraph, type GraphSettings } from './graph-model.ts'
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor.tsx'
import { EchartsGraphCanvas, type EchartsGraphCanvasHandle } from './EchartsGraphCanvas.tsx'
import { readableOn } from '../utils/theme-color.ts'
import { PanelHeader, Select } from '../ui/kit.tsx'
import { getThemeMode, subscribeThemeMode, toggleThemeMode } from '../theme.ts'
import css from './graph.module.css'
import kitCss from '../ui/kit.module.css'
import { useWechatDataUpdated } from './hooks.tsx'

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
 * 社交关系图谱加载画面 — 太空舱风格:旋转光环 + 脉动核心 + 环绕节点,
 * 暗示节点/连线/圈子正在成形。
 */
function GraphLoading(): React.JSX.Element {
  const nodes = Array.from({ length: 8 })
  return (
    <div className={css.graphLoading} aria-busy="true">
      <div className={css.graphLoadingOrbit}>
        <div className={css.graphLoadingRing} />
        <div className={css.graphLoadingCore} />
        <div className={css.graphLoadingNodes}>
          {nodes.map((_, i) => (
            <span key={i} className={css.graphLoadingNode} style={{ '--a': `${i * 45}deg`, '--i': i } as React.CSSProperties} />
          ))}
        </div>
      </div>
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
  /** 'social' = 我的人脉（好友/群组）；'knowledge' = 我的笔记（知识网络/融合视图）。 */
  variant?: 'social' | 'knowledge'
  onOpenChat?: (username: string) => void
}): React.JSX.Element {
  const [data, setData] = useState<GraphSnapshot | null>(() => readRenderCache<GraphSnapshot>('graph'))
  /** 知识图谱快照（笔记 / stub / wiki 边）。与社交图谱分开加载：它是叠加维度，
   *  取不到时社交侧必须照常可用，所以单独 try/catch、不共用 error 状态。 */
  const [knowledge, setKnowledge] = useState<KnowledgeSnapshot | null>(() => readRenderCache<KnowledgeSnapshot>('kb-graph'))
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
  const themeMode = useSyncExternalStore(subscribeThemeMode, getThemeMode)
  const dark = themeMode === 'dark'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(true)
  const [search, setSearch] = useState('')
  // 固定节点(画布锚点;布局/拖拽联动都不移动)
  const [pinned, setPinned] = useState<Set<string>>(() => new Set())
  // 圈子聚焦:选中一个圈子高亮,其余淡出(null=关闭)
  const [focusCommunity, setFocusCommunity] = useState<number | null>(null)
  const [hoverCommunity, setHoverCommunity] = useState<number | null>(null)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  // 选中详情头像
  const [selAvatar, setSelAvatar] = useState('')
  /** 数据已加载标记(稳定引用,避免 load 依赖 data 造成无限重拉循环)。 */
  const dataRef = useRef<GraphSnapshot | null>(data)
  // 海报导出选择:风格 + 比例
  const [posterStyle, setPosterStyle] = useState<'light' | 'dark' | 'neon'>('dark')
  const [posterRatio, setPosterRatio] = useState<'1:1' | '3:4' | '16:9'>('1:1')
  const [exporting, setExporting] = useState(false)
  const canvasRef = useRef<EchartsGraphCanvasHandle | null>(null)

  const patch = (p: Partial<GraphSettings>): void => { setSettings(prev => ({ ...prev, ...p })) }
  /** 切换全局主题（不再是图谱私有轴）。 */
  const toggleTheme = (): void => { toggleThemeMode() }
  /** 恢复默认参数(含清除固定/聚焦/选中)。 */
  const isDefaultSettings = JSON.stringify(settings) === JSON.stringify(DEFAULT_GRAPH_SETTINGS)
  const restoreDefaults = (): void => {
    setSettings({
      ...DEFAULT_GRAPH_SETTINGS,
      ...(variant === 'knowledge' ? { mode: 'knowledge' as const } : {}),
    })
    setPinned(new Set())
    setFocusCommunity(null)
    setHoverCommunity(null)
    setSelectedId(null)
  }

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    if (dataRef.current === null) setLoading(true)
    try {
      const env = await apiGetGraph()
      dataRef.current = env
      setData(env)
      writeRenderCache('graph', env)
      // 性能:若用户未自定义「节点上限」,按候选节点数动态封顶(≤250),大图也流畅;
      // 一旦用户改过(非默认档),后续刷新不再覆盖。
      setSettings(prev => prev.nodeLimit === DEFAULT_GRAPH_SETTINGS.nodeLimit
        ? { ...prev, nodeLimit: Math.min(DEFAULT_GRAPH_SETTINGS.nodeLimit, Math.max(1, env.nodes.filter(n => n.kind !== 'group' && n.kind !== 'self').length)) }
        : prev)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  /** 知识图谱单独加载：失败只静默保持旧值（或空），不把社交图谱面板带进错误态。 */
  const loadKnowledge = useCallback(async (): Promise<void> => {
    try {
      const kb = await apiGetKnowledgeGraph()
      setKnowledge(kb)
      writeRenderCache('kb-graph', kb)
    } catch { /* 知识维度不可用不应影响社交图谱 */ }
  }, [])

  useEffect(() => { void load(); void loadKnowledge() }, [load, loadKnowledge])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => {
    if (!data) void load()
    if (!knowledge) void loadKnowledge()
  })

  const isKnowledgeMode = variant === 'knowledge'

  // 性能:buildGraph 只随「结构参数」(模式/上限/阈值/仅好友)重建;
  // 外观参数(大小/粗细/标签等)由画布逐帧读取,拖动滑杆不再触发全量图重建
  const graph = useMemo<BuiltGraph>(
    () => (isKnowledgeMode ? buildKnowledgeNetwork(knowledge, data, settings) : buildGraph(data, settings)),
    [data, knowledge, isKnowledgeMode, settings.mode, settings.nodeLimit, settings.minCommon, settings.friendsOnly],
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

  // 选中详情头像(「我」用 self wxid 查)。知识节点没有头像，也不该拿
  // 'note:1' / 'kb:xxx' 这种伪用户名去查 getAvatar。
  useEffect(() => {
    if (selected && (selected.kind === 'note' || selected.kind === 'stub')) { setSelAvatar(''); return }
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
  const setMode = (mode: GraphSettings['mode']): void => {
    setFocusCommunity(null)
    patch({ mode })
  }

  // ── 知识笔记的增删改 ──────────────────────────────────────────────
  // 图谱快照只带 excerpt（列表用），编辑需要完整正文，因此打开编辑器时按 id 回查一次 getNotes。
  const openNoteEditor = useCallback(async (id: number): Promise<void> => {
    try {
      const list = await apiGetNotes()
      const n = list.items.find(x => x.id === id)
      setNoteEditor(n ? { open: true, id: n.id, title: n.title, body: n.body } : { open: true, id })
    } catch {
      setNoteEditor({ open: true, id })
    }
  }, [])

  const removeNote = useCallback(async (id: number): Promise<void> => {
    try {
      const r = await apiDeleteNote(id)
      if (!r.ok) { setError(r.error ?? '删除笔记失败'); return }
      if (selectedId === 'note:' + id) setSelectedId(null)
      await loadKnowledge()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [selectedId, loadKnowledge])

  /** 侧栏只列「最相关」的几篇：按连接度降序，避免把几百篇笔记铺进窄栏。 */
  const topNotes = useMemo(() => (knowledge?.notes ?? [])
    .slice()
    .sort((a, b) => (b.backLinks + b.outLinks) - (a.backLinks + a.outLinks) || b.updatedAt - a.updatedAt)
    .slice(0, 6), [knowledge])

  // 搜索候选(名称/username 包含)
  const searchTerms = search.trim().toLowerCase()
  const searchHits = useMemo(() => {
    if (!searchTerms) return []
    return graph.nodes.filter(n => n.label.toLowerCase().includes(searchTerms) || n.id.toLowerCase().includes(searchTerms)).slice(0, 8)
  }, [graph, searchTerms])

  const locateSearch = (id: string): void => {
    setSelectedId(id)
    canvasRef.current?.centerOn(id)
  }

  const doExportSvg = async (): Promise<void> => {
    try {
      const svg = await canvasRef.current?.exportSvg() ?? ''
      if (!svg) { console.warn('SVG 导出失败:画布未就绪'); return }
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = '社交关系图谱.svg'
      a.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
    } catch (e) {
      console.error('SVG 导出失败', e)
    }
  }
  const doExportPng = async (): Promise<void> => {
    try {
      const url = await canvasRef.current?.exportPng(posterRatio, posterStyle)
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = `社交图谱-${posterStyle}-${posterRatio}.png`
      a.click()
    } catch (e) {
      console.error('PNG 导出失败', e)
    }
  }
  /** 导出朋友圈海报:头像图谱 + 排版(风格/比例即时生效)。 */
  const doExportPoster = async (): Promise<void> => {
    setExporting(true)
    try {
      const url = await canvasRef.current?.renderPoster(posterRatio, posterStyle)
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = `社交图谱-${posterStyle}-${posterRatio}.jpg`
      a.click()
    } catch (e) {
      console.error('海报导出失败', e)
    } finally {
      setExporting(false)
    }
  }

  const focusCommunityRow = focusCommunity !== null ? communities.find(c => c.id === focusCommunity) ?? null : null

  return (
    <div className={css.panel}>
      <PanelHeader
        title={isKnowledgeMode
          ? (settings.mode === 'fused' ? '知识图谱 · 融合视图' : '知识图谱 · 知识网络')
          : (settings.mode === 'groups' ? '社交图谱 · 群组网络' : '社交图谱 · 好友网络')}
        desc={selected ? selected.label + ' · ' + String(selected.intimacy ?? selected.weight) + ' 条消息' : `${graph.nodes.length} 节点 · ${graph.edges.length} 连线 · ${graph.communityCount} 圈子`}
        actions={(
          <>
            <div className={css.searchWrap}>
              <input type="text" value={search} onChange={(e) => { setSearch(e.target.value) }} placeholder="搜索节点…" className={css.searchInput} />
              {searchHits.length > 0 && (
                <div className={css.searchDrop}>
                  {searchHits.map(hit => (
                    <button key={hit.id} type="button" className={css.searchHit} onClick={() => { locateSearch(hit.id); setSearch('') }}>{hit.label}<span className={css.searchHitId}>{hit.id}</span></button>
                  ))}
                </div>
              )}
              {searchTerms && searchHits.length === 0 && (
                <div className={css.searchDrop}><span className={css.searchEmpty}>无匹配节点</span></div>
              )}
            </div>
            <button type="button" className={css.chip} onClick={() => { void load() }}>{loading ? '刷新中…' : '⟳ 刷新'}</button>
            {/* 海报（朋友圈分享图）自带「最亲近的人 / 圈子概览」等社交侧版式，
                知识网络下这些版块没有意义，因此隐藏海报入口；SVG/PNG 仍忠实导出当前图。 */}
            {!isKnowledgeMode && (
              <>
                <Select
                  value={posterStyle}
                  onChange={(v) => { setPosterStyle(v as 'light' | 'dark' | 'neon') }}
                  options={[
                    { value: 'dark', label: '深空' },
                    { value: 'light', label: '浅日' },
                    { value: 'neon', label: '霓虹' },
                  ]}
                  ariaLabel="导出风格"
                />
                <Select
                  value={posterRatio}
                  onChange={(v) => { setPosterRatio(v as '1:1' | '3:4' | '16:9') }}
                  options={[
                    { value: '1:1', label: '1:1 方图' },
                    { value: '3:4', label: '3:4 竖版' },
                    { value: '16:9', label: '16:9 横版' },
                  ]}
                  ariaLabel="导出比例"
                />
                <button type="button" className={css.chip} onClick={() => { void doExportPoster() }} disabled={exporting}>{exporting ? '⏳ 导出中…' : '📤 发朋友圈'}</button>
              </>
            )}
            <button type="button" className={css.chip} onClick={() => { void doExportSvg() }}>SVG</button>
            <button type="button" className={css.chip} onClick={() => { void doExportPng() }}>PNG</button>
            <button type="button" className={css.chip} onClick={toggleTheme}>{dark ? '☀️ 浅色' : '🌙 深色'}</button>
            <button type="button" className={css.chip} onClick={() => { canvasRef.current?.fitView() }}>适应视图</button>
            <button type="button" className={css.chip} data-on={selectedId !== null} onClick={() => { setSelectedId(null) }}>{selectedId ? '清除选中' : '选中节点'}</button>
            <button type="button" className={css.chip} onClick={() => { setRailOpen(v => !v) }}>{railOpen ? '◀ 面板' : '▶ 面板'}</button>
          </>
        )}
      />

      <div className={css.statBar}>
        <div className={css.statBox}><span className={css.statNum}>{graph.nodes.length}</span><span className={kitCss.textCaption}>节点</span></div>
        <div className={css.statBox}><span className={css.statNum}>{graph.edges.length}</span><span className={kitCss.textCaption}>连线</span></div>
        <div className={css.statBox}><span className={css.statNum}>{graph.communityCount}</span><span className={kitCss.textCaption}>圈子</span></div>
        {isKnowledgeMode ? (
          <>
            <div className={css.statBox}><span className={css.statNum}>{knowledge?.summary.noteCount ?? graph.nodes.filter(n => n.kind === 'note').length}</span><span className={kitCss.textCaption}>笔记</span></div>
            <div className={css.statBox}><span className={css.statNum}>{knowledge?.summary.stubCount ?? graph.nodes.filter(n => n.kind === 'stub').length}</span><span className={kitCss.textCaption}>待补笔记</span></div>
          </>
        ) : (
          <>
            <div className={css.statBox}><span className={css.statNum}>{graph.nodes.filter(n => n.kind === 'person').length}</span><span className={kitCss.textCaption}>联系人</span></div>
            <div className={css.statBox}><span className={css.statNum}>{graph.nodes.filter(n => n.kind === 'group').length}</span><span className={kitCss.textCaption}>群聊</span></div>
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
                ? '还没有可显示的知识节点。点右侧「＋ 新建笔记」写下第一篇，或在「微信问答」的回答下点「沉淀为笔记」。'
                : '当前条件下没有可显示的节点。试试提高节点上限，或关闭「仅好友」。'}
            </div>
          )}
          {(data || knowledge) && graph.nodes.length > 0 && (
            <>
              <EchartsGraphCanvas
                ref={canvasRef}
                graph={displayGraph}
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
              />
              <div className={css.legend}>
                {isKnowledgeMode ? (
                  <>
                    <span><i className={css.legendDot} />紫方块 = 笔记</span>
                    <span><i className={css.legendLineBlue} />紫线 = [[链接]]</span>
                    <span><i className={css.legendLine} />虚线圆 = 尚未创建的笔记</span>
                    <span><i className={css.legendBar} />半径 = 连接度</span>
                  </>
                ) : (
                  <>
                    <span><i className={css.legendDot} />颜色 = 圈子(社区)</span>
                    <span><i className={css.legendLine} />灰线 = 共同群数</span>
                    <span><i className={css.legendLineBlue} />蓝线 = 与我亲密度</span>
                    <span><i className={css.legendBar} />半径 = 消息量</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {railOpen && (
          <aside className={css.rail}>
            {/* 统计条 */}
            <div className={css.statRow}>
              <span className={css.statChip} title="当前展示节点数">{graph.nodes.length} 节点</span>
              <span className={css.statChip} title="当前连线数">{graph.edges.length} 连线</span>
              <span className={css.statChip} title="社区检测出的圈子数">{graph.communityCount} 圈子</span>
            </div>

            {/* 选中节点详情 */}
            {selected && (
              <div className={css.detail} data-focus={focusCommunity !== null || undefined}>
                <div className={css.detailHd}>
                  {selAvatar ? (
                    <img src={selAvatar} alt="" className={css.detailAvatar} />
                  ) : (
                    <span
                      className={css.detailAvatar}
                      style={{
                        background: selected.kind === 'self' ? 'var(--nm-cyan)' : selected.community >= 0 ? communityColor(selected.community) : 'rgba(128,138,156,0.35)',
                        // 同上：社区色是任意值，白字未必可读（浅色社区色上白字会糊掉）
                        color: selected.kind === 'self' ? 'var(--nm-on-accent)' : selected.community >= 0 ? readableOn(communityColor(selected.community)) : 'var(--nm-text-1)',
                      }}
                    >{selected.label.slice(0, 1).toUpperCase()}</span>
                  )}
                  <div className={css.detailTitles}>
                    <span className={css.detailName}>{selected.label}</span>
                    <span className={kitCss.textMeta}>
                      {selected.kind === 'note'
                        ? `笔记 · 出链 ${selected.outLinks ?? 0} / 被引用 ${selected.backLinks ?? 0}`
                        : selected.kind === 'stub'
                          ? `尚未创建的笔记 · 被引用 ${selected.backLinks ?? 0} 次`
                          : `${selected.kind === 'group' ? '群聊' : selected.kind === 'self' ? '我' : selected.isOfficial ? '公众号' : (selected.isFriend ? '好友' : '群友')} · 消息量 ${selected.intimacy ?? selected.weight}`}
                      {selected.sharedCount !== undefined ? ` · 共同 ${selected.sharedCount}` : ''}
                    </span>
                  </div>
                  <button type="button" className={css.detailClose} onClick={() => { setSelectedId(null) }} aria-label="关闭详情">×</button>
                </div>
                {selected.community >= 0 && (
                  <div className={`${kitCss.textMeta} ${css.legendRow}`}>
                    <i style={{ width: 10, height: 10, borderRadius: 10, background: communityColor(selected.community), display: 'inline-block' }} />
                    圈子 #{selected.community + 1} · {communities.find(c => c.id === selected.community)?.members.length ?? 0} 位
                  </div>
                )}
                <div className={css.detailBtns}>
                  <button type="button" className={css.miniBtn} onClick={() => { focusNode(selected.id) }}>🔍 聚焦 1 跳</button>
                  {selected.id !== 'self' && (
                    <button type="button" className={css.miniBtn} data-on={pinned.has(selected.id) || undefined} onClick={() => { togglePin(selected.id) }}>{pinned.has(selected.id) ? '📌 已固定' : '📌 固定'}</button>
                  )}
                  {selected.kind === 'note' && (
                    <button type="button" className={css.miniBtn} onClick={() => { void openNoteEditor(Number(selected.id.slice(5))) }}>✏️ 编辑笔记</button>
                  )}
                  {/* stub 的闭环：点它就地把「还缺的那篇笔记」写出来，而不是留一个悬空引用 */}
                  {selected.kind === 'stub' && (
                    <button type="button" className={css.miniBtn} onClick={() => { setNoteEditor({ open: true, title: selected.label }) }}>＋ 创建这篇笔记</button>
                  )}
                  {onOpenChat && selected.kind !== 'note' && selected.kind !== 'stub' && (
                    <button type="button" className={css.miniBtn} onClick={() => { onOpenChat(selected.id) }}>💬 查看聊天</button>
                  )}
                </div>
                {selectedGroupNames.length > 0 && (
                  <>
                    <div className={css.detailSub}>共同群</div>
                    <div className={css.detailChips}>
                      {selectedGroupNames.map((g, gi) => (
                        <span key={gi} className={css.detailChip} title={g}>{g.length > 12 ? g.slice(0, 12) + '…' : g}</span>
                      ))}
                    </div>
                  </>
                )}
                <div className={css.detailSub}>相连关系 ({selectedConnections.length})</div>
                <div className={css.detailChips}>
                  {selectedConnections.map(ce => (
                    <button key={ce.edge.source + ce.edge.target} type="button" className={css.detailChip} onClick={() => { setSelectedId(ce.other?.id ?? null) }} title={ce.other?.label ?? ''}>
                      {ce.other?.label ?? '?'}<span className={css.rankW}>{ce.edge.weight}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 最亲近 Top5 */}
            <div className={css.railSection}>
              <div className={css.railTitle}>{isKnowledgeMode ? '最关联 · 连接度' : '最亲近 · 消息量'}</div>
              {topFriends.map((n, i) => (
                <button key={n.id} type="button" className={css.rank} title={n.label} onClick={() => { setSelectedId(n.id); canvasRef.current?.centerOn(n.id) }}>
                  <span className={css.rankNum}>{i + 1}</span>
                  <span className={css.rankName}>{n.label}</span>
                  <span className={css.rankW}>{n.intimacy ?? n.weight}</span>
                </button>
              ))}
            </div>

            {/* 圈子概览(洞察):点击聚焦圈内高亮,悬停即时预览 */}
            {communities.length > 0 && (
              <div className={css.railSection}>
                <div className={css.railTitle}>
                  圈子概览 · {communities.length} 个
                  {focusCommunityRow && <button type="button" className={css.clearChip} onClick={() => { setFocusCommunity(null) }}>清除聚焦</button>}
                </div>
                {communities.slice(0, 8).map(c => (
                  <button
                    key={c.id}
                    type="button"
                    className={css.rank}
                    data-on={focusCommunity === c.id || undefined}
                    title={`${[...c.members].map(m => m.label).join('、')}（共 ${c.members.length} ${isKnowledgeMode ? '篇' : '人'}）`}
                    onClick={() => { setFocusCommunity(prev => prev === c.id ? null : c.id) }}
                    onMouseEnter={() => { setHoverCommunity(c.id) }}
                    onMouseLeave={() => { setHoverCommunity(null) }}
                  >
                    <span className={css.rankNum} style={{ background: communityColor(c.id), color: readableOn(communityColor(c.id)) }}>{c.members.length}</span>
                    <span className={css.rankName}>{[...c.members].slice(0, 2).map(m => m.label).join('、')}{c.members.length > 2 ? ` 等 ${c.members.length} ${isKnowledgeMode ? '篇' : '人'}` : ''}</span>
                    {focusCommunity === c.id ? <span className={css.rankW}>聚焦中</span> : null}
                  </button>
                ))}
              </div>
            )}

            {/* 数据筛选 */}
            <div className={css.railSection}>
              <div className={css.railTitle}>数据</div>
              {isKnowledgeMode ? (
                <div className={css.seg}>
                  <button type="button" className={css.segBtn} data-on={settings.mode === 'knowledge' || undefined} onClick={() => { setMode('knowledge') }}>知识网络</button>
                  <button type="button" className={css.segBtn} data-on={settings.mode === 'fused' || undefined} onClick={() => { setMode('fused') }}>融合视图</button>
                </div>
              ) : (
                <div className={css.seg}>
                  <button type="button" className={css.segBtn} data-on={settings.mode === 'people' || undefined} onClick={() => { setMode('people') }}>好友网络</button>
                  <button type="button" className={css.segBtn} data-on={settings.mode === 'groups' || undefined} onClick={() => { setMode('groups') }}>群组网络</button>
                </div>
              )}
              <Slider label="节点上限" value={settings.nodeLimit} min={20} max={10000} step={20} onChange={(v) => { patch({ nodeLimit: v }) }} fmt={v => v >= 10000 ? '全部' : String(v)} />
              {(settings.mode === 'people' || settings.mode === 'groups') && (
                <Slider label={settings.mode === 'people' ? '共同群阈值 ≥' : '共同成员阈值 ≥'} value={settings.minCommon} min={1} max={10} step={1} onChange={(v) => { patch({ minCommon: v }) }} />
              )}
              {settings.mode === 'people' && (
                <Toggle label="仅显示好友" checked={settings.friendsOnly} onChange={(v) => { patch({ friendsOnly: v }) }} />
              )}
            </div>

            {/* 知识笔记（仅知识网络/融合视图显示） */}
            {isKnowledgeMode && (
              <div className={css.railSection}>
                <div className={css.railTitle}>知识笔记</div>
                <div className={css.rowBtns}>
                  <button type="button" className={css.miniBtn} onClick={() => { setNoteEditor({ open: true }) }}>＋ 新建笔记</button>
                </div>
                <div className={kitCss.textMeta}>
                  {knowledge
                    ? `共 ${knowledge.summary.noteCount} 篇（问答沉淀 ${knowledge.summary.askCount}）· ${knowledge.summary.stubCount} 个待补 · ${knowledge.summary.orphanCount} 篇无关联`
                    : '知识图谱暂不可用（社交图谱不受影响）'}
                </div>
                {topNotes.map(n => (
                  <div key={n.id} className={css.noteRow}>
                    <button
                      type="button"
                      className={css.noteTitle}
                      title={n.excerpt || n.title}
                      onClick={() => { setSelectedId('note:' + n.id); canvasRef.current?.centerOn('note:' + n.id) }}
                    >
                      {n.title}
                      {n.sourceKind === 'ask' ? ' ·来自问答' : ''}
                      <span className={css.noteMetric}>{n.backLinks} ← / → {n.outLinks}</span>
                    </button>
                    <button type="button" className={css.noteEdit} onClick={() => { void openNoteEditor(n.id) }} aria-label={`编辑 ${n.title}`}>✏️</button>
                    <button type="button" className={css.noteDel} onClick={() => { void removeNote(n.id) }} aria-label={`删除 ${n.title}`}>×</button>
                  </div>
                ))}
              </div>
            )}

            {/* 外观 */}
            <div className={css.railSection}>
              <div className={css.railTitle}>外观</div>
              <Toggle label="箭头" checked={settings.showArrows} onChange={(v) => { patch({ showArrows: v }) }} />
              <Toggle label="全部标签" checked={settings.showLabels} onChange={(v) => { patch({ showLabels: v }) }} />
              <Toggle label="背景网格" checked={settings.showGrid} onChange={(v) => { patch({ showGrid: v }) }} />
              <Slider label="节点模糊" value={settings.blurNodes} min={0} max={12} step={1} onChange={(v) => { patch({ blurNodes: v }) }} fmt={v => v === 0 ? '关闭' : String(v) + 'px'} />
              <Slider label="文本透明度" value={settings.labelOpacity} min={0.05} max={1} step={0.05} onChange={(v) => { patch({ labelOpacity: v }) }} fmt={v => String(Math.round(v * 100)) + '%'} />
              <Slider label="节点大小" value={settings.nodeScale} min={0.4} max={4} step={0.05} onChange={(v) => { patch({ nodeScale: v }) }} fmt={v => v.toFixed(2) + '×'} />
              <Slider label="连线粗细" value={settings.edgeWidth} min={0.3} max={6} step={0.1} onChange={(v) => { patch({ edgeWidth: v }) }} fmt={v => v.toFixed(1)} />
              <button type="button" className={css.animBtn} onClick={() => { canvasRef.current?.runAnimation() }}>播放动画</button>
            </div>

            {/* 布局与固定 */}
            <div className={css.railSection}>
              <div className={css.railTitle}>布局</div>
              <div className={css.rowBtns}>
                <button type="button" className={css.miniBtn} onClick={() => { canvasRef.current?.relayout() }}>⟲ 重新布局</button>
                <button type="button" className={css.miniBtn} disabled={pinned.size === 0} onClick={() => { setPinned(new Set()) }}>清除固定{pinned.size > 0 ? ` (${pinned.size})` : ''}</button>
              </div>
              <button type="button" className={css.miniBtn} disabled={isDefaultSettings} onClick={restoreDefaults}>↺ 恢复默认参数</button>
              <Toggle label="锁定布局" checked={settings.lockLayout} onChange={(v) => { patch({ lockLayout: v }) }} />
              <div className={css.railHint}>「我」位于图谱中;拖拽节点调整布局;锁定布局后禁止拖拽与自动重排,力度/外观参数变化仍会重新布局。</div>
            </div>

            {/* 深度过滤 */}
            <div className={css.railSection}>
              <div className={css.railTitle}>深度过滤</div>
              <Slider label="邻域深度" value={settings.depth} min={0} max={8} step={1} onChange={(v) => { patch({ depth: v }) }} fmt={v => v === 0 ? '全部' : String(v) + ' 跳 (选中节点)'} />
            </div>

            {/* 力度 */}
            <div className={css.railSection}>
              <div className={css.railTitle}>力度</div>
              <Slider label="节点间距" value={settings.nodeGap} min={0.4} max={3.5} step={0.05} onChange={(v) => { patch({ nodeGap: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
              <Slider label="圈子分离度" value={settings.communitySeparation} min={0.3} max={5} step={0.1} onChange={(v) => { patch({ communitySeparation: v }) }} fmt={v => v.toFixed(1) + '×'} disabled={settings.lockLayout} />
              <Slider label="图谱向心力" value={settings.forceCentripetal} min={0} max={5} step={0.05} onChange={(v) => { patch({ forceCentripetal: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
              <Slider label="节点间的排斥力" value={settings.forceRepulsion} min={0.1} max={12} step={0.1} onChange={(v) => { patch({ forceRepulsion: v }) }} fmt={v => v.toFixed(1) + '×'} disabled={settings.lockLayout} />
              <Slider label="相连节点的吸引力" value={settings.forceAttraction} min={0.1} max={5} step={0.05} onChange={(v) => { patch({ forceAttraction: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
              <Slider label="连线长度" value={settings.forceEdgeLength} min={0.2} max={4} step={0.05} onChange={(v) => { patch({ forceEdgeLength: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
              {settings.lockLayout && <div className={css.railHint}>布局已锁定,力度/间距滑杆暂不可调;关闭「锁定布局」后恢复。</div>}
            </div>

            <div className={css.railHint}>点击节点选中并高亮相邻节点与连线;拖拽节点调整布局;滚轮缩放、拖拽空白平移;顶部「适应视图」缩放至全图。</div>
          </aside>
        )}
      </div>

      {/* 笔记编辑器（新建 / 编辑）。保存/删除后统一重载知识图谱，让画布立刻反映变化。 */}
      <KnowledgeNoteEditor
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

