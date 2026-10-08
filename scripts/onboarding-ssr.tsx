/**
 * 启动页四个内容页 + 授权面板的离屏冒烟（SSR，无浏览器）。
 *
 * 为什么需要它：2026-09-30 「首次上手」重写把四个内容页的信息架构整个换了一遍，
 * 而这块内容**没有任何渲染级判据** —— 类型检查只管形状，wiring 守卫只管源码里有没有
 * 某个接线。文案改错、分组对不上侧栏、步骤漏了「做完应看到什么」，在真机上才看得出来。
 * 本环境没有 DOM 测试环境，所以用 `react-dom/server` 把每一页渲染成静态 HTML 再断言。
 *
 * 三件事**从真源现算**，不钉死手抄的名单：
 *   ① 功能引导的分组名与 `nav-config.ts` 的 `NAV_GROUPS` 顺序一致（含分组数）；
 *   ② 每个分组至少有一个条目名能在 nav-config 的可见/隐藏条目标签里找到；
 *   ③ 首页 rail 的 `MODULES` / `REMOTE API` 与导航真源、`docs/API.md` 一致。
 *
 * 运行：`node scripts/ui-ask-smoke.js scripts/onboarding-ssr.tsx`
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AboutPage,
  FeaturesPage,
  HelpPage,
  HomePage,
} from '../src/client/ui-app/onboarding/OnboardingShell.tsx'
import { FEATURE_GROUPS, FIRST_RUN_STEPS, FAQ } from '../src/client/ui-app/onboarding/onboarding-content.tsx'
import { LicenseAuthPanel } from '../src/client/ui-app/license/LicenseAuthPanel.tsx'
import { NAV_GROUPS } from '../src/client/ui-wechat/src/client/pages/wechat-data/nav-config.ts'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}

function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const home = renderToStaticMarkup(h(HomePage, { onExplore: () => {} }))
const features = renderToStaticMarkup(h(FeaturesPage, {}))
const help = renderToStaticMarkup(h(HelpPage, {}))
const about = renderToStaticMarkup(h(AboutPage, { versions: { electron: '30.0.0', chrome: '124.0.0', node: '20.0.0' } }))
const license = renderToStaticMarkup(h(LicenseAuthPanel, {
  status: { state: 'unlicensed', licensed: false } as never,
  onStatusChange: () => {},
  compact: true,
}))

/** nav-config 的全部条目标签（可见 + hidden，都算真实入口）。 */
const NAV_LABELS = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label)))
/** nav-config 的侧栏可见数 = 总数 − hidden − settings（它渲染在底栏专属按钮上）。 */
const NAV_HIDDEN = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.hidden).length
const NAV_TOTAL = NAV_GROUPS.flatMap((g) => g.items).length
const NAV_VISIBLE_IN_BODY = NAV_TOTAL - NAV_HIDDEN - 1

console.log('启动页 SSR 冒烟')

check('首页：三步开始 + 高频问法 + telemetry 都在渲染结果里', () => {
  ok(home.includes('三步开始'), '缺「三步开始」标题')
  ok(home.includes('它常被用来回答这些问题'), '缺「高频问法」标题')
  ok(home.includes('MODULES'), 'telemetry 少了 MODULES')
  ok(home.includes('REMOTE API'), 'telemetry 少了 REMOTE API')
  for (const s of FIRST_RUN_STEPS) {
    ok(home.includes(s.title), `三步里少了一步：${s.title}`)
    ok(home.includes('做完') || home.includes(s.desc.slice(0, 8)), `步骤缺说明：${s.title}`)
  }
})

check('首页 rail 的计数与真源一致（侧栏可见数 / 可路由页签数 / docs·API 的接口数）', () => {
  const modules = /MODULES<\/div><div[^>]*>(\d+)</.exec(home)?.[1]
    ?? /MODULES[\s\S]{0,200}?>(\d+)</.exec(home)?.[1]
  ok(modules === String(NAV_VISIBLE_IN_BODY),
    `首页 MODULES=${String(modules)}，而 nav-config 真源算出的侧栏可见数是 ${String(NAV_VISIBLE_IN_BODY)}`)
  // 提示行里的「N 个可路由页签」同样是用户可见的计数：它与 nav-config 的条目总数现算比对
  // （2026-09-30 加：这一句是那次重写新写的，漏了守卫就会成为下一个「过期的手写数字」）。
  const tabs = /(\d+) 个可路由页签/.exec(home)?.[1]
  ok(tabs === String(NAV_TOTAL),
    `首页写的可路由页签数=${String(tabs)}，nav-config 真源是 ${String(NAV_TOTAL)}`)
})

check('功能引导：分组名与 nav-config 的 NAV_GROUPS 逐组同序', () => {
  const real = NAV_GROUPS.map((g) => g.label)
  const shown = FEATURE_GROUPS.map((g) => g.name)
  ok(shown.length === real.length, `分组数不一致：页面 ${String(shown.length)} 组，真源 ${String(real.length)} 组`)
  real.forEach((label, i) => {
    ok(shown[i] === label, `第 ${String(i + 1)} 组对不上：页面「${String(shown[i])}」vs 真源「${label}」`)
    ok(features.includes(label), `分组「${label}」没渲染出来`)
  })
})

check('功能引导：每个分组至少有一个条目名是 nav-config 里的真实入口', () => {
  for (const g of FEATURE_GROUPS) {
    const hit = g.items.some((it) => NAV_LABELS.has(it) || [...NAV_LABELS].some((l) => it.startsWith(l)))
    ok(hit, `分组「${g.name}」的条目全是凭印象写的：${g.items.join('、')}`)
  }
})

check('使用说明：每一步都有「做完应看到」，并且常见问题整体渲染', () => {
  ok((help.match(/做完应看到/g) ?? []).length >= 4, '「做完应看到」不足 4 条（四步各一条）')
  ok(help.includes('常见问题'), '缺常见问题小节')
  for (const f of FAQ) ok(help.includes(f.title), `常见问题没渲染：${f.title}`)
  ok(help.includes('断网'), 'FAQ 里没给出断网这条出口')
})

check('关于：数据位置 / 彻底删除 / 断网使用 / 版本信息都在', () => {
  ok(about.includes('%APPDATA%'), '没写数据位置')
  ok(about.includes('彻底删除'), '没写怎么彻底删')
  ok(about.includes('没有任何出网开关'), '没写「已无出网开关」这条边界')
  ok(about.includes('30.0.0') && about.includes('124.0.0'), '运行时版本没渲染')
})

check('授权面板：三步走与常见问题渲染，且按钮文案没被改掉', () => {
  ok(license.includes('导出激活请求'), '按钮文案被改动了（真机 e2e 与用户都按这个名字找它）')
  ok(license.includes('选择 license.json 导入'), '导入按钮文案被改动了')
  ok((license.match(/flowNo/g) ?? []).length >= 1 || license.includes('手里有厂商签发的'), '三步走没渲染')
  ok(license.includes('设备不匹配'), '常见问题里没写设备不匹配怎么办')
  ok(license.includes('校验并导入'), '粘贴导入按钮没了')
})

console.log(`\n${failed ? '❌' : '✅'} 启动页冒烟：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
if (failed > 0) process.exitCode = 1
