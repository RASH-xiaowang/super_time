/**
 * 微信+格式化工具（纯函数，无副作用）。
 *
 * ## 两条必须遵守的约定
 *
 * 1. **时间函数的单位写进名字**：`...Sec` 收秒级时间戳（unix seconds），
 *    `...Ms` 收毫秒。此前各面板各自实现 fmtTime，有的收秒、有的收毫秒，
 *    类型都是 number，传错也不报错 —— 整片时间会错到 1970 年且无人察觉。
 *    现在单位在函数名里，读代码即可发现不匹配。
 *
 * 2. **同类格式化只允许一个实现**。这条由 `scripts/check-ui-consistency.js`
 *    把关：历史上曾出现 9 个面板各写一份 fmtBytes（口径互不相同，12 GB
 *    在有的面板显示成 "12288.0 MB"）、6 份 fmtTime、多份 pct。
 *
 * 已删除的零引用导出：formatDividerTime / avatarLetter / fmtDur / favIcon
 * （全域 279 个文件核查确认无人引用）。iconSvg 与 ICON_PATHS 仅被本文件的
 * fileIcon 使用，故不再对外导出。
 */

/**
 * 字节数 → 人类可读体积。**全局唯一实现**，所有面板都必须用它。
 *
 * 统一口径：B 不省略；KB/MB 取 1 位小数，GB/TB 取 2 位；逐级进位到 TB。
 * （统一前 9 个实现的差异见 docs/ui-audit.md：Health/Hook/MediaAssets 封顶在 MB，
 * Settings 无 B 单位，Overview 的 KB 取 0 位小数。）
 *
 * @param n - 字节数（null/undefined/NaN/负数一律视作 0）。
 * @returns 例如 '512 B'、'1.5 KB'、'12.0 MB'、'1.25 GB'、'2.00 TB'。
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
 * **秒级**时间戳 → `YYYY-MM-DD HH:mm`。
 * @param ts - unix 秒（不是毫秒！）。
 * @param placeholder - 空值或非法值时返回的占位符。
 */
export function fmtDateTimeSec(ts: number | null | undefined, placeholder = '—'): string {
  const n = Number(ts ?? 0)
  if (!n) return placeholder
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return placeholder
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * **秒级**时间戳 → 消息悬停时显示的完整时间：`YYYY-MM-DD HH:mm:ss`。
 *
 * 微信只在悬停某条消息时才显示时间，且精确到秒（列表里的常显时间只到分）。
 * @param ts - unix 秒。
 * @param placeholder - 空值或非法值时返回的占位符。
 */
export function fmtMsgClockSec(ts: number | null | undefined, placeholder = ''): string {
  const n = Number(ts ?? 0)
  if (!n) return placeholder
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return placeholder
  const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms}`
}

/** 星期的中文简写，索引 = `Date.getDay()`（0 = 周日）。 */
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']

/**
 * **秒级**时间戳 → 聊天流里的日期分隔标签（微信 `formatTimeDivider` 同款口径）。
 *
 * 今天 `HH:mm`；昨天 `昨天 HH:mm`；一周内 `星期X HH:mm`；
 * 今年 `M月D日 HH:mm`；更早 `YYYY年M月D日 HH:mm`。
 * @param ts - unix 秒。
 * @param now - 参照「今天」的时刻（默认取当前时间，便于测试注入）。
 * @returns 分隔标签；空值或非法时间返回空串（调用方据此跳过该分隔）。
 */
export function fmtDividerSec(ts: number | null | undefined, now: Date = new Date()): string {
  const n = Number(ts ?? 0)
  if (!n) return ''
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const dayStart = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  // 负值（消息时间在未来 / 时钟偏差）按「今天」处理，不显示成「星期X -1」之类。
  const daysAgo = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (daysAgo <= 0) return hm
  if (daysAgo === 1) return `昨天 ${hm}`
  if (daysAgo < 7) return `星期${WEEKDAY_CN[d.getDay()] ?? ''} ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/**
 * **秒级**时间戳 → 会话列表用短标签：今天 `HH:mm`，昨天 `昨天`，更早 `M/D`。
 * @param ts - unix 秒。
 */
export function fmtSessionTimeSec(ts: number | null | undefined): string {
  const n = Number(ts ?? 0)
  if (!n) return ''
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const yesterday = new Date(now.getTime() - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * **毫秒级**时间戳 → `HH:mm:ss`。
 * @param ts - 毫秒时间戳（不是秒！）。
 * @param placeholder - 空值或非法值时返回的占位符。
 */
export function fmtClockMs(ts: number | null | undefined, placeholder = '—'): string {
  const n = Number(ts ?? 0)
  if (!n) return placeholder
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return placeholder
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * **毫秒级**时间戳 → 本地完整日期时间（zh-CN，24 小时制）。
 * @param ts - 毫秒时间戳。
 */
export function fmtLocaleMs(ts: number | null | undefined): string {
  const n = Number(ts ?? 0)
  if (!n) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * **秒级**时间戳 → `M-D`（文件列表用的短日期，无年份）。
 * @param ts - unix 秒（不是毫秒！）。
 */
export function fmtMonthDaySec(ts: number | null | undefined): string {
  const n = Number(ts ?? 0)
  if (!n) return ''
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 0..1 的比例 → `NN%`（整数百分比）。
 * @param ratio - 比例（0.42 → '42%'）。
 */
export function fmtPct(ratio: number | null | undefined): string {
  return `${Math.round((Number(ratio) || 0) * 100)}%`
}

/**
 * part/whole → 百分比**数值**（保留一位小数）。需要拼 '%' 时由调用方追加。
 * @param part - 分子。
 * @param whole - 分母（<= 0 时返回 0）。
 */
export function fmtSharePct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

/**
 * Deterministic avatar color from a name.
 * @param name - Name used to seed the color hash.
 * @returns A hex color string.
 */
export function colorFromName(name: string): string {
  const colors = ['#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#009688', '#4caf50', '#ff9800', '#795548', '#607d8b', '#ff5722']
  let h = 0
  const s = name || '?'
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i)
  return colors[Math.abs(h) % colors.length] ?? '#2196f3'
}

/** hsl(h, s%, l%) → sRGB（0-255）。只用于本文件的对比度选色，不对外导出。 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (hp < 1) { r = c; g = x } else if (hp < 2) { r = x; g = c }
  else if (hp < 3) { g = c; b = x } else if (hp < 4) { g = x; b = c }
  else if (hp < 5) { r = x; b = c } else { r = c; b = x }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}
function relLum(c: { r: number; g: number; b: number }): number {
  const f = (v: number): number => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
function contrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const L1 = relLum(a), L2 = relLum(b)
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
}

const AVATAR_LIGHT = '#ffffff'
const AVATAR_DARK = '#10151f'

/**
 * 名字首字头像的「底色 + 文字色」（第 88 轮）。
 *
 * 为什么需要：四个面板（聊天会话 / 通讯录 / 数据配置 / 撤回消息）各自用
 * `hsl(色相 45% 55%)` 当头像底色、文字写死白色。实测白字在那个底色上
 * **360 个色相里只有 57 个达到 4.5:1**，最差（h=60 黄）只有 1.92:1 —— 首字看不清。
 *
 * 现在统一由这里给色：色相仍用**同一套**哈希（字符码求和取模 360），
 * 亮度在 55% 附近做最小偏移，并二选一挑浅色/深色文字，保证 ≥ 4.5:1。
 * 顺带把四个面板的取色公式统一成同一个 —— 同一个人在任何页签都是同一个颜色。
 * @param seed - 头像持久的标识（通常是 username，其次显示名）。
 * @returns 背景色与文字色（都是 CSS 颜色字符串）。
 */
export function avatarColors(seed: string): { background: string; color: string } {
  const s = seed || '?'
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h + s.charCodeAt(i)) % 360
  const light = { r: 255, g: 255, b: 255 }
  const dark = { r: 16, g: 21, b: 31 }
  // 先试原来的 55% 亮度；不够就从近到远试其它亮度
  const lightness = [55, 50, 60, 45, 65, 40, 70, 36, 74]
  for (const l of lightness) {
    const bg = hslToRgb(h, 0.45, l / 100)
    const cw = contrast(light, bg)
    const cd = contrast(dark, bg)
    const useWhite = cw >= cd
    const best = useWhite ? cw : cd
    if (best >= 4.5) {
      return { background: `hsl(${h} 45% ${l}%)`, color: useWhite ? AVATAR_LIGHT : AVATAR_DARK }
    }
  }
  // 兜底（理论上到不了）：给一个必定安全的深底白字
  return { background: 'hsl(' + h + ' 45% 32%)', color: AVATAR_LIGHT }
}

/**
 * Linear icon svg (24 viewBox, 1.6 stroke, currentColor).
 * 仅供本文件的 fileIcon 使用，不对外导出。
 */
function iconSvg(paths: string, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}

/** Icon path snippets (feather-style stroke fragments), 供 fileIcon 使用。 */
const ICON_PATHS = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  present: '<path d="M2 3h20"/><path d="M4 3v14h16V3"/><path d="M9 21h6M12 17v4"/>',
}

/**
 * File extension -> icon SVG.
 * @param ext - File extension (case-insensitive).
 * @returns An inline SVG string for the matching icon (generic file icon as fallback).
 */
export function fileIcon(ext: string): string {
  const e = (ext || '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(e)) return iconSvg(ICON_PATHS.image)
  if (['mp3', 'wav', 'm4a', 'flac', 'aac', 'silk'].includes(e)) return iconSvg(ICON_PATHS.music)
  if (['mp4', 'mov', 'avi', 'mkv', 'm4v'].includes(e)) return iconSvg(ICON_PATHS.video)
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return iconSvg(ICON_PATHS.archive)
  if (['doc', 'docx', 'wps'].includes(e)) return iconSvg(ICON_PATHS.file)
  if (['xls', 'xlsx', 'csv'].includes(e)) return iconSvg(ICON_PATHS.sheet)
  if (['ppt', 'pptx'].includes(e)) return iconSvg(ICON_PATHS.present)
  if (['pdf'].includes(e)) return iconSvg(ICON_PATHS.file)
  if (['apk', 'exe', 'msi'].includes(e)) return iconSvg(ICON_PATHS.gear)
  return iconSvg(ICON_PATHS.file)
}
