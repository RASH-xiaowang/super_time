/**
 * 「设置 → 远程访问（手机）」的接线判据。
 *
 * ## 为什么这一节特别需要接线守卫
 *
 * 它是本机**唯一入站暴露面**的开关。这一节的失效方式全部是静默的，而且都朝危险方向失效：
 *   · 卡片写了但没挂进 Settings ⇒ 用户找不到开关，只能去手工编辑 `config.json`
 *     （而 N24 的教训正是「界面上的开关比没有开关更容易误导」—— 反过来，
 *     代码里的行为没有界面开关同样糟糕：用户不知道自己开着什么）；
 *   · 导航目录里没有这一节 ⇒ 卡片在页面里但滚不到、点不到；
 *   · 二维码另写一个编码器 ⇒ 与 `clawbot-qr.ts` 那份（有黄金向量校验的）分家，
 *     手机扫不出来时没人知道是哪一份坏了；
 *   · **令牌明文常驻界面** ⇒ 投屏 / 截图 / 远程协助时等于交出全部聊天记录的钥匙。
 *     口径必须是「只在刚生成的那一刻显示一次，之后只剩掩码」。
 *
 * 判据一律走源码结构（AST 或精确文本），不做模糊匹配。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 本 spec 在 `src/client/ui-wechat/src/client/pages/wechat-data/panels/`，上溯 **8** 级到仓库根。 */
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')

const card = read(HERE, 'settings-remote-access.tsx')
const settings = read(HERE, 'Settings.tsx')
const state = read(HERE, 'settings-state.tsx')
const preload = read(join(ROOT, 'preload.js'))
const main = read(join(ROOT, 'main.js'))

/** 收集真实的调用表达式名（`a.b(…)` → `a.b`，`f(…)` → `f`）。注释与字符串里的都不算。 */
function callNames(src: string, file = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const t = node.expression
      if (ts.isIdentifier(t)) out.push(t.text)
      else if (ts.isPropertyAccessExpression(t)) out.push(t.getText(sf))
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('卡片挂进了设置面板与导航目录', () => {
  it('Settings.tsx 引入并渲染了它（少这一条，卡片就是死代码）', () => {
    expect(settings, 'Settings.tsx 没有引入远程访问卡片').toMatch(/from '\.\/settings-remote-access\.tsx'/)
    expect(settings, 'Settings.tsx 没有渲染远程访问卡片').toContain('<SettingsRemoteAccess />')
  })

  it('导航目录里有这一节，且与「数据边界与出网」同组（出站与入站是同一类问题）', () => {
    expect(state, "NavKey 的联合类型里没有 'remote'").toMatch(/\|\s*'ai'\s*\|\s*'boundary'\s*\|\s*'remote'/)
    expect(state, '导航条目里没有远程访问这一节').toMatch(/key:\s*'remote'/)
    // 组名要与 boundary 一致，否则目录里它会孤零零地另起一组
    const at = state.indexOf("key: 'remote'")
    const block = state.slice(Math.max(0, at - 400), at + 400)
    expect(block, "远程访问没有排在「智能与隐私」组里").toContain("group: '智能与隐私'")
    expect(state, '导航条目的副标题没写清「默认关闭」（这是这一节最要紧的事实）')
      .toContain('默认关闭')
  })

  it('卡片自己带 data-settings-section（滚动定位与目录高亮都靠它）', () => {
    expect(card).toContain('data-settings-section="remote"')
  })
})

describe('复用而不是另造：二维码走 clawbot-qr', () => {
  it('用的是仓里那份有黄金向量校验的编码器', () => {
    expect(card, '没有复用 clawbot-qr 的编码器（另写一份 = 扫不出来时没人知道是哪份坏了）')
      .toMatch(/from '\.\/clawbot-qr\.ts'/)
    const calls = callNames(card)
    expect(calls, '没有调用 encodeQr').toContain('encodeQr')
    expect(calls, '没有调用 qrSvgPath').toContain('qrSvgPath')
  })

  it('编码失败要给出原因，并且仍然给出手输链接（二维码不是唯一入口）', () => {
    expect(card, '二维码失败时没有兜底的手输链接').toMatch(/catch \(e\)/)
    expect(card).toContain('二维码生成失败')
    // 链接本体与二维码是分开渲染的：码画不出来，链接还在
    expect(card).toContain('{qr.url}')
  })
})

describe('令牌口径：明文只显示一次，常驻界面的是掩码', () => {
  it('事实表里显示的是掩码字段，不是令牌原文', () => {
    expect(card, '事实表里没有显示令牌掩码').toContain('state.tokenMasked')
    // 令牌原文只允许来自 rotate() 的返回值（一次性），不许从状态查询里取
    expect(card, '卡片里出现了一个「随时能读出明文令牌」的入口')
      .not.toMatch(/value\?\.\s*token(?!Masked)/)
  })

  it('明文令牌只活在 one-time 的二维码块里，且界面上写清了「只显示一次」', () => {
    expect(card).toContain('只在这次生成后显示')
    expect(card, '没有提示「再看一次要轮换令牌」—— 用户会以为界面坏了')
      .toContain('轮换令牌')
  })

  it('关掉开关时作废二维码（服务都不监听了，留一个能扫的码只会让人以为还开着）', () => {
    expect(card, '关闭后没有清掉二维码').toMatch(/if \(!next\) setQr\(null\)/)
  })
})

describe('桥接：三个动作都接上了，且浏览器态整块不渲染', () => {
  it('卡片调用了 state / rotate / toggle 三条', () => {
    const calls = callNames(card)
    for (const m of ['api.state', 'api.rotate', 'api.toggle']) {
      expect(calls, `卡片没有调用 ${m}`).toContain(m)
    }
  })

  it('preload 暴露了这四条通道（少一条界面上就是个点了没反应的按钮）', () => {
    for (const ch of ['remote-access:state', 'remote-access:apply', 'remote-access:rotate', 'remote-access:toggle']) {
      expect(preload, `preload 没有暴露 ${ch}`).toContain(ch)
    }
  })

  it('main.js 注册了这四条，并且控制面走的是 createRemoteAccessControl', () => {
    for (const ch of ['remote-access:state', 'remote-access:apply', 'remote-access:rotate', 'remote-access:toggle']) {
      expect(main, `main.js 没有注册 ${ch}`).toContain(`'${ch}'`)
    }
    expect(main, 'main.js 没有用控制面模块（轮换/开关的逻辑不该写在 main.js 里）')
      .toContain('createRemoteAccessControl')
    // 写配置必须经后端（原子写 + 备份 + 密钥分流进 secrets.json 都在那一份实现里）
    const control = read(join(ROOT, 'src', 'backend', 'http-control.js'))
    expect(control, '控制面没有走 saveWechatConfig（自己写文件会把令牌留在 config.json 里）')
      .toContain("'saveWechatConfig'")
  })

  it('浏览器态整块不渲染（在手机上配置「电脑怎么被手机访问」没有意义）', () => {
    expect(card, '没有桥时卡片仍然渲染（会出一屏点了没反应的按钮）')
      .toMatch(/if \(!api\) return <React\.Fragment \/>/)
  })
})

describe('如实告知：防火墙与明文 HTTP 这两条不能从界面上消失', () => {
  it('写了「防火墙弹窗点了取消就连不上」与手动放行命令', () => {
    expect(card).toContain('netsh advfirewall firewall add rule')
    expect(card, '没有说清「同一个 Wi-Fi」这个前提').toContain('同一个 Wi-Fi')
  })

  it('写明这条链路是明文 HTTP、无 TLS，并指向隐私声明第四节 H', () => {
    expect(card, '界面上没有如实说明明文 HTTP 的代价').toContain('明文 HTTP')
    expect(card).toContain('PRIVACY.md')
    expect(card, '没有指向第四节 H').toContain('第四节 H')
  })

  it('写清了「白名单之外不开放」，免得用户以为手机与桌面等价', () => {
    expect(card).toContain('白名单')
    expect(card, '没有点名哪些能力不开放').toContain('API Key')
  })
})
