// @vitest-environment node
/**
 * 许可证与设备指纹的**宿主侧完整性**：进程内指纹缓存、原子写 + 备份、时钟回拨检测。
 *
 * 这三件事的共同点是「出错时静默」：
 *   · 指纹不缓存 → 每次过闸都起 `reg` / `cmd /c vol` 子进程，界面只是变慢；
 *   · 许可证直接覆盖写 → 写一半断电后用户看到「许可证突然没了」，且原始内容找不回；
 *   · 时钟调回到期日之前 → 过期证看起来一直有效，没有任何报错。
 *
 * 所以判据都落在可观察行为上：对象是否复用、备份是否是上一版、回拨是否被拒绝。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const REPO_ROOT = join(__dirname, '..', '..', '..')
const { getDeviceFingerprint, clearFingerprintCache, refreshDeviceFingerprint } = require(join(REPO_ROOT, 'src', 'license', 'fingerprint.js')) as {
  getDeviceFingerprint: () => { fingerprint: string, parts: Record<string, string> }
  clearFingerprintCache: () => void
  refreshDeviceFingerprint: () => { fingerprint: string, parts: Record<string, string> }
}
const {
  readLicenseFile, writeLicenseFile, deleteLicenseFile,
  readLastSeen, writeLastSeen, clearLastSeen,
} = require(join(REPO_ROOT, 'src', 'license', 'store.js')) as {
  readLicenseFile: (dir: string) => any
  writeLicenseFile: (dir: string, doc: object) => string
  deleteLicenseFile: (dir: string) => boolean
  readLastSeen: (dir: string) => number | null
  writeLastSeen: (dir: string, at: number) => boolean
  clearLastSeen: (dir: string) => boolean
}
const { evaluatePayload, CLOCK_ROLLBACK_TOLERANCE_MS } = require(join(REPO_ROOT, 'src', 'license', 'schema.js')) as {
  evaluatePayload: (payload: any, ctx: any) => { valid: boolean, code: string }
  CLOCK_ROLLBACK_TOLERANCE_MS: number
}

const scratch: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'license-integrity-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

describe('设备指纹：进程内缓存与显式失效', () => {
  it('同一进程内重复取值复用同一份结果（不再起 reg / vol 子进程）', () => {
    clearFingerprintCache()
    const first = getDeviceFingerprint()
    const second = getDeviceFingerprint()
    expect(second).toBe(first)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('clear/refresh 之后重新采集，但同一台机器的指纹值不变', () => {
    clearFingerprintCache()
    const first = getDeviceFingerprint()
    const refreshed = refreshDeviceFingerprint()
    expect(refreshed).not.toBe(first)
    expect(refreshed.fingerprint, '同一台机器刷新后指纹变了 —— 许可证会被判成换机').toBe(first.fingerprint)
  })
})

describe('许可证文件：原子写与上一版备份', () => {
  const doc = (licenseId: string) => ({
    payload: { product: 'super-time-wechat', licenseId },
    signature: 'sig-' + licenseId,
    importedAt: '2026-01-01T00:00:00.000Z',
  })

  it('覆盖写入前保留上一版 .bak，主文件始终是完整 JSON', () => {
    const dir = tempDir()
    writeLicenseFile(dir, doc('L1'))
    expect(readLicenseFile(dir)).toMatchObject({ payload: { licenseId: 'L1' } })
    writeLicenseFile(dir, doc('L2'))
    expect(readLicenseFile(dir)).toMatchObject({ payload: { licenseId: 'L2' } })
    const bak = JSON.parse(readFileSync(join(dir, 'license.json.bak'), 'utf8'))
    expect(bak, '备份不是上一版（导入错证后无法人工回退）').toMatchObject({ payload: { licenseId: 'L1' } })
    // 原子写的临时文件必须清理干净，不能每导入一次就在 userData 留一份垃圾。
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('删除许可证后状态归零（避免下次读取到旧文件）', () => {
    const dir = tempDir()
    writeLicenseFile(dir, doc('L1'))
    expect(deleteLicenseFile(dir)).toBe(true)
    expect(readLicenseFile(dir)).toBeNull()
  })
})

describe('last-seen 基线：读写与清空', () => {
  it('写入后可读回，清空后为 null，坏文件按「没有基线」处理', () => {
    const dir = tempDir()
    expect(readLastSeen(dir)).toBeNull()
    const at = Date.parse('2026-06-01T00:00:00.000Z')
    expect(writeLastSeen(dir, at)).toBe(true)
    expect(readLastSeen(dir)).toBe(at)
    expect(clearLastSeen(dir)).toBe(true)
    expect(readLastSeen(dir)).toBeNull()
    expect(readLastSeen(join(dir, 'missing-subdir'))).toBeNull()
  })
})

describe('许可证有效期：系统时钟回拨检测', () => {
  const fingerprint = 'a'.repeat(64)
  const basePayload = (expiresAt: string) => ({
    device: { fingerprint },
    expiresAt,
  })

  it('时钟被调回到上次运行时间之前（超过容差）→ CLOCK_ROLLBACK，且先于过期判定', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const future = now.getTime() + 2 * 60 * 60 * 1000
    const result = evaluatePayload(basePayload('2025-06-01T00:00:00.000Z'), {
      fingerprint,
      appVersion: '1.0.0',
      now,
      // 基线是「两小时后」，而当前时钟还在两小时前 —— 典型「把日期调回去用过期证」。
      lastSeenAt: future,
    })
    expect(result.valid).toBe(false)
    expect(result.code).toBe('CLOCK_ROLLBACK')
  })

  it('容差内的时钟抖动（NTP 校时）不算回拨', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const result = evaluatePayload(basePayload('2027-01-01T00:00:00.000Z'), {
      fingerprint,
      appVersion: '1.0.0',
      now,
      lastSeenAt: now.getTime() + CLOCK_ROLLBACK_TOLERANCE_MS - 1000,
    })
    expect(result.valid).toBe(true)
  })

  it('没有基线 / 基线损坏时跳过回拨判定（首次导入不能被误拒）', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    for (const lastSeenAt of [null, undefined, 'not-a-date', 0]) {
      const result = evaluatePayload(basePayload('2027-01-01T00:00:00.000Z'), {
        fingerprint,
        appVersion: '1.0.0',
        now,
        lastSeenAt,
      })
      expect(result.valid, `lastSeenAt=${String(lastSeenAt)} 时被误判`).toBe(true)
    }
  })

  it('基线正常、证书已过期 → 仍是 EXPIRED（回拨检测不能掩盖正常过期）', () => {
    const now = new Date('2026-06-01T00:00:00.000Z')
    const result = evaluatePayload(basePayload('2026-01-01T00:00:00.000Z'), {
      fingerprint,
      appVersion: '1.0.0',
      now,
      lastSeenAt: now.getTime() - 60_000,
    })
    expect(result.valid).toBe(false)
    expect(result.code).toBe('EXPIRED')
  })
})
