#!/usr/bin/env node
/**
 * `file:` 本地依赖的溯源表（CODE-AUDIT-2026-09-26 P1-5，第二批 #15）。
 *
 * ## 这件事真正的痛点不是「装不上」，是「说不清装的是哪一份」
 *
 * 19 个 `file:` 依赖直接指向仓库里的目录（`src/backend/deps/**` 与两个 in-repo 包）。
 * npm 既不能解析也不能升级它们，上游改了要**手工拷贝**进来 —— 于是有两个具体的坑：
 *   ① 拷完之后没有任何东西记录「这份是哪来的、哪个版本、什么时候动过」；
 *   ② 这些包里 `src/*.ts` 与 `lib/*.js` 并存，而**运行时加载的是 `lib/`**：
 *      改了 `src/` 不会自动改 `lib/`，也不会报错，只会静默漂移
 *      （实测的一例：`lib/typert.host.js` 里 `sourceLocation` 写的是
 *      `packages/host/wechat-data/src/gateway.ts`，**本仓库根本没有这条路径** ——
 *      这份生成物是从另一棵树里签出来的，本仓没有任何脚本能重现它）。
 *
 * ## 因此这里做三件事
 *
 * 1. `--write` 生成 `src/backend/deps/PROVENANCE.json`：逐包记 name/version/repository/
 *    文件数/整棵目录的 sha256（**内容指纹**，与 mtime 无关，克隆下来也能复算）。
 * 2. `--check` 复算并比对：表里缺行、多行、版本变了、内容变了，都单独列出并退出 1。
 *    守卫用例 `src/backend/tests/deps-provenance.spec.ts` 直接调这两个纯函数，
 *    所以它随 `npm test` 每次都跑 —— 不依赖 CI 配置改动。
 * 3. `--import <包名> <上游目录>` 把上游的一份拷进来并顺手刷新那一行（排除 `node_modules`
 *    /`.git`/`*.tsbuildinfo`），同时把「上游工作区路径 + 那一刻的 commit sha」写进记录里。
 *    这是「半自动」：拷贝这一步可以脚本做，**该不该拷**仍然由人判断。
 *
 * 另有 `--table <路径>` 只服务守卫用例：`--check` 的退出码是 CI 唯一的抓手，而「漂移必须
 * 退出 1」这条判据没法拿仓库真表测（真表必须一致）—— 有了覆盖入口，用例才能造一份临时
 * 坏表去**真的**要求退出码非 0。
 *
 * in-repo 的两个包（`dsh-wechat-data`、`dsh-client-ui-primitives`）只登记不指纹 ——
 * 它们本来就在本仓演进，`lib/` 由构建重新生成并由 CI 逐字节比对，再叠一层内容指纹
 * 只会让每次提交都要 `--write`，那不是溯源，是噪声。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TABLE_PATH = join(ROOT, 'src', 'backend', 'deps', 'PROVENANCE.json')

/** 拷贝/指纹时忽略的东西：装出来的依赖、VCS 元数据、构建缓存。 */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist'])
export const SKIP_BASENAMES = new Set(['tsconfig.tsbuildinfo', '.DS_Store'])

/** 递归列出一棵目录里的文件（相对路径、正斜杠、已排序）。 */
export function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(d, e.name))
        continue
      }
      if (!e.isFile()) continue
      if (SKIP_BASENAMES.has(e.name) || e.name.endsWith('.tsbuildinfo')) continue
      out.push(relative(dir, join(d, e.name)).split(sep).join('/'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

/**
 * 一棵目录的内容指纹。
 * 口径写死在这里：`相对路径 \0 文件内容sha256 \n` 逐行拼接再整体 sha256
 * —— 与 mtime/权限/排序无关，任何机器上重算都该得到同一个值。
 */
export function treeDigest(dir) {
  const files = listFiles(dir)
  const lines = []
  let bytes = 0
  for (const rel of files) {
    const buf = readFileSync(join(dir, rel))
    bytes += buf.length
    lines.push(rel + '\0' + createHash('sha256').update(buf).digest('hex') + '\n')
  }
  return { treeSha256: createHash('sha256').update(lines.join('')).digest('hex'), files: files.length, bytes }
}

/** package.json 里所有 `file:` 依赖（dependencies + optionalDependencies + devDependencies）。 */
export function fileDependencies(pkg) {
  const out = []
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec === 'string' && spec.startsWith('file:')) out.push({ name, spec, field })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 人手工维护的字段：`--write` / `--import` 重写表时必须原样带过去（否则每次刷新都会吃掉注释）。 */
const HUMAN_FIELDS = ['upstream', 'upstreamCommit', 'importedAt', 'upstreamWorkspace', 'note']
function headSha(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null
  } catch { return null }
}

/**
 * 从 package.json 与磁盘现状生成整张表。
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.previous] 旧表：用来**保留**人手写的 note/upstream 字段。
 */
export function buildTable(opts = {}) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const previous = opts.previous ?? {}
  const packages = {}
  for (const dep of fileDependencies(pkg)) {
    const rel = dep.spec.slice('file:'.length)
    const abs = join(ROOT, rel)
    const exists = existsSync(abs)
    let version = null
    let repository = null
    if (exists) {
      try {
        const meta = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'))
        version = typeof meta.version === 'string' ? meta.version : null
        const repo = meta.repository
        repository = typeof repo === 'string' ? repo : repo && typeof repo.url === 'string' ? repo.url : null
      } catch { /* 缺 package.json：下面按缺失报出去 */ }
    }
    const inRepo = !rel.split(sep).join('/').split('/').includes('deps')
    const dig = inRepo || !exists ? null : treeDigest(abs)
    const old = previous[dep.name] ?? {}
    packages[dep.name] = {
      kind: inRepo ? 'in-repo' : 'vendored',
      path: rel.split(sep).join('/'),
      declared: dep.spec,
      version,
      repository,
      ...(dig ? { treeSha256: dig.treeSha256, files: dig.files, bytes: dig.bytes } : {}),
      // 人手写的字段一律带过去：`--write` 不该吃掉上一轮记下的来源说明
      ...Object.fromEntries(HUMAN_FIELDS.filter((f) => old[f] !== undefined && old[f] !== null).map((f) => [f, old[f]])),
    }
  }
  return { schema: 1, generatedBy: 'scripts/deps-provenance.mjs', packages }
}

/**
 * 比对旧表与现状。
 * @returns {{missing: string[], extra: string[], changed: string[], absent: string[]}}
 */
export function diffTables(previous, current) {
  const prevKeys = Object.keys(previous).sort()
  const curKeys = Object.keys(current).sort()
  const missing = curKeys.filter((k) => !prevKeys.includes(k))
  const extra = prevKeys.filter((k) => !curKeys.includes(k))
  const changed = []
  const absent = []
  for (const k of curKeys) {
    const p = previous[k]
    const c = current[k]
    if (!p) continue
    if (typeof c.path === 'string' && !existsSync(join(ROOT, c.path))) { absent.push(k); continue }
    const diffs = []
    if (p.version !== c.version) diffs.push(`version ${String(p.version)} -> ${String(c.version)}`)
    if (p.repository !== c.repository) diffs.push(`repository ${String(p.repository)} -> ${String(c.repository)}`)
    if (p.treeSha256 !== c.treeSha256) diffs.push(`treeSha256 ${String(p.treeSha256).slice(0, 12)} -> ${String(c.treeSha256).slice(0, 12)}`)
    if (p.files !== c.files) diffs.push(`files ${String(p.files)} -> ${String(c.files)}`)
    if (p.kind !== c.kind) diffs.push(`kind ${String(p.kind)} -> ${String(c.kind)}`)
    if (diffs.length > 0) changed.push(`${k}: ${diffs.join('; ')}`)
  }
  return { missing, extra, changed, absent }
}

/**
 * 读表（不存在时返回 null，让调用方区分「没有表」与「表是空的」）。
 * @param {string} [tablePath] 覆盖默认表路径 —— 守卫用例用它把 `--check` 的
 *   退出码指向一份临时表，从而**真的**验证「漂移必须退出 1」。
 */
export function readTable(tablePath = TABLE_PATH) {
  if (!existsSync(tablePath)) return null
  try {
    const j = JSON.parse(readFileSync(tablePath, 'utf8'))
    return j && typeof j === 'object' && j.packages ? j.packages : null
  } catch { return null }
}

/** 把一棵上游目录拷进 deps/，并刷新表里那一行。 */
function importFrom(name, fromDir, tablePath) {
  const src = resolve(fromDir)
  if (!existsSync(join(src, 'package.json'))) throw new Error(`上游目录里没有 package.json：${src}`)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const dep = fileDependencies(pkg).find((d) => d.name === name)
  if (!dep) throw new Error(`package.json 的 file: 依赖里没有 ${name}`)
  const dest = join(ROOT, dep.spec.slice('file:'.length))
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const copy = (s, d) => {
    for (const e of readdirSync(s, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        mkdirSync(join(d, e.name), { recursive: true })
        copy(join(s, e.name), join(d, e.name))
        continue
      }
      if (!e.isFile()) continue
      if (SKIP_BASENAMES.has(e.name) || e.name.endsWith('.tsbuildinfo')) continue
      writeFileSync(join(d, e.name), readFileSync(join(s, e.name)))
    }
  }
  copy(src, dest)
  return { dest, upstream: src, upstreamCommit: headSha(src), importedAt: new Date().toISOString().slice(0, 10) }
}

function main() {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--write') ? 'write' : argv.includes('--import') ? 'import' : 'check'
  // `--table <路径>` 只给守卫用例用：把退出码判据指向一份临时表，才能真的制造「漂移」这一情形。
  const ti = argv.indexOf('--table')
  const tablePath = ti === -1 ? TABLE_PATH : resolve(String(argv[ti + 1] ?? TABLE_PATH))
  if (mode === 'import') {
    const i = argv.indexOf('--import')
    const name = argv[i + 1]
    const from = argv[i + 2]
    if (!name || !from) { console.error('用法：--import <包名> <上游目录>'); process.exit(2) }
    const info = importFrom(name, from, tablePath)
    console.log(`已拷入 ${name} <- ${info.dest}${info.upstreamCommit ? `  (上游 ${info.upstreamCommit.slice(0, 12)} @ ${info.upstream})` : ''}`)
    const previous = readTable(tablePath) ?? {}
    const fresh = buildTable({ previous })
    const row = fresh.packages[name]
    if (row) {
      row.upstream = info.upstream
      row.upstreamCommit = info.upstreamCommit
      row.importedAt = info.importedAt
    }
    writeFileSync(tablePath, JSON.stringify({ ...JSON.parse(readFileSync(tablePath, 'utf8')), packages: fresh.packages }, null, 2) + '\n', 'utf8')
    console.log('已刷新表里那一行；请 review `git diff` 后提交。')
    return
  }
  const previous = readTable(tablePath)
  const fresh = buildTable({ previous: previous ?? undefined })
  if (mode === 'write') {
    // 表读不出东西却存在 ⇒ 覆盖它会把**人手的** upstream/note 一起吃掉（readTable 对
    // 语法坏掉/缺 packages 的 JSON 一律回 null，而这里原本会当成「没有旧表」）。
    if (existsSync(tablePath) && previous === null) {
      console.error(`拒绝覆盖：${relative(ROOT, tablePath)} 存在但读不出 packages —— `
        + '直接 --write 会吃掉手写的 upstream/note 字段。先把这份 JSON 修好再刷新。')
      process.exit(1)
    }
    writeFileSync(tablePath, JSON.stringify(fresh, null, 2) + '\n', 'utf8')
    console.log(`PROVENANCE.json 已写出（${Object.keys(fresh.packages).length} 行）`)
    return
  }
  if (!previous) {
    console.error(`缺少溯源表 ${relative(ROOT, tablePath)} —— 先跑 \`node scripts/deps-provenance.mjs --write\``)
    process.exit(1)
  }
  const d = diffTables(previous, fresh.packages)
  for (const line of d.changed) console.log('差异  ' + line)
  for (const k of d.missing) console.log(`缺行  ${k} 在 package.json 里但表里没有`)
  for (const k of d.extra) console.log(`多行  ${k} 表里有但 package.json 已不再引用`)
  for (const k of d.absent) console.log(`缺失  ${k} 表里说有，磁盘上没有目录`)
  const bad = d.changed.length + d.missing.length + d.extra.length + d.absent.length
  console.log(bad === 0
    ? `依赖溯源一致：${Object.keys(fresh.packages).length} 个 file: 依赖，指纹全部复算通过。`
    : `依赖溯源有 ${bad} 处不一致（见上）。确认无误后跑 --write 刷新表。`)
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
