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

/** 收集 JSX 标签名（开标签与自闭合都算）、import 绑定，以及每个元素的属性名。 */
function jsxNames(file: string): { tags: string[]; imported: string[]; elements: Array<{ tag: string; attrs: string[] }> } {
  const { src } = parse(file)
  const tags: string[] = []
  const imported: string[] = []
  const elements: Array<{ tag: string; attrs: string[] }> = []
  // 去重遍历：这几条断言量的都是「有几颗」，同一节点被交两次就会翻倍。
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(src)
      tags.push(tag)
      elements.push({
        tag,
        attrs: node.attributes.properties.map((p) => (ts.isJsxAttribute(p) ? p.name.getText(src) : '#spread')),
      })
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
  return { tags, imported, elements }
}

describe('M23：卡片缩略图走后端代理', () => {
  it('chats-cards.tsx 里已经没有直连的 <img>，11 处都是 RemoteImg', () => {
    const { tags, imported } = jsxNames(CARDS)
    expect(tags.filter((t) => t === 'img'), '又有 <img> 直接吃消息里的地址了').toEqual([])
    expect(imported, 'RemoteImg 没有被 import（写了标签名也不算接上）').toContain('RemoteImg')
    const used = tags.filter((t) => t === 'RemoteImg').length
    expect(used, `RemoteImg 只用了几处：${String(used)}`).toBeGreaterThanOrEqual(11)
  })

  /**
   * 朋友圈的每一张图（九宫格、封面、视频封面与 `<video poster>`、灯箱、缩略图条、评论图）。
   *
   * 这里之所以连 `<video>` 的 `poster` 一起管：`poster` 是一次**图片请求**，归 CSP 的
   * `img-src` 管，不归 `media-src`。视频本体是后端给的 data URL（`media-src` 里有 `data:`），
   * 但 poster 若继续吃 CDN 地址，收紧 `img-src` 之后就会变成「视频能放、封面不出」。
   */
  for (const [file, minUses] of [['moments-card.tsx', 4], ['moments-portals.tsx', 5]] as const) {
    it(`${file}：没有直连 <img>，poster 只接受本机地址`, () => {
      const { tags, imported } = jsxNames(join(HERE, file))
      expect(tags.filter((t) => t === 'img'), `${file} 里又有直连 <img> 了`).toEqual([])
      expect(imported, `${file} 没 import RemoteImg`).toContain('RemoteImg')
      expect(tags.filter((t) => t === 'RemoteImg').length, `${file} 用了几个 RemoteImg`).toBeGreaterThanOrEqual(minUses)
      const text = readFileSync(join(HERE, file), 'utf8')
      const posters = [...text.matchAll(/poster=\{([^}]*)\}/g)].map((m) => m[1]?.trim() ?? '')
      expect(posters.length, `${file} 里没有 poster 属性？前提不成立`).toBeGreaterThan(0)
      for (const p of posters) {
        expect(p, `${file} 的 poster 又不是只给本机地址：poster={${p}}`).toMatch(/^localImageSrc\(/)
      }
      // 远程地址不许再原样进 poster 的兜底分支
      expect(text).not.toMatch(/poster=\{[^}]*cspSafeSrc/)
    })
  }

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

  /**
   * 「哪一格该去本机解码」是 IntersectionObserver 在 DOM 上认 `data-sns-key` 认出来的，
   * 而 `RemoteImg` 在 pending / failed 两态画的是占位、**没有 `<img>`** —— 钥匙挂在它身上，
   * 那一格就永远不会被观察到，本机解码再也不发起（迁移时真踩到过，见评论图那一处）。
   * 这条只能由守卫钉：TypeScript 对带连字符的 JSX 属性名不做多余属性检查，
   * `data-sns-key` 挂在任何组件上都算合法（实测 `tsc` 0 错误）。
   */
  it('本机解码的观察钥匙不挂在会消失的节点上', () => {
    for (const f of [CARDS, join(HERE, 'moments-card.tsx'), join(HERE, 'moments-portals.tsx')]) {
      const hung = jsxNames(f).elements
        .filter((e) => e.tag === 'RemoteImg' && e.attrs.some((a) => a.startsWith('data-')))
        .map((e) => e.attrs.filter((a) => a.startsWith('data-')))
      expect(hung, `${f.split(/[\\/]/).pop()}：观察钥匙挂在了 RemoteImg 上，代理回话之前那一格不在 DOM 里`).toEqual([])
    }
    // 反向前提：这架观察机器还在，而且钥匙挂在永远在 DOM 的容器上（网格 / 视频块 / 评论行）
    const keys = jsxNames(join(HERE, 'moments-card.tsx')).elements.filter((e) => e.attrs.includes('data-sns-key'))
    expect(keys.length, '一处 data-sns-key 都没有：本机解码的观察机制被拆了').toBeGreaterThanOrEqual(3)
    expect(keys.every((e) => e.tag === 'div'), '观察钥匙又挂回画图节点上了：' + keys.map((e) => e.tag).join(',')).toBe(true)
  })
})
