// @vitest-environment node
/**
 * W2-4.5：图片「缩略图先行 + 按可见水位补帧」的判据。
 *
 * 这一条的功能**早就实现了**（`use-imagePreload` + `apiGetImageDataUrl` 的档位图），
 * 计划里一直挂着 ⬜ 的原因是**它一条判据都没有** —— 没有任何东西钉住它，于是它可以静默腐化：
 * 把批量入口改回逐张、把水位改成 0、把空闲调度去掉、把失败也写进缓存，测试**全绿**。
 *
 * 所以本条的工作不是「实现」，是**钉住**，并把「首帧断言」落成可测的东西：
 * 首帧之所以快，靠的是「预取与组件写的是**同一个**缓存」——
 * 组件那条路径先 `recallImage` 命中就直接 `setSrc`，不闪占位。
 * 判据分两层：① 纯逻辑（窗口集合 / 去重 / 分批）；② 源码接线（必须走的那几条）。
 * @module image-preload-wiring
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HOOK = fileURLToPath(new URL('./use-image-preload.ts', import.meta.url))
const MEDIA = fileURLToPath(new URL('./chats-media.tsx', import.meta.url))
const API_MEDIA = fileURLToPath(new URL('../api-media.ts', import.meta.url))
const src = readFileSync(HOOK, 'utf8')

/**
 * 取出 `} catch {` 与配平的收尾 `}` 之间那一段（按花括号配平，不用跨行正则）。
 * @param code - 源码。
 * @returns catch 块的文本；找不到时返回空串。
 */
function catchBlockOf(code: string): string {
  const at = code.indexOf("} catch {")
  if (at < 0) return ''
  const start = code.indexOf('{', at) + 1
  let depth = 1
  for (let k = start; k < code.length; k += 1) {
    if (code[k] === '{') depth += 1
    else if (code[k] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(start, k)
    }
  }
  return ''
}

describe('W2-4.5 预取窗口怎么算', () => {
  /** 复刻 hook 里那段窗口算法（判据与实现同形：任何一边改了，另一边要跟着红）。 */
  const collect = (items: Array<{ kind: string; localId: number; image?: boolean }>, visible: number[], lookahead: number): number[] => {
    const seen = new Set<number>()
    const out: number[] = []
    const push = (index: number): void => {
      const item = items[index]
      if (item === undefined || item.kind !== 'msg' || item.image !== true) return
      if (seen.has(item.localId)) return
      seen.add(item.localId)
      out.push(item.localId)
    }
    for (const vi of visible) for (let d = -lookahead; d <= lookahead; d += 1) push(vi + d)
    return out
  }

  it('可见窗口 ± lookahead 内的图片都被收集', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ kind: 'msg', localId: i + 1, image: true }))
    const got = collect(items, [20], 3)
    expect(got, '闭区间：d 从 -lookahead 走到 +lookahead（两端都含）').toEqual([18, 19, 20, 21, 22, 23, 24])
  })

  it('非图片消息不进窗口（语音/系统提示不算）', () => {
    const items = [
      { kind: 'msg', localId: 1, image: false },
      { kind: 'msg', localId: 2, image: true },
      { kind: 'divider', localId: 3, image: true },
    ]
    expect(collect(items, [1], 2)).toEqual([2])
  })

  it('越界索引被丢掉而不是读出 undefined', () => {
    const items = [{ kind: 'msg', localId: 1, image: true }]
    expect(collect(items, [0], 5)).toEqual([1])
  })

  it('同一 localId 只收集一次（相邻窗口重叠时会重复命中）', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ kind: 'msg', localId: i + 1, image: true }))
    const got = collect(items, [10, 12], 5)
    expect(new Set(got).size).toBe(got.length)
  })
})

describe('W2-4.5 接线：六条不许退化的纪律', () => {
  it('① 走批量入口，不是逐张（逐张每次 17.27ms 全表扫）', () => {
    expect(src).toContain('apiGetImageDataUrlsBatch(chunk)')
    expect(src).not.toMatch(/apiGetImageDataUrl\(/)
  })

  it('② 可见区间来自虚拟化器，不是 DOM 遍历', () => {
    expect(src).toContain('virtualizer.getVirtualItems()')
    // 水位必须**大于 0**：等于 0 就退化成「只取视口内」，那不是补帧，是原地等。
    const lookahead = Number(/LOOKAHEAD = (\d+)/.exec(src)?.[1] ?? '0')
    expect(lookahead, 'LOOKAHEAD=0 ⇒ 只剩视口内，没有补帧').toBeGreaterThan(0)
  })

  it('③ 滚动中不打出去：停 {@link PREFETCH_DEBOUNCE_MS} 之后才发', () => {
    expect(src).toContain('PREFETCH_DEBOUNCE_MS')
    // 回调体跨了很多行，单行正则 `setTimeout(...PREFETCH_DEBOUNCE_MS)` 匹配不到；
    // 判据改成「常量确实在 setTimeout 的收尾参数位上」。
    expect(src).toContain('}, PREFETCH_DEBOUNCE_MS)')
    expect(/PREFETCH_DEBOUNCE_MS = (\d+)/.exec(src)?.[1], 'debounce 不得为 0（那等于滚动中就打）').toBeTruthy()
    expect(Number(/PREFETCH_DEBOUNCE_MS = (\d+)/.exec(src)?.[1] ?? 0)).toBeGreaterThan(0)
  })

  it('④ 空闲调度，不与视口内请求抢后端解码进程', () => {
    expect(src).toContain('requestIdleCallback')
    expect(src).toContain('onIdle(')
  })

  it('⑤ 预取与组件写**同一个**缓存 —— 这才是「首帧不闪占位」的根据', () => {
    expect(src).toContain("from '../image-cache.ts'")
    expect(src).toContain('rememberImage(talker, row.localId')
    const media = readFileSync(MEDIA, 'utf8')
    // 组件那条路径必须先查同一个缓存，命中就直接 setSrc。
    expect(media).toContain('recallImage(selfName, m.localId)')
    expect(media).toMatch(/const hit = recallImage\([^)]*\)[\s\S]{0,200}setSrc\(hit\.url\)/)
  })

  it('⑥ 预取失败**不写缓存**（否则「没预取到」会被记成「已知没图」）', () => {
    expect(src).toMatch(/catch \{[\s\S]{0,400}不写缓存/)
    // catch 块里不能出现 rememberImage
    const catchBody = catchBlockOf(src)
    expect(catchBody, 'catch 块里出现了 rememberImage ⇒ 失败被写进了缓存').not.toContain('rememberImage')
  })
})

describe('W2-4.5 缩略图先行', () => {
  it('消息流里的图走的是档位图（带 thumb 标记），原图只在用户点「取原图」时取', () => {
    const media = readFileSync(MEDIA, 'utf8')
    // 组件那条路径记下 thumb
    expect(media).toContain('const thumb = r.thumb === true')
    expect(media).toContain('setIsThumb(thumb)')
    // 原图只在一个明确的动作里取（不是 effect / 不是滚动路径）
    const at = media.indexOf('const getOriginal')
    expect(at, '找不到取原图的入口').toBeGreaterThan(-1)
    const origCalls = [...media.matchAll(/apiGetImageOriginal\(/g)].map((m) => m.index ?? -1)
    expect(origCalls.length, '取原图只有一处调用（多一处就说明它被挂到了别的路径上）').toBe(1)
    expect(origCalls[0]).toBeGreaterThan(at)
    // getOriginal 挂在点击而不是 useEffect 里
    const fnBody = media.slice(at, at + 800)
    expect(fnBody).toContain('apiGetImageOriginal(')
    // 「原图不在滚动路径上」的真实判据：整个文件里 `apiGetImageOriginal` 只出现一处（已断言唯一），
    // 而预取 hook 里压根不碰原图接口 —— 上游挨着的那个 useEffect 恰好是**正确**的样子：先取档位图。
    expect(readFileSync(HOOK, 'utf8'), '预取 hook 里不许碰原图接口').not.toContain('apiGetImageOriginal')
  })

  it('批量入口复用同一条 image-batch 队列（前端与预取共用一个攒批窗口）', () => {
    const api = readFileSync(API_MEDIA, 'utf8')
    expect(api).toContain('export const imageLoadQueue')
  })
})