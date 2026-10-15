/**
 * **现场探针**：量朋友圈**视频封面**的真实形状
 * （默认跳过；`SNS_LIVE=1` 且 `SNS_LIVE_DB` 指向真库才跑）。
 *
 * ## 为什么要有它（2026-10-08 阶段 1）
 *
 * `sns-video.ts` 的封面通路有两处已知可疑，而**修法取决于它们的真实触发条件**：
 *
 *   · `fetchSnsCoverDataUrl` 用 `decryptSnsHead`（**只解前 128 KB**），而 `imageMimeOf`
 *     只看 JPEG 头 3 个字节就放行 ⇒ 封面超过 128 KB 时，交付的是一份**尾部仍是密文**的
 *     data URL，浏览器渲染失败 —— 与我这轮修的朋友圈图片是同一类缺陷；
 *   · 全程**没有任何结尾完整性校验**，所以上面那种坏文件会被当成好图直接交出去。
 *
 * 但**不能凭推断改**：若实测封面普遍小于 128 KB，那这就是隐患而不是现网缺陷，
 * 修法应该是「加校验 + 超限时才整份解」而不是「一律整份解」（后者会让小封面白付 3 倍 CPU）。
 * 所以这里先把四件事量出来：
 *
 *   ① 封面字节数的分布，及其与 131072 这条线的关系；
 *   ② 响应体是**密文**还是已经是图片（决定要不要解密）；
 *   ③ 只解头之后，头是否合法、**结尾标记是否还在末尾**；
 *   ④ 整份解之后同一张封面的结尾标记距离末尾多少字节（用来确认尾块形态与图片一致）。
 *
 * 顺带量**评论图**：卡片那一路仍拿 `proxyableSrc(img.thumb, img.url)` 直接当 `src`
 * （见 `moments-card.tsx`），若那些地址返回的也是密文，那条兜底同样原理上渲染不出来。
 *
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptSnsAll, decryptSnsHead, SNS_HEAD_ENCRYPTED_BYTES } from '../src/query/sns-keystream.ts'
import { weixinVersion } from '../src/query/config.ts'

const DB = process.env['SNS_LIVE_DB'] ?? ''
const LIVE = process.env['SNS_LIVE'] === '1' && DB !== ''
/** 最多探几个封面：现场跑一次要真网，够看清分布就行。 */
const LIMIT = Number(process.env['SNS_LIVE_LIMIT'] ?? '12')

interface Vid {
  tid: string
  mediaId: string
  coverUrl: string
  seed: string
  declaredSize: string
}

/**
 * 反转义 XML 实体。
 *
 * ⚠️ 不做这一步就 400：微信的 XML 把查询串里的 `&` 写成 `&amp;`，直接拿去请求的话
 * 实际发出去的是 `…?encfilekey=…&amp;token=…&amp;idx=1` ⇒ 参数名全错、CDN 返 400 与 0 字节。
 * 生产代码走 `moments.ts` 的 `unescapeXml`；本探针直读原始 XML，所以必须自己补。
 * （朋友圈**图片**的地址没有查询参数，所以图片那条探针不会暴露这个问题。）
 */
const unescapeXml = (s: string): string => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')

const dec = (v: unknown): string => typeof v === 'string' ? v
  : (v instanceof Uint8Array ? new TextDecoder('utf-8').decode(v) : String(v ?? ''))
const group1 = (re: RegExp, s: string): string => re.exec(s)?.[1] ?? ''
const textOf = (xml: string, tag: string): string =>
  group1(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'), xml)
const attrOf = (xml: string, tag: string, attr: string): string =>
  group1(new RegExp('\\b' + attr + '="([^"]*)"'), group1(new RegExp('<' + tag + '\\b([^>]*)>', 'i'), xml))

/** 取最近若干条**视频类**（`type=6`）动态的封面信息。 */
function pickCovers(): Vid[] {
  if (!existsSync(DB)) return []
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db.prepare('SELECT content FROM SnsTimeLine ORDER BY rowid DESC LIMIT 400').all() as Array<{ content: unknown }>
  const out: Vid[] = []
  for (const r of rows) {
    const xml = dec(r.content)
    const tid = textOf(xml, 'id').trim()
    for (const m of xml.matchAll(/<media>([\s\S]*?)<\/media>/g)) {
      const b = m[1] ?? ''
      if (textOf(b, 'type').trim() !== '6') continue
      const coverUrl = unescapeXml(textOf(b, 'thumb')).trim()
      if (coverUrl === '') continue
      out.push({
        tid,
        mediaId: textOf(b, 'id').trim(),
        coverUrl,
        seed: unescapeXml(attrOf(b, 'enc', 'key')),
        declaredSize: attrOf(b, 'size', 'totalSize'),
      })
    }
    if (out.length >= LIMIT) break
  }
  db.close()
  return out
}

/**
 * 取封面字节。
 *
 * ⚠️ **必须带微信 UA**：微信 CDN 只认特定 UA，给通用 UA 就是 400 或 0 字节
 * （见 `sns-video.ts` 的同一处注释）。第一版探针用裸 `fetch`，结果 http 版本非 200、
 * https 版本又撞 TLS —— 两个都是「没带 UA / 协议不对」，不是封面的性质。
 * 协议口径照 `fetchSnsMediaBytes`：库里的地址原样用。
 */
async function fetchCover(url: string): Promise<{ res: Response; bytes: Buffer }> {
  const headers = {
    'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) WeChat/${weixinVersion()}`,
    accept: '*/*',
  }
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (e) {
    // 协议不通就换 https 再试一次，并把两次都记下来（分清「证书问题」与「地址问题」）
    res = await fetch(url.replace(/^http:/i, 'https:'), { headers }).catch(() => {
      throw e
    })
  }
  return { res, bytes: Buffer.from(await res.arrayBuffer()) }
}

/** JPEG/PNG 魔数（只看头，与 `sns-video.ts` 的 `imageMimeOf` 同一口径）。 */
function imageMimeOf(b: Buffer): 'jpeg' | 'png' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 8 && b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png'
  return null
}
/** 最后一个 JPEG EOI 距末尾多少字节；没有则 -1。 */
function eoiFromEnd(b: Buffer): number {
  for (let i = b.length - 2; i >= 0; i -= 1) {
    if (b[i] === 0xff && b[i + 1] === 0xd9) return b.length - (i + 2)
  }
  return -1
}
const hex4 = (b: Buffer): string => [...b.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ')

describe.skipIf(!LIVE)('live: 朋友圈视频封面形状探针（真库/真网/真 WASM）', () => {
  it('量封面字节分布、是否密文、只解头与整份解的结尾差异', async () => {
    const covers = pickCovers()
    expect(covers.length, '样本里没有视频动态（真库路径：' + DB + '）').toBeGreaterThan(0)

    const lines: string[] = []
    let overLine = 0
    let needDecrypt = 0
    let headOkButTailBroken = 0
    let allOk = 0
    let plainNoDecrypt = 0

    for (const [i, c] of covers.entries()) {
      // 封面 URL 自带 token + idx=1；协议口径与 fetchSnsMediaBytes 一致（库里的地址原样用）
      const { res, bytes: raw } = await fetchCover(c.coverUrl)
      const xEnc = String(res.headers.get('x-enc') ?? '(无)')
      const over = raw.length > SNS_HEAD_ENCRYPTED_BYTES
      if (over) overLine += 1

      const rawMime = imageMimeOf(raw)
      if (rawMime !== null) plainNoDecrypt += 1
      let headDesc = 'n/a'
      let allDesc = 'n/a'
      if (rawMime === null && c.seed !== '') {
        needDecrypt += 1
        const head = (await decryptSnsHead(raw, c.seed)).bytes
        const all = (await decryptSnsAll(raw, c.seed)).bytes
        const hm = imageMimeOf(head)
        const am = imageMimeOf(all)
        headDesc = (hm ?? '非图片') + ' eoiFromEnd=' + String(eoiFromEnd(head))
        allDesc = (am ?? '非图片') + ' eoiFromEnd=' + String(eoiFromEnd(all))
        // 只解头：头合法但结尾标记不在末尾 ⇒ 交付出去就是渲染失败的坏图
        if (hm !== null && eoiFromEnd(head) !== 0) headOkButTailBroken += 1
        if (am !== null && eoiFromEnd(all) === 0) allOk += 1
      }

      lines.push('#' + String(i) + ' HTTP ' + String(res.status)
        + ' ct=' + String(res.headers.get('content-type') ?? '')
        + ' x-enc=' + xEnc
        + ' bytes=' + String(raw.length) + (over ? ' ★超过128KB★' : '')
        + ' declaredSize=' + (c.declaredSize || '(无)')
        + ' seed=' + (c.seed === '' ? '★无★' : '有')
        + '\n      raw  ' + (rawMime ?? '密文') + ' head=' + hex4(raw)
        + '\n      只解头 ' + headDesc
        + '\n      整份解 ' + allDesc)
    }

    const verdict = [
      '=== 封面实测（' + String(covers.length) + ' 个）===',
      ...lines,
      '',
      '=== 汇总 ===',
      '  超过 128 KB 的:            ' + String(overLine) + ' / ' + String(covers.length),
      '  响应体已是图片（免解密）:   ' + String(plainNoDecrypt),
      '  响应体是密文（需解密）:     ' + String(needDecrypt),
      '  只解头后头合法但尾坏:       ' + String(headOkButTailBroken) + '   ← 这就是现网缺陷的触发数',
      '  整份解后头尾都完整:         ' + String(allOk),
      '',
      needDecrypt === 0
        ? '判定：封面响应体本来就是图片 ⇒ 无需解密，当前实现是对的。'
        : headOkButTailBroken === 0
          ? '判定：封面都小于 128 KB 或只解头就完整 ⇒ 当前实现**没有**触发缺陷，属于隐患。'
          : '判定：' + String(headOkButTailBroken) + ' 个封面只解头之后尾部是坏的 ⇒ **现网缺陷成立**，'
            + '需按大小分流（>128 KB 走整份解，小的仍走只解头以省 CPU）。',
      allOk > 0 && headOkButTailBroken > 0
        ? '注意：整份解能救回来 ⇒ 说明「只解头」是病因，尾块形态与朋友圈图片一致。'
        : '',
    ].join('\n')
    console.log('\n' + verdict + '\n')

    // 探针的价值是把数字摆出来，不预设结论；只断言「确实探到了样本」。
    expect(covers.length).toBeGreaterThan(0)
  }, 300000)
})
