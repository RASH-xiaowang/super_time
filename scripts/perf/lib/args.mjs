/**
 * 极简参数解析（不引依赖，也不让 CLI 参数散落在业务逻辑里）。
 *
 * 支持：`--key=value` / `--key value` / `--flag`（值为 true）/ `--no-flag`（值为 false）。
 * 未知参数保留在 `rest` 里并由调用方决定报错还是忽略。
 */

/**
 * @param {string[]} argv - 通常传 `process.argv.slice(2)`。
 * @returns {{ values: Record<string, string | boolean>, rest: string[] }}
 */
export function parseArgs (argv) {
  const values = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { rest.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--')) { rest.push(a); continue }
    const body = a.slice(2)
    if (body.startsWith('no-')) { values[body.slice(3)] = false; continue }
    const eq = body.indexOf('=')
    if (eq >= 0) { values[body.slice(0, eq)] = body.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { values[body] = next; i++ } else { values[body] = true }
  }
  return { values, rest }
}

/**
 * 取数字参数（缺省/非法时用 fallback，并给出 warn 回调）。
 * @param {Record<string, unknown>} values
 * @param {string} key
 * @param {number} fallback
 * @param {(msg: string) => void} [warn]
 */
export function numArg (values, key, fallback, warn) {
  const raw = values[key]
  if (raw === undefined || raw === true) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) { if (warn) warn(`--${key}=${String(raw)} 不是数字，使用默认 ${fallback}`); return fallback }
  return n
}

/** 取字符串参数。 */
export function strArg (values, key, fallback) {
  const raw = values[key]
  return typeof raw === 'string' && raw !== '' ? raw : fallback
}

/** 取逗号分隔列表参数（自动 trim + 去空）。 */
export function listArg (values, key, fallback) {
  const raw = values[key]
  if (typeof raw !== 'string') return fallback
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** 取布尔参数：显式 `--x`/`--x=true` 为真，`--no-x` 为假。 */
export function boolArg (values, key, fallback) {
  const raw = values[key]
  if (raw === undefined) return fallback
  if (raw === true) return true
  if (raw === false) return false
  return String(raw) === '1' || String(raw).toLowerCase() === 'true'
}
