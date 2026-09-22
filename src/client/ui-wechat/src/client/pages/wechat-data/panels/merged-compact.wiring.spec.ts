/**
 * 合并面板外壳（顶部分段切换条）紧凑化的**接线**守卫。
 *
 * 背景：六个「同主题、多视图」的导航项都由 `MergedSections` 起一条分段切换条
 * （消息视图 / 收藏与表情 / 文件与存储 / 资金往来 / 群聊分析 / 总结与报告）。
 * 那条 `.bar` 原先自带 `padding: 14px 0 0`，叠在外层 `.content` 的 16px 内边距
 * 之上 —— 于是条上方有 14px 纯留白、条下方又要等子面板自己的 padding（16px），
 * 观感上变成「条飘在两段留白中间」，而且它比下面板内容还疏。
 *
 * 本轮改了三处**不参与任何功能测试**的值，改回去不会有任何用例转红：
 *   ① `.bar` 取消上方留白，只留 6px 收口（条与内容之间的留白 30px → 14px）；
 *   ② 子面板的上下内边距由外壳覆写 `--nm-panel-pad` 统一收一档；
 *   ③ 分段项横向内边距 12px → 10px（横向最容易溢出的控件，少一次换行）。
 *
 * 其中 ③ 的**最小点击高度是 WCAG 2.2 SC 2.5.8 的硬要求（≥24×24）**，
 * 且除本文件外没有任何用例在守 —— 是本轮最容易被后续「再压一点」误删的一行。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
/** 去掉注释再断言：注释里会引用「原为 14px」这类旧值，直接匹配源码会误判。 */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const theme = read('../scifi-theme.css')
const mergedCode = strip(read('merged.module.css'))
// M21 第十七刀把 kit 的 CSS 也拆了（表格 / 浮层各一份）：按**前缀联合**读全部 kit*.module.css，
// 断言本身一条没改（规则搬到哪一份都算数）。
const kitCode = strip(readdirSync(join(HERE, '..', 'ui')).filter((f) => /^kit(-[a-z]+)?\.module\.css$/.test(f)).sort().map((f) => read(join('..', 'ui', f))).join('\n'))
const shellTsx = read('MergedSections.tsx')

/** 取一个 CSS 块（`选择器 { … }`，不含嵌套），没有就返回空串。 */
const block = (css: string, selector: string): string => {
  const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
  return m?.[1] ?? ''
}

describe('分段条：上方不再留白', () => {
  it('.bar 去掉了 14px 的上方留白', () => {
    expect(mergedCode, '旧的 `padding: 14px 0 0` 回来了').not.toContain('padding: 14px')
    expect(mergedCode).toMatch(/\.bar \{[^}]*align-items: center/)
  })

  it('.bar 只留一档 6px 收口（用密度令牌，不是手写数字）', () => {
    expect(block(mergedCode, '.bar')).toMatch(/padding: 0 0 var\(--nm-dense-g3\)/)
  })
})

describe('子面板的上下内边距由外壳统一收口', () => {
  it('.body 覆写了 --nm-panel-pad，且没用字面量 16px', () => {
    const b = block(mergedCode, '.body')
    expect(b, '外壳没有覆写 --nm-panel-pad，子面板还是 16px').toContain('--nm-panel-pad')
    expect(b).toMatch(/--nm-panel-pad: var\(--nm-dense-g4\) 0/)
    expect(b, '覆写值退化成了字面量，失去与主题同步的能力').not.toContain('16px')
  })

  it('主题里 --nm-panel-pad 的原值是 16px —— 覆写必须比它紧', () => {
    // 直接解析数值而不是抓 `:root` 块：主题里有**两个** `:root`，令牌在后一个，
    // 按块抓会取到前面的基础块、拿到 undefined（第一版就踩了这个坑）。
    const m = /--nm-panel-pad:\s*(\d+)px/.exec(theme)
    expect(m, '主题里找不到 --nm-panel-pad').not.toBeNull()
    const rootDefault = Number(m![1])
    const override = /--nm-panel-pad:\s*var\(--nm-dense-g4\)/.exec(mergedCode)
    const dense = /--nm-dense-g4:\s*(\d+)px/.exec(theme)
    expect(dense, '主题里找不到 --nm-dense-g4').not.toBeNull()
    // 覆写必须真的更紧：否则这一层就是空操作，注释里「留白 30px → 14px」的账不成立。
    expect(Number(dense![1])).toBeLessThan(rootDefault)
    expect(override, '外壳没有按密度令牌覆写').not.toBeNull()
  })

  it('被收口的面板确实读的是这个令牌（否则覆写静默失效）', () => {
    // 合并组里「自带根类」的三个面板 + kit 的面板骨架，都必须走同一个令牌。
    // 一旦有人把它改成字面量 16px，外壳的覆写就不再生效 —— 而界面上只是
    // 「这一页比别页松一点」，没有任何用例会报警。
    for (const f of ['daily-summary.module.css', 'records.module.css', 'storage.module.css']) {
      expect(read(f), `${f} 不再读 --nm-panel-pad`).toContain('padding: var(--nm-panel-pad)')
    }
    expect(block(kitCode, '.panelShell')).toContain('padding: var(--nm-panel-pad)')
  })

  it('已知例外：list-panel 的面板根没有内边距，只靠 .bar 的 6px 兜底', () => {
    // 文件资产 / 我的收藏 / 表情包 / 撤回消息 用的是共用的 list-panel.module.css，
    // 它还被 7 个**非合并**面板共用，所以不能在那里加内边距（会波及设置弹窗等）。
    // 这条断言把这个边界写下来：如果哪天 list-panel 加了内边距，
    // 说明边界变了，应该连同上面的注释一起重新评估。
    const listPanel = block(strip(read('list-panel.module.css')), '.panel')
    expect(listPanel).not.toContain('padding')
  })
})

describe('令牌引用必须都存在（拼错就是 padding 归零）', () => {
  it('merged.module.css 用到的每个 --nm-* 都在主题里有定义', () => {
    const defined = new Set([...theme.matchAll(/(--nm-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = [...new Set([...mergedCode.matchAll(/var\((--nm-[a-z0-9-]+)/g)].map((m) => m[1]))]
    expect(used.length, '外壳没引用任何令牌').toBeGreaterThan(0)
    // var() 拼错不会报错，只会静默退化成「无值」→ padding 变 0，条直接贴住内容。
    expect(used.filter((u) => !defined.has(u)), '引用了主题里不存在的令牌').toEqual([])
  })
})

describe('分段项：横向收紧，但最小点击尺寸不许动', () => {
  it('横向内边距 12px → 10px', () => {
    expect(block(kitCode, '.segItem')).toMatch(/padding: 4px 10px/)
    expect(block(kitCode, '.segItem'), '旧的 12px 回来了').not.toMatch(/padding: 4px 12px/)
  })

  it('min-height 保持 24px（WCAG 2.2 SC 2.5.8）', () => {
    // 删掉这行高度会回落到 22px（实测值），键盘 / 触屏最小点击尺寸就不达标了。
    expect(block(kitCode, '.segItem')).toMatch(/min-height: 24px/)
  })
})

describe('外壳行为没被改坏', () => {
  it('仍然渲染分段控件 + 当前分段正文', () => {
    expect(shellTsx).toContain('<Segmented')
    expect(shellTsx).toContain('css.bar')
    expect(shellTsx).toContain('css.body')
    expect(shellTsx).toContain('current.render()')
  })

  it('深链同步还在（initial 变化要切到对应分段）', () => {
    // 同一组合并面板被多个 tab 复用（同一个组件实例），useState 只在首次生效 ——
    // 少了这个 effect 就会出现「点了撤回消息却还停在会话列表」。
    expect(shellTsx).toMatch(/useEffect\(\(\) => \{ setActive\(initial\) \}, \[initial\]\)/)
  })

  it('六个合并组都还在（没有被悄悄拆掉）', () => {
    const panel = read('../WechatDataPanel.tsx')
    for (const label of ['消息视图', '收藏与表情视图', '文件与存储视图', '资金往来视图', '群聊分析视图', '总结与报告视图']) {
      expect(panel, `合并组「${label}」不见了`).toContain(`ariaLabel="${label}"`)
    }
  })
})
