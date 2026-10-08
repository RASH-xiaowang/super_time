/**
 * 界面开关 ↔ 代码消费者的接线守卫。
 *
 * 起因：`api_enabled` / `api_port` / `api_token` 这些键曾经**只有界面与存储、没有任何消费者**：
 * 界面上写着开关，取数路径却照旧。纯逻辑用例证明不了网关有没有把配置传下去 ——
 * 少了这一层，机制再对也是空转（M8/M13 的同一类教训）。
 *
 * 2026-09-30：`cdn_enabled` / `cdn_local_decrypt`（「自动获取原图（CDN）」「原图解密方式」）
 * 连同它们的消费者 `cdnSwitches()` 随「移除全部出网开关」一起删除 ——
 * 界面上不再有这两个开关，配置默认值里也不再写这两个键，所以本节不再有与 CDN 有关的判据。
 * 剩下的判据只有一条：界面不许暴露**没有消费者的死控件**（api_enabled / api_port /
 * api_token 这类）。判断依据用 AST 取键名的属性赋值 / 属性访问，注释里写个键名骗不过去。
 *
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SETTINGS_DIR = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')
// M21 拆 Settings ⇒ 读**面板 + 它的拆分模块**的联合（断言一条没改；密钥清单搬到 settings-common 也算数）。
const settingsSrc = readdirSync(SETTINGS_DIR)
  .filter((f) => /^settings-[a-z-]+\.tsx?$/.test(f))
  .concat(['Settings.tsx'])
  .sort()
  .map((f) => readFileSync(join(SETTINGS_DIR, f), 'utf8')).join('\n')

/**
 * 取「与键名有关的标识」：字符串字面量 + **属性赋值名** + **属性访问名**。
 *
 * 为什么不能只看字符串字面量：前端读配置写作 `cachedCfg?.api_port`（属性访问）、
 * 写回写作 `api_port: port`（属性赋值名），两处都不是字符串字面量 ——
 * 第一版因此把「界面里有 api_port」误判成没有。刻意**不含解构绑定名**
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

describe('界面开关的接线：可见的控件必须有消费者', () => {
  it('界面不再暴露 api_enabled / api_port（无服务端的死控件已撤下）', () => {
    const keys = keyNames(settingsSrc, 'Settings.tsx')
    expect(keys, '界面仍在读写 api_enabled').not.toContain('api_enabled')
    expect(keys, '界面仍在读写 api_port').not.toContain('api_port')
    // api_token 只允许留在「不进渲染缓存」的密钥字段清单里（M1），不允许再回表单
    const tokenUses = keys.filter((k) => k === 'api_token')
    expect(tokenUses.length, `api_token 在界面里有 ${tokenUses.length} 处引用，应当只剩缓存剥离那一处`).toBe(1)
    expect(settingsSrc).toContain('SETTINGS_SECRET_FIELDS')
  })

  it('界面不再暴露已删的 CDN 开关（cdn_enabled / cdn_local_decrypt 全链路已移除）', () => {
    const keys = keyNames(settingsSrc, 'Settings.tsx')
    for (const dead of ['cdn_enabled', 'cdn_local_decrypt']) {
      expect(keys, `界面仍在读写已删的出网开关键 ${dead}`).not.toContain(dead)
    }
    for (const dead of ['cdnEnabled', 'cdnLocal', 'toggleCdn', 'apiSetCdnImageEnabled', 'apiSetCdnImageLocalDecrypt']) {
      expect(settingsSrc, `界面仍在引用已删的出网开关符号 ${dead}`).not.toContain(dead)
    }
  })

  it('后端默认值仍保留 api_enabled / api_port / api_token（撤下的是界面，不是数据）', () => {
    // 删字段要连带重建 bundle/types 并考虑旧配置兼容，本期不做 —— 这条守住「只撤界面」。
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
    for (const key of ['api_enabled', 'api_port', 'api_token']) {
      expect(src, `配置默认值里缺少 ${key}`).toContain(key)
    }
    // 已删的出网开关不许留在默认值里（旧配置里多出来的键不再被写入默认值）
    for (const dead of ['cdn_enabled', 'cdn_local_decrypt']) {
      expect(src, `配置默认值里还在写已删的 ${dead}`).not.toContain(dead)
    }
  })
})
