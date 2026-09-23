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
  ok(html.includes('隐私与数据边界'), '缺少标题')
  ok(html.includes(`v${PRIVACY_VERSION}`), `缺少声明版本 v${PRIVACY_VERSION}`)
})

check('四个必读小节都在（数据本机处理 / 内存扫描 / 出网清单 / 你的控制）', () => {
  for (const t of ['数据在本机处理', '只读扫描微信进程内存', '会出网的地方', '你的控制']) {
    ok(html.includes(t), `缺少小节：${t}`)
  }
})

check('出网清单里点明了「没有开关」的那些出网点', () => {
  // 只说「可关闭 AI 出网」会让人以为关掉它就等于完全离线 —— 这里要求页面本身说清楚
  ok(html.includes('无开关'), '没有点明「无开关」的出网点')
  ok(html.includes('AI 问答与总结'), '没有说明 AI 出网')
  ok(html.includes('腾讯图片 CDN') || html.includes('头像'), '没有说明头像出网')
})

check('出网点开关口径与文档一致（图片与头像有开关、只剩地图底图没有）', () => {
  // 这一条守的是一个**犯过的错**：本屏曾把「远程图片/视频/公众号封面」也标成「无开关」，
  // 而 docs/PRIVACY.md 的 D 条与设置里的「自动获取原图（CDN）」都表明它**有**开关。
  // M23 之后「有开关」的范围扩大了：图片、视频与**头像**全部由后端代取，两个开关真的管得到；
  // 反过来，把头像重新标成「无开关」也是错 —— 那会让人以为断网之外还得做点什么。
  //
  // 注意不能用「按 data-switch 切块、再看块里含哪个标签」来配：下面的诚实说明里也点了
  // 那两个标签名，会被算进最后一块。改成按**渲染顺序**对齐（顺序不一致就直接判错位）。
  const kinds = html.split('data-switch="').slice(1).map((c) => c.slice(0, c.indexOf('"')))
  const ORDER = ['AI 问答与总结', 'AI embedding', '头像图片', '远程图片 / 视频 / 公众号封面', '地图底图', '语音模型下载']
  const at = ORDER.map((l) => html.indexOf(`>${l}<`))
  ok(at.every((i) => i > 0), `有出网点标签没渲染出来：${ORDER.filter((_, i) => at[i] < 0).join('、')}`)
  ok(at.every((v, i) => i === 0 || v > at[i - 1]), '出网点渲染顺序与清单不一致，下面的口径断言会错位')
  ok(kinds.length === ORDER.length, `应为 ${ORDER.length} 个出网点，实际 ${kinds.length} 个`)
  const kindOf = Object.fromEntries(ORDER.map((l, i) => [l, kinds[i]]))
  ok(kindOf['头像图片'] === 'toggle', `头像应标为可关闭（后端代取），实际 ${kindOf['头像图片']}`)
  ok(kindOf['地图底图'] === 'none', `地图底图应为无开关，实际 ${kindOf['地图底图']}`)
  ok(kindOf['远程图片 / 视频 / 公众号封面'] === 'toggle', `远程取图应标为可关闭，实际 ${kindOf['远程图片 / 视频 / 公众号封面']}`)
  ok(kindOf['AI 问答与总结'] === 'toggle', `AI 问答与总结应标为可关闭，实际 ${kindOf['AI 问答与总结']}`)
  ok(kinds.filter((k) => k === 'none').length === 1, '无开关的应当且仅当是地图底图这一条')
})

check('重点被单独框出：一句话结论 + 关不掉的那一条 + 完全离线的诚实说明', () => {
  ok(html.includes('一句话结论'), '缺少顶部结论块')
  // 结论里那个「几条没有内置开关」是界面自己算出来的（blocked.length），这里核对的是**它算得对**：
  // 与清单里 data-switch="none" 的颗数一致。写死数字的守则会自己过期（它曾经就是硬写着 2）。
  const noneCount = html.split('data-switch="').slice(1).filter((c) => c.startsWith('none')).length
  ok(html.includes(`${String(noneCount)} 条没有内置开关`), `结论里的「无开关」条数应与清单一致（${String(noneCount)} 条）`)
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
