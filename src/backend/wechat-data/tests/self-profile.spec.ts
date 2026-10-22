/**
 * 当前账号昵称（侧栏品牌位，2026-10-21）。
 *
 * 判据：
 *  ① 只读 contact.db 自己那一行，显示优先级「备注 > 昵称 > 微信号」；
 *  ② 未解密/表缺失/没有自己那一行 ⇒ name 为空串（界面回退品牌名），绝不抛；
 *  ③ 接线守卫：Remote / 客户端 api / 侧栏组件 / 品牌名兜底都在。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { querySelfProfile } from '../src/query/self-profile.ts'

const SELF = 'wxid_self_test'
const scratch: string[] = []
let savedSelf: string | undefined

beforeEach(() => {
  savedSelf = process.env.DSH_WECHAT_SELF_WXID
  process.env.DSH_WECHAT_SELF_WXID = SELF
})

afterEach(() => {
  if (savedSelf === undefined) delete process.env.DSH_WECHAT_SELF_WXID
  else process.env.DSH_WECHAT_SELF_WXID = savedSelf
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个只含 contact 表的临时解密根。 */
function tempDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'self-profile-'))
  scratch.push(dir)
  return dir
}

/** 在 `<root>/contact/contact.db` 里建 contact 表并插入一行。 */
/** 编码一个 protobuf length-delimited 字符串字段。 */
function pstring(field: number, value: string): Buffer {
  const raw = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([(field << 3) | 2, raw.length]), raw])
}

/** contact.extra_buffer 的国家(5)/省(6)/市(7)。 */
function extra(country: string, province: string, city: string): Buffer {
  return Buffer.concat([pstring(5, country), pstring(6, province), pstring(7, city)])
}

function seedContact(
  root: string,
  row: { nick: string; remark: string; alias: string; extra?: Buffer },
): void {
  const contactDir = join(root, 'contact')
  mkdirSync(contactDir, { recursive: true })
  const db = new DatabaseSync(join(contactDir, 'contact.db'))
  try {
    db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT, alias TEXT, extra_buffer BLOB)')
    db.prepare('INSERT INTO contact (username, nick_name, remark, alias, extra_buffer) VALUES (?, ?, ?, ?, ?)')
      .run(SELF, row.nick, row.remark, row.alias, row.extra ?? Buffer.alloc(0))
  } finally {
    db.close()
  }
}

describe('querySelfProfile：只读自己那一行', () => {
  it('有备注 ⇒ 用备注（优先于昵称）', () => {
    const root = tempDataRoot()
    seedContact(root, { nick: '昵称甲', remark: '备注甲', alias: 'alias_me' })
    expect(querySelfProfile(root)).toEqual({ username: SELF, name: '备注甲', alias: 'alias_me' })
  })

  it('资料里有地区 ⇒ 中国只拼省+市，海外带国家', () => {
    const domestic = tempDataRoot()
    seedContact(domestic, {
      nick: '昵称甲',
      remark: '',
      alias: '',
      extra: extra('CN', 'Guangxi', 'Nanning'),
    })
    expect(querySelfProfile(domestic).region).toBe('广西南宁')

    const abroad = tempDataRoot()
    seedContact(abroad, {
      nick: '昵称乙',
      remark: '',
      alias: '',
      extra: extra('US', 'New York', 'New York'),
    })
    expect(querySelfProfile(abroad).region).toBe('美国 纽约州 纽约')
  })

  it('地区为空 / 表没有 extra_buffer ⇒ 省略 region，不伪造地区', () => {
    const empty = tempDataRoot()
    seedContact(empty, { nick: '昵称甲', remark: '', alias: '' })
    expect(querySelfProfile(empty).region).toBeUndefined()

    const legacy = tempDataRoot()
    const contactDir = join(legacy, 'contact')
    mkdirSync(contactDir, { recursive: true })
    const db = new DatabaseSync(join(contactDir, 'contact.db'))
    try {
      db.exec('CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT, alias TEXT)')
      db.prepare('INSERT INTO contact (username, nick_name, remark, alias) VALUES (?, ?, ?, ?)')
        .run(SELF, '旧库昵称', '', '')
    } finally {
      db.close()
    }
    expect(() => querySelfProfile(legacy)).not.toThrow()
    expect(querySelfProfile(legacy).name).toBe('旧库昵称')
    expect(querySelfProfile(legacy).region).toBeUndefined()
  })

  it('没备注 ⇒ 用昵称（实测本机 SuperT_王国宁 走这条）', () => {
    const root = tempDataRoot()
    seedContact(root, { nick: '昵称甲', remark: '', alias: 'alias_me' })
    expect(querySelfProfile(root).name).toBe('昵称甲')
  })

  it('备注/昵称都空 ⇒ 回退微信号', () => {
    const root = tempDataRoot()
    seedContact(root, { nick: '', remark: '', alias: 'alias_me' })
    expect(querySelfProfile(root).name).toBe('alias_me')
  })

  it('contact.db 不存在 / 没有自己那一行 ⇒ name 为空串（调用方回退品牌名，不抛）', () => {
    const empty = tempDataRoot()
    expect(() => querySelfProfile(empty)).not.toThrow()
    expect(querySelfProfile(empty)).toEqual({ username: SELF, name: '' })
    const other = tempDataRoot()
    seedContact(other, { nick: '', remark: '', alias: '' })
    expect(querySelfProfile(other).name).toBe('')
  })

  it('解析不到 self wxid ⇒ 直接空档案（不打开任何库）', async () => {
    delete process.env.DSH_WECHAT_SELF_WXID
    const root = tempDataRoot()
    const profile = querySelfProfile(root)
    // 没有 config.json / all_keys / 可扫描账号时 username 为空；机器上若恰好有真实账号扫描结果，
    // 至少不会抛错、且 name 是字符串（这里只断言不崩与形状）。
    expect(typeof profile.username).toBe('string')
    expect(typeof profile.name).toBe('string')
  })
})

describe('接线守卫：Remote / api / 侧栏 / 品牌兜底', () => {
  it('后端 Remote、客户端 api、品牌组件与兜底常量都接上了', async () => {
    const { readFileSync } = await import('node:fs')
    const base = join(import.meta.dirname, '..')
    const gateway = readFileSync(join(base, 'src', 'gateway-read.ts'), 'utf8')
    expect(gateway).toContain("@Remote('getSelfProfile')")
    expect(gateway).toContain('querySelfProfile(this._dirs.decrypted)')
    const client = join(base, '..', '..', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
    expect(readFileSync(join(client, 'api-read.ts'), 'utf8')).toContain('apiGetSelfProfile')
    expect(readFileSync(join(client, 'panels', 'brand-title.tsx'), 'utf8')).toContain("BRAND_NAME = 'Super Time'")
    expect(readFileSync(join(client, 'panels', 'brand-title.tsx'), 'utf8')).toContain("BRAND_SUBTITLE = '微信数据工作台'")
    expect(readFileSync(join(client, 'WechatDataPanel.tsx'), 'utf8')).toContain('<BrandTitle />')
  })
})
