/**
 * 词云词频统计（query/wordcloud.ts）的回归用例（界面优化阶段 4）。
 *
 * 覆盖：① 真实管道——临时 message db 里的中文消息走到 bigram 计数与停用过滤；
 * ② 入参校验（scope=chat 缺 username 必须报错，方向是「拒绝」而非静默全量）；
 * ③ 空数据目录的空结果形态。
 * 实体保护（contactMeta 昵称整词计数）依赖联系人库结构，属真实库行为，
 * 首版不做合成夹具——它的回归由「停用词把跨词噪音挡住」这条间接保底。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { queryWordCloud } from '../src/query/wordcloud.ts'
import { invalidateWechatMeta } from '../src/query/meta.ts'

let temp: string | null = null

function makeTemp(): string {
  temp ??= mkdtempSync(join(tmpdir(), 'wordcloud-spec-'))
  return temp
}

afterEach(() => {
  if (temp) { rmSync(temp, { recursive: true, force: true }); temp = null }
})

/** 造一个最小 message 分片：表名 Msg_<md5(username)>，插入给定的 (type, content) 行。 */
function seedMessages(username: string, rows: Array<{ type: number; content: string; ts?: number }>): string {
  const root = makeTemp()
  const msgDir = join(root, 'message')
  mkdirSync(msgDir, { recursive: true })
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  const db = new DatabaseSync(join(msgDir, 'shard0.db'))
  db.exec(`CREATE TABLE "${table}" (create_time INTEGER, local_type INTEGER, message_content TEXT)`)
  const ins = db.prepare(`INSERT INTO "${table}" (create_time, local_type, message_content) VALUES (?, ?, ?)`)
  for (const r of rows) ins.run(r.ts ?? 1_700_000_000, r.type, r.content)
  db.close()
  return root
}

describe('queryWordCloud', () => {
  it('scope=chat：中文消息走到 bigram 计数，虚词组合被停用词挡住', async () => {
    const root = seedMessages('u1', [
      { type: 1, content: '项目会议明天开' },
      { type: 1, content: '项目文档已经发了' },
      { type: 1, content: '开会记得带文档' },
      { type: 3, content: '[图片]' }, // 非文本类型不计
    ])
    const r = await queryWordCloud(root, { scope: 'chat', username: 'u1' })
    expect(r.scanned).toBe(3) // 只统计 local_type=1
    const map = new Map(r.words.map(w => [w.text, w.count]))
    expect(map.get('项目')).toBe(2)
    expect(map.get('文档')).toBe(2)
    // 「明天」「已经」这类时间/虚词组合不出榜（单字虚词或显式停用词挡住）
    expect(map.has('明天')).toBe(false)
    expect(map.has('已经')).toBe(false)
    // 出现 1 次的词不进词云（统计意义门槛）
    expect(map.has('记得')).toBe(false)
  })

  it('scope=chat 缺 username：必须报错而不是静默全量（拒绝方向）', async () => {
    const root = makeTemp()
    await expect(queryWordCloud(root, { scope: 'chat' })).rejects.toThrow(/username/)
  })

  it('空数据目录：空结果形态而不是抛错', async () => {
    const root = makeTemp()
    const r = await queryWordCloud(root, { scope: 'global' })
    expect(r.words).toEqual([])
    expect(r.scanned).toBe(0)
  })

  it('limit 钳制：负数/超大值都收敛到 [1, 400]', async () => {
    const root = makeTemp()
    // 上限 2026-09-30 由 200 提到 400（全屏画布要 ~243 个词才填得满）。
    // 只验证不抛错（空目录下 limit 不影响结果形态）
    await expect(queryWordCloud(root, { scope: 'global', limit: -5 })).resolves.toBeDefined()
    await expect(queryWordCloud(root, { scope: 'global', limit: 99999 })).resolves.toBeDefined()
  })

  /**
   * 分片级增量缓存（2026-09-29）最危险的失效模式：**把陈旧结果端出来**。
   *
   * 背景：`scanMessages` 现在按分片签名（`fileSigOf` = **mtime + size**）缓存词频，
   * 签名没变就整段跳过（真机实测 `working/probe-wordcloud-incremental.ts`：只动一个分片时
   * 重算 999ms → 332ms，省 67%）。省时间的前提是"签名变了就必须重扫" —— 这条用例就是那个前提的守卫。
   *
   * ⚠️ **插入一行后必须显式推 mtime**（2026-09-29 用探针查清）：
   * SQLite 文件是页对齐的，插一条小消息**既不改文件大小**（都是 8192）**也可能不改 mtime**
   * （写入落在 WAL / 同一毫秒内）—— 那时签名**本来就没变**，缓存按设计返回上一次的结果，
   * 这不是"陈旧 bug"，而是"签名口径看不见这次写入"。守卫要守的是
   * **"签名变了 ⇒ 结果必须跟着变"**，所以这里把 mtime 推一下，让前提成立。
   * （签名口径本身的粗细是全仓缓存层共有的、早于本改动的设计；真机上微信写入量级大，
   *   size/mtime 都会变。）
   */
  it('增量缓存：分片签名变了，结果必须跟着变（不许端出陈旧词频）', async () => {
    const root = seedMessages('u-incr', [
      { type: 1, content: '苹果 苹果 香蕉' },
    ])
    const before = new Map((await queryWordCloud(root, { scope: 'global' })).words.map(w => [w.text, w.count]))
    expect(before.get('橘子'), '第一遍不该有「橘子」').toBeUndefined()

    // 往同一个分片里追加一条新消息（出现 3 次的「橘子」必须上榜首）
    const shard = join(root, 'message', 'shard0.db')
    const db = new DatabaseSync(shard)
    const table = 'Msg_' + createHash('md5').update('u-incr', 'utf8').digest('hex')
    const ins = db.prepare(`INSERT INTO "${table}" (create_time, local_type, message_content) VALUES (?, ?, ?)`)
    ins.run(1_700_000_100, 1, '橘子 橘子 橘子')
    db.close()
    // 让签名确实变化（见上面 ⚠️：页对齐文件 + 同毫秒写入时，插入本身可能既不改 size 也不改 mtime）
    const later = new Date(Date.now() + 3000)
    utimesSync(shard, later, later)
    invalidateWechatMeta()

    const after = new Map((await queryWordCloud(root, { scope: 'global' })).words.map(w => [w.text, w.count]))
    expect(after.get('橘子'), '签名变了就必须重扫：新写入的内容必须在结果里').toBe(3)
  })
})
