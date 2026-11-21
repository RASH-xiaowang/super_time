/**
 * 「卡片高度必须由内容决定」的守卫（2026-11-19）。
 *
 * ## 事故现场
 *
 * 「年度之最」这张卡被撑成一堵墙：9 个砖块竖排、每格近百像素空白
 * （用户截图 +「为什么这张卡片那么高」）。
 *
 * 根因是 CSS 里写了：
 *
 * ```css
 * .tileGrid { grid-auto-rows: 1fr; align-content: stretch; flex: 1 1 auto; }
 * ```
 *
 * `1fr` 在**不定高**的网格里会让**所有行等高、且等于最高的那一行** ——
 * 而最后一格「最后一句」是一整条消息，一高就把另外 8 行也全撑到同样高度。
 * 当时写它的动机是"别在卡片下半截留空"，但用拉伸行高硬凑是错的方向：
 * 行高一旦脱离内容，任何一条长文本都会把整张卡放大数倍。
 *
 * ## 守什么
 *
 * ① 砖块/格子网格的行高必须是 `auto`（或 `minmax(…, auto)`），不许 `1fr`；
 * ② 这类网格不许 `flex: 1 1 auto` 撑进父容器（画布卡高度本来就由内容决定）；
 * ③ 单元格里的长文本必须限行（否则单格仍会把卡撑高）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const cssText = readFileSync(join(HERE, 'annual.module.css'), 'utf8')
/** 剥注释（说明里会引用被删的旧写法）。 */
const cssCode = cssText.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取某条选择器的声明（同名规则合并）。 */
function declarationsOf(selector: string): string[] {
  const out: string[] = []
  postcss.parse(cssCode).walkRules((rule) => {
    if (rule.selector.trim() !== selector) return
    rule.walkDecls((decl) => { out.push(`${decl.prop}:${decl.value}`) })
  })
  return out
}

describe('数据格网格：行高必须随内容，不许被拉伸', () => {
  it('.tileGrid 的行高是 auto，不是 1fr', () => {
    const decl = declarationsOf('.tileGrid')
    expect(decl, '找不到 .tileGrid').not.toHaveLength(0)
    expect(decl, '.tileGrid 又用 1fr 行高了 ⇒ 所有行会被拉成最高那行的高度')
      .not.toContain('grid-auto-rows:1fr')
    expect(decl, '.tileGrid 行高必须是 auto').toContain('grid-auto-rows:auto')
    expect(decl, '.tileGrid 不许 flex 撑高').not.toContain('flex:1 1 auto')
    expect(decl, '.tileGrid 不许 align-content: stretch').not.toContain('align-content:stretch')
  })

  it('整个年度报告样式里没有「1fr 行高」这种会把卡片撑爆的写法', () => {
    const offenders: string[] = []
    postcss.parse(cssCode).walkDecls((decl) => {
      if (decl.prop !== 'grid-auto-rows') return
      if (/\b1fr\b/.test(decl.value)) offenders.push(`${(decl.parent as { selector?: string }).selector ?? '?'} → ${decl.value}`)
    })
    expect(offenders, `这些网格的行高是 1fr（会被最高那行撑开）：\n  ${offenders.join('\n  ')}`)
      .toEqual([])
  })

  it('砖块里的长值限行（否则单格仍会把卡片撑高）', () => {
    const decl = declarationsOf('.tileV')
    expect(decl, '找不到 .tileV').not.toHaveLength(0)
    expect(decl, '.tileV 缺行数上限').toContain('-webkit-line-clamp:3')
    expect(decl, '.tileV 缺 overflow 兜底').toContain('overflow:hidden')
  })

  it('防空转：砖块结构确实还在（否则上面的判据恒真）', () => {
    expect(declarationsOf('.tile'), '找不到 .tile').not.toHaveLength(0)
    expect(declarationsOf('.tileK'), '找不到 .tileK').not.toHaveLength(0)
  })
})
