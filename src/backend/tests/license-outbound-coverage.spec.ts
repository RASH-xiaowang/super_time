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
 *   · 接缝 = 隐私闸门 `privacyGate`（2026-09-30 起只剩脱敏 + 审计，不再拦截），
 *     或 LLM 工厂的**实际使用** `makeEmbedFn|makeRerankFn|makeChatAsker`
 *     —— 工厂内部统一过 `privacyGate`，所以「用了工厂」与「直接调闸门」等价；
 *   · `Boolean(this.makeEmbedFn(…))` 只是「配没配向量模型」的能力探测，不发出任何数据，
 *     必须按调用点结构排除，否则 `getKbVectorIndex` 会被冤枉。
 *
 * 用 TS AST 而不是正则：注释与字符串里的同名文本骗不过它。本仓有过前例 ——
 * 正则扫 `privacyBlocked('kb_extract')` 时命中了 `getKnowledgeGraph` 文档注释里的一行，
 * 差点把一个不出网的方法登记进授权档位。
 *
 * 2026-09-30（出网开关全移除）：`privacyBlocked` / `privacyBlockedAt` 已不存在，接缝集合
 * 随之收敛；`extractKbEntities` 之类的调用从「直接过闸」改成「经 `makeChatAsker` 工厂」，
 * 工厂接缝必须一并认，否则出网判据会静默失效。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { gatewaySource } from './gateway-source.ts'
import { grp } from './helpers/strict-index.ts'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATEWAY = join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts')
const requireCjs = createRequire(import.meta.url)

/** 出网但**不是**「把内容交给模型」的方法：拉微信 CDN 的媒体，属数据浏览。
 *  它们不出现在 `privacyGate` / LLM 工厂这条接缝上：要么由**主机白名单**（M23）与
 *  授权档位管，要么是「用户点击才发生」的文件下载 —— 应用内已没有任何出网开关
 *  （`blockOutbound` 于 2026-09-30 整体移除），所以这些方法身上没有应用内闸门可查。 */
const NON_AI_OUTBOUND: Record<string, string> = {
  getSnsVideoDataUrl: '从微信 CDN 取回视频字节，不发内容给模型（只走消息自带的免登录直链 + 主机白名单）',
  getSnsVideoCoverDataUrl: '从微信 CDN 取回封面字节，不发内容给模型（同上，主机白名单）',
  getImageOriginal: '从微信 CDN 取回聊天图片原图字节，不发内容给模型（只走消息自带的免登录直链）',
  fetchOriginalImagesBatch: '批量版同一件事：仍只走消息自带的免登录直链，不发内容给模型（数量大，但性质与 getImageOriginal 完全一致）',
  getRemoteImages: '远程图片代理（M23）：按地址从微信 CDN 白名单主机取图并落盘，不发内容给模型',
  downloadWhisperModel: '从 HuggingFace / hf-mirror 下载语音识别模型**文件**，只在你点击下载时发生，不发内容给模型',
  installWhisperEngine: '从 GitHub releases 下载 whisper.cpp 引擎**压缩包**，只在你点击下载时发生，不发内容给模型',
  downloadLayaModel: '从 HuggingFace 下载本地决策分析模型**文件**（约 1.26 GB），只在你点击下载时发生，不发内容给模型；分析本身跑在本机 onnxruntime 上',
}

const PRIVACY_SEAMS = new Set(['privacyGate'])
/** LLM 工厂入口：工厂内部统一过 `privacyGate`（脱敏 + 审计），所以用了工厂就算出网。 */
const FACTORY_SEAMS = new Set(['makeEmbedFn', 'makeRerankFn', 'makeChatAsker'])

/** 从 `Boolean(this.makeEmbedFn(…))` 这类能力探测里认出「只是问配没配」。 */
function isCapabilityProbe(node: ts.CallExpression): boolean {
  const p = node.parent
  return ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'Boolean'
}

type MethodScan = { name: string; seams: string[] }

/** 方法体里出现 `this.kbRemotes().NAME(` 这类**转发**时，接缝要看被转发到的那份实现。 */
function delegationTarget(bodyText: string): string | null {
  const m = /this\.[A-Za-z_$][\w$]*\(\)\.([A-Za-z_$][\w$]*)\(/.exec(bodyText)
  return m ? grp(m, 1, 'this.xxx().yyy() 委托式') : null
}

/**
 * 扫「搬出去的处理器」：`createXxxRemotes(rc)` 返回的对象字面量里的方法/箭头函数，按名字索引其接缝。
 * M21 把 gateway 的域方法体搬进 `src/backend/wechat-data/src/remotes/*.ts`，网关上只剩签名 + 转发 ——
 * 不跟这一步的话，出网判据会**静默失效**（搬走的方法一个个都不再被视为出网）。
 */
/**
 * 处理器内部再往下委托一层：`async optimizeAskQuestion(…) { return optimizeAskQuestionIn(rc, …) }`
 * ⇒ 接缝还要跟着被委托的那份模块级函数走。
 *
 * 为什么需要：M21 把方法体搬进 `remotes/*.ts` 之后，工厂函数自己受 `function-size-ratchet`
 * 的棘轮管着（只许变小），于是「再搬一次到模块级函数」是同一把结构刀的延续。不跟这一跳，
 * 出网判据会把刚搬走的方法静静算成「不出网」—— 那正是本 spec 存在的理由（W3-6.1 实测踩到）。
 * @param bodyText - 处理器方法体的文本。
 * @returns 被委托的模块级函数名；不是这种形态时 null。
 */
function implDelegationTarget(bodyText: string): string | null {
  const m = /return\s+([A-Za-z_$][\w$]*In)\s*\(\s*rc\s*,/.exec(bodyText)
  return m ? grp(m, 1, 'return xxxIn(rc, …) 委托式') : null
}

function scanImpls(src: string): Map<string, string[]> {
  const sf = ts.createSourceFile('impls.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const impls = new Map<string, string[]>()
  const seamsOf = (root: ts.Node): string[] => {
    const seams: string[] = []
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const callee = n.expression.name.text
        if (PRIVACY_SEAMS.has(callee)) seams.push(callee)
        else if (FACTORY_SEAMS.has(callee) && !isCapabilityProbe(n)) seams.push(callee)
      }
      n.forEachChild(walk)
    }
    walk(root)
    return seams
  }
  /** 模块级函数的接缝（委托的下一跳）。 */
  const moduleFns = new Map<string, string[]>()
  const visitFns = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      moduleFns.set(node.name.text, seamsOf(node.body))
    }
    node.forEachChild(visitFns)
  }
  visitFns(sf)
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      let seams = seamsOf(node)
      const target = implDelegationTarget(node.getText(sf))
      if (target) seams = [...seams, ...(moduleFns.get(target) ?? [])]
      impls.set(node.name.text, seams)
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      let seams = seamsOf(node.initializer)
      const target = implDelegationTarget(node.getText(sf))
      if (target) seams = [...seams, ...(moduleFns.get(target) ?? [])]
      impls.set(node.name.text, seams)
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
            else if (FACTORY_SEAMS.has(callee) && !isCapabilityProbe(n)) seams.push(callee)
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

  it('白名单不许腐烂：列进去的方法必须仍是真实的 @Remote 方法', () => {
    // 2026-09-30 改口径：出网开关全移除后，这 8 个方法身上不再有 `privacyGate` 可查 ——
    // 它们的出网由**主机白名单**（M23）或「用户点击下载」决定，接缝扫描天生看不见。
    // 所以这里守的是「名单没有指向一个被删/改名的方法」：方法没了，这条白名单就是
    // 一份骗人的文档（它仍在替一个不存在的方法声明「这不是 AI 出网」）。
    const remoteNames = new Set([...gatewaySrc.matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))
    for (const name of Object.keys(NON_AI_OUTBOUND)) {
      expect(remoteNames.has(name), `${name} 已不是 @Remote 方法，把 NON_AI_OUTBOUND 里这条删掉`).toBe(true)
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
