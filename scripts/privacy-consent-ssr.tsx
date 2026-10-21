/**
 * 隐私同意闸门的离屏冒烟（SSR，无浏览器）。
 *
 * 为什么需要它：H14 的验收里有一条硬要求 ——「首次启动必须显式同意隐私声明后才能进入主界面」。
 * 判定逻辑由 `consent.spec.ts` 覆盖、接线由 AST 守卫覆盖，但那条要求里还有一件
 * **只有真的渲染一次才看得到**的事：按钮在未勾选之前必须是禁用的（否则「显式同意」变成走过场）。
 * 本环境没有浏览器/DOM 测试环境（见 M13/M15 的结论），所以用 react-dom/server 把它渲染成
 * 静态 HTML 来断言渲染事实。
 *
 * 由 `scripts/ui-ask-smoke.js` 负责 bundling 后执行（同一套 esbuild 配置）。
 * 运行：`node scripts/ui-ask-smoke.js scripts/privacy-consent-ssr.tsx`
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PrivacyConsentGate } from '../src/client/ui-app/privacy/PrivacyConsentGate.tsx'
import { PRIVACY_VERSION } from '../src/client/ui-app/privacy/consent.ts'

let passed = 0
let failed = 0

/** 断言块。 */
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

/** 极简断言。 */
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const html = renderToStaticMarkup(h(PrivacyConsentGate, { onAccepted: () => {}, onExit: () => {} }))

console.log('隐私同意闸门 SSR 冒烟')

check('渲染出标题与声明版本', () => {
  // 默认（无 `embedded`）= 声明升版后的**独立整屏**：页头由组件自己给
  // （内嵌启动页那条路径的页头仍由 `StageHead` 提供，见 OnboardingShell 的 consent 站）。
  ok(html.includes('隐私与数据边界'), '缺少标题')
  ok(html.includes('一句话结论'), '缺少两栏布局的标题锚点「一句话结论」')
  ok(html.includes('会出网的地方（逐条）'), '缺少出网清单一节的标题')
  ok(html.includes(`v${PRIVACY_VERSION}`), `缺少声明版本 v${PRIVACY_VERSION}`)
})

check('四个必读小节都在（数据本机处理 / 内存扫描 / 出网清单 / 你的控制）', () => {
  for (const t of ['数据在本机处理', '只读扫描微信进程内存', '会出网的地方', '你的控制']) {
    ok(html.includes(t), `缺少小节：${t}`)
  }
})

check('出网清单里点明了「没有开关」的那些出网点', () => {
  // 只说「可关闭 AI 出网」会让人以为关掉它就等于完全离线 —— 这里要求页面本身说清楚。
  ok(html.includes('无开关'), '没有点明「无开关」的出网点')
  ok(html.includes('仅点击时下载'), '没有点明「仅点击时下载」的那一条')
  ok(html.includes('AI 问答与总结'), '没有说明 AI 出网')
  ok(html.includes('腾讯图片 CDN') || html.includes('头像'), '没有说明头像出网')
  // 2026-10-21（v24）：任务触发从「Webhook / 八爪鱼」扩到多厂商 —— 同意屏必须如实列出
  // 每家厂商的出网主机（固定主机 + 可配置实例地址）与「不发图片 / 实验性」口径。
  ok(html.includes('多家 RPA 厂商'), '没有说明任务触发的多厂商方式')
  for (const host of [
    'api-rpa.bazhuayu.com', 'api.yingdao.com', 'console-rpa.aliyun.com',
    'z-commander-api.ai-indeed.com', 'cloud.uipath.com', 'uipath.com', 'laiye.com',
  ]) {
    ok(html.includes(host), `没有点明 RPA 厂商的出网主机：${host}`)
  }
  ok(html.includes('实例地址'), '没有说明 UiPath / 来也 / 私有化部署用你配置的实例地址')
  ok(html.includes('实验性'), '没有说清阿里云 / 来也 / 实在为实验性接入')
  ok(html.includes('不发图片'), '没有说清 RPA 厂商方式不发图片')
  // 2026-10-21（v25 / 八爪鱼 v1.2.0）：参数改为全部在「附加参数」里显式配置，默认不发业务参数，
  // 同意屏必须点明「附加参数逐条配置 + 默认不发业务参数 + 值来源 + 不含凭据」。
  ok(html.includes('附加参数'), '没有说明八爪鱼参数在「附加参数」中逐条配置')
  ok(html.includes('默认不发业务参数'), '没有说明八爪鱼默认不发业务参数')
  ok(html.includes('自定义模板'), '没有说明附加参数支持自定义模板')
  ok(html.includes('不含凭据'), '没有说清附加参数不含凭据')
})

check('出网点开关口径与文档一致（应用内已无任何出网开关：6 条无开关 + 1 条仅点击时下载）', () => {
  // 2026-09-30：出网开关全部移除。除「语音模型下载」属于显式点击才发生（manual），
  // 其余六个出网点一律没有应用内开关 —— 要断网只能靠系统防火墙或断网。
  // （2026-10-21：新增「任务触发（Webhook / 多家 RPA 厂商）」；它没有应用内开关，
  // 约束是每个任务的触发方式配置 —— 不配置就不发送。）
  //
  // 注意不能用「按 data-switch 切块、再看块里含哪个标签」来配：下面的诚实说明里也点了
  // 那些标签名，会被算进最后一块。改成按**渲染顺序**对齐（顺序不一致就直接判错位）。
  //
  // 2026-10-15：手机端（M0–M4）新增了**入站监听面**（`kind: 'off'`，局域网远程访问）。
  // 它刻意与出网点分开列、**不并进「共 N 个出网点」**（方向相反：本机监听、别的设备连进来）。
  // 所以这里必须只数**出网侧**的两种档位（none / manual），把 off 排除掉 ——
  // 否则这条断言会把入站那条算进来，报「应为 7 个，实际 8 个」。
  const kinds = html.split('data-switch="').slice(1)
    .map((c) => c.slice(0, c.indexOf('"')))
    .filter((k) => k === 'none' || k === 'manual')
  const ORDER = [
    'AI 问答与总结', 'AI embedding', '任务触发（Webhook / 多家 RPA 厂商）', '头像图片',
    '远程图片 / 视频 / 公众号封面', '地图底图', '语音模型下载',
  ]
  /** 唯一一条「仅点击时下载」的出网点；其余出网点都应当是「无开关」。 */
  const MANUAL = '语音模型下载'
  const at = ORDER.map((l) => html.indexOf(`>${l}<`))
  ok(at.every((i) => i > 0), `有出网点标签没渲染出来：${ORDER.filter((_, i) => (at[i] ?? -1) < 0).join('、')}`)
  // 取不到前一项就当 NaN：任何与 NaN 的比较都是 false ⇒ 宁可判错位，不许悄悄放过
  ok(at.every((v, i) => i === 0 || v > (at[i - 1] ?? Number.NaN)), '出网点渲染顺序与清单不一致，下面的口径断言会错位')
  ok(kinds.length === ORDER.length, `应为 ${ORDER.length} 个出网点，实际 ${kinds.length} 个`)
  const kindOf = Object.fromEntries(ORDER.map((l, i) => [l, kinds[i]]))
  ok(kindOf[MANUAL] === 'manual', `${MANUAL}应标为「仅点击时下载」，实际 ${kindOf[MANUAL]}`)
  for (const l of ORDER.filter((l) => l !== MANUAL)) ok(kindOf[l] === 'none', `${l} 应为「无开关」，实际 ${kindOf[l]}`)
  ok(kinds.filter((k) => k === 'none').length === ORDER.length - 1, `无开关的应当且仅当 ${ORDER.length - 1} 条（${MANUAL}除外）`)
  ok(kinds.filter((k) => k === 'manual').length === 1, '「仅点击时下载」的应当且仅当 1 条')
  // 标记文字与 data-switch 同源，这里再按渲染结果数一遍（防「值对但标签写错」）。
  ok((html.match(/>无开关</g) ?? []).length === ORDER.length - 1, `渲染出的「无开关」标记不是 ${ORDER.length - 1} 个`)
  ok((html.match(/>仅点击时下载</g) ?? []).length === 1, '渲染出的「仅点击时下载」标记不是 1 个')
})

check('重点被单独框出：一句话结论 + 那句「没有任何出网开关」+ 完全离线的诚实说明', () => {
  ok(html.includes('一句话结论'), '缺少顶部结论块')
  // 结论块自己说「应用内已没有任何出网开关」——这是全页最容易被误读的一点。
  ok(html.includes('没有任何出网开关'), '结论块没点明「应用内已没有任何出网开关」')
  // 统计行里的条数是界面自己算出来的（blocked.length），这里核对的是**它算得对**：
  // 与清单里 data-switch="none" 的颗数一致。写死数字的守则会自己过期（它曾经就是硬写着 2）。
  const noneCount = html.split('data-switch="').slice(1).filter((c) => c.startsWith('none')).length
  const manualCount = html.split('data-switch="').slice(1).filter((c) => c.startsWith('manual')).length
  ok(/共[\s\S]{0,40}?7[\s\S]{0,40}?个出网点/.test(html), '统计行没写「共 7 个出网点」')
  ok(new RegExp(`${String(noneCount)}[\\s\\S]{0,20}?条无开关`).test(html),
    `统计行里的「无开关」条数应与清单一致（${String(noneCount)} 条）`)
  ok(new RegExp(`${String(manualCount)}[\\s\\S]{0,30}?条只在你要用时发生`).test(html),
    `统计行里的「只在你要用时发生」条数应与清单一致（${String(manualCount)} 条）`)
  ok(html.includes('诚实说明'), '缺少「别把关开关读成完全离线」的说明')
  ok(html.includes('系统防火墙') || html.includes('断网'), '没有给出完全离线的办法')
})

check('未勾选时「同意并继续」是禁用态（显式同意不是走过场）', () => {
  // react-dom/server 会把 disabled 渲染成 disabled=""，这是初始（未勾选）状态的渲染事实
  ok(/<button[^>]*disabled[^>]*>[^<]*同意并继续/.test(html), `未渲染为禁用态：${html.match(/<button[^>]*>同意并继续/)?.[0] ?? '找不到按钮'}`)
  ok(/<input[^>]*type="checkbox"/.test(html), '没有勾选框')
  ok(!/checked=""/.test(html), '初始不应处于已勾选态')
})

check('提供了「不同意」的出口而不是只有同意', () => {
  ok(html.includes('不同意并退出'), '没有不同意路径')
})

check('同意回调只在点击按钮时触发（渲染阶段不调用）', () => {
  // 传进去的是一个会记账的回调：SSR 期间若被调用说明「同意」被提前落地了
  let called = 0
  renderToStaticMarkup(h(PrivacyConsentGate, { onAccepted: () => { called += 1 } }))
  ok(called === 0, `渲染阶段不应调用 onAccepted（实际调用 ${called} 次）`)
})

console.log(`\n${failed ? '❌' : '✅'} 隐私同意闸门冒烟：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
if (failed > 0) process.exitCode = 1
