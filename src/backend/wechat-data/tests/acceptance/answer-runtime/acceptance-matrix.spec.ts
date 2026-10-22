// @vitest-environment node
/**
 * 验收矩阵的元测试：防止文档漂移。
 *
 * 矩阵是给三条问答入口共用的验收契约。若 profile 增减、异常名改动或阈值被
 * 删掉，这里必须先红，而不是等到运行时跑出一条“看起来还行”的答案。
 */
import { describe, expect, it } from 'vitest'
import matrix from './acceptance-matrix.json'

interface MatrixCell {
  profile: string
  anomaly: string
  requestStatus: string
  answerStatus: string
  fallbackStatus: string | null
  statusSelector: string
  expectedEvidenceState: string
  assertionFields: string[]
  acceptance: string
}

interface KnownRuntimeGap {
  id: string
  kind: string
  profiles: string[]
  anomalies: string[]
  currentObserved: string
  target: {
    requestStatus: string
    answerStatus: string
    fallbackStatus: string | null
  }
  expectedApi: string
  assertionFields: string[]
}

interface Threshold {
  operator: string
  value: number
  unit: string
}

interface AcceptanceMatrix {
  version: number
  statusSemantics: Record<string, { meaning: string, values: unknown[] }>
  profiles: Record<string, {
    dataScope: string
    allowedTools: string[]
    forbiddenTools: string[]
    sessionScope: string
    kbMode: string
  }>
  anomalies: Record<string, {
    requestStatus: string
    answerStatus: string
    fallbackStatus: string | null
    expectedEvidenceState: string
    statusRule: string
    mustNotBeStatuses: string[]
  }>
  matrix: MatrixCell[]
  thresholds: Record<string, Threshold>
  thresholdEvaluation: {
    status: string
    note: string
  }
  knownRuntimeGaps: KnownRuntimeGap[]
}

const data = matrix as unknown as AcceptanceMatrix
const profileIds = ['wechat-ask', 'session-ask', 'clawbot-auto'] as const
const anomalyIds = [
  'empty',
  'tool_error',
  'tool_timeout',
  'scope_violation',
  'invalid_arguments',
  'malformed_result',
] as const
const answerStatuses = [
  'ok',
  'degraded',
  'insufficient',
  'needs_clarification',
  'failed',
  'blocked',
] as const
const statusSelectors = [
  'answerStatus',
  'answerStatus-with-evidence-else-fallbackStatus',
] as const

describe('问答运行时验收矩阵', () => {
  it('显式定义请求门禁、回答状态与兜底状态的语义', () => {
    expect(data.version).toBe(2)
    expect(data.statusSemantics['requestStatus']?.values).toEqual(['accepted', 'blocked'])
    expect(data.statusSemantics['answerStatus']?.values).toEqual([...answerStatuses])
    expect(data.statusSemantics['fallbackStatus']?.values).toEqual([...answerStatuses, null])
    for (const semantics of Object.values(data.statusSemantics)) {
      expect(semantics.meaning.length).toBeGreaterThan(12)
    }
  })

  it('恰好覆盖三个 profile × 六类异常，且没有重复格', () => {
    expect(Object.keys(data.profiles).sort()).toEqual([...profileIds].sort())
    expect(Object.keys(data.anomalies).sort()).toEqual([...anomalyIds].sort())
    expect(data.matrix).toHaveLength(profileIds.length * anomalyIds.length)

    const cells = new Set(data.matrix.map(cell => `${cell.profile}\u0000${cell.anomaly}`))
    expect(cells.size).toBe(data.matrix.length)
    for (const profile of profileIds) {
      for (const anomaly of anomalyIds) {
        expect(cells.has(`${profile}\u0000${anomaly}`), `缺少矩阵格 ${profile}/${anomaly}`).toBe(true)
      }
    }
  })

  it('每格同时声明请求安全状态、回答状态与兜底状态，且与异常定义一致', () => {
    for (const cell of data.matrix) {
      const anomaly = data.anomalies[cell.anomaly]
      expect(anomaly, `未知异常 ${cell.anomaly}`).toBeDefined()
      if (!anomaly) continue
      const label = `${cell.profile}/${cell.anomaly}`
      expect(['accepted', 'blocked']).toContain(cell.requestStatus)
      expect(answerStatuses).toContain(cell.answerStatus)
      if (cell.fallbackStatus !== null) {
        expect(answerStatuses).toContain(cell.fallbackStatus)
      }
      expect(statusSelectors).toContain(cell.statusSelector)

      expect(cell.requestStatus, `${label} requestStatus 漂移`).toBe(anomaly.requestStatus)
      expect(cell.answerStatus, `${label} answerStatus 漂移`).toBe(anomaly.answerStatus)
      expect(cell.fallbackStatus, `${label} fallbackStatus 漂移`).toBe(anomaly.fallbackStatus)
      expect(cell.expectedEvidenceState, `${label} 证据状态漂移`).toBe(anomaly.expectedEvidenceState)
      expect(anomaly.mustNotBeStatuses).not.toContain(cell.answerStatus)
      if (cell.fallbackStatus !== null) {
        expect(anomaly.mustNotBeStatuses).not.toContain(cell.fallbackStatus)
      }
      expect(anomaly.statusRule.length, `${cell.anomaly} 未解释状态选择规则`).toBeGreaterThan(12)
      expect(cell.assertionFields, `${label} 未声明断言字段`).toEqual(
        expect.arrayContaining(['requestStatus', 'finalStatus']),
      )
      expect(cell.acceptance.length, `${cell.profile}/${cell.anomaly} 的验收说明为空`).toBeGreaterThan(12)
    }
  })

  it('请求安全阻断与最终回答状态使用不同口径，不允许互相顶替', () => {
    for (const cell of data.matrix) {
      const label = `${cell.profile}/${cell.anomaly}`
      if (cell.requestStatus === 'blocked') {
        expect(cell.answerStatus, `${label} 的来源拒绝必须同时是回答阻断`).toBe('blocked')
        expect(cell.fallbackStatus, `${label} 的阻断不得伪装成兜底成功`).toBeNull()
        expect(cell.statusSelector, `${label} 的阻断应直接断言 answerStatus`).toBe('answerStatus')
      }
      if (cell.anomaly === 'empty') {
        expect(cell.requestStatus, `${label} 的空结果不是请求阻断`).toBe('accepted')
        expect(cell.answerStatus, `${label} 的纯空结果必须如实为 insufficient`).toBe('insufficient')
        expect(cell.fallbackStatus, `${label} 的纯空结果没有失败兜底`).toBeNull()
      }
      if (cell.anomaly === 'tool_error' || cell.anomaly === 'tool_timeout') {
        expect(cell.answerStatus, `${label} 有可用证据时应为 degraded`).toBe('degraded')
        expect(cell.fallbackStatus, `${label} 全部失败且无证据时必须如实为 failed`).toBe('failed')
        expect(cell.statusSelector, `${label} 必须按证据情况选择最终状态`).toBe(
          'answerStatus-with-evidence-else-fallbackStatus',
        )
      }
      if (cell.anomaly === 'scope_violation') {
        expect(cell.requestStatus, `${label} 的越权必须在请求层阻断`).toBe('blocked')
      }
    }
  })

  it('ClawBot 的矩阵格固定 kb-only，且白名单与 profile contract 一致', () => {
    const clawbot = data.profiles['clawbot-auto']
    expect(clawbot).toBeDefined()
    if (!clawbot) return
    expect(clawbot.dataScope).toBe('kb-only')
    expect(clawbot.allowedTools).toEqual(['search_kb'])
    expect(clawbot.sessionScope).toBe('none')
    expect(clawbot.kbMode).toBe('required')
    for (const cell of data.matrix.filter(item => item.profile === 'clawbot-auto')) {
      // 每格必须至少点名知识库、search_kb 或“不得回退到消息工具”三者之一。
      expect(cell.acceptance).toMatch(/知识库|search_kb|消息工具/)
      expect(cell.acceptance).not.toContain('全库检索')
    }
  })

  it('六个异常都有可执行阈值，不是只有文字说明', () => {
    const required = [
      'intentScopeAccuracy',
      'sessionCrossScopeLeaks',
      'toolTop1Accuracy',
      'argumentValidationPassRate',
      'argumentAutoRepairRate',
      'recallAt20RelativeImprovement',
      'mrrRelativeImprovement',
      'aggregateSqlParity',
      'citationAccuracy',
      'unsupportedHighRiskValueRate',
      'zeroEvidenceFabrication',
      'coreferenceAccuracy',
      'sixAnomalyCoverage',
      'toolLoopP95Ms',
      'latencyRegression',
      'clawbotCitationViolations',
      'evidenceKeyStability',
      'profileWhitelistExactness',
    ]
    for (const name of required) {
      const threshold = data.thresholds[name]
      expect(threshold, `缺少阈值 ${name}`).toBeDefined()
      if (!threshold) continue
      expect(['>=', '<=', '=']).toContain(threshold.operator)
      expect(Number.isFinite(threshold.value)).toBe(true)
      expect(threshold.unit.length).toBeGreaterThan(0)
    }
    expect(data.thresholds['sixAnomalyCoverage']?.value).toBe(1)
    expect(data.thresholds['sessionCrossScopeLeaks']?.value).toBe(0)
    expect(data.thresholds['zeroEvidenceFabrication']?.value).toBe(0)
    expect(data.thresholds['clawbotCitationViolations']?.value).toBe(0)
  })

  it('质量阈值明确标记为尚未实测，且不以 pendingRuntime 掩盖缺口', () => {
    expect(data.thresholdEvaluation.status).toBe('not-measured')
    expect(data.thresholdEvaluation.note).toMatch(/尚未|没有|不能宣称|不等同|不等于/)
    expect('pendingRuntime' in data).toBe(false)
    expect(data.knownRuntimeGaps.length).toBeGreaterThan(0)
  })

  it('每个已知缺口都有目标状态和可执行断言，且不能与矩阵目标冲突', () => {
    const cells = new Map(data.matrix.map(cell => [`${cell.profile}\u0000${cell.anomaly}`, cell]))
    const ids = new Set<string>()
    for (const gap of data.knownRuntimeGaps) {
      expect(ids.has(gap.id), `重复缺口 ${gap.id}`).toBe(false)
      ids.add(gap.id)
      expect(gap.currentObserved.length, `${gap.id} 未描述现状`).toBeGreaterThan(12)
      expect(gap.expectedApi.length, `${gap.id} 未说明期望接口`).toBeGreaterThan(12)
      expect(['runtime', 'test-sync']).toContain(gap.kind)
      expect(gap.profiles.length, `${gap.id} 未绑定 profile`).toBeGreaterThan(0)
      expect(gap.anomalies.length, `${gap.id} 未绑定异常类型`).toBeGreaterThan(0)
      expect(gap.assertionFields).toEqual(expect.arrayContaining(['requestStatus', 'finalStatus']))
      for (const profile of gap.profiles) {
        expect(profileIds).toContain(profile)
        for (const anomaly of gap.anomalies) {
          expect(anomalyIds).toContain(anomaly)
          const cell = cells.get(`${profile}\u0000${anomaly}`)
          expect(cell, `${gap.id} 指向不存在的矩阵格 ${profile}/${anomaly}`).toBeDefined()
          if (!cell) continue
          expect(gap.target.requestStatus, `${gap.id} 与矩阵 requestStatus 冲突`).toBe(cell.requestStatus)
          expect(gap.target.answerStatus, `${gap.id} 与矩阵 answerStatus 冲突`).toBe(cell.answerStatus)
          expect(gap.target.fallbackStatus, `${gap.id} 与矩阵 fallbackStatus 冲突`).toBe(cell.fallbackStatus)
        }
      }
    }
  })
})
