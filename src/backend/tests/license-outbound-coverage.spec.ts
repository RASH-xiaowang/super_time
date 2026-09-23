/**
 * 出网方法必须登记 license 功能位。
 *
 * 起因：`METHOD_FEATURE` 漏登记时，`authorizeCall` 的默认分支回落到 `wechat-data` 最低档
 * （`service.js` 的 `|| 'wechat-data'`）—— 只买了「数据浏览」的授权反而能把聊天正文、
 * 知识库正文交给第三方模型。这是 fail-closed 的**方向反了**：本该更严，实际更松，
 * 而且不出声。2026-09-20 用本文件的判据查出 4 个（runSummaryTask / buildKbVectorIndex /
 * buildRagVectorIndex / searchKb），此前只有注释里写着「漏登记后果是反的」。
 *
 * 判据取自 `gateway.ts` 自身，不维护第二份人工名单：
 *   · 按 `@Remote` 装饰器切出每个方法的范围，只在**方法体内**找接缝；
 *   · 接缝 = 隐私闸门 `privacyBlocked|privacyGate`，或嵌入/重排函数的**实际使用**
 *     `makeEmbedFn|makeRerankFn`；
 *   · `Boolean(this.makeEmbedFn(…))` 只是「配没配向量模型」的能力探测，不发出任何数据，
 *     必须按调用点结构排除，否则 `getKbVectorIndex` 会被冤枉。
 *
 * 用 TS AST 而不是正则：注释与字符串里的同名文本骗不过它。本仓有过前例 ——
 * 正则扫 `privacyBlocked('kb_extract')` 时命中了 `getKnowledgeGraph` 文档注释里的一行，
 * 差点把一个不出网的方法登记进授权档位。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { gatewaySource } from './gateway-source.ts'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATEWAY = join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts')
const requireCjs = createRequire(import.meta.url)

/** 出网但**不是**「把内容交给模型」的方法：拉微信 CDN 的媒体，属数据浏览。
 *  它们由隐私开关（`sns_video_fetch` / `sns_cover_fetch`）单独管，与 license 档位无关。 */
const NON_AI_OUTBOUND: Record<string, string> = {
  getSnsVideoDataUrl: '从微信 CDN 取回视频字节，不发内容给模型',
  getSnsVideoCoverDataUrl: '从微信 CDN 取回封面字节，不发内容给模型',
  getImageOriginal: '从微信 CDN 取回聊天图片原图字节，不发内容给模型（只走消息自带的免登录直链）',
  getRemoteImages: '远程图片代理（M23）：按地址从微信 CDN 白名单主机取图并落盘，不发内容给模型',
}

const PRIVACY_SEAMS = new Set(['privacyBlocked', 'privacyGate'])
const EMBED_SEAMS = new Set(['makeEmbedFn', 'makeRerankFn'])

/** 从 `Boolean(this.makeEmbedFn(…))` 这类能力探测里认出「只是问配没配」。 */
function isCapabilityProbe(node: ts.CallExpression): boolean {
  const p = node.parent
  return ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'Boolean'
}

type MethodScan = { name: string; seams: string[] }

/** 方法体里出现 `this.kbRemotes().NAME(` 这类**转发**时，接缝要看被转发到的那份实现。 */
function delegationTarget(bodyText: string): string | null {
  const m = /this\.[A-Za-z_$][\w$]*\(\)\.([A-Za-z_$][\w$]*)\(/.exec(bodyText)
  return m ? m[1] : null
}

/**
 * 扫「搬出去的处理器」：`createXxxRemotes(rc)` 返回的对象字面量里的方法/箭头函数，按名字索引其接缝。
 * M21 把 gateway 的域方法体搬进 `src/backend/wechat-data/src/remotes/*.ts`，网关上只剩签名 + 转发 ——
 * 不跟这一步的话，出网判据会**静默失效**（搬走的方法一个个都不再被视为出网）。
 */
function scanImpls(src: string): Map<string, string[]> {
  const sf = ts.createSourceFile('impls.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const impls = new Map<string, string[]>()
  const seamsOf = (root: ts.Node): string[] => {
    const seams: string[] = []
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const callee = n.expression.name.text
        if (PRIVACY_SEAMS.has(callee)) seams.push(callee)
        else if (EMBED_SEAMS.has(callee) && !isCapabilityProbe(n)) seams.push(callee)
      }
      n.forEachChild(walk)
    }
    walk(root)
    return seams
  }
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      impls.set(node.name.text, seamsOf(node))
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      impls.set(node.name.text, seamsOf(node.initializer))
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return impls
}

function scanGateway(src: string, impls: Map<string, string[]>): { methods: MethodScan[]; decoratedCount: number } {
  const sf = ts.createSourceFile('gateway.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const methods: MethodScan[] = []
  let decoratedCount = 0

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []
      const remote = decorators
        .map((d) => d.expression)
        .find((e): e is ts.CallExpression =>
          ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Remote')
      const arg = remote?.arguments[0]
      if (remote && arg && ts.isStringLiteral(arg)) {
        decoratedCount++
        const seams: string[] = []
        const walkBody = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const callee = n.expression.name.text
            if (PRIVACY_SEAMS.has(callee)) seams.push(callee)
            else if (EMBED_SEAMS.has(callee) && !isCapabilityProbe(n)) seams.push(callee)
          }
          n.forEachChild(walkBody)
        }
        if (node.body) walkBody(node.body)
        // 转发形态：方法体只有 `return this.kbRemotes().NAME(…)` ⇒ 接缝取被转发实现的
        if (node.body) {
          const target = delegationTarget(node.body.getText(sf))
          if (target) seams.push(...(impls.get(target) ?? []))
        }
        if (seams.length > 0) methods.push({ name: arg.text, seams })
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return { methods, decoratedCount }
}

// M21：方法面拆成多层壳、@Remote 方法体在 remotes/ ⇒ 读「类 + 域处理器」的联合（断言未改）
const gatewaySrc = gatewaySource()
const { methods: outbound, decoratedCount } = scanGateway(gatewaySrc, scanImpls(gatewaySrc))
const outboundNames = new Set(outbound.map((m) => m.name))
const service = requireCjs(join(ROOT, 'src', 'license', 'service.js')) as {
  METHOD_FEATURE: Record<string, string>
}
const registered = new Set(Object.keys(service.METHOD_FEATURE))

describe('出网方法必须登记 license 功能位', () => {
  it('解析没漏方法（防空转）：装饰器数量与源码里的 @Remote 字面量一致', () => {
    const raw = [...gatewaySrc.matchAll(/@Remote\('/g)].length
    expect(decoratedCount, 'AST 解析出的 @Remote 方法数与源码文本对不上').toBe(raw)
    expect(raw).toBeGreaterThan(100)
  })

  it('每个出网方法要么登记了功能位，要么在白名单里写明理由', () => {
    const unregistered = outbound
      .filter((m) => !registered.has(m.name) && !(m.name in NON_AI_OUTBOUND))
      .map((m) => `${m.name}（接缝：${[...new Set(m.seams)].join(', ')}）`)
    expect(
      unregistered,
      '这些方法会出网但没登记功能位 —— 会回落到 wechat-data 最低档，' +
        `只买数据浏览的授权就能调它们出网。要修的是 METHOD_FEATURE（src/license/service.js），` +
        `不是这份用例：\n  ${unregistered.join('\n  ')}`,
    ).toEqual([])
  })

  it('白名单不许腐烂：列进去的方法必须仍然带接缝', () => {
    for (const name of Object.keys(NON_AI_OUTBOUND)) {
      expect(outboundNames.has(name), `${name} 已不出网，把 NON_AI_OUTBOUND 里这条删掉`).toBe(true)
    }
  })

  it('METHOD_FEATURE 里没有陈旧条目（登记了但已不是 @Remote 方法）', () => {
    const remoteNames = new Set([...gatewaySrc.matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))
    const stale = [...registered].filter((r) => !remoteNames.has(r))
    expect(stale, `这些功能位登记指向不存在的方法：${stale.join(', ')}`).toEqual([])
  })

  it('判据真的在工作（防空转）：已知出网方法与刚补的 4 个都在集合里', () => {
    // 少于 10 个说明扫描逻辑已经失效，上面几条会变成恒真。
    expect(outbound.length).toBeGreaterThanOrEqual(10)
    for (const name of [
      'askWechat', 'generateDailySummary', 'generatePeriodSummary', 'optimizeAskQuestion',
      'extractKbEntities', 'suggestKbLinks', 'summarizeKbFile',
      'runSummaryTask', 'buildKbVectorIndex', 'buildRagVectorIndex', 'searchKb',
    ]) {
      expect(outboundNames.has(name), `${name} 应当被判为出网方法`).toBe(true)
      expect(registered.has(name), `${name} 应当已登记功能位`).toBe(true)
    }
  })

  it('能力探测不算出网：getKbVectorIndex 只报「配没配向量模型」', () => {
    expect(outboundNames.has('getKbVectorIndex'), 'Boolean(this.makeEmbedFn(…)) 是探测，不该判为出网').toBe(false)
  })
})
