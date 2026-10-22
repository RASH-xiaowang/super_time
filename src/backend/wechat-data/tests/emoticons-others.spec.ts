/**
 * 「其他表情包」必须返回扫描到的完整去重列表。
 *
 * 回归背景（2026-10-22）：后端统计出 1924 个其他表情，却把返回列表二次截断成
 * 前 500 个，界面同时显示「其他 1924」和「其他表情包 (500)」。这里用 620 个
 * 不同 md5 跨过旧的 500 条边界，确保总数与列表长度始终一致。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryEmoticons } from '../src/query/emoticons.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 造一份最小表情库与消息库。
 * @param count - 消息库里的表情 md5 数量（全部带 cdnurl，保证可展示）。
 * @returns 解密数据根。
 */
function fixture(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-emoticons-others-'))
  scratch.push(root)
  mkdirSync(join(root, 'emoticon'), { recursive: true })
  mkdirSync(join(root, 'message'), { recursive: true })

  const emoticon = new DatabaseSync(join(root, 'emoticon', 'emoticon.db'))
  try {
    emoticon.exec('CREATE TABLE kNonStoreEmoticonTable (md5 TEXT)')
  } finally {
    emoticon.close()
  }

  const message = new DatabaseSync(join(root, 'message', 'message_0.db'))
  try {
    message.exec('CREATE TABLE "Msg_regression" (local_type INTEGER, message_content TEXT)')
    const insert = message.prepare('INSERT INTO "Msg_regression" (local_type, message_content) VALUES (47, ?)')
    for (let i = 0; i < count; i += 1) {
      const md5 = createHash('md5').update(`other-${String(i)}`).digest('hex')
      insert.run(`<msg><emoji md5="${md5}" cdnurl="https://example.invalid/${md5}.png"/></msg>`)
    }
  } finally {
    message.close()
  }
  return root
}

describe('其他表情包完整返回', () => {
  it('超过 500 个时不再截断，othersTotal 与列表长度一致', () => {
    const root = fixture(620)
    const snap = queryEmoticons(root, 200, 0)
    expect(snap.others).toHaveLength(620)
    expect(snap.othersTotal).toBe(620)
    expect(new Set(snap.others?.map(item => item.md5)).size).toBe(620)
    expect(snap.others?.every(item => item.cdnUrl !== undefined)).toBe(true)
  })
})
