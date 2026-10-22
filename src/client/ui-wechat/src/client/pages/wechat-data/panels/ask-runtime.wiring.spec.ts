/**
 * 统一问答运行信息的接线守卫。
 *
 * 语义测试只能证明组件本身可用；把两个线程里的 `<AskRuntimeMeta>` 摘掉，
 * 组件测试仍然会全绿。这里按仓库既有的源码级守卫做法，钉住三件事：
 *   ① 微信问答与会话内问答都在过程时间线后渲染运行信息，资源区在正文之后；
 *   ② 请求只在紧邻同范围轮次之间继承 threadState；
 *   ③ 助手轮次确实映射了运行时新增字段。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')

describe('统一问答运行信息接线', () => {
  it('实时工具卡由独立合并模块驱动，后端结构字段全部接通', () => {
    const process = read('AskProcess.tsx')
    const merge = read('ask-stage-merge.ts')
    const gatewayTypes = readFileSync(
      join(HERE, '..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'types-config.ts'),
      'utf8',
    ).replace(/\\/g, '/')
    expect(process).toContain("from './ask-stage-merge.ts'")
    expect(process).toContain('appendAskStage')
    expect(process).toContain('ToolStageCard')
    expect(merge).toContain('export function mergeAskStage')
    expect(merge).toContain('export function appendAskStage')
    expect(merge).toContain('export interface AskStage')
    for (const field of [
      'phase', 'callId', 'toolName', 'argumentsSummary', 'attempt', 'maxAttempts',
      'elapsedMs', 'errorClass', 'deadlineExceeded', 'hits', 'facts',
    ]) {
      expect(gatewayTypes, `网关事件缺少 ${field}`).toContain(`${field}?:`)
    }
    expect(gatewayTypes).toContain("'running' | 'done' | 'failed' | 'skipped'")
  })

  it('微信问答和会话内问答都在过程时间线后渲染运行信息，资源在正文之后', () => {
    for (const file of ['Ask.tsx', 'SessionAsk.tsx']) {
      const code = read(file)
      expect(code, `${file} 必须导入 AskRuntimeMeta 与 AskResources`).toContain("from './AskRuntimeMeta.tsx'")
      expect(code, `${file} 必须在 AskProcess 后渲染状态/工具/证据`).toMatch(
        /<AskProcess[^>]*\/>\s*<AskRuntimeMeta[\s\S]*?turn=\{t\}[\s\S]*?placement="meta"/,
      )
      const answerAt = code.indexOf('<AnswerBody')
      const resourcesAt = code.indexOf('<AskResources turn={t} />')
      expect(answerAt, `${file} 必须渲染回答正文`).toBeGreaterThan(-1)
      expect(resourcesAt, `${file} 必须在正文之后渲染资源区`).toBeGreaterThan(answerAt)
    }
  })

  it('请求只从紧邻且同范围的助手轮次取 threadState，并随请求回传', () => {
    const code = read('use-ask.ts')
    expect(code).toContain('prevTurns[prevTurns.length - 1]')
    expect(code).toContain('previous.scopeSignature === signature')
    expect(code).toContain('previous.stopped === true')
    expect(code).toContain('previous.status === \'failed\'')
    expect(code).toContain('previousFailed')
    expect(code).not.toContain('.reverse()')
    expect(code).not.toContain('.find(t => t.role === \'assistant\' && t.threadState !== undefined)')
    expect(code).toContain('...(threadState !== undefined ? { threadState } : {})')
  })

  it('助手结果映射全部运行时字段，旧后端缺字段时不补默认值', () => {
    const code = read('use-ask.ts')
    for (const field of ['status', 'statusReason', 'synthesisError', 'toolCalls', 'evidence', 'resources', 'threadState', 'grounding']) {
      expect(code, `缺少 ${field} 映射`).toContain(`runtime.${field} !== undefined ? { ${field}: runtime.${field} }`)
    }
  })

  it('交互目标保留键盘焦点、触控下限与减少动效支持', () => {
    const styles = read('ask-runtime.module.css')
    expect(styles).toMatch(/\.sectionHead\s*\{[\s\S]*?min-height:\s*32px/)
    expect(styles).toMatch(/\.moreBtn\s*\{[\s\S]*?min-height:\s*32px/)
    expect(styles).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height:\s*44px/)
    expect(styles).toContain('.sectionHead:focus-visible')
    expect(styles).toContain('.moreBtn:focus-visible')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('会话内问答抽屉使用响应式宽度，全屏仍四边铺满', () => {
    const styles = read('session-ask.module.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const panel = /\.panel\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ''
    const full = /\.panel\[data-full\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ''

    expect(panel, '找不到会话内问答抽屉的基础宽度').toMatch(/width:\s*clamp\(440px,\s*46vw,\s*640px\)/)
    expect(panel, '窄屏必须由 max-width 约束，不能横向溢出').toContain('max-width: 100%')
    expect(styles, '基础宽度不能再写死为旧值').not.toMatch(/\.panel\s*\{[^}]*width:\s*400px/)

    expect(full, '全屏宽度必须回到 auto').toContain('width: auto')
    expect(full, '全屏必须贴住左侧').toMatch(/left:\s*0/)
    expect(full, '全屏必须贴住右侧').toMatch(/right:\s*0/)
    expect(full, '全屏必须解除窄屏最大宽度限制').toContain('max-width: none')
    expect(read('SessionAsk.tsx'), '全屏属性必须仍然接到面板节点').toContain('data-full={full || undefined}')
  })

})
