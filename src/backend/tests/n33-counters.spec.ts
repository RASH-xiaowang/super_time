/**
 * N33 计数那一套的回归：解析（带时间戳与 ANSI）、重跑取最后一次、三桶分开、只报分布不判。
 *
 * @module tests/n33-counters
 */
import { describe, expect, it } from 'vitest'

import {
  N33_FIRST_RECORD,
  formatN33History,
  n33Violations,
  parseN33Counters,
  type N33Row,
} from './helpers/n33-counters.ts'

const TS = '2026-09-24T00:22:44.7278251Z '

describe('N33：e2e 那一行 `[N33 计数]` 的解析与三桶判读', () => {
  const N33_LINE = `${TS}  2026-09-24T00:22:44.7278251Z [N33 计数] 阶段① DOM事件=6 主进程到达=30 回调抛错=0 额外加载=0 页面异常=0`

  it('一行完整的计数解成五个数（带时间戳与 ANSI 也要能读）', () => {
    const c = parseN33Counters(`\x1b[0m${N33_LINE}\x1b[0m`)
    expect(c, '解不出来就等于这一桶被当成「没有读数」').not.toBeNull()
    expect(JSON.stringify(c)).toBe(JSON.stringify(N33_FIRST_RECORD))
  })

  it('日志里没有这一行 ⇒ null，不是 0（把「没读数」读成「没问题」是最坏的一种错）', () => {
    expect(parseN33Counters('Run npm test\n ✓ everything passed\n')).toBeNull()
    // 少一个字段（改了打印格式却没改解析）也必须 null，而不是给一个 0 补位
    expect(parseN33Counters('[N33 计数] 阶段① DOM事件=6 主进程到达=30 回调抛错=0 额外加载=0')).toBeNull()
  })

  it('重跑会在同一份日志里留下两行 ⇒ 取最后一次（前面那次是被盖掉的那次尝试）', () => {
    const two = [
      '[N33 计数] 阶段① DOM事件=6 主进程到达=30 回调抛错=0 额外加载=0 页面异常=0',
      '[N33 计数] 阶段① DOM事件=6 主进程到达=12 回调抛错=1 额外加载=0 页面异常=2',
    ].join('\n')
    expect(JSON.stringify(parseN33Counters(two))).toBe(JSON.stringify({ domEvents: 6, relayIn: 12, throws: 1, loads: 0, pageErrors: 2 }))
  })

  it('22 与 30 都不算破绽（只有硬不变量能判「断了」），而抛错/异常/额外加载必须被抓到', () => {
    // 这条是把「第一次跑真历史发现的教训」钉住：绿运行的 `主进程到达` 稳定是 22，
    // 而 #112 只看过一次、把它记成 30 —— 拿单次读数当基线会让闸门天天红在无害的东西上。
    expect(n33Violations({ ...N33_FIRST_RECORD, relayIn: 22 })).toEqual([])
    expect(n33Violations({ ...N33_FIRST_RECORD, relayIn: 0 }).join('；')).toContain('进度没中继到渲染层')
    expect(n33Violations({ ...N33_FIRST_RECORD, throws: 2 }).join('；')).toContain('断在渲染层回调')
    expect(n33Violations({ ...N33_FIRST_RECORD, loads: 1 }).join('；')).toContain('被重新加载')
    expect(n33Violations({ ...N33_FIRST_RECORD, domEvents: 0 }).join('；')).toContain('没触发到阶段①')
  })

  it('表里逐行给结论，并单独印「主进程到达」的分布（只报不判）', () => {
    const rows: N33Row[] = [
      { label: '470', counters: { ...N33_FIRST_RECORD, relayIn: 22 }, sha: 'aaa1111' },
      { label: '471', counters: { ...N33_FIRST_RECORD, relayIn: 12, throws: 1 }, sha: 'bbb2222' },
      { label: '472', counters: null, sha: 'ccc3333' },
    ]
    const text = formatN33History(rows, [])
    const j = text.join('\n')
    expect(text.find((l) => l.includes('run 470'))).toContain('✓ 硬不变量全成立')
    expect(text.find((l) => l.includes('run 471'))).toContain('⚠')
    expect(text.find((l) => l.includes('run 471'))).toContain('断在渲染层回调')
    expect(text.find((l) => l.includes('run 472'))).toContain('不算全 0')
    expect(j).toContain('2 次有计数、1 次日志里没这行')
    expect(j).toContain('破硬不变量的 1 次')
    expect(j).toContain('min 12 / 中位 12 / max 22')
  })

  it('「这批是绿的」只能是 API 给的事实：成功/失败/没带结论三种要分开报', () => {
    const rows: N33Row[] = [
      { label: '500', counters: { ...N33_FIRST_RECORD, relayIn: 22 }, conclusion: 'success' },
      { label: '501', counters: { ...N33_FIRST_RECORD, relayIn: 30 }, conclusion: 'success' },
      { label: '502', counters: { ...N33_FIRST_RECORD, relayIn: 30 }, conclusion: 'failure' },
      { label: '503', counters: { ...N33_FIRST_RECORD, relayIn: 22 } },
      { label: '504', counters: null, conclusion: 'cancelled' },
    ]
    const j = formatN33History(rows, []).join('\n')
    expect(j).toContain('CI 判成功 2 次')
    expect(j).toContain('判失败/取消 2 次')
    expect(j).toContain('没带结论 1 次（不当它是绿的）')
    // 「没这行」也要能自证是哪一步没跑：那次 CI 的结论就印在同一行上
    expect(j).toContain('CI 那次结论：cancelled')
    // 取值分布：这一列有多个取值时，报分布就是不许它被读成「基线 = 某一个数」
    expect(j).toContain('取值 22×2 30×2')
  })

  it('三桶要分开：拉取失败不算「没这行」，一张空表也不许读成「没问题」', () => {
    const text = formatN33History([{ label: '480', counters: null }], ['481(超时)', '482(403)']).join('\n')
    expect(text).toContain('2 次拉取失败')
    expect(text).toContain('481')
    expect(text).toContain('不计入前两桶')
    const empty = formatN33History([], ['483']).join('\n')
    expect(empty, '一行都没有时必须自认拿不到，而不是印一张看着像安全的空表').toContain('这张空表不代表')
  })
})