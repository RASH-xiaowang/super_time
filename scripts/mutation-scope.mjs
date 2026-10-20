/**
 * 变异登记的**增量选取**：按「这次 PR 改了哪些文件」挑出必须重跑的变异。
 *
 * ## 为什么需要它
 *
 * 2026-10-09 实测：全量 412 条变异一次跑完要按小时计（每条都要单独起一次 vitest，
 * `--maxWorkers=1 --no-file-parallelism`），塞不进 PR 门禁 —— 那里单测已经占 26 分钟、
 * `timeout-minutes` 只有 45。但**完全不跑**等于第三件套（变异自证）形同虚设：
 * 登记表会腐烂，守卫会悄悄失去证明力，而且没人会发现。
 *
 * 所以折中：**每次 push/PR 跑增量，夜间跑全量**。
 *
 * ## 关键判据：目标文件改了 **或** 它的判据 spec 改了
 *
 * 一条变异打在文件 A，但它的**证明力来自 spec B**。只按 A 筛会漏掉最该抓的那类改动 ——
 * 「把守卫削弱一点」：目标文件没动，但 `expect(...).toBe(...)` 被改成更容易过的形式，
 * 于是那条变异不再咬红，而登记表与全量单测都还是绿的。
 * 实测（2026-10-09，HEAD~1…HEAD 改了 30 个文件）：只按目标文件筛是 45 条，
 * 加上 spec 口径是 53 条 —— **多出的 8 条全是这一类**。
 *
 * ## 登记表本身被改动 ⇒ 全跑
 *
 * `scripts/mutations-registry*.mjs` 一动，可能是新增/删除/改了某条的 `from`。
 * 这时按文件筛没有意义（筛的基准本身就是被改的东西），所以退化成全量。
 *
 * ## 拿不到 diff 时 ⇒ 全跑，且必须喊出来
 *
 * 浅克隆、ref 不存在、git 失败……任何一种情况下**静默跳过**是最坏的结果：
 * 看起来门禁是绿的，实际什么都没验。所以失败一律退化成全量。
 *
 * @module scripts/mutation-scope
 */
import { execFileSync } from 'node:child_process'

/** 把 Windows 的 `\` 归一成 git 输出的 `/`，好让两边能对上。 */
const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/')

/** 登记表本体（改动它 ⇒ 全量）。 */
export const REGISTRY_PATH_RE = /^scripts\/mutations-registry(\.[\w-]+)?\.mjs$/

/**
 * 挑选这次改动必须重跑的变异。
 *
 * @param {ReadonlyArray<{ id: string, file: string, spec: string }>} mutations 全量登记表
 * @param {ReadonlyArray<string>} changedFiles 本次改动的文件（git 的路径写法）
 * @returns {{ picked: ReadonlyArray<{ id: string }>, all: boolean, reason: string, byTarget: number, bySpec: number }}
 *   `all` 为 true 表示「不要筛，全跑」；`picked` 在 `all` 为 true 时是**全部**。
 */
export function selectForDiff(mutations, changedFiles) {
  const set = new Set(changedFiles.map(norm).filter((p) => p !== ''))
  const registryTouched = [...set].filter((p) => REGISTRY_PATH_RE.test(p))
  if (registryTouched.length > 0) {
    return {
      picked: mutations,
      all: true,
      reason: '变异登记表本身被改动（' + registryTouched.join(', ') + '）⇒ 筛选基准已变，全量重跑',
      byTarget: 0,
      bySpec: 0,
    }
  }
  const byTarget = mutations.filter((m) => set.has(norm(m.file)))
  const targetIds = new Set(byTarget.map((m) => m.id))
  const bySpec = mutations.filter((m) => !targetIds.has(m.id) && set.has(norm(m.spec)))
  return {
    picked: [...byTarget, ...bySpec],
    all: false,
    reason: '目标文件命中 ' + String(byTarget.length) + ' 条 + 仅 spec 命中 ' + String(bySpec.length) + ' 条',
    byTarget: byTarget.length,
    bySpec: bySpec.length,
  }
}

/**
 * 取 `ref...HEAD` 之间改动的文件。
 *
 * @param {string} ref - 任意可解析的 git 引用（PR 的 base sha、push 的 before sha 等）
 * @param {string} cwd - 仓库目录
 * @returns {{ files: string[]; ok: boolean; detail: string }} `ok=false` 时调用方必须退化成全量
 */
export function changedFilesSince(ref, cwd) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', ref + '...HEAD'], { cwd, encoding: 'utf8' })
    const files = out.split('\n').map((s) => s.trim()).filter((s) => s !== '')
    return { files, ok: true, detail: String(files.length) + ' 个文件' }
  } catch (e) {
    return { files: [], ok: false, detail: (e && e.message ? e.message : String(e)).split('\n')[0] }
  }
}

/**
 * 取 `ref...HEAD` + **工作树脏改动/未跟踪文件** 的并集。
 *
 * `--diff` 在 CI 上通常干净，但本地/预推送时代码常常还没提交；只用 `ref...HEAD`
 * 会把“正在改的守卫”排除在变异增量之外，看起来绿、实际没验。这个函数只给
 * mutation-check 的增量口径用；`changedFilesSince` 保持原语义不动（已有用例依赖）。
 *
 * 任何一条 git 命令失败 ⇒ `ok:false`，调用方必须退化成全量，绝不静默跳过。
 *
 * @param {string} ref - 任意可解析的 git 引用。
 * @param {string} cwd - 仓库目录。
 * @returns {{ files: string[]; ok: boolean; detail: string }}
 */
export function changedFilesForGate(ref, cwd) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const files = new Set()
  let detail = ''
  try {
    const committed = run(['diff', '--name-only', ref + '...HEAD'])
    const unstaged = run(['diff', '--name-only'])
    const staged = run(['diff', '--cached', '--name-only'])
    const untracked = run(['ls-files', '--others', '--exclude-standard'])
    for (const blob of [committed, unstaged, staged, untracked]) {
      for (const line of blob.split('\n')) {
        const path = line.trim()
        if (path !== '') files.add(path.replace(/\\/g, '/'))
      }
    }
    detail = String(files.size) + ' 个文件（含工作树）'
    return { files: [...files], ok: true, detail }
  } catch (e) {
    return { files: [], ok: false, detail: (e && e.message ? e.message : String(e)).split('\n')[0] }
  }
}

