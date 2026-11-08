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
import type { GEdge, GNode } from './graph-model.ts'
import {
  communityColor,
  edgeDirectionSymbol,
  edgeKindLabel,
  edgeRelationLabel,
  edgeRelationLines,
} from './graph-model.ts'
import { readableOn } from '../utils/theme-color.ts'
import css from './graph.module.css'
import kitCss from '../ui/kit.module.css'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'

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
  members: ReadonlyArray<{ username: string, name: string, enterpriseName?: string, visible: boolean }>
}

/** 选中节点的相连关系（`other` 可能缺失：对端被「仅显示好友」或节点上限挡在图外）。 */
interface Connection {
  edge: GEdge
  other: GNode | null | undefined
}

/** 只有真实的单聊好友与群聊有会话；知识节点和「我」节点都不能拿去当 username。 */
const CHAT_KINDS = new Set(['person', 'group'])

export interface GraphSelectionDetailProps {
  /** 是否知识图谱（知识节点的 id 不是微信 username，不能拿去查头像）。 */
  isKnowledgeMode?: boolean
  /** 当前选中的节点。 */
  selected: GNode
  /** 「我」的真实 username（相连关系里可能包含 self 节点）。 */
  selfUsername?: string
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
    isKnowledgeMode = false, selected, selfUsername = '', selAvatar, selectedGroupNames, selectedClass, selectedConnections,
    communities, focusCommunity, pinned, selectNode, clearSelection, focusNode,
    togglePin, openNoteEditor, newNote, onOpenChat,
  } = p

  const connectionUsername = (id: string): string => {
    if (isKnowledgeMode) return ''
    return id === 'self' ? selfUsername : id
  }

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
          <span className={css.detailName}>{withEnterprise(selected.label, selected.enterpriseName)}</span>
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
                      : selected.kind === 'group' && selected.membershipStatus === 'unknown'
                        ? `群聊 · 消息量 ${selected.intimacy ?? selected.weight} · 成员快照缺失（不代表 0 人）`
                        : `${selected.kind === 'group' ? '群聊' : selected.kind === 'self' ? '我' : selected.isOfficial ? '公众号' : (selected.isFriend ? '好友' : '群友')} · 消息量 ${selected.intimacy ?? selected.weight}`}
            {selected.sharedCount !== undefined ? ` · 共同 ${selected.sharedCount}` : ''}
            {selected.membersTotal !== undefined ? ` · 成员 ${selected.membersTotal}${selected.membersTruncated ? '（详情已截断）' : ''}` : ''}
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
        {(selected.kind === 'person' || selected.kind === 'group') && (
          <button type="button" className={css.miniBtn} data-on={pinned.has(selected.id) || undefined} onClick={() => { togglePin(selected.id) }}>{pinned.has(selected.id) ? '已固定' : '固定'}</button>
        )}
        {selected.kind === 'note' && (
          <button type="button" className={css.miniBtn} onClick={() => { openNoteEditor(Number(selected.id.slice(5))) }}>编辑笔记</button>
        )}
        {/* stub 的闭环：点它就地把「还缺的那篇笔记」写出来，而不是留一个悬空引用 */}
        {selected.kind === 'stub' && (
          <button type="button" className={css.miniBtn} onClick={newNote}>创建这篇笔记</button>
        )}
        {onOpenChat && CHAT_KINDS.has(selected.kind) && (
          <button type="button" className={css.miniBtn} onClick={() => { onOpenChat(selected.id) }}>查看聊天</button>
        )}
      </div>
      {selectedGroupNames.length > 0 && (
        <>
          <div className={css.detailSub}>共同群</div>
          <div className={`${css.detailChips} ${css.detailConnections}`}>
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
                title={m.visible
                  ? withEnterprise(m.name, m.enterpriseName)
                  : `${withEnterprise(m.name, m.enterpriseName)}（被「仅显示好友」或「节点上限」挡在图外，未参与连边）`}
                onClick={() => { if (m.visible) selectNode(m.username) }}
              >
                <IdentityName
                  className={css.detailChipIdentity}
                  name={m.name}
                  username={m.username}
                  size={16}
                >
                  {withEnterprise(m.name, m.enterpriseName)}
                </IdentityName>
              </button>
            ))}
          </div>
        </>
      )}
      <div className={css.detailSub}>相连关系 ({selectedConnections.length} 条边)</div>
      <div className={css.detailEdgeHint}>线条样式由主关系决定；悬停任一项可查看该边的全部关系、方向、权重与证据。</div>
      <div className={`${css.detailChips} ${css.detailConnections}`}>
        {selectedConnections.map((ce) => {
          const other = ce.other
          const names = new Map<string, string>()
          names.set(selected.id, selected.label)
          if (other) names.set(other.id, withEnterprise(other.label, other.enterpriseName))
          names.set('self', '我')
          const labelOf = (id: string): string => names.get(id) ?? id
          const lines = edgeRelationLines(ce.edge, labelOf)
          const relations = ce.edge.relations ?? []
          const kinds = [...new Set(relations.map(edgeRelationLabel))]
          const kindSummary = kinds.length === 0
            ? edgeKindLabel(ce.edge.kind)
            : kinds.slice(0, 2).join(' / ') + (kinds.length > 2 ? ` 等 ${kinds.length} 种` : '')
          const title = other
            ? [withEnterprise(other.label, other.enterpriseName), ...lines].join('\n')
            : '对端节点不在当前视图'
          return (
            <button
              key={JSON.stringify([ce.edge.source, ce.edge.target])}
              type="button"
              className={`${css.detailChip} ${css.detailEdgeChip}`}
              data-edge
              disabled={!other}
              onClick={() => { if (other) selectNode(other.id) }}
              title={title}
              aria-label={title}
            >
              <span className={css.detailEdgeTop}>
                {other
                  ? isKnowledgeMode ? (
                      <span className={css.detailChipLabel}>{withEnterprise(other.label, other.enterpriseName)}</span>
                    ) : (
                      <IdentityName
                        className={css.detailChipIdentity}
                        name={other.label}
                        username={connectionUsername(other.id)}
                        size={16}
                      >
                        {withEnterprise(other.label, other.enterpriseName)}
                      </IdentityName>
                    )
                  : <span className={css.detailChipLabel}>对端不在当前视图</span>}
              </span>
              <span className={css.detailEdgeMeta}>
                {kindSummary} {edgeDirectionSymbol(ce.edge)} · 权重 {ce.edge.weight}
                {relations.length > 1 ? ` · ${relations.length} 种关系` : ''}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
