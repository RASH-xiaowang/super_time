/**
 * ClawBot 出网边界守卫（iLink 通道接入后的版本，2026-10-12；媒体取数同日）。
 *
 * 本文件此前守的是「零出网」；通道接入那天按预先写好的清单改判据（见 git 历史）。
 * 现在有**两个**出网接缝、各自一条纪律：
 *   · `clawbot-ilink.ts` —— API 面：取码/轮询/长轮询只带控制面，唯一点是 `requestJson`；
 *   · `clawbot-media.ts` —— CDN 字节面：只在你点开某条消息时按需下载，唯一点是 `downloadBytes`。
 * 判据：① 每个接缝里 `fetch(` 恰好一处；② 接缝之外零出网调用、零 https 字面量；
 * ③ 每个接缝内只有一个硬编码 https 目的地（新增目的地要过台账 + PRIVACY 两道门）；
 * ④ 接收侧请求不含本地数据、发送侧只带你写的那条正文（假 fetch 逐一实测）。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ILINK_BASE_URL,
  getUpdates,
  pollBindStatus,
  requestBindQr,
  sendTextMessage,
  type FetchLike,
} from '../src/query/clawbot/clawbot-ilink.ts'
import { CLAWBOT_CDN_BASE } from '../src/query/clawbot/clawbot-media.ts'
import { GW_DIR } from '../../tests/gateway-source.ts'

/** 剥注释：注释里讲协议时会提到 URL / fetch，不能当代码判。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 出网接缝文件（唯二可以 fetch 的 ClawBot 文件）。 */
const SEAMS = [
  { file: join(GW_DIR, 'query', 'clawbot', 'clawbot-ilink.ts'), host: 'https://ilinkai.weixin.qq.com', fn: 'requestJson' },
  { file: join(GW_DIR, 'query', 'clawbot', 'clawbot-media.ts'), host: 'https://novac2c.cdn.weixin.qq.com/c2c', fn: 'downloadBytes' },
] as const

function clawbotProductFiles(): string[] {
  const queryDir = join(GW_DIR, 'query', 'clawbot')
  const query = readdirSync(queryDir)
    .filter((f) => f.startsWith('clawbot-') && f.endsWith('.ts'))
    .map((f) => join(queryDir, f))
  return [join(GW_DIR, 'gateway-clawbot.ts'), join(GW_DIR, 'remotes', 'clawbot.ts'), ...query]
}

describe('ClawBot 出网边界（两个接缝，各自单点）', () => {
  it('每个接缝文件里 `fetch(` 恰好一处，且落在登记的那个函数里（台账主键按「文件#函数」）', () => {
    for (const seam of SEAMS) {
      const body = stripComments(readFileSync(seam.file, 'utf8'))
      const hits = body.match(/\bfetch\s*\(/g) ?? []
      expect(hits.length, `${seam.file} 里的 fetch 调用点不再是 1 个 —— 多一个点就漏登记`).toBe(1)
      expect(body, `${seam.file} 里找不到 ${seam.fn}（截断被搬走或改名 ⇒ 台账主键失效）`).toContain(`async function ${seam.fn}(`)
    }
  })

  it('除接缝文件外，全部 ClawBot 产品代码零出网（fetch / 网络内建模块都不许有）', () => {
    const files = clawbotProductFiles()
    expect(files.length, '一条 ClawBot 产品文件都没扫到 ⇒ 扫描口径坏了').toBeGreaterThanOrEqual(7)
    const seamPaths = SEAMS.map((s) => s.file)
    for (const f of files) {
      if (seamPaths.includes(f as (typeof seamPaths)[number])) continue
      const body = stripComments(readFileSync(f, 'utf8'))
      expect(/\bfetch\s*\(|fetchWithRetry\s*\(|https?\.request\s*\(/.test(body), `${f} 里出现了出网调用 —— 只许经两个接缝`).toBe(false)
      expect(/from\s+['"]node:(?:https?|net|dns)['"]/.test(body), `${f} import 了网络内建模块 —— 只许经两个接缝`).toBe(false)
    }
  })

  it('主机写死：每个接缝内只有一个 https 目的地；接缝之外一个 https 字面量都没有', () => {
    // 接缝各自恰好一个 https 字面量（就是它的常量本身）。
    expect(ILINK_BASE_URL).toBe('https://ilinkai.weixin.qq.com')
    expect(CLAWBOT_CDN_BASE).toBe('https://novac2c.cdn.weixin.qq.com/c2c')
    for (const seam of SEAMS) {
      const body = stripComments(readFileSync(seam.file, 'utf8'))
      const hosts = [...new Set(body.match(/https:\/\/[^\s'"`)]+/g) ?? [])]
      expect(hosts, `${seam.file} 里出现了第二个 https 目的地 —— 登记三处（本文件/台账/PRIVACY）才许加`).toEqual([seam.host])
    }
    // 其余 clawbot 文件一个 https 字面量都不许有。
    const seamPaths = SEAMS.map((s) => s.file)
    for (const f of clawbotProductFiles()) {
      if (seamPaths.includes(f as (typeof seamPaths)[number])) continue
      const body = stripComments(readFileSync(f, 'utf8'))
      expect(body.includes('https://'), `${f} 里出现 https 地址（要不要登记到 PRIVACY.md 第四节？）`).toBe(false)
    }
  })

  it('接收侧零内容、发送侧只有你写的那条正文（四种请求的 body 逐一实测）', async () => {
    interface Call { url: string, method: string, body: string | undefined, headers: Record<string, string> }
    const calls: Call[] = []
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body, headers: init?.headers ?? {} })
      return { ok: true, status: 200, text: async () => '{"qrcode":"t","qrcode_img_content":"https://liteapp.weixin.qq.com/q/x","ret":0,"status":"wait","errmsg":""}' }
    }
    const opts = { fetchImpl: fake }
    const creds = { botToken: 'bt', ilinkBotId: 'bot', ilinkUserId: 'u', baseUrl: '' }
    await requestBindQr(opts)
    await pollBindStatus('tok', opts)
    await getUpdates(creds, 'cursor-1', opts)
    await sendTextMessage(creds, { toUserId: 'user-1', text: '用户写的正文', contextToken: 'ctx-1', clientId: 'cid-1' }, opts)

    expect(calls).toHaveLength(4)
    for (const c of calls) {
      expect(c.url.startsWith('https://ilinkai.weixin.qq.com/'), `请求打到了登记外的主机：${c.url}`).toBe(true)
    }
    // 接收侧三条：GET/无 body，或 body 只有游标与渠道版本号。
    expect(calls[0]?.body).toBeUndefined()
    expect(calls[1]?.body).toBeUndefined()
    const pollBody = JSON.parse(calls[2]?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(pollBody).sort()).toEqual(['base_info', 'get_updates_buf'])
    expect(Object.keys(pollBody['base_info'] as Record<string, unknown>)).toEqual(['channel_version'])
    for (const c of calls.slice(0, 3)) {
      expect(c.body ?? '', '接收侧请求不许出现正文').not.toContain('用户写的正文')
    }
    // 发送侧：恰好 路由字段 + 一条正文条目；没有别的本地数据。
    const sendBody = JSON.parse(calls[3]?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(sendBody).sort()).toEqual(['base_info', 'msg'])
    const msg = sendBody['msg'] as Record<string, unknown>
    expect(Object.keys(msg).sort()).toEqual(['client_id', 'context_token', 'from_user_id', 'item_list', 'message_state', 'message_type', 'to_user_id'])
    expect(msg['item_list']).toEqual([{ type: 1, text_item: { text: '用户写的正文' } }])
    expect(msg['base_info'] ?? sendBody['base_info']).toEqual({})
    // 认证头只有凭证与会话标识；不该出现任何本机字段（如用户名、路径）。
    const headers = calls[2]?.headers ?? {}
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'AuthorizationType', 'Content-Type', 'X-WECHAT-UIN'])
    expect(JSON.stringify(calls.slice(0, 3))).not.toContain('decrypted')
  })
})
