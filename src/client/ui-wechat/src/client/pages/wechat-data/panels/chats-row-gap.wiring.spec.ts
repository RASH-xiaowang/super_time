/**
 * 消息行间距的接线守卫。
 *
 * 三条不变量的由来：
 *
 * ① **行间距只能由虚拟行的 `padding-bottom` 提供**。
 *    消息行是 `position: absolute` + `translateY()` 定位的（N18 虚拟化），
 *    **flex gap 对绝对定位子元素无效** ⇒ `.msgBody` 上的 `gap` 根本管不到行与行之间。
 *    2026-09-25 用户截图实测：气泡→灰字行 7px、灰字行→气泡 3px —— 那点空隙全是行内元素
 *    （昵称的 `margin-bottom: 4px`、文字行高余量）凑出来的，所以**又小又不统一**。
 *
 * ② **必须是 padding，不能是 margin**：`measureElement` 量的是元素的 border-box
 *    （不含 margin），用 margin 的话这段高度不会进 `translateY` 的累加 ——
 *    间距照样看不见，还会让相邻行重叠。
 *
 * ③ **间距要统一**：所有行类型共用 `--wx-row-gap`（16px，从微信官方量的那枚）；
 *    `.msgRow` / `.msgRowSystem` / `.msgDayDivider` 都不许自己加 `margin-bottom` ——
 *    那正是「同一条消息流里间距因内容不同而不同」的来源。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

const CSS = read('chats-rows.module.css')
/** `.msgRow` 本体在 chats.module.css（行样式的主文件），其余行类型在 chats-rows。 */
const MSG_CSS = read('chats.module.css')
const VIEW = read('chats-view.tsx')

/** 取某个 class 的声明块（只到第一个 `}`）。 */
function classBlock(css: string, name: string): string {
  const start = css.indexOf(`.${name} {`)
  expect(start, `CSS 里找不到 .${name}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('消息行间距', () => {
  it('① 虚拟行用 padding-bottom 撑出行间距，且值走 --wx-row-gap 令牌', () => {
    const row = classBlock(CSS, 'msgVRow')
    expect(row, '行间距必须作用在虚拟行自己身上（flex gap 对绝对定位元素无效）').toMatch(/padding-bottom:\s*var\(--wx-row-gap\)/)
    expect(CSS, '--wx-row-gap 必须有定义（16px 是官方量来的值）').toContain('--wx-row-gap: 16px')
  })

  it('② 用 padding 而不是 margin（margin 不进 measureElement 量到的高度）', () => {
    const row = classBlock(CSS, 'msgVRow')
    expect(row, 'margin 会让间距失效：测量只算 border-box').not.toContain('margin')
  })

  it('③ 间距统一：各消息行自己不得加 margin-bottom', () => {
    expect(classBlock(MSG_CSS, 'msgRow'), 'msgRow 不该自带下边距（间距只由 .msgVRow 一处提供）').not.toContain('margin-bottom')
    for (const cls of ['msgRowSystem', 'msgDayDivider']) {
      expect(classBlock(CSS, cls), `${cls} 不该自带下边距（那会让间距因内容类型而不同）`).not.toContain('margin-bottom')
    }
  })

  it('④ 虚拟行真的挂上了这个类（否则 CSS 写了也白写）', () => {
    const at = VIEW.indexOf('ref={msgVirtualizer.measureElement}')
    expect(at, '找不到虚拟行的 measureElement 绑定').toBeGreaterThan(-1)
    const around = VIEW.slice(at, at + 400)
    expect(around, '虚拟行要 className={cssrows.msgVRow}').toContain('className={cssrows.msgVRow}')
  })
})
