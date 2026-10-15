import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appendMessages, makeFixture, trackScratch } from './search-spec-fixtures.ts'
import { closeAllTrackedDbs } from '../../tests/helpers/temp-db.ts'
import { DatabaseSync } from 'node:sqlite'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexFreshness, getSearchIndexStatus, REFRESHED_KEY, searchIndexPath } from '../src/query/search.ts'

trackScratch('index-fresh')

/**
 * W2-6.4：索引保鲜探测 + 超阈值后台重建 + 界面提示。
 *
 * 这一条的分流是**量出来的**（`index-freshness.measure.spec.ts`）：
 * 增量同步最坏 25.6ms（该等），全量构建 5.4s（不能等）。所以判据要钉住三件事：
 *   ① 落后 ⇒ **仍然同步等**（不等就是拿旧索引作答 = 当初那个 bug）；
 *   ② 不可用（索引缺失/版本不符）⇒ 后台开跑并回一句话，**不在这一问里等**；
 *   ③ 那句话必须一路走到界面上，不能只停在后端日志里。
 */

/**
 * 制造「索引落后于分片」的形状：**把索引的 `refreshed_ms` 往回拨一分钟**。
 *
 * 为什么不用「把分片 mtime 推到未来」：那样同步完之后 `refreshed_ms` 仍然是「现在」，
 * 而分片还在未来 ⇒ 判据永远说落后，下面那条断言会变成永远红的假失败。
 * 往回拨的语义也更贴近现实：「索引是一分钟前刷的，之后微信又写了」。
 * @param decrypted - 数据根。
 */
function makeStale(decrypted: string): void {
  const db = new DatabaseSync(searchIndexPath(decrypted))
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(Date.now() - 60_000), REFRESHED_KEY)
  db.close()
}

describe('W2-6.4 落后于分片：同步等，不进后台', () => {
  it('索引落后 ⇒ 这一问**等**增量同步完（等 = 回答基于最新数据）', async () => {
    const decrypted = makeFixture(400, 0)
    await buildSearchIndex(decrypted, false)
    appendMessages(decrypted, 401, 430)
    makeStale(decrypted)
    expect(getSearchIndexFreshness(decrypted).stale, '夹具没造出「落后」形状').toBe(true)

    const ensured = await ensureSearchIndex(decrypted, { background: true })
    expect(ensured.action, '落后时必须走同步，不能是后台').toBe('sync')
    expect(ensured.added).toBe(30)
    expect(ensured.staleShards, '同步结果要带回落后的分片数，便于界面解释').toBeGreaterThanOrEqual(1)
    expect(getSearchIndexFreshness(decrypted).stale, '同步完就不该还判成落后').toBe(false)
    closeAllTrackedDbs()
  })

  it('没落后 ⇒ 什么都不做（不白付一次探测之后还要开事务）', async () => {
    const decrypted = makeFixture(50, 0)
    await buildSearchIndex(decrypted, false)
    const ensured = await ensureSearchIndex(decrypted, { background: true })
    expect(ensured.action).toBe('none')
    expect(ensured.elapsed_ms).toBe(0)
    closeAllTrackedDbs()
  })

  it('background:false 时仍然同步构建（老调用点行为不变）', async () => {
    const decrypted = makeFixture(30, 0)
    const ensured = await ensureSearchIndex(decrypted)
    expect(ensured.action).toBe('build')
    expect(ensured.rows).toBe(30)
    closeAllTrackedDbs()
  })
})

describe('W2-6.4 索引不可用：后台开跑 + 界面提示', () => {
  it('索引缺失 + background ⇒ 立刻返回 deferred，**不等**构建', async () => {
    const decrypted = makeFixture(4000, 0)
    const t0 = Date.now()
    const ensured = await ensureSearchIndex(decrypted, { background: true })
    const spent = Date.now() - t0
    expect(ensured.action).toBe('deferred')
    expect(ensured.message, 'deferred 必须带一句给界面的话').toBeTruthy()
    expect(ensured.message).toContain('后台')
    // 4000 条的构建远不止这点时间；这条断言钉的是「不等」，不是「快」。
    expect(spent, '这一问不该等构建跑完').toBeLessThan(4000)
    // 后台那一轮最终要真的把索引建起来（单飞闸让这一次调用直接复用同一个 promise）。
    const built = await buildSearchIndex(decrypted, false)
    expect(built.rows, '后台那一轮没把索引建出来').toBeGreaterThan(0)
    expect(getSearchIndexStatus(decrypted).ready, '后台建完之后索引应当就绪').toBe(true)
    closeAllTrackedDbs()
  })

  it('deferred 的提示说清「这一轮用的是旧索引」（不然用户以为答错了）', async () => {
    const decrypted = makeFixture(10, 0)
    const ensured = await ensureSearchIndex(decrypted, { background: true })
    expect(ensured.message).toContain('这一轮')
    closeAllTrackedDbs()
  })
})

describe('W2-6.4 提示一路走到界面', () => {
  const ask = readFileSync(new URL('../src/remotes/askdeep.ts', import.meta.url), 'utf8')
  const type = readFileSync(new URL('../src/types-ask-export.ts', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../../../client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx', import.meta.url), 'utf8')

  it('AskResult.retrieval 上有 indexNote 字段（不是塞进 channels[].note）', () => {
    expect(type).toContain('indexNote?: string')
  })

  it('后端把它填进两处结果组装（有召回的与「没检索到」的）', () => {
    expect(ask).toContain("...(indexNote === '' ? {} : { indexNote }),")
    expect((ask.match(/\.\.\.\(indexNote === '' \? \{\} : \{ indexNote \}\)/g) ?? []).length,
      '两条返回路径都要带：只在一处带就意味着另一种情况下用户看不到提示').toBe(2)
  })

  it('提问路径确实按后台模式调用（老调用点不传 options 的行为不变）', () => {
    expect(ask).toContain('ensureSearchIndex(rc.dirs().decrypted, { background: true })')
  })

  it('界面用告警色调渲染它，且文案是「索引更新中」而不是某个通道坏了', () => {
    expect(panel).toContain('retrieval.indexNote')
    expect(panel).toContain('索引更新中')
  })
})