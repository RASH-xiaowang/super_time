/**
 * 图谱初始参数（2026-10-18 用户反馈）：
 *   ① 「节点上限」初始默认 = **当前过滤条件下可显示的总人数 × 30%**（至少 1 个）；
 *      旧行为是 min(250, 快照人数)，且首屏 data 为 null 时会先把默认值算成 1 再锁死；
 *   ② 「头像模糊」只糊头像位图，名字 / 圆点 / 描边环 / 连线保持清晰
 *      （旧实现是给整个节点加 `shadowBlur`，名字和圆点一起被糊）。
 *
 * 渲染函数没有 2D context 可跑（node 环境），按仓库既有做法（graph-canvas-style.spec.ts）
 * 用源码断言补位；数值规则用纯函数单测。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultNodeLimit, eligibleCandidateCount } from './graph-model.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')

describe('节点上限：初始默认 = 可显示总人数 30%', () => {
  it('四舍五入、至少 1', () => {
    expect(defaultNodeLimit(0)).toBe(1)
    expect(defaultNodeLimit(1)).toBe(1)
    expect(defaultNodeLimit(3)).toBe(1)
    expect(defaultNodeLimit(10)).toBe(3)
    expect(defaultNodeLimit(20)).toBe(6)
    expect(defaultNodeLimit(21)).toBe(6)
    expect(defaultNodeLimit(284)).toBe(85)
    expect(defaultNodeLimit(289)).toBe(87)
    expect(defaultNodeLimit(2500)).toBe(750)
  })

  it('「总人数」= 当前过滤下可进图的人（排除群/我；仅好友时排除公众号与非好友）', () => {
    const data = {
      nodes: [
        { kind: 'contact', is_friend: true },
        { kind: 'contact', is_friend: false },
        { kind: 'official', is_friend: true },
        { kind: 'group' },
        { kind: 'self' },
      ],
    }
    expect(eligibleCandidateCount(data, { mode: 'people', friendsOnly: true })).toBe(1)
    expect(eligibleCandidateCount(data, { mode: 'people', friendsOnly: false })).toBe(3)
    expect(eligibleCandidateCount(data, { mode: 'groups', friendsOnly: true })).toBe(1)
    expect(eligibleCandidateCount(null, { mode: 'people', friendsOnly: true })).toBe(0)
  })

  it('buildGraph 与默认值共用同一份筛选实现（各写一份必然漂移）', () => {
    const src = read('graph-model.ts')
    expect(src).toMatch(/const rawNodes = rawCandidateNodes\(env, s\)/)
  })

  it('Graph.tsx 等 data 落地后按 30% 覆盖默认哨兵；用户拖过滑杆则不覆盖；恢复默认同规则', () => {
    const src = read('Graph.tsx')
    // 首屏 data=null 必须先跳过，否则先把哨兵消耗成 1、data 到了也不再生效
    expect(src, '缺 data 空守卫：首屏会把默认值算成 1').toMatch(/if \(!data\) return/)
    expect(src).toMatch(/defaultNodeLimit\(eligibleCandidateCount\(data, prev\)\)/)
    expect(src).toMatch(/prev\.nodeLimit === DEFAULT_GRAPH_SETTINGS\.nodeLimit/)
    expect(src, '恢复默认参数没有重算 30%').toMatch(/nodeLimit: defaultNodeLimit\(eligibleCandidateCount\(data, settings\)\)/)
  })

  it('滑杆允许 <20 的值（小图 30% 可能是 1–19）', () => {
    const rail = read('GraphRail.tsx')
    expect(rail).toMatch(/label="节点上限"[^>]*min=\{1\}[^>]*step=\{1\}/)
  })
})

describe('头像模糊：只糊头像位图', () => {
  it('画布：不再给节点整体 shadowBlur，只在头像位图绘制前后设/清 ctx.filter', () => {
    const src = read('graph-canvas-render.ts')
    expect(src, '仍在用节点整体 shadowBlur').not.toMatch(/shadowBlur\s*=\s*settings\.blurNodes/)
    const start = src.indexOf('} else if (sprite) {')
    expect(start, '找不到头像分支').toBeGreaterThan(-1)
    const branch = src.slice(start, src.indexOf('} else {', start))
    expect(branch, '头像绘制前没有设 filter').toMatch(/if \(blurPx > 0\) ctx\.filter = `blur\(\$\{blurPx\}px\)`/)
    expect(branch, '头像绘制后没有复位 filter（会漏到名字/描边环）').toMatch(/if \(blurPx > 0\) ctx\.filter = 'none'/)
    expect(branch).toMatch(/ctx\.drawImage\(sprite,/)
  })

  it('海报：filter 只在头像分支内设置且画完复位，名字/消息数仍用清晰文字', () => {
    const src = read('graph-poster.ts')
    const start = src.indexOf('const blurPx = input.blurNodes ?? 0')
    expect(start, '找不到海报的头像模糊处理').toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf("ctx.textAlign = 'center'", start))
    expect(block).toMatch(/if \(blurPx > 0\) ctx\.filter = `blur\(\$\{blurPx\}px\)`/)
    expect(block).toMatch(/ctx\.drawImage\(rel\.sprite/)
    expect(block).toMatch(/if \(blurPx > 0\) ctx\.filter = 'none'/)
  })

  it('参数面板标签改叫「头像模糊」', () => {
    const rail = read('GraphRail.tsx')
    expect(rail).toContain('label="头像模糊"')
    expect(rail, '旧标签还在').not.toContain('label="节点模糊"')
  })
})
