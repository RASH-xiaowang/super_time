/**
 * M8：图片/封面结果缓存的**定向**失效策略。
 *
 * 为什么值得单独测：这几个方法里最贵的（朋友圈图片/视频帧）单次要「读文件 + AES 解密 +
 * MD5」全量扫描，`wechat-host.js` 自己的注释记着实测 **12–21 秒**；而实时同步活跃期约 10s
 * 就有一次 `wechat-data/updated`。原先每次事件都 `clear()`，等于让缓存永远命中不了。
 * 这里锁住新的策略：失败条目与「内容会变」的方法丢掉，内容寻址的成功条目留下；
 * 整体清空只保留给「图片密钥变更」那条路径。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { resultCacheHandles } from '../wechat-host.js'

/** 每次用例前清空，避免用例间互相影响。 */
function freshCache() {
  const h = resultCacheHandles()
  h.clearAll()
  return h
}

describe('结果缓存的定向失效（M8）', () => {
  it('键里带上方法名与参数（失效判定要靠前缀解析方法名）', () => {
    const h = freshCache()
    const k = h.key('getAvatar', [{ username: 'wxid_a' }])
    expect(k).toBeTruthy()
    expect(String(k).startsWith('getAvatar\u0000')).toBe(true)
    // 不可缓存的方法不给键
    expect(h.key('queryMessages', [{ a: 1 }])).toBe(null)
  })

  it('失败结果在数据更新时被丢掉（图片可能刚下载到本地）', () => {
    const h = freshCache()
    const miss = h.key('getImageDataUrl', [{ username: 'wxid_a', localId: 7 }])
    const hit = h.key('getImageDataUrl', [{ username: 'wxid_a', localId: 8 }])
    h.write(miss, { ok: false, error: { message: '没找到' } })
    h.write(hit, { ok: true, value: { data: 'data:image/png;base64,AAA' } })

    h.clearStale()

    expect(h.read(miss)).toBe(null) // 之前的「没找到」要允许重试
    expect(h.read(hit)).toEqual({ ok: true, value: { data: 'data:image/png;base64,AAA' } })
  })

  it('内容会变的方法（头像/远程封面）在数据更新时被丢掉', () => {
    const h = freshCache()
    const avatar = h.key('getAvatar', [{ username: 'wxid_a' }])
    const cover = h.key('getArticleCover', [{ contentUrl: 'https://x/y' }])
    h.write(avatar, { ok: true, value: { url: 'file:///head_image/a.jpg' } })
    h.write(cover, { ok: true, value: { url: 'file:///decoded_images/c.jpg' } })

    h.clearStale()

    expect(h.read(avatar)).toBe(null)
    expect(h.read(cover)).toBe(null)
  })

  it('内容寻址的成功条目（朋友圈图片/视频帧/表情）在数据更新后仍然命中', () => {
    const h = freshCache()
    const keys = [
      h.key('getSnsImageDataUrl', [{ md5: 'abc' }]),
      h.key('getSnsVideoCoverDataUrl', [{ md5: 'abc' }]),
      h.key('getSnsVideoDataUrl', [{ md5: 'abc' }]),
      h.key('getEmoticonDataUrl', [{ md5: 'abc' }]),
      h.key('getImageDataUrl', [{ username: 'wxid_a', localId: 9 }]),
    ]
    for (const k of keys) h.write(k, { ok: true, value: { data: 'data:image/webp;base64,BBB' } })
    const before = h.size()

    h.clearStale()

    expect(h.size()).toBe(before) // 一个都没掉
    for (const k of keys) expect(h.read(k)).toEqual({ ok: true, value: { data: 'data:image/webp;base64,BBB' } })
  })

  it('clearAll 仍然整体清空（图片密钥变更时解码结果整体作废）', () => {
    const h = freshCache()
    h.write(h.key('getSnsImageDataUrl', [{ md5: 'abc' }]), { ok: true, value: { data: 'x' } })
    h.write(h.key('getAvatar', [{ username: 'a' }]), { ok: true, value: { url: 'y' } })
    expect(h.size()).toBe(2)
    h.clearAll()
    expect(h.size()).toBe(0)
  })

  it('超大结果不入缓存（不把整段视频的 base64 钉在内存里）', () => {
    const h = freshCache()
    const k = h.key('getSnsVideoDataUrl', [{ md5: 'big' }])
    h.write(k, { ok: true, value: { data: 'x'.repeat(512 * 1024 + 1) } })
    expect(h.read(k)).toBe(null)
  })
})

describe('接线：数据更新事件必须走定向失效（M8）', () => {
  /**
   * 为什么需要源码级守卫：上面的用例都是**直接调** `clearStale()` 的，把
   * `wechat-host.js` 事件分支里那句调用删掉（或退回整体 `clearResultCache()`）它们照样全绿 ——
   * 而「事件一来就把缓存清空」正是这次要修的那个风暴本身。仓库里 `llm-retry.spec.ts`
   * 的「不得有裸 fetch」是同款守卫。
   */
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-host.js'), 'utf8')

  it('wechat-data/updated 的分支调用 clearStaleResultCache()', () => {
    const line = src.split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .find((l) => l.includes("'wechat-data/updated'") && l.includes('if ('))
    expect(line, 'wechat-host.js 里找不到 wechat-data/updated 的处理分支').toBeTruthy()
    expect(line).toContain('clearStaleResultCache()')
    expect(line).not.toContain('clearResultCache()')
  })
})
