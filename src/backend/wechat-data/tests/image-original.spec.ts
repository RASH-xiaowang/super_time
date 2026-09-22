/**
 * 聊天图片「原图直取」的行为与接线守卫。
 *
 * 三件最容易坏、又坏得静默的事：
 *   ① **缓存键**只能用 `packed_info_data` 里那份 md5。XML 的 `md5=` 本机实测与
 *      `msg/attach` 文件名 **0% 命中**（4.x 它不是文件身份）—— 拿它当键的结果是
 *      「下载成功、界面还是缩略图」，谁都不会报错。
 *   ② **域名白名单**必须是「等于或以 `.后缀` 结尾」，且拦在发请求**之前**：
 *      消息 XML 是可被离线改写的文件，直链又是完整带凭据参数的 URL。
 *   ③ 两个开关（隐私「禁止出网」、界面「自动获取原图（CDN）」）都必须**一次请求都不发**。
 *
 * 每个用例都用**自己独立的临时目录**：早先版本图省事用了 `scratch[0] ?? '.'`，
 * 结果在某次变异跑（开关判据被摘掉、真的走到落盘那一步）时把 png 写进了**仓库根目录**，
 * 下一次跑就出现「明明断言不落盘却读到了文件」的假失败 —— 测试把产物写进工作区，
 * 是会污染后面用例和自己的判据的。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchImageOriginalToCache, resolveImageOriginalLink } from '../src/query/image-original.ts'
import { clearDecodedImageCache, decodeImageDataUrl } from '../src/query/media-image.ts'

/** M21：域方法体搬进 `remotes/*.ts`（网关只留签名 + 转发）⇒ 源码断言读联合。 */
function gatewayPlusRemotes(p: string): string {
  const dir = join(dirname(p), 'remotes')
  const extra = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => join(dir, f))
    : []
  return [p, ...extra].map((f) => readFileSync(f, 'utf8')).join('\n')
}

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
  vi.unstubAllGlobals()
})

/** 一个独立临时目录（绝不落在仓库里；Windows 与 CI runner 都用 TEMP）。 */
function tmpDir(tag: string): string {
  const base = process.env.TEMP ?? process.env.TMP ?? '/tmp'
  const dir = resolve(base, 'wx-orig-' + tag + '-' + Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  scratch.push(dir)
  return dir
}

const TALKER = 'wxid_unittest'
const IMG_MD5 = 'aabbccddeeff00112233445566778899'

/** 造一个只含图片消息的解密目录：`message_content` 存明文 XML（后端对非 zstd 会原样解）。 */
function fixture(xml: string, packed: string | null = IMG_MD5): string {
  const root = tmpDir('db')
  const decrypted = join(root, 'decrypted', 'message')
  mkdirSync(decrypted, { recursive: true })
  const table = 'Msg_' + createHash('md5').update(TALKER, 'utf8').digest('hex')
  const db = new DatabaseSync(join(decrypted, 'message_0.db'))
  db.exec(`CREATE TABLE "${table}" (local_id INTEGER, local_type INTEGER, message_content TEXT, packed_info_data TEXT)`)
  db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?)`).run(7, 3, xml, packed ?? '')
  db.close()
  return join(root, 'decrypted')
}

const TP_XML = (host: string): string =>
  `<msg><img aeskey="0123456789abcdef0123456789abcdef" length="10240" hdlength="20480"` +
  ` tpurl="https://${host}/wxgetmsgimg/download?id=1&amp;authkey=ABC" tphdurl="https://${host}/wxgetmsgimg/hd?id=1&amp;authkey=ABC"/></msg>`

describe('resolveImageOriginalLink', () => {
  it('取 tphdurl 优先，并解开 &amp; 转义', () => {
    const link = resolveImageOriginalLink(fixture(TP_XML('mmwebwx.weixin.qq.com')), TALKER, 7)
    expect(link).not.toBeNull()
    expect(link!.md5).toBe(IMG_MD5)
    expect(link!.url).toContain('/hd?id=1&authkey=ABC')
    expect(link!.hasHd).toBe(true)
    expect(link!.declaredBytes).toBe(20480)
  })

  it('白名单外的主机一律不返回链接（不发请求，而不是请求后失败）', () => {
    expect(resolveImageOriginalLink(fixture(TP_XML('evil.example.com')), TALKER, 7)).toBeNull()
    // 只写 endsWith('qq.com') 会放过的那一类
    expect(resolveImageOriginalLink(fixture(TP_XML('notqq.com')), TALKER, 7)).toBeNull()
  })

  it('没有 tpurl / tphdurl 时返回 null（只有 cdnbigimgurl 的那种要登录态，本应用不做）', () => {
    expect(resolveImageOriginalLink(fixture('<msg><img md5="ff" cdnbigimgurl="305702010004" length="10"/></msg>'), TALKER, 7)).toBeNull()
  })

  it('packed_info 缺失时不返回（缓存键都不知是哪张图，写下去也没人读）', () => {
    expect(resolveImageOriginalLink(fixture(TP_XML('mmwebwx.weixin.qq.com'), ''), TALKER, 7)).toBeNull()
  })
})

describe('fetchImageOriginalToCache', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 9])
  const LINK = { md5: IMG_MD5, url: 'https://mmwebwx.weixin.qq.com/a', hasHd: true, declaredBytes: 12 }

  const stubFetch = (make: () => Promise<Response>): (() => number) => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls += 1; return make() })
    return () => calls
  }
  const okResponse = (bytes: Uint8Array): Response =>
    ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.slice().buffer,
    }) as unknown as Response

  it('关掉「自动获取原图（CDN）」时一次请求都不发、也不写盘', async () => {
    const calls = stubFetch(async () => okResponse(PNG))
    const decoded = join(tmpDir('cdn-off'), 'decoded')
    const r = await fetchImageOriginalToCache(LINK, decoded, { cdnEnabled: false })
    expect(calls()).toBe(0)
    expect(r.bytes).toBeUndefined()
    expect(r.error).toContain('自动获取原图')
    expect(() => readFileSync(join(decoded, IMG_MD5 + '.png'))).toThrow()
  })

  it('成功后落进 decoded 根目录（那正是取图路径第一站读的槽位）', async () => {
    const calls = stubFetch(async () => okResponse(PNG))
    const decoded = join(tmpDir('dl'), 'decoded')
    const r = await fetchImageOriginalToCache(LINK, decoded, {})
    expect(calls()).toBe(1)
    expect(r.format).toBe('png')
    expect(r.bytes).toBe(12)
    expect(readFileSync(join(decoded, IMG_MD5 + '.png')).length).toBe(12)
  })

  it('白名单外主机即便被直接调用也拒绝发请求', async () => {
    const calls = stubFetch(async () => okResponse(PNG))
    const decoded = join(tmpDir('deny'), 'decoded')
    const r = await fetchImageOriginalToCache({ ...LINK, url: 'https://attacker.example.org/x' }, decoded, {})
    expect(calls()).toBe(0)
    expect(r.error).toContain('允许清单')
  })

  it('回来的不是图片时不落盘（免得把 HTML 错误页缓存成图）', async () => {
    stubFetch(async () => okResponse(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 1, 2, 3, 4, 5, 6])))
    const decoded = join(tmpDir('badbytes'), 'decoded')
    const r = await fetchImageOriginalToCache(LINK, decoded, {})
    expect(r.bytes).toBeUndefined()
    expect(r.error).toContain('不是可识别的图片格式')
    expect(() => readFileSync(join(decoded, IMG_MD5 + '.png'))).toThrow()
  })
})

describe('解码缓存的两个槽位（缩略图不许永久遮蔽后到的原图）', () => {
  const SMALL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])

  /** 造一份「只有缓存、不碰 attach」的场景：不传 wechatBaseDir，解码只会走缓存槽。 */
  function cacheOnly(files: Record<string, Uint8Array>): { decrypted: string; decoded: string } {
    const decrypted = fixture('<msg><img length="10"/></msg>')
    const decoded = join(decrypted, '..', 'decoded')
    mkdirSync(decoded, { recursive: true })
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(decoded, name), Buffer.from(bytes))
    return { decrypted, decoded }
  }
  const call = (c: { decrypted: string; decoded: string }) =>
    decodeImageDataUrl(c.decrypted, c.decoded, TALKER, 7)

  it('两个槽都在时，给的是「最好的一份」而不是缩略图', () => {
    const c = cacheOnly({
      [IMG_MD5 + '.t.png']: SMALL,
      [IMG_MD5 + '.png']: new Uint8Array([...SMALL, 9, 9, 9, 9]),
    })
    const r = call(c)
    expect(r.error).toBeUndefined()
    expect(r.thumb).toBeUndefined()
    expect(Buffer.from(r.url!.split(',')[1] ?? '', 'base64').length).toBe(16)
  })

  it('只有 `.t.` 槽时明确回报 thumb:true（界面才说得出「本机只有缩略图」）', () => {
    const r = call(cacheOnly({ [IMG_MD5 + '.t.png']: SMALL }))
    expect(r.url).toBeTruthy()
    expect(r.thumb).toBe(true)
  })

  it('clearDecodedImageCache 把两个槽都删掉（「去微信里点过原图」因此能被重解看到）', () => {
    const c = cacheOnly({ [IMG_MD5 + '.png']: SMALL, [IMG_MD5 + '.t.png']: SMALL })
    expect(clearDecodedImageCache(c.decoded, TALKER, IMG_MD5)).toBe(2)
    expect(call(c).url).toBeUndefined()
  })
})

describe('接线守卫', () => {
  const gateway = gatewayPlusRemotes(join(import.meta.dirname, '..', 'src', 'gateway.ts'))
  const impl = readFileSync(join(import.meta.dirname, '..', 'src', 'query', 'image-original.ts'), 'utf8')

  it('解码缓存写入端：缩略/中图必须落到 `.t.` 槽（否则又会永久遮蔽后到的原图）', () => {
    const mi = readFileSync(join(import.meta.dirname, '..', 'src', 'query', 'media-image.ts'), 'utf8')
    const at = mi.indexOf('function writeDecodedCache')
    expect(at, '找不到 writeDecodedCache —— 改名时请同步本用例').toBeGreaterThan(-1)
    expect(mi.slice(at, mi.indexOf('\n}', at)).includes("thumb ? '.t.' : '.'"), '写入端必须按 thumb 分槽').toBe(true)
    expect((mi.match(/writeDecodedCache\([^)]*, thumb\)/g) ?? []).length, '两处 .dat 分支都要把 thumb 传下去').toBe(2)
  })

  it('getImageOriginal 过两道闸：隐私出网闸门 + CDN 开关', () => {
    // M21：方法体搬到 remotes/media.ts（@Remote 处只剩转发）⇒ 取实现那段
    const implAt = gateway.lastIndexOf('getImageOriginal(')
    const at = implAt >= 0 && gateway.slice(implAt).includes('rc.') ? implAt : gateway.indexOf("@Remote('getImageOriginal')")
    expect(at, '找不到 getImageOriginal —— 改名时请同步本用例').toBeGreaterThan(-1)
    const endImpl = gateway.slice(at).indexOf('\n    },')
    const body = endImpl > 0 ? gateway.slice(at, at + endImpl) : gateway.slice(at, gateway.indexOf("@Remote('", at + 1))
    expect(body.includes("privacyBlocked('image_original_fetch'"), '必须过「禁止出网」总闸').toBe(true)
    expect(/(?:this|rc)\.cdnSwitches\(\)/.test(body), '必须把「自动获取原图（CDN）」开关传进去').toBe(true)
    expect(body.includes("op('task', 'image_original_fetch'"), '取回结果要进操作记录').toBe(true)
  })

  it('缓存键只来自 packed_info，绝不使用 XML 的 md5=', () => {
    expect(impl.includes('resolveImageResourceHint('), 'md5 必须来自 resolveImageResourceHint（packed_info 口径）').toBe(true)
    expect(/at\.md5\b/.test(impl), '出现 XML md5 当键的写法：那是 4.x 的假身份，实测 0% 命中文件名').toBe(false)
  })

  it('白名单判定是严格后缀（放行子域，拦住 notqq.com 这类）', () => {
    const at = impl.indexOf('function hostAllowed')
    expect(at, '找不到 hostAllowed —— 改名时请同步本用例').toBeGreaterThan(-1)
    const body = impl.slice(at, impl.indexOf('\n}', at))
    expect(body.includes('host === suf'), '主机等于后缀要放行').toBe(true)
    expect(body.includes("host.endsWith('.' + suf)"), '子域必须以「.后缀」结尾才放行').toBe(true)
    expect(body.includes('host.endsWith(suf)'), '不许出现裸 endsWith(后缀)：那会放过 notqq.com').toBe(false)
  })
})
