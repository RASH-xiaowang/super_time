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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { createWechatBackend, resultCacheHandles } from '../wechat-host.js'

/** 每次用例前清空，避免用例间互相影响。 */
function freshCache() {
  const h = resultCacheHandles()
  h.clearAll()
  return h
}

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

describe('结果缓存的定向失效（M8）', () => {
  it('键里带上方法名与参数（失效判定要靠前缀解析方法名）', () => {
    const h = freshCache()
    const k = h.key('getAvatar', [{ username: 'wxid_a' }])
    expect(k).toBeTruthy()
    expect(String(k).startsWith('getAvatar\u0000')).toBe(true)
    // 不可缓存的方法不给键
    expect(h.key('queryMessages', [{ a: 1 }])).toBe(null)
  })

  it('解码输入指纹进键：密钥/数据根一变，同样的入参也命中不了旧条目', () => {
    // 这几个方法返回的是「按当前图片密钥解码出来的字节」，而密钥在 secrets.json、
    // db_dir 在 config.json —— 用户**手工编辑**这两个文件不会走任何 RPC，所以只能靠
    // 「把它们的指纹放进键」来自失效（复审实测过反例：手改后同一 localId 永久返回旧字节）。
    const h = freshCache()
    const args = [{ username: 'wxid_a', localId: 7 }]
    const before = h.key('getImageDataUrl', args, 'm1:s1|m2:s2')
    const after = h.key('getImageDataUrl', args, 'm1:s1|m9:s9')
    expect(before).not.toBe(after)
    // 指纹相同则键相同（否则缓存永远命中不了）
    expect(h.key('getImageDataUrl', args, 'm1:s1|m2:s2')).toBe(before)

    // 端到端：指纹变化后旧条目读不到
    h.write(before, { ok: true, value: { data: 'OLD' } })
    expect(h.read(before)).toEqual({ ok: true, value: { data: 'OLD' } })
    expect(h.read(after)).toBe(null)
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

  it('取缓存键时带上了「解码输入指纹」（缺了它就无法对手工改密钥自失效）', () => {
    const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    expect(code).toContain('resultCacheKey(method, callArgs, decodeInputSig())')
  })
})

describe('真值级接线：解码输入指纹真的来自那两份文件（复审要求）', () => {
  /**
   * 为什么还要这条：上面那条源码守卫只保证**调用点写法**，把 `decodeInputSig` 内部改成
   * 「恒返回 ''」或读错目录它照样通过（复审实测该变异存活）。所以补一条端到端：
   * 用真实后端 + 打桩的 gateway 方法计数，改 `secrets.json` / `config.json` 必须让同参调用
   * 重新执行，不改则必须命中缓存。
   */
  it('改 secrets.json / config.json 会让同参调用重新执行；无变更则命中', async () => {
    const ud = mkdtempSync(join(tmpdir(), 'wx-rc-e2e-'))
    scratch.push(ud)
    const dataRoot = join(ud, 'wechat-data')
    mkdirSync(dataRoot, { recursive: true })
    const cfgFile = join(dataRoot, 'config.json')
    const secFile = join(dataRoot, 'secrets.json')
    writeFileSync(cfgFile, '{}', 'utf8')
    writeFileSync(secFile, '{}', 'utf8')

    const prevHome = process.env.DSH_HOME
    const backend = await createWechatBackend({ userDataPath: ud })
    try {
      let calls = 0
      backend.gateway.getImageDataUrl = async () => {
        calls += 1
        return { url: 'data:image/png;base64,AAA' }
      }
      const args = [{ username: 'wxid_a', localId: 1 }]

      await backend.call('getImageDataUrl', args)
      expect(calls).toBe(1)
      await backend.call('getImageDataUrl', args)
      expect(calls, '无变更必须命中缓存').toBe(1)

      // 手工改密钥（不走任何 RPC）—— 内容长度不同，保证 mtime+size 指纹必变
      writeFileSync(secFile, '{"image_aes_key":"0123456789abcdef"}', 'utf8')
      await backend.call('getImageDataUrl', args)
      expect(calls, '改了 secrets.json 必须重新解码').toBe(2)

      writeFileSync(cfgFile, '{"db_dir":"D:\\\\wx\\\\db_storage"}', 'utf8')
      await backend.call('getImageDataUrl', args)
      expect(calls, '改了 config.json 必须重新解码').toBe(3)

      await backend.call('getImageDataUrl', args)
      expect(calls, '没有变更就该继续命中').toBe(3)
    } finally {
      backend.dispose()
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
    }
  }, 60_000)
})
