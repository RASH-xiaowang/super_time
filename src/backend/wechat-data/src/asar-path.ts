/**
 * Path rewriting for the packaged (asar) layout.
 *
 * In a packaged build this bundle lives at
 * `resources/app.asar/src/backend/wechat-data/lib/index.js`, so any path
 * resolved by walking up from `import.meta.url` lands *inside* the archive.
 * Electron patches `fs`, so `existsSync` / `readFileSync` answer for such paths
 * as if they were real files — but the patch covers **neither writes nor
 * `child_process`**: an in-archive path has no on-disk location, so
 * `writeFileSync` fails with ENOTDIR and `spawn` fails with ENOENT.
 *
 * So "the path exists" and "the path is usable" are two different questions in
 * a packaged build. Both call sites below (whisper model/engine install, the
 * wx_silk decoder process) need the second one, and both therefore depend on
 * the file also being listed in electron-builder's `asarUnpack` — the rewrite
 * alone is not enough, because the sibling has to actually exist.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The archive segment Electron inserts between `resources/` and the app. */
const ARCHIVE = 'app.asar'

/**
 * Rewrite an in-archive path to its `app.asar.unpacked` sibling.
 *
 * Dev paths (no `app.asar` segment) and already-unpacked paths come back
 * unchanged. The second guard matters: a path that already contains
 * `app.asar.unpacked` would otherwise be rewritten to
 * `app.asar.unpacked/.unpacked/...`, because the search finds the `app.asar`
 * prefix *inside* the marker.
 * @param p - Absolute path.
 * @returns The unpacked sibling in a packaged build; `p` otherwise.
 */
export function unpackedAware(p: string): string {
  const i = p.indexOf(ARCHIVE)
  if (i < 0) return p
  if (p.startsWith(`${ARCHIVE}.unpacked`, i)) return p
  // The archive root (no trailing separator) and any nested path both work:
  // whatever follows the marker is re-rooted under app.asar.unpacked.
  const rest = p.slice(i + ARCHIVE.length).replace(/^[\\/]+/, '')
  return join(p.slice(0, i), `${ARCHIVE}.unpacked`, rest)
}

/**
 * Resolve a candidate path to one that is a **real file on disk**.
 *
 * Use this instead of a bare `existsSync(candidate)` whenever the caller is
 * about to *execute* or *write* the path — that is exactly where the asar `fs`
 * patch stops applying. In a packaged build the answer is the
 * `app.asar.unpacked` sibling (and `''` when it is missing, i.e. when
 * `asarUnpack` does not cover the file: a clear "not found" beats handing an
 * unrunnable path to `spawn`).
 * @param candidate - Absolute path, possibly inside `app.asar`.
 * @param exists - Existence probe; injectable so the packaged layout can be
 *   simulated without Electron.
 * @returns A real on-disk path, or `''` when there is none.
 */
export function onDiskPath(candidate: string, exists: (p: string) => boolean = existsSync): string {
  const unpacked = unpackedAware(candidate)
  if (unpacked === candidate) return exists(candidate) ? candidate : ''
  return exists(unpacked) ? unpacked : ''
}
