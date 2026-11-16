// @vitest-environment jsdom
/**
 * 无投递地址的消息不是“没生成”，而是“正文已落库、等待规则”。
 *
 * AI 回复采用先写消息列表、再按规则投递的两阶段流程。没有规则时记录仍是
 * pending，必须把这个状态明确显示出来并给出规则入口，不能让用户误以为
 * 模型没有产出；空白预约则必须显示“生成中/生成停滞”，不能声称正文已保存。
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { MessageListRecords } from './message-list-records.tsx'

type Stats = {
  success: number
  failed: number
  pending: number
  queued: number
  running: number
}

function aiRecord(patch: Partial<MessageListRecord> = {}): MessageListRecord {
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
    ...patch,
  }
}

function renderRecords(
  records: MessageListRecord[],
  stats: Partial<Stats> = {},
): string {
  return renderToStaticMarkup(createElement(MessageListRecords, {
    records,
    total: records.length,
    stats: { success: 0, failed: 0, pending: records.length, queued: 0, running: 0, ...stats },
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
}

describe('消息列表：未配置投递地址的 AI 回复', () => {
  it('明确显示正文已保存并给出去配置规则的入口', () => {
    const html = renderRecords([aiRecord()])

    expect(html).toContain('正文已保存在消息列表')
    expect(html).toContain('待配置')
    expect(html).toContain('去配置规则')
    expect(html).toContain('data-configure-rule="11"')
    expect(html).toContain('配置规则')
    expect(html).toContain('在的，怎么了？')
    expect(html).toContain('>1</span>')
    expect(html).toContain('disabled=""')
  })

  it('空白预约显示生成中，不再声称正文已保存或待配置', () => {
    const now = Date.now()
    const html = renderRecords([aiRecord({
      id: 12,
      replyId: 'ml-12',
      text: '',
      note: '',
      error: '',
      createdAt: now,
      updatedAt: now,
    })], { pending: 1 })

    expect(html).toContain('生成中')
    expect(html).toContain('模型正在生成，尚无正文')
    expect(html).not.toContain('正文已保存在消息列表')
    expect(html).not.toContain('待配置')
    expect(html).not.toContain('data-configure-rule')
  })

  it('备注列只显示失败分层标题，完整原文留在 title 属性', () => {
    const error = '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题'
    const html = renderRecords([aiRecord({
      status: 'failed',
      text: '旧问题的回答',
      error,
      webhookUrl: 'http://192.0.2.10:17890/webhook/***',
    })], { failed: 1 })

    expect(html).toContain('已过期')
    expect(html).toContain('>这条回复已过期</span>')
    expect(html).toContain('对方传来更新的消息')
    expect(html).not.toContain('>' + error + '<')
  })

  it('已过期行不再计入失败数，并标注窗口内排除的条数', () => {
    const html = renderRecords([aiRecord({
      status: 'failed',
      text: '旧问题的回答',
      error: '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题',
      failureKind: 'superseded',
      webhookUrl: 'http://192.0.2.10:17890/webhook/***',
    })], { failed: 1, pending: 0 })

    expect(html).toContain('<b>0</b> 失败 · 当前窗口')
    expect(html).toContain('已排除 1 条已过期')
    expect(html).toContain('已过期')
    expect(html).toContain('>这条回复已过期</span>')
  })

  it('待配置计数只统计已有正文的记录，空白预约单独计入生成中', () => {
    const now = Date.now()
    const html = renderRecords([
      aiRecord({ createdAt: now, updatedAt: now }),
      aiRecord({
        id: 12,
        replyId: 'ml-12',
        text: '',
        note: '',
        error: '',
        createdAt: now,
        updatedAt: now,
      }),
    ], { pending: 2 })

    expect(html).toContain(' / 1 待配置')
    expect(html).toContain('<b>1</b> 生成中')
    expect((html.match(/data-configure-rule=/g) ?? [])).toHaveLength(1)
    expect(html).toContain('1 条 AI 回复还没有投递地址')
  })
})
