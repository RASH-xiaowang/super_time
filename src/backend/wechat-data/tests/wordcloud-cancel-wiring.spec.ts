// @vitest-environment node
/**
 * W2-9.4 的接线判据 —— **补行为判据的盲区**。
 *
 * ## 为什么还需要这一层
 *
 * `wordcloud-cancel.spec.ts` 是行为判据（真的造大语料、真的并发两次），它能钉住
 * 「取消会发生」「半成品不进缓存」。但它**钉不住下面三件事**，实测三个变异都还能全绿：
 *
 *   ① 只保留**让出边界**那一处检查、去掉分片边界检查 ⇒ 行为判据照样绿
 *      （只要行数够多，让出点一样会触发）。而这两种形状的扫描体量差别很大：
 *      一张十万行但从不让出的会话表，缺了分片边界就永远停不下来。
 *   ② 去掉 `cachedBySigAsync` 的 `shouldCache` ⇒ 行为判据里的「半成品」
 *      恰好是「0 行」那份，等于一份空缓存，看不出差别。
 *   ③ 取消不按 scope 分桶 ⇒ 行为判据里那次会话词云**先跑完**了才轮到全库，看不出差别。
 *
 * 所以这三条只能按**接线**钉。它们都是「一处都不能少」的结构性纪律，
 * 写出来之后三个变异全部转红（见台账里的变异记录）。
 * @module wordcloud-cancel-wiring
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src/query/wordcloud.ts', import.meta.url))
const META = fileURLToPath(new URL('../src/query/meta.ts', import.meta.url))
const src = readFileSync(SRC, 'utf8')
const meta = readFileSync(META, 'utf8')

/** `scanMessages` 函数体（按行取，避免把 `scanMoments` 那份算进来）。 */
function bodyOf(name: string): string {
  const i = src.indexOf('async function ' + name)
  expect(i, '找不到 ' + name).toBeGreaterThan(-1)
  return src.slice(i, src.indexOf('\n}', i))
}

describe('W2-9.4 两个取消检查点都得在', () => {
  it('scanMessages：分片边界 + 让出边界', () => {
    const body = bodyOf('scanMessages')
    const checks = body.match(/if \(isCancelled\(\)\) return \{ scanned, canceled: true \}/g) ?? []
    expect(checks.length, '分片边界与让出边界两处检查，少一处就有停不下来的形状').toBe(2)
    expect(body, '分片边界检查必须排在打开分片之前').toMatch(/if \(isCancelled\(\)\)[^\n]*\n\s*const path = join\(msgDir, file\)/)
    expect(body, '让出点之后才检查（让出前检查等于没检查）').toMatch(/await yieldToLoop\(\)(?:\s*\/\/[^\n]*|\s*\n)*\s*if \(isCancelled\(\)\)/)
  })

  it('scanMoments：候选库边界 + 让出边界', () => {
    const body = bodyOf('scanMoments')
    expect(body, '朋友圈那条路也是「一大坨内容扫很久」，同样要有两处检查').toContain('if (isCancelled()) return { scanned, canceled: true }')
    expect(body.match(/isCancelled\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('取消**不抛错**：返回已算完的部分 + canceled 标记', () => {
    expect(src).toContain('scanned = r.scanned')
    expect(src).toContain('canceled = r.canceled')
    expect(src).toContain('return { words, scanned, canceled }')
    // 反脆性：取消路径上不许出现 throw
    const body = bodyOf('computeWordCloud')
    expect(body, '取消改成抛错 ⇒ 用户自己切年份却看到红色报错').not.toMatch(/throw/)
  })
})

describe('W2-9.4 半成品不许进缓存', () => {
  it('cachedBySigAsync 提供 shouldCache 闸门', () => {
    expect(meta).toContain('shouldCache: (value: T) => boolean = () => true')
    expect(meta, '闸门没接进写回 ⇒ 参数只是个摆设').toMatch(/inFlight\.get\(flightKey\) === rec && shouldCache\(value\)/)
  })

  it('词云这条真的用了它，且判据是「有没有被取消」', () => {
    expect(src).toContain('(v) => v.canceled !== true,')
    expect(src).toMatch(/\(\) => computeWordCloud\(decryptedDir, scope, username, year, isCancelled\)/)
  })
})

describe('W2-9.4 票号按 scope 分桶', () => {
  it('票号表是**模块级**的（放在函数里就成了每次调用一张新表，机制等于没接）', () => {
    const q = src.indexOf('export async function queryWordCloud')
    expect(src.indexOf('const WORDCLOUD_TICKETS = new Map<string, number>()'), '票号表必须先于 queryWordCloud 出现').toBeLessThan(q)
    const fnBody = src.slice(q)
    expect(fnBody, '票号表/计数器声明漏进了函数体 ⇒ 每次调用都是一张新表').not.toContain('const WORDCLOUD_TICKETS = new Map')
    expect(fnBody).not.toContain('let wordcloudTicketSeq = 0')
  })

  it('set 与 get 用的是同一个键（scope），不是全局一张', () => {
    expect(src).toContain('WORDCLOUD_TICKETS.set(scope, ticket)')
    expect(src).toContain('WORDCLOUD_TICKETS.get(scope)')
  })
})