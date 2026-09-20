/**
 * D8 · **真实样本**回归 —— 用用户本机上那批真文件走完整链路。
 *
 * 与 `kb-b-endtoend.spec.ts` 的差别在**输入**：那一支用的是仓库里手工生成的极小夹具
 * （两三页 PDF、两张工作表的 xlsx），能证明「代码逻辑对」；而真实文件才会暴露
 * 夹具永远暴露不了的东西 —— 真实的 CJK 字体编码（要不要走 cmaps）、真实的中文
 * 段落与表格、真实 Office 导出的那点不规范。本支就是那一层。
 *
 * ⚠ 它依赖**仓库外**的样本目录（`C:\Users\Administrator\Documents\test`），
 * 所以在别的机器上整支 `skip` —— 这是刻意的：把样本提交进仓库既大又涉及用户数据。
 * `describe.skipIf` 让「没有样本」表现为「没跑」，而不是「假装跑过了」。
 *
 * 样本清单（2026-09 实测，21 个条目）：三个 B 档真文件
 * （`测试报告.pdf` / `项目计划书.docx` / `员工名单.xlsx`）+ 若干 A 档文本，
 * 另有 pptx / rtf / zip 等本仓不接受或暂无解析器的类型 —— 那些要**如实被拒**，
 * 不许悄悄放行（放行的后果是界面上显示「已就绪」而正文是空的）。
 * @vitest-environment node
 */
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { kbFilesDbPath, registerKbFile, resetRecoveryGuardForTest } from '../src/query/kb-files.ts'
import { drainKbQueue, resetQueueGuardForTest } from '../src/query/kb-queue.ts'
import { searchKb } from '../src/query/kb-search.ts'
import { isAcceptedExt } from '../src/query/kb/types.ts'

/** 真实样本目录（仓库外；不存在则整支跳过）。 */
const SAMPLES = 'C:\\Users\\Administrator\\Documents\\test'
const HAS_SAMPLES = existsSync(SAMPLES)

/** B 档那三个（必须真正解出正文）。 */
const B_FILES = ['测试报告.pdf', '项目计划书.docx', '员工名单.xlsx'] as const

let root = ''
let decrypted = ''
let srcDir = ''
const report: string[] = []

if (HAS_SAMPLES) {
  root = mkdtempSync(join(tmpdir(), 'kb-real-'))
  decrypted = join(root, 'data', 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  resetRecoveryGuardForTest()
  resetQueueGuardForTest()
}

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

/** 直接读库拿一行的解析状态。 */
function rowOf(db: DatabaseSync, name: string): Record<string, unknown> | undefined {
  return db.prepare(
    'SELECT id, parse_state, parser, parse_error, chunk_count, char_count, ext FROM kb_files WHERE name = ?',
  ).get(name) as Record<string, unknown> | undefined
}

/** 某个文件已落库的正文（拼起来，用来验中文有没有变成乱码）。 */
function textOf(db: DatabaseSync, fileId: number): string {
  const rows = db.prepare('SELECT text FROM kb_chunks WHERE file_id = ? ORDER BY ordinal').all(fileId) as Array<Record<string, unknown>>
  return rows.map((r) => String(r['text'] ?? '')).join('\n')
}

describe.skipIf(!HAS_SAMPLES)('真实样本回归（D8）', () => {
  it('★ 三个 B 档真文件：登记 → 解析 → ready，中文正文完好在库里', async () => {
    // 真拷贝到临时目录：不动用户原文件（这是本模块的硬不变量，顺带也验了它）。
    for (const name of B_FILES) {
      const src = join(SAMPLES, name)
      const dst = join(srcDir, name)
      copyFileSync(src, dst)
      const r = registerKbFile(decrypted, { kbId: 1, srcPath: dst })
      expect(r.ok, `${name} 登记失败：${r.code} ${r.error}`).toBe(true)
      expect(r.file?.parseState, `${name} 登记后应当排队`).toBe('queued')
    }

    const rep = await drainKbQueue(decrypted)
    report.push(`drain: processed=${rep.processed} ready=${rep.ready} unsupported=${rep.unsupported} failed=${rep.failed}`)

    const db = new DatabaseSync(kbFilesDbPath(decrypted))
    try {
      for (const name of B_FILES) {
        const row = rowOf(db, name)
        expect(row, `库里没有 ${name}`).toBeDefined()
        const state = String(row!['parse_state'])
        const chunks = Number(row!['chunk_count'])
        const chars = Number(row!['char_count'])
        const text = textOf(db, Number(row!['id']))
        report.push(
          `${name}  ext=${String(row!['ext'])}  parser=${String(row!['parser'])}  state=${state}  `
          + `chunks=${chunks}  chars=${chars}${String(row!['parse_error'] ?? '') === '' ? '' : '  note=' + String(row!['parse_error'])}`,
        )
        // 正文前 200 字（人工复核用：中文必须是中文，不能是乱码 —— 这是本支存在的理由）。
        report.push(`    首段：${text.slice(0, 200).replace(/\s+/g, ' ')}`)

        expect(state, `${name} 没到 ready`).toBe('ready')
        expect(chunks, `${name} 没落块`).toBeGreaterThan(0)
        expect(chars, `${name} 正文是空的`).toBeGreaterThan(0)
        // 解码没坏：`U+FFFD` 是编码解错的典型痕迹，任何一档都不许有。
        expect(text.includes('\uFFFD'), `${name} 正文里有 U+FFFD（解码坏了）`).toBe(false)
        /*
         * 汉字那一条**只**对 docx / xlsx 断言，因为实测这批样本里：
         *   · `项目计划书.docx`、`员工名单.xlsx` 是中文内容；
         *   · `测试报告.pdf` **本身就只有英文**（正文原话：`It contains English text
         *     to keep the font simple.`），对它要求汉字是错的 —— 这条断言第一版就是这么
         *     红掉的。也就是说：**这批样本覆盖不到「中文 PDF 抽文字」**。
         * 中文 PDF 要靠 `cmaps/`（字体没有 ToUnicode 时的字节 → 字符映射），
         * 而它是否真管用，目前只有 `kb-package-deps.spec.ts` 那条「cmaps 不被裁掉」
         * 的守卫 + 手工造的中文 PDF 能证明。**留一条已知空白，别假装验过了。**
         */
        if (name.endsWith('.docx') || name.endsWith('.xlsx')) {
          expect(/[\u4e00-\u9fff]/.test(text), `${name} 抽出来的正文里一个汉字都没有`).toBe(true)
        }
      }
    } finally {
      db.close()
    }

    // 三个文件各自能被搜到。检索走的是**正文**（块文本 + 小节标题），不是文件名 ——
    // 所以查询词必须真的出现在正文里：那份 PDF 是英文样本，用它文件名里的「报告」搜不到。
    const queries: Array<[string, string]> = [
      ['测试报告.pdf', 'Test Report'],
      ['项目计划书.docx', '项目'],
      ['员工名单.xlsx', '员工'],
    ]
    for (const [name, q] of queries) {
      const r = searchKb(decrypted, 1, { query: q })
      const names = r.hits.map((h) => h.fileName)
      report.push(`检索「${q}」→ ${r.hits.length} 条命中：${[...new Set(names)].join(', ')}`)
      expect(names, `「${q}」搜不到 ${name}`).toContain(name)
    }
  }, 60_000)

  it('目录里其余文件如实分档：该收的收下、该拒的拒绝（不许静默假成功）', async () => {
    const entries = readdirSync(SAMPLES)
    const accepted: string[] = []
    const rejected: string[] = []
    // 落在**二号库**：去重是按 `(kb_id, sha256)` 判的，而上面那个用例已经把三个 B 档
    // 真文件登记进 1 号库了 —— 同一个库会直接判 `duplicate`（第一版就是这么红的）。
    // 顺带也就验了「同一个文件可以进不同的库」这条跨库语义。
    const KB2 = 2
    for (const name of entries) {
      const ext = extname(name).replace(/^\./, '').toLowerCase()
      if (!isAcceptedExt(ext)) { rejected.push(name); continue }
      const dst = join(srcDir, 'rest-' + name)
      copyFileSync(join(SAMPLES, name), dst)
      const r = registerKbFile(decrypted, { kbId: KB2, srcPath: dst })
      expect(r.ok, `${name} 在白名单里却登记失败：${r.code} ${r.error}`).toBe(true)
      accepted.push(name)
    }
    const rep = await drainKbQueue(decrypted)
    report.push(`\n其余文件（进 2 号库）：收下 ${accepted.length} 个（${accepted.join(', ')}）`)
    report.push(`如实拒绝 ${rejected.length} 个（不在白名单）：${rejected.join(', ')}`)
    report.push(`drain：processed=${rep.processed} ready=${rep.ready} unsupported=${rep.unsupported} failed=${rep.failed}`)

    const db = new DatabaseSync(kbFilesDbPath(decrypted))
    try {
      for (const name of accepted) {
        const row = db.prepare(
          'SELECT parse_state, parser, chunk_count FROM kb_files WHERE name = ? AND kb_id = ?',
        ).get('rest-' + name, KB2) as Record<string, unknown> | undefined
        report.push(`  rest-${name}: state=${String(row?.['parse_state'])} parser=${String(row?.['parser'])} chunks=${String(row?.['chunk_count'])}`)
        // 收下 ≠ 一定能解：`unsupported`（抽不出正文，如空的 xlsx）是诚实的结果，
        // 但**不许**是 `failed` —— 白名单里的类型不该「读不动」。
        expect(['ready', 'unsupported'], `rest-${name} 落到了 ${String(row?.['parse_state'])}`).toContain(String(row?.['parse_state']))
      }
    } finally {
      db.close()
    }
    // 防空转：目录里必须真的有被收下的东西，否则上面整段是空集。
    expect(accepted.length, '一个文件都没被收下 —— 样本目录或白名单漂了').toBeGreaterThan(0)
    expect(rejected.length, '一个都没被拒 —— 说明白名单宽到把 pptx/rtf 都收了').toBeGreaterThan(0)
  }, 60_000)

  it('把报告落盘（证据留痕，控制台会被 cp936 二次编码，不可靠）', () => {
    const dir = join(process.cwd(), 'working')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'd8-real-samples.txt'), report.join('\n'), 'utf8')
    expect(report.length).toBeGreaterThan(0)
  })
})
