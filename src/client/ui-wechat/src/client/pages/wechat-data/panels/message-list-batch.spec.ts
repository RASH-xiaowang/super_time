// @vitest-environment node
/** 消息列表批量处理的可执行门槛。 */
import { describe, expect, it } from 'vitest'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  batchDeleteEligibility,
  batchProbeEligibility,
  batchResendEligibility,
  isBatchSelectable,
} from './message-list-view.ts'

function record(patch: Partial<MessageListRecord> = {}): MessageListRecord {
  return {
    id: 1,
    replyId: 'ml-1',
    chatName: '会话',
    targetName: '对象',
    text: '正文',
    images: [],
    triggeredAt: 1,
    source: 'ai_reply',
    status: 'pending',
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: '',
    error: '',
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('消息列表批量处理', () => {
  it('只允许待执行和失败记录进入批量重发，空内容不可重发', () => {
    expect(batchResendEligibility(record({ status: 'pending' })).eligible).toBe(true)
    expect(batchResendEligibility(record({ status: 'failed' })).eligible).toBe(true)
    expect(batchResendEligibility(record({ status: 'success' })).eligible).toBe(false)
    expect(batchResendEligibility(record({ text: '', images: [] }))).toMatchObject({
      eligible: false,
    })
  })

  it('投递中与未确认记录禁止自动重发', () => {
    expect(batchResendEligibility(record({ status: 'dispatching' })).eligible).toBe(false)
    expect(batchResendEligibility(record({ status: 'sent_unconfirmed' })).eligible).toBe(false)
  })

  it('删除拦截 AI 回复与投递中的记录；探测仍要求已保存地址', () => {
    const noSnapshot = record({ source: 'manual', webhookUrl: '' })
    expect(batchResendEligibility(noSnapshot).eligible).toBe(true)
    expect(batchProbeEligibility(noSnapshot).eligible).toBe(false)
    expect(batchDeleteEligibility(noSnapshot).eligible).toBe(true)
    expect(isBatchSelectable(noSnapshot)).toBe(true)

    const unconfirmedWithSnapshot = record({
      source: 'manual',
      status: 'sent_unconfirmed',
      webhookUrl: 'https://downstream.example/webhook/***',
    })
    expect(batchResendEligibility(unconfirmedWithSnapshot).eligible).toBe(false)
    expect(batchProbeEligibility(unconfirmedWithSnapshot).eligible).toBe(true)
    expect(batchDeleteEligibility(unconfirmedWithSnapshot).eligible).toBe(true)
    expect(isBatchSelectable(unconfirmedWithSnapshot)).toBe(true)

    expect(batchDeleteEligibility(record({ source: 'manual', status: 'dispatching' })).eligible).toBe(false)
    expect(isBatchSelectable(record({ source: 'manual', status: 'dispatching' }))).toBe(false)
  })

  it('AI 回复一律不可批量勾选删除，改用专用删除/清理', () => {
    for (const status of ['pending', 'failed', 'success', 'sent_unconfirmed'] as const) {
      const aiRow = record({ source: 'ai_reply', status })
      expect(batchDeleteEligibility(aiRow)).toEqual({
        eligible: false,
        reason: 'AI 回复请用专用删除/清理',
      })
      expect(isBatchSelectable(aiRow)).toBe(false)
    }
  })
})
