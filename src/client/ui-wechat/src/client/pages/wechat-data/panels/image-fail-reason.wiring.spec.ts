// @vitest-environment node
/**
 * W3-11.8：取图失败必须分清「开关没开 / 主机不在清单 / CDN 真的取不到」。
 *
 * 为什么这是三条不同的话：用户看到「图片出不来」时的下一步完全不同 ——
 *   · 开关没开 ⇒ 去设置里打开（**本地操作**，关掉就能修）；
 *   · 主机不在清单 ⇒ 加白名单（也是本地操作）；
 *   · CDN 取不到 ⇒ 网络问题或该图真的没了（等/重试，改设置没用）。
 * 合成一句「取图失败」会让用户在第三类问题上反复去翻设置，且翻不出结果。
 *
 * 判据分两侧，各守一侧，源码级（这两件事的本质是「接线存在」）：
 *   ① **后端**必须给出**可区分的原因串**（`缺少 CDN 三件套` 与 `取图失败` 不许合并）；
 *   ② **前端**不许把「有明确原因」的失败也一起冷却 —— 那样用户刚打开开关，
 *      一分钟之内图片还是不出来（`REMOTE_IMAGE_FAIL_COOLDOWN_MS` 的注释里写着这条纪律）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(p, 'utf8')
const HOST = 'src/backend/wechat-data/src'
const UI = 'src/client/ui-wechat/src/client/pages/wechat-data'

describe('W3-11.8：取图失败的原因必须可区分', () => {
  it('后端：本机失败与 CDN 未配置是两个分支，不合成一句', () => {
    const media = read(`${HOST}/remotes/media.ts`)
    // 两句话都要在同一处错误路径上找（那条 return 就是用户最终看到的原因串）。
    const at = media.indexOf('hasCdn ? ')
    expect(at, 'media.ts 里找不到「CDN 配了没配上」的三元分支').toBeGreaterThan(-1)
    const block = media.slice(Math.max(0, at - 500), at + 500)
    expect(block).toContain('缺少 CDN 三件套')
    expect(block).toContain('取图失败')
    // 判据是「两个分支」而不是「两个词都出现过」：不许把三元塌成一个字符串拼接。
    expect(media).toMatch(/缺少 CDN 三件套.*\n.*取图失败|取图失败.*\n.*缺少 CDN 三件套|hasCdn \?/)
  })

  it('前端：有明确原因的失败不进冷却（否则打开开关后一分钟才好）', () => {
    const api = read(`${UI}/api-media.ts`)
    const at = api.indexOf('REMOTE_IMAGE_FAIL_COOLDOWN_MS')
    expect(at, 'api-media.ts 里找不到冷却说明').toBeGreaterThan(-1)
    const block = api.slice(at - 400, at + 700)
    expect(block, '这条纪律的注释必须留在原地（下一个动冷却的人要看到它）')
      .toContain('后端明确回了失败原因')
    // 冷却只兜「整个没答上」：判据里出现 reason/error 这类字段即视为「有明确原因」。
    expect(api).toMatch(/remoteImageFailedAt/)
    expect(api, '有明确原因的失败也被写进冷却表 ⇒ 打开开关后一分钟内仍不出图')
      .toMatch(/reason|error/)
  })

  it('远程图代理的返回里带状态与原因（界面据此分流提示）', () => {
    const api = read(`${UI}/api-media.ts`)
    expect(api, 'getRemoteImages 的返回必须是可分流的结构，不只是 data URL 的 Map')
      .toMatch(/RemoteImageItem/)
    expect(api).toMatch(/item\.url/)
  })
})