// @vitest-environment jsdom
/**
 * 统一问答运行信息的展示判据。
 *
 * 这些字段是“回答为什么可信”的证据链：状态、工具是否跑过、证据来自哪里、
 * 文件/收藏是不是被伪装成消息引用。旧后端不返回它们时组件必须完全不渲染，
 * 否则会把既有问答界面撑出一块空壳。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskTurn, EvidenceBundle } from './use-ask.ts'
import { AskResources, AskRuntimeMeta, intentLabel } from './AskRuntimeMeta.tsx'

const evidence = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  items: [],
  facts: [],
  status: 'ok',
  missing: [],
  stats: {
    count: 0, messages: 0, kb: 0, sessions: 0, candidateCount: 0, total: 0,
    hitCount: 0, factCount: 0, duplicateCount: 0, droppedByBudget: 0,
    truncated: false, snippetChars: 0, sourceCounts: { msg: 0, kb: 0, agg: 0, resource: 0 },
    toolCounts: {}, failedTools: [], attemptedTools: 0, successfulTools: 0,
  },
  assessment: { status: 'sufficient', sufficient: true, usableItems: 0, reason: '' },
  ...over,
})

const turn = (over: Partial<AskTurn> = {}): AskTurn => ({ role: 'assistant', text: '回答', ...over })
let host: HTMLDivElement
let root: Root

function show(t: AskTurn): void {
  act(() => { root.render(createElement(AskRuntimeMeta, { turn: t })) })
}
function showResources(t: AskTurn): void {
  act(() => { root.render(createElement(AskResources, { turn: t })) })
}
function clickButton(label: string): void {
  const buttons = [...host.querySelectorAll('button')]
  const button = buttons.find(el => el.textContent?.includes(label))
  expect(button, `找不到按钮：${label}`).toBeDefined()
  act(() => { button?.click() })
}
const need = (sel: string): Element => {
  const el = host.querySelector(sel)
  expect(el, `${sel} 没找到`).not.toBeNull()
  return el as Element
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('意图中文映射', () => {
  it('新增枚举与旧枚举都有中文；未知值原样显示', () => {
    expect(intentLabel('lookup')).toBe('查询')
    expect(intentLabel('aggregate')).toBe('聚合统计')
    expect(intentLabel('relation')).toBe('关系/对比')
    expect(intentLabel('timeline')).toBe('时间线')
    expect(intentLabel('content_media')).toBe('内容/媒体')
    expect(intentLabel('open_qa')).toBe('开放问答')
    expect(intentLabel('clarify')).toBe('需要澄清')
    expect(intentLabel('recency_lookup')).toBe('最近查询')
    expect(intentLabel('unknown_new')).toBe('unknown_new')
    expect(intentLabel()).toBe('—')
  })
})

describe('AskRuntimeMeta', () => {
  it('旧后端没有运行时字段时整块不渲染（不撑出空壳）', () => {
    show(turn())
    expect(host.innerHTML).toBe('')
  })

  it('显示状态与原因，默认不展开工具明细', () => {
    show(turn({
      status: 'insufficient',
      statusReason: '没有检索到可用证据',
      toolCalls: [{
        index: 0, round: 1, callId: 'c1', name: 'search_files',
        argumentsSummary: 'query=报价', ok: true, deduplicated: false,
        attempts: 1, retries: 0, elapsedMs: 18, hits: 2, facts: 0,
      }],
    }))
    expect(need('[data-status="insufficient"]').textContent).toContain('证据不足')
    expect(host.textContent).toContain('没有检索到可用证据')
    expect(host.textContent).toContain('工具调用 1 次')
    expect(host.textContent).not.toContain('query=报价')
  })

  it('展开工具后显示轮次、成功/失败、尝试/重试、耗时、命中与错误码', () => {
    show(turn({
      status: 'degraded',
      toolCalls: [{
        index: 0, round: 2, callId: 'c1', name: 'search_messages',
        argumentsSummary: 'query=合同', ok: false, deduplicated: false,
        attempts: 3, retries: 2, elapsedMs: 1200, hits: 0, facts: 0,
        errorCode: 'upstream_failure', errorClass: 'transient',
      }],
    }))
    act(() => { (need('button[aria-expanded="false"]') as HTMLButtonElement).click() })
    expect(host.textContent).toContain('消息检索')
    expect(host.textContent).toContain('第 2 轮')
    expect(host.textContent).toContain('尝试 3 次')
    expect(host.textContent).toContain('重试 2 次')
    expect(host.textContent).toContain('1.2s')
    expect(host.textContent).toContain('upstream_failure · transient')
  })

  it('证据包显示来源统计，资源卡与消息引用分开且不伪装成可点击链接', () => {
    show(turn({
      status: 'ok',
      evidence: evidence({
        items: [{
          evidenceId: 'msg:a:1', kind: 'hit', tool: 'search_messages', tools: ['search_messages'],
          source: 'msg', name: '群聊', time: '2026-10-01 10:00', snippet: '报价单已发',
          key: 'a:1', locator: { type: 'message', username: 'a', localId: 1, key: 'a:1' },
        }],
        stats: {
          ...evidence().stats, count: 1, messages: 1, total: 1, hitCount: 1, sessions: 1,
        },
      }),
      resources: [{
        evidenceId: 'res:1', tool: 'search_files', key: 'file:报价.xlsx', name: '报价.xlsx',
        time: '2026-10-02 12:00', snippet: '18.0 KB',
        locator: {
          type: 'resource', tool: 'search_files', key: 'file:报价.xlsx',
          stableKey: 'file:报价.xlsx', resourceKind: 'file', fileName: '报价.xlsx',
          size: 18_432, category: 'file', session: '项目群',
        },
      }],
    }))
    expect(host.textContent).toContain('证据包')
    expect(host.textContent).toContain('相关资源')
    expect(host.textContent).toContain('独立于消息引用')
    clickButton('相关资源')
    expect(host.textContent).toContain('报价.xlsx')
    expect(host.textContent).toContain('文件')
    expect(host.textContent).toContain('18.0 KB')
    expect(host.textContent).toContain('会话 项目群')
    expect(host.querySelector('a')).toBeNull()
  })

  it('status=ok 但 withheld=true 时不显示绿色已完成，改为未采用警示', () => {
    show(turn({ status: 'ok', withheld: true }))
    const badge = need('[data-status="insufficient"]')
    expect(badge.textContent).toContain('未采用 · 证据不足')
    expect(host.querySelector('[data-status="ok"]')).toBeNull()
    expect(host.textContent).toContain('模型内容未通过接地核对，已不予采用')
  })

  it('旧响应只有 withheld=true 时也能渲染，不依赖 status 字段', () => {
    show(turn({ withheld: true }))
    expect(host.textContent).toContain('未采用 · 证据不足')
    expect(host.textContent).toContain('模型内容未通过接地核对，已不予采用')
  })

  it('资源区默认折叠，展开后资源只出现一次且不渲染内部 key 与敏感字段', () => {
    const resource = {
      evidenceId: 'res:search_files:file-secret',
      tool: 'search_files',
      key: 'file:internal-key',
      name: '报价.xlsx',
      time: '2026-10-02 12:00',
      snippet: '18.0 KB',
      locator: {
        type: 'resource' as const,
        tool: 'search_files',
        key: 'file:internal-key',
        stableKey: 'file:internal-key',
        resourceKind: 'file' as const,
        fileName: '报价.xlsx',
        size: 18_432,
        session: '项目群',
        md5: 'md5-secret-value',
        serverId: 'server-secret-value',
        sourceId: 'source-secret-value',
        timelineId: 'timeline-secret-value',
        transferId: 'transfer-secret-value',
        messageServerId: 'message-server-secret-value',
        mediaId: 'media-secret-value',
        url: 'https://secret.example/a',
        token: 'token-secret-value',
        seed: 'seed-secret-value',
      },
    }
    show(turn({
      status: 'ok',
      resources: [resource, { ...resource }],
      evidence: evidence({
        items: [{
          evidenceId: resource.evidenceId,
          kind: 'hit',
          tool: 'search_files',
          tools: ['search_files'],
          source: 'resource',
          name: resource.name,
          time: resource.time,
          snippet: resource.snippet,
          key: resource.key,
          locator: resource.locator,
        }],
        stats: {
          ...evidence().stats,
          count: 1,
          total: 1,
          hitCount: 1,
          sourceCounts: { msg: 0, kb: 0, agg: 0, resource: 1 },
        },
      }),
    }))
    expect(host.textContent).not.toContain('报价.xlsx')
    clickButton('相关资源')
    expect(host.textContent?.split('报价.xlsx').length).toBe(2)
    expect(host.textContent).not.toContain('internal-key')
    expect(host.textContent).not.toContain('md5-secret-value')
    expect(host.textContent).not.toContain('server-secret-value')
    expect(host.textContent).not.toContain('source-secret-value')
    expect(host.textContent).not.toContain('timeline-secret-value')
    expect(host.textContent).not.toContain('transfer-secret-value')
    expect(host.textContent).not.toContain('message-server-secret-value')
    expect(host.textContent).not.toContain('media-secret-value')
    expect(host.textContent).not.toContain('secret.example')
    expect(host.textContent).not.toContain('token-secret-value')
    expect(host.textContent).not.toContain('seed-secret-value')
    expect(host.textContent).not.toContain('证据包')
  })

  it('统计事实标题不重复，deadlineExceeded 显示为超时', () => {
    show(turn({
      status: 'degraded',
      toolCalls: [{
        index: 0, round: 1, callId: 'slow', name: 'search_messages',
        argumentsSummary: 'query=合同', ok: false, deduplicated: false,
        attempts: 1, retries: 0, elapsedMs: 20_000, hits: 0, facts: 0,
        deadlineExceeded: true, errorCode: 'timeout',
      }],
      evidence: evidence({
        items: [{
          evidenceId: 'fact:1', kind: 'fact', tool: 'aggregate_messages', tools: ['aggregate_messages'],
          source: 'agg', name: '统计', time: '', snippet: '共 3 条', key: 'fact:1',
          locator: { type: 'fact', tool: 'aggregate_messages' },
        }],
        stats: {
          ...evidence().stats,
          count: 1, factCount: 1, total: 1, hitCount: 1,
          sourceCounts: { msg: 0, kb: 0, agg: 1, resource: 0 },
        },
      }),
    }))
    clickButton('工具调用')
    expect(host.textContent).toContain('超时')
    clickButton('证据包')
    expect(host.textContent).toContain('统计事实')
    expect(host.textContent).not.toContain('统计事实 · 统计事实')
  })

  it('缺 items/stats/sourceCounts 与未知 status 时不崩溃，并提供降级文案', () => {
    show(turn({
      status: 'future_status' as never,
      evidence: {
        items: undefined,
        facts: [],
        status: 'ok',
        missing: [],
        stats: undefined,
        assessment: { status: 'sufficient', sufficient: true, usableItems: 0, reason: '' },
      } as unknown as EvidenceBundle,
      resources: [{ evidenceId: 'res:loose' } as never],
    }))
    expect(host.textContent).toContain('未知状态：future_status')
    expect(host.textContent).toContain('相关资源')
  })

  it('独立资源插槽在正文后使用时可单独渲染', () => {
    showResources(turn({
      resources: [{
        evidenceId: 'res:1', tool: 'search_files', key: 'file:a', name: 'A.pdf',
        time: '', snippet: '',
        locator: { type: 'resource', tool: 'search_files', key: 'file:a', resourceKind: 'file' },
      }],
    }))
    expect(host.textContent).toContain('相关资源')
    clickButton('相关资源')
    expect(host.textContent).toContain('A.pdf')
  })
})
