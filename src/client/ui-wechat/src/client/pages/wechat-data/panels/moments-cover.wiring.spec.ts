/**
 * 「朋友圈」链接封面失败口径 + 审计工具两条度量口径的守卫。
 *
 * 本轮实测（真实数据）发现两件事：
 *
 *  ① **封面失败会留下空框**。`.linkCover` 是固定 60×60 的框，而失败处理是
 *     `e.currentTarget.style.display = 'none'` —— 图片一藏，框还在。实测 64 个链接封面里
 *     有 **60 个**没有任何可用 URL（`coverSrc` 为空串），旧代码统统变成 60 个灰色空格子。
 *     现在改成"标记失败 + 渲染 🔗 占位"，与评论图/朋友圈图的失败口径一致。
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

describe('朋友圈：链接封面失败要有占位，不能留空格子', () => {
  it('固定尺寸的图片框失败时一律给占位（链接封面 + 详情弹层），不再把 img 设成 display:none', () => {
    // 链接封面
    expect(moments, '封面失败没有标记状态').toMatch(/setFailedImgs\(prev => new Set\(prev\)\.add\('cover:' \+ m\.tid\)\)/)
    expect(moments, '缺少封面失败占位渲染').toMatch(/failedImgs\.has\('cover:' \+ m\.tid\)/)
    expect(momentsCss, '缺少占位样式').toMatch(/\.linkCoverFallback\s*\{/)
    // 详情弹层的固定纵横比图片框
    expect(moments, '详情弹层图片失败没有标记状态').toMatch(/setFailedImgs\(prev => new Set\(prev\)\.add\(dfk\)\)/)
    expect(moments).toMatch(/failedImgs\.has\(dfk\)/)
    // 反例：固定尺寸框里再出现 `display = 'none'`（那正是留空格的写法）。
    // 例外并注明：视频封面（.videoTile 自带背景 + ▶ 徽标）与灯箱缩略图条
    // （失败即收起一格，容器本身仍有意义），这两处的隐藏不会产生"无意义空格"。
    const hideSites = [...moments.matchAll(/([A-Za-z]+)\s*=\s*'none'/g)].length
    const legacy = [...moments.matchAll(/e\.currentTarget\.style\.display = 'none'/g)].length
    expect(legacy, `仍有 ${legacy} 处旧写法（应为 4 处视频/缩略图站点），hideSites=${hideSites}`).toBeLessThanOrEqual(4)
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
