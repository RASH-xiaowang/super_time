/**
 * **现场探针**：判定朋友圈 CDN 图片**到底加密了多大一段**（默认跳过；`SNS_LIVE=1` 才跑）。
 *
 * ## 为什么需要它（2026-10-08 的悬案）
 *
 * 应用里 8/12 张图失败，日志（`app.log`）记的是
 * `CDN=解密后图片不完整（结尾标记缺失，可能只解密了前 128 KB）`。
 * 从这条错误**推不出**成因 —— 当时的写法把「只解了头」当成既定事实写进了文案，
 * 于是「图片是整文件加密」这个断言既没被证实，也没被证伪，而它决定了修法：
 *
 * | | H1 整文件加密 | H2 只有前 128 KB 加密 |
 * |---|---|---|
 * | 修法 | 保留整份解，**放宽结尾判据** | 改回只解头，**结尾判据当探测器** |
 *
 * 两者修法相反，所以必须先测。单元测试测不出来：它们只证明「代码形状对」，
 * 证明不了「CDN 那 8 张图的尾部到底长什么样」。
 *
 * ## 这条用例怎么分辨 H1 / H2
 *
 * 对同一份 CDN 响应体跑三种处理，各自报「尾部 EOI 距离文件末尾多少字节」：
 *
 *  · `raw`   —— 完全不解密。**若这里已经有合法 JPEG 且 EOI 就在末尾 ⇒ H2 直接成立**
 *               （密文只盖住头部，尾部本来就是明文 JPEG 数据）；
 *  · `head`  —— 只解前 128 KB（`decryptSnsHead`）；
 *  · `all`   —— 整份解（`decryptSnsAll`）。
 *
 * 哪种处理能让尾部出现合法 EOI，哪种假设就是对的。同时记录 `X-Enc` 响应头 ——
 * 参考项目 `WeChatDataAnalysis-main/src/wechat_decrypt_tool/sns_media.py:1234-1239`
 * 就是靠它决定要不要解密，而我们的 `sns-cdn-image.ts` 压根没读这个头。
 *
 * 魔数识别对齐参考项目的 `sns_media.py:840-852`（含 AVIF/HEIF/HEIC/BMP），
 * 外加 WebP —— 我们现在的 `sniffImage` 只认 JPEG/PNG，其余一律判失败。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { snsCdnUrl } from '../src/query/sns-cdn-url.ts'
import { fetchSnsCdnImage } from '../src/query/sns-cdn-image.ts'
import { decryptSnsAll, decryptSnsHead } from '../src/query/sns-keystream.ts'

const DB = process.env['SNS_LIVE_DB']
  ?? 'C:/Users/Administrator/AppData/Roaming/super-time-electron/wechat-data/decrypted/sns/sns.db'
const OUT = 'D:/super-time-wechat/working'
const LIVE = process.env['SNS_LIVE'] === '1'
/** 最多探几张：现场跑一次要真网，样本够分辨 H1/H2 就行。 */
const LIMIT = Number(process.env['SNS_LIVE_LIMIT'] ?? '9')

interface Pick {
  url: string
  token: string
  /** 生产口径（`moments.ts:270`）：`<enc key>` → `<thumb key>` → `<url key>`。 */
  prodKey: string
  /** 逐个候选，用来分辨「哪个 key 能解出图片」——跨层抓的 LivePhoto key 会单独标出来。 */
  candidates: Array<{ name: string; key: string }>
  md5: string
}

const text = (v: unknown): string => typeof v === 'string' ? v
  : (v instanceof Uint8Array ? new TextDecoder('utf-8').decode(v) : String(v ?? ''))

const group1 = (re: RegExp, s: string): string => re.exec(s)?.[1] ?? ''

/**
 * 逐字复刻生产代码 `moments.ts:143-158` 的 `xmlTagAttr`（纯 `indexOf`，**不区分嵌套**）。
 *
 * 为什么必须逐字复刻而不是用正则：`<enc key>` 在朋友圈 XML 里**常常是嵌在
 * `<LivePhoto><liveMedia>` 里那段视频的 key**，正则会跨层抓到它，而生产的
 * `indexOf('<enc>')` 因为顶层 `<enc>0</enc>` 先精确匹配而返回 `null`。
 * 两条路径取到的 key 不同 —— 本文件第一版用正则，结果 9 张里 7 张拿视频的 key 去解图片，
 * 报出「头不是图片」的假象。
 */
function xmlTagAttr(xml: string, tag: string, attr: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const tagEnd = xml.indexOf('>', start)
  if (tagEnd < 0) return null
  const tagStr = xml.slice(start, tagEnd)
  const search = attr + '="'
  const a = tagStr.indexOf(search)
  if (a < 0) return null
  const v = a + search.length
  const e = tagStr.indexOf('"', v)
  if (e < 0) return null
  return tagStr.slice(v, e)
}

/** 从真库最近的多图动态里取样本（沿用 `sns-live-verify.manual.spec.ts` 的口径）。 */
function pickMedia(): Pick[] {
  if (!existsSync(DB)) return []
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare('SELECT content FROM SnsTimeLine ORDER BY rowid DESC LIMIT 40').all() as Array<{ content: unknown }>
  const out: Pick[] = []
  for (const r of rows) {
    const xml = text(r.content)
    const blocks = [...xml.matchAll(/<media>([\s\S]*?)<\/media>/g)].map((m) => m[1] ?? '')
    if (blocks.length < 3) continue
    for (const b of blocks) {
      const body = /<url\b[^>]*>([^<]+)<\/url>/.exec(b)?.[1]
      if (body === undefined) continue
      const attrs = /<url\b([^>]*)>/.exec(b)?.[1] ?? ''
      const thumbAttrs = /<thumb\b([^>]*)>/.exec(b)?.[1] ?? ''
      out.push({
        url: body.trim(),
        token: group1(/token="([^"]+)"/, attrs) || group1(/token="([^"]+)"/, thumbAttrs),
        prodKey: xmlTagAttr(b, 'enc', 'key') ?? xmlTagAttr(b, 'thumb', 'key') ?? xmlTagAttr(b, 'url', 'key') ?? '',
        candidates: [
          { name: 'enc(顶层)', key: xmlTagAttr(b, 'enc', 'key') ?? '' },
          { name: 'thumb.key', key: xmlTagAttr(b, 'thumb', 'key') ?? '' },
          { name: 'url.key', key: xmlTagAttr(b, 'url', 'key') ?? '' },
          // 跨层正则：会命中 LivePhoto 里视频的 key —— 保留它是为了证明「抓错的后果」
          { name: 'enc(跨层正则)', key: group1(/<enc\b[^>]*key="([^"]+)"/, b) },
        ].filter((c) => c.key !== ''),
        md5: group1(/md5="([^"]+)"/, attrs),
      })
    }
    break
  }
  db.close()
  return out
}

/**
 * 图片魔数识别，口径对齐参考项目 `sns_media.py:840-852`（外加 WebP）。
 *
 * 我们线上那版 `sns-cdn-image.ts` 的 `sniffImage` 只认 JPEG/PNG ——
 * 若微信真给过 AVIF/HEIC，那批图会被判成「解密后仍不是图片格式」而根本没走到结尾判据。
 */
function detectMime(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 6 && b.subarray(0, 3).every((x, i) => x === 'GIF'.charCodeAt(i))) return 'image/gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b.length >= 12 && b.subarray(0, 4).every((x, i) => x === 'RIFF'.charCodeAt(i))
    && b.subarray(8, 12).every((x, i) => x === 'WEBP'.charCodeAt(i))) return 'image/webp'
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0)
    if (brand === 'avif') return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic'
    if (['heif', 'mif1', 'msf1'].includes(brand)) return 'image/heif'
  }
  return ''
}

/** 尾部最后一个 JPEG EOI（`FF D9`）距离文件末尾的字节数；没有则 `-1`。 */
function eoiFromEnd(b: Uint8Array): number {
  for (let i = b.length - 2; i >= 0; i -= 1) {
    if (b[i] === 0xff && b[i + 1] === 0xd9) return b.length - (i + 2)
  }
  return -1
}

/** 尾部 PNG `IEND`（`49 45 4E 44 AE 42 60 82`）距离文件末尾的字节数；没有则 `-1`。 */
function iendFromEnd(b: Uint8Array): number {
  const need = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
  for (let i = b.length - need.length; i >= 0; i -= 1) {
    if (need.every((v, k) => b[i + k] === v)) return b.length - (i + need.length)
  }
  return -1
}

/** 一份字节的判定摘要。`tail` 是「结尾标记距末尾多少字节」，`-1` = 没找到。 */
function probe(b: Uint8Array): string {
  const mime = detectMime(b)
  const head = [...b.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ')
  if (mime === 'image/jpeg') return 'jpeg head=' + head + ' eoiFromEnd=' + String(eoiFromEnd(b))
  if (mime === 'image/png') return 'png  head=' + head + ' iendFromEnd=' + String(iendFromEnd(b))
  return (mime === '' ? 'none' : mime) + ' head=' + head + ' eoiFromEnd=' + String(eoiFromEnd(b))
}

describe.skipIf(!LIVE)('live: 朋友圈 CDN 图片加密范围探针（真库/真网/真 WASM）', () => {
  it('分辨「整文件加密」与「只有前 128 KB 加密」，并分辨哪个 key 能解出图片', async () => {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
    const media = pickMedia().slice(0, LIMIT)
    expect(media.length, '样本里没有多图动态（真库路径：' + DB + '）').toBeGreaterThan(0)

    const lines: string[] = []
    let rawTailOk = 0
    let headTailOk = 0
    let allTailOk = 0
    let fetched = 0
    /** 用生产口径的 key 解出来的，能被认成图片的张数。 */
    let prodIsImage = 0

    for (const [i, m] of media.entries()) {
      const seed = m.prodKey
      const res = await fetch(snsCdnUrl(m.url, m.token))
      const raw = Buffer.from(await res.arrayBuffer())
      if (res.ok && raw.length > 0) fetched += 1
      const head = (await decryptSnsHead(raw, seed)).bytes
      const all = (await decryptSnsAll(raw, seed)).bytes
      if (detectMime(all) !== '') prodIsImage += 1

      const tailOkOf = (b: Uint8Array): boolean => {
        const mime = detectMime(b)
        if (mime === 'image/jpeg') return eoiFromEnd(b) === 0
        if (mime === 'image/png') return iendFromEnd(b) === 0
        return false
      }
      if (tailOkOf(raw)) rawTailOk += 1
      if (tailOkOf(head)) headTailOk += 1
      if (tailOkOf(all)) allTailOk += 1

      // 每个候选 key 各解一遍：哪个能解出图片，一眼就能看出来
      const perKey = await Promise.all(m.candidates.map(async (c) => {
        const dec = (await decryptSnsAll(raw, c.key)).bytes
        const mime = detectMime(dec)
        return c.name + '=' + (mime === '' ? '非图片' : mime.replace('image/', '') + '/eoi' + String(eoiFromEnd(dec)))
      }))

      lines.push('#' + String(i) + ' HTTP ' + String(res.status)
        + ' ct=' + String(res.headers.get('content-type') ?? '')
        + ' x-enc=' + String(res.headers.get('x-enc') ?? '(无)')
        + ' bytes=' + String(raw.length)
        + ' prodKey=' + (seed === '' ? '(空!)' : seed)
        + '\n      raw  ' + probe(raw)
        + '\n      head ' + probe(head)
        + '\n      all  ' + probe(all)
        + '\n      key  ' + (perKey.length > 0 ? perKey.join('  ') : '(无候选)'))

      // 把三种结果都落盘，肉眼与解码器都比「eoiFromEnd」这个数字更能说明问题
      writeFileSync(OUT + '/probe-' + String(i) + '-raw.bin', raw)
      writeFileSync(OUT + '/probe-' + String(i) + '-head.bin', head)
      writeFileSync(OUT + '/probe-' + String(i) + '-all.bin', all)
    }

    const verdict = [
      '=== 现场结果（' + String(fetched) + '/' + String(media.length) + ' 取回成功）===',
      ...lines,
      '',
      '=== 生产口径 key 解出来能被认成图片的张数 ===',
      '  ' + String(prodIsImage) + '/' + String(media.length),
      '',
      '=== 尾部**正好**在末尾（结束标记距离 = 0）的张数 ===',
      '  完全不解密 (raw) : ' + String(rawTailOk),
      '  只解前 128 KB    : ' + String(headTailOk),
      '  整份解密 (all)   : ' + String(allTailOk),
      '',
      '=== 2026-10-08 首次运行的判定（据上面的数字）===',
      '  · 图片是**整文件**加密（H1）⇒ `decryptSnsAll` 是对的，不需要退回只解头；',
      '  · 解密后 EOI 并不贴住末尾，而是**恒定差 24 字节**（CDN 签名块）⇒',
      '    旧判据「最后两字节必须是 ff d9」把 9/9 张好图全判成失败；',
      '  · `x-enc: 1` 是真实响应头，参考项目靠它决定要不要解密，我们原先无条件 XOR；',
      '  · 生产口径的 key 取对了（`<url key>`/`<thumb key>`）。跨层正则抓到的',
      '    `enc(跨层正则)` 解出来一律「非图片」——那是 LivePhoto 里视频的 key，不能用于图片。',
    ].join('\n')
    console.log('\n' + verdict + '\n')

    // 这条用例的价值是**把数字摆出来**，不是断言某一个假设成立 ——
    // 所以只断言「确实探到了样本」，具体结论留给上面那段文字与人判断。
    expect(fetched, '一张都没取回（网络或 token 问题，不是加密范围问题）').toBeGreaterThan(0)
  }, 180000)

  it('真数据走完整生产通路 `fetchSnsCdnImage`：裁掉 CDN 尾块后应当逐张成图', async () => {
    const media = pickMedia().slice(0, LIMIT)
    expect(media.length, '样本里没有多图动态（真库路径：' + DB + '）').toBeGreaterThan(0)

    const fails: string[] = []
    let ok = 0
    for (const [i, m] of media.entries()) {
      const r = await fetchSnsCdnImage(m.url, m.token, m.prodKey)
      if (r.dataUrl === undefined) {
        fails.push('#' + String(i) + ' ' + String(r.error ?? '(无原因)'))
        continue
      }
      // 字节级断言：交付的字节必须**紧贴**结束标记 —— 这正是旧判据栽的地方
      const out = Buffer.from(r.dataUrl.slice(r.dataUrl.indexOf(',') + 1), 'base64')
      const jpeg = out.length > 2 && out[0] === 0xff && out[1] === 0xd8 && out[out.length - 2] === 0xff && out[out.length - 1] === 0xd9
      const png = out.length > 8 && out[0] === 0x89 && out[8] === 0x49
      if (!jpeg && !png) {
        fails.push('#' + String(i) + ' 交付的字节没有紧贴结束标记（长度 ' + String(out.length) + '）')
        continue
      }
      ok += 1
    }
    console.log('\n=== 生产通路真机结果 ===\n成图 ' + String(ok) + '/' + String(media.length)
      + (fails.length > 0 ? '\n失败：\n  ' + fails.join('\n  ') : '') + '\n')

    expect(fails, '有图片没能成图（这是本次修复的验收判据）').toEqual([])
    expect(ok).toBe(media.length)
  }, 180000)
})