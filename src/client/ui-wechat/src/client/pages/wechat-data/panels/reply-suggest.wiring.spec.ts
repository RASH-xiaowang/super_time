/**
 * 「推荐回复」的接线守卫：按钮只在单聊、面板挂在消息流右侧、读取范围只给当前会话。
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：本文件在 `src/client/ui-wechat/src/client/pages/wechat-data/panels/` 下，上溯 8 级。 */
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const chats = strip(readFileSync(join(HERE, 'Chats.tsx'), 'utf8'))
const panel = readFileSync(join(HERE, 'ReplySuggest.tsx'), 'utf8')
const data = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'reply-suggest.ts'), 'utf8')

describe('推荐回复的接线', () => {
  it('头部按钮只在单聊出现，且文案与入口一致', () => {
    const at = chats.indexOf('推荐回复：按这段对话')
    expect(at, '找不到推荐回复按钮的 title —— 改名后请同步本用例').toBeGreaterThan(-1)
    // 按钮所在的那个条件表达式里必须限定 private
    const around = chats.slice(Math.max(0, at - 400), at)
    expect(around.includes("curSession.type === 'private'"), '推荐回复按钮应当只对单聊出现').toBe(true)
  })

  it('面板挂在消息流右侧（第三栏），且把当前会话传进去', () => {
    const at = chats.indexOf('<ReplySuggest')
    expect(at, '找不到 ReplySuggest 的挂载点 —— 改名后请同步本用例').toBeGreaterThan(-1)
    // 条件在标签**之前**（JSX 的 `{cond && (<Comp .../>)}`），所以两边都要看。
    const around = chats.slice(Math.max(0, at - 300), at + 220)
    expect(around.includes('target={curSession}'), '面板必须拿到当前会话（否则读取范围会退化成「没有范围」）').toBe(true)
    expect(around.includes("curSession.type === 'private'"), '面板同样只该对单聊挂载').toBe(true)
  })

  it('数据层按 talker 取上下文（跨会话隔离靠它）', () => {
    // collectReplyContext 必须把 talker 交给 queryMessages（唯一的数据入口）
    const m = /export function collectReplyContext\(([\s\S]*?)\n\}/.exec(data)
    expect(m, '找不到 collectReplyContext —— 改名后请同步本用例').not.toBeNull()
    const body = m![1]
    expect(body.includes('queryMessages('), '上下文必须来自 queryMessages（不要自己开库）').toBe(true)
    expect(/\bqueryMessages\([^)]*talker/.test(body), 'queryMessages 的第一个业务参数必须是 talker').toBe(true)
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
