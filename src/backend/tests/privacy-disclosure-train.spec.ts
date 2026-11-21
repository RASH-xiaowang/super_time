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
const desk = read('src/client/ui-wechat/src/client/pages/wechat-data/panels/AgentDesk.tsx')
const outbound = gate.slice(gate.indexOf('const OUTBOUND:'), gate.indexOf('const INBOUND:'))
const section = (label: string): string => {
  const start = outbound.indexOf(`label: '${label}'`)
  expect(start, `Missing outbound entry: ${label}`).toBeGreaterThanOrEqual(0)
  const next = outbound.indexOf('\n  {', start)
  return outbound.slice(start, next < 0 ? undefined : next)
}

describe('privacy consent / trust / runtime disclosure train', () => {
  it('registers twelve outbound surfaces without counting inbound listeners', () => {
    expect(outbound.match(/label: '/g)).toHaveLength(12)
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

  it('memory scope and model-bound privacy seam agree with the screen', () => {
    const memory = section('AI 队友记忆与提案')
    for (const text of ['用户级记忆', '当前会话', '不可信背景', 'ai_reply_analyze', '900 字', '已发出的内容不能撤回']) expect(memory).toContain(text)
    const runtime = read('src/backend/wechat-data/src/query/ai-reply/runner-generate.ts')
    const memoryStart = runtime.indexOf('const memory = memoryPromptBlock(')
    expect(memoryStart).toBeGreaterThan(0)
    const seam = runtime.slice(memoryStart)
    expect(seam).toMatch(/memory,[\s\S]*deps.gate\(\s*'ai_reply_analyze'/)
    expect(seam).toMatch(/\[systemPrompt, prompt\]/)
    expect(trust).toContain("ai_reply_analyze: 'AI回复（含队友记忆）'")
    expect(doc).toContain('| v41 |')
  })

  it('mark accepted remains separate from explicit Webhook send', () => {
    expect(desk).not.toContain('采纳只记录你的反馈，不会把文字发进微信')
    const mark = desk.split('\n').find(line => line.includes("apiSetAgentProposalStatus(item.id, 'accepted')")) ?? ''
    expect(mark).toContain('只标记采纳')
    expect(mark).not.toContain('apiSendAgentProposal')
    expect(desk).toContain('apiSendAgentProposal(item.id, sendTarget)')
    expect(section('AI 队友记忆与提案')).toContain('「只标记采纳」仅记状态')
    expect(doc).not.toContain('页面上的「采纳 / 忽略」只改本机状态，不调用大肥鱼，不发微信')
  })

  it('storage inventory includes every persisted agent table', () => {
    const store = read('src/backend/wechat-data/src/query/agent/store.ts')
    const tables = [...store.matchAll(/CREATE TABLE IF NOT EXISTS (agent_\w+)/g)].map(match => match[1])
    expect(tables.length).toBeGreaterThanOrEqual(10)
    const storage = doc.slice(doc.indexOf('## 三、'), doc.indexOf('## 四、'))
    for (const table of tables) expect(storage).toContain('`' + table + '`')
    expect(trust).not.toContain('头像图片是唯一例外')
    expect(trust).not.toContain('只有检索到的聊天片段会发送')
  })

  it('version 41 requires both material runtime slices, not declarations alone', () => {
    const version = /PRIVACY_VERSION\s*=\s*(\d+)/.exec(read('src/client/ui-app/privacy/consent.ts'))?.[1]
    expect(version).toBe('41')
    expect(doc).toContain('生效版本：**v41**')
    const remotes = read('src/backend/wechat-data/src/gateway-chat-ai-reply.ts')
    for (const name of ['getAgentDesk', 'saveAgentControl', 'writeAgentMemory', 'deleteAgentMemory', 'addAgentPromise', 'setAgentProposalStatus', 'sendAgentDraft', 'sendAgentProposal']) {
      expect(remotes).toContain("@Remote('" + name + "')")
      expect(read('src/backend/wechat-data/src/remote-arg-schema-overlay.ts')).toContain("remote('" + name + "'")
      expect(read('src/backend/http-remote-policy.js')).toContain("'" + name + "'")
    }
    expect(read('src/backend/wechat-data/src/remotes/summary.ts')).toContain('pushSummaryToWebhook')
    expect(read('src/backend/wechat-data/src/query/ai-reply/runner-generate.ts')).toContain('memoryPromptBlock')
  })
})