/**
 * 消息记录详情「回复过程」的接线守卫。
 *
 * 留痕好不好用取决于三根线是否都接上：详情抽屉只对 AI 回复记录挂载、
 * 组件真的去读留痕、薄 Remote 层真的调用了后端方法。任一处漏接，
 * 界面只会安静地少一整块内容，所以在这里一起钉住。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('消息记录详情：回复过程留痕', () => {
  it('只有 AI 回复记录才挂载留痕区块', () => {
    const drawer = read('message-list-detail-drawer.tsx')
    expect(drawer).toContain("import { MessageListTraceSection } from './message-list-detail-trace.tsx'")
    expect(drawer).toContain("{record.source === 'ai_reply' && <MessageListTraceSection recordId={record.id} />}")
  })

  it('组件按 recordId 读一次留痕，记录切换时重新读取', () => {
    const trace = read('message-list-detail-trace.tsx')
    expect(trace).toContain('apiGetChatAiReplyTrace(props.recordId)')
    expect(trace).toMatch(/useEffect\([\s\S]*?\[props\.recordId\]/)
    // 旧记录没有留痕时要如实说明，而不是留空或抛错（兜底文案在薄 Remote 层）。
    expect(read('../api-chat-ai-reply.ts')).toContain('这条记录没有过程留痕')
    expect(trace).toContain('state.error')
  })

  it('展示上下文、知识库、系统提示词、提问提示词与模型输出', () => {
    const trace = read('message-list-detail-trace.tsx')
    for (const title of ['上下文（发给模型的历史对话）', '知识库命中', '系统提示词', '本轮提问提示词', '模型输出']) {
      expect(trace, `缺少留痕区块：${title}`).toContain(title)
    }
    // 长文本必须可折叠且限高，不能把抽屉其它字段挤没。
    expect(trace).toContain('<details')
    expect(read('message-list-detail.module.css')).toMatch(/\.tracePre\s*\{[^}]*max-height:/)
  })

  it('薄 Remote 层调用后端 getChatAiReplyTrace，不直连 remote()', () => {
    expect(read('../api-chat-ai-reply.ts')).toContain('remote().getChatAiReplyTrace({ recordId })')
    expect(read('message-list-detail-trace.tsx')).not.toContain('remote()')
  })
})
