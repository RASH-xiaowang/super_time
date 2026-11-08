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
const outboundStart = html.indexOf('会出网的地方（逐条）')
const inboundStart = html.indexOf('会被连进来的地方（入站）')
const outboundHtml = outboundStart >= 0 && inboundStart > outboundStart
  ? html.slice(outboundStart, inboundStart)
  : ''

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
  // 每家厂商的出网主机（固定主机 + 可配置实例地址）与「实验性」口径。
  ok(html.includes('多家 RPA 厂商'), '没有说明任务触发的多厂商方式')
  for (const host of [
    'api-rpa.bazhuayu.com', 'mcp-rpa.bazhuayu.com', 'api.yingdao.com', 'console-rpa.aliyun.com',
    'z-commander-api.ai-indeed.com', 'cloud.uipath.com', 'uipath.com', 'laiye.com',
  ]) {
    ok(html.includes(host), `没有点明 RPA 厂商的出网主机：${host}`)
  }
  ok(html.includes('实例地址'), '没有说明 UiPath / 来也 / 私有化部署用你配置的实例地址')
  ok(html.includes('实验性'), '没有说清阿里云 / 来也 / 实在为实验性接入')
  ok(html.includes('八爪鱼 RPA（MCP）'), '没有说明八爪鱼 MCP 这条实验性通道')
  ok(html.includes('消息列表回复投递'), '没有说明消息列表的下游回复投递')
  ok(html.includes('task_callback'), '没有说明消息列表文本会过隐私闸')
  // 2026-10-23（v29）：所有 RPA 厂商默认不发业务参数；图片仅在显式配置三类来源后发直链。
  // 必须同时说明默认边界、三种来源和取图所需的局域网监听面，不能只写“可发图片”。
  ok(html.includes('默认都不发业务参数'), '没有说清 RPA 厂商默认不发业务参数')
  ok(
    html.includes('imagesJson / imageCount / firstImageUrl'),
    '没有说明三种图片类参数来源',
  )
  ok(html.includes('短时签名直链'), '没有说明图片通过短时签名直链传递')
  ok(html.includes('局域网访问'), '没有说明机器人取图需要打开局域网访问')
  // 2026-10-23（v29）：全部 RPA 厂商统一在「附加参数」里显式配置，默认不发业务参数。
  ok(html.includes('附加参数'), '没有说明参数在「附加参数」中逐条配置')
  ok(html.includes('默认不发业务参数'), '没有说明默认不发业务参数')
  ok(html.includes('自定义模板'), '没有说明附加参数支持自定义模板')
  ok(html.includes('不含凭据'), '没有说清附加参数不含凭据')
  // 2026-10-21（v26）：凭据「眼睛」按需回读 —— 仅桌面端本机，手机 / 浏览器不可调用。
  ok(html.includes('点眼睛查看'), '没有说明桌面端本机可点眼睛查看已保存凭据')
  ok(html.includes('手机/浏览器不可调用'), '没有说清手机 / 浏览器不可调用凭据回读')
})

check('出网点开关口径与文档一致（7 条无开关 + 1 条仅点击时下载 + 1 条默认关闭可关）', () => {
  // 2026-09-30：全局出网开关全部移除。除「语音模型下载」属于显式点击才发生（manual），
  // 其余出网点没有全局开关；2026-10-30（v32）新增的「AI回复」是出网侧的 off 档
  // （默认关闭、按单聊开启）。要断网仍只能靠系统防火墙或断网。
  // （2026-10-21：新增「任务触发（Webhook / 多家 RPA 厂商）」；它没有应用内开关，
  // 约束是每个任务的触发方式配置 —— 不配置就不发送。）
  //
  // 注意不能用「按 data-switch 切块、再看块里含哪个标签」来配：下面的诚实说明里也点了
  // 那些标签名，会被算进最后一块。改成按**渲染顺序**对齐（顺序不一致就直接判错位）。
  //
  // 2026-10-15：手机端（M0–M4）新增了**入站监听面**（`kind: 'off'`，局域网远程访问）。
  // 它刻意与出网点分开列、**不并进「共 N 个出网点」**（方向相反：本机监听、别的设备连进来）。
  // 因此解析时必须先截出「出网」到「入站」之间的片段；否则入站的两条 off 会把总数算多。
  ok(outboundStart >= 0 && inboundStart > outboundStart, '无法定位出网清单与入站清单的边界')
  const kinds = outboundHtml.split('data-switch="').slice(1)
    .map((c) => c.slice(0, c.indexOf('"')))
    .filter((k) => k === 'none' || k === 'manual' || k === 'off')
  const ORDER = [
    'AI 问答与总结', 'AI embedding', '任务触发（Webhook / 多家 RPA 厂商）',
    '消息列表回复投递', 'AI回复', '头像图片', '远程图片 / 视频 / 公众号封面', '地图底图', '语音模型下载',
  ]
  /** 唯一一条「仅点击时下载」的出网点；其余出网点都应当是「无开关」。 */
  const MANUAL = '语音模型下载'
  /** 默认关闭、按单聊开启的出网点。 */
  const OFF = 'AI回复'
  const at = ORDER.map((l) => outboundHtml.indexOf(`>${l}<`))
  ok(at.every((i) => i > 0), `有出网点标签没渲染出来：${ORDER.filter((_, i) => (at[i] ?? -1) < 0).join('、')}`)
  // 取不到前一项就当 NaN：任何与 NaN 的比较都是 false ⇒ 宁可判错位，不许悄悄放过
  ok(at.every((v, i) => i === 0 || v > (at[i - 1] ?? Number.NaN)), '出网点渲染顺序与清单不一致，下面的口径断言会错位')
  ok(kinds.length === ORDER.length, `应为 ${ORDER.length} 个出网点，实际 ${kinds.length} 个`)
  const kindOf = Object.fromEntries(ORDER.map((l, i) => [l, kinds[i]]))
  ok(kindOf[MANUAL] === 'manual', `${MANUAL}应标为「仅点击时下载」，实际 ${kindOf[MANUAL]}`)
  ok(kindOf[OFF] === 'off', `${OFF}应标为「默认关闭 · 可关」，实际 ${kindOf[OFF]}`)
  for (const l of ORDER.filter((l) => l !== MANUAL && l !== OFF)) {
    ok(kindOf[l] === 'none', `${l} 应为「无开关」，实际 ${kindOf[l]}`)
  }
  ok(kinds.filter((k) => k === 'none').length === ORDER.length - 2, `无开关的应当且仅当 ${ORDER.length - 2} 条（${MANUAL}、${OFF}除外）`)
  ok(kinds.filter((k) => k === 'manual').length === 1, '「仅点击时下载」的应当且仅当 1 条')
  ok(kinds.filter((k) => k === 'off').length === 1, '「默认关闭 · 可关」的出网点应当且仅当 1 条')
  // 标记文字与 data-switch 同源，这里再按渲染结果数一遍（防「值对但标签写错」）。
  ok((outboundHtml.match(/>无开关</g) ?? []).length === ORDER.length - 2, `渲染出的「无开关」标记不是 ${ORDER.length - 2} 个`)
  ok((outboundHtml.match(/>仅点击时下载</g) ?? []).length === 1, '渲染出的「仅点击时下载」标记不是 1 个')
  ok((outboundHtml.match(/>默认关闭 · 可关</g) ?? []).length === 1, '渲染出的「默认关闭 · 可关」出网标记不是 1 个')
})

check('重点被单独框出：一句话结论 + 那句「没有全局出网开关」+ 完全离线的诚实说明', () => {
  ok(html.includes('一句话结论'), '缺少顶部结论块')
  // 结论块自己说「应用内没有全局出网开关」——这是全页最容易被误读的一点。
  ok(html.includes('没有全局出网开关'), '结论块没点明「应用内没有全局出网开关」')
  // 统计行里的条数是界面自己算出来的（blocked.length），这里核对的是**它算得对**：
  // 与清单里 data-switch="none" 的颗数一致。写死数字的守则会自己过期（它曾经就是硬写着 2）。
  const noneCount = outboundHtml.split('data-switch="').slice(1).filter((c) => c.startsWith('none')).length
  const nonNoneCount = outboundHtml.split('data-switch="').slice(1)
    .filter((c) => c.startsWith('manual') || c.startsWith('off')).length
  const totalCount = noneCount + nonNoneCount
  ok(new RegExp(`共[\\s\\S]{0,40}?${String(totalCount)}[\\s\\S]{0,40}?个出网点`).test(outboundHtml),
    `统计行没写「共 ${totalCount} 个出网点」`)
  ok(new RegExp(`${String(noneCount)}[\\s\\S]{0,20}?条无开关`).test(outboundHtml),
    `统计行里的「无开关」条数应与清单一致（${String(noneCount)} 条）`)
  ok(new RegExp(`${String(nonNoneCount)}[\\s\\S]{0,30}?条只在你要用时发生`).test(outboundHtml),
    `统计行里的「只在你要用时发生」条数应与出网侧非 none 档一致（${String(nonNoneCount)} 条）`)
  ok(html.includes('诚实说明'), '缺少「别把关开关读成完全离线」的说明')
  ok(html.includes('系统防火墙') || html.includes('断网'), '没有给出完全离线的办法')
})

check('入站清单单列局域网消息 Webhook，并说明令牌与明文 HTTP 边界', () => {
  ok(html.includes('消息列表局域网 Webhook'), '没有列出消息列表入站 Webhook')
  ok(html.includes('/api/message-webhook/'), '没有写明入站路由')
  ok(html.includes('完整 Webhook 地址等同于写入凭据'), '没有说明路径地址即写入凭据')
  ok(html.includes('轮换令牌'), '没有说明轮换令牌会失效')
  ok(html.includes('明文 HTTP'), '没有说明链路仍是明文 HTTP')
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
