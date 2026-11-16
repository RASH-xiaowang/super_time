import { describe, expect, it } from 'vitest'
import type { MessageListRecord, MessageListSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import {
  EMPTY_MESSAGE_LIST_WINDOW,
  MESSAGE_LIST_PAGE_SIZE,
  MESSAGE_LIST_WINDOW_MAX,
  aiReplyPhase,
  appendMessageListWindow,
  batchDeleteEligibility,
  batchResendEligibility,
  findExactRuleForRecord,
  isAiReplyWaitingForWebhook,
  isBatchSelectable,
  mergeMessageListRecordUpdates,
  mergeMessageListRefresh,
  messageListFailureCopy,
  messageListRecordStatusHint,
  messageListRecordStatusLabel,
  nextMessageListPageSize,
  replaceMessageListWindow,
  ruleFormForRecord,
  type MessageListWindowState,
} from './message-list-view.ts'

function record(id: number, triggeredAt: number, status: MessageListRecord['status'] = 'pending'): MessageListRecord {
  return {
    id,
    replyId: 'reply-' + String(id),
    chatName: '会话 ' + String(id),
    targetName: '对象 ' + String(id),
    text: '消息 ' + String(id),
    images: [],
    triggeredAt,
    source: 'manual',
    status,
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: '',
    error: '',
    attempts: 0,
    createdAt: triggeredAt,
    updatedAt: triggeredAt,
  }
}

function snapshot(
  items: MessageListRecord[],
  total: number,
  options: Partial<Pick<MessageListSnapshot, 'hasMore' | 'nextCursor' | 'truncated'>> = {},
): MessageListSnapshot {
  return { items, total, ...options }
}

describe('消息列表有界窗口', () => {
  it('首屏按复合顺序去重，刷新不会保留旧筛选窗口', () => {
    const first = replaceMessageListWindow(snapshot(
      [record(1, 100), record(3, 200), record(2, 200), record(3, 200)],
      4,
      { hasMore: true, nextCursor: 'page-2' },
    ))
    expect(first.items.map((item) => item.id)).toEqual([3, 2, 1])
    expect(first).toMatchObject({
      total: 4,
      hasMore: true,
      nextCursor: 'page-2',
      windowCapped: false,
    })
  })

  it('续页按 id 去重并按 triggeredAt/id 排序，重复时间戳不跳不重', () => {
    const current = replaceMessageListWindow(snapshot(
      [record(9, 300), record(8, 300), record(7, 200)],
      10,
      { hasMore: true, nextCursor: 'cursor-old' },
    ))
    const next = appendMessageListWindow(current, snapshot(
      [record(8, 300), record(6, 200), record(5, 200), record(4, 100)],
      10,
      { hasMore: true, nextCursor: 'cursor-next' },
    ))
    expect(next.items.map((item) => item.id)).toEqual([9, 8, 7, 6, 5, 4])
    expect(new Set(next.items.map((item) => item.id)).size).toBe(next.items.length)
    expect(next.nextCursor).toBe('cursor-next')
  })

  it('数据窗口有 2,000 条硬上界，达到后停止请求下一页', () => {
    const items = Array.from({ length: MESSAGE_LIST_WINDOW_MAX }, (_value, index) => (
      record(10_000 - index, 1_700_000_000_000 + index)
    ))
    const full = replaceMessageListWindow(snapshot(
      items,
      MESSAGE_LIST_WINDOW_MAX + 1,
      { hasMore: true, nextCursor: 'after-window' },
    ))
    expect(full.items).toHaveLength(MESSAGE_LIST_WINDOW_MAX)
    expect(full.windowCapped).toBe(true)
    expect(full.hasMore).toBe(false)
    expect(nextMessageListPageSize(full.items.length)).toBe(0)
  })

  it('100k 行只保留窗口上界，重复续页保持线性窗口成本', () => {
    let window = replaceMessageListWindow(snapshot([], 100_000, {
      hasMore: true,
      nextCursor: 'c0',
    }))
    const startedAt = performance.now()
    for (let page = 0; page < 500; page += 1) {
      const items = Array.from({ length: MESSAGE_LIST_PAGE_SIZE }, (_value, index) => {
        const id = 100_000 - page * MESSAGE_LIST_PAGE_SIZE - index
        return record(id, 1_700_000_000_000 - page * MESSAGE_LIST_PAGE_SIZE - index)
      })
      window = appendMessageListWindow(window, snapshot(items, 100_000, {
        hasMore: true,
        nextCursor: 'c' + String(page + 1),
      }))
    }
    const elapsedMs = performance.now() - startedAt
    console.log(
      '[MESSAGE_LIST_WINDOW_SCALE] rows=100000 pages=500'
        + ' retained=' + String(window.items.length)
        + ' elapsedMs=' + elapsedMs.toFixed(1),
    )
    expect(window.items).toHaveLength(MESSAGE_LIST_WINDOW_MAX)
    expect(new Set(window.items.map((item) => item.id)).size).toBe(MESSAGE_LIST_WINDOW_MAX)
  })

  it('静默刷新合并第一页并保留深页游标，不把当前窗口缩回一页', () => {
    const current = {
      ...EMPTY_MESSAGE_LIST_WINDOW,
      items: [record(8, 800), record(7, 700)],
      total: 20,
      nextCursor: 'deep-cursor',
      hasMore: true,
    }
    const next = mergeMessageListRefresh(current, snapshot(
      [record(9, 900), record(8, 800), record(6, 600)],
      21,
      { hasMore: true, nextCursor: 'first-page-cursor' },
    ))
    expect(next.items.map((item) => item.id)).toEqual([9, 8, 7, 6])
    expect(next.nextCursor).toBe('deep-cursor')
    expect(next.hasMore).toBe(true)
  })

  it('满 2,000 条静默刷新不挤掉尾部，只更新与第一页重叠的记录', () => {
    const currentItems = Array.from({ length: MESSAGE_LIST_WINDOW_MAX }, (_value, index) => (
      record(3_000 - index, 1_700_000_000_000 + 3_000 - index)
    ))
    const current = {
      ...EMPTY_MESSAGE_LIST_WINDOW,
      items: currentItems,
      total: 5_000,
      nextCursor: 'after-1001',
      hasMore: false,
      windowCapped: true,
    }
    const firstPage = Array.from({ length: MESSAGE_LIST_PAGE_SIZE }, (_value, index) => {
      const id = 3_000 + 1 - index
      return record(id, 1_700_000_000_000 + id, id === 3_000 ? 'success' : 'pending')
    })

    const next = mergeMessageListRefresh(current, snapshot(firstPage, 5_001, {
      hasMore: true,
      nextCursor: 'new-first-page',
    }))

    expect(next.items).toHaveLength(MESSAGE_LIST_WINDOW_MAX)
    expect(next.items[0]?.id).toBe(3_000)
    expect(next.items.at(-1)?.id).toBe(1_001)
    expect(next.items.some((item) => item.id === 3_001)).toBe(false)
    expect(next.items[0]?.status).toBe('success')
    expect(next.nextCursor).toBe('after-1001')
    expect(next.hasMore).toBe(false)
    expect(next.windowCapped).toBe(true)
  })

  it('连续静默刷新始终保住满窗尾部，不产生游标断口', () => {
    let current: MessageListWindowState = {
      ...EMPTY_MESSAGE_LIST_WINDOW,
      items: Array.from({ length: MESSAGE_LIST_WINDOW_MAX }, (_value, index) => (
        record(3_000 - index, 1_700_000_000_000 + 3_000 - index)
      )),
      total: 5_000,
      nextCursor: 'after-1001',
      hasMore: false,
      windowCapped: true,
    }
    for (let refresh = 1; refresh <= 3; refresh += 1) {
      const newest = 3_000 + refresh
      const firstPage = Array.from({ length: MESSAGE_LIST_PAGE_SIZE }, (_value, index) => (
        record(newest - index, 1_700_000_000_000 + newest - index)
      ))
      current = mergeMessageListRefresh(current, snapshot(firstPage, 5_000 + refresh, {
        hasMore: true,
        nextCursor: 'new-first-page-' + String(refresh),
      }))
      expect(current.items.at(-1)?.id).toBe(1_001)
      expect(current.nextCursor).toBe('after-1001')
    }
    expect(current.items).toHaveLength(MESSAGE_LIST_WINDOW_MAX)
    expect(current.items.some((item) => item.id > 3_000)).toBe(false)
  })

  it('第一页与深页无重叠时不插入，避免在顶部批次和当前窗口之间造空洞', () => {
    const current = {
      ...EMPTY_MESSAGE_LIST_WINDOW,
      items: Array.from({ length: 800 }, (_value, index) => (
        record(2_000 - index, 1_700_000_000_000 + 2_000 - index)
      )),
      total: 5_000,
      nextCursor: 'after-one-201',
      hasMore: true,
    }
    const firstPage = Array.from({ length: MESSAGE_LIST_PAGE_SIZE }, (_value, index) => (
      record(2_400 - index, 1_700_000_000_000 + 2_400 - index)
    ))

    const next = mergeMessageListRefresh(current, snapshot(firstPage, 5_200, {
      hasMore: true,
      nextCursor: 'after-two-201',
    }))

    expect(next.items.map((item) => item.id)).toEqual(current.items.map((item) => item.id))
    expect(next.nextCursor).toBe('after-one-201')
    expect(next.hasMore).toBe(true)
    expect(next.total).toBe(5_200)
  })

  it('定向刷新只改已加载记录；筛选后缺失的记录会从窗口移除', () => {
    const current = {
      ...EMPTY_MESSAGE_LIST_WINDOW,
      items: [record(9, 900), record(8, 800), record(7, 700)],
      total: 3,
      nextCursor: 'deep-cursor',
      hasMore: true,
    }
    const next = mergeMessageListRecordUpdates(
      current,
      snapshot([record(8, 800, 'success')], 2),
      [8, 7, 100],
    )
    expect(next.items.map((item) => item.id)).toEqual([9, 8])
    expect(next.items.find((item) => item.id === 8)?.status).toBe('success')
    expect(next.total).toBe(3)
    expect(next.nextCursor).toBe('deep-cursor')
    expect(next.hasMore).toBe(true)
  })
})

describe('记录到规则表单的参数带入', () => {
  it('未配置记录会预填会话名和触发对象', () => {
    const item = record(11, 1_793_262_006_439)
    item.chatName = 'ai-微信助理'
    item.targetName = '客户 A'
    item.source = 'ai_reply'
    expect(ruleFormForRecord(item)).toMatchObject({
      chatName: 'ai-微信助理',
      targetName: '客户 A',
      webhookUrl: '',
      enabled: true,
      recordSource: 'ai_reply',
    })
  })

  it('存在精确规则时优先编辑原规则', () => {
    const item = record(11, 1_793_262_006_439)
    const exact = {
      id: 9,
      chatName: item.chatName,
      targetName: item.targetName,
      webhookUrl: 'http://192.0.2.10:17890/webhook/test',
      greetingText: '您好',
      note: '现有规则',
      enabled: false,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(findExactRuleForRecord([exact], item)).toBe(exact)
    expect(ruleFormForRecord(item, exact)).toMatchObject({
      id: 9,
      webhookUrl: exact.webhookUrl,
      enabled: false,
      greetingText: '您好',
      recordSource: 'manual',
    })
  })
})

describe('AI 回复待配置状态', () => {
  it('只有缺少 Webhook 且已有正文的 AI pending 记录显示待配置', () => {
    const waiting = record(21, 1)
    waiting.source = 'ai_reply'
    waiting.status = 'pending'
    waiting.webhookUrl = ''
    expect(isAiReplyWaitingForWebhook(waiting)).toBe(true)
    expect(messageListRecordStatusLabel(waiting)).toBe('待配置')

    waiting.webhookUrl = 'http://192.0.2.10:17890/webhook/***'
    expect(isAiReplyWaitingForWebhook(waiting)).toBe(false)
    expect(messageListRecordStatusLabel(waiting)).toBe('待执行')

    const blank = record(23, 3)
    blank.source = 'ai_reply'
    blank.status = 'pending'
    blank.text = ''
    blank.webhookUrl = ''
    expect(isAiReplyWaitingForWebhook(blank), '空白预约不是“待配置”').toBe(false)

    const manual = record(22, 2)
    expect(messageListRecordStatusLabel(manual)).toBe('待执行')
  })
})

describe('AI 回复阶段判定', () => {
  const BASE = 1_700_000_000_000

  function aiRecord(patch: Partial<MessageListRecord> = {}): MessageListRecord {
    const item = record(41, BASE)
    item.source = 'ai_reply'
    item.status = 'pending'
    item.text = ''
    item.webhookUrl = ''
    item.createdAt = BASE
    item.updatedAt = BASE
    return { ...item, ...patch }
  }

  it('空白预约 10 分钟内为生成中，超时按 createdAt 判为生成停滞', () => {
    const generating = aiRecord()
    expect(aiReplyPhase(generating, BASE + 60_000)).toBe('generating')
    expect(messageListRecordStatusLabel(generating, BASE + 60_000)).toBe('生成中')
    expect(messageListRecordStatusHint(generating, BASE + 60_000)).toBe('模型正在生成，尚无正文')

    // updatedAt 被无关回写刷新过，也不能把已停滞的预约继续显示成生成中。
    const stalled = aiRecord({ updatedAt: BASE + 9 * 60_000 })
    expect(aiReplyPhase(stalled, BASE + 10 * 60_000)).toBe('stalled')
    expect(messageListRecordStatusLabel(stalled, BASE + 10 * 60_000)).toBe('生成停滞')
    expect(messageListRecordStatusHint(stalled, BASE + 10 * 60_000))
      .toBe('超过 10 分钟没有进展，可能已中断')
  })

  it('已有正文但没有发送地址是待配置，而不是生成中', () => {
    const waiting = aiRecord({ text: '在的，怎么了？' })
    expect(aiReplyPhase(waiting, BASE + 60_000)).toBe('waiting_config')
    expect(messageListRecordStatusLabel(waiting, BASE + 60_000)).toBe('待配置')
    expect(messageListRecordStatusHint(waiting, BASE + 60_000))
      .toBe('正文已生成并保存；配置发送地址后自动投递')
  })

  it('失败记录按是否已有正文区分生成失败与发送失败', () => {
    const noText = aiRecord({ status: 'failed', error: '模型调用超时' })
    expect(aiReplyPhase(noText, BASE + 60_000)).toBe('failed_generation')
    expect(messageListRecordStatusLabel(noText, BASE + 60_000)).toBe('生成失败')
    expect(messageListRecordStatusHint(noText, BASE + 60_000)).toBe('模型调用超时')

    const withText = aiRecord({ status: 'failed', text: '已生成但没发出去', error: '连接被拒绝' })
    expect(aiReplyPhase(withText, BASE + 60_000)).toBe('failed_send')
    expect(messageListRecordStatusLabel(withText, BASE + 60_000)).toBe('发送失败')
    expect(messageListRecordStatusHint(withText, BASE + 60_000)).toBe('连接被拒绝')

    const manualFailed = record(42, BASE, 'failed')
    manualFailed.text = ''
    expect(aiReplyPhase(manualFailed, BASE + 60_000)).toBe('other')
    expect(messageListRecordStatusLabel(manualFailed, BASE + 60_000)).toBe('失败')
  })

  it('AI 回复记录一律不可批量勾选删除', () => {
    for (const status of ['pending', 'failed', 'success'] as const) {
      const aiRow = aiRecord({ status, text: '正文' })
      expect(batchDeleteEligibility(aiRow)).toMatchObject({
        eligible: false,
        reason: expect.stringContaining('AI 回复请用专用删除/清理'),
      })
      expect(isBatchSelectable(aiRow)).toBe(false)
    }
    expect(batchDeleteEligibility(record(43, BASE)).eligible).toBe(true)
  })
})

describe('失败文案分层', () => {
  const BASE = 1_700_000_000_000

  function failedRecord(patch: Partial<MessageListRecord>): MessageListRecord {
    return { ...record(51, BASE, 'failed'), source: 'ai_reply', ...patch }
  }

  it('已过期回复给出不补发说明', () => {
    const expired = failedRecord({
      text: '旧问题的回答',
      error: '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题',
    })
    expect(messageListFailureCopy(expired)).toMatchObject({
      title: '这条回复已过期',
      detail: '对方传来更新的消息，系统只回复最新一条；旧问题不会补发',
      hint: '如需回复，请等待新消息',
    })
  })

  it('无发送地址、未生成正文、未确认与兜底各自分层', () => {
    const noAddress = failedRecord({
      text: '正文',
      error: '未匹配到 Webhook：请先在规则配置中为会话名和触发对象设置地址',
    })
    expect(messageListFailureCopy(noAddress)).toMatchObject({
      title: '还没有发送地址',
      detail: '未匹配到 Webhook：请先在规则配置中为会话名和触发对象设置地址',
      hint: '去配置规则',
    })

    const noText = failedRecord({ text: '', error: '模型调用失败' })
    expect(messageListFailureCopy(noText)).toMatchObject({
      title: '没有生成正文',
      detail: '模型没有返回内容',
      hint: '重试只能重新发送已有正文',
    })

    const unconfirmed = failedRecord({
      status: 'sent_unconfirmed',
      text: '正文',
      error: '请求可能已发出，但未收到完整响应',
    })
    expect(messageListFailureCopy(unconfirmed)).toMatchObject({
      title: '发送结果未确认',
      detail: '请求可能已发出，请先在微信核对，避免重复发送',
      hint: '核对后可单条重发',
    })

    const other = failedRecord({ text: '正文', error: '下游返回 500' })
    expect(messageListFailureCopy(other)).toMatchObject({
      title: '操作失败',
      detail: '下游返回 500',
    })
  })
})

describe('下游异步任务状态', () => {
  it('queued/running 显示为处理中，且不能批次重发或删除', () => {
    const queued = record(31, 1, 'queued')
    const running = record(32, 2, 'running')
    expect(messageListRecordStatusLabel(queued)).toBe('已受理·排队')
    expect(messageListRecordStatusLabel(running)).toBe('下游执行中')
    for (const item of [queued, running]) {
      expect(batchResendEligibility(item)).toMatchObject({
        eligible: false,
        reason: expect.stringContaining('下游异步任务'),
      })
      expect(batchDeleteEligibility(item)).toMatchObject({
        eligible: false,
        reason: expect.stringContaining('下游任务'),
      })
    }
  })
})
