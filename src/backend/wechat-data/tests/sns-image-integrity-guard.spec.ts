/**
 * 朋友圈图片取图链路的**接线守卫**：把 2026-10-08 那次「一屏 9 张全挂」的三条教训钉成闸门。
 *
 * 这次的真因是**判据过严**，而不是能力不足 —— 但代码里当时写着三条**方向相反**的断言
 * （「只能解头」「换一份 WASM」「尾部标记缺失 = 只解了 128KB」），把后来的人全引向死路。
 * 所以除了行为断言，还要在源码层面拦住同类回归：
 *
 *   1. **不许退回死盯最后两字节**的结尾判据 —— 微信 CDN 在 EOI 之后恒定挂 24 字节签名块；
 *   2. **必须留着密钥流长度闸门** —— 少了它，密钥流偏短会静默交付「头对尾密文」的文件；
 *   3. **不许跨层正则抓 `<enc key>`** —— 那是 LivePhoto 里视频的 key，拿它解图片必坏；
 *   4. **错误文案只许报实测值** —— 上一版把成因写死成「可能只解密了前 128 KB」，
 *      而那正是错的（真实成因是尾块），断言错在文案里比错在代码里更贵。
 *
 * 实测依据见 `sns-image-tail-probe.manual.spec.ts`（`SNS_LIVE=1`）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (rel: string): string => readFileSync(join(PKG, rel), 'utf8')

const cdn = read('src/query/sns-cdn-image.ts')
const keystream = read('src/query/sns-keystream.ts')
const moments = read('src/query/moments.ts')

/**
 * 剥掉块注释与行注释。
 *
 * 为什么需要：守卫要盯的是**代码里的断言**，不是文档里的复述。像「上一版把成因写死成
 * 「只解了头部」」这种说明必须留着（那是给后来的人看的路标），但它不该让一条
 * 「不许出现那句错话」的断言变红。混在一起查，就只能二选一：要么守卫失效，要么文档不敢写。
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

describe('朋友圈图片：结尾判据不许退回「死盯最后两字节」', () => {
  it('sns-cdn-image.ts 里没有把 EOI 位置写死成 b[b.length-2] 这种形式', () => {
    // 一旦有人「简化」回旧写法，这条会红。刻意只匹配真正的下标表达式，不匹配注释里的叙述。
    expect(code(cdn)).not.toMatch(/\[\s*(?:b|bytes)\s*\.\s*length\s*-\s*2\s*\]/)
    expect(code(cdn)).not.toMatch(/\[\s*(?:b|bytes)\s*\.\s*length\s*-\s*1\s*\]\s*===/)
  })

  it('走的是「尾部窗口内搜索 + 裁掉尾块」这条路径', () => {
    const src = code(cdn)
    expect(src).toContain('END_SCAN_WINDOW')
    expect(src).toContain('trimToImageEnd')
    // 窗口必须有个数（不是无界搜索）：无界搜索会把「图被截断」也判成通过
    const m = /const END_SCAN_WINDOW = (\d+)/.exec(src)
    expect(m, 'END_SCAN_WINDOW 必须是常量数字').not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
    expect(Number(m![1])).toBeLessThanOrEqual(4096)
  })
})

describe('朋友圈图片：密钥流长度闸门不许被删', () => {
  it('sns-keystream.ts 里仍有一处「长度不符就抛错」', () => {
    expect(code(keystream)).toMatch(/bytes\.length\s*!==\s*n/)
    // 抛错而不是打日志：静默截断会一路走到 <img> 上才暴露
    expect(code(keystream)).toMatch(/密钥流长度不符/)
  })
})

describe('朋友圈图片：种子不许跨层抓', () => {
  it('moments.ts 不用跨层正则去找 <enc … key>（那会抓到 LivePhoto 里视频的 key）', () => {
    // 正则写法（`/<enc\b[^>]*key=/`）天生跨层；生产用的是 `xmlTagAttr` 的 indexOf 口径，
    // 顶层 `<enc>0</enc>` 先精确匹配 `<enc>` 从而返回 null，才正确回落到 <thumb key>。
    expect(code(moments)).not.toMatch(/<enc\\b/)
    expect(code(moments)).toMatch(/xmlTagAttr\(inner, 'thumb', 'key'\)/)
    expect(code(moments)).toMatch(/xmlTagAttr\(inner, 'url', 'key'\)/)
  })
})

describe('朋友圈图片：错误文案只许报实测值', () => {
  it('被证伪的成因断言不许回到代码里', () => {
    for (const src of [code(cdn), code(keystream)]) {
      expect(src).not.toContain('只解密了前 128 KB')
      expect(src).not.toContain('无法一次生成全量')
      expect(src).not.toContain('参考项目另有一份 WASM')
    }
  })

  it('失败文案里带着实测数字（长度 / x-enc / 有没有解密）', () => {
    const src = code(cdn)
    expect(src).toContain('x-enc=')
    expect(src).toContain('结尾标记缺失')
    // 成因只报「测到了什么」，不写「所以是因为…」
    expect(src).not.toMatch(/因为.*导致/)
  })
})

describe('朋友圈图片：读 X-Enc 与 mime 补齐不许被删', () => {
  it('sns-cdn-image.ts 读 x-enc 响应头决定要不要解密', () => {
    expect(code(cdn)).toMatch(/x-enc/)
  })

  it('mime 识别含 AVIF/HEIF/HEIC/BMP/GIF/WebP（只认 JPEG/PNG 会误拒真图）', () => {
    for (const t of ['image/avif', 'image/heic', 'image/heif', 'image/bmp', 'image/gif', 'image/webp']) {
      expect(code(cdn), '少了 ' + t + ' 的识别').toContain(t)
    }
  })
})

describe('朋友圈图片：真机测量与回归覆盖不许消失', () => {
  it('探针用例还在（它是这些结论的证据来源）', () => {
    expect(read('tests/sns-image-tail-probe.manual.spec.ts')).toContain('SNS_LIVE')
  })

  it('整份解密的确定性往返测试已补上（此前是零覆盖），且它自己跑真 WASM', () => {
    const ks = read('tests/sns-keystream.spec.ts')
    expect(code(ks)).toContain('decryptSnsAll')
    // 它必须跑真 WASM —— 一旦有人把它 mock 掉，这个洞就又回来了
    expect(code(ks)).not.toContain('vi.mock')
  })

  it('取图单测已不再把整个密钥流模块 mock 掉', () => {
    const spec = read('tests/sns-cdn-image.spec.ts')
    // 仍会 mock（桩可控），但必须**只**桩化 keystream，且不许把 decryptSnsAll 变成空实现
    expect(code(spec)).toMatch(/decryptSnsAll:\s*vi\.fn/)
  })
})

/* ───────────────────── 高清原图：取图顺序与落盘纪律 ───────────────────── */

const mediaRemotes = code(read('src/remotes/media.ts'))
const mediaCache = code(read('../../client/ui-wechat/src/client/pages/wechat-data/media-cache.ts'))
const momentsMedia = code(read('../../client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts'))

describe('先网后本：有网只走网络，无网只用本地（顺序不许被调换）', () => {
  // 用位置而不是切片段：同一文件里有两处 `} else {`（`hasCdn` 那个在前），
  // 靠字符串切容易切错区间，而切错了断言会变成恒真。
  const iBranch = mediaRemotes.indexOf('if (!offline) {')
  const iOfflineElse = iBranch < 0 ? -1 : mediaRemotes.indexOf('} else {', iBranch)
  const iStore = mediaRemotes.indexOf('lookupOriginal(decoded, options.md5)')
  const iCdn = mediaRemotes.indexOf('fetchSnsCdnImage(')
  const iLocalOriginal = mediaRemotes.indexOf('local(false)')
  const iLocalThumb = mediaRemotes.indexOf('local(true)')

  it('两条分支都在：有网走 CDN，无网走已下载的原图缓存', () => {
    expect(mediaRemotes).toMatch(/const offline = options\.offline === true/)
    for (const [name, i] of [['有网分支', iBranch], ['无网分支', iOfflineElse], ['已下载原图缓存', iStore], ['CDN', iCdn]] as Array<[string, number]>) {
      expect(i, name + ' 那一步不见了').toBeGreaterThan(-1)
    }
    // 结构上：无网那段的 else 之后紧跟的就是查已下载原图 ⇒ 它在 else 里，不在有网分支里
    expect(iOfflineElse).toBeLessThan(iStore)
  })

  it('有网分支里只有 CDN，不经过任何本地判断', () => {
    expect(iCdn).toBeGreaterThan(iBranch)
    expect(iCdn, 'CDN 调用必须落在无网分支之前，也就是有网分支里').toBeLessThan(iOfflineElse)
    expect(iStore, '已下载原图缓存只能落在无网分支里').toBeGreaterThan(iOfflineElse)
    expect(iLocalOriginal, '本机原图只能落在两条分支之后（网络失败时回落）').toBeGreaterThan(iOfflineElse)
  })

  it('无网分支不发任何网络请求', () => {
    // iCdn 在 iOfflineElse 之前 ⇒ 无网那段里没有第二次 CDN 调用
    expect(mediaRemotes.indexOf('fetchSnsCdnImage(', iOfflineElse)).toBe(-1)
  })

  it('本机两档仍必须显式区分 allowThumb（漏传就退回旧行为：缩略图赢过原图）', () => {
    // local(allowThumb) 是唯一的前端封装；它必须把参数透传下去
    expect(mediaRemotes).toMatch(/const local = \(allowThumb: boolean\) =>/)
    expect(mediaRemotes).toMatch(/resolveSnsImageDataUrl\(base, aesKey, xorKey, options\.md5, options\.timelineId, options\.mediaId, allowThumb\)/)
    const calls = [...mediaRemotes.matchAll(/\blocal\((true|false)\)/g)].map((m) => m[1])
    expect(calls, '必须恰好两档：先原图、后缩略图').toEqual(['false', 'true'])
    expect(iLocalOriginal).toBeLessThan(iLocalThumb)
  })

  it('CDN 取回的原图要写穿落盘缓存（下次无网时才有本地可用）', () => {
    const after = mediaRemotes.slice(iCdn, iLocalOriginal)
    expect(after).toMatch(/saveOriginalFromDataUrl\(decoded, options\.md5, cdn\.dataUrl\)/)
  })

  it('本机原图拿到也写穿；缩略图刻意不写穿（否则缩略图会变成永久的「高清」）', () => {
    const thumbBranch = mediaRemotes.slice(iLocalThumb, iLocalThumb + 700)
    expect(thumbBranch).not.toMatch(/saveOriginalFromDataUrl\(decoded, options\.md5, localThumb\.url\)/)
    expect(thumbBranch).toMatch(/thumb: true/)
  })
})

describe('高清原图：缩略图不许被当成高清沉淀下来', () => {
  it('后端：缩略图那一档**不**写穿落盘缓存，且必须标 thumb', () => {
    const iThumb = mediaRemotes.indexOf('本机缩略图兜底')
    expect(iThumb).toBeGreaterThan(-1)
    const tail = mediaRemotes.slice(iThumb)
    // 缩略图分支里不许出现写盘调用
    const branch = tail.slice(0, tail.indexOf('}'))
    expect(branch).not.toContain('saveOriginalFromDataUrl')
    expect(branch).toContain('thumb: true')
  })

  it('后端：只有原图那两路写穿落盘', () => {
    const writes = [...mediaRemotes.matchAll(/saveOriginalFromDataUrl\(/g)].length
    // 加上函数自身的定义那一处，正好 3（定义 + 本机原图 + CDN）
    expect(writes).toBe(3)
  })

  it('前端：进面板恢复与单张查询都要遵守「先网后本」', () => {
    // 有网时不查本地缓存：产品规则是「有网直接取原图，不用经过本地判断」
    expect(momentsMedia).toMatch(/const cached = offline \? await snsMediaCacheGet\(it\.key, true\) : null/)
    // 批量恢复整段只在无网时做
    expect(momentsMedia).toMatch(/useEffect\(\(\) => \{\s*if \(!isOffline\(\)\) return/)
    // 网络状态由界面读同一个信号（navigator.onLine），不在后端另造一套探网
    expect(momentsMedia).toMatch(/navigator\.onLine === false/)
    // 并且把它传给后端，由后端决定走网络还是走本地
    expect(momentsMedia).toMatch(/opts\.offline = offline/)
    expect(mediaRemotes).toMatch(/offline\?: boolean/)
  })

  it('前端：写回时把 thumb 标记一起存下去', () => {
    expect(momentsMedia).toMatch(/snsMediaCacheSet\(it\.key, r\.url, r\.thumb === true\)/)
    expect(mediaCache).toMatch(/thumb\?: boolean/)
    // wantOriginal 为真时，缩略图**与 v1 旧条目**都必须当未命中。
    // 只判 thumb 不够：v1 条目根本没有这个字段（真机清点 1186 条里 1093 条是那种）。
    expect(mediaCache).toMatch(/wantOriginal && \(r\.thumb === true \|\| !isCurrent\(r\)\)/)
  })

  it('前端：缓存库带版本并在跨版本升级时清库（否则旧条目永远分辨不出好坏）', () => {
    expect(mediaCache).toMatch(/const MEDIA_DB_VERSION = \d+/)
    expect(mediaCache).toMatch(/ev\.oldVersion > 0 && ev\.oldVersion < MEDIA_DB_VERSION/)
    expect(mediaCache).toMatch(/store\.clear\(\)/)
    // 写回的条目必须带语义版本，否则 isCurrent 判不出来
    expect(mediaCache).toMatch(/v: MEDIA_ENTRY_V/)
  })

  it('朋友圈卡片不许拿 CDN 原始地址当 src（那是密文，原理上渲染不出来）', () => {
    const card = code(read('../../client/ui-wechat/src/client/pages/wechat-data/panels/moments-card.tsx'))
    // 图片那一路只能喂后端解出来的 data URL
    expect(card).toMatch(/src=\{dataSrc \?\? ''\}/)
    expect(card).not.toMatch(/src=\{dataSrc \|\| proxyableSrcAllowHttp/)
  })

  it('前端：淘汰按字节而不是条数（4000 条 × 大图 = 配额爆掉，而写入失败是静默的）', () => {
    expect(mediaCache).toContain('MEDIA_MAX_BYTES')
    expect(mediaCache).not.toContain('MEDIA_MAX_ENTRIES')
    // 必须盯住**那道提前返回的闸门本身**，不能只盯「出现过这个常量」——
    // 循环里还有一处 `total <= MEDIA_MAX_BYTES`，只查常量的话把闸门改成 `if (true)`
    // 照样能过（M406 就是这么漏过去的）。
    expect(mediaCache).toMatch(/if \(total <= MEDIA_MAX_BYTES \|\| rows\.length === 0\)/)
    // 每条记录必须带 size，否则算不出真实占用（base64 串长度就是它的大小）
    expect(mediaCache).toMatch(/size\?: number/)
  })
})