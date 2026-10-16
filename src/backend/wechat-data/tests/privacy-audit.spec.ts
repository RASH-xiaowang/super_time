/**
 * Privacy state store: settings, audit aggregates and redaction.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPrivacyAudit, getPrivacyStateSnapshot, listPrivacyAudit, readPrivacySettings, recordPrivacyAudit, redactSensitiveText, writePrivacySettings } from '../src/query/privacy-audit.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-priv-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

describe('privacy audit store', () => {
  it('persists settings, records audits and redacts text', () => {
    const dir = root()
    expect(readPrivacySettings(dir).redactSensitive).toBe(false)
    writePrivacySettings(dir, { redactSensitive: true })
    const s = readPrivacySettings(dir)
    expect(s.redactSensitive).toBe(true)

    recordPrivacyAudit(dir, 'ask', 100, 2, 3)
    recordPrivacyAudit(dir, 'daily', 200, 1, 5)
    const snap = getPrivacyStateSnapshot(dir)
    expect(snap.audit.total).toBe(2)
    expect(snap.audit.byFeature[0]?.feature).toBe('daily')
    expect(snap.audit.byFeature[0]?.count).toBe(1)

    expect(listPrivacyAudit(dir)).toHaveLength(2)
    const cleared = clearPrivacyAudit(dir)
    expect(cleared.ok).toBe(true)
    expect(cleared.removed).toBe(2)
    expect(getPrivacyStateSnapshot(dir).audit.total).toBe(0)

    const text = redactSensitiveText('电话 13812345678 邮箱 a@b.com 密码:abc1234')
    expect(text).not.toContain('13812345678')
    expect(text).toContain('[手机号]')
    expect(text).toContain('[邮箱]')
    expect(text).toContain('[口令]')
  })

  // 「读不到」不再被翻译成「默认放行」这种语义判断：出网拦截已删除，读失败只需如实抛错，
  // 调用方（gateway-privacy.ts#privacyGateAt）按默认值（不脱敏）继续并记审计。
  it('库读不到时抛错，而不是编一个假值', () => {
    const dir = root()
    // 把库路径换成同名**目录**：openStore 必失败，且不依赖文件锁、权限这类环境差异。
    const db = join(dirname(dir), 'wechat_privacy.db')
    rmSync(db, { recursive: true, force: true })
    mkdirSync(db)
    expect(() => readPrivacySettings(dir)).toThrow()
    // 对照：审计是 best-effort，库坏了不该把出网调用本身炸掉（脱敏与审计另有其处）。
    expect(() => recordPrivacyAudit(dir, 'ask', 1, 1, 1)).not.toThrow()
  })
})
