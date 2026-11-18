/**
 * 统一问答运行信息的接线守卫。
 *
 * 语义测试只能证明组件本身可用；把两个线程里的 `<AnswerRunView>` 摘掉，
 * 组件测试仍然会全绿。这里按仓库既有的源码级守卫做法，钉住三件事：
 *   ① 两个入口共用运行视图，主回答在过程详情前，资源区在运行视图后；
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

  it('微信问答和会话内问答共用运行视图，过程在上、正式回答在下、资源在正文之后', () => {
    for (const file of ['Ask.tsx', 'SessionAsk.tsx']) {
      const code = read(file)
      expect(code, `${file} 必须导入共享运行视图`).toContain("from './AnswerRunView.tsx'")
      expect(code, `${file} 必须用 AnswerRunView 渲染已完成轮次`).toContain('<AnswerRunView')
      expect(code, `${file} 必须在运行中复用同一运行视图`).toMatch(/<AnswerRunView[\s\S]*?streaming/)
      const runAt = code.indexOf('<AnswerRunView')
      const resourcesAt = code.indexOf('<AskResources turn={t} />')
      expect(runAt, `${file} 必须渲染统一运行视图`).toBeGreaterThan(-1)
      expect(resourcesAt, `${file} 必须在正文之后渲染资源区`).toBeGreaterThan(runAt)
    }
    const runView = read('AnswerRunView.tsx')
    expect(runView.indexOf('<AnswerBody')).toBeGreaterThan(-1)
    expect(runView.indexOf('<ProcessInspector')).toBeLessThan(runView.indexOf('<AnswerBody'))
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

  it('桌面保持紧凑，粗指针设备保留触控下限，并支持键盘焦点与减少动效', () => {
    const styles = read('answer-run.module.css')
    expect(styles).toMatch(/\.processHead\s*\{[\s\S]*?min-height:\s*28px/)
    expect(styles).toMatch(/\.statusAction\s*\{[\s\S]*?min-height:\s*22px/)
    expect(styles).toMatch(/\.moreButton,[\s\S]*?\.retryBtn\s*\{[\s\S]*?min-height:\s*28px/)
    const coarse = /@media \(pointer: coarse\) \{[\s\S]*?\n\}/.exec(styles)?.[0] ?? ''
    expect(coarse, '粗指针设备没有恢复 44px 触控下限').toContain('min-height: 44px')
    expect(coarse, '触控停止按钮没有恢复 44px 最小宽度').toContain('min-width: 44px')
    expect(styles).toContain('.processHead:focus-visible')
    expect(styles).toContain('.moreButton:focus-visible')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('会话内问答右栏参与布局宽度分配，全屏吃满消息流让出的空间', () => {
    const styles = read('session-ask.module.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const panel = /\.panel\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ''
    const full = /\.panel\[data-full\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ''

    expect(panel, '右栏必须作为普通 flex 子项参与排版').toContain('position: relative')
    expect(panel, '右栏宽度必须跟随视口收敛到 320–420px').toMatch(/width:\s*clamp\(320px,\s*34vw,\s*420px\)/)
    expect(panel, '右栏必须声明对应的 flex basis，不能收缩成 overlay').toMatch(/flex:\s*0 0 clamp\(320px,\s*34vw,\s*420px\)/)
    expect(panel, '右栏必须允许内部内容先收窄，不能把消息列顶出容器').toContain('min-width: 0')
    expect(panel, '右栏必须是尺寸查询容器（窄栏内部卡片按自身宽度降列）').toContain('container-type: inline-size')
    expect(panel, '右栏不能绝对定位覆盖聊天记录').not.toContain('position: absolute')

    expect(full, '全屏必须吃满消息流让出的剩余宽度').toContain('flex: 1 1 auto')
    expect(full, '全屏宽度必须回到 auto').toContain('width: auto')
    expect(full, '全屏必须解除窄屏最大宽度限制').toContain('max-width: none')
    expect(read('SessionAsk.tsx'), '全屏属性必须仍然接到面板节点').toContain('data-full={full || undefined}')
    expect(read('SessionAsk.tsx'), '会话 AI 面板必须带统一右栏标记').toContain('data-side-panel-view=""')
  })

  it('输入区与「微信问答」同构：发送键在输入框同一行右下角，出处说明收进底部行', () => {
    const tsx = read('SessionAsk.tsx')
    const styles = read('session-ask.module.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const inputRow = /\.inputRow\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ''
    const input = /\.input\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ''

    // 结构：textarea 与发送/停止键包在同一个 `.inputRow` 里（此前发送键掉到下一行）。
    expect(tsx, '输入框与发送键没有包进同一行容器').toMatch(/className=\{css\.inputRow\}[\s\S]{0,900}?className=\{css\.(send|stopSend)\}/)
    expect(inputRow, '输入行必须底部对齐').toContain('align-items: flex-end')
    expect(input, '输入框必须按 flex 占满剩余宽度').toMatch(/flex:\s*1 1 auto/)
    expect(input, '输入框必须允许收窄，否则发送键会被顶出容器').toContain('min-width: 0')

    // 出处说明不再单独占一行（`.note` 已删），收进 `.composerFoot` 右端。
    expect(styles, '还留着独立的 .note 行规则').not.toContain('.note {')
    expect(tsx, '出处说明没有收进底部行').toMatch(/css\.composerFoot[\s\S]{0,700}?css\.footHint/)
    expect(styles, '出处说明缺少窄栏隐藏规则').toContain('@container (max-width: 400px)')
  })

})
