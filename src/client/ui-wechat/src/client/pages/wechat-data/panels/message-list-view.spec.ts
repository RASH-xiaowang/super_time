import { describe, expect, it } from 'vitest'
import type { MessageListRecord, MessageListSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import {
  AI_REPLY_REGENERATE_WINDOW_MS,
  AI_REPLY_STALLED_MS,
  EMPTY_MESSAGE_LIST_WINDOW,
  MESSAGE_LIST_PAGE_SIZE,
  MESSAGE_LIST_WINDOW_MAX,
  aiReplyDeleteEligibility,
  aiReplyAnyDeleteEligibility,
  aiReplyTerminalDeleteEligibility,
  aiReplyPhase,
  aiReplyRegenerateEligibility,
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

  it('superseded 阶段优先于生成/发送失败，旧错误前缀仍按已过期兜底', () => {
    const superseded = aiRecord({
      status: 'failed',
      text: '旧问题的回答',
      error: '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题',
      failureKind: 'superseded',
    })
    expect(aiReplyPhase(superseded, BASE + 60_000)).toBe('superseded')
    expect(messageListRecordStatusLabel(superseded, BASE + 60_000)).toBe('已过期')
    expect(messageListRecordStatusHint(superseded, BASE + 60_000))
      .toBe('会话已有更新消息，这条按设计不发送')

    // 旧行没有 failureKind 时，错误前缀决定它同样是「已过期」而不是发送失败。
    const legacy = aiRecord({
      status: 'failed',
      text: '旧问题的回答',
      error: '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题',
    })
    expect(aiReplyPhase(legacy, BASE + 60_000)).toBe('superseded')
    expect(messageListRecordStatusLabel(legacy, BASE + 60_000)).toBe('已过期')
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

  it('failureKind 优先映射稳定分类，六种原因各有独立文案', () => {
    const cases: Array<[string, string]> = [
      ['superseded', '这条回复已过期'],
      ['no_webhook', '还没有发送地址'],
      ['generation_failed', '没有生成正文'],
      ['send_failed', '发送失败'],
      ['unconfirmed', '发送结果未确认'],
      ['config_changed', '设置已变更'],
    ]
    for (const [failureKind, title] of cases) {
      const item = failedRecord({
        status: 'failed',
        text: '正文',
        error: '原始错误：' + failureKind,
        failureKind,
      })
      expect(messageListFailureCopy(item).title).toBe(title)
    }
    // kind 优先于错误字符串：即便文本像「未匹配到 Webhook」，仍按 send_failed。
    const preferred = failedRecord({
      status: 'failed',
      text: '正文',
      error: '未匹配到 Webhook',
      failureKind: 'send_failed',
    })
    expect(messageListFailureCopy(preferred)).toMatchObject({
      title: '发送失败',
      detail: '未匹配到 Webhook',
    })
    // 无 kind 的旧行继续保留字符串兜底。
    const legacy = failedRecord({ text: '', error: '模型调用失败' })
    expect(messageListFailureCopy(legacy).title).toBe('没有生成正文')
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

describe('AI 回复的重新生成与专用清理资格', () => {
  const NOW = 1_800_000_000_000

  function aiRecord(
    now: number,
    patch: Partial<MessageListRecord> = {},
  ): MessageListRecord {
    return {
      ...record(51, now, 'failed'),
      source: 'ai_reply',
      text: '',
      images: [],
      webhookUrl: '',
      error: '模型没有返回内容',
      failureKind: 'generation_failed',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...patch,
    }
  }

  it('空白失败、未投递且 24h 内的 AI 回复可以重新生成', () => {
    expect(aiReplyRegenerateEligibility(aiRecord(NOW), NOW)).toEqual({
      eligible: true,
      reason: '',
    })
    for (const failureKind of ['superseded', 'generation_failed', 'config_changed']) {
      expect(aiReplyRegenerateEligibility(
        aiRecord(NOW, { failureKind }),
        NOW,
      ).eligible).toBe(true)
    }
    // 窗口边界：差 1ms 仍可，正好 24h 不可。
    expect(aiReplyRegenerateEligibility(
      aiRecord(NOW, { createdAt: NOW - AI_REPLY_REGENERATE_WINDOW_MS + 1 }),
      NOW,
    ).eligible).toBe(true)
  })

  it('正文、图片、任务、超过 24h 或不支持的分类都会拒绝重新生成并给出原因', () => {
    const cases: Array<[Partial<MessageListRecord>, string]> = [
      [{ text: '已有正文' }, '已有正文'],
      [{ images: [{ url: 'https://example.com/a.png' }] }, '已有正文'],
      [{ jobId: 'jobs/abc' }, '已投递'],
      [{ attempts: 1 }, '尝试'],
      [{ lastAttemptAt: NOW - 1 }, '尝试'],
      [{ webhookUrl: 'http://192.0.2.10:17890/webhook/***' }, '发送地址'],
      [{ createdAt: NOW - AI_REPLY_REGENERATE_WINDOW_MS }, '24 小时'],
      [{ failureKind: 'send_failed' }, '失败类型'],
    ]
    for (const [patch, reason] of cases) {
      const result = aiReplyRegenerateEligibility(aiRecord(NOW, patch), NOW)
      expect(result.eligible, JSON.stringify(patch)).toBe(false)
      expect(result.reason).toContain(reason)
    }
    // 非 AI 来源、非失败状态同样不属于可重新生成类型。
    expect(aiReplyRegenerateEligibility(record(52, NOW, 'failed'), NOW).reason)
      .toContain('AI 回复')
    expect(aiReplyRegenerateEligibility(aiRecord(NOW, { status: 'success' }), NOW).reason)
      .toContain('只有失败')
  })

  it('已投递/未确认的记录不能重新生成，即使正文为空', () => {
    const delivered = aiRecord(NOW, { status: 'running', jobId: 'jobs/abc' })
    expect(aiReplyRegenerateEligibility(delivered, NOW).reason).toContain('已投递')

    const unconfirmed = aiRecord(NOW, {
      status: 'sent_unconfirmed',
      failureKind: 'unconfirmed',
    })
    expect(aiReplyRegenerateEligibility(unconfirmed, NOW).reason).toContain('未确认')
  })

  it('生成中的空白预约不能清理；停滞或失败后才可清理', () => {
    const pending = aiRecord(NOW, {
      status: 'pending',
      error: '',
      failureKind: undefined,
    })
    // 删除行不等于取消在途模型调用：10 分钟内一律拒绝并说明原因。
    expect(aiReplyDeleteEligibility(pending, NOW)).toEqual({
      eligible: false,
      reason: '生成进行中，完成或停滞后再清理',
      generating: true,
    })
    expect(aiReplyDeleteEligibility(pending, NOW + AI_REPLY_STALLED_MS - 1).eligible)
      .toBe(false)
    // 超过停滞窗口：不再有 runner 会在本次进程里续上，允许清理。
    expect(aiReplyDeleteEligibility(pending, NOW + AI_REPLY_STALLED_MS)).toMatchObject({
      eligible: true,
      generating: false,
    })
    expect(aiReplyDeleteEligibility(aiRecord(NOW), NOW)).toMatchObject({
      eligible: true,
      generating: false,
    })
  })

  it('正文、图片、任务、尝试过投递或状态不符的记录不能清理', () => {
    const cases: Array<[Partial<MessageListRecord>, string]> = [
      [{ text: '已有正文' }, '已有正文'],
      [{ images: [{ url: 'https://example.com/a.png' }] }, '已有正文'],
      [{ jobId: 'jobs/abc' }, '已投递'],
      [{ attempts: 1 }, '尝试'],
      [{ status: 'success' }, '待执行或失败'],
    ]
    for (const [patch, reason] of cases) {
      const result = aiReplyDeleteEligibility(aiRecord(NOW, patch), NOW)
      expect(result.eligible, JSON.stringify(patch)).toBe(false)
      expect(result.generating).toBe(false)
      expect(result.reason).toContain(reason)
    }
    expect(aiReplyDeleteEligibility(record(53, NOW), NOW).reason).toContain('AI 回复')
  })

  it('终态删除：已成功 / 已发出未确认 / 有正文的失败都能删，在途状态仍然拒绝', () => {
    // 三条终态记录（用户在消息列表里最常见的样子：已经发出去、或已经失败收口）。
    expect(aiReplyTerminalDeleteEligibility(aiRecord(NOW, {
      status: 'success',
      text: '已发出的回复',
    }))).toMatchObject({ eligible: true })
    expect(aiReplyTerminalDeleteEligibility(aiRecord(NOW, {
      status: 'sent_unconfirmed',
      text: '可能已发出',
      failureKind: 'unconfirmed',
    }))).toMatchObject({ eligible: true })
    expect(aiReplyTerminalDeleteEligibility(aiRecord(NOW, {
      status: 'failed',
      text: '生成过正文但发送失败',
      failureKind: 'send_failed',
    }))).toMatchObject({ eligible: true })

    // 在途状态一律拒绝：删行不等于停掉在途动作。
    for (const status of ['pending', 'dispatching', 'queued', 'running'] as const) {
      const result = aiReplyTerminalDeleteEligibility(aiRecord(NOW, { status, text: '正文' }))
      expect(result.eligible, status).toBe(false)
      expect(result.reason).toContain('不能删除')
    }

    // 下游任务还没结束的终态记录也不能删。
    const active = aiReplyTerminalDeleteEligibility(aiRecord(NOW, {
      status: 'success',
      text: '已受理',
      jobId: 'job-1',
      jobState: 'running',
    }))
    expect(active.eligible).toBe(false)
    expect(active.reason).toContain('下游异步任务尚未结束')

    // 非 AI 记录不归这个口径管。
    expect(aiReplyTerminalDeleteEligibility(record(54, NOW, 'success')).reason)
      .toContain('AI 回复')
  })

  it('合并口径：空白预约与终态记录都能删，生成中的两条口径都拒绝', () => {
    const blank = aiRecord(NOW, { status: 'failed', text: '', failureKind: 'generation_failed' })
    expect(aiReplyAnyDeleteEligibility(blank, NOW)).toMatchObject({ eligible: true })

    const delivered = aiRecord(NOW, { status: 'success', text: '已发出' })
    expect(aiReplyAnyDeleteEligibility(delivered, NOW)).toMatchObject({ eligible: true })

    // 空白 pending 在 10 分钟内是「生成中」：预约口径拒绝，终态口径也不收。
    const generating = aiRecord(NOW, { status: 'pending', text: '', failureKind: undefined })
    expect(aiReplyAnyDeleteEligibility(generating, NOW)).toMatchObject({ eligible: false })
    expect(aiReplyAnyDeleteEligibility(generating, NOW).reason).toContain('生成进行中')
  })
})
