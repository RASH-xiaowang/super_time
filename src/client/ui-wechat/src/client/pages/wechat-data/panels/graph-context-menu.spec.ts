/**
 * 节点右键菜单纯模型测试。
 *
 * 画布是 Canvas，DOM 测试环境不可用；因此把“菜单项由什么决定”和“菜单如何避开
 * 视口边缘”抽成纯函数，在这里锁住行为。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildNodeMenuItems,
  groupNodeMenuItems,
  noteIdOf,
  placeContextMenu,
} from './graph-context-menu-model.ts'
import type { GNode } from './graph-model.ts'

/** 最小节点。 */
function node(overrides: Partial<GNode> = {}): GNode {
  return {
    id: 'alice',
    label: 'Alice',
    kind: 'person',
    weight: 100,
    radius: 8,
    community: -1,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
    ...overrides,
  }
}

describe('节点右键菜单：按类型与能力给动作', () => {
  it('好友：详情 / 聚焦 / 固定 / 复制 / 查看聊天，不含笔记动作', () => {
    const items = buildNodeMenuItems({ node: node(), pinned: false, knowledge: false, canOpenChat: true })
    expect(items.map(i => i.id)).toEqual([
      'details', 'focus', 'pin', 'copy-label', 'copy-id', 'open-chat',
    ])
    expect(items.some(i => i.id.includes('note'))).toBe(false)
  })

  it('已固定节点显示“取消固定”，并保留可访问名称', () => {
    const items = buildNodeMenuItems({ node: node(), pinned: true, knowledge: false, canOpenChat: true })
    expect(items.find(i => i.id === 'pin')?.label).toBe('取消固定节点')
  })

  it('“我”、文件、章节、实体不出现固定（固定只用于社交布局锚点）', () => {
    const cases: GNode[] = [
      node({ id: 'self', kind: 'self' }),
      node({ id: 'file:1', kind: 'file' }),
      node({ id: 'doc:概览', kind: 'section' }),
      node({ id: 'ent:person:张三', kind: 'entity' }),
    ]
    for (const n of cases) {
      const items = buildNodeMenuItems({ node: n, pinned: false, knowledge: true, canOpenChat: false })
      expect(items.some(i => i.id === 'pin'), n.kind).toBe(false)
    }
  })

  it('没有聊天回调时不出现“查看聊天”，避免点了没反应的入口', () => {
    const items = buildNodeMenuItems({ node: node(), pinned: false, knowledge: false, canOpenChat: false })
    expect(items.some(i => i.id === 'open-chat')).toBe(false)
  })

  it('笔记：编辑 + 删除（删除标记为危险），不含聊天', () => {
    const items = buildNodeMenuItems({
      node: node({ id: 'note:42', label: '项目复盘', kind: 'note' }),
      pinned: false, knowledge: true, canOpenChat: true,
    })
    expect(items.find(i => i.id === 'edit-note')?.label).toBe('编辑笔记')
    expect(items.find(i => i.id === 'delete-note')?.danger).toBe(true)
    expect(items.some(i => i.id === 'open-chat')).toBe(false)
  })

  it('待补笔记：出现“创建这篇笔记”，不出现编辑/删除', () => {
    const items = buildNodeMenuItems({
      node: node({ id: 'kb:项目复盘', label: '项目复盘', kind: 'stub', stub: true }),
      pinned: false, knowledge: true, canOpenChat: false,
    })
    expect(items.some(i => i.id === 'create-note')).toBe(true)
    expect(items.some(i => i.id === 'edit-note' || i.id === 'delete-note')).toBe(false)
  })

  it('知识节点的聊天项一律不出现（即便调用方误传 canOpenChat）', () => {
    for (const kind of ['note', 'stub', 'file', 'section', 'entity'] as const) {
      const items = buildNodeMenuItems({
        node: node({ id: kind === 'note' ? 'note:1' : kind === 'file' ? 'file:1' : `x:${kind}`, kind }),
        pinned: false, knowledge: true, canOpenChat: true,
      })
      expect(items.some(i => i.id === 'open-chat'), kind).toBe(false)
    }
  })

  it('分组顺序固定为 查看 → 布局 → 复制 → 内容，空组不渲染', () => {
    const groups = groupNodeMenuItems(buildNodeMenuItems({
      node: node(), pinned: false, knowledge: false, canOpenChat: false,
    }))
    expect(groups.map(g => g.group)).toEqual(['view', 'layout', 'copy'])
  })
})

describe('菜单定位：靠边翻转并留安全边距', () => {
  it('普通位置不移动', () => {
    expect(placeContextMenu(
      { x: 100, y: 120 },
      { width: 240, height: 320 },
      { width: 1200, height: 800 },
    )).toEqual({ x: 100, y: 120 })
  })

  it('右下角优先向左上翻转，不能溢出', () => {
    const p = placeContextMenu(
      { x: 1180, y: 790 },
      { width: 240, height: 320 },
      { width: 1200, height: 800 },
    )
    expect(p).toEqual({ x: 932, y: 462 })
  })

  it('菜单比视口还大时仍保留 8px 边距（不出现负坐标）', () => {
    const p = placeContextMenu(
      { x: 50, y: 60 },
      { width: 900, height: 900 },
      { width: 500, height: 400 },
    )
    expect(p).toEqual({ x: 8, y: 8 })
  })
})

describe('节点 id 解析', () => {
  it('只接受正整数 note:N', () => {
    expect(noteIdOf(node({ id: 'note:42', kind: 'note' }))).toBe(42)
    expect(noteIdOf(node({ id: 'note:0', kind: 'note' }))).toBeNull()
    expect(noteIdOf(node({ id: 'note:42', kind: 'stub' }))).toBeNull()
  })
})
