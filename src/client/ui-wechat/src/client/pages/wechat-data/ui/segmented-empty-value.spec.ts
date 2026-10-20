/**
 * `Segmented` 的**空字符串选项**守卫（2026-10-17）。
 *
 * ── 为什么必须有它 ──────────────────────────────────────────────
 * Radix `ToggleGroup type="single"` 把 `''` 当作**「无选中」哨兵**：
 *   · 传 `value=''` 时它认为没有任何项被选中 ⇒ 那一项永远不高亮；
 *   · 点它时 Radix 认为「已经是空」，`onValueChange` 不再回调。
 * 而仓库里**大量**分段选择器用 `value: ''` 表示「全部 / 不限」
 * （ClawBot 收/发筛选、操作日志状态与分类、导出记录状态、问答历史状态与来源…）。
 * 原先 `Segmented` 写 `if (v) onChange(v)`，把 `''` 一律当假值丢掉 ⇒
 * 这些「全部」按钮**只能点一次**（用户 2026-10-17 报的就是这个）。
 *
 * 修法：内部把 `''` 换成哨兵 `'\u0000empty'`，对外仍原样传 `''`。
 * 本测试守两件事：① 空值选项能选中；② 非空值选项不受影响。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, 'kit-overlay.tsx'),
  'utf8',
)

/** 取 `Segmented` 函数体（从 `export function Segmented` 到下一个顶层 `export`）。 */
function segmentedBody(): string {
  const at = SRC.indexOf('export function Segmented')
  expect(at, '找不到 Segmented（改名了？）').toBeGreaterThan(-1)
  const next = SRC.indexOf('\nexport ', at + 10)
  return SRC.slice(at, next > 0 ? next : SRC.length)
}

describe('Segmented：空字符串是合法选项值（「全部」按钮可反复点）', () => {
  it('内部把空字符串换成哨兵值（Radix 不接受 "" 作为 item value）', () => {
    const body = segmentedBody()
    // 必须有「空 → 哨兵」的映射，且哨兵不能是空串本身。
    expect(body, '没有把空字符串换成哨兵 ⇒ Radix 认为「全部」永远未选中（只能点一次）')
      .toMatch(/const EMPTY = '[^']+'/)
    expect(body, '哨兵值不能是空字符串（那就等于没换）').not.toMatch(/const EMPTY = ''/)
    // 对外仍要还原成空字符串（调用方的 state 口径不变）。
    expect(body, '没有把哨兵还原成空字符串 ⇒ 调用方拿到哨兵值，筛选条件全错')
      .toMatch(/fromRadix/)
  })

  it('value 与 item value 都经过哨兵映射（否则 Radix 眼里「全部」仍是空）', () => {
    const body = segmentedBody()
    expect(body, 'ToggleGroup.Root 的 value 没走映射').toMatch(/value=\{toRadix\(value\)\}/)
    expect(body, 'ToggleGroup.Item 的 value 没走映射').toMatch(/value=\{toRadix\(o\.value\)\}/)
  })

  it('onValueChange 只在「真的取消选中」时忽略（空串回调不再被无条件丢掉）', () => {
    const body = segmentedBody()
    // 旧写法 `if (v) onChange(v)` 会把空串选项一并丢掉 —— 必须已退役。
    expect(body, '又写回 `if (v) onChange(v)` ⇒ 空值选项（「全部」）永远选不中')
      .not.toMatch(/if \(v\) onChange\(v\)/)
    expect(body, 'onValueChange 没有还原哨兵').toMatch(/onChange\(fromRadix\(v\)\)/)
  })
})
