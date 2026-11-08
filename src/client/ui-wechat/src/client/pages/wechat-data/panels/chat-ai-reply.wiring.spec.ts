/**
 * 「更多 → AI 回复」的并发闸门守卫。
 *
 * 扫描是全局动作，重复点击会排队多轮全量扫描；开关和立即扫描共用忙碌态，
 * 避免用户在扫描途中再次切换配置。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('AI 回复菜单并发闸门', () => {
  it('扫描使用同步锁，首次 await 之前就占位', () => {
    const hook = read('use-chat-ai-reply.ts')
    expect(hook).toContain('scanningLockRef.current !== null')
    expect(hook).toMatch(/scanningLockRef\.current = lock[\s\S]{0,160}await apiScanChatAiReplyNow/)
  })

  it('菜单忙碌态覆盖加载、保存与扫描，扫描按钮不能被重复触发', () => {
    const controls = read('use-chats-ai-reply-controls.ts')
    expect(controls).toContain('chatAiReply.loading || chatAiReply.saving || chatAiReply.scanning')
    const panel = read('Chats.tsx')
    expect(panel).toContain('aiReply={aiReplyControls.aiReply}')
    const actions = read('chats-head-actions.tsx')
    expect(actions).toContain('<ChatAiReplyMenu')
    const menu = read('chat-ai-reply-menu.tsx')
    expect(menu).toContain('disabled={aiReply === undefined || aiReply.busy || !aiReply.ready}')
    expect(menu).toContain('disabled={aiReply.busy}')
  })
})
