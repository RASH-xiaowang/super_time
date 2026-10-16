/**
 * 总览长条的**分母必须是真最大值**（2026-10-14 真数据实测出来的缺陷）。
 *
 * ## 缺陷长什么样
 *
 * 三处长条的宽度都是「当前值 / 分母 × 100%」，而分母原先取的是**数组第 0 项**：
 * 存储构成取 `categories[0].size`、关系浓度取 `relations.top[0].count`、内容构成干脆写死
 * `messages.text`。第 0 项是不是最大值，取决于后端给的顺序 —— 存储构成在渲染前会按 size
 * **重排一份副本**去画行，但分母读的仍是**没重排的原数组**；后端顺序按条数排，与体积顺序不同。
 *
 * 真实数据里这会让分母小于分子：实测存储构成的填充宽度算到 **1297%**（4216px 塞进 325px 的槽，
 * 被 `overflow: hidden` 裁掉）—— 界面上看只是「每条都顶满」，**比例信息整个丢失**，且不报任何错。
 *
 * ## 为什么以前没发现
 *
 * 回归测试与浏览器走查此前都用**打桩数据**（`value: null` 或手工造的小样本，第 0 项恰是最大），
 * 分母永远 ≥ 分子。换成真库（223 会话 / 138,365 条消息）第一次跑就露出来 —— 这正是
 * 「全部使用真实数据测试」这条要求买到的东西。
 *
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const panel = readStripped(join(HERE, 'overview-panel.tsx'))

describe('总览长条的分母是真最大值，不是「第 0 项」', () => {
  it('存储构成：分母取全部类别体积的最大值（渲染前重排的副本不算数，分母读的是原数组）', () => {
    expect(panel, '存储构成的分母又变回第 0 项 ⇒ 后端顺序一旦不是体积降序，长条就溢出被裁、比例全丢')
      .toContain('Math.max(1, ...data.storage.categories.map(x => x.size))')
    expect(panel, '不允许再按「第 0 项」当最大值').not.toContain('categories[0]?.size')
  })

  it('内容构成：分母取全部桶的最大值，而不是写死「文本桶最大」', () => {
    expect(panel, '内容构成的分母又写死成文本桶 ⇒ 图片/语音为主的账号会把长条画出槽外')
      .toContain('Math.max(1, ...MSG_BUCKETS.map(b => ins.messages[b.key] ?? 0))')
    expect(panel, '不允许再假设文本桶最大').not.toContain('Math.max(1, ins.messages.text)')
  })

  it('关系浓度：分母取 top 列表的真最大值（后端不保证降序）', () => {
    expect(panel, '关系浓度的分母又变回 top[0] ⇒ 后端不排序时长条溢出')
      .toContain('Math.max(1, ...ins.relations.top.map(x => x.count))')
    expect(panel, 'topBase 也必须走真最大值').not.toContain('relations.top[0]?.count')
  })
})
