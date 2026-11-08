/**
 * 右抽屉的标题栏让位守卫。
 *
 * kit 的 `Drawer` 走 Radix Portal，直接挂在 `body` 下；如果遮罩与内容仍写
 * `top: 0`，就会盖住 Electron 的 38px 自绘标题栏（用户截图中的「打开网页 /
 * 余额 / 数据就绪 / 主题 / 窗口控制」整条消失）。
 *
 * 这里同时钉住两端：标题栏高度变量只在标题栏存在时为 38px，抽屉的遮罩和
 * 面板都消费它；手机档转底部 sheet 时仍必须把 `top` 压回 `auto`。
 *
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atRuleBlock, classBlock, findRoot, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const titlebarCss = readText(join(ROOT, 'src', 'client', 'ui-app', 'titlebar.css'))
const overlayCss = readText(join(HERE, 'kit-overlay.module.css'))

describe('右抽屉不遮自绘标题栏', () => {
  it('标题栏高度默认 0，仅真实挂载 #titlebar 时为 38px', () => {
    expect(titlebarCss, '缺少浏览器态的 0px 默认值').toContain(':root {\n  --st-titlebar-h: 0px;')
    expect(titlebarCss, '标题栏存在时没有把共享高度设成 38px')
      .toContain('body:has(> #titlebar) {\n  --st-titlebar-h: 38px;')

    const titlebar = /#titlebar\s*\{[^}]*\}/.exec(titlebarCss)?.[0] ?? ''
    expect(titlebar, '找不到 #titlebar 规则').not.toBe('')
    expect(titlebar, '标题栏 flex basis 与共享高度脱节').toMatch(/flex:\s*0 0 var\(--st-titlebar-h\)/)
    expect(titlebar, '标题栏 height 与共享高度脱节').toMatch(/height:\s*var\(--st-titlebar-h\)/)
    expect(titlebar, '模态抽屉打开后标题栏可能被 body 的 pointer-events:none 禁掉')
      .toMatch(/pointer-events:\s*auto/)
  })

  it('抽屉遮罩与面板都从标题栏下方开始', () => {
    const mask = classBlock(overlayCss, 'drawerOverlay')
    expect(mask, '抽屉遮罩仍从视口顶部开始').toContain('top: var(--st-titlebar-h, 0px)')
    expect(mask, '抽屉遮罩仍用 inset: 0 覆盖标题栏').not.toContain('inset: 0')

    const drawer = classBlock(overlayCss, 'drawer')
    expect(drawer, '右侧抽屉仍从视口顶部开始').toContain('top: var(--st-titlebar-h, 0px)')
    expect(drawer, '右侧抽屉又写死了 top: 0').not.toMatch(/top:\s*0(?:;|\s*$)/m)
  })

  it('手机档仍从底部升起，不被桌面偏移改回顶部抽屉', () => {
    const phone = atRuleBlock(overlayCss, '@media (max-width: 560px)')
    expect(phone, '手机档抽屉没有压回 top: auto').toContain('top: auto !important')
  })
})
