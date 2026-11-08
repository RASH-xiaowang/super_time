/**
 * 旧 UI 缓存里的会话 username 可能还是 `Msg_<md5>` 的 32 位后缀。
 * 后端身份修复必须配一次本地缓存代际升级，否则升级后的首帧仍会显示哈希。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SCHEMA_KEY = 'dsh-wechat-cache-schema'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('微信缓存 schema 迁移', () => {
  it('首次升级丢弃全部微信数据缓存，但保留用户偏好', async () => {
    localStorage.setItem('dsh-wechat-cache-v1:sessions:list', '{"old":true}')
    localStorage.setItem('wxdata-render-cache:chats', '{"old":true}')
    localStorage.setItem('dsh-wechat-overview-base-v1', '{"old":true}')
    localStorage.setItem('chat-msgs:v1:0369f1affa3bb162c3bf31266d2ba0e6', '[]')
    localStorage.setItem('super-time-wechat-theme', 'dark')
    localStorage.setItem('graph-positions:main', '{"a":{"x":1,"y":2}}')

    await import('./cache.ts')

    expect(localStorage.getItem(SCHEMA_KEY)).toBe('message-identity-v3')
    expect(localStorage.getItem('dsh-wechat-cache-v1:sessions:list')).toBeNull()
    expect(localStorage.getItem('wxdata-render-cache:chats')).toBeNull()
    expect(localStorage.getItem('dsh-wechat-overview-base-v1')).toBeNull()
    expect(localStorage.getItem('chat-msgs:v1:0369f1affa3bb162c3bf31266d2ba0e6')).toBeNull()
    expect(localStorage.getItem('super-time-wechat-theme')).toBe('dark')
    expect(localStorage.getItem('graph-positions:main')).toBe('{"a":{"x":1,"y":2}}')
  })

  it('同代缓存不重复清理，二次启动保留可再生的快照', async () => {
    localStorage.setItem(SCHEMA_KEY, 'message-identity-v3')
    localStorage.setItem('dsh-wechat-cache-v1:sessions:list', '{"fresh":true}')
    localStorage.setItem('wxdata-render-cache:chats', '{"fresh":true}')

    await import('./cache.ts')

    expect(localStorage.getItem('dsh-wechat-cache-v1:sessions:list')).toBe('{"fresh":true}')
    expect(localStorage.getItem('wxdata-render-cache:chats')).toBe('{"fresh":true}')
  })
})
