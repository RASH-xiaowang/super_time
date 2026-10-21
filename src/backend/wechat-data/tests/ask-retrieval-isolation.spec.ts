// @vitest-environment node
/**
 * 检索阶段的 kb-only 数据面回归。
 *
 * 旧单通道检索是流水线关闭或异常时的回退路径。自动回复使用 `kb-only` 时，
 * 这条回退不得因为配置/异常而重新读取本机微信消息。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retrievalConfigPath } from '../src/query/retrieval/config.ts'

const mocks = vi.hoisted(() => ({
  retrieveAskCitations: vi.fn(),
  runRetrievalPipeline: vi.fn(),
}))

vi.mock('../src/query/ask.ts', () => ({
  retrieveAskCitations: mocks.retrieveAskCitations,
}))

vi.mock('../src/query/retrieval/pipeline.ts', () => ({
  runRetrievalPipeline: mocks.runRetrievalPipeline,
}))

import { runAskRetrieval, type AskRetrievalInput } from '../src/remotes/ask-retrieval.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ask-retrieval-isolation-'))
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  mocks.retrieveAskCitations.mockReset()
  mocks.runRetrievalPipeline.mockReset()
  mocks.retrieveAskCitations.mockReturnValue({
    citations: [{
      name: '李四',
      time: '2026-10-20 10:00',
      snippet: '本机消息',
      username: 'wxid_lisi',
      local_id: 1,
    }],
    chunks: [],
    terms: ['合同'],
    stats: {
      terms: 1,
      probed: 1,
      candidates: 1,
      kept: 1,
      scope: '全库',
      recency: false,
      timeHint: '',
      hintHits: 0,
      chunks: 0,
      windowMessages: 0,
      recall: 'bm25',
    },
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function input(overrides: Partial<AskRetrievalInput> = {}): AskRetrievalInput {
  return {
    decryptedDir: decrypted,
    question: '蓝鲸合同里的验收款是多少',
    plan: { subQueries: ['蓝鲸合同'], from: '', to: '', person: '' },
    scope: {},
    indexNote: '',
    scopeDescText: '仅知识库',
    op: () => {},
    makeEmbedFn: () => undefined,
    embedModelName: () => 'stub-embed',
    makeRerankFn: () => undefined,
    kbModel: () => ({ model: 'stub-rerank' }),
    askKnownEntities: () => [],
    ...overrides,
  }
}

describe('runAskRetrieval：kb-only 阻断 legacy 本机检索', () => {
  it('配置关闭流水线时，kb-only 不回退 retrieveAskCitations', async () => {
    writeFileSync(retrievalConfigPath(decrypted), JSON.stringify({ enabled: false }), 'utf8')
    const op = vi.fn()

    const out = await runAskRetrieval(input({ wechatDataEnabled: false, op }))

    expect(mocks.retrieveAskCitations).not.toHaveBeenCalled()
    expect(out.citations).toEqual([])
    expect(out.terms).toEqual([])
    expect(out.stats.candidates).toBe(0)
    expect(out.stats.scope).toBe('仅知识库')
    expect(op).toHaveBeenCalledWith(
      'task',
      'ask_wechat',
      'skip',
      'retrieval_legacy',
      expect.stringContaining('kb-only'),
    )
  })

  it('流水线异常时，kb-only 仍不进入 legacy 本机检索', async () => {
    mocks.runRetrievalPipeline.mockRejectedValue(new Error('pipeline failed'))
    const op = vi.fn()

    const out = await runAskRetrieval(input({ wechatDataEnabled: false, op }))

    expect(mocks.runRetrievalPipeline).toHaveBeenCalledOnce()
    expect(mocks.retrieveAskCitations).not.toHaveBeenCalled()
    expect(out.citations).toEqual([])
    expect(op).toHaveBeenCalledWith(
      'task',
      'ask_wechat',
      'fail',
      'retrieval_pipeline',
      'pipeline failed',
    )
    expect(op).toHaveBeenCalledWith(
      'task',
      'ask_wechat',
      'skip',
      'retrieval_legacy',
      expect.stringContaining('kb-only'),
    )
  })

  it('对照：手动问答未传 kb-only 时，配置关闭仍按原行为回退', async () => {
    writeFileSync(retrievalConfigPath(decrypted), JSON.stringify({ enabled: false }), 'utf8')

    const out = await runAskRetrieval(input())

    expect(mocks.retrieveAskCitations).toHaveBeenCalledOnce()
    expect(out.citations).toHaveLength(1)
    expect(out.citations[0]?.username).toBe('wxid_lisi')
  })
})
