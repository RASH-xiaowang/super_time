/** Privacy disclosures are a train with their runtime, never a standalone version bump.
 * Source-only regression: no live model, Webhook, user config or user database is opened.
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')
const gate = read('src/client/ui-app/privacy/PrivacyConsentGate.tsx')
const doc = read('docs/PRIVACY.md')
const trust = read('src/client/ui-wechat/src/client/pages/wechat-data/panels/PrivacyTrust.tsx')
const outbound = gate.slice(gate.indexOf('const OUTBOUND:'), gate.indexOf('const INBOUND:'))
const section = (label: string): string => {
  const start = outbound.indexOf(`label: '${label}'`)
  expect(start, `Missing outbound entry: ${label}`).toBeGreaterThanOrEqual(0)
  const next = outbound.indexOf('\n  {', start)
  return outbound.slice(start, next < 0 ? undefined : next)
}

describe('privacy consent / trust / runtime disclosure train', () => {
  it('registers eleven outbound surfaces without counting inbound listeners', () => {
    expect(outbound.match(/label: '/g)).toHaveLength(11)
    expect(gate).toContain('共 {OUTBOUND.length} 个出网点')
    expect(outbound).not.toContain("label: '消息列表局域网 Webhook'")
    expect(gate).toContain('INBOUND.map')
  })

  it('v39 message analysis is visible on consent and in audit labels', () => {
    const analysis = section('消息分析')
    for (const text of ['analyze_message', '20 条', '当前对话模型', '本机转写']) expect(analysis).toContain(text)
    expect(trust).toContain("analyze_message: '消息分析'")
    expect(doc).toContain('`analyze_message`')
  })

  it('summary push states destination, payload, activation and token redaction', () => {
    const push = section('定时总结 Webhook 推送')
    for (const text of ['已启用任务到点', '保存了推送地址', '立即运行', '总结生成成功', 'target', 'message', '/webhook/<token>', '/webhook/***', '没有全局出网开关']) expect(push).toContain(text)
    expect(push).toContain("kind: 'none'")
    expect(doc).toContain('| v40 |')
    const runtime = read('src/backend/wechat-data/src/remotes/summary.ts')
    expect(runtime).toMatch(/done && summary !== '' && task.webhookUrl.trim\(\) !== ''/)
    expect(runtime).toContain('message: summary')
    expect(read('src/backend/wechat-data/src/query/summary-webhook.ts')).toContain('JSON.stringify({ target, message })')
  })

  it('version 40 ships with summary runtime and task UI', () => {
    expect(read('src/client/ui-app/privacy/consent.ts')).toMatch(/PRIVACY_VERSION\s*=\s*40/)
    expect(doc).toContain('生效版本：**v40**')
    expect(doc).not.toContain('v41')
    expect(outbound).not.toContain('AI 队友记忆与提案')
    expect(read('src/backend/wechat-data/src/remotes/summary.ts')).toContain('pushSummaryToWebhook')
    expect(read('src/client/ui-wechat/src/client/pages/wechat-data/panels/SummaryTaskDrawer.tsx')).toContain('webhookOn')
    expect(trust).toContain('Webhook')
  })
})
