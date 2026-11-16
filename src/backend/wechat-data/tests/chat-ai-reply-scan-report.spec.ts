// @vitest-environment node
/**
 * 扫描汇总留痕：只记原因码与计数，同一份汇总 10 分钟内不重复落日志。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_AI_REPLY_SCAN_REPORT_DEDUPE_MS,
  formatChatAiReplyScanDetail,
  resetChatAiReplyScanReportDedupe,
  shouldWriteChatAiReplyScanReport,
} from '../src/query/ai-reply/scan-report.ts'

beforeEach(() => {
  resetChatAiReplyScanReportDedupe()
})

describe('AI 回复扫描汇总', () => {
  it('原因码顺序固定，零值不出现，未知原因追加在后面', () => {
    expect(formatChatAiReplyScanDetail({
      skipped: 1,
      lease_miss: 2,
      queued: 3,
      replied: 0,
      unknown_reason: 4,
    })).toBe('queued=3 lease_miss=2 skipped=1 unknown_reason=4')
  })

  it('没有任何事实时不产生汇总文本', () => {
    expect(formatChatAiReplyScanDetail({ queued: 0, lease_miss: 0 })).toBe('')
  })

  it('同一份汇总 10 分钟内只写一次，过期后可以再写', () => {
    const now = 1_000_000
    expect(shouldWriteChatAiReplyScanReport('queued=1', now)).toBe(true)
    expect(shouldWriteChatAiReplyScanReport('queued=1', now + 1_000)).toBe(false)
    expect(shouldWriteChatAiReplyScanReport('queued=2', now + 2_000)).toBe(true)
    expect(
      shouldWriteChatAiReplyScanReport('queued=1', now + CHAT_AI_REPLY_SCAN_REPORT_DEDUPE_MS + 1),
    ).toBe(true)
  })
})
