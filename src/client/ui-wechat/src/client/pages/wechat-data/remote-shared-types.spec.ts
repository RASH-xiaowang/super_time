/**
 * 跨进程共享类型的负向守卫。
 *
 * 手写 `WechatRemote` 镜像最危险的漂移不是「少了方法」（已有文本守卫），而是
 * 同名类型两边各自声明、悄悄长出不同字段。这里把已收进共享契约的 wire 类型
 * 同时从两端导入并用 `expectTypeOf` 判类型恒等；再扫一次客户端源码，确保这些
 * 类型没有重新长回本地镜像。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AnnualReview,
  FeedbackRecord,
  KbExtractResult,
  KbLinkSuggestResult,
  KbModelConfigResult,
  KbModelConfigView,
  KbVectorBuildWireResult,
  KbVectorIndexView,
  RetrievalConfig,
  RetrievalEvalResult,
  RetrievalStatus,
  VectorBuildResult,
} from '@deepseek-ai/dsh-wechat-data/types'
import type { AnnualReviewShape } from './api-status.ts'
import type {
  RetrievalConfigShape,
  RetrievalEvalResult as ClientRetrievalEvalResult,
  RetrievalFeedbackItem,
  RetrievalStatus as ClientRetrievalStatus,
  VectorBuildResult as ClientVectorBuildResult,
} from './api-config.ts'
import type {
  KbExtractResult as ClientKbExtractResult,
  KbLinkSuggestResult as ClientKbLinkSuggestResult,
  KbModelConfigResult as ClientKbModelConfigResult,
  KbModelConfigView as ClientKbModelConfigView,
  KbVectorBuildResult as ClientKbVectorBuildResult,
  KbVectorIndexView as ClientKbVectorIndexView,
} from './types.ts'

const typesSrc = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const configSrc = readFileSync(new URL('./api-config.ts', import.meta.url), 'utf8')
const statusSrc = readFileSync(new URL('./api-status.ts', import.meta.url), 'utf8')

expectTypeOf<ClientKbVectorIndexView>().toEqualTypeOf<KbVectorIndexView>()
expectTypeOf<ClientKbModelConfigView>().toEqualTypeOf<KbModelConfigView>()
expectTypeOf<ClientKbExtractResult>().toEqualTypeOf<KbExtractResult>()
expectTypeOf<ClientKbLinkSuggestResult>().toEqualTypeOf<KbLinkSuggestResult>()
expectTypeOf<ClientKbModelConfigResult>().toEqualTypeOf<KbModelConfigResult>()
expectTypeOf<ClientKbVectorBuildResult>().toEqualTypeOf<KbVectorBuildWireResult>()

expectTypeOf<RetrievalConfigShape>().toEqualTypeOf<RetrievalConfig>()
expectTypeOf<ClientRetrievalStatus>().toEqualTypeOf<RetrievalStatus>()
expectTypeOf<ClientVectorBuildResult>().toEqualTypeOf<VectorBuildResult>()
expectTypeOf<RetrievalFeedbackItem>().toEqualTypeOf<FeedbackRecord>()
expectTypeOf<ClientRetrievalEvalResult>().toEqualTypeOf<RetrievalEvalResult>()

expectTypeOf<AnnualReviewShape>().toEqualTypeOf<AnnualReview>()

describe('共享 wire 类型没有在客户端长回本地镜像', () => {
  it('KB 类型只从 types.ts 转发共享包', () => {
    for (const name of [
      'KbVectorIndexView',
      'KbModelConfigView',
      'KbExtractResult',
      'KbLinkSuggestResult',
      'KbModelConfigResult',
      'KbVectorBuildResult',
    ]) {
      expect(typesSrc, `types.ts 又把 ${name} 镜像成本地声明了`).not.toMatch(new RegExp(`export (interface|type) ${name}\\b`))
    }
  })

  it('检索层类型只从 api-config.ts 转发共享包', () => {
    for (const name of ['RetrievalConfigShape', 'RetrievalStatus', 'VectorBuildResult', 'RetrievalFeedbackItem', 'RetrievalEvalResult']) {
      expect(configSrc, `api-config.ts 又把 ${name} 镜像成本地声明了`).not.toMatch(new RegExp(`export (interface|type) ${name}\\b`))
    }
  })

  it('年度回顾主形状是共享 AnnualReview 的别名', () => {
    expect(statusSrc, 'api-status.ts 必须转发共享 AnnualReview 而不是本地镜像')
      .toContain('export type AnnualReviewShape = AnnualReview')
    expect(statusSrc).not.toMatch(/export interface AnnualReviewShape\b/)
  })
})
