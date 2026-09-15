/**
 * N24：界面开关 ↔ 代码消费者的接线守卫。
 *
 * 起因：`cdn_enabled` / `cdn_local_decrypt`（界面上的「自动获取原图（CDN）」「原图解密方式」）
 * 以及 `api_enabled` / `api_port` / `api_token` 五个键**只有界面与存储、没有任何消费者**：
 * 用户关掉 CDN 开关后取图路径照旧出网，而界面上写着「已关闭」。纯逻辑用例（`cdn-switch.spec.ts`）
 * 证明的是判定函数与 query 层的行为，**证明不了网关有没有把配置传下去** ——
 * 少了这一层，机制再对也是空转（M8/M13 的同一类教训）。
 *
 * 判据用 AST 取**调用点实参**，不扫原始文本：注释里写个 `cdnSwitches()` 骗不过去。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATEWAY = join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts')
const SETTINGS = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'Settings.tsx')
const gatewaySrc = readFileSync(GATEWAY, 'utf8')
const settingsSrc = readFileSync(SETTINGS, 'utf8')

/** 必须把 `cdnSwitches()` 传进去的远端取媒体调用点。 */
const REMOTE_CALL_SITES = [
  'fetchEmoticonRemote',
  'resolveArticleCoverDataUrl',
  'fetchSnsCoverDataUrl',
  'fetchSnsVideoDataUrl',
  'loadSnsVideoBytes',
]

/**
 * 找某个函数名在 gateway 里的**调用点**（注释/字符串里的同名文本不算）。
 * @param name - 被调函数名（`foo(...)` 中的 foo）。
 * @returns 每个调用点的完整源码文本。
 */
function callSiteTexts(src: string, name: string): string[] {
  const sf = ts.createSourceFile('gateway.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const text = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (text === name) out.push(node.getText(sf))
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

/** 取某个类方法的源码文本（用于断言「配置是在这个方法体里读的」）。 */
function methodText(src: string, name: string): string | null {
  const sf = ts.createSourceFile('gateway.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let hit: string | null = null
  const visit = (node: ts.Node): void => {
    if (hit) return
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      hit = node.getText(sf)
      return
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return hit
}

/** 取一段源码里的字符串字面量。 */
function literals(src: string, filename: string): string[] {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

/**
 * 取「与键名有关的标识」：字符串字面量 + **属性赋值名** + **属性访问名**。
 *
 * 为什么不能只看字符串字面量：前端读配置写作 `cachedCfg?.cdn_enabled`（属性访问）、
 * 写回写作 `cdn_enabled: cdnEnabled`（属性赋值名），两处都不是字符串字面量 ——
 * 第一版因此把「界面里有 cdn_enabled」误判成没有。刻意**不含解构绑定名**
 * （`const { api_token: _tok } = c`），那一处是「把密钥从渲染缓存里剥掉」的正常写法。
 * @param src - 源码全文。
 * @param filename - 用于选择解析器。
 * @returns 键名列表（可能重复，调用方自行计数）。
 */
function keyNames(src: string, filename: string): string[] {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const push = (name: ts.Node | undefined): void => {
    if (!name) return
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) out.push(name.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) push(node.name)
    else if (ts.isPropertyAccessExpression(node)) push(node.name)
    else if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('N24：CDN 开关的接线', () => {
  it('cdnSwitches() 真的读了 cdn_enabled / cdn_local_decrypt（在方法体内，不是文件里出现过）', () => {
    const body = methodText(gatewaySrc, 'cdnSwitches')
    expect(body, 'gateway 里没有 cdnSwitches 方法').toBeTruthy()
    const keys = literals(body!, 'gateway.ts')
    expect(keys, 'cdnSwitches 没读 cdn_enabled').toContain('cdn_enabled')
    expect(keys, 'cdnSwitches 没读 cdn_local_decrypt').toContain('cdn_local_decrypt')
  })

  it('每个远端取媒体调用点都把开关实参传了进去', () => {
    for (const name of REMOTE_CALL_SITES) {
      const sites = callSiteTexts(gatewaySrc, name)
      expect(sites.length, `gateway 里找不到 ${name} 的调用点（方法被删或改名？请同步本用例）`).toBeGreaterThan(0)
      for (const site of sites) {
        expect(site, `${name} 的调用点没传 cdnSwitches()：${site.slice(0, 120)}`).toContain('cdnSwitches()')
      }
    }
  })

  it('界面仍然保留两个 CDN 开关（不许用「删掉开关」的方式结掉 N24）', () => {
    const keys = keyNames(settingsSrc, 'Settings.tsx')
    expect(keys).toContain('cdn_enabled')
    expect(keys).toContain('cdn_local_decrypt')
    // 而且它们要出现在保存 patch 里（否则界面读了却存不下去）
    const patch = /apiSaveWechatConfig\(\{[\s\S]*?\}\)/.exec(settingsSrc)?.[0] ?? ''
    expect(patch, '保存 patch 里没有 cdn_enabled').toContain('cdn_enabled')
    expect(patch, '保存 patch 里没有 cdn_local_decrypt').toContain('cdn_local_decrypt')
  })

  it('界面不再暴露 api_enabled / api_port（无服务端的死控件已撤下）', () => {
    const keys = keyNames(settingsSrc, 'Settings.tsx')
    expect(keys, '界面仍在读写 api_enabled').not.toContain('api_enabled')
    expect(keys, '界面仍在读写 api_port').not.toContain('api_port')
    // api_token 只允许留在「不进渲染缓存」的密钥字段清单里（M1），不允许再回表单
    const tokenUses = keys.filter((k) => k === 'api_token')
    expect(tokenUses.length, `api_token 在界面里有 ${tokenUses.length} 处引用，应当只剩缓存剥离那一处`).toBe(1)
    expect(settingsSrc).toContain('SETTINGS_SECRET_FIELDS')
  })

  it('后端字段未被误删（撤下的是界面，不是数据）', () => {
    // 删字段要连带重建 bundle/types 并考虑旧配置兼容，N24 本期不做 —— 这条守住「只撤界面」。
    // 注意路径会随后端的层次调整而变：M24 之后配置实现从 `query/config.ts` 下沉到 `config/`
    // （`query/config.ts` 变成转发门面），所以默认值现在住在 `config/wechat-config.ts`。
    // 这里按「默认值所在的那个文件」找，并断言它真的存在 —— 找不到就让用例红着说明去哪了。
    const candidates = [
      join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'config', 'wechat-config.ts'),
      join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'config.ts'),
    ]
    const withDefaults = candidates.filter((p) => existsSync(p) && readFileSync(p, 'utf8').includes('api_enabled: true'))
    expect(withDefaults.length, '找不到任何一份带默认值的配置文件（M24 之后应在 config/wechat-config.ts）').toBeGreaterThan(0)
    const src = withDefaults.map((p) => readFileSync(p, 'utf8')).join('\n')
    for (const key of ['api_enabled', 'api_port', 'api_token', 'cdn_enabled', 'cdn_local_decrypt']) {
      expect(src, `配置默认值里缺少 ${key}`).toContain(key)
    }
  })
})
