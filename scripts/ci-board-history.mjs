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
 *   node scripts/ci-board-history.mjs --runs 20 --required 4
 *   node scripts/ci-board-history.mjs --from-file a.log --from-file b.log   # 离线解析本地日志
 *
 * token：优先 `GITHUB_TOKEN`，否则走 `git credential fill`（只在内存里，绝不打印）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { formatHistory, parseRunLog } from '../src/backend/tests/helpers/ci-board-history.ts'

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
const required = Number(arg('required', '4'))

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
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ci-board-history' } })
  if (!res.ok) throw new Error(`${path} → HTTP ${String(res.status)}`)
  return await res.text()
}

const boards = []
const missing = []
const failed = []

const localLogs = allArgs('from-file')
if (localLogs.length > 0) {
  for (const p of localLogs) {
    const label = p.replace(/^.*[\\/]/, '')
    const b = parseRunLog(readFileSync(p, 'utf8'), label)
    if (b) boards.push(b)
    else missing.push(label)
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
  console.log(`[榜历史] 看 ${String(items.length)} 次「${workflow}」已完成的运行（验收要求：最慢文件距线倍数 ≥ ${String(required)}×，按最差值判）`)
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
      let worst = null
      for (const j of jobs) {
        // 用 job id 自己拼 URL：`/runs/{id}/jobs` 的返回里没有可靠的 `logs_url`（第一版就踩了这个）。
        const raw = await get(`/repos/${repo}/actions/jobs/${String(j.id)}/logs`)
        const b = parseRunLog(raw, runNumber)
        if (b !== null && (worst === null || b.topMs > worst.topMs)) worst = b
      }
      if (worst === null) { missing.push(runNumber); continue }
      boards.push(worst)
    } catch (err) {
      failed.push(`${runNumber}(${String((err && err.message) ?? err).slice(0, 60)})`)
    }
  }
}

for (const line of formatHistory(boards, missing, required)) console.log(line)
if (failed.length > 0) console.log(`  —— 另有 ${String(failed.length)} 次运行拉取失败（不计入「没有榜」）：${failed.join(', ')}`)
