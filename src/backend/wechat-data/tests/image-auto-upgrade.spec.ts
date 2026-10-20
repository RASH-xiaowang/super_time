/**
 * 「自动取原图」的守卫：把 2026-10-17 的设计约束钉死。
 *
 * ## 为什么需要这组守卫
 *
 * 用户要求「不需要人工点击」。实现方式是在 `getImageDataUrl` 里**后端自己**再试一次升级，
 * 而不是让前端在拿到 `thumb: true` 后再发一次 RPC。这个选择有三条硬约束，每条都值得守：
 *
 * | 约束 | 违反后果 |
 * |---|---|
 * | 只在 `thumb === true` 时升级 | 已经是原图还重解，每张图白烧几十毫秒 |
 * | 批量路径**不联网** | 一屏几十张各发一次 CDN 请求，首屏拖到分钟级 |
 * | 失败要记 TTL | 虚拟列表滚动会反复挂载同一张图，每次都重试就是持续白烧 |
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const SRC = readFileSync(join(HERE, '..', 'src', 'query', 'image-auto-upgrade.ts'), 'utf8')
const MEDIA = readFileSync(join(HERE, '..', 'src', 'remotes', 'media.ts'), 'utf8')

/** 剥掉注释再断言：注释里写着历史成因与被否掉的旧值，直接搜会误判。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const CODE = stripComments(SRC)
const MEDIA_CODE = stripComments(MEDIA)

describe('自动取原图：只在需要时升级', () => {
  it('① 只在 `thumb === true` 时触发升级（已经是原图不重解）', () => {
    // 判据在 `imageWithAutoUpgrade`：`r.thumb !== true || r.url === undefined` 直接返回。
    expect(MEDIA_CODE).toContain('if (r.thumb !== true || r.url === undefined) return r')
  })

  it('② 升级顺序：本机重解在前，CDN 直链在后', () => {
    // 本机重解是几十毫秒的纯本地操作，CDN 是一次网络往返 —— 顺序反了会让每张图都先等网络。
    const localAt = CODE.indexOf('clearDecodedImageCache(')
    const cdnAt = CODE.indexOf('resolveImageOriginalLink(')
    expect(localAt, '找不到本机重解').toBeGreaterThan(-1)
    expect(cdnAt, '找不到 CDN 直链').toBeGreaterThan(-1)
    expect(localAt, '本机重解必须在 CDN 之前').toBeLessThan(cdnAt)
  })

  it('③ 批量路径不联网（`allowNetwork=false`）', () => {
    // 一屏几十张，每张都发一次 CDN 请求会把首屏拖到分钟级。
    expect(MEDIA_CODE, '批量路径必须传 allowNetwork=false').toContain('imageWithAutoUpgrade(rc, it.username, it.localId, base, aesKey, xorKey, false)')
    expect(MEDIA_CODE, '单条路径才允许联网').toContain('imageWithAutoUpgrade(rc, options.username, options.localId, base, aesKey, xorKey, true)')
  })

  it('④ 失败要记 TTL，避免虚拟列表反复重试', () => {
    expect(CODE, '要有 TTL 常量').toContain('RETRY_TTL_MS')
    expect(CODE, '失败要写进记忆').toContain('triedAt.set(key, Date.now())')
    expect(CODE, 'TTL 内要跳过').toContain('Date.now() - last < RETRY_TTL_MS')
  })

  it('⑤ 用户显式点「取原图」时清掉记忆（否则按钮像没反应）', () => {
    expect(MEDIA_CODE, 'getImageOriginal 必须清记忆').toContain('forgetAutoUpgradeAttempt(talker, localId)')
  })

  it('⑥ 升级失败不抛异常、不写操作记录（失败是常态）', () => {
    // 本机 97% 的图微信从没下载过原图，失败是常态 —— 抛异常会让整条读图路径挂掉。
    expect(CODE).not.toMatch(/throw new Error/)
    expect(CODE, '自动升级不该写操作记录（那是用户显式动作才写的）').not.toContain("rc.op(")
  })

  it('⑦ 升级成功后要重新解一次（缓存槽已被原图占住）', () => {
    expect(MEDIA_CODE).toContain('const again = await decodeImageDataUrlAsync(')
    expect(MEDIA_CODE).toContain('return again.url !== undefined ? again : r')
  })
})
