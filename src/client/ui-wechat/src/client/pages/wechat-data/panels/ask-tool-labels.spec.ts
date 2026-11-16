/**
 * 问答运行过程工具中文名的共享映射。
 *
 * 微信问答与会话内 AI 问答共用同一份映射；新增工具必须在这里补齐，否则
 * 运行过程会暴露英文工具名。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { ASK_TOOL_LABELS, askToolNameLabel } from './ask-tool-labels.ts'

describe('askToolNameLabel：新增工具的中文名', () => {
  it.each([
    ['get_funds_summary', '转账/红包汇总'],
    ['get_call_history', '通话记录'],
    ['get_group_detail', '群资料'],
    ['search_revoked', '撤回检索'],
    ['aggregate_media', '媒体盘点'],
    ['get_moments_stats', '朋友圈统计'],
  ])('%s → %s', (tool, label) => {
    expect(askToolNameLabel(tool)).toBe(label)
    expect(ASK_TOOL_LABELS[tool]).toBe(label)
  })
})

describe('askToolNameLabel：既有工具文案保持不变', () => {
  it.each([
    ['search_messages', '消息检索'],
    ['get_session_messages', '读取会话消息'],
    ['search_contacts', '联系人检索'],
    ['search_moments', '朋友圈检索'],
    ['search_records', '转账/红包检索'],
    ['search_kb', '知识库检索'],
  ])('%s → %s', (tool, label) => {
    expect(askToolNameLabel(tool)).toBe(label)
  })
})

describe('askToolNameLabel：未知与空值', () => {
  it('未知工具原样返回，不把新工具藏起来', () => {
    expect(askToolNameLabel('future_tool')).toBe('future_tool')
  })

  it('空值返回 undefined，由调用方决定兜底文案', () => {
    expect(askToolNameLabel(undefined)).toBeUndefined()
    expect(askToolNameLabel('')).toBeUndefined()
  })
})
