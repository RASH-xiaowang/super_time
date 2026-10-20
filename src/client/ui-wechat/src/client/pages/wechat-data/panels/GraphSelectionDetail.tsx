/**
 * 图谱参数面板里的**选中节点详情**卡片。
 *
 * ## 为什么单独成文件
 *
 * `GraphRail.tsx#GraphRail` 抽出后仍有 270 行，顶穿 `function-size-ratchet.spec.ts` 的 250 行上限。
 * 这块详情卡是**语义独立**的一节：它只回答「我点中的这个节点是谁、和谁有关系、能对它做什么」，
 * 与下面的滑杆 / 开关（调参数）没有耦合。抽出来后 `GraphRail` 回到 250 行以内。
 *
 * ## 为什么是 props 而不是 context
 *
 * 依赖项全部来自 `GraphPanel` 的局部状态；props 让「这一节用到哪些状态」在签名里一眼看得全。
 *
 * @module panels/GraphSelectionDetail
 */
import type { GNode } from './graph-model.ts'
import { communityColor } from './graph-model.ts'
import { readableOn } from '../utils/theme-color.ts'
import css from './graph.module.css'
import kitCss from '../ui/kit.module.css'

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

/** 知识类节点（笔记 / 待补 / 文件 / 章节 / 实体）没有「查看聊天」。 */
const KNOWLEDGE_KINDS = new Set(['note', 'stub', 'file', 'section', 'entity'])

export interface GraphSelectionDetailProps {
  /** 当前选中的节点。 */
  selected: GNode
  /** 选中节点的头像 data URL（空串 = 用首字兜底）。 */
  selAvatar: string
  /** 选中节点的共同群名。 */
  selectedGroupNames: readonly string[]
  /** 选中节点的同班级信息（null = 无）。 */
  selectedClass: SelectedClass | null
  /** 选中节点的相连关系。 */
  selectedConnections: readonly Connection[]
  /** 圈子列表（用于显示「圈子 #N · M 位」）。 */
  communities: readonly Community[]
  /** 当前聚焦的圈子（null = 未聚焦）。 */
  focusCommunity: number | null
  /** 已固定的节点 id。 */
  pinned: ReadonlySet<string>
  /** 选中一个节点（并居中）。 */
  selectNode: (id: string) => void
  /** 清除选中。 */
  clearSelection: () => void
  /** 聚焦某个节点 1 跳。 */
  focusNode: (id: string) => void
  /** 固定 / 取消固定一个节点。 */
  togglePin: (id: string) => void
  /** 打开笔记编辑器（id 为空 = 新建）。 */
  openNoteEditor: (id?: number) => void
  /** 新建笔记（stub 的闭环）。 */
  newNote: () => void
  /** 打开某个节点的聊天（可选）。 */
  onOpenChat?: ((username: string) => void) | undefined
}

/**
 * 渲染选中节点详情卡。
 * @param p - 见 {@link GraphSelectionDetailProps}。
 * @returns 详情卡元素。
 */
export function GraphSelectionDetail(p: GraphSelectionDetailProps): React.JSX.Element {
  const {
    selected, selAvatar, selectedGroupNames, selectedClass, selectedConnections,
    communities, focusCommunity, pinned, selectNode, clearSelection, focusNode,
    togglePin, openNoteEditor, newNote, onOpenChat,
  } = p

  return (
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
                : selected.kind === 'file'
                  ? `文件 · ${selected.fileMeta?.ext.toUpperCase() || '未知类型'} · ${selected.fileMeta?.chunkCount ?? 0} 个文本块 / ${selected.fileMeta?.charCount ?? 0} 字`
                  : selected.kind === 'section'
                    ? `章节 · ${selected.sectionFileIds?.length ?? 0} 份文件里都有 · 共出现 ${selected.backLinks ?? 0} 次`
                    // 实体直接复读 excerpt：那句话里已经写清了「模型推断」与是哪个模型，
                    // 详情里再拼一遍「实体 · N 份文件」反而把它最要紧的半句丢了。
                    : selected.kind === 'entity'
                      ? (selected.excerpt || '模型推断的实体')
                      : `${selected.kind === 'group' ? '群聊' : selected.kind === 'self' ? '我' : selected.isOfficial ? '公众号' : (selected.isFriend ? '好友' : '群友')} · 消息量 ${selected.intimacy ?? selected.weight}`}
            {selected.sharedCount !== undefined ? ` · 共同 ${selected.sharedCount}` : ''}
          </span>
        </div>
        <button type="button" className={css.detailClose} onClick={clearSelection} aria-label="关闭详情">×</button>
      </div>
      {selected.community >= 0 && (
        <div className={`${kitCss.textMeta} ${css.legendRow}`}>
          <i style={{ width: 10, height: 10, borderRadius: 10, background: communityColor(selected.community), display: 'inline-block' }} />
          圈子 #{selected.community + 1} · {communities.find(c => c.id === selected.community)?.members.length ?? 0} 位
        </div>
      )}
      <div className={css.detailBtns}>
        <button type="button" className={css.miniBtn} onClick={() => { focusNode(selected.id) }}>聚焦 1 跳</button>
        {selected.id !== 'self' && (
          <button type="button" className={css.miniBtn} data-on={pinned.has(selected.id) || undefined} onClick={() => { togglePin(selected.id) }}>{pinned.has(selected.id) ? '已固定' : '固定'}</button>
        )}
        {selected.kind === 'note' && (
          <button type="button" className={css.miniBtn} onClick={() => { openNoteEditor(Number(selected.id.slice(5))) }}>编辑笔记</button>
        )}
        {/* stub 的闭环：点它就地把「还缺的那篇笔记」写出来，而不是留一个悬空引用 */}
        {selected.kind === 'stub' && (
          <button type="button" className={css.miniBtn} onClick={newNote}>创建这篇笔记</button>
        )}
        {onOpenChat && !KNOWLEDGE_KINDS.has(selected.kind) && (
          <button type="button" className={css.miniBtn} onClick={() => { onOpenChat(selected.id) }}>查看聊天</button>
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
      {selectedClass && (
        <>
          <div className={css.detailSub}>
            同班级 · {selectedClass.key}
            {selectedClass.members.length > 0 ? `（全库 ${selectedClass.total} 人 · 本视图 ${selectedClass.visibleCount} 人）` : ''}
          </div>
          <div className={css.detailChips}>
            {selectedClass.members.map(m => (
              <button
                key={m.username}
                type="button"
                className={css.detailChip}
                data-dim={m.visible ? undefined : true}
                disabled={!m.visible}
                title={m.visible ? m.name : `${m.name}（被「仅显示好友」或「节点上限」挡在图外，未参与连边）`}
                onClick={() => { if (m.visible) selectNode(m.username) }}
              >
                {m.name.length > 12 ? m.name.slice(0, 12) + '…' : m.name}
              </button>
            ))}
          </div>
        </>
      )}
      <div className={css.detailSub}>相连关系 ({selectedConnections.length})</div>
      <div className={css.detailChips}>
        {selectedConnections.map(ce => (
          <button key={ce.edge.source + ce.edge.target} type="button" className={css.detailChip} onClick={() => { selectNode(ce.other?.id ?? '') }} title={ce.other?.label ?? ''}>
            {ce.other?.label ?? '?'}<span className={css.rankW}>{ce.edge.weight}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
