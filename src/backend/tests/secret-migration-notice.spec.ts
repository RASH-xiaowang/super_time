/**
 * W2-12.3：密钥从 `config.json` 搬到 `secrets.json`（M1）这件事得**提示一次**。
 *
 * ## 为什么要提示
 *
 * 搬运动作是 `saveConfig` 顺手做的、**静默**的：`config.json` 里剩下的真值先抄进
 * `secrets.json`，然后**无条件 delete** 掉 `config.json` 里的密钥字段。
 * 这对程序是好事（明文密钥不再躺在会被同步/备份的配置文件里），但 `config.json`
 * 是用户会手工编辑的文件 —— 搬完他去那找密钥会找不着，且**什么提示都没有**。
 *
 * ## 判据钉的四条
 *
 * ① `pending` 只在「`config.json` 里真的还留着**有意义**的密钥字段」时为真：
 *    `image_xor_key: 136` 是内置默认值，老版本会把它一并写进 config.json ——
 *    对它报「已迁移」是骗人（搬不搬结果都一样）。
 * ② 点过「知道了」（确认位）之后就不再提示 —— 这是「一次性」的全部含义。
 * ③ 判定是**纯读**：连着问两次不动文件（这条路径在每次打开设置时都会跑）。
 * ④ 搬家本身没被本条改坏：保存之后 config.json 里确实没有密钥字段了，提示也随之消失。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SECRET_MIGRATION_ACK_FIELD, getConfig, saveConfig, secretMigrationPending } from '../wechat-data/src/config/wechat-config.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 每个用例一个独立数据根（配置是「解密目录的兄弟文件」，共用父目录会互相串）。 */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-secmig-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

/** 直接往 `config.json` 写东西（模拟老版本数据 / 手工编辑）。 */
function writeConfig(decrypted: string, obj: Record<string, unknown>): void {
  writeFileSync(join(decrypted, '..', 'config.json'), JSON.stringify(obj, null, 2), 'utf8')
}

function readConfig(decrypted: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(decrypted, '..', 'config.json'), 'utf8')) as Record<string, unknown>
}

describe('W2-12.3 旧数据：config.json 里还留着密钥 ⇒ 该提示', () => {
  it('有意义的密钥字段被列出来', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', db_enc_key: 'K-real', image_aes_key: 'A-real' })
    const st = secretMigrationPending(d)
    expect(st.pending).toBe(true)
    expect(st.fields.sort()).toEqual(['db_enc_key', 'image_aes_key'])
  })

  it('**内置默认值不算**（image_xor_key: 136 搬不搬都一样，报了就是骗人）', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', image_xor_key: 136 })
    expect(secretMigrationPending(d).pending, '只有内置默认值 ⇒ 没有「搬家」这回事').toBe(false)
  })

  it('空串也不算（界面未加载完时提交的空串不是「用户要清空」）', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', db_enc_key: '', image_aes_key: '' })
    expect(secretMigrationPending(d).pending).toBe(false)
  })

  it('config.json 干净 ⇒ 不提示', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', api_port: 5032 })
    const st = secretMigrationPending(d)
    expect(st.pending).toBe(false)
    expect(st.fields).toEqual([])
  })
})

describe('W2-12.3「一次性」：确认位写回去就不再提示', () => {
  it('确认位为 true ⇒ 即使密钥还在 config.json 里也不提示', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', db_enc_key: 'K-real', [SECRET_MIGRATION_ACK_FIELD]: true })
    const st = secretMigrationPending(d)
    expect(st.pending, '点过「知道了」还提示，就是噪音').toBe(false)
    // 但字段还是要报出来 —— 诊断界面可能想知道「这库里有哪些密钥字段还留在外面」。
    expect(st.fields).toEqual(['db_enc_key'])
  })

  it('确认位只认严格 true（"true" 字符串 / 1 都不算，免得手改文件时误关）', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', db_enc_key: 'K-real', [SECRET_MIGRATION_ACK_FIELD]: 'true' })
    expect(secretMigrationPending(d).pending, '字符串 "true" 不是确认').toBe(true)
  })

  it('确认位住在 config.json（不是 secrets.json —— 它不是密钥）', () => {
    expect(SECRET_MIGRATION_ACK_FIELD).toBe('secret_migration_notice_ack')
    const d = dataRoot()
    // 注意这里 config.json 里**没有**密钥字段：否则 `saveConfig` 会顺手做真正的搬家，
    // 造出 secrets.json 是对的，那样就测不到「确认位被当成密钥」这件事了。
    writeConfig(d, { db_dir: 'D:\\wx' })
    saveConfig(d, { [SECRET_MIGRATION_ACK_FIELD]: true })
    expect(readConfig(d)[SECRET_MIGRATION_ACK_FIELD]).toBe(true)
    expect(existsSync(join(d, '..', 'secrets.json')), '只写确认位不该凭空造出 secrets.json（它不是密钥）').toBe(false)
  })
})

describe('W2-12.3 判定是纯读', () => {
  it('连着问三次，文件一个字节都不变', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', db_enc_key: 'K-real' })
    const before = readFileSync(join(d, '..', 'config.json'), 'utf8')
    const a = secretMigrationPending(d)
    const b = secretMigrationPending(d)
    const c = secretMigrationPending(d)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(readFileSync(join(d, '..', 'config.json'), 'utf8')).toBe(before)
  })

  it('config.json 不存在 / 坏掉时不抛（这条路径在打开设置时就会跑）', () => {
    const d = dataRoot()
    expect(secretMigrationPending(d).pending).toBe(false)
    writeFileSync(join(d, '..', 'config.json'), '{ 这不是 JSON', 'utf8')
    expect(() => secretMigrationPending(d)).not.toThrow()
    expect(secretMigrationPending(d).pending, '坏文件里读不出密钥 ⇒ 不提示（提示了也迁移不了）').toBe(false)
  })
})

describe('W2-12.3 搬家本身没被本条改坏', () => {
  it('保存之后密钥进了 secrets.json、config.json 里没了，提示随之消失', () => {
    const d = dataRoot()
    writeConfig(d, { db_dir: 'D:\\wx', db_enc_key: 'K-real' })
    expect(secretMigrationPending(d).pending).toBe(true)

    const r = saveConfig(d, { db_dir: 'D:\\wx' })
    expect(r.ok).toBe(true)

    const cfg = readConfig(d)
    expect('db_enc_key' in cfg, 'config.json 里不该再有密钥字段').toBe(false)
    const secrets = JSON.parse(readFileSync(join(d, '..', 'secrets.json'), 'utf8')) as Record<string, unknown>
    expect(secrets['db_enc_key']).toBe('K-real')
    // 真值还在（getConfig 读得到）—— 这才是迁移，不是丢密钥。
    expect(String(getConfig(d)['db_enc_key'])).toBe('K-real')
    expect(secretMigrationPending(d).pending).toBe(false)
  })
})