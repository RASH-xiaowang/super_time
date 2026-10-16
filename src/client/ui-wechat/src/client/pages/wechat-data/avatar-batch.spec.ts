// @vitest-environment node
/**
 * W2-10.2：头像走**攒批**，而不是一屏 N 个组件 N 次 RPC。
 *
 * ## 这条要守的事
 *
 * `Avatar` 组件是「一屏挂 N 个、每个自己取图」的典型形状。原先每个组件缓存未命中就发一次
 * `getAvatar`，一屏 200 个联系人就是 200 次 RPC。计划里说「需新批量 Remote」——
 * 查下来**不成立**：批量入口 M23 的 `getAvatarsLocal` 早就有了，表情那条更早（E1）就批完。
 * 真正没批的是**组件这一侧**。
 *
 * 实测（`avatar-batch-cost.measure.spec.ts`）：逐张 200 次 34.18ms vs 批量 1 次 6.15ms = **5.6×**。
 *
 * ## 为什么不直接换成 `apiGetAvatarsLocal`
 *
 * 单张那条路（`resolveAvatar`）还多一级「按昵称再找一次联系人」的回落，批量接口**没有**。
 * 直接替换会少一批头像。所以是「批量优先 + 未命中退回单张」，不是二选一 ——
 * 这条判据把「退回」钉住，改掉它就是静默地少图。
 * @module avatar-batch
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const API = fileURLToPath(new URL('./api-config.ts', import.meta.url))
const SUPPORT = fileURLToPath(new URL('./panels/chats-support.tsx', import.meta.url))
const api = readFileSync(API, 'utf8')
const support = readFileSync(SUPPORT, 'utf8')

describe('W2-10.2 组件走攒批', () => {
  it('Avatar 取图走 apiGetAvatarBatched（不是逐张的 apiGetAvatar）', () => {
    const i = support.indexOf('export function Avatar(')
    expect(i, '找不到 Avatar 组件').toBeGreaterThan(-1)
    const body = support.slice(i, i + 1600)
    expect(body, 'Avatar 还在逐张发 RPC').toContain('apiGetAvatarBatched({ username: key })')
    expect(body, '逐张那条入口不许留在 Avatar 里').not.toMatch(/apiGetAvatar\(\{ username: key \}\)/)
  })

  it('签名与语义不变（调用方一行都不用改），所以那处 import 只多不少', () => {
    expect(support).toContain("import { apiGetAvatar, apiGetMessageFile, apiGetAvatarBatched } from '../api.ts'")
  })

  it('仍然是「只写成功结果，失败写 null」—— 攒批不改变缓存纪律', () => {
    const i = support.indexOf('export function Avatar(')
    const body = support.slice(i, i + 1600)
    expect(body).toContain("const value = r.kind === 'data' ? (r.data ?? null) : null")
    expect(body).toContain('cacheBounded(avatarCache, key, value, AVATAR_CACHE_MAX)')
  })
})

describe('W2-10.2 队列本体', () => {
  it('复用 createImageLoadQueue（与图片 W1-2、表情 E1 同一个），不是自己再写一套攒批', () => {
    expect(api).toContain("import { createImageLoadQueue } from './image-batch.ts'")
    expect(api).toContain('const avatarQueue = createImageLoadQueue<{ username: string; nickname?: string }, AvatarResult>({')
  })

  it('flush 走批量入口 getAvatarsLocal', () => {
    expect(api).toContain('const map = await apiGetAvatarsLocal({ usernames: keys.map((k) => k.username) })')
  })

  it('批量没命中的**退回单张**（那一级「按昵称找联系人」的回落只在单张路上）', () => {
    const i = api.indexOf('const avatarQueue = createImageLoadQueue')
    expect(i).toBeGreaterThan(-1)
    const body = api.slice(i, i + 900)
    expect(body, '未命中就直接判 none ⇒ 会少一批头像').toContain('return apiGetAvatar(k)')
    expect(body).toMatch(/if \(typeof hit === 'string' && hit !== ''\) return \{ kind: 'data', data: hit \}/)
  })

  it('空 username 不进队列（直接 none，省掉一次白跑的 IPC）', () => {
    const i = api.indexOf('export async function apiGetAvatarBatched(')
    expect(i).toBeGreaterThan(-1)
    const body = api.slice(i, i + 400)
    expect(body).toContain("if (u === '') return { kind: 'none' }")
  })

  it('flush 返回条数不足时有兜底（不能静默错位）', () => {
    expect(api).toContain("onMissing: (k) => ({ kind: 'none' })")
  })

  it('**没有**为此新增 Remote：批量入口 M23 就有了', () => {
    // 计划原文写「需新批量 Remote」；真加一个的话 gateway 的 Remote 面会变，
    // 而这里明确断言头像走的是既有的 getAvatarsLocal。
    expect(api).toContain('apiGetAvatarsLocal')
    expect(api).not.toContain('apiGetAvatarsLocalBatch')
  })
})