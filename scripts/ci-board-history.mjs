#!/usr/bin/env node
/**
 * 查「最近若干次 CI 运行的 `[耗时榜]` 榜首」，按**最差值**回答 N36 的验收。
 *
 * 为什么手动跑而不是进 CI 门禁：拿共享 runner 的心情去拦合并，等于制造另一种假红
 * （同一次提交两次运行的榜首实测 104.5 秒 vs 20.8 秒）。但「按最差值判」这条验收如果
 * 没有任何东西能把它查出来，它就只是一句写在文档里的话 —— 所以有这一个脚本。
 *
 * 解析部分（脏日志 → 读数）是纯函数，在 `src/backend/tests/helpers/ci-board-history.ts`，
 * 有用例直接喂真日志钉住；这里只负责「拉」和「打印」。
 *
 * 用法：
 *   node scripts/ci-board-history.mjs                     # 最近 12 次 ci.yml 的运行
 *   node scripts/ci-board-history.mjs --runs 20 --budget 15
 *   node scripts/ci-board-history.mjs --runs 24 --compare      # 最近一半 vs 前一半：这一刀到底动没动
 *   node scripts/ci-board-history.mjs --file kb-vector    # 再横过来看这一个文件的历次读数
 *   node scripts/ci-board-history.mjs --from-file a.log --from-file b.log   # 离线解析本地日志
 *
 * token：优先 `GITHUB_TOKEN`，否则走 `git credential fill`（只在内存里，绝不打印）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { MIN_FOR_BAND, classifyRun, fileHistory, formatCompare, formatFileHistory, formatHistory, parseRunLog, verdictOf } from '../src/backend/tests/helpers/ci-board-history.ts'
import { formatN33History, parseN33Counters } from '../src/backend/tests/helpers/n33-counters.ts'
import { baselineMs, baselineProblems } from '../src/backend/tests/helpers/local-baseline.ts'

const API = 'https://api.github.com'
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const allArgs = (name) => {
  const out = []
  for (let i = 2; i < process.argv.length; i += 1) if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  return out
}

const repo = arg('repo', 'RASH-xiaowang/super_time')
const workflow = arg('workflow', 'ci.yml')
const runs = Number(arg('runs', '12'))
// A 类那半条的预算（秒）。2026-09-24 改定的口径，见 helpers/ci-board-history.ts 里的 TOP_BUDGET_MS。
const budgetS = Number(arg('budget', '15'))
// 给了 `--file` 就额外横过来看这一个文件（关键词是文件名子串，大小写不敏感）。
const needle = String(arg('file', '') ?? '').trim()

/**
 * 本机基线：只有拿到它，① 才能从「上界」变成「按 A 类判」。
 * 读不到 / 不自洽就退回上界判决，**但一定要说出来** —— 静默少一份输入等于悄悄换了口径。
 * `--no-baseline` 是故意留的开关：想只看 CI 侧数（或基线刚被自己改坏）时用。
 */
let localLookup = null
if (!process.argv.includes('--no-baseline')) {
  try {
    const raw = JSON.parse(readFileSync(new URL('../src/backend/tests/fixtures/ci/local-baseline.json', import.meta.url), 'utf8'))
    const problems = baselineProblems(raw)
    if (problems.length > 0) {
      console.error('[榜历史] 本机基线不可用 ⇒ ① 只能给上界。原因：')
      for (const p of problems) console.error(`  - ${p}`)
    } else {
      localLookup = (file) => baselineMs(raw, file)
      console.error(`[榜历史] 用基线：@${raw.headSha} 量于 ${raw.measuredAt}（${raw.mode}，${String(Object.keys(raw.files).length)} 个文件）`)
    }
  } catch (err) {
    console.error(`[榜历史] 读不到本机基线（${String((err && err.message) ?? err).slice(0, 80)}）⇒ ① 只能给上界；要它可判：npm run ci:baseline`)
  }
}

const tokenFromGit = () => {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\n\n`,
    encoding: 'utf8',
  })
  const m = /^password=(.*)$/m.exec(out)
  if (!m || !m[1]) throw new Error('git credential fill 没给出 password —— 先确认这台机器有 github.com 的凭据')
  return m[1]
}

const makeFetch = (token) => async (path) => {
  // 必须有超时：2026-09-24 这一次抓取在 `fetch` 上挂了 13 分钟没返回，而工具自己一个字都不说 ——
  // 挂住与「这个作业没有日志」在使用者眼里长得一模一样。
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ci-board-history' },
    signal: AbortSignal.timeout(Number(arg('timeout-ms', '30000'))),
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${String(res.status)}`)
  return await res.text()
}

const boards = []
const missing = []
const failed = []
/** N33：每次运行的 e2e 计数（`null` = 那份日志里没有这一行；与「拉取失败」不是一桶）。 */
const n33rows = []

const localLogs = allArgs('from-file')
if (localLogs.length > 0) {
  for (const p of localLogs) {
    const label = p.replace(/^.*[\\/]/, '')
    const raw = readFileSync(p, 'utf8')
    const b = parseRunLog(raw, label)
    if (b) boards.push(b)
    else missing.push(label)
    n33rows.push({ label, counters: parseN33Counters(raw) })
  }
} else {
  const token = process.env.GITHUB_TOKEN ?? tokenFromGit()
  const get = makeFetch(token)
  let list
  try {
    list = JSON.parse(await get(`/repos/${repo}/actions/workflows/${workflow}/runs?per_page=${String(Math.max(1, runs))}&status=completed`))
  } catch (err) {
    console.error(`[榜历史] 取运行列表失败：${String((err && err.message) ?? err)}`)
    process.exit(2)
  }
  const items = (list.workflow_runs ?? []).slice(0, runs)
  console.log(`[榜历史] 看 ${String(items.length)} 次「${workflow}」已完成的运行（口径：A 类榜首中位 ≤ ${String(budgetS)} 秒 —— 今天的实现读的是**全体榜首**的中位，是一个上界；B 类越线要求「同一次日志能自证」）`)
  console.log('  注意：重跑过的运行这里只能读到**最新一次尝试**的榜（API 不暴露旧尝试），所以印出来的「最差值」是**下界** —— 可能被盖小，不会被夸大。')
  for (const r of items) {
    const runNumber = String(r.run_number ?? r.id)
    try {
      // 读到的是「最新一次作业尝试」的榜：重跑过的运行会把之前那次的证据盖掉
      // （#98 那次 attempt-1 的榜首是 104.5 秒、真的红了，attempt-2 只有 20.8 秒），
      // 而这个 API 在这里不暴露 attempt 编号（`run.attempt` / `job.attempt` 都是 undefined，
      // `/runs/{id}/jobs?attempt=N` 对 N=1、2 返回同一个 job id），所以本工具**给不出旧尝试的榜**。
      // 结论：印出来的「最差值」是**下界** —— 只可能被重跑盖小，不会被夸大。
      const jobs = JSON.parse(await get(`/repos/${repo}/actions/runs/${String(r.id)}/jobs?per_page=100`)).jobs ?? []
      const meta = { sha: String(r.head_sha ?? '').slice(0, 7), branch: String(r.head_branch ?? '') }
      let worst = null
      let n33 = null
      for (const j of jobs) {
        // 用 job id 自己拼 URL：`/runs/{id}/jobs` 的返回里没有可靠的 `logs_url`（第一版就踩了这个）。
        const raw = await get(`/repos/${repo}/actions/jobs/${String(j.id)}/logs`)
        const b = parseRunLog(raw, runNumber, meta)
        if (b !== null && (worst === null || b.topMs > worst.topMs)) worst = b
        // e2e 与单测在同一个 job 里（ci.yml 只有一个 job、几十步），所以同一份日志两处都读得到。
        if (n33 === null) n33 = parseN33Counters(raw)
      }
      n33rows.push({ label: runNumber, counters: n33, sha: meta.sha, conclusion: typeof r.conclusion === 'string' ? r.conclusion : undefined })
      if (worst === null) { missing.push(runNumber); continue }
      boards.push(worst)
    } catch (err) {
      failed.push(`${runNumber}(${String((err && err.message) ?? err).slice(0, 60)})`)
    }
  }
}

for (const line of formatHistory(boards, missing, budgetS * 1000, localLookup)) console.log(line)
if (needle !== '') for (const line of formatFileHistory(fileHistory(boards, needle), needle, budgetS * 1000)) console.log(line)
if (process.argv.includes('--compare') && localLookup !== null) {
  // 两半窗口对比：新的一半 vs 旧的一半。带（± 秒）来自 MAD，所以每半至少要 MIN_FOR_BAND 个样本 ——
  // 不够就什么都不印？不行：那会被读成「没有差异」。所以这里显式说一句为什么没给。
  const half = Math.floor(boards.length / 2)
  const aRuns = boards.slice(0, half).map((b) => classifyRun(b, localLookup))
  const bRuns = boards.slice(half).map((b) => classifyRun(b, localLookup))
  const av = verdictOf(aRuns.filter((r) => !r.ambiguous && r.aTop !== null).map((r) => r.aTop.ms))
  const bv = verdictOf(bRuns.filter((r) => !r.ambiguous && r.aTop !== null).map((r) => r.aTop.ms))
  if (av === null || bv === null) console.log(`[对比] 每一半都要至少 ${String(MIN_FOR_BAND)} 个可判样本才给噪声带 —— 这次是 ${String(aRuns.length)} / ${String(bRuns.length)}（拉更多次：--runs 24）`)
  else for (const line of formatCompare(av, bv, `最近 ${String(half)} 次`, `之前 ${String(half)} 次`)) console.log(line)
}
for (const line of formatN33History(n33rows, failed.map((x) => String(x).split('(')[0] ?? x))) console.log(line)
if (failed.length > 0) console.log(`  —— 另有 ${String(failed.length)} 次运行拉取失败（不计入「没有榜」）：${failed.join(', ')}`)
