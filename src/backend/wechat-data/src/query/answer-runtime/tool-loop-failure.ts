import { classifyToolErrorDetailed, type ToolErrorClass } from './errors.ts'
import { getAnswerProfile } from '../tools/profiles.ts'
import type { ToolResult } from '../tools/types.ts'
import type { ToolLoopInput } from './types.ts'

export function failureResult(
  name: string,
  errorCode: NonNullable<ToolResult['errorCode']>,
  error: string,
  details?: Record<string, unknown>,
): ToolResult {
  return {
    tool: name as ToolResult['tool'],
    ok: false,
    error,
    errorCode,
    ...(details ? { errorDetails: details } : {}),
    hits: [],
  }
}

/** 工具把服务端等待建议放在 `errorDetails`；分类器需要它才能尊重限流退避。 */
export function retryAfterOption(result: ToolResult): { retryAfterMs?: number } {
  const details = result.errorDetails
  if (!details) return {}
  for (const key of ['retryAfterMs', 'retry_after_ms']) {
    const value = details[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return { retryAfterMs: value }
    }
  }
  for (const key of ['retryAfterSec', 'retry_after_sec']) {
    const value = details[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return { retryAfterMs: value * 1000 }
    }
  }
  return {}
}

export function classifyFailure(result: ToolResult): { cls: ToolErrorClass; code?: string } {
  const raw = result.errorCode
  if (raw === 'invalid_arguments' || raw === 'unknown_tool') return { cls: 'invalid_arguments', ...(raw ? { code: raw } : {}) }
  if (
    raw === 'scope_violation'
    || raw === 'tool_not_allowed'
    || raw === 'data_scope_blocked'
    || raw === 'scope_required'
    || raw === 'unsupported_scope'
  ) {
    return { cls: 'scope_blocked', ...(raw ? { code: raw } : {}) }
  }
  if (raw === 'not_configured') return { cls: 'not_found', ...(raw ? { code: raw } : {}) }
  const detailed = classifyToolErrorDetailed(result.error ?? '', {
    tool: String(result.tool),
    ...(raw ? { code: raw } : {}),
    ...retryAfterOption(result),
  })
  return { cls: detailed.cls, ...(raw ? { code: raw } : {}) }
}

/** profile 明确声明有副作用的工具不能自动重放，即使错误看起来是瞬时/限流。 */
export function isSideEffectTool(loop: ToolLoopInput, name: string): boolean {
  const profile = typeof loop.profile === 'string' ? getAnswerProfile(loop.profile) : loop.profile
  return (profile.sideEffectTools ?? []).some(tool => String(tool) === name)
}

export function resultHasEvidence(result: ToolResult): boolean {
  return result.ok && (result.hits.length > 0 || (result.facts?.length ?? 0) > 0)
}

export function resultBlockedByScope(result: ToolResult): boolean {
  return !result.ok && classifyFailure(result).cls === 'scope_blocked'
}
