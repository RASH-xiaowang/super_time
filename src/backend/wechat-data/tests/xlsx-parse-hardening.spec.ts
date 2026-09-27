/**
 * xlsx 解析的加固守卫（CODE-AUDIT-2026-09-26 P1-6）。
 *
 * 依赖原本是 `xlsx@0.18.5`：受 CVE-2023-30533（**原型污染**，<0.19.3）与 CVE-2024-22363
 * （ReDoS，<0.20.2）影响，而 SheetJS 已停止向 npm 发布 —— 修复版只在自有 CDN 有，
 * 挂在 npm 上的版本区间**永远不会自己变好**。2026-09-27 经授权换源，于是这里四条判据：
 *
 * 判一：解析出来的**用户单元格永远不许当对象键**。
 * `sheet_to_json(ws)` 的默认形态就是「首行做键、每行一个对象」⇒ 表头写 `__proto__.x`
 * 这类键名正是那条污染路径的入口。本仓只用 `header: 1`（返回**数组的数组**，
 * 单元格永远是值），所以这条路径是关着的。AST 判据保证「以后有人图省事改成对象模式」会当场红。
 *
 * 判二：真跑一份 xlsx，前后对比 `Object.prototype` 的自有属性 ⇒ 污染真的发生时用例变红。
 *
 * 判三：**装的是哪一份**。声明必须是 `cdn.sheetjs.com` 的精确 tarball（不许回到 npm 版本区间）、
 * 装出来的版本必须在两条 CVE 的修复下限之上、lockfile 必须带 `integrity`（否则「同一个 URL」
 * 也可以被人换内容）。这一条是换源这件事唯一能被机器记住的形式。
 *
 * 判四：换源**没有把行为换掉**。金标准是旧版 0.18.5 对同一批夹具跑出的二维数组
 * （`fixtures/kb-b/xlsx-0.18.5.aoa.golden.json`，采集过程见文件里的 `_readme`），
 * 新版逐格必须相同 —— 尤其 `raw: false` 那套「给用户看的那串字」的语义。
 *
 * 顺手记一条**没有**的结论，免得下一个人重走：在 0.18.5 上把表头写成 `__proto__`
 * 再跑默认对象模式，它会把键名改成 `__proto___NaN` 而没有污染 `Object.prototype`
 * —— 上面那个 PoC 形状复现不了这条 CVE（真 exploits 走的是别的路径）。所以判一是
 * 「把门关上」的纪律，不是「已经挡住了一次真实攻击」的证据，别把它当后者引用。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseXlsx } from '../src/query/kb/parse-xlsx.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const ROOT = join(HERE, '..', '..', '..', '..')

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'deps' || e.name === 'lib' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) tsFiles(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 按键排序后的条目（比较两组选项时不让「谁写在前面」影响结论）。 */
function sortedEntries(o: Record<string, string>): Array<[string, string]> {
  return Object.keys(o).sort().map((k) => [k, o[k] ?? ''] as [string, string])
}

describe('xlsx：用户单元格永远不许成为对象键', () => {
  const calls: Array<{ where: string; header: string | null; given: Record<string, string> }> = []
  for (const f of tsFiles(SRC)) {
    const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const seen = new Set<ts.Node>()
    const walk = (n: ts.Node): void => {
      if (seen.has(n)) return
      seen.add(n)
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'sheet_to_json') {
        const opts = n.arguments[1]
        let header: string | null = null
        const given: Record<string, string> = {}
        if (opts && ts.isObjectLiteralExpression(opts)) {
          for (const prop of opts.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const key = prop.name.getText(sf)
              given[key] = prop.initializer.getText(sf)
              if (key === 'header') header = prop.initializer.getText(sf)
            }
          }
        }
        calls.push({
          where: `${relative(SRC, f).split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
          header,
          given,
        })
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }

  /**
   * 本仓**唯一**允许的那一组读表选项（源码文本形状）。
   * 四个键都必须出现，且值一字不差 —— 判四的金标准文件里记的也是这一组，三方要对得上。
   */
  const EXPECTED: Record<string, string> = { header: '1', raw: 'false', defval: "''", blankrows: 'false' }

  it('扫到了 sheet_to_json 调用（防空转）', () => {
    expect(calls.length, '一个 sheet_to_json 都没扫到 ⇒ 判据恒真').toBeGreaterThanOrEqual(1)
  })

  it('每一处都是 header: 1（数组模式，键名永远不来自文件）', () => {
    const bad = calls.filter((c) => c.header !== '1')
    expect(bad, '这些调用会把用户单元格里写的键名变成真对象键（CVE-2023-30533 的入口）：\n  '
      + bad.map((c) => `${c.where} → header=${String(c.header)}`).join('\n  ')).toEqual([])
  })

  it('每一处的整组选项都是 EXPECTED（金标准量的就是这一组）', () => {
    const bad = calls.filter((c) => JSON.stringify(sortedEntries(c.given)) !== JSON.stringify(sortedEntries(EXPECTED)))
    expect(bad, '选项与金标准那组不一致 ⇒ 判四的「逐格等价」不再覆盖生产调用：\n  '
      + bad.map((c) => `${c.where} → ${JSON.stringify(c.given)}`).join('\n  ')).toEqual([])
  })
})

describe('xlsx：解析真文件不会污染原型链', () => {
  const FIXTURES = [
    join(HERE, 'fixtures', 'kb-b', '设备台账.xlsx'),
    join(HERE, 'fixtures', 'kb-b', '空台账.xlsx'),
  ]

  it('夹具存在且非空（防空转：拿不到文件时下面几条都是假的）', () => {
    for (const f of FIXTURES) {
      expect(readFileSync(f).byteLength, `夹具太小，不像真的 xlsx：${f}`).toBeGreaterThan(1000)
    }
  })

  it('解析前后 Object.prototype 的自有属性一个不多', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    for (const f of FIXTURES) {
      const out = await parseXlsx(new Uint8Array(readFileSync(f)))
      expect(out, `夹具解析失败（判据就失效了）：${f}`).toBeTruthy()
    }
    const after = Object.getOwnPropertyNames(Object.prototype).sort()
    expect(after, '原型链上多出了属性 ⇒ 撞到原型污染了（这就是那条 CVE 的可观测形状）').toEqual(before)
    // `polluted` / `x` 这类是污染 PoC 常用的键名；显式盯一眼，红了能一眼看出是谁
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('解析产物上不许有 __proto__ / constructor / prototype 这类自有键', async () => {
    const DANGER = new Set(['__proto__', 'constructor', 'prototype'])
    const offenders: string[] = []
    const walk = (v: unknown, path: string): void => {
      if (v === null || typeof v !== 'object') return
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${String(i)}]`)); return }
      for (const k of Object.keys(v)) {
        if (DANGER.has(k)) offenders.push(`${path}.${k}`)
        walk((v as Record<string, unknown>)[k], `${path}.${k}`)
      }
    }
    for (const f of FIXTURES) walk(await parseXlsx(new Uint8Array(readFileSync(f))), 'out')
    expect(offenders.join(', ')).toBe('')
  })
})

/** 拆成数字段比较（`'0.20.10' > '0.20.2'` 按字符串会算错）。 */
function versionAtLeast(actual: string, floor: string): boolean {
  const a = actual.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const b = floor.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

describe('判三 依赖面：装的是 SheetJS 自有 CDN 的修复版（换源这件事的机器记忆）', () => {
  type Json = Record<string, unknown>
  const readJson = (rel: string): Json =>
    JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Json
  const declared = (): string => {
    const deps = (readJson('package.json')['dependencies'] ?? {}) as Record<string, string>
    return deps['xlsx'] ?? ''
  }
  /** 两条 CVE 的修复下限：30533 → 0.19.3、22363 → 0.20.2，取高的那条。 */
  const FLOOR = '0.20.2'

  it('声明的是 cdn.sheetjs.com 上的精确 tarball，不是 npm 版本区间', () => {
    const d = declared()
    // npm 上那一版**永远停在 0.18.5**（SheetJS 不再往 npm 发），所以 `^0.18.5` 这种写法
    // 看着「还有升级空间」，实际升级空间是零 —— 只有 URL 形态能拿到修复版。
    expect(d.startsWith('https://cdn.sheetjs.com/'),
      `xlsx 的声明必须指向 SheetJS 自有 CDN，现在是「${d}」`).toBe(true)
    const m = /^https:\/\/cdn\.sheetjs\.com\/xlsx-(\d+\.\d+\.\d+)\/xlsx-(\d+\.\d+\.\d+)\.tgz$/.exec(d)
    expect(m, `URL 形状不对（要的是 …/xlsx-<版本>/xlsx-<版本>.tgz）：「${d}」`).not.toBeNull()
    expect(m?.[1], 'URL 里两段版本号不一致：目录说一个版本、文件名说另一个').toBe(m?.[2])
    expect(versionAtLeast(m?.[1] ?? '0', FLOOR), `CDN 上的这一版还在 ${FLOOR} 之下`).toBe(true)
  })

  it(`装出来的版本 ≥ ${FLOOR}，而且零传递依赖（CDN 版把过去 7 个包内联了）`, () => {
    const inst = readJson(join('node_modules', 'xlsx', 'package.json'))
    const v = String(inst['version'] ?? '')
    expect(v, '读不到装上的 xlsx 版本').not.toBe('')
    expect(versionAtLeast(v, FLOOR), `node_modules 里是 ${v}，低于修复下限 ${FLOOR}`).toBe(true)
    // 这条不只是「更干净」：`build.files` 是白名单，只列了 `node_modules/xlsx/**/*`。
    // 一旦上游又冒出传递依赖而白名单没跟上，表现是「装完的软件里 Excel 报找不到模块」，
    // 而开发机走实时解析永远看不出来（同一套道理见 kb-package-deps.spec.ts）。
    expect(Object.keys((inst['dependencies'] ?? {}) as Record<string, string>),
      'xlsx 出现了传递依赖 ⇒ 打包白名单要一起补，否则装出来的软件读不了 Excel').toEqual([])
  })

  it('lockfile 把内容钉死：resolved 与声明同源，且带 sha512 integrity', () => {
    const lock = readJson('package-lock.json')
    const pkgs = (lock['packages'] ?? {}) as Record<string, Json>
    const e = pkgs['node_modules/xlsx']
    expect(e, 'lockfile 里没有 node_modules/xlsx 这一行（npm ci 装不出可复现的一份）').toBeDefined()
    expect(String(e?.['resolved'] ?? ''), 'lock 里记录的下载地址与 package.json 声明的不是同一个（内容可被中间人换）')
      .toBe(declared())
    expect(String(e?.['integrity'] ?? ''), 'lock 里没有 sha512 摘要 ⇒ 只钉了地址没钉内容').toMatch(/^sha512-/)
    expect(versionAtLeast(String(e?.['version'] ?? ''), FLOOR), 'lock 里钉的版本低于修复下限').toBe(true)
  })
})

describe('判四 换源没有把行为换掉（金标准采自 0.18.5）', () => {
  const GOLDEN_PATH = join(HERE, 'fixtures', 'kb-b', 'xlsx-0.18.5.aoa.golden.json')
  const GOLDEN_OPTIONS_TEXT = { header: '1', raw: 'false', defval: "''", blankrows: 'false' }

  interface GoldenWorkbook { sheetNames: string[]; sheets: Record<string, unknown[][]> }
  interface Golden {
    xlsxVersion: string
    options: Record<string, unknown>
    files: Record<string, GoldenWorkbook>
  }
  const golden = (): Golden => {
    expect(existsSync(GOLDEN_PATH), `金标准文件不见了：${GOLDEN_PATH}`).toBe(true)
    return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden
  }
  /** JSON 里的值 → 源码里的那个字面量文本（只覆盖本用例用到的四种）。 */
  const asText = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : String(v))

  it('金标准自己用的就是判一那一组选项，而且确实有内容（否则「逐格相同」是句空话）', () => {
    const g = golden()
    expect(g.xlsxVersion, '金标准应当采自换源前那一版（0.18.5），否则它证明不了「换源前后」').toBe('0.18.5')
    expect(sortedEntries(Object.fromEntries(Object.entries(g.options).map(([k, v]) => [k, asText(v)]))))
      .toEqual(sortedEntries(GOLDEN_OPTIONS_TEXT))
    const rows = Object.values(g.files).flatMap((f) => Object.values(f.sheets).map((s) => s.length))
    expect(rows.length, '金标准里一个 sheet 都没有').toBeGreaterThanOrEqual(4)
    // 7 = 采集那一刻两份夹具的行数合计（`空台账.xlsx` 只有空表，所以全在 `设备台账.xlsx` 上）。
    // 掉了就说明金标准被截断或被换掉了 —— 那时「逐格相同」会退化成「两个空数组相同」。
    expect(rows.reduce((a, b) => a + b, 0), '金标准里的行数少于采集时的 7 行').toBeGreaterThanOrEqual(7)
    expect(Math.max(...rows), '金标准里没有一个「表头 + 若干数据行」的表 ⇒ 只比了个空壳').toBeGreaterThanOrEqual(4)
    let han = 0
    for (const book of Object.values(g.files)) {
      for (const sheet of Object.values(book.sheets)) {
        for (const row of sheet) for (const cell of row) if (/[一-龥]/.test(String(cell))) han += 1
      }
    }
    expect(han, '金标准里没有一个中文单元格 ⇒ 「显示文本没变」这话没被验证过').toBeGreaterThan(3)
  })

  interface Reader {
    read: (d: Uint8Array, o: { type: string }) => { SheetNames?: unknown, Sheets?: Record<string, unknown> }
    utils: { sheet_to_json: (ws: unknown, o: Record<string, unknown>) => unknown }
  }
  const loadInstalled = async (): Promise<Reader> => {
    const mod = await import(/* @vite-ignore */ 'xlsx') as Record<string, unknown>
    const XLSX = (mod['default'] ?? mod) as Reader
    expect(typeof XLSX?.read, '装上的 xlsx 没有 read ⇒ 这条判据失效').toBe('function')
    return XLSX
  }
  /** 把装上的库对每份夹具的输出与「期望」逐格比；返回所有不一致（空数组 = 完全相同）。 */
  const diffAgainst = (XLSX: Reader, want: Record<string, GoldenWorkbook>, options: Record<string, unknown>): string[] => {
    const diffs: string[] = []
    for (const [file, rec] of Object.entries(want)) {
      const p = join(HERE, 'fixtures', 'kb-b', file)
      expect(existsSync(p), `夹具不见了：${p}`).toBe(true)
      const wb = XLSX.read(new Uint8Array(readFileSync(p)), { type: 'array' })
      const names = Array.isArray(wb.SheetNames) ? (wb.SheetNames as string[]) : []
      if (JSON.stringify(names) !== JSON.stringify(rec.sheetNames)) {
        diffs.push(`${file}：sheet 名单 ${JSON.stringify(names)} ≠ 金标准 ${JSON.stringify(rec.sheetNames)}`)
      }
      for (const sn of rec.sheetNames) {
        const got = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets?.[sn], options) ?? [])
        const exp = JSON.stringify(rec.sheets[sn] ?? [])
        if (got !== exp) diffs.push(`${file} › ${sn}：\n    现在 ${got}\n    金标准 ${exp}`)
      }
    }
    return diffs
  }

  it('装上的库对同一批夹具给出一模一样的二维数组', async () => {
    const g = golden()
    const diffs = diffAgainst(await loadInstalled(), g.files, g.options)
    expect(diffs.join('\n  '),
      '换源之后单元格与 0.18.5 不一样了。判一/判二只保证「还是数组模式、没污染原型」，'
      + '保证不了显示文本的语义（raw:false 那套日期/数字格式）—— 那就是这条判据的存在理由：\n  ').toBe('')
  })

  it('反例自证：金标准里改一个格子，上面那条比较必须报出来', async () => {
    // 上面那条现在**恒真不恒真**，只有喂一份「故意不同」的期望才知道 ——
    // 拿金标准本身当被改对象，改一次、比一次，比较函数必须给出非空差异。
    const g = golden()
    const copy = JSON.parse(JSON.stringify(g.files)) as Record<string, GoldenWorkbook>
    let changed = ''
    outer: for (const [file, rec] of Object.entries(copy)) {
      for (const rows of Object.values(rec.sheets)) {
        for (const row of rows) {
          if (row.length > 0) { row[0] = `${String(row[0])}-被改过`; changed = file; break outer }
        }
      }
    }
    expect(changed, '金标准里一个单元格都没有 ⇒ 反例没造出来，上面那条比较是恒真的').not.toBe('')
    expect(diffAgainst(await loadInstalled(), copy, g.options).length,
      '改了期望值却没报差异 ⇒ 「逐格等价」这条判据其实什么都没判').toBeGreaterThan(0)
  })
})
