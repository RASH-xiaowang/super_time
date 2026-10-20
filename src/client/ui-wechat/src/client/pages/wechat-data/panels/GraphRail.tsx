/**
 * 社交 / 知识图谱的**参数面板**（悬浮层）。
 *
 * ## 为什么单独成文件
 *
 * `Graph.tsx#GraphPanel` 在 `function-size-ratchet.spec.ts` 里登记为 725 行（**只许变小**）。
 * 2026-10-16 把控制栏从「固定 252px 右栏」改成「悬浮弹层」时，新增的折叠按钮 + 浮层标题栏
 * 让它涨到 753 行 —— 直接顶穿棘轮。这里把整块 `<aside>`（约 250 行 JSX）按**语义**抽出来：
 * 它是「调参数」这一件事的完整界面，与画布渲染、数据加载无关。
 *
 * ## 为什么是 props 而不是 context
 *
 * 依赖项多（`graph` / `selected` / `settings` / `patch` / `communities` / `pinned` / …），
 * 但它们**全部**来自 `GraphPanel` 的局部状态 —— 建 context 只会多一层间接，
 * 而 props 让「这一节用到哪些状态」在签名里一眼看得全。
 *
 * ## 悬浮层的定位
 *
 * `.rail` 是 `position: absolute`（相对 `.stage`），**不占布局宽度** —— 这是本次改动的核心：
 * 原先它 `flex-shrink: 0`，窗口一窄就把画布压成一条缝（节点半径是绝对值，于是全挤成一团）。
 * 折叠按钮 `.railToggle` 由调用方渲染（它要在浮层**外面**，收起时才可见）。
 *
 * @module panels/GraphRail
 */
import { useEffect, useState } from 'react'
import type { BuiltGraph, GNode, GraphSettings } from './graph-model.ts'
import { communityColor } from './graph-model.ts'
import { readableOn } from '../utils/theme-color.ts'
import { GraphSelectionDetail } from './GraphSelectionDetail.tsx'
import css from './graph.module.css'
import kitCss from '../ui/kit.module.css'

/** 滑块（本文件与 `Graph.tsx` 共用同一套外观；`Graph.tsx` 里那份是模块私有的）。 */
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
    <label className={css.ctlRow}>
      <span className={css.ctlLabel}>{label}</span>
      <input
        type="range"
        className={css.ctlRange}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => { onChange(Number(e.target.value)) }}
      />
      <span className={css.ctlValue}>{fmt ? fmt(value) : String(value)}</span>
    </label>
  )
}

/** 开关（同上）。 */
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button type="button" className={css.ctlToggle} data-on={checked || undefined} onClick={() => { onChange(!checked) }}>
      <span className={css.ctlTrack}><i className={css.ctlKnob} /></span>
      <span>{label}</span>
    </button>
  )
}

/** 一个圈子（`communities` 的元素类型，从 `GraphPanel` 的用法反推）。 */
interface Community {
  id: number
  members: ReadonlyArray<{ label: string }>
}

/** 选中节点的「同班级」信息。 */
interface SelectedClass {
  key: string
  total: number
  visibleCount: number
  members: ReadonlyArray<{ username: string, name: string, visible: boolean }>
}

/** 选中节点的相连关系（`other` 可能缺失：对端被「仅显示好友」或节点上限挡在图外）。 */
interface Connection {
  edge: { source: string, target: string, weight: number }
  other: { id: string, label: string } | null | undefined
}

export interface GraphRailProps {
  /** 当前图（节点/连线/圈子计数）。 */
  graph: BuiltGraph
  /** 是否知识图谱模式（决定若干文案与分段）。 */
  isKnowledgeMode: boolean
  /** 当前选中的节点（null = 无）。 */
  selected: GNode | null
  /** 选中节点的头像 data URL（空串 = 用首字兜底）。 */
  selAvatar: string
  /** 选中节点的共同群名。 */
  selectedGroupNames: readonly string[]
  /** 选中节点的同班级信息（null = 无）。 */
  selectedClass: SelectedClass | null
  /** 选中节点的相连关系。 */
  selectedConnections: readonly Connection[]
  /** 圈子列表。 */
  communities: readonly Community[]
  /** 当前聚焦的圈子（null = 未聚焦）。 */
  focusCommunity: number | null
  /** 最亲近 / 最关联 Top 榜。 */
  topFriends: readonly GNode[]
  /** 知识图谱的 Top 笔记。 */
  topNotes: ReadonlyArray<{ id: number, title: string, excerpt?: string, sourceKind?: string, backLinks: number, outLinks: number }>
  /** 知识图谱摘要（null = 不可用）。 */
  knowledge: { summary: { noteCount: number, askCount: number, stubCount: number, orphanCount: number } } | null
  /** 当前参数。 */
  settings: GraphSettings
  /** 是否已是默认参数（决定「恢复默认」是否可点）。 */
  isDefaultSettings: boolean
  /** 已固定的节点 id。 */
  pinned: ReadonlySet<string>
  /** 改一个参数。 */
  patch: (p: Partial<GraphSettings>) => void
  /** 切换数据口径（好友 / 群组 / 知识网络）。 */
  setMode: (m: GraphSettings['mode']) => void
  /** 选中一个节点（并居中）。 */
  selectNode: (id: string) => void
  /** 清除选中。 */
  clearSelection: () => void
  /** 聚焦某个节点 1 跳。 */
  focusNode: (id: string) => void
  /** 固定 / 取消固定一个节点。 */
  togglePin: (id: string) => void
  /** 聚焦 / 取消聚焦一个圈子。 */
  setFocusCommunity: (updater: (prev: number | null) => number | null) => void
  /** 悬停预览一个圈子。 */
  setHoverCommunity: (id: number | null) => void
  /** 打开笔记编辑器（id 为空 = 新建）。 */
  openNoteEditor: (id?: number) => void
  /** 删除一篇笔记。 */
  removeNote: (id: number) => void
  /** 新建笔记。 */
  newNote: () => void
  /** 重新布局。 */
  relayout: () => void
  /** 清除全部固定。 */
  clearPinned: () => void
  /** 恢复默认参数。 */
  restoreDefaults: () => void
  /** 播放布局动画。 */
  runAnimation: () => void
  /** 打开某个节点的聊天（可选）。 */
  onOpenChat?: ((username: string) => void) | undefined
  /** 收起面板。 */
  onClose: () => void
}

/** 知识类节点（笔记 / 待补 / 文件 / 章节 / 实体）没有「查看聊天」。 */
const KNOWLEDGE_KINDS = new Set(['note', 'stub', 'file', 'section', 'entity'])

/**
 * 渲染参数面板（悬浮层）。
 * @param p - 见 {@link GraphRailProps}。
 * @returns 浮层元素。
 */
export function GraphRail(p: GraphRailProps): React.JSX.Element {
  const {
    isKnowledgeMode, selected, selAvatar, selectedGroupNames, selectedClass, selectedConnections,
    communities, focusCommunity, topFriends, topNotes, knowledge, settings, isDefaultSettings, pinned,
    patch, setMode, selectNode, clearSelection, focusNode, togglePin, setFocusCommunity, setHoverCommunity,
    openNoteEditor, removeNote, newNote, relayout, clearPinned, restoreDefaults, runAnimation, onOpenChat, onClose,
  } = p

  /**
   * 侧栏视图（2026-10-18 用户反馈）：参数是参数、节点详情是详情，不再把详情塞进
   * 「图谱参数」列表里。选中节点时自动切到详情页；点「图谱参数」页签可随时回去调参。
   */
  const [view, setView] = useState<'params' | 'detail'>(selected ? 'detail' : 'params')
  useEffect(() => { setView(selected ? 'detail' : 'params') }, [selected?.id])

  return (
    <aside className={css.rail} aria-label="图谱参数">
      <div className={css.railHd}>
        <span className={css.railHdTitle}>{view === 'detail' ? '节点详情' : '图谱参数'}</span>
        <button type="button" className={css.railClose} onClick={onClose} aria-label="收起参数面板">✕</button>
      </div>

      {/* 视图页签：参数与「选中节点详情」是两件事，不再混在同一个列表里 */}
      <div className={css.seg} role="tablist" aria-label="图谱侧栏视图">
        <button type="button" role="tab" aria-selected={view === 'params'} className={css.segBtn} data-on={view === 'params' || undefined} onClick={() => { setView('params') }}>图谱参数</button>
        <button type="button" role="tab" aria-selected={view === 'detail'} className={css.segBtn} data-on={view === 'detail' || undefined} disabled={!selected} onClick={() => { if (selected) setView('detail') }}>节点详情{selected ? '' : ' · 未选中'}</button>
      </div>

      {view === 'detail' ? (
        selected ? (
          <GraphSelectionDetail
            selected={selected}
            selAvatar={selAvatar}
            selectedGroupNames={selectedGroupNames}
            selectedClass={selectedClass}
            selectedConnections={selectedConnections}
            communities={communities}
            focusCommunity={focusCommunity}
            pinned={pinned}
            selectNode={selectNode}
            clearSelection={clearSelection}
            focusNode={focusNode}
            togglePin={togglePin}
            openNoteEditor={openNoteEditor}
            newNote={newNote}
            onOpenChat={onOpenChat}
          />
        ) : (
          <div className={css.railSection}>
            <div className={css.railTitle}>未选中节点</div>
            <div className={kitCss.textMeta}>在图谱里点击任意节点，这里显示它的关系、共同群聊与可执行操作；调参请切「图谱参数」。</div>
          </div>
        )
      ) : (
        <>
          {/* 最亲近 Top5（统计计数在页头统计条已有一份，这里不再重复一遍） */}
          <div className={css.railSection}>
            <div className={css.railTitle}>{isKnowledgeMode ? '最关联 · 连接度' : '最亲近 · 消息量'}</div>
            {topFriends.map((n, i) => (
              <button key={n.id} type="button" className={css.rank} title={n.label} onClick={() => { selectNode(n.id) }}>
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
                {focusCommunity !== null && <button type="button" className={css.clearChip} onClick={() => { setFocusCommunity(() => null) }}>清除聚焦</button>}
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

          {/* 数据筛选 + 邻域深度（同属「看哪些节点」，放在同一区，避免分区过碎） */}
          <div className={css.railSection}>
            <div className={css.railTitle}>数据</div>
            {isKnowledgeMode ? (
              /* 知识图谱只有「知识网络」一种数据口径 —— 曾经的「融合视图」（把笔记的来源会话
                 叠进图里）已整体删除：节点必须全部来自知识库，人/群是通讯录数据。
                 这里保留同一套分段外观，让右侧栏与社交分支的高度/观感一致。 */
              <div className={css.seg}>
                <button type="button" className={css.segBtn} data-on onClick={() => { setMode('knowledge') }}>知识网络</button>
              </div>
            ) : (
              <div className={css.seg}>
                <button type="button" className={css.segBtn} data-on={settings.mode === 'people' || undefined} onClick={() => { setMode('people') }}>好友网络</button>
                <button type="button" className={css.segBtn} data-on={settings.mode === 'groups' || undefined} onClick={() => { setMode('groups') }}>群组网络</button>
              </div>
            )}
            <Slider label="节点上限" value={settings.nodeLimit} min={1} max={10000} step={1} onChange={(v) => { patch({ nodeLimit: v }) }} fmt={v => v >= 10000 ? '全部' : String(v)} />
            {(settings.mode === 'people' || settings.mode === 'groups') && (
              <Slider label={settings.mode === 'people' ? '共同群阈值 ≥' : '共同成员阈值 ≥'} value={settings.minCommon} min={1} max={10} step={1} onChange={(v) => { patch({ minCommon: v }) }} />
            )}
            {settings.mode === 'people' && (
              <>
                <Toggle label="仅显示好友" checked={settings.friendsOnly} onChange={(v) => { patch({ friendsOnly: v }) }} />
                <Toggle label="同备注编号连边" checked={settings.remarkClass} onChange={(v) => { patch({ remarkClass: v }) }} />
                <Toggle label="首字相同连边" checked={settings.firstChar} onChange={(v) => { patch({ firstChar: v }) }} />
              </>
            )}
            <Slider label="邻域深度" value={settings.depth} min={0} max={8} step={1} onChange={(v) => { patch({ depth: v }) }} fmt={v => v === 0 ? '全部' : String(v) + ' 跳 (选中节点)'} />
          </div>

      {/* 知识笔记（仅知识图谱显示） */}
      {isKnowledgeMode && (
        <div className={css.railSection}>
          <div className={css.railTitle}>知识笔记</div>
          <div className={css.rowBtns}>
            <button type="button" className={css.miniBtn} onClick={newNote}>＋ 新建笔记</button>
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
                onClick={() => { selectNode('note:' + String(n.id)) }}
              >
                {n.title}
                {n.sourceKind === 'ask' ? ' ·来自问答' : ''}
                <span className={css.noteMetric}>{n.backLinks} ← / → {n.outLinks}</span>
              </button>
              <button type="button" className={css.noteEdit} onClick={() => { openNoteEditor(n.id) }} aria-label={`编辑 ${n.title}`}>编</button>
              <button type="button" className={css.noteDel} onClick={() => { removeNote(n.id) }} aria-label={`删除 ${n.title}`}>×</button>
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
        <Slider label="头像模糊" value={settings.blurNodes} min={0} max={12} step={1} onChange={(v) => { patch({ blurNodes: v }) }} fmt={v => v === 0 ? '关闭' : String(v) + 'px'} />
        <Slider label="文本透明度" value={settings.labelOpacity} min={0.05} max={1} step={0.05} onChange={(v) => { patch({ labelOpacity: v }) }} fmt={v => String(Math.round(v * 100)) + '%'} />
        <Slider label="节点大小" value={settings.nodeScale} min={0.4} max={4} step={0.05} onChange={(v) => { patch({ nodeScale: v }) }} fmt={v => v.toFixed(2) + '×'} />
        <Slider label="连线粗细" value={settings.edgeWidth} min={0.3} max={6} step={0.1} onChange={(v) => { patch({ edgeWidth: v }) }} fmt={v => v.toFixed(1)} />
        <button type="button" className={css.animBtn} onClick={runAnimation}>播放动画</button>
      </div>

      {/* 布局与固定 + 力度（同属「怎么摆」，合成一区） */}
      <div className={css.railSection}>
        <div className={css.railTitle}>布局与力度</div>
        <div className={css.rowBtns}>
          <button type="button" className={css.miniBtn} onClick={relayout}>重新布局</button>
          <button type="button" className={css.miniBtn} disabled={pinned.size === 0} onClick={clearPinned}>清除固定{pinned.size > 0 ? ` (${String(pinned.size)})` : ''}</button>
        </div>
        <button type="button" className={css.miniBtn} disabled={isDefaultSettings} onClick={restoreDefaults}>恢复默认参数</button>
        <Toggle label="锁定布局" checked={settings.lockLayout} onChange={(v) => { patch({ lockLayout: v }) }} />
        <Slider label="节点间距" value={settings.nodeGap} min={0.4} max={3.5} step={0.05} onChange={(v) => { patch({ nodeGap: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
        <Slider label="圈子分离度" value={settings.communitySeparation} min={0.3} max={5} step={0.1} onChange={(v) => { patch({ communitySeparation: v }) }} fmt={v => v.toFixed(1) + '×'} disabled={settings.lockLayout} />
        <Slider label="图谱向心力" value={settings.forceCentripetal} min={0} max={5} step={0.05} onChange={(v) => { patch({ forceCentripetal: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
        <Slider label="节点间的排斥力" value={settings.forceRepulsion} min={0.1} max={12} step={0.1} onChange={(v) => { patch({ forceRepulsion: v }) }} fmt={v => v.toFixed(1) + '×'} disabled={settings.lockLayout} />
        <Slider label="相连节点的吸引力" value={settings.forceAttraction} min={0.1} max={5} step={0.05} onChange={(v) => { patch({ forceAttraction: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
        <Slider label="连线长度" value={settings.forceEdgeLength} min={0.2} max={4} step={0.05} onChange={(v) => { patch({ forceEdgeLength: v }) }} fmt={v => v.toFixed(2) + '×'} disabled={settings.lockLayout} />
        {settings.lockLayout && <div className={css.railHint}>布局已锁定，力度/间距滑杆暂不可调；关闭「锁定布局」后恢复。</div>}
        <div className={css.railHint}>拖拽节点调整布局；「我」固定在图谱中，锁定后禁止拖拽与自动重排。</div>
      </div>

      <div className={css.railHint}>点击节点选中并高亮相邻节点与连线；拖拽节点调整布局；滚轮缩放、拖拽空白平移；顶部「适应视图」缩放至全图。</div>
        </>
      )}
    </aside>
  )
}
