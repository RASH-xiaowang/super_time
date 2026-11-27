/**
 * 自定义工具「调用名」的生成与校验（2026-11-24）。
 *
 * ## 为什么单独一个纯函数模块
 *
 * 调用名是模型唯一能看到并使用的标识，规则必须与后端 `validateCustomTool` 完全一致：
 * 小写字母开头、3–49 位小写字母/数字/下划线。把它写成纯函数就能被单测逐格喂，
 * 而不是等用户点了「创建」才在抽屉底部收到一句红字。
 *
 * ## 为什么要「自动生成」
 *
 * 用户填的是中文名称（「最近三个月转账」），而调用名必须是 ASCII。要求用户自己想一个
 * 英文标识是没必要的摩擦 —— 中文名称无法音译时用 `tool_<4位哈希>`（同名不同标题不会撞），
 * 用户想改也随时能改。
 *
 * @module panels/local-tool-name
 */

/** 与后端 `validateCustomTool` 的 `NAME_RE` 一致。 */
const NAME_RE = /^[a-z][a-z0-9_]{2,48}$/
/** 自动生成时最长留多少字符（给去重后缀留空间）。 */
const SUGGEST_MAX = 40

/**
 * 这份输入是否已经是合法的调用名。
 * @param name - 候选名。
 * @returns 合法为 true。
 */
export function isValidToolName(name: string): boolean {
  return NAME_RE.test(name.trim())
}

/**
 * 名字不合法时的原因（合法时返回空串，界面据此决定显不显示提示）。
 * @param name - 候选名。
 * @returns 面向用户的一句话；空串表示没有意见。
 */
export function toolNameHint(name: string): string {
  const raw = name.trim()
  if (raw === '') return '还需要一个调用名（可以点「自动生成」）'
  if (raw.length < 3) return '至少 3 个字符'
  if (raw.length > 49) return '最多 49 个字符'
  if (!/^[a-z]/.test(raw)) return '要以小写字母开头'
  if (!NAME_RE.test(raw)) return '只能用小写字母、数字和下划线'
  return ''
}

/** 字符串的 32 位哈希（djb2；只用于生成可读后缀，不做安全用途）。 */
function shortHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return hash.toString(16).padStart(8, '0').slice(0, 4)
}

/**
 * 由显示名称生成一个可用的调用名（保证合法且不与被占用的名字重复）。
 *
 * 纯中文标题无法音译，退化成 `tool_<哈希>` —— 确定性的（同一个标题每次生成同一个），
 * 且不同标题几乎不会相撞；万一撞了再加 `_2`/`_3`。
 * @param title - 工具的显示名称。
 * @param taken - 已被占用的调用名（内置工具 + 已有自定义工具）。
 * @returns 合法且未被占用的调用名。
 */
export function suggestToolName(title: string, taken: ReadonlySet<string> = new Set()): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SUGGEST_MAX)
  // 纯数字/空串/太短都不可用；中文标题会走到这里。
  const base = /^[a-z]/.test(slug) && slug.length >= 3 ? slug : `tool_${shortHash(title.trim())}`
  if (!taken.has(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, SUGGEST_MAX - 3)}_${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_x`
}
