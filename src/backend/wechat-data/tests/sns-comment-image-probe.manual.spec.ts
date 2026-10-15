/**
 * **现场探针**：量朋友圈**评论图**（`<imageinfo>`）的真实形状
 * （默认跳过；`SNS_LIVE=1` 且 `SNS_LIVE_DB` 指向真库才跑）。
 *
 * ## 为什么要有它（2026-10-09 阶段 1）
 *
 * 评论图那一路有个「两个独立成因叠在一起」的历史问题，靠读代码只能看出一个：
 *
 *   · `moments.ts` 解析 `<imageinfo>` 时取了 `url`/`thumb_url`/`md5`/`media_id`，
 *     **唯独没取 `token` 和 `key`** —— 而这两个恰好是决定 CDN 返 200 还是 400 的东西；
 *   · `moments-media.ts` 转发 CDN 三件套时用 `kind === 'img'` 把门，
 *     评论图的 `kind` 是 `'comment'`，于是**就算填了也传不过去**。
 *
 * 修法分岔在「裸地址到底行不行」：如果裸地址能取到图，那只补 token 就行；
 * 如果裸地址必然 400，那卡片里那条 `proxyableSrc(img.thumb, img.url)` 兜底是**死代码**，
 * 必须删（留着只会把一个必然失败的请求交给渲染层）。这个不能猜，所以先量。
 *
 * 顺带量两件决定实现细节的事：
 *   ① 解密后 EOI 距末尾多少字节 —— 决定现有尾块处理（`trimToImageEnd`，256 字节窗口）
 *      是否已覆盖评论图，还是需要为评论图单开一套；
 *   ② 实收字节 vs `<file_size>` 声明 —— 判断有没有截断。
 *
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decryptSnsAll, SNS_HEAD_ENCRYPTED_BYTES } from '../src/query/sns-keystream.ts'
import { snsCdnUrl } from '../src/query/sns-cdn-url.ts'
import { weixinVersion } from '../src/query/config.ts'

const DB = process.env['SNS_LIVE_DB'] ?? ''
const LIVE = process.env['SNS_LIVE'] === '1' && DB !== ''
/** 探几条：现场跑一次要真网，够看清形态就行。 */
const LIMIT = Number(process.env['SNS_LIVE_LIMIT'] ?? '5')

interface Img {
  rowid: number
  url: string
  thumb: string
  token: string
  thumbToken: string
  seed: string
  fileSize: number
}

/** 与生产 `moments.ts` 同口径的实体反转义；不解压就 400（地址里的 `&` 是 `&amp;`）。 */
const unescapeXml = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const dec = (v: unknown): string => typeof v === 'string' ? v
  : (v instanceof Uint8Array ? new TextDecoder('utf-8').decode(v) : String(v ?? ''))
const group1 = (re: RegExp, s: string): string => re.exec(s)?.[1] ?? ''
const textOf = (xml: string, tag: string): string =>
  group1(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'), xml)

function pickCommentImages(): Img[] {
  if (!existsSync(DB)) return []
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare('SELECT rowid, content FROM SnsTimeLine ORDER BY rowid DESC').all() as Array<{ rowid: number; content: unknown }>
  const out: Img[] = []
  for (const r of rows) {
    for (const m of dec(r.content).matchAll(/<imageinfo\b[\s\S]*?<\/imageinfo>/gi)) {
      const b = m[0]
      out.push({
        rowid: r.rowid,
        url: unescapeXml(textOf(b, 'url')).trim(),
        thumb: unescapeXml(textOf(b, 'thumb_url')).trim(),
        token: unescapeXml(textOf(b, 'token')).trim(),
        thumbToken: unescapeXml(textOf(b, 'thumb_url_token')).trim(),
        seed: textOf(b, 'key').trim(),
        fileSize: Number(textOf(b, 'file_size').trim() || '0'),
      })
    }
    if (out.length >= LIMIT) break
  }
  db.close()
  return out
}

/** 最后一个 JPEG EOI 距末尾多少字节；没有则 -1。 */
function eoiFromEnd(b: Buffer): number {
  for (let i = b.length - 2; i >= 0; i -= 1) {
    if (b[i] === 0xff && b[i + 1] === 0xd9) return b.length - (i + 2)
  }
  return -1
}
const hex4 = (b: Buffer): string => [...b.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ')

/**
 * ⚠️ **必须带微信 UA**：微信 CDN 只认特定 UA，给通用 UA 就是 400 或 0 字节
 * （与 `sns-video.ts` 同一处注释）。
 */
const fetchBytes = async (url: string): Promise<{ res: Response; bytes: Buffer }> => {
  const res = await fetch(url, {
    headers: {
      'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) WeChat/${weixinVersion()}`,
      accept: '*/*',
    },
  })
  return { res, bytes: Buffer.from(await res.arrayBuffer()) }
}

describe.skipIf(!LIVE)('live: 朋友圈评论图形状探针（真库/真网/真 WASM）', () => {
  it('量裸地址 vs 补 token 的成败、解密后的结尾形态', async () => {
    const imgs = pickCommentImages()
    expect(imgs.length, '全表里没有 <imageinfo>（真库路径：' + DB + '）').toBeGreaterThan(0)

    const lines: string[] = ['=== 评论图实测（' + String(imgs.length) + ' 条）===']
    let bareOk = 0
    let withTokenOk = 0
    let overHeadLine = 0
    let cleanEoi = 0
    let withTrailer = 0
    let noEoi = 0

    for (const [i, g] of imgs.entries()) {
      lines.push('#' + String(i) + ' rowid=' + String(g.rowid) + ' 声明 file_size=' + String(g.fileSize)
        + (g.fileSize > SNS_HEAD_ENCRYPTED_BYTES ? ' ★声明已超128KB★' : '')
        + ' token长度=' + String(g.token.length) + ' seed=' + (g.seed === '' ? '★无★' : g.seed))

      // ① 裸地址（= 卡片里 `proxyableSrc(img.thumb, img.url)` 现在用的形态）
      const bare = await fetchBytes(g.url)
      if (bare.res.ok && bare.bytes.length > 0) bareOk += 1
      lines.push('    ① 裸 <url> 原样        : HTTP ' + String(bare.res.status) + ' bytes=' + String(bare.bytes.length))

      // ② 经 `snsCdnUrl` 补 token&idx=1（= 后端图片通路的形态）
      const built = snsCdnUrl(g.url, g.token)
      const withTok = await fetchBytes(built)
      if (withTok.res.ok && withTok.bytes.length > 0) withTokenOk += 1
      if (withTok.bytes.length > SNS_HEAD_ENCRYPTED_BYTES) overHeadLine += 1
      lines.push('    ② snsCdnUrl(补 token) : HTTP ' + String(withTok.res.status)
        + ' bytes=' + String(withTok.bytes.length) + ' x-enc=' + String(withTok.res.headers.get('x-enc') ?? '(无)')
        + ' 密文头=' + hex4(withTok.bytes))

      // ③ 整份解密后的结尾形态
      if (withTok.bytes.length > 0 && g.seed !== '') {
        const plain = (await decryptSnsAll(withTok.bytes, g.seed)).bytes
        const e = eoiFromEnd(plain)
        const isJpeg = plain[0] === 0xff && plain[1] === 0xd8 && plain[2] === 0xff
        if (e === 0) cleanEoi += 1
        else if (e > 0) withTrailer += 1
        else noEoi += 1
        lines.push('    ③ 整份解              : 解出 ' + String(plain.length) + ' 字节  是JPEG=' + String(isJpeg)
          + ' eoiFromEnd=' + String(e)
          + (e === 0 ? '（结尾干净）'
            : e > 0 ? '（有 ' + String(e) + ' 字节尾块 ⇒ 现有 256 字节窗口的 trimToImageEnd 能裁掉）'
              : '（找不到 EOI）'))
        if (e > 0 && e <= 64) lines.push('        尾块: ' + plain.subarray(plain.length - e).toString('hex'))
      }
    }

    const total = imgs.length
    const verdict = [
      '', '=== 汇总 ===',
      '  裸地址能取到图的:                 ' + String(bareOk) + ' / ' + String(total) + '   ← 卡片现在那条兜底的成功数',
      '  snsCdnUrl 补 token 能取到图的:    ' + String(withTokenOk) + ' / ' + String(total),
      '  其中实收 > 128 KB（必须整份解）:   ' + String(overHeadLine),
      '  解密后 EOI 就在末尾:              ' + String(cleanEoi),
      '  解密后带尾块（现有裁尾块能处理）:  ' + String(withTrailer),
      '  解密后找不到 EOI:                 ' + String(noEoi),
      '',
      bareOk === 0
        ? '判定：裸地址**一条都取不到** ⇒ 卡片里 `proxyableSrc(img.thumb, img.url)` 是死代码，必须删。'
        : '判定：裸地址能取到 ⇒ 只需补 token 转发，兜底可以留。',
      withTokenOk === 0
        ? '★ 注意：补 token 仍然全败 ⇒ 结论不能只靠这条，须换更近的样本再判（老动态的 CDN 链接可能过期）。'
        : '判定：补 token 后可取 ⇒ 后端图片通路可直接复用于评论图（`snsCdnUrl` 产出的形态与朋友圈图片一致）。',
      withTrailer > 0
        ? '判定：评论图**也有尾块** ⇒ 现有 `trimToImageEnd`（256 字节窗口）已覆盖，无需为评论图单开裁剪逻辑。'
        : cleanEoi > 0
          ? '判定：评论图解密后 EOI 就在末尾（无尾块）⇒ 现有处理天然兼容。'
          : '',
    ].join('\n')
    console.log('\n' + lines.join('\n') + '\n' + verdict + '\n')

    expect(imgs.length).toBeGreaterThan(0)
  }, 300000)
})
