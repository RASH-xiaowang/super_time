/**
 * `wechat-args-guard.js` 的类型面（H11 口径：给宿主层 JS 补声明，而不是在调用处写 `any`）。
 *
 * 为什么必须有：这道闸门是 `wechat:call` 唯一的入参关口，它的返回值形状
 * （`{ok:true, value, bytes}` / `{ok:false, code, message}`）**就是**主进程对渲染层的错误契约。
 * 用 `@ts-expect-error` 或 `as any` 咽掉类型，等于让契约随实现漂移 ——
 * 而 `code` 会被面板按字符串分支处理（`ARGS_TYPE`/`ARGS_SIZE`/…）。
 * 形状与 `wechat-args-guard.js` 的 JSDoc 逐条对齐。
 */

/** 结构上界（见实现里的 `ARG_LIMITS` 注释：刻意比「应该」大一个量级，收界要证据）。 */
export interface ArgLimits {
  maxArgs: number
  maxDepth: number
  maxString: number
  maxItems: number
  maxKeys: number
  maxTotalBytes: number
  maxLedgerEntries: number
}

export const ARG_LIMITS: ArgLimits

/** 违规原因（`inspect` 的返回）。 */
export interface Violation {
  code: string
  message: string
}

/** 深查累计器。 */
export interface Acc {
  bytes: number
  nodes: number
}

/** 一次校验的两种结局。 */
export type GuardResult =
  | { ok: true, value: unknown[], bytes: number }
  | ({ ok: false } & Violation)

/**
 * 校验并归一化 `wechat:call` 的参数（非数组当单参数包一层，与旧行为一致）。
 * @param args - 渲染层传来的原始参数。
 */
export function guardCallArgs(args: unknown): GuardResult

/**
 * 深查一个参数值（数组/对象递归、环检测、体积累计）。
 * @param value - 待查的值。
 * @param depth - 当前深度。
 * @param seen - 祖先链。
 * @param acc - 累计器（就地更新）。
 */
export function inspect(value: unknown, depth: number, seen: Set<object>, acc: Acc): Violation | null

/** 一条 `@Remote` 调用的生成信息（只声明本模块用到的部分）。 */
export interface TypertInvocation {
  method: string
  parameters?: Array<{ codec?: { schema?: unknown } }>
}

/** 实现名 → 按位置排好的 zod schema 列表。 */
export function buildSchemaMap(invocations: readonly TypertInvocation[] | undefined): Map<string, unknown[]>

/**
 * 形状档的判定结果。
 *
 * 单看 `verdict` 分支而不是四个变体：调用方（宿主层）只按「要不要拒」与「记不记账」两条走，
 * 而 `message`/`code` 都只在 `mismatch` 时出现 —— 写成判别联合会让每一处读取都要先收窄，
 * 而那些收窄并不带来任何额外的安全（真正的契约是 `code` 有值 ⇒ 已拒绝）。
 */
export interface SchemaVerdict {
  verdict: 'ok' | 'unloaded' | 'no-schema' | 'mismatch'
  /** 仅 `mismatch` 有值：一句能直接读的原因（含字段路径）。 */
  message?: string
  /** 仅「方法在 `enforced` 里且判定不通过」有值：主进程据此拒绝。 */
  code?: string
}

/**
 * 用生成的 schema 判一次参数；`enforced` 里没有的方法只记账不拒绝。
 * @param schemas - `buildSchemaMap` 的产物（null = 表没加载到）。
 * @param implName - 已解析的实现名。
 * @param callArgs - 归一化后的参数数组。
 * @param enforced - 已有真实流量证据的方法名集合。
 */
export function checkSchema(
  schemas: Map<string, unknown[]> | null,
  implName: string,
  callArgs: readonly unknown[],
  enforced: ReadonlySet<string>,
): SchemaVerdict

/** zod issues 是否**只**由多余键造成。 */
export function onlyExtraKeys(issues: Array<{ code?: string }>): boolean

/** 把一条 issue 翻成人能看懂的一行。 */
export function issueText(issues: Array<{ code?: string, path?: Array<string | number>, message?: string }>): string

/** 记一次调用的参数体积（收上界的依据）。 */
export function observe(method: string, bytes: number): void

/** 记一次 zod 影子判定（`null` = 通过）。 */
export function noteSchema(method: string, reason: string | null): void

/** 影子账本快照（进 `info().argGuard`）。 */
export function snapshot(covered: number, total: number): {
  covered: number
  total: number
  uncovered: number
  enforced: string[]
  mismatched: string[]
  largest: Array<{ method: string, maxBytes: number }>
}

/** 复位影子账本（只给单测用）。 */
export function resetLedger(): void
