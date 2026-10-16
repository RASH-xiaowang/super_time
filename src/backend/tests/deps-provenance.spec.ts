/**
 * `file:` 本地依赖的溯源表必须**说得出这份是谁的哪一版**（P1-5，第二批 #15）。
 *
 * ## 这条守卫在防的是什么
 *
 * 19 个依赖写成 `file:src/backend/deps/...`，npm 既解析不了也升级不了，上游改了要手工拷进来。
 * 拷完之后仓库里**没有任何东西**记下「哪来的、哪个版本、动过没有」—— 于是出问题时唯一的线索是
 * `git log`，而 git 只看得到**我们这份**，看不到上游那份。更阴的一种漂移是：这些包里
 * `src/*.ts` 与 `lib/*.js` 并存，运行时加载的是 `lib/`，改了 `src/` 不报错也不生效。
 *
 * ## 判据为什么是「内容指纹 + 双向对齐」而不是「表存在」
 *
 * 一张没人验证的表比没有表更糟（它会让人以为已经溯源了）。所以这里每次跑测试都**复算**：
 * 把磁盘现状与表里的 `treeSha256` 比对，并要求 package.json 里的 `file:` 清单与表的行**双向相等**。
 * 指纹口径与 mtime 无关（见下面那条用例）—— 否则换台机器、重新克隆一次就会假红。
 *
 * 表由 `node scripts/deps-provenance.mjs --write` 生成；本用例只读不算命令，
 * 因此 `npm test` 不需要额外的构建步骤（也不依赖 git）。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { at } from './helpers/strict-index.ts'
import {
  TABLE_PATH, buildTable, diffTables, fileDependencies, listFiles, readTable, treeDigest,
} from '../../../scripts/deps-provenance.mjs'
import type { ProvenanceRow } from '../../../scripts/deps-provenance.mjs'

/** 一份「表」：故意用真类型而不是 `Record<string, unknown>` —— 改坏表形状的用例必须编译得过。 */
type Rows = Record<string, ProvenanceRow>

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const table = readTable()
const fresh = buildTable({ previous: table ?? undefined })

describe('依赖溯源表（deps/PROVENANCE.json）', () => {
  it('表存在且非空转：行数下限、且至少有一行带内容指纹', () => {
    expect(table, '缺 src/backend/deps/PROVENANCE.json —— 跑 node scripts/deps-provenance.mjs --write').toBeTruthy()
    expect(Object.keys(table ?? {}).length, '表里的行数低于 file: 依赖数 ⇒ 判据覆盖面不对').toBeGreaterThanOrEqual(19)
    expect(Object.values(table ?? {}).filter((r) => typeof r.treeSha256 === 'string').length)
      .toBeGreaterThan(10)
  })

  it('package.json 的 file: 清单与表**双向**对齐（漏一行、留一行旧的都是问题）', () => {
    const declared = fileDependencies(pkg).map((d: { name: string }) => d.name).sort()
    const rows = Object.keys(table ?? {}).sort()
    expect(rows, '表与 package.json 的 file: 依赖不一致：\n  ' + rows.join('\n  ')).toEqual(declared)
    expect(declared.length).toBeGreaterThanOrEqual(19)
  })

  it('复算指纹：现状与表完全一致（缺目录 / 版本变了 / 内容变了 / 文件数变了都会报出来）', () => {
    const d = diffTables(table ?? {}, fresh.packages)
    expect(d.missing, '表里缺行：' + d.missing.join(', ')).toEqual([])
    expect(d.extra, '表里多出行（package.json 已不再引用）：' + d.extra.join(', ')).toEqual([])
    expect(d.changed.map((l: string) => String(l).split(':')[0] ?? ''), '内容/版本与表对不上：' + d.changed.join('\n')).toEqual([])
    expect(d.absent, '表里说有的目录磁盘上不存在：' + d.absent.join(', ')).toEqual([])
  })

  it('in-repo 的两个包只登记不指纹（它们每次构建都变，指纹只会制造噪声）', () => {
    const inRepo = Object.entries(table ?? {}).filter(([, r]) => r.kind === 'in-repo')
    expect(inRepo.length, '本该有 in-repo 包这一类 ⇒ 分类逻辑或表被改坏').toBeGreaterThanOrEqual(2)
    for (const [name, row] of inRepo) {
      expect(row.treeSha256, `${name} 是 in-repo 包，不该有内容指纹`).toBeUndefined()
      expect(typeof row.version).toBe('string')
    }
    // 反向：vendored 的必须有指纹，否则「溯源」是空的
    for (const [name, row] of Object.entries(table ?? {}).filter(([, r]) => r.kind === 'vendored')) {
      expect(typeof row.treeSha256, `${name} 缺 treeSha256`).toBe('string')
      expect(row.files, `${name} 缺文件数`).toBeGreaterThan(0)
    }
  })

  it('判据自证：把表改坏一处，diffTables 必须恰好报出那一处', () => {
    const clone = (): Rows => JSON.parse(JSON.stringify(table ?? {})) as Rows
    const base = clone()
    // `at()` 而不是 `keys[0] as string`：一行指纹都没有时，要直说「前提不成立」，
    // 不是往下跑出个 `Cannot read properties of undefined`（见 helpers/strict-index.ts）。
    const [victim, row] = at(Object.entries(base).filter(([, r]) => typeof r.treeSha256 === 'string'), 0)

    const tampered = clone()
    const original = String(row.treeSha256)
    tampered[victim] = { ...row, treeSha256: original.startsWith('0') ? '1' + original.slice(1) : '0' + original.slice(1) }
    const d1 = diffTables(tampered, fresh.packages)
    expect(d1.changed.length, '改了指纹却没报出来 ⇒ 上面那条「复算」是恒真').toBe(1)
    expect(d1.changed[0]).toContain(victim)

    const dropped = clone()
    delete dropped[victim]
    expect(diffTables(dropped, fresh.packages).missing).toContain(victim)

    const stale = clone()
    stale['@不存在的/包'] = {
      kind: 'vendored', path: 'src/backend/deps/nope', declared: 'file:src/backend/deps/nope',
      version: '1.0.0', repository: null, treeSha256: 'x', files: 1,
    }
    expect(diffTables(stale, fresh.packages).extra).toEqual(['@不存在的/包'])
  })
})

describe('指纹口径本身（克隆到别的机器也必须复算得一致）', () => {
  const dirs: string[] = []
  const temp = (tag: string): string => {
    const d = mkdtempSync(join(tmpdir(), `prov-${tag}-`))
    dirs.push(d)
    return d
  }
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  it('mtime 与文件顺序都不影响指纹；内容或路径变了就必须变', () => {
    const a = temp('a')
    mkdirSync(join(a, 'lib'), { recursive: true })
    writeFileSync(join(a, 'index.js'), 'export const x = 1\n')
    writeFileSync(join(a, 'lib', 'y.js'), 'export const y = 2\n')
    const first = treeDigest(a)
    // 倒着的 mtime（老文件后写）不该改变任何东西
    utimesSync(join(a, 'index.js'), 1_600_000_000, 1_600_000_000)
    utimesSync(join(a, 'lib', 'y.js'), 1_500_000_000, 1_500_000_000)
    expect(treeDigest(a).treeSha256, '指纹被 mtime 影响 ⇒ 换台机器就会假红').toBe(first.treeSha256)

    writeFileSync(join(a, 'lib', 'y.js'), 'export const y = 3\n')
    expect(treeDigest(a).treeSha256, '内容变了指纹没变 ⇒ 漂移查不出来').not.toBe(first.treeSha256)

    const b = temp('b')
    mkdirSync(join(b, 'lib'), { recursive: true })
    writeFileSync(join(b, 'index.js'), 'export const x = 1\n')
    writeFileSync(join(b, 'lib', 'z.js'), 'export const y = 2\n')
    expect(treeDigest(b).treeSha256, '只改文件名就算同一个东西 ⇒ 改名将不可见').not.toBe(first.treeSha256)
    expect(first.files).toBe(2)
    expect(first.bytes, '字节数该是两份文件之和').toBeGreaterThan(0)
  })

  it('node_modules / .git / *.tsbuildinfo 不进指纹，也不进拷贝清单', () => {
    const d = temp('skip')
    mkdirSync(join(d, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(d, '.git'), { recursive: true })
    writeFileSync(join(d, 'node_modules', 'x', 'index.js'), 'junk')
    writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(d, 'tsconfig.tsbuildinfo'), '{"program":1}')
    writeFileSync(join(d, 'index.js'), 'real\n')
    expect(listFiles(d)).toEqual(['index.js'])
  })

  it('不存在的目录回空清单而不是抛（--import 之前就靠这个判定「还没拷进来」）', () => {
    expect(listFiles(join(temp('none'), 'nope'))).toEqual([])
    const dig = treeDigest(join(temp('none2'), 'nope'))
    expect(dig.files).toBe(0)
    expect(dig.bytes).toBe(0)
    expect(typeof dig.treeSha256).toBe('string')
  })
})

/**
 * CLI 的退出码。
 *
 * 上面那些用例走的是纯函数，而 CI 里真正被调用的是 `npm run check:deps-provenance` ——
 * 「有差异但退出 0」的表单一模一样、函数调用全绿，门禁却是空的。所以这一组**起子进程**测退出码。
 * `--table` 就是为此而存在的覆盖入口：仓库真表必须一致（不然日常全红），拿它测「漂移」测不出东西。
 */
describe('CLI 退出码（CI 抓手）', () => {
  const run = (args: string[]): { code: number | null, out: string } => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'deps-provenance.mjs'), ...args], { encoding: 'utf8' })
    return { code: r.status, out: String(r.stdout) + String(r.stderr) }
  }

  it('仓库现状必须 check 通过（退出 0），且回报的包数与 package.json 一致', () => {
    const { code, out } = run(['--check'])
    expect(out, 'CLI 输出：\n' + out).toContain('依赖溯源一致')
    expect(code, '--check 在现状一致时必须退出 0').toBe(0)
    expect(Number(out.match(/(\d+) 个 file: 依赖/)?.[1] ?? -1))
      .toBe(fileDependencies(pkg).length)
  })

  it('表漂移时 `--check` 必须退出 1（只改一行指纹，其余保持一致）', () => {
    const stale = JSON.parse(JSON.stringify(table ?? {})) as Rows
    const [victim, row] = at(Object.entries(stale).filter(([, r]) => typeof r.treeSha256 === 'string'), 0)
    const original = String(row.treeSha256)
    stale[victim] = { ...row, treeSha256: (original.startsWith('0') ? '1' : '0') + original.slice(1) }
    const dir = mkdtempSync(join(tmpdir(), 'prov-check-'))
    const file = join(dir, 'PROVENANCE.json')
    try {
      writeFileSync(file, JSON.stringify({ schema: 1, generatedBy: 'test', packages: stale }, null, 2), 'utf8')
      const { code, out } = run(['--check', '--table', file])
      expect(code, `漂移却没退出 1（门禁形同虚设）。输出：\n${out}`).toBe(1)
      expect(out).toContain(victim)
      expect(out, '必须把差异种类说清楚，否则只有退出码没人知道改了什么').toContain('treeSha256')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('表整个缺失时也必须退出 1，而不是「一致」地退出 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-missing-'))
    try {
      const { code, out } = run(['--check', '--table', join(dir, 'nope.json')])
      expect(code, `没有表却退出了 0：\n${out}`).toBe(1)
      expect(out).toContain('缺少溯源表')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('反例自证：--write 在旧表之上重刷，必须一个字节都不改（人手字段也跟着走）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-round-'))
    const file = join(dir, 'PROVENANCE.json')
    try {
      // 先把仓库真表搬过去当「旧表」：全新的临时表没有 previous，note 本来就该是 0，
      // 拿它断言「note 被吃掉」是把测试写成了恒假（第一轮就是这么红的：expected +0 to be 16）。
      writeFileSync(file, readFileSync(TABLE_PATH, 'utf8'), 'utf8')
      expect(run(['--write', '--table', file]).code).toBe(0)
      expect(readFileSync(file, 'utf8'), '--write 重刷同一份现状应当逐字节相同（否则表里会有抖动）')
        .toBe(readFileSync(TABLE_PATH, 'utf8'))
      const written = JSON.parse(readFileSync(file, 'utf8')) as { packages: Record<string, { note?: string }> }
      const notes = Object.values(written.packages).filter((r) => typeof r.note === 'string').length
      expect(notes, '--write 吃掉了人手写的 note').toBe(
        Object.values(table ?? {}).filter((r) => typeof r.note === 'string').length,
      )
      expect(notes).toBeGreaterThan(10)
      expect(run(['--check', '--table', file]).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('坏表闸门：表存在但 JSON 读不出时，--write 必须拒绝覆盖而不是吃掉人手字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-corrupt-'))
    const file = join(dir, 'PROVENANCE.json')
    try {
      writeFileSync(file, '{"packages": 这里是手抖打坏的', 'utf8')
      const w = run(['--write', '--table', file])
      expect(w.code, `坏表被 --write 直接覆盖了：\n${w.out}`).toBe(1)
      expect(w.out).toContain('拒绝覆盖')
      expect(readFileSync(file, 'utf8'), '被拒之后原文件必须一字未动').toBe('{"packages": 这里是手抖打坏的')
      // 而「表压根不存在」是合法的 bootstrap（首次 --write），不能被同一道闸门拦住。
      const freshFile = join(dir, 'fresh.json')
      expect(run(['--write', '--table', freshFile]).code).toBe(0)
      expect(existsSync(freshFile)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
