/**
 * W2-9.4：大语料词云的**分词扫描可取消**。
 *
 * ## 为什么这条值得单独立判据
 *
 * 词云冷算一次要扫全库（源码里记着「global 一次 15.3 秒，优化后 ~2 秒，实测最大单点 1921ms」）。
 * 用户拖年份滑块 / 快速切会话时，新请求会连着发好几次 —— 旧的那几次**烧到结束为止**，
 * 期间还占着 CPU 与一次全表扫的 I/O。界面上早就把结果丢了（`alive` 标志），
 * 只有后端还在干活。本机合成 32 万行实测：一次全库扫描约 **53ms**，所以这不是「理论浪费」。
 *
 * ## 口径（三条，与本仓其它取消通道一致）
 *
 * ① **取消不抛错**：返回已经算完的那一部分 + `canceled: true`。
 *    用户是自己切换了年份/会话，不该看到一句红色报错。
 * ② **只在两个边界检查**：分片边界 与 让出边界。为什么不是每行都查 ——
 *    那是一次闭包调用，摊到每一行上并不便宜（单表实测十万量级行）。
 * ③ **半成品不写缓存**（`cachedBySigAsync` 的 `shouldCache`）：写进去就是
 *    30 秒内一直返回那份扫了一半的词表，而界面上没有任何东西说「这是半的」。
 *
 * ## 第四件事：后来者作废前一个，但要**按 scope 分桶**
 *
 * 总览页的全库热词常与会话/朋友圈的小词云同屏出现。让小的取消大的，
 * 会让大的永远算不完 —— 所以只有**同类里的后来者**才作废前一个。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryWordCloud } from '../src/query/wordcloud.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 正文的时间戳落在 **2024 年内**。
 *
 * ⚠ 踩过的坑：夹具一开始用 `1700000000`（2023-11），于是按年筛选的 SQL
 * （`create_time >= 2024-01-01 AND < 2025-01-01`）一行都取不到，`scanned` 恒为 0 ——
 * 后面那些「扫了一半」的断言全都成了空断言，而测试报的是「没被取消」，方向完全错。
 */
const TS_START = Math.floor(new Date(2023, 0, 1).getTime() / 1000)
const TS_SPAN = Math.floor(new Date(2026, 0, 1).getTime() / 1000) - TS_START

/** 造一个「大到值得取消」的消息分片群：N 个分片 × M 行正文。 */
function seedShards(decrypted: string, shards: number, rows: number): void {
  const msgDir = join(decrypted, 'message')
  mkdirSync(msgDir, { recursive: true })
  // ⚠ 不要用 `<![CDATA[…]]>`：stripXml 的 `<[^>]*>` 从 `<` 一路吃到第一个 `>`，
  //   那正好是 `]]>` 的尾巴，于是**整段正文被当成标签删掉**，text 变空串、扫出来 0 条。
  const text = '<msg><content>今天天气不错 周末去公园 天气很好 公园散步 周末愉快</content></msg>'
  for (let s = 0; s < shards; s += 1) {
    const table = 'Msg_t' + String(s)
    const db = new DatabaseSync(join(msgDir, 'msg_' + String(s).padStart(4, '0') + '.db'))
    db.exec('CREATE TABLE ' + table + ' (local_id INTEGER, local_type INTEGER, create_time INTEGER, message_content BLOB)')
    db.exec('BEGIN')
    const ins = db.prepare('INSERT INTO ' + table + ' (local_id, local_type, create_time, message_content) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < rows; i += 1) ins.run(i, 1, TS_START + Math.floor((i / rows) * TS_SPAN), Buffer.from(text, 'utf8'))
    db.exec('COMMIT')
    db.close()
  }
}

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-wc-cancel-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

describe('W2-9.4 夹具自检', () => {
  it('合成分片能被扫到（scanned / words 都非零），按年筛选也一样', { timeout: 180_000 }, async () => {
    const d = dataRoot()
    seedShards(d, 3, 500)
    const r = await queryWordCloud(d, { scope: 'global' })
    expect(r.scanned, '扫不到行 ⇒ 后面那些「扫了一半」的断言都是空的').toBeGreaterThan(0)
    expect(r.words.length, '正文里的词一个都没进词表 ⇒ 夹具形状不对').toBeGreaterThan(0)
    expect(r.canceled).toBeFalsy()

    const byYear = await queryWordCloud(d, { scope: 'global', year: 2024 })
    expect(byYear.scanned, '按年筛选一行都取不到 ⇒ 夹具的时间戳不在 2024 年内').toBeGreaterThan(0)
  })
})

describe('W2-9.4 后来者作废前一个（同 scope 内）', () => {
  it('后一次请求一到，前一次立刻在下一次分片边界停住，且不抛错', { timeout: 180_000 }, async () => {
    const d = dataRoot()
    seedShards(d, 60, 400)

    const full = await queryWordCloud(d, { scope: 'global', year: 2024 })
    expect(full.canceled, '正常跑完不该标成取消').toBeFalsy()
    expect(full.scanned).toBeGreaterThan(0)

    // 拖年份滑块的真实形状：2023 那次刚开跑，2025 那次就来了。
    // 两次**不加任何 await 地连着发** —— 这是唯一能让「作废」必然发生的掐点：
    // `queryWordCloud` 会一路同步走到 `computeWordCloud` 的第一个 `await yieldToLoop()`，
    // 所以第二次调用一定发生在第一次恢复扫描**之前**。
    const first = queryWordCloud(d, { scope: 'global', year: 2023 })
    const secondP = queryWordCloud(d, { scope: 'global', year: 2025 })
    const a = await first
    const second = await secondP

    expect(second.canceled, '后一次没被作废（它才是最新的）').toBeFalsy()
    expect(a.canceled, '前一次没被作废 ⇒ 白烧到结束').toBe(true)
    expect(a.scanned, '第一个分片边界就该停 ⇒ 还没扫到任何一行').toBe(0)
    expect(Array.isArray(a.words), '取消不抛错：仍要交回一个可用的结果形状').toBe(true)
  })

  it('不同 scope 不互相作废（小的不能把大的取消掉）', { timeout: 180_000 }, async () => {
    const d = dataRoot()
    seedShards(d, 40, 400)
    const chatP = queryWordCloud(d, { scope: 'chat', username: 'wxid_nobody' })
    const globalP = queryWordCloud(d, { scope: 'global', year: 2024 })
    const chat = await chatP
    const global = await globalP
    expect(global.canceled, '会话词云把全库词云取消了 ⇒ 全库会永远算不完').toBeFalsy()
    expect(global.scanned).toBeGreaterThan(0)
    expect(chat.scanned).toBeGreaterThanOrEqual(0)
  })
})

describe('W2-9.4 半成品不许进缓存', () => {
  it('被作废的那一次不会把半份词表留给下一次', { timeout: 180_000 }, async () => {
    const d = dataRoot()
    seedShards(d, 40, 400)

    const clean = await queryWordCloud(d, { scope: 'global', year: 2024 })
    expect(clean.canceled).toBeFalsy()
    expect(clean.scanned).toBeGreaterThan(0)

    const doomed = queryWordCloud(d, { scope: 'global', year: 2023 })
    void queryWordCloud(d, { scope: 'global', year: 2025 })
    expect((await doomed).canceled, '这次没被作废 ⇒ 用例前提不成立').toBe(true)

    // 关键：2023 那次只扫了 0 行就停了。若半成品进了缓存，
    // 下面这次拿到的就是那份空结果。
    const retry = await queryWordCloud(d, { scope: 'global', year: 2023 })
    expect(retry.scanned, '半份词表进了缓存 ⇒ 重试拿到的还是空的').toBeGreaterThan(0)
    expect(retry.canceled).toBeFalsy()
  })
})
