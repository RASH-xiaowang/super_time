/**
 * `snsCdnUrl` 的行为守卫：把"实测能通的那条请求形态"钉死。
 *
 * 依据（2026-10-08 真机实测，见模块注释的表）：
 *   · 必须 https（库里是 http）
 *   · 尺寸段必须归一成 `/0`（`/150` 实测 400）
 *   · 必须追加 `token=<token>&idx=1`（只有 token 也是 400）
 */
import { describe, expect, it } from 'vitest'
import { snsCdnUrl } from '../src/query/sns-cdn-url.ts'

const URL0 = 'http://mmsns.qpic.cn/mmsns/O8n3oVqPCRqxo9xeicGSdFT1ruIuemvKZiciaYvbD67SEsSW7ylEaFBCNMvN7Ua6icSO/0'
const TOK = 'r3MUdKBTQtokBVGyMoJg7qz1zGmgBLI6'

describe('snsCdnUrl：朋友圈 CDN 请求构造', () => {
  it('http → https，并追加 token + idx=1（实测 200 的那一形态）', () => {
    expect(snsCdnUrl(URL0, TOK)).toBe(
      'https://mmsns.qpic.cn/mmsns/O8n3oVqPCRqxo9xeicGSdFT1ruIuemvKZiciaYvbD67SEsSW7ylEaFBCNMvN7Ua6icSO/0?token=' + TOK + '&idx=1')
  })

  it('尺寸段归一到 /0（/150 那种 CDN 会拒）', () => {
    expect(snsCdnUrl(URL0.replace('/0', '/150'), TOK)).toContain('/0?token=')
    expect(snsCdnUrl(URL0.replace('/0', '/480'), TOK)).toContain('/0?token=')
  })

  it('清掉库里可能已有的 token/idx，不叠加（否则参数重复会 400）', () => {
    const withOld = URL0 + '?token=OLD&idx=9&foo=1'
    const out = snsCdnUrl(withOld, TOK)
    expect(out).toContain('foo=1')
    expect(out).toContain('token=' + TOK)
    expect(out).not.toContain('token=OLD')
    expect(out).not.toContain('idx=9')
    expect((out.match(/idx=1/g) ?? []).length).toBe(1)
  })

  it('没有 token 时只做 https + /0（不为空 token 造参数）', () => {
    expect(snsCdnUrl(URL0, undefined)).toBe('https://mmsns.qpic.cn/mmsns/O8n3oVqPCRqxo9xeicGSdFT1ruIuemvKZiciaYvbD67SEsSW7ylEaFBCNMvN7Ua6icSO/0')
  })

  it('非腾讯系主机原样返回（不硬改别人的地址）', () => {
    const other = 'http://example.com/a/150'
    expect(snsCdnUrl(other, TOK)).toBe(other)
    expect(snsCdnUrl('', TOK)).toBe('')
  })
})
