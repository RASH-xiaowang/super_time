/**
 * B 档（PDF / Word / Excel）的**端到端**用例 —— 阶段 D · G-03 / G-05 / H3 / H4。
 *
 * 与 `kb-parse-b.spec.ts` 的分工（那一支的头注末行就把这里点名了）：
 *   · 那一支**不碰盘、不碰库**：钉「字节 → 段」这一层（解析器是纯函数）；
 *   · 本支从 `registerKbFile` 起走**与线上完全相同**的那条路
 *     （读字节 → 落 blob → 落 queued 行 → 执行器认领 → 解析 → 分块 → 落 chunk + FTS），
 *     钉的是「真文件真能进检索」。
 *
 * 为什么这一支不可省（它挡的是三类「单测全绿而功能是坏的」）：
 *   ① **分派接线**：扩展名 → 异步解析器这条路由只写在 `parse-async.ts`，
 *      若哪天被改回同步（或 `isAsyncParsableExt` 与 `PENDING_PARSER_EXTS` 漂了），
 *      纯函数用例照样全绿，而 PDF 永远停在 `queued` —— 界面上是「等待解析」不动；
 *   ② **状态机的可观察性**：`queued → parsing → chunking → ready` 每一格都代表一件
 *      已发生的事。纯函数用例看不见状态，坏掉的表现是「一直转圈」而不是报错；
 *   ③ **H4 的非阻塞承诺**：「解析一份大 PDF 期间 `listKbFiles` 仍在 200ms 内返回」
 *      是**同时性**的性质，只有把解析真的挂在半途、再去调另一个接口才测得出来。
 *
 * 输入是 `tests/fixtures/kb-b/` 的真夹具（与 `kb-parse-b.spec.ts` 同一批、
 * 由 `working/gen-kb-b-fixtures.py` 可复现）。刻意用真夹具而不是内联字符串：
 * 这三档的输入是容器格式，内联字符串走不到解析器里。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kbFilesDbPath, listKbFiles, registerKbFile, resetRecoveryGuardForTest } from '../src/query/kb-files.ts'
import { drainKbQueue, resetQueueGuardForTest } from '../src/query/kb-queue.ts'
import { searchKb } from '../src/query/kb-search.ts'

/** 夹具目录（真文件，随仓库提交）——与 `kb-parse-b.spec.ts` 同一份。 */
const FIXTURES = fileURLToPath(new URL('./fixtures/kb-b/', import.meta.url))

let root = ''
/** 解密数据根（库、blob、FTS 都落在它下面）。 */
let decrypted = ''
/** 「用户电脑上的某处」：夹具在这里被复制成待登记的原文件。 */
let srcDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-e2e-'))
  decrypted = join(root, 'data', 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  // 两处进程内记忆都要清：本支每个用例都是「一次全新的进程启动」，
  // 不清的话「只做一次」的守卫（崩溃恢复 / 队列在跑）会把用例之间的顺序带进来。
  resetRecoveryGuardForTest()
  resetQueueGuardForTest()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 把夹具复制成原文件（真拷贝：登记读的是这个路径下的字节）。 */
function put(name: string): string {
  const dst = join(srcDir, name)
  copyFileSync(join(FIXTURES, name), dst)
  return dst
}

/** 登记夹具并断言受理成功（失败就把原因抛出来，免得用例在「少了一个文件」的状态下空转）。 */
function add(name: string, kbId = 1): number {
  const r = registerKbFile(decrypted, { kbId, srcPath: put(name) })
  if (!r.ok || r.file === undefined) throw new Error(`夹具登记失败：${name} → ${r.code}: ${r.error}`)
  return r.file.id
}

/** 三个 B 档真夹具（各含一句只可能出现在自己那里的内容）。 */
const THREE = ['季度报告.pdf', '项目周报.docx', '设备台账.xlsx'] as const

/** 直接读库拿某一行的解析状态（断言落在**落盘的事实**上，而不是返回值上）。 */
function rowOf(name: string): { state: string; parser: string; error: string; chunks: number; chars: number } {
  const db: DatabaseSync = new DatabaseSync(kbFilesDbPath(decrypted))
  try {
    const r = db.prepare(
      'SELECT parse_state AS s, parser AS p, parse_error AS e, chunk_count AS c, char_count AS cc FROM kb_files WHERE name = ?',
    ).get(name) as Record<string, unknown> | undefined
    if (r === undefined) throw new Error('库里没有这一行：' + name)
    return {
      state: String(r['s'] ?? ''),
      parser: String(r['p'] ?? ''),
      error: String(r['e'] ?? ''),
      chunks: Number(r['c'] ?? 0),
      chars: Number(r['cc'] ?? 0),
    }
  } finally {
    db.close()
  }
}

/**
 * 某个文件在 `kb_chunks` 里的**实际**块数与字符数。
 *
 * 为什么要跟 `kb_files` 里的汇总列分开算：那两个数是直接显示给用户的
 * （「已就绪 · 12 块 · 3.4 千字」），若哪天写入路径只更新了一边，用户看到的
 * 是一个**没人能对账**的数字 —— 用例对着汇总列断言是查不出来的（它自证不了）。
 */
function actualOf(name: string): { chunks: number; chars: number } {
  const db: DatabaseSync = new DatabaseSync(kbFilesDbPath(decrypted))
  try {
    const r = db.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(c.text)), 0) AS cc FROM kb_chunks c '
      + 'JOIN kb_files f ON f.id = c.file_id WHERE f.name = ?',
    ).get(name) as Record<string, unknown>
    return { chunks: Number(r['n'] ?? 0), chars: Number(r['cc'] ?? 0) }
  } finally {
    db.close()
  }
}

describe('登记 → 排队 → 解析 → 可检索（H3 的主链路）', () => {
  it('三个真文件登记后都停在 queued、0 块（登记**不当场**解析 —— 这是 H4 的前提）', () => {
    for (const name of THREE) {
      const id = add(name)
      expect(id).toBeGreaterThan(0)
      const row = rowOf(name)
      expect(row.state, `${name} 被当场解析了：B 档必须排队（否则对话框会冻住）`).toBe('queued')
      expect(row.parser).toBe('')
      expect(row.chunks).toBe(0)
      expect(row.chars).toBe(0)
    }
    // 队列里三行都在等着（这是「登记成功」与「被解析」之间那段等待的可见形态）。
    const snap = listKbFiles(decrypted, 1)
    expect(snap.readError).toBeUndefined()
    expect(snap.items.filter((f) => f.parseState === 'queued').map((f) => f.name).sort())
      .toEqual([...THREE].sort())
  })

  it('drainKbQueue 把它们全部推到 ready，且各自用了对的解析器', async () => {
    for (const name of THREE) add(name)
    const report = await drainKbQueue(decrypted)
    expect(report.skipped).toBe(false)
    expect(report.processed).toBe(3)
    expect({ ready: report.ready, unsupported: report.unsupported, failed: report.failed })
      .toEqual({ ready: 3, unsupported: 0, failed: 0 })

    // 三个解析器各认领自己的那一份 —— 这条同时钉住「扩展名 → 解析器」的分派表。
    expect(rowOf('季度报告.pdf').parser).toBe('pdfjs')
    expect(rowOf('项目周报.docx').parser).toBe('mammoth')
    expect(rowOf('设备台账.xlsx').parser).toBe('xlsx')

    for (const name of THREE) {
      const row = rowOf(name)
      expect(row.state, `${name} 没到 ready`).toBe('ready')
      expect(row.chunks, `${name} 一块都没落`).toBeGreaterThan(0)
      expect(row.chars, `${name} 正文是空的`).toBeGreaterThan(0)
      // `ready` 必须可读：不许留一句英文异常或空串。
      expect(row.error).not.toMatch(/Error|undefined|\[object/)
      // 汇总列与真实块行**对得上**（这两个数是直接显示给用户的，对不上就是假读数）。
      expect(actualOf(name), `${name} 的 chunk_count / char_count 与真实块行对不上`).toEqual({
        chunks: row.chunks,
        chars: row.chars,
      })
    }
  })

  it('★ FTS 真的搜得到：三份文件各自的独有内容都能命中它自己（H3 的证据）', async () => {
    for (const name of THREE) add(name)
    await drainKbQueue(decrypted)

    // 每份文件配一句只可能出现在它那里的内容：
    //   PDF 第 2 页的英文句子、Word 里 h2 节下的那条进展、Excel 单元格里的设备名。
    // 三句都要命中，且命中的必须是**对应的那一份**（否则「搜到了」可能只是别的文件带的词）。
    const cases: Array<{ file: string; query: string }> = [
      { file: '季度报告.pdf', query: 'Warehouse' },
      { file: '项目周报.docx', query: '玄武区交付节点' },
      { file: '设备台账.xlsx', query: '高压清洗机' },
    ]
    for (const c of cases) {
      const r = searchKb(decrypted, 1, { query: c.query })
      expect(r.error, `${c.query} 检索报错`).toBeUndefined()
      expect(r.hits.length, `「${c.query}」一条都没搜到 —— 内容没进索引`).toBeGreaterThan(0)
      expect(r.hits[0]?.fileName, `「${c.query}」命中的不是 ${c.file}`).toBe(c.file)
      // 摘要要带出命中处（marks 由后端算，前端只渲染）。
      expect(r.hits[0]?.snippet.length, '摘要为空 —— 界面上会是「搜到了但看不到内容」').toBeGreaterThan(0)
    }

    // 反面：库里搜不到的内容必须一条都没有（否则上面的「命中」可能来自噪声索引）。
    expect(searchKb(decrypted, 1, { query: '不存在的生僻短语甲乙丙丁' }).hits).toEqual([])
  })

  it('PDF 的页码一路带到检索结果里（点开能定位到第几页）', async () => {
    add('季度报告.pdf')
    await drainKbQueue(decrypted)
    const hit = searchKb(decrypted, 1, { query: 'Warehouse' }).hits[0]
    expect(hit?.page, 'PDF 命中要能说出页码').toBe(2)
    expect(hit?.fileExt).toBe('pdf')
  })

  it('原文件被删掉也不影响：解析读的是登记那一刻的 blob 副本', async () => {
    // 不变量 ①（`kb-files.ts`）：副本是登记那一刻的字节，原文件之后改名 / 移动 /
    // 删除都不该影响入库的内容。这条如果不成立，用户整理一次文件夹就会丢掉正文。
    add('项目周报.docx')
    unlinkSync(join(srcDir, '项目周报.docx'))
    const report = await drainKbQueue(decrypted)
    expect(report.ready).toBe(1)
    expect(rowOf('项目周报.docx').state).toBe('ready')
    expect(searchKb(decrypted, 1, { query: '玄武区交付节点' }).hits.length).toBeGreaterThan(0)
  })

  it('再 drain 一次是空转（processed = 0）—— 队列不会重复解析已就绪的文件', async () => {
    for (const name of THREE) add(name)
    expect((await drainKbQueue(decrypted)).processed).toBe(3)
    const again = await drainKbQueue(decrypted)
    expect(again.processed).toBe(0)
    expect(again.ready).toBe(0)
    // 也不能重复插入 chunk：重复解析会让同一段正文在检索里出现两次。
    const snap = listKbFiles(decrypted, 1)
    expect(snap.items.reduce((n, f) => n + f.chunkCount, 0))
      .toBe(THREE.reduce((n, name) => n + rowOf(name).chunks, 0))
  })
})

describe('H4：解析期间别的接口不被挡住', () => {
  it('★ 解析在途时 listKbFiles 仍能立刻返回（不是在「全解完」之后才回）', async () => {
    for (const name of THREE) add(name)
    // 不 await：让执行器真的挂在解析途中，再去调另一个接口。
    const pending = drainKbQueue(decrypted)

    const started = Date.now()
    const snap = listKbFiles(decrypted, 1)
    const elapsed = Date.now() - started

    const report = await pending
    // 防空转：必须真的有一批活正在被处理，否则「查询很快」毫无意义（空库也很快）。
    expect(report.processed).toBeGreaterThan(0)
    expect(snap.readError).toBeUndefined()
    expect(snap.total).toBe(3)
    // 计划 H4 的验收口径是 200ms。这里刻意留得更紧（50ms）：同步实现会把这句
    // 拖到与解析同样的量级（几百毫秒到几秒），两种情况差着两个数量级，不会误判。
    expect(elapsed, `解析在途时 listKbFiles 用了 ${elapsed}ms —— 解析又回到调用栈里了`).toBeLessThan(50)
  })
})

describe('失败分档：读不动 → failed，抽不出正文 → unsupported（两者用户动作不同）', () => {
  it('截断的 xlsx / 被改名的 pdf ⇒ failed，且 parse_error 是人话（不挂起、不假成功）', async () => {
    // 截断：SheetJS 曾在这一条上**永久挂起**（同步阻塞事件循环），所以整条
    // `drainKbQueue` 都会跟着卡住 —— 这里给一个短超时，让「挂起」被明确归因到这一条。
    const full = readFileSync(join(FIXTURES, '设备台账.xlsx'))
    writeFileSync(join(srcDir, '截断的设备台账.xlsx'), full.subarray(0, 40))
    // 改名：ZIP 合法，但里面没有 xl/workbook.xml。
    copyFileSync(join(FIXTURES, '季度报告.pdf'), join(srcDir, '季度报告.xlsx'))

    for (const name of ['截断的设备台账.xlsx', '季度报告.xlsx']) {
      const r = registerKbFile(decrypted, { kbId: 1, srcPath: join(srcDir, name) })
      expect(r.ok, `${name} 应该能登记（登记只落副本，读不读得动是解析的事）`).toBe(true)
    }
    const report = await drainKbQueue(decrypted)
    expect(report.processed).toBe(2)
    expect({ ready: report.ready, unsupported: report.unsupported, failed: report.failed })
      .toEqual({ ready: 0, unsupported: 0, failed: 2 })

    const trunc = rowOf('截断的设备台账.xlsx')
    expect(trunc.state).toBe('failed')
    expect(trunc.chunks).toBe(0)
    expect(trunc.error).toContain('不完整')

    const renamed = rowOf('季度报告.xlsx')
    expect(renamed.state).toBe('failed')
    expect(renamed.error).toContain('不是有效的 Excel 工作簿')
    // 文案纪律：`failed` 也要说清「为什么会这样 + 该做什么」，不许出现英文栈信息。
    for (const name of ['截断的设备台账.xlsx', '季度报告.xlsx']) {
      expect(rowOf(name).error).not.toMatch(/at [A-Za-z]+ \(|\.mjs|\.js:\d+/)
    }
  }, 15_000)

  it('空白 PDF / 空台账 ⇒ unsupported（有格式没正文，不是失败）', async () => {
    for (const name of ['空白.pdf', '空台账.xlsx']) {
      const r = registerKbFile(decrypted, { kbId: 1, srcPath: put(name) })
      expect(r.ok).toBe(true)
    }
    const report = await drainKbQueue(decrypted)
    expect({ ready: report.ready, unsupported: report.unsupported, failed: report.failed })
      .toEqual({ ready: 0, unsupported: 2, failed: 0 })

    for (const name of ['空白.pdf', '空台账.xlsx']) {
      const row = rowOf(name)
      expect(row.state, `${name} 该记 unsupported`).toBe('unsupported')
      // 文案纪律：这两档都不能说「损坏」（用户会去重做文件，而重做没有用）。
      expect(row.error).not.toContain('损坏')
      expect(row.error.length).toBeGreaterThan(0)
    }
    // 扫描件提示要指向 OCR（本机没做），而不是含糊的「解析失败」。
    expect(rowOf('空白.pdf').error).toContain('OCR')
  })

  it('一处失败不拖累别人：同一轮里 failed 与 ready 并存', async () => {
    add('项目周报.docx')
    copyFileSync(join(FIXTURES, '季度报告.pdf'), join(srcDir, '同名报告.xlsx'))
    registerKbFile(decrypted, { kbId: 1, srcPath: join(srcDir, '同名报告.xlsx') })

    const report = await drainKbQueue(decrypted)
    expect({ ready: report.ready, failed: report.failed }).toEqual({ ready: 1, failed: 1 })
    expect(rowOf('项目周报.docx').state).toBe('ready')
    expect(rowOf('同名报告.xlsx').state).toBe('failed')
  })
})

/**
 * 撞锁 = **暂态**，不是「这份文件坏了」。
 *
 * 这一支挡的是一个真机实测到过的坏法：写库那一步撞上 `SQLITE_BUSY` 时，
 * `runJob` 会把**已经解析成功**的成果整份丢掉并把该行判 `failed`
 * —— 用户看到「解析失败」，实际文件毫无问题，他得移掉再重新添加才能恢复。
 *
 * 造锁的手法与真机同源：`wechat_kb_files.db` 是 **rollback journal**（不是 WAL），
 * 写侧要拿到排他锁才能 `COMMIT`。另开一条连接执行 `BEGIN` + 一次 `SELECT`，
 * 它就握着 SHARED 锁不放，直到 `COMMIT`。这不是模拟 —— 探针在高频只读轮询下
 * 就是在真机上这么撞的。
 */
describe('撞锁重试：别的连接正读着库，也不许把解析成果判死', () => {
  it('★ 对端握着读锁 60ms 时，文件照样收敛到 ready（重试吃掉暂态失败）', async () => {
    add('季度报告.pdf')

    const hog: DatabaseSync = new DatabaseSync(kbFilesDbPath(decrypted))
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      try {
        hog.exec('COMMIT')
      } catch {
        /* 已经放开过 */
      }
      try {
        hog.close()
      } catch {
        /* 已关 */
      }
    }

    hog.exec('BEGIN')
    hog.prepare('SELECT COUNT(*) AS n FROM kb_files').get() // 拿到 SHARED 锁，一直不放

    // 60ms：晚于第 2 次尝试（t≈40ms）、早于第 3 次（t≈120ms），两边都有余量。
    const timer = setTimeout(release, 60)
    const spy = vi.spyOn(console, 'warn')
    try {
      const report = await drainKbQueue(decrypted)
      const warned = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')

      // 先证「锁真的造出来了」—— 少了这一条，用例会因为「碰巧没撞上」而假绿。
      expect(warned, '这一次没撞上锁，用例失去意义（说明造锁手法失效了）').toContain('被占用')
      // 再证产品行为：重试之后**没有**任何一份被判死，且正文真的落了库。
      expect(report.failed).toBe(0)
      expect(report.ready).toBe(1)
      const row = rowOf('季度报告.pdf')
      expect(row.state).toBe('ready')
      expect(row.error).not.toContain('database is locked')
      expect(row.chunks).toBeGreaterThan(0)
      expect(actualOf('季度报告.pdf').chunks).toBe(row.chunks)
    } finally {
      clearTimeout(timer)
      release()
      spy.mockRestore()
    }
  }, 15_000)

  it('三个写库步骤都包了重试（源码锚点：提交那一步的行为测不稳，但漏包要抓得到）', () => {
    /**
     * 为什么这条读**源码**而不是再跑一次真争用：`commitReady` 只在解析完的那一刻才执行，
     * 而一次锁窗口只能盖住一个步骤 —— 想让它专门盖住提交，就得让「造锁的时机」追上
     * 「解析什么时候结束」，那是一个必然抖动的赛跑（用例会变成偶然绿）。
     * 上面那条真争用用例钉住了**机制**（撞上 BUSY ⇒ 重试 ⇒ 仍 ready），
     * 这条钉住**接线**（三个写步骤都还在 `withBusyRetry` 里，谁被删了都报红）。
     */
    const src = readFileSync(fileURLToPath(new URL('../src/query/kb-queue.ts', import.meta.url)), 'utf8')
    // 认领（autocommit 的 UPDATE，真机上探针轮询时最容易撞的一步）
    expect(src, '认领那一步没走 withBusyRetry').toContain("withBusyRetry('认领下一份'")
    // 提交（真机上 `季度报告.pdf` 真正失败的那一步）
    expect(src, '写入分块与就绪状态没走 withBusyRetry').toContain("withBusyRetry(\n      '写入分块与就绪状态'")
    // 记状态（撞锁时留下的会是一行假 `chunking`）
    expect(src, 'markState 没把 markStateOnce 交给 withBusyRetry')
      .toContain('() => markStateOnce(decryptedDir, id, state, parser, note, chunkCount, charCount)')
  })

  it('重试只吃「锁占用」：真正读不动的文件仍然判 failed（不许把永久错误也重试掉）', async () => {
    // 截断的文件 ⇒ 解析器抛「不是有效的…」；这条错**不带** errcode 5/6，
    // 所以必须原样抛出去、原样判死。若把重试写成「什么都重试」，
    // 这里会变成「重试 5 次后仍失败」，用户等多 400ms 才看到同一句话。
    copyFileSync(join(FIXTURES, '设备台账.xlsx'), join(srcDir, '截断报告.xlsx'))
    writeFileSync(join(srcDir, '截断报告.xlsx'), readFileSync(join(srcDir, '截断报告.xlsx')).subarray(0, 700))
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: join(srcDir, '截断报告.xlsx') })
    expect(r.ok).toBe(true)

    const spy = vi.spyOn(console, 'warn')
    try {
      const report = await drainKbQueue(decrypted)
      expect(report.failed).toBe(1)
      expect(rowOf('截断报告.xlsx').state).toBe('failed')
      expect(spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toContain('被占用')
    } finally {
      spy.mockRestore()
    }
  }, 15_000)
})
