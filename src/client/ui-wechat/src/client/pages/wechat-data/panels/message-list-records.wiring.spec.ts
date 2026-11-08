// @vitest-environment jsdom
/**
 * 无投递地址的消息不是“没生成”，而是“正文已落库、等待规则”。
 *
 * AI 回复采用先写消息列表、再按规则投递的两阶段流程。没有规则时记录仍是
 * pending，必须把这个状态明确显示出来并给出规则入口，不能让用户误以为
 * 模型没有产出。
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { MessageListRecords } from './message-list-records.tsx'

function aiRecord(): MessageListRecord {
  return {
    id: 11,
    replyId: 'ml-11',
    chatName: 'ai-微信助理',
    targetName: 'ai-微信助理',
    text: '在的，怎么了？',
    images: [],
    triggeredAt: 1_793_262_006_439,
    source: 'ai_reply',
    status: 'pending',
    note: 'AI 回复 · 自动生成',
    chatUsername: 'wxid_peer',
    targetUsername: 'wxid_peer',
    webhookUrl: '',
    error: '未匹配到 Webhook：请先在规则配置中为会话名和触发对象设置地址',
    attempts: 0,
    createdAt: 1_793_262_006_439,
    updatedAt: 1_793_262_011_630,
  }
}

describe('消息列表：未配置投递地址的 AI 回复', () => {
  it('明确显示正文已保存并给出去配置规则的入口', () => {
    const html = renderToStaticMarkup(createElement(MessageListRecords, {
      records: [aiRecord()],
      total: 1,
      stats: { success: 0, failed: 0, pending: 1, queued: 0, running: 0 },
      loading: false,
      readError: '',
      search: '',
      status: 'pending',
      source: 'ai_reply',
      thumbs: {},
      canWrite: true,
      resendingId: null,
      batchBusy: false,
      probeBusyId: null,
      jobBusyId: null,
      onSearchChange: () => {},
      onStatusChange: () => {},
      onSourceChange: () => {},
      onRefresh: () => {},
      onResend: () => {},
      onBatchResend: async () => true,
      onBatchProbe: async () => true,
      onBatchDelete: async () => true,
      onProbe: () => {},
      onQueryJob: () => {},
      onConfigureRule: () => {},
      onConfigureRecordRule: () => {},
    }))

    expect(html).toContain('正文已保存在消息列表')
    expect(html).toContain('待配置')
    expect(html).toContain('去配置规则')
    expect(html).toContain('data-configure-rule="11"')
    expect(html).toContain('配置规则')
    expect(html).toContain('在的，怎么了？')
    expect(html).toContain('>1</span>')
    expect(html).toContain('disabled=""')
  })
})
