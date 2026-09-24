/**
 * N33 那五个 e2e 计数的解析与历史判读（从 `ci-board-history.ts` 拆出来：那边过了 M21 的 1000 行棘轮，
 * 而这两件事本来就只有"都读 CI 日志"这一点关系）。
 *
 * 判读口径在这个文件里只有一份；`scripts/ci-board-history.mjs` 只负责拉日志和打印。
 * @module tests/helpers/n33-counters
 */
import { stripLogNoise } from './ci-board-history.ts'

/**
 * N33：e2e 结尾那一行 `[N33 计数]` 的解析与历史判读。
 *
 * 为什么这一半要单独有一套（而不是继续「等一次带数字的红」）：#112 之后每次 CI —— **绿的也算** ——
 * 都会打一行五个计数（DOM 事件 / 主进程到达 / 回调抛错 / 额外加载 / 页面异常）。
 * 但「等一次红」是把结论交给运气：它可能几个月不来，来了也可能只留一行看不懂的数。
 * N36 那条同样是「偶发」的问题是靠把日志变成一条命令查得出来的历史才收口的，这里照同一做法。
 *
 * 三件事必须分开，不然会撒谎：
 *  - **有计数**：五个数都在，可以跟基线比；
 *  - **日志里没这一行**：e2e 那步没跑到、或跑到了但那一步之前就没打 —— 这一桶**不许当成「全 0」**
 *    （「没读数」被读成「没问题」是本仓反复写过的最坏一种错，见 § ㉟）；
 *  - **拉取失败**：API 或凭据的问题，跟上面两桶都不是一回事。
 */
export interface N33Counters {
  domEvents: number
  relayIn: number
  throws: number
  loads: number
  pageErrors: number
}

/**
 * 「一次绿运行」实测到的第一条计数（#112，run 465 之前的一次）。
 *
 * **它不是不变量，别拿它当判据**：这条命令第一次跑真历史（2026-09-24，12 次运行）就发现
 * `主进程到达` 在绿运行里一直是 **22**，只有两次是 30 —— 也就是这个数随「导出过程中进度节拍
 * 有没有被合并」而变，而 #112 当时只看过一次运行就把它写成了基线。
 * 所以判据分成两层：**硬不变量**（下面的 `n33Violations`）与**分布**（`relayIn` 印 min/中位/max，
 * 只报不判）。把「与某一次的读数不同」当成缺陷，会让闸门天天红在无害的东西上 —— 那种红很快就会
 * 被人忽略，然后真的那条腿断了也没人看。
 */
export const N33_FIRST_RECORD: N33Counters = { domEvents: 6, relayIn: 30, throws: 0, loads: 0, pageErrors: 0 }

/** @deprecated 名字会让人误以为这是「应当等于」的基线；用 {@link N33_FIRST_RECORD} 或 `n33Violations`。 */
export const N33_BASELINE = N33_FIRST_RECORD

/**
 * 硬不变量：这几条破了才是「断在某条腿上」的信号。
 * @param c - 一次运行的五个计数。
 * @returns 破掉的条目（中文、可直接印）；全成立时为空数组。
 */
export function n33Violations (c: N33Counters): string[] {
  const out: string[] = []
  if (c.throws > 0) out.push(`回调抛错 ${String(c.throws)} 次 ⇒ 断在渲染层回调里`)
  if (c.pageErrors > 0) out.push(`页面异常 ${String(c.pageErrors)} 次 ⇒ 渲染层 JS 出错`)
  if (c.loads > 0) out.push(`额外加载 ${String(c.loads)} 次 ⇒ 中继期间页面被重新加载过`)
  if (c.domEvents === 0) out.push('DOM事件 0 次 ⇒ e2e 没触发到阶段①（这一条不能证明链路通）')
  if (c.relayIn === 0) out.push('主进程到达 0 次 ⇒ 进度没中继到渲染层（链路断在主进程侧）')
  return out
}

const N33_LINE = /\[N33 计数\][^\n]*?DOM事件=(\d+) 主进程到达=(\d+) 回调抛错=(\d+) 额外加载=(\d+) 页面异常=(\d+)/

/**
 * 从一份（可能是几十 KB 的）作业日志里取**最后一次** `[N33 计数]`。
 * @param rawLog - 未经处理的作业日志原文（本函数自己去 ANSI 与时间戳）。
 * @returns 五个计数；日志里没这行/字段不全时返回 **null**（不是 0）。
 */
export function parseN33Counters (rawLog: string): N33Counters | null {
  const clean = stripLogNoise(rawLog)
  let last: RegExpExecArray | null = null
  for (const m of clean.matchAll(new RegExp(N33_LINE.source, 'g'))) last = m
  if (last === null) return null
  return {
    domEvents: Number(last[1] ?? 0),
    relayIn: Number(last[2] ?? 0),
    throws: Number(last[3] ?? 0),
    loads: Number(last[4] ?? 0),
    pageErrors: Number(last[5] ?? 0),
  }
}

/** 一行历史：某个运行 + 它的计数（`null` = 这一桶是「日志里没这行」）。 */
export interface N33Row { label: string, counters: N33Counters | null, sha?: string, conclusion?: string }

/**
 * 把若干运行摊成一张表 + 一句总结。
 * @param rows - 每次运行一行（按时间倒序传进来即可，本函数按 label 印）。
 * @param failedFetch - 拉取失败的运行编号（单独一桶，不与「没这行」混）。
 * @returns 要打印的行。
 */
export function formatN33History (
  rows: readonly N33Row[],
  failedFetch: readonly string[] = [],
): string[] {
  const out: string[] = ['[N33 计数历史] e2e 那五个计数：DOM事件 / 主进程到达 / 回调抛错 / 额外加载 / 页面异常']
  if (rows.length === 0) {
    out.push(`  ⚠ 一个运行都没拿到（拉取失败 ${String(failedFetch.length)} 次）—— 这张空表不代表「没问题」`)
    return out
  }
  let broken = 0
  let noLine = 0
  const relays: number[] = []
  for (const r of rows) {
    if (r.counters === null) {
      noLine += 1
      out.push(`  run ${r.label.padEnd(6)} （日志里没有 [N33 计数] 这一行 —— e2e 那步没跑到或没打，**不算全 0**）` +
        `${r.conclusion === undefined ? '' : ` CI 那次结论：${r.conclusion}`}`)
      continue
    }
    const c = r.counters
    relays.push(c.relayIn)
    const v = n33Violations(c)
    if (v.length > 0) broken += 1
    out.push(`  run ${r.label.padEnd(6)} ${(String(c.domEvents) + ' / ' + String(c.relayIn) + ' / ' + String(c.throws) + ' / ' + String(c.loads) + ' / ' + String(c.pageErrors)).padEnd(18)} ${r.sha ?? ''}  ${v.length === 0 ? '✓ 硬不变量全成立' : `⚠ ${v.join('；')}`}`)
  }
  const ok = rows.length - noLine
  relays.sort((a, b) => a - b)
  const mid = relays.length === 0 ? 0 : (relays[Math.floor((relays.length - 1) / 2)] ?? 0)
  // 「这批是绿的」不能靠嘴说：conclusion 是 API 给的事实，没带进来就得承认没带 ——
  // 否则一次失败的运行会被当成「绿运行的对照读数」，而那正是这张表唯一要防的错。
  const green = rows.filter((r) => r.conclusion === 'success').length
  const unknown = rows.filter((r) => r.conclusion === undefined).length
  const notGreen = rows.length - green - unknown
  const hist = new Map<number, number>()
  for (const v of relays) hist.set(v, (hist.get(v) ?? 0) + 1)
  const histText = [...hist.entries()].map(([v, n]) => `${String(v)}×${String(n)}`).join(' ')
  out.push([
    `  读数：${String(ok)} 次有计数、${String(noLine)} 次日志里没这行`,
    failedFetch.length > 0 ? `、${String(failedFetch.length)} 次拉取失败（不计入前两桶：${failedFetch.join(', ')}）` : '',
    `。破硬不变量的 ${String(broken)} 次${broken === 0
      ? ` —— 其中 CI 判成功 ${String(green)} 次${notGreen > 0 ? `、判失败/取消 ${String(notGreen)} 次` : ''}${unknown > 0 ? `、没带结论 ${String(unknown)} 次（不当它是绿的）` : ''}，这批读数里两条腿都是通的（有 DOM 事件、也有主进程中继，且没有抛错/异常/额外加载）`
      : ''}`,
  ].join(''))
  out.push(`  分布（只报不判）：主进程到达 min ${String(relays[0] ?? 0)} / 中位 ${String(mid)} / max ${String(relays[relays.length - 1] ?? 0)} ⇒ 取值 ${histText}；` +
    `#112 首次记录是 ${String(N33_FIRST_RECORD.relayIn)} —— 这一列本来就有多个取值（进度节拍有没有被合并），所以报分布而不是报「基线」`)
  out.push('  「什么时候算诊断出来」：抛错/页面异常 >0 ⇒ 断在渲染层回调；DOM事件>0 而主进程到达=0 ⇒ 断在中继；两个都 0 ⇒ e2e 自己没触发到阶段①（这一条要靠那次运行的其它行佐证，别只信计数）')
  return out
}
