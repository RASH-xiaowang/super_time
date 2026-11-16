/**
 * 消息窗口合并的**行为**守卫（`message-identity.ts`）。
 *
 * 判据来自真机数据：群 `17660437911@chatroom` 的 `message_0..5` 各自从 `local_id 1`
 * 起编号，同一个窗口里因此会长着好几条 `local_id` 相同的**不同消息**。
 * 只按 `localId` 建 Map 做合并，老分片那一行会被最新页的另一条覆盖 ——
 * 位置上是新内容、尾部又追加了同一份新内容，用户看到的就是「重复内容」。
 *
 * 所以这里的用例全部以「哪一行被换、换成了谁、有没有多出一份」为断言。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import {
  mergeLatestWindow,
  mergeRowsInPlace,
  messageIdentity,
  prependOlderWindow,
} from './message-identity.ts'

const row = (localId: number, sortSeq: number, text: string): WechatMessage => ({
  localId,
  sortSeq,
  createTime: 1700000000 + sortSeq,
  type: 1,
  isSender: 0,
  displayText: text,
}) as WechatMessage

const same = (a: WechatMessage, b: WechatMessage): boolean =>
  a.localId === b.localId && a.sortSeq === b.sortSeq && a.displayText === b.displayText

describe('messageIdentity', () => {
  it('同一 localId 在不同分片（sort_seq 不同）⇒ 不是同一条消息', () => {
    const shard2 = row(1, 500, '二〇二三年三月的图片')
    const shard0 = row(1, 9000, '二〇二五年十一月的视频')
    expect(messageIdentity(shard2)).not.toBe(messageIdentity(shard0))
  })

  it('同一条消息重复到达 ⇒ 身份稳定', () => {
    expect(messageIdentity(row(7, 42, '甲'))).toBe(messageIdentity(row(7, 42, '甲')))
  })

  it('缺 sort_seq 的旧响应退回 local_id + create_time，仍然区分不同消息', () => {
    const old = { localId: 3, createTime: 100, type: 1, isSender: 0 } as WechatMessage
    const other = { localId: 3, createTime: 200, type: 1, isSender: 0 } as WechatMessage
    expect(messageIdentity(old)).not.toBe(messageIdentity(other))
  })
})

describe('mergeLatestWindow（对账）', () => {
  it('跨分片同号行不许互相覆盖：老行原样保留，新行追加到尾部', () => {
    const older = row(1, 500, '二〇二三年三月的图片')
    const prev = [older]
    const latest = [row(1, 9000, '二〇二五年十一月的视频')]
    const merge = mergeLatestWindow(prev, latest, same)
    expect(merge.next[0], '老分片的同号行被最新页的行顶上去了（重复内容的来源）').toBe(older)
    expect(merge.next.map((m) => m.displayText), '最新页的行没有追加').toEqual([
      '二〇二三年三月的图片',
      '二〇二五年十一月的视频',
    ])
    expect(merge.added).toHaveLength(1)
    expect(merge.changed).toBe(false)
  })

  it('同一身份正文变了 ⇒ 就地换掉那一行，不追加第二份', () => {
    const edited = row(4, 100, '旧正文')
    const merge = mergeLatestWindow([edited], [row(4, 100, '编辑后的正文')], same)
    expect(merge.next).toHaveLength(1)
    expect(merge.next[0]?.displayText).toBe('编辑后的正文')
    expect(merge.changed, '编辑后没标成「变了」⇒ 不写缓存、不重渲染').toBe(true)
    expect(merge.added).toHaveLength(0)
  })

  it('什么都没变 ⇒ 原数组身份不变（避免每次推送都重渲染）', () => {
    const prev = [row(1, 10, '甲'), row(2, 11, '乙')]
    const merge = mergeLatestWindow(prev, [row(1, 10, '甲'), row(2, 11, '乙')], same)
    expect(merge.next).toBe(prev)
    expect(merge.changed).toBe(false)
    expect(merge.added).toHaveLength(0)
  })

  it('最新窗口里同一身份出现两次 ⇒ 只追加一份', () => {
    const merge = mergeLatestWindow([], [row(3, 30, '丙'), row(3, 30, '丙')], same)
    expect(merge.added).toHaveLength(1)
    expect(merge.next).toHaveLength(1)
  })
})

describe('mergeRowsInPlace（编辑后刷新）', () => {
  it('只替换、不追加：目标不在窗口里时窗口保持原样', () => {
    const prev = [row(1, 10, '甲'), row(2, 11, '乙')]
    expect(mergeRowsInPlace(prev, [row(9, 99, '不在窗口里')])).toBe(prev)
  })

  it('定向取回的单条按复合身份替换窗口里那一行', () => {
    const prev = [row(1, 10, '甲'), row(1, 500, '另一个分片的同号行')]
    const restored = row(1, 10, '恢复后的原文')
    const next = mergeRowsInPlace(prev, [], [restored])
    expect(next[0]).toBe(restored)
    expect(next[1], '同号但不同分片的行被顺手改了（张冠李戴）').toBe(prev[1])
    expect(next).toHaveLength(2)
  })

  it('没有任何可替换的行 ⇒ 保持原数组身份', () => {
    const prev = [row(1, 10, '甲')]
    expect(mergeRowsInPlace(prev, [row(1, 10, '甲')])).toBe(prev)
  })
})

describe('prependOlderWindow（续页）', () => {
  it('重复页退化成空操作（连点两次「加载更多」不会把历史拼两遍）', () => {
    const prev = [row(3, 30, '丙')]
    const page = [row(1, 10, '甲'), row(2, 20, '乙')]
    const first = prependOlderWindow(prev, page)
    expect(first.next.map((m) => m.displayText)).toEqual(['甲', '乙', '丙'])
    const second = prependOlderWindow(first.next, page)
    expect(second.next, '同一页被拼了第二遍').toBe(first.next)
    expect(second.added).toHaveLength(0)
  })

  it('部分重叠的页只插入真正新的行，顺序仍是「更早的在前」', () => {
    const prev = [row(2, 20, '乙'), row(3, 30, '丙')]
    const next = prependOlderWindow(prev, [row(1, 10, '甲'), row(2, 20, '乙')]).next
    expect(next.map((m) => m.displayText)).toEqual(['甲', '乙', '丙'])
  })
})
