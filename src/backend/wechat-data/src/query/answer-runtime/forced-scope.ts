/**
 * schema 必填校验前的「会话锁定字段」注入。
 *
 * 大部分会话类工具用 `username`，通话用 `peer`，群资料用 `group`。只映射真正
 * 参与执行范围校验的字段；工具自己的展示/筛选参数不在这里猜。
 *
 * @module query/answer-runtime/forced-scope
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 工具名到「会话锁定字段」的映射（字段 → 取值来源）。 */
function forcedScopeFieldValues(name: string): Readonly<Record<string, string>> {
  if (name === 'get_call_history') return { peer: 'username' }
  if (name === 'get_group_detail') return { group: 'username' }
  return { username: 'username' }
}

/**
 * schema 必填校验发生在 `enforceProfileScope` 之前，必须先注入强制会话。
 *
 * 否则模型漏填 `get_group_detail.group` 时会先报「缺少必填参数」，
 * 永远走不到 profile 守卫的自动补齐逻辑。这里只补空值：模型显式写了别的
 * 会话/群/对方时必须保留原值，交给守卫返回 `scope_violation`，不能静默改写。
 *
 * @param name - 工具名。
 * @param parameters - 工具 schema。
 * @param raw - 模型原始参数。
 * @param lockedUsername - 当前锁定的会话 username（没有锁定时为 undefined）。
 * @returns 已注入锁定字段的参数（无法注入时原样返回）。
 */
export function withForcedScope(
  name: string,
  parameters: Record<string, unknown>,
  raw: unknown,
  lockedUsername: string | undefined,
): unknown {
  if (lockedUsername === undefined) return raw
  const properties = isRecord(parameters['properties']) ? parameters['properties'] : {}
  const inject: Record<string, string> = {}
  for (const [field, source] of Object.entries(forcedScopeFieldValues(name))) {
    if (source === 'username' && Object.prototype.hasOwnProperty.call(properties, field)) {
      inject[field] = lockedUsername
    }
  }
  if (Object.keys(inject).length === 0) return raw
  const base = raw === null || raw === undefined
    ? {}
    : isRecord(raw)
      ? raw
      : undefined
  if (!base) return raw
  const next: Record<string, unknown> = { ...base }
  for (const [field, value] of Object.entries(inject)) {
    const existing = next[field]
    const empty = existing === undefined
      || existing === null
      || (typeof existing === 'string' && existing.trim() === '')
    if (empty) next[field] = value
  }
  return next
}
