// @vitest-environment node
/**
 * 消息列表行为测试共享的临时数据根、附件样本和投递依赖。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MessageListDispatchDeps } from '../src/query/message-list-dispatch.ts'

export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=',
  'base64',
)
export const PNG_DATA_URL = 'data:image/png;base64,' + PNG_BYTES.toString('base64')
export const JPEG_DATA_URL = 'data:image/jpeg;base64,'
  + Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0xff, 0xd9]).toString('base64')

export let root = ''
export let decrypted = ''

export function setupMessageListFixture(): void {
  root = mkdtempSync(join(tmpdir(), 'message-list-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
}

export function cleanupMessageListFixture(): void {
  rmSync(root, { recursive: true, force: true })
}

export function dispatchDeps(
  fetchImpl: MessageListDispatchDeps['fetchImpl'],
  gate: MessageListDispatchDeps['gate'] = (_feature, _stats, texts) => texts,
): MessageListDispatchDeps {
  return {
    decodeImage: async () => ({ url: PNG_DATA_URL }),
    gate,
    fetchImpl,
  }
}

/** Build `contact.extra_buffer` with protobuf field 2 = enterprise wording id. */
function enterpriseBuffer(wordingId: string): Buffer {
  const value = Buffer.from(wordingId, 'utf8')
  return Buffer.concat([Buffer.from([0x12, value.length]), value])
}

export function seedEnterpriseContacts(rows: ReadonlyArray<[username: string, name: string]>): void {
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const db = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
  db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
  db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-ent', '示例企业')
  const ins = db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)')
  for (const [username, name] of rows) {
    ins.run(username, name, '', enterpriseBuffer('wording-ent'))
  }
  db.close()
}
