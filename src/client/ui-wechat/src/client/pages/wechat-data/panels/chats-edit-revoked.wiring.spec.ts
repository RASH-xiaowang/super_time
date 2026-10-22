/**
 * 编辑消息框与撤回行的视觉 / 可访问性守卫。
 *
 * 用户截图反馈过两件事：
 *  ① 编辑消息弹窗太窄，长正文频繁折行；
 *  ② 撤回行没有左对齐、头像缺失，且正文/资源要展开后才出现。
 *
 * 这里不做浏览器像素测量，只钉住真正决定形态的源码与 CSS：
 *  - 编辑弹窗必须继续接 `editDialog`，且双类名宽度压过 kit 的 520px 基础值；
 *  - 输入区至少 160px 高、可纵向拉伸，手机档整宽；
 *  - 轮询状态仍在动作排之前；
 *  - 撤回行整宽左对齐，正文组件每一行都渲染，头像与昵称结构不被破坏。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')

const VIEW = read('chats-view.tsx')
const TOOLS = read('chats-message-tools.tsx')
const CARDS_CSS = read('chats-cards.module.css')
const REVOKED = read('Revoked.tsx')
const LIST_CSS = read('list-panel.module.css')

/** 剥注释，避免解释性注释里的片段被误判为真实声明。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取一条选择器的声明体。选择器可以含多个类名。 */
function ruleOf(css: string, selector: string): string {
  const clean = stripComments(css)
  const start = clean.indexOf(`${selector} {`)
  expect(start, `CSS 里找不到 ${selector}`).toBeGreaterThan(-1)
  const open = clean.indexOf('{', start)
  const end = clean.indexOf('}', open)
  expect(end, `${selector} 的声明体没有闭合`).toBeGreaterThan(open)
  return clean.slice(open + 1, end)
}

/** 在指定媒体查询中找包含 needle 的那一块，返回完整块体。 */
function mediaBlockOf(css: string, condition: string, needle: string): string {
  const clean = stripComments(css)
  let from = 0
  while (from < clean.length) {
    const at = clean.indexOf(`@media ${condition}`, from)
    if (at < 0) return ''
    const open = clean.indexOf('{', at)
    let depth = 0
    let end = -1
    for (let i = open; i < clean.length; i += 1) {
      if (clean[i] === '{') depth += 1
      else if (clean[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end, `${condition} 没有闭合`).toBeGreaterThan(open)
    const body = clean.slice(open + 1, end)
    if (body.includes(needle)) return body
    from = end + 1
  }
  return ''
}

describe('编辑消息弹窗', () => {
  it('仍把 editDialog 接到 Dialog 上，并把 editArea 接到 textarea 上', () => {
    const start = TOOLS.indexOf('<Dialog')
    const end = TOOLS.indexOf('</Dialog>', start)
    expect(start, '找不到编辑消息 Dialog').toBeGreaterThan(-1)
    expect(end, '编辑消息 Dialog 没有结束标签').toBeGreaterThan(start)
    const dialog = TOOLS.slice(start, end)

    expect(dialog, '编辑消息 Dialog 丢了 editDialog 类').toContain('${csscards.editDialog}')
    const areaStart = dialog.indexOf('<textarea')
    expect(areaStart, '编辑消息弹窗里没有 textarea').toBeGreaterThan(-1)
    const area = dialog.slice(areaStart, dialog.indexOf('/>', areaStart) + 2)
    expect(area, 'textarea 丢了 editArea 类').toContain('${csscards.editArea}')
    expect(area, 'textarea 的可访问名称丢了').toContain("aria-label={mode === 'editText' ? '消息内容' : '消息源码'}")
  })

  it('双类名宽度是 min(760px, 92vw)，不是 kit 的 520px', () => {
    const rule = ruleOf(CARDS_CSS, '.editDialog.editDialog')
    expect(rule, '编辑框宽度又退回 520px').not.toContain('520px')
    expect(rule, '编辑框宽度必须是 760px 与 92vw 的较小值').toMatch(
      /width:\s*min\(760px,\s*92vw\);/,
    )
    expect(rule, '双类名规则不应再写死单一像素宽度').not.toMatch(/width:\s*\d+px;/)
  })

  it('输入区至少 160px、可纵向拉伸，手机档整宽', () => {
    const area = ruleOf(CARDS_CSS, '.editArea')
    expect(area, '输入区宽度没有吃满弹窗').toContain('width: 100%')
    expect(area, '输入区最小高度又低于 160px').toContain('min-height: 160px')
    expect(area, '输入区高度上限没有随视口收缩').toContain('max-height: 50vh')
    expect(area, '输入区必须允许用户纵向拉伸').toContain('resize: vertical')

    const mobile = mediaBlockOf(CARDS_CSS, '(max-width: 560px)', '.editDialog.editDialog')
    expect(mobile, '手机档没有编辑弹窗的整宽覆盖').not.toBe('')
    const mobileRule = ruleOf(mobile, '.editDialog.editDialog')
    expect(mobileRule, '手机档弹窗宽度必须是 100%').toContain('width: 100%')
    expect(mobileRule, '手机档弹窗不得再留 92vw 上界').toContain('max-width: 100%')
  })
})

describe('会话头轮询状态', () => {
  it('DOM 顺序仍在 ChatsHeadActions（AI 问答 / 更多）之前', () => {
    const pollAt = VIEW.indexOf('{pollStatus &&')
    const actionsAt = VIEW.indexOf('<ChatsHeadActions')
    expect(pollAt, '找不到轮询状态').toBeGreaterThan(-1)
    expect(actionsAt, '找不到动作排').toBeGreaterThan(-1)
    expect(pollAt, '轮询状态又跑回动作排后面了').toBeLessThan(actionsAt)
  })
})

describe('撤回行', () => {
  it('行与头部整宽左对齐，正文按头像列缩进', () => {
    const row = ruleOf(LIST_CSS, '.rvRow')
    expect(row, '撤回行必须占满列表宽度').toContain('width: 100%')
    expect(row, '撤回行必须纵向排正文').toContain('flex-direction: column')
    expect(row, '撤回行的子项必须拉伸到整宽').toContain('align-items: stretch')
    expect(row, '撤回行宽度不能因 padding/border 溢出').toContain('box-sizing: border-box')

    const head = ruleOf(LIST_CSS, '.rvRowHd')
    expect(head, '撤回行头部必须从左侧开始').toContain('justify-content: flex-start')
    expect(head, '撤回行头部必须整宽').toContain('width: 100%')
    expect(head, '撤回行头部必须垂直居中').toContain('align-items: center')

    const body = ruleOf(LIST_CSS, '.rvBodyPad')
    expect(body, '正文必须占满行宽').toContain('width: 100%')
    expect(body, '正文必须按 28px 头像列缩进 48px').toContain('padding: 4px 8px 8px 48px')
    expect(body, '正文宽度不能因 padding 溢出').toContain('box-sizing: border-box')
  })

  it('撤回头部窄屏可换行，正文不再使用 4 行截断', () => {
    const head = ruleOf(LIST_CSS, '.rvRowHd')
    expect(head, '窄屏长昵称会把时间/展开符挤出头部').toContain('flex-wrap: wrap')
    expect(head, '换行后行间距需要可读').toMatch(/row-gap|gap:\s*[^;]*\s/)

    const bodyText = ruleOf(LIST_CSS, '.rvBodyText')
    expect(bodyText, '撤回正文仍未展开时不得截断').not.toContain('line-clamp')
    expect(bodyText, '撤回正文应保留换行').toContain('white-space: pre-wrap')
    expect(LIST_CSS, 'CSS 里仍存在 4 行 clamp').not.toMatch(/-webkit-line-clamp:\s*4/)
  })

  it('每一行都直接渲染 RevokedContent，不等展开才出现', () => {
    const start = REVOKED.indexOf('filtered.slice(0, rvCount).map')
    const end = REVOKED.indexOf('{filtered.length > rvCount', start)
    expect(start, '找不到撤回行 map').toBeGreaterThan(-1)
    expect(end, '找不到撤回行 map 的结束位置').toBeGreaterThan(start)
    const rows = REVOKED.slice(start, end)

    expect(rows, '撤回正文/资源不是每行都渲染').toContain('<RevokedContent item={it} open={open} />')
    expect(rows, '撤回正文/资源又被包在展开条件里').not.toMatch(/\{open\s*&&/)
    expect(rows, '撤回行缺少展开态语义').toContain('aria-expanded={open}')
    expect(rows, '撤回行缺少可读的展开/收起标签').toContain('label: rowLabel')
  })

  it('头像、昵称、类型、时间与展开指示的结构保持', () => {
    const start = REVOKED.indexOf('filtered.slice(0, rvCount).map')
    const end = REVOKED.indexOf('{filtered.length > rvCount', start)
    const rows = REVOKED.slice(start, end)
    const headerAt = rows.indexOf('<div className={css.rvRowHd}>')
    const avatarAt = rows.indexOf('<Avatar')
    const nameAt = rows.indexOf('<span className={css.rowName}>')
    const typeAt = rows.indexOf('<span className={css.cite}>')
    const timeAt = rows.indexOf('className={`${css.rowTime} ${css.rvTimePush}`}')
    const chevronAt = rows.indexOf('<span className={css.rvChevron}')

    expect(headerAt, '找不到撤回行头部').toBeGreaterThan(-1)
    expect(avatarAt, '头像没有放在头部').toBeGreaterThan(headerAt)
    expect(nameAt, '昵称没有放在头像之后').toBeGreaterThan(avatarAt)
    expect(typeAt, '类型标签没有放在昵称之后').toBeGreaterThan(nameAt)
    expect(timeAt, '时间没有放在类型之后').toBeGreaterThan(typeAt)
    expect(chevronAt, '展开指示没有放在时间之后').toBeGreaterThan(timeAt)
    expect(rows, '头像没有使用真实 sender_username').toContain("username={it.sender_username ?? ''}")
    expect(rows, '头像没有使用发送者展示名').toContain("name={it.sender || '未知'}")
  })
})
