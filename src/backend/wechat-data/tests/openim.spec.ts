/**
 * Enterprise-WeChat name resolution from contact.db.
 *
 * `contact.extra_buffer` field 2 is an `openim_wording` id. Only that wording
 * lookup is an enterprise name; field 4 is commonly an enterprise id and must
 * not leak into the UI as a company name.
 *
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  enterpriseNameFromExtra,
  isEnterpriseWechatUser,
  loadOpenimDirectoryFromDb,
  loadOpenimEnterpriseNamesFromDb,
  loadOpenimWordingNames,
} from '../src/query/openim.ts'

/** Build a length-delimited protobuf string field. */
function fieldString(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  expect(bytes.length).toBeLessThan(128)
  return Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes])
}

describe('企业微信账号判定', () => {
  it('只把 @openim 普通用户算作企业微信，排除客服账号', () => {
    expect(isEnterpriseWechatUser('wxid_peer@openim')).toBe(true)
    expect(isEnterpriseWechatUser('  wxid_peer@openim  ')).toBe(true)
    expect(isEnterpriseWechatUser('wxid_peer@kefu.openim')).toBe(false)
    expect(isEnterpriseWechatUser('123@chatroom')).toBe(false)
    expect(isEnterpriseWechatUser('wxid_peer')).toBe(false)
  })
})

describe('loadOpenimDirectoryFromDb', () => {
  it('把 wording id 映射为企业名称，并填充 username → enterpriseName', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE contact (username TEXT, extra_buffer BLOB)')
      db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-deepseek', '深度求索')
      db.prepare('INSERT INTO contact VALUES (?, ?)').run(
        'wxid_peer@openim',
        fieldString(2, 'wording-deepseek'),
      )
      db.prepare('INSERT INTO contact VALUES (?, ?)').run(
        'wxid_kefu@kefu.openim',
        fieldString(2, 'wording-deepseek'),
      )

      const directory = loadOpenimDirectoryFromDb(db)
      expect(directory.wordingNames.get('wording-deepseek')).toBe('深度求索')
      expect(directory.enterpriseNames.get('wxid_peer@openim')).toBe('深度求索')
      expect(directory.enterpriseNames.has('wxid_kefu@kefu.openim')).toBe(false)
      expect(loadOpenimEnterpriseNamesFromDb(db).get('wxid_peer@openim')).toBe('深度求索')
    } finally {
      db.close()
    }
  })

  it('缺少 openim_wording 表时按老快照处理，不抛错也不伪造企业名', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE contact (username TEXT, extra_buffer BLOB)')
      db.prepare('INSERT INTO contact VALUES (?, ?)').run(
        'wxid_peer@openim',
        fieldString(2, 'missing-wording'),
      )
      expect(loadOpenimWordingNames(db).size).toBe(0)
      expect(loadOpenimDirectoryFromDb(db).enterpriseNames.size).toBe(0)
    } finally {
      db.close()
    }
  })

  it('缺少 extra_buffer 列时保留联系人但企业名为空', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE contact (username TEXT)')
      db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-a', '甲公司')
      db.prepare('INSERT INTO contact VALUES (?)').run('wxid_peer@openim')
      expect(loadOpenimDirectoryFromDb(db).enterpriseNames.size).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('enterpriseNameFromExtra', () => {
  const names = new Map([['wording-a', '甲公司']])

  it('空 buffer / 找不到 wording / 只有 field 4 时都不返回企业名', () => {
    expect(enterpriseNameFromExtra(Buffer.alloc(0), names)).toBeUndefined()
    expect(enterpriseNameFromExtra(fieldString(2, 'unknown'), names)).toBeUndefined()
    expect(enterpriseNameFromExtra(fieldString(4, 'enterprise-id'), names)).toBeUndefined()
  })
})
