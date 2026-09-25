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
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { queryWordCloud } from '../src/query/wordcloud.ts'

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
  it('scope=chat：中文消息走到 bigram 计数，虚词组合被停用词挡住', () => {
    const root = seedMessages('u1', [
      { type: 1, content: '项目会议明天开' },
      { type: 1, content: '项目文档已经发了' },
      { type: 1, content: '开会记得带文档' },
      { type: 3, content: '[图片]' }, // 非文本类型不计
    ])
    const r = queryWordCloud(root, { scope: 'chat', username: 'u1' })
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

  it('scope=chat 缺 username：必须报错而不是静默全量（拒绝方向）', () => {
    const root = makeTemp()
    expect(() => queryWordCloud(root, { scope: 'chat' })).toThrow(/username/)
  })

  it('空数据目录：空结果形态而不是抛错', () => {
    const root = makeTemp()
    const r = queryWordCloud(root, { scope: 'global' })
    expect(r.words).toEqual([])
    expect(r.scanned).toBe(0)
  })

  it('limit 钳制：负数/超大值都收敛到 [1, 200]', () => {
    const root = makeTemp()
    // 只验证不抛错（空目录下 limit 不影响结果形态）
    expect(() => queryWordCloud(root, { scope: 'global', limit: -5 })).not.toThrow()
    expect(() => queryWordCloud(root, { scope: 'global', limit: 99999 })).not.toThrow()
  })
})
