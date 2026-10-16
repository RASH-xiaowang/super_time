/**
 * 手机端外壳的**跨文件一致性**判据。
 *
 * ## 为什么单独一份
 *
 * 手机外壳是「一个断点数 + 五个文件」的组合：JS 侧 `PHONE_QUERY`（决定底部栏渲不渲染）、
 * `wechat-data.module.css`（侧栏塌成搜索条、内容让出底部栏高度）、`kit-overlay.module.css`
 * （抽屉/弹窗转全屏 sheet）、`mobile-viewport.css`（dvh / 安全区 / 可选中文字）、
 * 以及两张悬浮卡的隐藏。这五处**必须用同一个 560**。
 *
 * 一旦某处写成 520 或 600，症状是「底部栏出来了但侧栏还在」或「侧栏没了但抽屉还是右侧抽屉」
 * 这种半手机半桌面的缝合态 —— 而它只在真机窄屏上出现，桌面回归测试全绿。
 * 所以这里把「560 出现在哪些文件、每处都做了什么」逐条钉住。
 *
 * 另外钉两条**结构**事实：抽屉转 sheet 必须带 `!important`（宽度是内联 style，压不住就白写），
 * 以及 `WechatDataPanel` 真的挂了 `MobileNavHost`（没挂的话上面全是死 CSS）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { atRuleBlock } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WD = join(HERE, '..')
/** `src/client/`：从本 spec 所在目录上溯 6 级（ui → wechat-data → pages → client → src → ui-wechat → client）。 */
const CLIENT = join(HERE, '..', '..', '..', '..', '..', '..')
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')

/** 手机档的 at-rule 头（与 `use-media-query.ts#PHONE_QUERY` 同一个数）。 */
const PHONE = '@media (max-width: 560px)'

const shell = read(WD, 'wechat-data.module.css')
const overlay = read(WD, 'ui', 'kit-overlay.module.css')
const viewport = read(CLIENT, 'ui-app', 'mobile-viewport.css')
const guide = read(WD, 'panels', 'setup-guide.module.css')
const notice = read(WD, 'panels', 'notice.module.css')
const panel = read(WD, 'WechatDataPanel.tsx')
const hook = read(WD, 'ui', 'use-media-query.ts')

/**
 * 取某个文件里手机档那一段的内容。
 *
 * 实现住在 `test-helpers/wiring-kit.ts`（M5 起 chats 那侧也要按档断言，两处各抄一份
 * 括号配对迟早走样 —— 走样的样子是「切多/切少 ⇒ 断言假绿」）。
 * 与本文件早先那份的差别：**找不到就红**，不再返回空串。
 */
function phoneBlock(src: string): string {
  return atRuleBlock(src, PHONE)
}

describe('断点数只有一处口径：560', () => {
  it('JS 侧的 PHONE_QUERY 就是 (max-width: 560px)', () => {
    expect(hook).toContain("export const PHONE_QUERY = '(max-width: 560px)'")
  })

  it('五个外壳文件都用了同一个 560 断点（少一处就是半手机半桌面的缝合态）', () => {
    for (const [name, src] of [
      ['wechat-data.module.css', shell],
      ['kit-overlay.module.css', overlay],
      ['mobile-viewport.css', viewport],
      ['setup-guide.module.css', guide],
      ['notice.module.css', notice],
    ] as const) {
      expect(src, `${name} 里没有 ${PHONE}`).toContain(PHONE)
    }
    // 反向：这些文件里不许再冒出第二个手机断点（480 / 520 / 600 都会与 560 打架）
    for (const [name, src] of [
      ['wechat-data.module.css', shell],
      ['kit-overlay.module.css', overlay],
    ] as const) {
      for (const bad of ['max-width: 480px', 'max-width: 520px', 'max-width: 600px', 'max-width: 640px']) {
        expect(src, `${name} 里出现了第二个手机断点 ${bad}`).not.toContain(bad)
      }
    }
  })
})

describe('外壳各处在 560 下做了什么', () => {
  it('侧栏塌成顶部搜索条，而不是整块隐藏（全局搜索住在侧栏里）', () => {
    const b = phoneBlock(shell)
    expect(b, '侧栏没有在手机档重排').toContain('.sidebar')
    // 关键：只留搜索框。整块 display:none 会让手机上再也搜不了
    expect(b, '没有「只留 .navSearch」这条 —— 侧栏被整块藏掉的话全局搜索就没了')
      .toContain('.sidebar > *:not(.navSearch) { display: none; }')
    expect(b, '内容区没有给底部标签栏让出高度（最后一行会被压在栏下面）')
      .toMatch(/padding-bottom:\s*calc\(\d+px \+ env\(safe-area-inset-bottom/)
    expect(b, '.body 没有改成竖排（搜索条与内容会并排）').toContain('flex-direction: column')
  })

  it('触摸目标下限：全局元素级 44px + 段条在手机档覆盖回 44px', () => {
    // 2026-10-14 在 375px × 真实数据上量的：段条 24px（8 组合并视图的主导航）、
    // 分类按钮/作者芯片 26px、日期预设 24px、搜索框 32px —— 手指点不准，触摸上也没有 :hover 补救。
    const b = phoneBlock(viewport)
    expect(b, '手机档没有元素级的 44px 下限').toMatch(/min-height:\s*44px/)
    expect(b, '下限不该把复选/单选框也抬（会把行撑破）').toContain('input:not([type="checkbox"]):not([type="radio"])')
    // 段条基础档是刻意的 24px（WCAG 2.5.8 AA，merged-compact 钉着），元素级规则被它的类特异性盖住
    // ⇒ 必须在 kit-overlay 的手机档里覆盖；两边都要在，少一边就是 24px。
    const ob = phoneBlock(overlay)
    expect(ob, '段条在手机档没有抬到 44px ⇒ 元素级规则被 .segItem 的类特异性盖住，实际仍是 24px')
      .toContain('.segItem { min-height: 44px; }')
    expect(overlay.slice(0, overlay.indexOf(PHONE)), '段条基础档被顺手改成 44px ⇒ 桌面档也变高，且 merged-compact 的 24px 判据会红')
      .not.toContain('.segItem { min-height: 44px; }')
  })

  it('抽屉与弹窗转全屏底部 sheet，且宽度覆盖带 !important（宽度是内联 style）', () => {
    const b = phoneBlock(overlay)
    expect(b, '抽屉没有转成底部 sheet').toContain('.drawer')
    // 内联 style 的优先级高于任何选择器：不加 !important 这条等于没写
    expect(b, '抽屉宽度覆盖没有 !important —— 会被 kit-overlay.tsx 的内联 width 压住')
      .toContain('width: 100% !important')
    expect(b, '弹窗没有转成底部 sheet').toContain('.dialog')
    expect(b, '弹窗还留着居中定位的 transform').not.toContain('transform: translate(-50%')
    // 高度用 dvh：键盘顶起时 84vh 那套会把弹窗顶出屏幕
    expect(b, 'sheet 高度没用 dvh').toContain('dvh')
  })

  it('视口层：dvh 在 @supports 里、安全区与可选中文字在 560 里', () => {
    expect(viewport, 'dvh 没包在 @supports 里（不认 dvh 的老内核会整条失效）')
      .toContain('@supports (height: 100dvh)')
    const b = phoneBlock(viewport)
    expect(b, '没有安全区内边距（刘海与手势条会吃掉像素）').toContain('env(safe-area-inset-top')
    // titlebar.css 在 body 上关了文本选择；手机上复制聊天正文是高频动作，必须放回来
    expect(b, '窄视口下没有放开文本选择').toContain('user-select: text')
    // iOS Safari 横竖屏切换会自作主张放大正文，把 375px 排好的版面顶歪
    expect(b, '没有禁掉 iOS 的自动字号调整').toMatch(/text-size-adjust:\s*100%/)
  })

  it('两张悬浮卡在手机上不渲染（它们的动作都只能在这台电脑上做）', () => {
    expect(phoneBlock(guide), '配置向导卡在手机上仍然悬浮（392px 宽，盖掉半屏）')
      .toContain('.card { display: none; }')
    expect(phoneBlock(notice), '提醒堆栈在手机上仍然悬浮（只能看不能办）')
      .toContain('.stack { display: none; }')
  })
})

describe('接线：外壳真的挂上了', () => {
  it('WechatDataPanel 渲染了 MobileNavHost（否则上面全是死 CSS）', () => {
    expect(panel, '没有引入 MobileNavHost').toMatch(/from '\.\/ui\/mobile-nav\.tsx'/)
    expect(panel, '没有渲染 MobileNavHost').toContain('<MobileNavHost')
    // 选中 tab 时要带上桌面侧栏那套副作用（清聊天/朋友圈的选中态），否则切页会带着旧上下文
    expect(panel, '底部栏切 tab 没有清掉会话/朋友圈的选中态')
      .toContain('onSelect={(t) => { setChatTarget(null); setMomentAuthor(null); setActive(t) }}')
  })

  it('mobile-viewport.css 被 ui-entry 引入（没引入就是死文件）', () => {
    const entry = read(CLIENT, 'ui-app', 'ui-entry.tsx')
    expect(entry).toContain("import './mobile-viewport.css'")
  })

  it('底部标签栏是 fixed 且带手势条内边距（否则最后一格点不到）', () => {
    const nav = read(WD, 'ui', 'mobile-nav.module.css')
    expect(nav).toContain('position: fixed')
    expect(nav).toContain('env(safe-area-inset-bottom')
    // 触摸目标下限 44px
    expect(nav, '底部栏格子高度低于 44px 的触摸目标下限').toContain('min-height: 48px')
  })
})
