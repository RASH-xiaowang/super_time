/**
 * 消息板面「对齐微信桌面端官方布局」的几何守卫（2026-10-12）。
 *
 * 起因（用户要求）：聊天会话的**消息板面**布局要和官方微信一样。
 * 下层 CSS 早就写着「对齐微信官方桌面端几何」，但真有四处对不上，而且没有一条判据
 * 能发现它们 —— 它们只是「看起来不太像微信」：
 *
 *   ① **气泡尖角是菱形**：用 12×12 的方块 `rotate(45deg)`，画出来上下都鼓；微信桌面端
 *      是「贴气泡那条边是直的、尖朝外」的三角形。
 *   ② **消息区是一张卡**：四周边框 + 圆角 + 毛玻璃 + 卡片底，而微信桌面端是
 *      「扁平消息区 + 左边一条发丝线」。
 *   ③ **头像 34px**：微信桌面端官方是 40px；而且这个数曾写在两处（令牌 + 行内 size），
 *      两处不同步时气泡宽度的扣减就会对错。
 *   ④ **消息区头部贴在左边**：微信桌面端是「会话名居中 + 右侧动作」。
 *
 * 这条判据不重复 CSS 里已有的宽度/行距守卫（`chats-bubble-width.wiring.spec.ts` /`);
 * `chats-row-gap.wiring.spec.ts`），只钉上面这四件**形态**。
 * 全部断言都带反例可做：改动任何一处都会红。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8')

const ROWS = read('chats-rows.module.css')
const MSG = read('chats.module.css')
const SHELL = read('chats-shell.module.css')
const ROWS_FILE = read('chats-msg-row.tsx')

/** 剥注释：解释「为什么不写某条」的注释里会原样出现那条声明的片段。 */
function strip(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取某块的声明（到第一个 `}` 为止），同样剥注释。 */
function blockOf(css: string, cls: string): string {
  const start = css.indexOf(`.${cls} {`)
  expect(start, `CSS 里找不到 .${cls}`).toBeGreaterThan(-1)
  return strip(css.slice(start, css.indexOf('}', start)))
}

describe('消息板面 · 微信桌面端官方几何', () => {
  it('① 气泡尖角是真三角（clip-path），不是旋转方块（菱形）', () => {
    // 只在「尖角那一节」里查：rotate(45deg) 在文件别处还有合法用处（别的元素也在用），
    // 整份扫会把不相干的地方算上。
    const tailAt = MSG.indexOf('/* 微信气泡尖角')
    expect(tailAt, '找不到尖角那一节').toBeGreaterThan(-1)
    const tailEnd = MSG.indexOf('.msgRowSelf .msgBubble {', tailAt)
    expect(tailEnd, '尖角一节的右边界找不到').toBeGreaterThan(tailAt)
    const tail = strip(MSG.slice(tailAt, tailEnd))
    expect(tail, '收到的尖角要用 clip-path 切成三角形').toContain('clip-path: polygon(100% 0, 100% 100%, 0 50%)')
    expect(tail, '发出的尖角同样要用 clip-path').toContain('clip-path: polygon(0 0, 0 100%, 100% 50%)')
    // 反面：那一节里不许再出现旋转方块（那画出来是菱形，不像微信）
    expect(tail, '尖角又变成旋转方块了（菱形不像微信）').not.toContain('rotate(45deg)')
    expect(tail, '尖角也不该再带圆角（三角形没有圆角这一步）').not.toContain('border-radius: 2px')
  })

  it('② 消息区是扁平的：没有四周边框/圆角/毛玻璃，只有左边一条发丝线', () => {
    const m = blockOf(ROWS, 'messages')
    expect(m, '消息区又是卡片了（边框 + 圆角）').not.toContain('border-radius: var(--nm-r-lg)')
    // 注意只禁 blur：`backdrop-filter: none` 是「显式关掉」，两回事
    expect(m, '消息区不该糊毛玻璃').not.toMatch(/backdrop-filter:\\s*blur/)
    expect(m, '消息区要去掉四周边框').toContain('border: none')
    // 边界仍是发丝线，但只在左侧
    expect(m, '与会话列表的分隔必须是左边一条发丝线').toContain('border-left: 1px solid var(--nm-border)')
    // 微信的消息区底色与会话内的聊天底色同一个
    expect(m, '消息区底色没有跟随聊天底色令牌').toContain('background: var(--wx-chat-bg)')
  })

  it('③ 头像 40px，且令牌与行内 size 是同一个数（两处漂移会让宽度扣减算错）', () => {
    const avatar = ROWS.match(/--wx-avatar:\s*(\d+)px/)
    expect(avatar, '找不到 --wx-avatar 定义').not.toBeNull()
    expect(avatar![1], '微信桌面端消息行头像是 40px').toBe('40')
    expect(ROWS_FILE, '行内头像尺寸和令牌不一致（改令牌没改 size，或反过来）').toContain('size={40}')
    // 气泡宽度上界那条扣减必须引用令牌，不能另写一个 44 之类的字面量
    expect(ROWS, '宽度扣减要引用头像令牌').toContain('calc(100% - var(--wx-avatar) - var(--wx-gap))')
  })

  it('④ 头部：会话名**始终左对齐**、动作排贴右；底色与消息流同一个来源', () => {
    // 2026-10-14 改判据口径：原写法无条件要求标题绝对居中，而那是**量过不成立**的几何 ——
    // 动作排约 350px，1280px 窗口下消息列约 740px，居中标题与动作排必然重叠约 57px
    // （那版选择器此前还是死规则，判据读源码所以一直绿、真机上从来没生效过）。
    // 于是改成「门槛以下在流、门槛以上居中 + 动作靠右」这个**带可行性门槛**的形态。
    //
    // 2026-10-16 门槛 960 → 1200：960 那版**漏算了轮询状态**（`✓ 时间 · N 条新消息`，实测 112px）。
    // 绝对居中的标题两侧必须对称，右侧**所有**内容都要计入：
    //   2 × (动作排 351 + gap 10 + 轮询 112) + 标题 240 = 1186 ⇒ 取 1200。
    // 真机逐档实测：列宽 1382 余量 97px ✅ / 列宽 1062 **重叠 63px** ❌（旧门槛放它进来了）。
    //
    // 2026-10-16 用户要求**彻底去掉居中**：绝对居中要求两侧完全对称，任何右侧元素增删都要
    // 重算门槛，且窄窗口下标题会突然从居中跳到左侧、观感割裂。现在统一左对齐 ——
    // 标题紧贴左缘、动作排与轮询状态贴右缘，**任何列宽下都不重叠**，也不再按宽度切换布局。
    const info = blockOf(SHELL, 'msgHeaderInfo')
    expect(info, '标题必须**在流**（绝对居中会压到动作排上，且要求两侧对称）')
      .not.toContain('position: absolute')
    expect(info, '标题要吃掉中间、把动作排推到右边').toContain('flex: 1')
    expect(info, '标题不许再居中（用户要求左对齐）').not.toContain('text-align: center')
    expect(info, '标题不许再居中（用户要求左对齐）').not.toContain('align-items: center')
    // 整个文件里都不该再有「宽列切绝对居中」的容器查询
    expect(strip(SHELL), '不该再有把标题切成绝对居中的容器查询（用户要求始终左对齐）')
      .not.toContain('left: 50%')
    expect(strip(SHELL), '不该再有把标题切成绝对居中的容器查询（用户要求始终左对齐）')
      .not.toContain('translate(-50%, -50%)')
    // 动作排无条件贴右（原先只在宽列档里，现在提到基础档）
    expect(blockOf(SHELL, 'msgHeaderActions'), '动作排必须贴右（「右侧动作」是这条例子的另一半）')
      .toContain('margin-left: auto')
    // 轮询状态**不许**再自己吃 `margin-left: auto`：两个 auto 会平分剩余空间，
    // 把动作排从右缘推到中间，于是与标题重叠（2026-10-16 用户截图报的那一版）。
    const poll = blockOf(read('chats-cards.module.css'), 'msgHeaderPoll')
    expect(poll, '轮询状态不许再吃 margin-left: auto（会与动作排平分剩余空间、把动作排推到标题上）')
      .not.toContain('margin-left: auto')
    // 聊天底色只能有一个来源：同一个文件里深色值一份、浅色值一份。
    // （不能按「行首」数：深浅两块都写在各个规则的声明区里，行首匹配会两边都数上。）
    const darkDefs = (ROWS.match(/--wx-chat-bg:\s*#191919;/g) ?? []).length
    expect(darkDefs, '--wx-chat-bg 深色值必须只定义一次，否则头与消息流会裂成两种背景').toBe(1)
    const lightDefs = (ROWS.match(/--wx-chat-bg:\s*#ededed;/g) ?? []).length
    expect(lightDefs, '--wx-chat-bg 浅色值必须只定义一次').toBe(1)
    expect(blockOf(read('chats-cards.module.css'), 'msgHeader'), '头部没有跟随聊天底色')
      .toContain('background: var(--wx-chat-bg)')
  })
})
