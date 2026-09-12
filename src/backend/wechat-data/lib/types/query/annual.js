/**
 * Annual summary: available years derived from message timestamps across the
 * message shards (a session's last_timestamp is recent even when a chat has
 * older messages), so every year with messages shows up as a selectable report.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cachedBySig, shardCatalogSig } from "./meta.js";
/**
 * List available years (descending) from actual message create_time values.
 * @param decryptedDir - decrypted data root.
 * @returns years with messages, and no count summary (a separate query owns it).
 */
export function queryAnnual(decryptedDir) {
    return cachedBySig('annual:' + decryptedDir, shardCatalogSig(decryptedDir, ['message']), () => computeAnnual(decryptedDir), 30_000);
}
function computeAnnual(decryptedDir) {
    const msgDir = join(decryptedDir, 'message');
    if (!existsSync(msgDir))
        return { years: [] };
    const years = new Set();
    const files = readdirSync(msgDir)
        .filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache') && !f.includes('fts'));
    for (const file of files) {
        let db = null;
        try {
            db = new DatabaseSync(join(msgDir, file), { readOnly: true });
        }
        catch {
            continue;
        }
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
            for (const t of tables) {
                if (!t.startsWith('Msg_'))
                    continue;
                try {
                    const rows = db.prepare(`SELECT DISTINCT CAST(strftime('%Y', datetime(create_time, 'unixepoch')) AS INTEGER) y FROM "${t}" WHERE create_time > 0`).all();
                    for (const r of rows) {
                        const y = r.y;
                        if (Number.isFinite(y) && y > 2000)
                            years.add(y);
                    }
                }
                catch { /* skip table */ }
            }
        }
        catch { /* skip db */ }
        finally {
            db.close();
        }
    }
    return { years: Array.from(years).sort((a, b) => b - a) };
}
//# sourceMappingURL=annual.js.map