// @vitest-environment node
/**
 * 本地分析新流程的接线守卫。
 *
 * 2026-10-25 重设计后，流程改为：
 *   打开分析 / 点击消息 → 只分析选中的一条 → 复用内存与磁盘缓存 → 可重试或强制重算。
 *
 * 这里守的是最容易「代码看着改了、行为却没变」的四条接线：
 *   ① 不再按可见窗口扫消息；
 *   ② 面板可见且目标有效才发请求；
 *   ③ 点击消息会打开分析并关闭可能占位的 AI 问答；
 *   ④ 重新分析会带 `force`，不是重新命中旧缓存。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readChatsSource } from '../../../test-helpers/chats-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]): string => readFileSync(join(HERE, ...parts), 'utf8')
const view = readChatsSource()
const head = read('chats-head-actions.tsx')
const hook = read('use-inline-analysis.ts')
const panel = read('ChatAnalysisPanel.tsx')
const api = read('..', 'api-read.ts')
const BACKEND = join(HERE, '..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src')
const remote = readFileSync(join(BACKEND, 'remotes', 'laya.ts'), 'utf8')
const gateway = readFileSync(join(BACKEND, 'gateway-laya-ops.ts'), 'utf8')
const analysis = readFileSync(join(BACKEND, 'laya', 'analysis.ts'), 'utf8')

describe('本地分析：选中即分析', () => {
  it('hook 只接收当前目标，不再依赖可见窗口或虚拟列表', () => {
    expect(hook).not.toContain('virtualizer')
    expect(hook).not.toContain('collectAnalyzeTargets')
    expect(hook).toContain('targets: [{ localId: targetId, sortSeq: targetSeq }]')
    expect(view, '传进 hook 的目标必须受分析面板可见性约束').toContain('if (!analysisPaneOpen || targetMessage === undefined) return null')
  })

  it('打开分析时自动选中最近一条对方文本/语音', () => {
    expect(view).toContain('latestAnalyzableMessage(msgItems)')
    expect(view).toContain('setAnalysisTarget({ talker: sessionTalker, localId: latest.localId })')
  })

  it('点击消息或头部入口都会关闭 AI 问答占位', () => {
    expect(view).toContain('setAiOpen(false)')
    expect(view).toContain('setAnalysisPaneOpen(true)')
    expect(view).toContain('openMessageAnalysis(item.m)')
    expect(head, '从头部打开分析时也要让出右栏，否则 AI 问答仍会占位').toContain('if (!analysisPaneOpen) setAiOpen(false)')
    expect(view).toContain('localId: message.localId')
    expect(view, '选中消息在消息流里要可见').toContain('data-analysis-target=')
  })

  it('失败可重试，结果可跳过缓存重算', () => {
    expect(panel).toContain('重试这条消息')
    expect(panel).toContain('重新分析')
    expect(panel).toContain('onRetry(targetId)')
    expect(panel).toContain('onRefresh(targetId)')
    expect(hook).toMatch(/force \? \{ force: true \}/)
    expect(api, '客户端 API 类型要透传 force').toContain('force?: boolean')
    expect(gateway, 'Gateway 入参要接受 force').toContain('force?: boolean')
    expect(remote, 'Remote 要把 force 原样传给分析层').toContain('options.force === true ? { force: true }')
    expect(analysis, 'force 必须跳过读缓存').toContain('const readCache = useCache && input.force !== true')
    expect(analysis, 'force 只跳过读，不跳过写回').toContain('if (useCache && toWrite.length > 0)')
    expect(hook, '失败后要消费 forced 标记，避免自动重试成环')
      .toMatch(/\.finally\(\(\) => \{[\s\S]*forced\.current\.delete\(targetId\)/)
  })

  it('旧的批次停止/进度 UI 不再挡在单条分析前面', () => {
    expect(panel).not.toContain('已停止（算出 ')
    expect(panel).not.toContain('progress.done')
    expect(panel).not.toContain('onCancel')
  })
})
