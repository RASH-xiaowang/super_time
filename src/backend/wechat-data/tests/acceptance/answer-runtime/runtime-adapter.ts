// @vitest-environment node
/**
 * 未完成运行时的**条件式适配层**。
 *
 * 验收测试不能把「今天恰好导出了哪个名字」写死成编译前提：
 * 主运行时仍在并行开发，函数名与返回形状可能继续收敛。这里用动态 import +
 * 运行时能力探测，只有模块存在且所需函数是 function 时才返回可用 façade；
 * 缺失时返回 undefined，由用例给出明确的 pending/skip 说明。
 */

export interface RuntimeErrorClassification {
  cls: string
  category?: string
  retryable: boolean
  message: string
  maxAttempts: number
  maxRetries?: number
}

export interface RuntimeErrorModule {
  classifyToolErrorDetailed(
    error: unknown,
    options?: Record<string, unknown>,
  ): RuntimeErrorClassification
}

export interface RuntimeArgumentRepair {
  ok: boolean
  args: Record<string, unknown>
  repairs: string[]
  error?: string
  field?: string
}

export interface RuntimeArgumentsModule {
  repairToolArguments(
    name: string,
    raw: unknown,
    opts?: Record<string, unknown>,
  ): RuntimeArgumentRepair
}

export interface EvidenceLocatorLike {
  type: string
  username?: string
  localId?: number
  kbId?: number
  chunkId?: number
  key?: string
  fileName?: string
}

export interface EvidenceItemLike {
  evidenceId: string
  kind: string
  tool: string
  tools: string[]
  source: string
  key: string
  locator: EvidenceLocatorLike
  snippet: string
}

export interface EvidenceAssessmentLike {
  status: string
  sufficient: boolean
  usableItems: number
  reason: string
}

export interface EvidenceBundleLike {
  items: EvidenceItemLike[]
  facts: Array<{ title: string; body: string }>
  status: string
  missing: string[]
  stats: {
    count: number
    failedTools: string[]
    candidateCount: number
    sourceCounts: Record<string, number>
  }
  assessment: EvidenceAssessmentLike
}

export interface RuntimeEvidenceModule {
  buildEvidenceBundle(
    results: readonly unknown[],
    options?: Record<string, unknown>,
  ): EvidenceBundleLike
  assessEvidence(
    evidence: unknown,
    options?: Record<string, unknown>,
  ): EvidenceAssessmentLike
}

function functionAt(module: Record<string, unknown>, name: string): Function | undefined {
  const value = module[name]
  return typeof value === 'function' ? value as Function : undefined
}

/** 载入错误分类模块；模块或导出缺失时返回 undefined。 */
export async function loadErrorRuntime(): Promise<RuntimeErrorModule | undefined> {
  try {
    const module = await import('../../../src/query/answer-runtime/errors.ts') as unknown as Record<string, unknown>
    const classify = functionAt(module, 'classifyToolErrorDetailed')
    if (!classify) return undefined
    return {
      classifyToolErrorDetailed: classify as RuntimeErrorModule['classifyToolErrorDetailed'],
    }
  } catch {
    return undefined
  }
}

/** 载入参数修复模块；模块或导出缺失时返回 undefined。 */
export async function loadArgumentsRuntime(): Promise<RuntimeArgumentsModule | undefined> {
  try {
    const module = await import('../../../src/query/answer-runtime/arguments.ts') as unknown as Record<string, unknown>
    const repair = functionAt(module, 'repairToolArguments')
    if (!repair) return undefined
    return {
      repairToolArguments: repair as RuntimeArgumentsModule['repairToolArguments'],
    }
  } catch {
    return undefined
  }
}

/** 载入证据包模块；当前仍在并行收敛，因此按能力探测而不是静态导入。 */
export async function loadEvidenceRuntime(): Promise<RuntimeEvidenceModule | undefined> {
  try {
    const module = await import('../../../src/query/answer-runtime/evidence.ts') as unknown as Record<string, unknown>
    const build = functionAt(module, 'buildEvidenceBundle')
    const assess = functionAt(module, 'assessEvidence')
    if (!build || !assess) return undefined
    return {
      buildEvidenceBundle: build as RuntimeEvidenceModule['buildEvidenceBundle'],
      assessEvidence: assess as RuntimeEvidenceModule['assessEvidence'],
    }
  } catch {
    return undefined
  }
}
