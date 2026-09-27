// @vitest-environment jsdom
/**
 * 分页哨兵的「停滞」行为判据（#22 的真窗口验收实测抓到，不是推测）。
 *
 * 症状：`useLazySentinel` 只在 IntersectionObserver **报状态变化**的那一刻回调一次。
 * 于是两种情况下翻页会永远停在当前页，而界面上一点错都不报：
 *  ① 首报正好撞上"这一页还在加载中"，调用方那句 `if (hasMore && !loadingMore)` 把它丢了，
 *     而哨兵此后一直待在视口里 ⇒ 不会再有第二次回调；
 *  ② 内容比视口矮（大屏 + 小分页），哨兵从来就没离开过视口。
 * 实测形状：600 条附件、格子墙视口 625px 高 ⇒ 翻到第 2 页（60 条）就再也不动。
 * 修法是 `watch`（通常传已加载条数）：数据每追加一批就重新问一次"哨兵还在里面吗"。
 */
import { act } from 'react-dom/test-utils'
import { createElement, useCallback, useRef, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLazySentinel } from './hooks.tsx'

/** 假 IntersectionObserver：只记录回调，不自己报第二遍（真实浏览器在元素没离开视口时也正是这样）。 */
class FakeIO {
  static instances: FakeIO[] = []
  cb: (entries: Array<{ isIntersecting: boolean }>) => void
  observed: Element[] = []
  /** 0 表示已经报过一次"在里面"，此后不再主动报 —— 这就是停滞的前提。 */
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.cb = cb
    FakeIO.instances.push(this)
  }

  observe(el: Element): void {
    this.observed.push(el)
    this.cb([{ isIntersecting: true }])
  }

  /** 手动喂一条状态（用来模拟"滚出视口"）。 */
  emit(isIntersecting: boolean): void { this.cb([{ isIntersecting }]) }

  disconnect(): void { this.observed = [] }
  unobserve(): void { /* 本判据用不到 */ }
  takeRecords(): [] { return [] }
}

function Probe({ onVisible, loaded }: { onVisible: () => void; loaded: number }): ReactElement {
  const refFn = useLazySentinel(onVisible, '0px', undefined, loaded)
  // 本文件的 include glob 只收 （不含 tsx），所以这里不写 JSX，用 createElement 拼。
  return createElement('div', { 'data-probe': '1', ref: refFn })
}

let host: HTMLDivElement
let root: Root
const onVisible = vi.fn((): void => {})

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  FakeIO.instances = []
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO
  onVisible.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
})

const show = (loaded: number): void => {
  act(() => { root.render(createElement(Probe, { onVisible, loaded })) })
}

describe('useLazySentinel 的补查', () => {
  it('挂载即回调一次（IO 首报）', () => {
    show(30)
    expect(onVisible).toHaveBeenCalledTimes(1)
  })

  it('哨兵没离开过视口时，数据每追加一批还要再问一次 —— 否则翻页就停在当前页', () => {
    show(30)
    show(60)
    show(90)
    expect(onVisible.mock.calls.length, '停在第 1 页就是这个形状（实测附件面板卡在第 2 页）').toBeGreaterThanOrEqual(3)
  })

  it('哨兵不在视口里时，数据变了也不许补查（那就成了每次翻页都白敲一次）', () => {
    show(30)
    const first = FakeIO.instances[0]
    expect(first ?? null, '前提：观察器建起来了').not.toBeNull()
    first?.emit(false)
    const before = onVisible.mock.calls.length
    show(60)
    show(90)
    expect(onVisible.mock.calls.length, '已经滚出视口了还补查 ⇒ 会把不该发的请求发出去').toBe(before)
  })

  it('反例自证：把补查那一句去掉（回到修好之前的形状），同样的输入只回调一次', () => {
    // 这一格证明上面那条 `>= 3` 不是"用例自己喂自己"：`BrokenProbe` 就是旧实现的形状 ——
    // 只在 IO 回调里 call、ref 回调稳定（不重新 observe），所以完全不看数据有没有追加。
    // 同一份"挂载 + 两次追加"的驱动下它只有 1 次（真窗口里就表现为翻页停在第 2 页）。
    const broken: number[] = []
    function BrokenProbe({ loaded }: { loaded: number }): ReactElement {
      // 与真 hook 一样：最新值放 ref（回调不重建），观察器只在挂载时建一次。
      const latest = useRef(loaded)
      latest.current = loaded
      const attach = useCallback((el: HTMLDivElement | null): void => {
        if (!el) return
        const ob = new FakeIO((entries) => { if (entries[0]?.isIntersecting) broken.push(latest.current) })
        ob.observe(el)
      }, [])
      return createElement('div', { 'data-broken': '1', ref: attach })
    }
    const host2 = document.createElement('div')
    document.body.append(host2)
    const root2 = createRoot(host2)
    try {
      act(() => { root2.render(createElement(BrokenProbe, { loaded: 30 })) })
      act(() => { root2.render(createElement(BrokenProbe, { loaded: 60 })) })
      act(() => { root2.render(createElement(BrokenProbe, { loaded: 90 })) })
    } finally {
      act(() => { root2.unmount() })
      host2.remove()
    }
    // 旧实现：第一次挂载 call 一次；两次"追加"没有新的状态变化 ⇒ 再没有第二次。
    expect(broken, '这份退化实现居然也会多次回调 ⇒ 假 IO 不像浏览器，上面的对照无效').toEqual([30])
    // 正实现（同一份驱动）：至少三次。
    show(30)
    show(60)
    show(90)
    expect(onVisible.mock.calls.length).toBeGreaterThan(broken.length)
  })
})
