/**
 * 「朋友圈」图片占位口径 + 审计工具两条度量口径的守卫。
 *
 * 实测发现的两个问题都还钉在这里，只是**机制换了**：
 *
 *  ① **封面失败会留下空框**。`.linkCover` 是固定 60×60 的框，而最初的失败处理是
 *     `e.currentTarget.style.display = 'none'` —— 图片一藏，框还在。实测 64 个链接封面里
 *     有 **60 个**没有任何可用 URL（`coverSrc` 为空串），旧代码统统变成 60 个灰色空格子。
 *     M23 之前靠面板自己维护 `failedImgs` 状态机（onError 里 add、渲染时 has）来换 🔗 占位；
 *     远程图交给后端代理之后「取不到」有了确定信号（代理回错误），那台状态机于是整体换成
 *     `RemoteImg` 的 `pending` / `failed` 两个占位属性。⇒ 这里钉的是**结果**：固定尺寸的图框
 *     必须带 `failed`；而 `failedImgs` 与 `display = 'none'` 这两个旧写法**一律不许回来**。
 *
 *  ② **审计工具的两条度量在报假警**：
 *     · 「裁切」把 `overflow-y: auto/scroll`（可滚动的长列表、作者栏）与
 *       `-webkit-line-clamp`（有意 2 行截断、且都带 title 全文）也算进去了，
 *       于是朋友圈被记成"裁切 ×11"，实际全是设计如此 → 现在两者都排除，全站裁切归零；
 *     · 「console error」把外部 CDN 的 4xx 与 JS 错误混在一起。实测朋友圈那 3 条全是
 *       `mmbiz.qpic.cn`（公众号封面 CDN）的 400 —— 图片 URL 过期，Chromium 无论有没有
 *       onError 兜底都会打一条 error。现在外部资源失败单独计数，不参与"面板是否健康"的判定。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
// M21 第二十二/二十四刀把 Moments.tsx 拆成 support + panel + portals + 转发桶
// ⇒ 读**该前缀的全部模块的联合**（断言一条没改；源码搬到哪份都算数）。
// 用 readdir 扫描而不是手写清单：下次再拆一刀不必回来补名字（troubleshoot 过一次：
// 第二十四刀搬走详情弹层后，手写清单漏了 portals，`setFailedImgs(prev => …add(dfk))` 当场变红）。
const moments = readdirSync(HERE)
  .filter((f) => /^moments-[a-z-]+\.tsx$/.test(f))
  .concat(['Moments.tsx'])
  .sort()
  .map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
const momentsCss = readFileSync(join(HERE, 'moments.module.css'), 'utf8')
const audit = readFileSync(join(ROOT, 'scripts', 'panel-audit.mjs'), 'utf8')

/**
 * 收集一个模块里的每个 `<RemoteImg>` 站点（属性名 + 整段 JSX 文本）。
 * 走 AST 而不是全文正则：注释里写一句 `failed=` 不该被算成一处占位。
 */
function remoteImgSites(file: string): Array<{ attrs: string[]; text: string }> {
  const text = readFileSync(file, 'utf8')
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: Array<{ attrs: string[]; text: string }> = []
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(src) === 'RemoteImg') {
      out.push({
        attrs: node.attributes.properties.map((p) => (ts.isJsxAttribute(p) ? '#' + p.name.getText(src) : '#spread')),
        text: node.getText(src),
      })
    }
    node.forEachChild(visit)
  }
  visit(src)
  return out
}
const sites = [join(HERE, 'moments-card.tsx'), join(HERE, 'moments-portals.tsx')].flatMap(remoteImgSites)

describe('朋友圈：图片失败要有占位，不能留空格子', () => {
  it('每个固定尺寸的图框都带 failed 占位（视频封面/灯箱缩略图条除外），旧的 display:none 与 failedImgs 一律不许回来', () => {
    expect(sites.length, '朋友圈里没有 RemoteImg？前提不成立（图没走代理）').toBeGreaterThanOrEqual(9)
    // 两类例外与旧口径同样有理由：视频封面（.videoTile 自带背景 + ▶ 徽标）、灯箱缩略图条
    // （取不到就收起那一格，容器本身仍有意义）—— 都不会留下"没有意义的空格子"。
    const collapseOk = ['videoCover', 'lightboxThumb']
    const naked = sites
      .filter((s) => !collapseOk.some((c) => s.text.includes('css.' + c)))
      .filter((s) => !s.attrs.includes('#failed'))
      .map((s) => s.text.replace(/\s+/g, ' ').slice(0, 60))
    expect(naked, '这些框失败时会塌成空格子：' + JSON.stringify(naked)).toEqual([])
    // 九宫格与详情弹层还要带 pending：代理在取的时候先画「加载中」，而不是让格子空一下
    const boxes = sites.filter((s) => s.text.includes('className={css.img}'))
    expect(boxes.length, '找不到固定格子的 RemoteImg').toBeGreaterThanOrEqual(2)
    for (const b of boxes) expect(b.attrs, '格子上没有 pending 占位').toContain('#pending')
    // 链接封面的 🔗 占位（本轮最初修的就是它）与它的样式都还在
    expect(sites.some((s) => s.text.includes('css.linkCoverFallback')), '链接封面没有 🔗 占位').toBe(true)
    expect(momentsCss, '缺少占位样式').toMatch(/\.linkCoverFallback\s*\{/)
    // 反例：`display = 'none'` 正是留空格子的写法；failedImgs 那台状态机已被代理的确定信号取代
    expect(moments, '仍有把 img 藏掉的旧写法').not.toMatch(/style\.display = 'none'/)
    expect(moments, 'failedImgs 已被 RemoteImg 的 pending/failed 取代').not.toMatch(/failedImgs/)
    expect(moments, '渲染层不该再用 onError 兜远程图：失败原因现在由代理给出').not.toMatch(/onError=/)
  })

  it('`.linkCover` 是固定尺寸的框 —— 这正是必须给占位的原因', () => {
    expect(momentsCss).toMatch(/\.linkCover\s*\{[^}]*width:\s*60px[^}]*height:\s*60px/)
  })

  it('朋友圈图的失败口径保持一致（评论图/正文图也是占位或提示，不是空框）', () => {
    expect(moments).toContain('图片加载失败')
    expect(moments).toContain('commentImgFallback')
  })
})

describe('审计工具：裁切与 console error 的口径', () => {
  it('「裁切」排除可滚容器与有意的 line-clamp 截断', () => {
    expect(audit, '没有排除可滚容器').toMatch(/cs\.overflowY === 'visible' \|\| cs\.overflowY === 'auto' \|\| cs\.overflowY === 'scroll'/)
    expect(audit, '没有排除 line-clamp').toMatch(/cs\.webkitLineClamp && cs\.webkitLineClamp !== 'none'/)
    expect(audit, '没有排除单行省略号').toMatch(/cs\.textOverflow === 'ellipsis' && cs\.whiteSpace === 'nowrap'/)
  })

  it('外部资源失败（CDN 4xx）与 JS 错误分开计数', () => {
    expect(audit, '没有记录外部资源失败').toMatch(/assetFails\.push/)
    expect(audit, '没有把外部资源失败单独标记').toMatch(/外部资源×/)
    // JS 错误仍然单独统计
    expect(audit).toMatch(/errs\.push/)
  })
})
