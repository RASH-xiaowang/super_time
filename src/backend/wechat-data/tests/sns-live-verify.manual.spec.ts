/**
 * **现场验证**（默认跳过；`SNS_LIVE=1` 才跑）：用真库的真实媒体、真 CDN、真 WxIsaac64 WASM
 * 走完整条链，把解出的图落盘到 `working/live-sns-*.jpg`，供人眼确认。
 *
 * 这条用例存在的意义：单元判据只能证明"代码形状对"，证明不了"这张图真的能显示"。
 * 之前所有失败都发生在这一步，而它在应用里不可观测。
 *
 * 2026-10-08 首次运行的结论（写在 `remotes/media.ts` 的注释里）：9/9 图片取回 HTTP 200、
 * **头 128 KB 解密正确（JPEG 魔数对上）但尾部仍是密文** ⇒ 我们这份 WASM 构建无法一次生成
 * 全量密钥流，故取图顺序改为「本机优先、CDN 兜底」。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { snsCdnUrl } from '../src/query/sns-cdn-url.ts'
import { decryptSnsAll } from '../src/query/sns-keystream.ts'

const DB = 'C:/Users/Administrator/AppData/Roaming/super-time-electron/wechat-data/decrypted/sns/sns.db'
const OUT = 'D:/super-time-wechat/working'
const LIVE = process.env['SNS_LIVE'] === '1'

interface Pick {
  url: string
  token: string
  encKey: string
  urlKey: string
  md5: string
}

const text = (v: unknown): string => typeof v === 'string' ? v
  : (v instanceof Uint8Array ? new TextDecoder('utf-8').decode(v) : String(v ?? ''))

const group1 = (re: RegExp, s: string): string => re.exec(s)?.[1] ?? ''

function pickMedia(): Pick[] {
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
        encKey: group1(/<enc\b[^>]*key="([^"]+)"/, b),
        urlKey: group1(/key="([^"]+)"/, attrs),
        md5: group1(/md5="([^"]+)"/, attrs),
      })
    }
    break
  }
  db.close()
  return out
}

describe.skipIf(!LIVE)('live: 朋友圈 CDN 取图 + 整份解密（真库/真网/真 WASM）', () => {
  it('取回并解出完整图片（头部 + 结尾都要对）', async () => {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
    const media = pickMedia()
    expect(media.length, '样本里没有多图动态').toBeGreaterThan(0)
    const lines: string[] = []
    let ok = 0
    for (const [i, m] of media.entries()) {
      const seed = m.encKey !== '' ? m.encKey : m.urlKey
      const res = await fetch(snsCdnUrl(m.url, m.token))
      const raw = Buffer.from(await res.arrayBuffer())
      const dec = (await decryptSnsAll(raw, seed)).bytes
      const isJpeg = dec[0] === 0xff && dec[1] === 0xd8
      const tailOk = isJpeg && dec.length > 3 && dec[dec.length - 2] === 0xff && dec[dec.length - 1] === 0xd9
      const head = [...dec.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
      lines.push('#' + String(i) + ' HTTP ' + String(res.status) + ' raw=' + String(raw.length) +
        ' dec=' + String(dec.length) + ' seed=' + (m.encKey !== '' ? 'enc' : 'urlKey') +
        ' jpeg=' + String(isJpeg) + ' tail=' + String(tailOk) + ' head=' + head)
      if (isJpeg && tailOk) { writeFileSync(OUT + '/live-sns-' + String(i) + '.jpg', dec); ok += 1 }
    }
    console.log('\n=== 现场结果 ===\n' + lines.join('\n') + '\n完整成图: ' + String(ok) + '/' + String(media.length))
    expect(ok, '没有任何一张解成完整图片（见上面的逐张明细）').toBeGreaterThan(0)
  }, 120000)
})
