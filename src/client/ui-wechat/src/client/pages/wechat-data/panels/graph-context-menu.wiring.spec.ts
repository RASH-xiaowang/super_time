/**
 * 节点右键菜单接线守卫。
 *
 * Canvas 里的右键命中与 portal 定位无法在 node 环境跑 DOM；沿用仓库既有做法，
 * 对源码结构做最小断言，防止“菜单组件写了但画布没接”“所有右键都被吃掉”这类静默退化。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const host = readFileSync(join(HERE, 'graph-canvas-host.tsx'), 'utf8')
const graph = readFileSync(join(HERE, 'Graph.tsx'), 'utf8')
const menu = readFileSync(join(HERE, 'GraphNodeContextMenu.tsx'), 'utf8')
const controller = readFileSync(join(HERE, 'GraphNodeMenuController.tsx'), 'utf8')

describe('画布右键：命中节点才打开菜单', () => {
  it('onContextMenu 先命中测试，未命中直接 return（空白处保留浏览器菜单）', () => {
    expect(host).toMatch(/const onContextMenu = \(ev: React\.MouseEvent<HTMLCanvasElement>\): void =>/)
    expect(host).toMatch(/const hit = hitAt\(localPoint\(ev\)\)/)
    expect(host).toMatch(/if \(!hit \|\| !propsRef\.current\.onNodeContextMenu\) return/)
  })

  it('只有命中节点时才 preventDefault', () => {
    const start = host.indexOf('const onContextMenu =')
    const block = host.slice(start, host.indexOf('const onMiniClick =', start))
    expect(block.indexOf('if (!hit')).toBeLessThan(block.indexOf('ev.preventDefault()'))
  })

  it('传给面板的是视口坐标 clientX/clientY', () => {
    expect(host).toMatch(/onNodeContextMenu\(hit, \{ x: ev\.clientX, y: ev\.clientY \}\)/)
  })

  it('右键命中的节点同时成为当前选中，菜单与画布高亮指向同一目标', () => {
    expect(host).toMatch(/if \(!hit[\s\S]{0,350}?propsRef\.current\.onSelect\(hit\)[\s\S]{0,200}?onNodeContextMenu\(hit/)
  })

  it('左键才进入拖拽/选中，右键不会在菜单打开前先建拖拽状态', () => {
    expect(host).toMatch(/const onPointerDown =[\s\S]{0,250}?if \(ev\.button !== 0\) return/)
  })
})

describe('面板接线：菜单动作复用已有能力', () => {
  it('GraphCanvas 收到 onNodeContextMenu，并由节点 id 反查节点', () => {
    expect(graph).toMatch(/onNodeContextMenu=\{\(id, position\) =>/)
    expect(graph).toMatch(/graph\.nodes\.find\(n => n\.id === id\)/)
  })

  it('切库清理只依赖稳定函数，不能依赖随菜单打开而变化的整个状态对象', () => {
    expect(graph).toMatch(/\}, \[kbId, nodeMenu\.clear, clearSearch\]\)/)
    expect(graph).not.toContain('}, [kbId, nodeMenu])')
    expect(graph).not.toContain('}, [kbId, nodeSearch])')
    expect(graph).toContain('const clearSearch = useCallback((): void => { setSearchText(\'\') }, [])')
  })

  it('详情动作会选中并打开右侧抽屉', () => {
    expect(graph).toMatch(/const openNodeDetails = useCallback\(\(node: GNode\): void => \{\s*setSelectedId\(node\.id\)\s*setRailOpen\(true\)\s*detailRequest\.show\(\)/)
    expect(graph).toContain('onDetails={openNodeDetails}')
    expect(graph).toContain('detailRequest={detailRequest.request}')
  })

  it('聚焦 / 固定 / 复制 / 聊天 / 编辑 / 创建 / 删除都有真实动作', () => {
    for (const action of ['focus', 'pin', 'copy-label', 'copy-id', 'open-chat', 'edit-note', 'create-note', 'delete-note']) {
      expect(controller, `缺少 ${action} 动作`).toContain(`case '${action}':`)
    }
    expect(controller).toContain('copyTextToClipboard(node.label)')
    expect(controller).toContain('copyTextToClipboard(node.id)')
  })

  it('删除笔记走应用内确认框，不能一点就删', () => {
    const noteActions = readFileSync(join(HERE, 'use-graph-note-actions.ts'), 'utf8')
    expect(noteActions).toMatch(/const ok = await confirm\(\{/)
    expect(noteActions).toContain("title: '删除这篇笔记？'")
    expect(noteActions).toContain('if (!ok) return')
  })
})

describe('菜单浮层：portal / 定位 / 键盘 / 关闭', () => {
  it('挂到 document.body，避开画布 overflow hidden', () => {
    expect(menu).toContain('createPortal(')
    expect(menu).toContain('document.body')
  })

  it('打开后聚焦第一项，并支持方向键 / Home / End', () => {
    expect(menu).toContain('firstItemRef.current?.focus()')
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(menu).toContain(`ev.key === '${key}'`)
  })

  it('点击外部、Escape、滚动、尺寸变化都关闭', () => {
    expect(menu).toContain("document.addEventListener('mousedown', onDown)")
    expect(menu).toContain("document.addEventListener('keydown', onKey)")
    expect(menu).toContain("window.addEventListener('scroll', onViewport, true)")
    expect(menu).toContain("window.addEventListener('resize', onViewport)")
  })

  it('菜单自身拦截 contextmenu，避免右键菜单里再弹浏览器菜单', () => {
    expect(menu).toContain('onContextMenu={(ev) => { ev.preventDefault() }}')
  })
})
