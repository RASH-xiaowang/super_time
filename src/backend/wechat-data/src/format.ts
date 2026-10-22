/**
 * 后端唯一的「给人看」格式化（P3-1 / P3-2 / CODE-AUDIT-2026-09-26 第一批 #8）。
 *
 * 为什么要专门有一个文件：字节体积与时间在 `query/**` 与 `laya/**` 里各被实现过一遍，
 * 口径互不相同（同一份 1.4MB 在「知识库文件」里是 `1.4 MB`、在 laya 里是 `1428.6 KB`、
 * 在 kb-files-store 里封顶 MB），而时间那几份**连单位都不一样**（有的收秒、有的收毫秒，
 * 类型都是 number ⇒ 传错了不报错，只是整片显示成 1970 年）。
 * 前端已有 `utils/format.ts` 这个唯一出处，这里补齐后端那一半，口径与前端逐字一致。
 * 唯一的实现 + 单位写进名字，由 `src/backend/tests/format-single-source.spec.ts` 守着。
 */

/**
 * 字节数 → 人类可读体积（与前端 `utils/format.ts#fmtBytes` 同一口径）。
 * B 不省略；KB/MB 取 1 位小数；GB/TB 取 2 位；逐级进位。
 * @param n - 字节数（null / NaN / 负数一律视作 0）。
 */
export function fmtBytes(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${v} B`
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`
  if (v < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(2)} GB`
  return `${(v / 1024 ** 4).toFixed(2)} TB`
}

/** 本地时间各部分补齐两位。 */
function p2(x: number): string {
  return String(x).padStart(2, '0')
}

/**
 * `Date` 对象 → `YYYY-MM-DD`（本地时区）。
 * @param d - 已经算好的本地 `Date`。
 */
export function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * **秒级**时间戳 → `YYYY-MM-DD HH:mm`。
 * @param ts - unix 秒（不是毫秒！毫秒传进来会得到 1970 年）。
 * @param placeholder - 空值/非法值时的占位。
 */
export function fmtDateTimeSec(ts: number | null | undefined, placeholder = ''): string {
  const n = Number(ts ?? 0)
  if (!n) return placeholder
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return placeholder
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * 朋友圈那种相对时间标签（**秒级**时间戳）：今天/昨天带钟点，再往前按天、按月。
 * @param ts - unix 秒。
 */
export function fmtRelativeDaySec(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  const hhmm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  if (dayDiff <= 0) return `今天 ${hhmm}`
  if (dayDiff === 1) return `昨天 ${hhmm}`
  if (dayDiff < 365) return `${dayDiff}天前`
  return `${Math.floor(dayDiff / 30)}个月前`
}
