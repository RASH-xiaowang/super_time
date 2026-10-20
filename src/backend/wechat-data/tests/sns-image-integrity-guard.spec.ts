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

describe('本地优先：长期归档 → 解码缓存 → 本机原图 → CDN（顺序不许被调换）', () => {
  const iImgFn = mediaRemotes.indexOf('async function snsImageWithCdnFirst')
  const endOfImgFn = iImgFn < 0 ? null : /\n\}\r?\n/.exec(mediaRemotes.slice(iImgFn))
  const afterImgFn = iImgFn < 0 ? '' : mediaRemotes.slice(iImgFn, iImgFn + (endOfImgFn?.index ?? 0))
  /** 在**这个函数内**找，但返回整文件里的绝对下标 —— 下面的 `.slice(iCdn, …)` 还要用它。 */
  const findInImg = (needle: string, fromInImg = 0): number => {
    const i = afterImgFn.indexOf(needle, fromInImg)
    return i < 0 ? -1 : i + iImgFn
  }
  const iArchived = findInImg('lookupArchivedOriginal(decoded, options.md5)')
  const iStore = findInImg('lookupOriginal(decoded, options.md5)')
  const iCdn = findInImg('fetchSnsCdnImage(')
  const iLocalOriginal = findInImg('local(false)')
  const iLocalThumb = findInImg('local(true)')

  it('切片带边界：取到的正好是 snsImageWithCdnFirst 这个函数，不含后面的顶层函数', () => {
    expect(iImgFn, 'snsImageWithCdnFirst 不见了').toBeGreaterThan(-1)
    expect(afterImgFn.startsWith('async function snsImageWithCdnFirst')).toBe(true)
    expect(afterImgFn).toContain('fetchSnsCdnImage(')
    expect(afterImgFn, '切片越界吃进了别的顶层函数').not.toContain('snsVideoCoverWithCdnFirst')
  })

  it('四路顺序：长期归档 → 解码缓存 → 本机原图 → CDN；缩略图永远最后', () => {
    for (const [name, i] of [
      ['长期归档', iArchived], ['解码缓存', iStore], ['本机原图', iLocalOriginal],
      ['CDN', iCdn], ['本机缩略图', iLocalThumb],
    ] as Array<[string, number]>) {
      expect(i, name + ' 那一步不见了').toBeGreaterThan(-1)
    }
    expect(iArchived).toBeLessThan(iStore)
    expect(iStore).toBeLessThan(iLocalOriginal)
    expect(iLocalOriginal).toBeLessThan(iCdn)
    expect(iCdn).toBeLessThan(iLocalThumb)
  })

  it('CDN 只在本地两路都没有且在线时才调（离线/缺三件套都不出网）', () => {
    expect(afterImgFn).toMatch(/if \(!offline && hasCdn\) \{/)
    // CDN 之前必须已经查过归档/缓存/本机原图（否则又会「有网先网」）
    expect(iCdn).toBeGreaterThan(iArchived)
    expect(iCdn).toBeGreaterThan(iStore)
    expect(iCdn).toBeGreaterThan(iLocalOriginal)
  })

  it('本机两档仍必须显式区分 allowThumb（漏传就退回旧行为：缩略图赢过原图）', () => {
    expect(mediaRemotes).toMatch(/const local = async \(allowThumb: boolean\) =>/)
    expect(mediaRemotes).toMatch(/resolveSnsImageDataUrl\(base, aesKey, xorKey, options\.md5, options\.timelineId, options\.mediaId, allowThumb\)/)
    const calls = [...mediaRemotes.matchAll(/\blocal\((true|false)\)/g)].map((m) => m[1])
    expect(calls, '必须恰好两档：先原图、后缩略图').toEqual(['false', 'true'])
    expect(iLocalOriginal).toBeLessThan(iLocalThumb)
  })

  it('CDN 取回的原图要写穿两处缓存（解码缓存 + 长期归档）', () => {
    // CDN 调用之后紧跟 CDN 分支的落盘；此时 iLocalOriginal 已经在前，不能再拿它当右边界。
    const after = mediaRemotes.slice(iCdn, iCdn + 700)
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

  it('后端：原图两路 + 视频封面写穿落盘；缩略图不写', () => {
    const writes = [...mediaRemotes.matchAll(/saveOriginalFromDataUrl\(/g)].length
    // 定义一处 + 本机原图 + CDN + 视频封面（rememberCover）。缩略图那一路刻意不在里面。
    expect(writes).toBe(4)
  })

  it('前端：进面板恢复与单张查询都遵守「本地优先」', () => {
    // 单张先查 IndexedDB 原图（命中就不再出网）
    expect(momentsMedia).toMatch(/const cached = await snsMediaCacheGet\(it\.key, true\)/)
    // 批量恢复不再分有网/无网
    expect(momentsMedia).not.toMatch(/if \(!isOffline\(\)\) return/)
    expect(momentsMedia).toMatch(/snsMediaCacheGetMany\(keys, true\)/)
    // 网络状态由界面读同一个信号（navigator.onLine），不在后端另造一套探网
    expect(momentsMedia).toMatch(/navigator\.onLine === false/)
    // 并且把它传给后端：后端仍要靠它决定「本地都没有时能不能出网」
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

/*
 * ============================================================================
 * 2026-10-09（阶段 1）：评论图与视频封面
 *
 * 现场实测见两个探针（`SNS_LIVE=1` 跑）：
 *   · `sns-comment-image-probe.manual.spec.ts`：评论图裸 `<url>` **5/5 HTTP 400**，
 *     补 `?token=…&idx=1` 后 **5/5 HTTP 200**；解密后 EOI 距末尾 **24 字节**（与图片同形）。
 *   · `sns-video-cover-probe.manual.spec.ts`：12 个封面**全部 < 128 KB**，只解头就完整
 *     ⇒ 「只解头」对封面当下是对的（所以不能一律改整份解），缺的是**结尾校验**与 **offline**。
 *
 * 这几组守卫盯的是「结论**被用上**」，不是「结论**被写下**」：
 * 评论图要通，得**四处同时**成立（解析出 token/key、类型允许、渲染层登记、批处理放行），
 * 少一处就静默退回 `[图]`；这类「四处拼起来才对」的接线最容易被单点改动悄悄拆掉。
 * ============================================================================
 */
const PANELS = '../../client/ui-wechat/src/client/pages/wechat-data/panels'
const cardSrc = code(read(`${PANELS}/moments-card.tsx`))
const portalsSrc = code(read(`${PANELS}/moments-portals.tsx`))
const mediaHook = code(read(`${PANELS}/moments-media.ts`))
const videoQuery = code(read('src/query/sns-video.ts'))
const remotesMedia = code(read('src/remotes/media.ts'))

describe('评论图：token/key 从解析到批处理，四处缺一不可', () => {
  it('① 解析器从 <imageinfo> 里取 token 与 key（缺了就必然 400）', () => {
    const src = code(moments)
    expect(src).toMatch(/image\.token\s*=/)
    expect(src).toMatch(/image\.seed\s*=/)
    // 必须反转义：库里的查询串一律写成 &amp;，不解压参数名就发错
    expect(src).toMatch(/unescapeXml\(xmlTagText\(ib, 'token'\)/)
    expect(src).toMatch(/unescapeXml\(xmlTagText\(ib, 'key'\)/)
  })

  it('② 客户端类型 MomentCommentItem 也带 token/seed（后端类型改了、客户端没改就是白改）', () => {
    const types = code(read('src/types-moments.ts'))
    expect(types).toMatch(/token\?: string; seed\?: string/)
  })

  it('③ 卡片与详情浮层登记评论图时都带上 url/token/seed', () => {
    for (const [name, src] of [['moments-card.tsx', cardSrc], ['moments-portals.tsx', portalsSrc]] as const) {
      expect(src, `${name} 少了 kind: 'comment'`).toContain("kind: 'comment'")
      expect(src, `${name} 没把 url 交给后端`).toMatch(/\.\.\.\(img\.url \? \{ url: img\.url \}/)
      expect(src, `${name} 没把 token 交给后端`).toMatch(/\.\.\.\(img\.token \? \{ token: img\.token \}/)
      expect(src, `${name} 没把 seed 交给后端`).toMatch(/\.\.\.\(img\.seed \? \{ seed: img\.seed \}/)
    }
  })

  it('④ 批处理放行 CDN 三件套的判据是「不是视频」，不是「是 img」', () => {
    // 这条是本 PR 里最容易回归的一处：把 `!== 'video'` 写回 `=== 'img'`，
    // 评论图就静默退回 [图]，而所有单测仍然全绿（因为它们都不走真实批处理）。
    expect(mediaHook).toMatch(/it\.kind !== 'video' && it\.url/)
    expect(mediaHook).toMatch(/it\.kind !== 'video' && it\.token/)
    expect(mediaHook).toMatch(/it\.kind !== 'video' && it\.seed/)
    expect(code(mediaHook)).not.toMatch(/it\.kind === 'img' && it\.(?:url|token|seed)/)
  })

  it('详情浮层的评论图也挂 data-sns-key（否则 portal 出来的格子没人观察 ⇒ 没人取图）', () => {
    expect(portalsSrc).toMatch(/data-sns-key=\{img\?\.md5 \|\| undefined\}/)
    // 观察的那次补扫要覆盖 document（浮层 portal 到 body，不在滚动容器里）
    expect(mediaHook).toMatch(/document\.querySelectorAll<HTMLElement>\('\[data-sns-key\]'\)/)
    // 并且要有「浮层变了就重扫」的触发信号，否则新渲染的浮层节点仍然扫不到
    expect(mediaHook).toMatch(/\[moments, detailKey\]/)
  })
})

describe('朋友圈媒体：<img src> 不许直接吃 CDN 原始地址（那是密文）', () => {
  it('卡片与详情浮层都不再把 SNS 的 url/thumb 当 src 兜底', () => {
    // 实测：3219 条地址里只有 9 条是 https（proxyableSrc 只收 https/data/blob）
    // ⇒ 这些 `|| proxyableSrc(...)` 兜底几乎恒为空串；一旦命中就是**密文**，渲染必失败。
    for (const [name, src] of [['moments-card.tsx', cardSrc], ['moments-portals.tsx', portalsSrc]] as const) {
      expect(src, `${name} 还在把 CDN 地址当 src`).not.toMatch(/proxyableSrc\(/)
      expect(src, `${name} 还在 import proxyableSrc`).not.toContain('from \'../utils/url.ts\'')
      // 不许出现「取不到就拿远端地址顶上」的任何形态
      expect(src, `${name} 还有裸远端兜底`).not.toMatch(/\|\|\s*proxyableSrc/)
    }
  })

  it('「原图」开关连同它的状态一起删掉了（它唯一的实现就是密文，且 3219 条里只有 9 条 https ⇒ 恒禁用）', () => {
    for (const f of [`${PANELS}/moments-card.tsx`, `${PANELS}/moments-portals.tsx`, `${PANELS}/moments-panel.tsx`, `${PANELS}/moments-viewer.ts`]) {
      expect(read(f), `${f} 还留着 viewOriginal`).not.toContain('viewOriginal')
    }
  })
})

describe('视频封面：按大小分流 + 结尾校验 + offline', () => {
  it('走的是「>128 KB 才整份解、否则只解头但要过结尾校验」这条', () => {
    expect(videoQuery).toContain('coverEndsComplete')
    expect(videoQuery).toMatch(/raw\.length > SNS_HEAD_ENCRYPTED_BYTES/)
    // 两档都要有：只写一档就会在另一档上静默交付坏图
    expect(videoQuery).toMatch(/decryptSnsAll\(raw, seed\)/)
    expect(videoQuery).toMatch(/decryptSnsHead\(raw, seed\)/)
    // 结尾窗口必须是有界常量（无界搜索会把「图被截断」也判成通过）
    const m = /const COVER_END_SCAN_WINDOW = (\d+)/.exec(videoQuery)
    expect(m, 'COVER_END_SCAN_WINDOW 必须是常量数字').not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(0)
    expect(Number(m![1])).toBeLessThanOrEqual(4096)
  })

  it('封面没有种子时明说缺 <enc key>，不许含糊成别的成因', () => {
    expect(videoQuery).toContain('没有 <enc key>，无法解密')
  })

  it('getSnsVideoCoverDataUrl 收 offline，且远端请求在 !offline 分支里', () => {
    expect(remotesMedia).toMatch(/getSnsVideoCoverDataUrl\(options: \{[^}]*offline\?: boolean/)
    expect(remotesMedia).toMatch(/const offline = options\.offline === true/)
    // 有网时远端优先、无网时只走本机：判据必须挂在 !offline 上
    expect(remotesMedia).toMatch(/if \(!offline && remote !== '' && \/\^https\?:/)
  })

  it('视频本体那条保持「只解头」—— 它只用来探时长/宽高，不许跟着改成整份解', () => {
    // 切片按「下一个导出函数」划，不要用 `[\s\S]*?\n\}`：函数体里第一个顶格 `}` 就是某个
    // 内层块的结尾（`if (!isMp4Container(...)) {`），非贪婪匹配会在那里停下，切出一小截。
    const iBody = videoQuery.indexOf('export async function fetchSnsVideoDataUrl')
    const iCover = videoQuery.indexOf('export async function fetchSnsCoverDataUrl')
    expect(iBody, '找不到 fetchSnsVideoDataUrl').toBeGreaterThan(-1)
    expect(iCover, '找不到 fetchSnsCoverDataUrl').toBeGreaterThan(iBody)
    const body = videoQuery.slice(iBody, iCover)
    expect(body).toContain('decryptSnsHead')
    expect(body, '视频本体不许改成整份解（那是封面那条路）').not.toContain('decryptSnsAll')
  })
})
