/**
 * W2-5.6 观测基线 · 朋友圈视频封面解析：逐条 vs 批量（合成数据）。**不是回归用例**，靠 `MEASURE_SNS_COVER=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 5.6 说「视频封面批版并入图片批处理通道」。动手之前得先数清楚**省在哪一段**，
 * 因为候选成本有三处，各自有完全不同的量级：
 *   ① `snsMonthRoots` 每次调用都要重列一遍 `cache/` 并 stat 每个月份目录；
 *   ② `scanMonth` 会对该月**每个文件**算 md5（这是最贵的一段，但已有 `snsVideoIndex` 按月缓存）；
 *   ③ IPC 往返（前端一次一条）。
 *
 * 合成数据刻意做成「一屏 K 条视频封面分散在 M 个月里」—— 那正是最坏也最常见的情形：
 * 逐条解析时每条都要自己走一遍 ①，而 ② 靠按月缓存摊掉。
 * 于是这个基准会告诉我们：批量化到底该去优化 ①，还是该去砍 ③（或者两条都砍）。
 *
 * 运行：
 *   MEASURE_SNS_COVER=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/sns-cover-batch.measure.spec.ts
 *   月份数用 SNS_COVER_MONTHS 覆盖（默认 12），每月的文件数用 SNS_COVER_FILES 覆盖（默认 200）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSnsVideoCoverDataUrls, snsVideoIndexForTest } from '../src/query/sns-video.ts'
import { at } from '../../tests/helpers/strict-index.ts'

/**
 * 建一个合成 `cache/<月>/Sns/Video/<目录>/<序号>.mp4` + 同名 `.jpg` 树。
 *
 * 两个细节不是随手写的：
 *   · 文件名用序号而不是 md5 —— `findByContentMd5` 算的是**文件内容**的 md5，真实布局下文件名是随机 id；
 *   · 必须同时写一张同名 `.jpg`。封面解析拿到 `.mp4` 之后会去找同名图片（`sibling`），
 *     找不到就报「找到视频但缺少同名封面」—— 只写 mp4 的话夹具一条都命中不了。
 * @returns 每个月的代表 md5（取该月第 3 个视频的内容 md5，供查询样本用）。
 */
function makeSnsCache(base: string, months: number, filesPerMonth: number): string[][] {
  const out: string[][] = []
  for (let m = 0; m < months; m += 1) {
    const monthDir = join(base, 'cache', `2026-${String(m + 1).padStart(2, '0')}`, 'Sns', 'Video')
    const sub = join(monthDir, 'd0')
    mkdirSync(sub, { recursive: true })
    const md5s: string[] = []
    for (let i = 0; i < filesPerMonth; i += 1) {
      const content = `v-${String(m)}-${String(i)}`
      const md5 = createHash('md5').update(content).digest('hex')
      const stem = `${String(i).padStart(4, '0')}`
      writeFileSync(join(sub, `${stem}.mp4`), content)
      writeFileSync(join(sub, `${stem}.jpg`), 'jpeg:' + content)
      md5s.push(md5)
    }
    out.push(md5s)
  }
  return out
}

describe.skipIf(process.env.MEASURE_SNS_COVER !== '1')('W2：朋友圈视频封面 逐条 vs 批量（合成数据）', () => {
  it('命中样本与未命中样本分开量（两种形状的账差得很远）', { timeout: 180_000 }, () => {
    const MONTHS = Math.max(1, Number(process.env.SNS_COVER_MONTHS ?? '12'))
    const FILES = Math.max(1, Number(process.env.SNS_COVER_FILES ?? '200'))
    const base = mkdtempSync(join(tmpdir(), 'wx-snscover-'))
    /** 跑一个场景：清缓存 → 逐条 → 清缓存 → 批量 → 打印 A/B。 */
    const run = (label: string, sample: readonly string[]) => {
      snsVideoIndexForTest().clear()
      const tA = Number(process.hrtime.bigint()) / 1e6
      let hitsA = 0
      for (const md5 of sample) if (resolveSnsVideoCoverDataUrls(base, [md5]).get(md5)?.url) hitsA += 1
      const msA = Number(process.hrtime.bigint()) / 1e6 - tA

      snsVideoIndexForTest().clear()
      const tB = Number(process.hrtime.bigint()) / 1e6
      let hitsB = 0
      const got = resolveSnsVideoCoverDataUrls(base, sample)
      for (const r of got.values()) if (r.url) hitsB += 1
      const msB = Number(process.hrtime.bigint()) / 1e6 - tB

      expect(hitsA, `${label}：批量与逐条必须命中同样多条（不等就说明批量改变了判定语义）`).toBe(hitsB)
      console.log([
        `  ${label}`,
        `    A 逐条 ${msA.toFixed(1)}ms ⇒ ${(msA / Math.max(sample.length, 1)).toFixed(2)}ms/条（命中 ${String(hitsA)}）`,
        `    B 批量 ${msB.toFixed(1)}ms ⇒ ${(msB / Math.max(sample.length, 1)).toFixed(2)}ms/条`,
        `    A/B  ${(msA / Math.max(msB, 0.001)).toFixed(1)}×`,
      ].join('\n'))
    }
    try {
      const byMonth = makeSnsCache(base, MONTHS, FILES)
      // 命中样本：一屏 K 条，分散在不同月份（每月取第 3 个视频）。
      const hits = byMonth.map((m) => at(m, 2, '样本 md5') ?? '')
      expect(hits.length, '样本一条都不能少（空 md5 会让两次调用的工作量不对等）').toBe(MONTHS)
      // 未命中样本：K 个**互不相同**且本机确实没有的内容 md5 —— 刷朋友圈时最常见的那一类
      // （点开一条没转发过的视频）。刻意不去重：重复的未命中会被 misses 缓存挡住，
      // 那条路径本来就便宜，量它等于量一个不存在的问题。
      const misses = hits.map((_, i) => createHash('md5').update(`absent-${String(i)}`).digest('hex'))

      console.log(['', `[SNS-COVER] ${String(MONTHS)} 个月 × ${String(FILES)} 个视频 / 样本 ${String(hits.length)} 条`].join('\n'))
      run('① 命中（本机缓存里有）', hits)
      run('② 未命中（本机没有，要去 CDN）', misses)
      console.log('')
    } finally {
      snsVideoIndexForTest().clear()
      rmSync(base, { recursive: true, force: true })
    }
  })
})