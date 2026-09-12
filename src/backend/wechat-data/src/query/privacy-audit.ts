/**
 * Privacy state store for WeChat AI features: outbound block, sensitive-field
 * redaction, and per-feature audit counts. Persisted in
 * <data-root>/wechat_privacy.db; enforcement lives in the gateway's LLM paths.
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type { PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot } from '../types.ts'

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_privacy.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(dbPath(decryptedDir))
  db.exec('CREATE TABLE IF NOT EXISTS privacy_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS privacy_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, feature TEXT NOT NULL, ts INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0)')
  return db
}

function getSetting(db: DatabaseSync, key: string, dft: boolean): boolean {
  const row = db.prepare('SELECT value FROM privacy_settings WHERE key = ?').get(key) as { value?: string } | undefined
  return row ? row.value === '1' : dft
}

/** Read the current privacy settings. Defaults: redaction off, outbound allowed. */
export function readPrivacySettings(decryptedDir: string): { redactSensitive: boolean; blockOutbound: boolean } {
  try {
    const db = openStore(decryptedDir)
    const out = {
      redactSensitive: getSetting(db, 'redactSensitive', false),
      blockOutbound: getSetting(db, 'blockOutbound', false),
    }
    db.close()
    return out
  } catch {
    return { redactSensitive: false, blockOutbound: false }
  }
}

/** Persist privacy settings (partial update). */
export function writePrivacySettings(
  decryptedDir: string,
  patch: { redactSensitive?: boolean; blockOutbound?: boolean },
): { redactSensitive: boolean; blockOutbound: boolean } {
  const db = openStore(decryptedDir)
  try {
    const entries: Array<[string, boolean | undefined]> = [
      ['redactSensitive', patch.redactSensitive],
      ['blockOutbound', patch.blockOutbound],
    ]
    for (const [key, value] of entries) {
      if (value === undefined) continue
      db.prepare('INSERT INTO privacy_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value ? '1' : '0')
    }
    const out = {
      redactSensitive: getSetting(db, 'redactSensitive', false),
      blockOutbound: getSetting(db, 'blockOutbound', false),
    }
    return out
  } finally {
    db.close()
  }
}

/** Record one AI feature call in the audit log. */
export function recordPrivacyAudit(decryptedDir: string, feature: string, chars: number, sessions: number, messages: number): void {
  try {
    const db = openStore(decryptedDir)
    db.prepare('INSERT INTO privacy_audit(feature, ts, chars, sessions, messages) VALUES (?, ?, ?, ?, ?)').run(feature, Date.now(), chars, sessions, messages)
    db.close()
  } catch { /* audit is best-effort */ }
}

/** Read the privacy state snapshot including audit aggregates. */
export function getPrivacyStateSnapshot(decryptedDir: string): PrivacyStateSnapshot {
  const settings = readPrivacySettings(decryptedDir)
  try {
    const db = openStore(decryptedDir)
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM privacy_audit').get() as { n: number } | undefined
    const featureRows = db.prepare('SELECT feature, COUNT(*) AS n, SUM(chars) AS c FROM privacy_audit GROUP BY feature ORDER BY n DESC').all() as Array<{ feature: string; n: number; c: number }>
    const lastRow = db.prepare('SELECT MAX(ts) AS t FROM privacy_audit').get() as { t: number | null } | undefined
    db.close()
    return {
      redactSensitive: settings.redactSensitive,
      blockOutbound: settings.blockOutbound,
      audit: {
        total: totalRow?.n ?? 0,
        byFeature: featureRows.map(r => ({ feature: r.feature, count: r.n, chars: r.c })),
        last: lastRow?.t ?? null,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    }
  } catch {
    return {
      redactSensitive: settings.redactSensitive,
      blockOutbound: settings.blockOutbound,
      audit: { total: 0, byFeature: [], last: null, updatedAt: Math.floor(Date.now() / 1000) },
    }
  }
}

/** List recent raw privacy audit rows. */
export function listPrivacyAudit(decryptedDir: string, limit = 200): PrivacyAuditRow[] {
  try {
    const db = openStore(decryptedDir)
    const rows = db.prepare('SELECT id, feature, ts, chars, sessions, messages FROM privacy_audit ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
    db.close()
    return rows.map(r => ({
      id: Number(r['id'] ?? 0),
      feature: typeof r['feature'] === 'string' ? r['feature'] : '',
      ts: Number(r['ts'] ?? 0),
      chars: Number(r['chars'] ?? 0),
      sessions: Number(r['sessions'] ?? 0),
      messages: Number(r['messages'] ?? 0),
    }))
  } catch {
    return []
  }
}

/** Clear all privacy audit rows. */
export function clearPrivacyAudit(decryptedDir: string): PrivacyAuditClearResult {
  try {
    const db = openStore(decryptedDir)
    const r = db.prepare('DELETE FROM privacy_audit').run()
    db.close()
    return { ok: true, removed: Number(r.changes) }
  } catch {
    return { ok: false, removed: 0 }
  }
}

/** Redact common sensitive fields (phone/id/bank/email/password) from prompt text. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/1[3-9]\d{9}/g, '[手机号]')
    .replace(/[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, '[身份证]')
    .replace(/(?:62\d{14,17}|[45]\d{15,18})/g, '[银行卡]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱]')
    .replace(/(?:密码|口令|pwd|password|passwd)\s*[=:：]\s*[A-Za-z0-9@#$%^&*!_.-]{4,32}/g, '[口令]')
}
