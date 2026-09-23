// @vitest-environment node
/**
 * M23 接线守卫：卡片缩略图必须**经过后端代理**，而不是把消息里的 https 地址直接交给 `<img>`。
 *
 * 为什么单独立一份（`api-remote-image.spec.ts` 已经测过攒批了）：那边测的是「api 层会不会攒批」，
 * 而这一刀真正的风险在**调用点退回去** —— 只要有人在卡片里再写一次 `<img src={cspSafeSrc(...)}>`，
 * 那张图就又变成渲染层直连：出网开关管不到、不进操作记录、没有缓存，而**全部门禁仍然是绿的**
 * （CSP 的 `https:` 通配还没拿掉，所以它连违规都不会报）。这正是本仓反复踩过的「只测下层、
 * 不测接线」的缺口，所以这里钉的是 JSX 本身。
 *
 * 判据用 TypeScript 的 AST，只认真实 JSX 元素与 import 绑定 —— 注释里写一句 `<RemoteImg`、
 * 或字符串里出现 `getRemoteImages` 都不算数（M12 / N19 / N20 / N23 同一族教训）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const CARDS = join(HERE, 'chats-cards.tsx')
const REMOTE_IMG = join(HERE, 'remote-img.tsx')
const API_MEDIA = join(HERE, '..', 'api-media.ts')

function parse(file: string): { src: ts.SourceFile; text: string } {
  const text = readFileSync(file, 'utf8')
  return { src: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), text }
}

/** 收集 JSX 标签名（开标签与自闭合都算），以及「这个文件里某个名字是不是 import 进来的绑定」。 */
function jsxNames(file: string): { tags: string[]; imported: string[] } {
  const { src } = parse(file)
  const tags: string[] = []
  const imported: string[] = []
  // 去重遍历：这几条断言量的都是「有几颗」，同一节点被交两次就会翻倍。
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tags.push(node.tagName.getText(src))
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      const named = node.importClause.namedBindings
      if (named && ts.isNamedImports(named)) {
        for (const e of named.elements) imported.push(e.name.text)
      }
    }
    node.forEachChild(visit)
  }
  visit(src)
  return { tags, imported }
}

describe('M23：卡片缩略图走后端代理', () => {
  it('chats-cards.tsx 里已经没有直连的 <img>，11 处都是 RemoteImg', () => {
    const { tags, imported } = jsxNames(CARDS)
    expect(tags.filter((t) => t === 'img'), '又有 <img> 直接吃消息里的地址了').toEqual([])
    expect(imported, 'RemoteImg 没有被 import（写了标签名也不算接上）').toContain('RemoteImg')
    const used = tags.filter((t) => t === 'RemoteImg').length
    expect(used, `RemoteImg 只用了几处：${String(used)}`).toBeGreaterThanOrEqual(11)
  })

  it('RemoteImg 自己只在需要时才发代理请求，本地地址走同步分支', () => {
    const { src, text } = parse(REMOTE_IMG)
    let calls: string[] = []
    const seen = new Set<ts.Node>()
    const visit = (node: ts.Node): void => {
      if (seen.has(node)) return
      seen.add(node)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text)
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) calls.push('#jsx:' + node.tagName.getText(src))
      node.forEachChild(visit)
    }
    visit(src)
    // 组件里只允许一颗原生 `<img>`（渲染出口）：多一颗就意味着有第二条绕过代理的画图路径
    expect(calls.filter((c) => c === '#jsx:img').length, 'RemoteImg 里的原生 <img> 数量不等于 1').toBe(1)
    expect(calls).toContain('apiGetRemoteImageUrl')
    expect(/data:\|blob:\|file:/.test(text), '本地地址要有同步分支，否则每张 data URL 都白跑一次 RPC').toBe(true)
  })

  it('api 层的代理走批量 RPC，一次一张的入口不存在', () => {
    const { src } = parse(API_MEDIA)
    const rpc: string[] = []
    const seen = new Set<ts.Node>()
    const visit = (node: ts.Node): void => {
      if (seen.has(node)) return
      seen.add(node)
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && /^(get|set)[A-Z]/.test(node.name.text)) {
        rpc.push(node.name.text)
      }
      node.forEachChild(visit)
    }
    visit(src)
    expect(rpc).toContain('getRemoteImages')
    expect(rpc, '不许存在「一次一张」的代理 RPC：那会绕开攒批，一屏就是 N 次跨进程调用').not.toContain('getRemoteImage')
  })
})
