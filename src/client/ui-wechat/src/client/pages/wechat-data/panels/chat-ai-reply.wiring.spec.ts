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

  it('头部入口的忙碌态覆盖加载、保存与扫描，扫描按钮不能被重复触发', () => {
    const controls = read('use-chats-ai-reply-controls.ts')
    expect(controls).toContain('chatAiReply.loading || chatAiReply.saving || chatAiReply.scanning')
    const panel = read('Chats.tsx')
    expect(panel).toContain('aiReply={aiReplyControls.aiReply}')
    const actions = read('chats-head-actions.tsx')
    // 开关与设置 2026-11-18 搬到头部；「立即检查」仍留在「更多」。
    expect(actions).toContain('<ChatAiReplyHeaderButtons')
    expect(actions).toContain('<ChatAiReplyMenu')
    const menu = read('chat-ai-reply-menu.tsx')
    // 开关与设置共用同一个禁用判据：busy 或尚未就绪都不能点。
    expect(menu).toContain('const disabled = aiReply.busy || !aiReply.ready')
    expect(menu).toContain('disabled={aiReply.busy}')
  })

  it('开关写入期间回源让路，收尾只看锁归属（否则关掉后按钮永久变灰）', () => {
    const refresh = read('use-chat-ai-reply-refresh.ts')
    // 回源会让路：否则它推进 requestId，写结果被判过期，saving 收不回来。
    expect(refresh, '回源没有在写操作期间让路').toMatch(
      /savingLockRef\.current !== null\)\s*return Promise\.resolve\(\)/,
    )
    const hook = read('use-chat-ai-reply.ts')
    // 收尾不许再用 requestId 兜：锁仍属本次写入就必须把 saving 收回去。
    const saveFinally = hook.slice(hook.lastIndexOf('if (savingLockRef.current === lock)'))
    expect(saveFinally, '保存收尾又把 requestId 当条件了').not.toMatch(
      /if \(requestIdRef\.current === requestId\) setSaving\(false\)/,
    )
    expect(saveFinally, '保存收尾没有收回 saving').toContain('setSaving(false)')
    // 人格保存同一口径。
    const persona = read('chat-ai-reply-persona-action.ts')
    const personaFinally = persona.slice(persona.lastIndexOf('context.savingLockRef.current === lock'))
    expect(personaFinally, '人格保存收尾又把 requestId 当条件了').not.toMatch(
      /if \(context\.requestIdRef\.current === requestId\) context\.setSaving\(false\)/,
    )
  })
})
