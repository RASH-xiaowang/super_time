/**
 * 「推荐回复」的接线守卫：入口只在单聊、面板挂在消息流右侧、读取范围只给当前会话。
 *
 * 2026-09-25 二次调整：推荐回复不再独占一栏 —— 它与「分析」共用 `ChatRightPanel`，
 * 但两者严格二选一。本文件里两条「挂载点」断言随之指向组合层，其余（只对单聊、
 * 必须有入口、读取范围、知识库下拉、复制走共享助手）语义未变。
 *
 * 起因：这是 2026-09-20 新增的单聊功能（头部按钮 → 第三栏面板 → 3 条候选回复）。
 * 它有三处「接线错了也不报错、但语义就变了」的地方，各钉一条：
 *   ① 按钮若给到群聊，「回一句」的语义不成立（群里的推荐回复是另一个产品问题）；
 *   ② 面板若不传 target，读取范围会退化成「没有范围」；
 *   ③ 后端若不再按 talker 取上下文，就会把别处的聊天端上来（用户报障过的那类）。
 * 源码锚点断言 + 先剥注释（本仓既有做法），断言的字符串均为单行，不受行尾影响。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { readChatsSource } from '../../../test-helpers/chats-source.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：本文件在 `src/client/ui-wechat/src/client/pages/wechat-data/panels/` 下，上溯 8 级。 */
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
// M21 拆了 Chats.tsx ⇒ 读联合（断言未改）
const chats = strip(readChatsSource())
const panel = readFileSync(join(HERE, 'ReplySuggest.tsx'), 'utf8')
const data = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'reply-suggest.ts'), 'utf8')
const remotes = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'remotes', 'summaryrec.ts'), 'utf8')

describe('推荐回复的接线', () => {
  it('入口是右栏「回复助手」（一个面板），候选段仍然只对单聊出现', () => {
    // 2026-11-18：分析与推荐回复合并成一个面板，入口也合成一条「回复助手」——
    // 因此不再有独立的「推荐回复」菜单项，候选段由组合层的 `allowSuggest` 控制。
    expect(chats.includes('推荐回复：按这段对话'), '头部按钮已随需求移除，不该再加回来').toBe(false)
    const at = chats.indexOf('<ChatRightPanel')
    expect(at, '找不到 ChatRightPanel 的挂载点 —— 改名后请同步本用例').toBeGreaterThan(-1)
    const around = chats.slice(Math.max(0, at - 420), at + 400)
    expect(around.includes('chatRightMode'), '右栏挂载必须由打开状态参与决定').toBe(true)
    // 群聊里「替你回一句」没有对象：候选段必须能被整段关掉。
    expect(around.includes("allowSuggest={curSession.type === 'private'}"),
      '推荐回复仍只对单聊出现（「回一句」在群里不成立）').toBe(true)
  })

  it('面板挂在消息流右侧（第三栏），且把当前会话传进去', () => {
    const at = chats.indexOf('<ChatRightPanel')
    expect(at, '找不到 ChatRightPanel 的挂载点 —— 改名后请同步本用例').toBeGreaterThan(-1)
    // 条件在标签**之前**（JSX 的 `{cond && (<Comp .../>)}`），所以两边都要看。
    const around = chats.slice(Math.max(0, at - 300), at + 400)
    expect(around.includes('target={curSession}'), '面板必须拿到当前会话（否则读取范围会退化成「没有范围」）').toBe(true)
    // 合并后只有一个开关：打开即渲染这一个面板（内部两段同时在场）。
    expect(chats.includes("const chatRightMode = analysisPaneOpen ? 'assistant' as const : undefined"),
      '右栏只有「打开 / 收起」两态，不该再有互斥的两个内容域').toBe(true)
  })

  it('数据层按 talker 取上下文（跨会话隔离靠它）', () => {
    // collectReplyContext 必须把 talker 交给 queryMessages（唯一的数据入口）
    const m = /export function collectReplyContext\(([\s\S]*?)\n\}/.exec(data)
    expect(m, '找不到 collectReplyContext —— 改名后请同步本用例').not.toBeNull()
    const body = m?.[1] ?? ''
    expect(body.includes('queryMessages('), '上下文必须来自 queryMessages（不要自己开库）').toBe(true)
    expect(/\bqueryMessages\([^)]*talker/.test(body), 'queryMessages 的第一个业务参数必须是 talker').toBe(true)
  })

  it('知识库走最近对话的混合检索，不只拿最后一句话做短语匹配', () => {
    expect(remotes).toContain('collectReplyKbSnippetsHybrid({')
    expect(remotes).toContain('lines,')
    expect(remotes).toContain('latestPeer,')
    expect(remotes).toContain("makeEmbedFn: (model, feature) => rc.makeEmbedFn(model, feature)")
    expect(data, '旧的同步 FTS-only 路径不应留在推荐回复数据层').not.toContain('searchKb(')
  })

  it('会话级推荐固定使用最近 60 条，并把唯一目标行交给提示词', () => {
    expect(data).toContain('export const REPLY_SUGGEST_CONTEXT_LIMIT = 60')
    expect(remotes).toContain('REPLY_SUGGEST_CONTEXT_LIMIT')
    expect(remotes).toContain('buildReplyPrompt(promptLines, promptSnippets, want, targetLine)')
    expect(remotes).toContain('REPLY_TOOL_RESULT_RESERVE')
    expect(remotes).toContain('promptLines.shift()')
    expect(data).toContain('const targetLine = targetText !== \'\' && targetSpeaker !== undefined')
  })

  it('点消息即切换分析对象，不再因为「推荐回复开着」而锁住消息区', () => {
    // 2026-11-18：两块合并进同一个面板后，上面的研判就是**针对选中那条消息**的，
    // 锁住点击等于让用户没法换对象。锁已移除（只保留批量海报模式自己的保护）。
    expect(chats).not.toContain('suggestionInteractionLocked')
    expect(chats).toContain(
      "onClick={!messagePoster.active && item.kind === 'msg'",
    )
    const analysis = readFileSync(join(HERE, 'chats-analysis.ts'), 'utf8')
    expect(analysis).not.toContain('suggestionInteractionLocked')
    // 点消息仍然要能打开面板并定位到该条。
    expect(analysis).toContain('setAnalysisPaneOpen(true)')
    expect(analysis).toContain('setAnalysisTarget({ talker: curSession.username, localId: message.localId })')
  })

  it('面板里有知识库下拉：默认跟随全局、可改、且有「不用知识库」', () => {
    // 为什么钉这条：库的切换器在知识库面板那边，聊天页里够不着 —— 面板自己不提供下拉，
    // 用户就只能吃默认那个库（2026-09-20 用户实测反馈「没有选择知识库的下拉框」）。
    expect(panel.includes('<Select'), '推荐回复面板必须有知识库下拉').toBe(true)
    expect(panel.includes('不用知识库'), '下拉要能明确「不用知识库」，而不是只能从库里挑').toBe(true)
    expect(/kbOverride \?\? scopeKbId/.test(panel), '未显式选择时应跟随应用当前选中的库').toBe(true)
  })

  it('面板说明「只读、不代发」——本应用没有发送路径', () => {
    expect(panel.includes('不会替你发消息'), '面板应写明只读、需手动粘贴（避免用户以为它能直接发）').toBe(true)
  })

  it('复制走共享剪贴板助手，且拿到真实结果之前不改口径', () => {
    // 原先写的是 `void navigator.clipboard.writeText(text)` 紧跟 `setCopied(index)`：
    // `writeText` 是 Promise，被拒时界面照样显示「已复制」—— 把「我试过了」演成「成功了」，
    // 还顺手在渲染进程里留一条没人接的 rejection。共享助手 `copyTextToClipboard`
    // 已经把异步 API 与 execCommand 兜底两条路径的失败都收敛成布尔值，所以这里只判布尔。
    expect(panel.includes('copyTextToClipboard('), '复制必须走 utils/misc.ts 的共享助手').toBe(true)
    expect(/if \(ok\) setCopied\(/.test(panel), '「已复制」只能在助手真的返回 true 之后出现').toBe(true)
    expect(/void navigator\.clipboard/.test(strip(panel)), '不许再 fire-and-forget 直接写剪贴板').toBe(false)
  })

  it('复制失败要说出来，不能静默', () => {
    // 剪贴板被系统/焦点拦下是常态（窗口失焦时 Chrome 就拒），静默等于让用户以为已经复制走了。
    expect(panel.includes('setCopyFailed(true)'), '助手返回 false 时必须落到状态里').toBe(true)
    expect(panel.includes('复制失败'), '要有给用户看的失败文案（含「手动选中复制」这条退路）').toBe(true)
  })
})
