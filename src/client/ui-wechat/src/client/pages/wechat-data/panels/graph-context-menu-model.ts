/**
 * 知识图谱 / 社交图谱节点右键菜单的纯模型。
 *
 * 为什么单独成文件：菜单项要按节点类型（笔记 / 待补 / 文件 / 章节 / 实体 /
 * 好友 / 群）和技能能力（能否查看聊天、能否编辑笔记）决定。把这些条件留在
 * JSX 里会很快退化成到处 `if`，而且纯模型可以在 node 测试环境直接验证。
 *
 * 这里只描述“有哪些动作”，不执行动作；动作由 `GraphNodeContextMenu.tsx` 接线。
 */
import type { GNode } from './graph-model.ts'

/** 菜单项动作 id。 */
export type GraphNodeMenuAction =
  | 'details'
  | 'focus'
  | 'pin'
  | 'copy-label'
  | 'copy-id'
  | 'open-chat'
  | 'edit-note'
  | 'create-note'
  | 'delete-note'

/** 菜单分组：同一组内是相近动作，组间用分隔线。 */
export type GraphNodeMenuGroup = 'view' | 'layout' | 'copy' | 'content'

export interface GraphNodeMenuItem {
  id: GraphNodeMenuAction
  label: string
  group: GraphNodeMenuGroup
  /** 是否危险动作（删除），用于样式与二次确认。 */
  danger?: boolean
  /** 是否当前不可用；不可用项仍展示，让用户知道能力存在但条件不满足。 */
  disabled?: boolean
  /** 右侧快捷键提示（仅展示，不抢浏览器快捷键）。 */
  hint?: string
}

export interface GraphNodeMenuInput {
  node: GNode
  /** 是否已固定。 */
  pinned: boolean
  /** 是否知识图谱。 */
  knowledge: boolean
  /** 是否提供“查看聊天”能力（社交图谱且有外层回调）。 */
  canOpenChat: boolean
}

/** 知识类节点没有“查看聊天”（它们是库里的内容，不是通讯录对象）。 */
const KNOWLEDGE_KINDS = new Set<GNode['kind']>(['note', 'stub', 'file', 'section', 'entity'])
/** 可固定的是社交布局锚点；“我”始终固定，知识节点不是布局锚点。 */
const PINNABLE_KINDS = new Set<GNode['kind']>(['person', 'group'])

/** 节点是否是笔记（可编辑）。 */
export function noteIdOf(node: GNode): number | null {
  if (node.kind !== 'note' || !node.id.startsWith('note:')) return null
  const id = Number(node.id.slice(5))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 节点是否是未创建的笔记目标（可创建）。 */
export function isStubNode(node: GNode): boolean {
  return node.kind === 'stub'
}

/**
 * 构建节点菜单项。
 *
 * 顺序遵循“先看、再定位、再复制、最后改内容”的任务流；删除永远放在最后一组，
 * 避免误触。知识节点不出现聊天项，社交节点不出现笔记项。
 * @param input - 节点与当前能力。
 * @returns 菜单项列表（不含分隔线，分隔线由 UI 按 group 画）。
 */
export function buildNodeMenuItems(input: GraphNodeMenuInput): GraphNodeMenuItem[] {
  const { node, pinned, knowledge, canOpenChat } = input
  const items: GraphNodeMenuItem[] = [
    { id: 'details', label: '查看节点详情', group: 'view' },
    { id: 'focus', label: '聚焦 1 跳邻域', group: 'view', hint: '双击' },
  ]
  if (PINNABLE_KINDS.has(node.kind)) {
    items.push({ id: 'pin', label: pinned ? '取消固定节点' : '固定节点', group: 'layout' })
  }
  items.push(
    { id: 'copy-label', label: '复制节点名称', group: 'copy' },
    { id: 'copy-id', label: '复制节点 ID', group: 'copy' },
  )

  if (!knowledge && canOpenChat && !KNOWLEDGE_KINDS.has(node.kind)) {
    items.push({ id: 'open-chat', label: '查看聊天', group: 'content' })
  }

  const noteId = noteIdOf(node)
  if (noteId !== null) {
    items.push(
      { id: 'edit-note', label: '编辑笔记', group: 'content' },
      { id: 'delete-note', label: '删除笔记', group: 'content', danger: true },
    )
  } else if (isStubNode(node)) {
    items.push({ id: 'create-note', label: '创建这篇笔记', group: 'content' })
  }

  return items
}

/**
 * 把菜单项按 group 分组，供 UI 在组之间画分隔线。
 * @param items - 菜单项。
 * @returns 按 group 聚合后的列表（空组已过滤）。
 */
export function groupNodeMenuItems(
  items: readonly GraphNodeMenuItem[],
): ReadonlyArray<{ group: GraphNodeMenuGroup, items: readonly GraphNodeMenuItem[] }> {
  const order: GraphNodeMenuGroup[] = ['view', 'layout', 'copy', 'content']
  return order
    .map(group => ({ group, items: items.filter(item => item.group === group) }))
    .filter(entry => entry.items.length > 0)
}

/**
 * 计算菜单的视口内位置。
 *
 * 右键点靠近右/下边缘时菜单要向左/上翻转，而不是被裁掉。
 * 用 `clientX/clientY`（视口坐标），并留 8px 安全边距。
 * @param point - 右键位置。
 * @param menu - 菜单尺寸。
 * @param viewport - 视口尺寸。
 * @returns 左上角坐标（已夹在视口内）。
 */
export function placeContextMenu(
  point: { x: number, y: number },
  menu: { width: number, height: number },
  viewport: { width: number, height: number },
): { x: number, y: number } {
  const gap = 8
  // 优先保持在右键点右/下方；空间不够时翻到左/上方，再夹在视口内。
  // 只做夹紧会让菜单覆盖右键点左侧的大片内容，用户会以为点错了节点。
  const maxX = viewport.width - menu.width - gap
  const maxY = viewport.height - menu.height - gap
  const x = point.x + menu.width + gap > viewport.width - gap
    ? point.x - menu.width - gap
    : point.x
  const y = point.y + menu.height + gap > viewport.height - gap
    ? point.y - menu.height - gap
    : point.y
  return {
    x: Math.min(Math.max(x, gap), Math.max(gap, maxX)),
    y: Math.min(Math.max(y, gap), Math.max(gap, maxY)),
  }
}
