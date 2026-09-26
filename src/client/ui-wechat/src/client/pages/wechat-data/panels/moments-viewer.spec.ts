// @vitest-environment jsdom
/**
 * `moments-viewer.ts` 的判据（第三批 #18 第四步）。
 *
 * 灯箱这一族的失败都不是崩溃，而是**说不清的怪**：滚轮把图缩到比原始还小、
 * 按最后一张再按右跳成 undefined、保存下来文件名写着 `.jpg` 内容其实是 webp。
 * 所以三条规则各钉正反例（`zoomFor` / `clampIndex` / `imageExtOf`），
 * 再用真渲染钉三件效果层的事：**换图一定复位**、**方向键不越界**、
 * **滚轮监听必须是非 passive 的**（React 的 `onWheel` 是 passive，
 * 在那里 `preventDefault()` 会被浏览器忽略 ⇒ 缩放到一半，身后的页面还在滚）。
 * @module moments-viewer-spec
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampIndex, imageExtOf, useMomentsViewer, zoomFor } from './moments-viewer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('zoomFor：滚轮推出来的倍率', () => {
  it('向上滚放大、向下滚缩小，比例各 1.1 / 0.9', () => {
    expect(zoomFor(-100, 1)).toBeCloseTo(1.1)
    expect(zoomFor(100, 2)).toBeCloseTo(1.8)
  })

  it('下限是 1：往下滚到底也不会缩成比原始更小', () => {
    let z = 1
    for (let i = 0; i < 40; i += 1) z = zoomFor(100, z)
    expect(z).toBe(1)
  })

  it('上限是 5：一路放大不会跑到无穷', () => {
    let z = 1
    for (let i = 0; i < 80; i += 1) z = zoomFor(-100, z)
    expect(z).toBe(5)
  })
})

describe('clampIndex：切图不许越界', () => {
  it('两端都钳住，中间原样', () => {
    expect(clampIndex(4, -3)).toBe(0)
    expect(clampIndex(4, 0)).toBe(0)
    expect(clampIndex(4, 2)).toBe(2)
    expect(clampIndex(4, 3)).toBe(3)
    expect(clampIndex(4, 99)).toBe(3)
  })

  it('只有一张时任何方向都停在 0（不是 -1 或 1）', () => {
    expect(clampIndex(1, 5)).toBe(0)
    expect(clampIndex(1, -5)).toBe(0)
  })

  it('空列表回 0（`len-1` 是 -1，钳位不许把它发出去）', () => {
    expect(clampIndex(0, 3)).toBe(0)
  })
})

describe('imageExtOf：保存时该用什么扩展名', () => {
  it('data URL 认 MIME，jpeg 归一成 jpg', () => {
    expect(imageExtOf('data:image/png;base64,AAAA')).toBe('png')
    expect(imageExtOf('data:image/webp;base64,AAAA')).toBe('webp')
    expect(imageExtOf('data:image/jpeg;base64,AAAA')).toBe('jpg')
    expect(imageExtOf('data:image/gif,,x')).toBe('gif')
  })

  it('普通地址取末段扩展名并转小写', () => {
    expect(imageExtOf('https://cdn/x/y.GIF?sign=1')).toBe('gif')
    expect(imageExtOf('https://cdn/x/y.png')).toBe('png')
  })

  it('签名尾巴不像扩展名时退回 jpg（写出 `.1688486141` 那种名字算缺陷）', () => {
    expect(imageExtOf('https://cdn/x/y.1688486141')).toBe('jpg')
    expect(imageExtOf('https://cdn/x/y')).toBe('jpg')
    expect(imageExtOf('https://cdn/x/y.averyverylongsegment')).toBe('jpg')
  })

  it('地址解析不了也不许抛，退回 jpg', () => {
    expect(imageExtOf('not a url at all %%%')).toBe('jpg')
  })
})

/* ── 效果层（真渲染） ──────────────────────────────────────────────────── */

let host: HTMLDivElement
let root: Root
let v: ReturnType<typeof useMomentsViewer> | null = null

function Harness(props: { open: boolean; images: number }): React.JSX.Element {
  v = useMomentsViewer()
  // 面板里这个 ref 由灯箱的包裹节点挂上。测试也必须让它**在打开灯箱的那次提交里**就位
  // （ref 回调早于 effect），否则 `[viewer]` 那次效果跑起来时 ref 还是 null —— 那正是
  // 这条效果依赖数组的口径，不能用「事后手动塞一个节点」绕过。
  return createElement('div', {
    'data-zoom': String(v.viewZoom),
    'data-index': String(v.viewer?.index ?? -1),
    'data-open': String(v.viewer !== null),
  }, props.open
    ? createElement('div', {
      'data-wrap': '1',
      ref: (el: HTMLDivElement | null): void => {
        if (v) v.lightboxWrapRef.current = el
      },
    })
    : null)
}

const attr = (name: string): string => host.firstElementChild?.getAttribute(name) ?? ''

const open = (images: number): void => {
  // 面板里包裹节点与 `viewer` 是同一次提交出现的（灯箱组件自己带 ref），
  // 所以这里也先让 ref 就位、再开灯箱 —— 反过来会造出一个产品里不存在的形状：
  // 效果跑的时候 ref 还是 null，等 ref 就位时依赖又没变，监听永远装不上。
  act(() => { root.render(createElement(Harness, { open: true, images })) })
  act(() => {
    v?.setViewer({ images: Array.from({ length: images }, (_, i) => ({ md5: 'm' + String(i) })), index: 0, author: '张三' })
  })
}

const key = (k: string): void => {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  v = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Harness, { open: false, images: 0 })) })
})

afterEach(() => {
  root.unmount()
  host.remove()
})

describe('useMomentsViewer 的效果', () => {
  it('渲染本身有效（否则下面几条是空转）', () => {
    expect(v, '钩子没跑起来').not.toBeNull()
    expect(attr('data-open')).toBe('false')
  })

  it('打开灯箱 ⇒ 复位成 1 倍（上一次留下的缩放不许带过来）', () => {
    act(() => { v?.setViewZoom(4) })
    open(3)
    expect(attr('data-open')).toBe('true')
    expect(attr('data-zoom'), '换个图集还带着上次的缩放').toBe('1')
  })

  it('方向键在两端都停得住，不绕回、不越界', () => {
    open(3)
    expect(attr('data-index')).toBe('0')
    key('ArrowLeft')
    expect(attr('data-index'), '第一张还能往左就变成 undefined 张了').toBe('0')
    key('ArrowRight')
    key('ArrowRight')
    expect(attr('data-index')).toBe('2')
    key('ArrowRight')
    expect(attr('data-index'), '最后一张往右越界').toBe('2')
    key('ArrowUp')
    expect(attr('data-index'), '别的键也动了索引').toBe('2')
  })

  it('setViewerIndex 钳进范围内', () => {
    open(3)
    act(() => { v?.setViewerIndex(77) })
    expect(attr('data-index')).toBe('2')
    act(() => { v?.setViewerIndex(-5) })
    expect(attr('data-index')).toBe('0')
  })

  it('滚轮监听是非 passive，且 preventDefault 真的被调（否则身后页面跟着滚）', () => {
    open(3)
    const wrap = host.querySelector('[data-wrap]') as HTMLDivElement
    expect(wrap, '测试夹具没把包裹节点挂上').not.toBeNull()
    let prevented = false
    const ev = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true })
    Object.defineProperty(ev, 'preventDefault', { value: () => { prevented = true } })
    act(() => { wrap.dispatchEvent(ev) })
    expect(prevented, '非 passive 监听没生效（React 的 onWheel 是 passive，那种写法拦不住页面滚动）').toBe(true)
    expect(Number(attr('data-zoom'))).toBeGreaterThan(1)
  })

  it('没开灯箱时不装滚轮监听（否则整页滚动都被吞掉）', () => {
    act(() => { v?.setViewer(null) })
    act(() => { root.render(createElement(Harness, { open: false, images: 0 })) })
    const wrap = document.createElement('div')
    let prevented = false
    const ev = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
    Object.defineProperty(ev, 'preventDefault', { value: () => { prevented = true } })
    wrap.dispatchEvent(ev)
    expect(prevented).toBe(false)
  })
})

describe('接线：面板只从这一层拿灯箱状态', () => {
  const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')

  it('面板走钩子，且不再自己持有那四个变换量', () => {
    expect(panel).toContain('useMomentsViewer')
    for (const gone of ['const [viewer, setViewer]', 'const [viewZoom', 'const [viewPan', 'const [viewRotate', 'const [viewOriginal', 'Math.max(0, v.index - 1)']) {
      expect(panel, `「${gone}」又回到面板里了`).not.toContain(gone)
      if (!gone.startsWith('Math.')) {
        expect(readFileSync(join(HERE, 'moments-viewer.ts'), 'utf8'), `本层里找不到「${gone}」⇒ 判据的对象是编的`).toContain(gone)
      }
    }
  })

  it('钩子调用必须留在媒体层之前（媒体层按 viewer 决定给哪一张做离线解码）', () => {
    const a = panel.indexOf('useMomentsViewer()')
    const b = panel.indexOf('useMomentsMedia({')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    expect(a, '顺序反了：媒体层会先于灯箱状态建立，viewer 变成永远是 null').toBeLessThan(b)
  })

  it('保存下来的文件名扩展名只能由那一条纯函数决定', () => {
    expect(panel).toContain('imageExtOf(src)')
    expect(panel, '面板里又自己嗅一遍扩展名').not.toContain('data:image')
    expect(readFileSync(join(HERE, 'moments-viewer.ts'), 'utf8')).toContain('data:image')
  })
})
