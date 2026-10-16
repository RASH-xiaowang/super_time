// @vitest-environment node
/**
 * W3-6.6：知识库实体抽取的**有界并发**与**逐文件不连坐**。
 *
 * ## 两条口径各自的来历
 *
 * ① **有界并发**：改前是 `for (const f of batch) await extractFileEntities(...)`,
 *    一批 20 个文件就是 20 次串行 LLM 往返 —— 用户点一下「抽取实体」要等很久，
 *    而这期间后端还被它占着。
 * ② **逐文件不连坐**：`extractFileEntities` 第一句 `new DatabaseSync(kbFilesDbPath(...))`
 *    在 try **之外**。库被占用/损坏时它直接抛，异常跟着 for 循环一起退出：
 *    剩下的文件一个都不跑，RPC 直接 reject，调用方**连失败汇总都拿不到**。
 *    这一条比并发更要紧 —— 它是「一个坏文件废掉整批」。
 *
 * 判据全部源码级（`runKbExtractBatch` / `kbExtractOne` 的存在与形状）：
 * 真实抽取要 LLM + 真实库，合成数据给不出有意义的实体，而并发形状本身
 * 就是「对不对」的全部。反向哨兵确保判据不是恒真（抹掉 try 必须转红）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(p, 'utf8')
const KB = 'src/backend/wechat-data/src/remotes/kb.ts'
const SCHED = 'src/backend/wechat-data/src/gateway-scheduler.ts'

describe('W3-6.6：实体抽取的有界并发 + 不连坐', () => {
  it('并发上界常量存在，且与调度器那一族同量级（LLM 往返，不等于下载并发）', () => {
    const kb = read(KB)
    expect(kb, 'KB.ts 里没有 KB_EXTRACT_CONCURRENCY').toMatch(/export const KB_EXTRACT_CONCURRENCY = 3/)
    const kbN = Number(/export const KB_EXTRACT_CONCURRENCY = (\d+)/.exec(kb)?.[1] ?? '0')
    expect(kbN, '并发数不是正数').toBeGreaterThan(1)
    expect(kbN, 'LLM 请求的并发上界过大 ⇒ 会把厂商速率限制撞崩，反而更慢').toBeLessThanOrEqual(8)
    // 与仓库既有范例同量级（DUE_SUMMARY_CONCURRENCY = 2）。
    const sch = read(SCHED)
    const ref = Number(/export const DUE_SUMMARY_CONCURRENCY = (\d+)/.exec(sch)?.[1] ?? '0')
    expect(ref, '参照常量读不出来（被改名/搬走了？）').toBeGreaterThan(0)
    expect(kbN, '与既有范例量级差太远 ⇒ 要么没并发、要么放得太开').toBeLessThanOrEqual(ref * 4)
  })

  it('认领方式是「共享 next 下标」而不是切片（切片的最后一片会只剩一个 worker）', () => {
    const kb = read(KB)
    expect(kb, '没有共享 next 计数 ⇒ 仍是固定切片并发').toMatch(/let next = 0/)
    expect(kb, 'worker 里没有自增认领').toMatch(/const i = next\s*\r?\n\s*next \+= 1/)
    expect(kb, 'Promise.all 的 worker 数没按并发上限算').toMatch(/Math\.min\(o\.concurrency, o\.batch\.length\)/)
  })

  it('单文件失败必须被 try 接住（否则一个坏文件废掉整批）', () => {
    const kb = read(KB)
    const one = kb.indexOf('async function kbExtractOne(')
    expect(one, '没有 kbExtractOne ⇒ 抽取逻辑又回到工厂里（也回回了连坐形状）').toBeGreaterThan(-1)
    const body = kb.slice(one, kb.indexOf('async function runKbExtractBatch('))
    expect(body, 'kbExtractOne 没有 try ⇒ 开库抛异常会穿出循环').toMatch(/try \{/)
    expect(body, '失败没有回报给调用方 ⇒ 面板拿不到失败汇总').toMatch(/sink\.onFailed\(/)
    // 正向哨兵：成功的条数也要回报（否则 saved 永远是 0）。
    expect(body).toMatch(/sink\.onSaved\(/)
  })

  it('循环里不再有裸 await extractFileEntities（它必须在 kbExtractOne 里被包住）', () => {
    const kb = read(KB)
    const calls = kb.match(/await extractFileEntities\(/g) ?? []
    expect(calls.length, 'extractFileEntities 的调用点只剩 kbExtractOne 里那一处').toBe(1)
  })
})