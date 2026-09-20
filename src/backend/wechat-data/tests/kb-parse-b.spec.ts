/**
 * B 档解析器（PDF / Word / Excel）的回归用例 —— 阶段 D · D3 / D4 / D5。
 *
 * 输入是**真格式的夹具**（`tests/fixtures/kb-b/`，由 `working/gen-kb-b-fixtures.py`
 * 用 Python 标准库生成、产物入库、逐字节可复现）。为什么不内联字符串：
 * 这三档的输入是容器格式（PDF 对象流 / OOXML 的 ZIP / SpreadsheetML），
 * 内联字符串根本走不到那三支解析器 —— 那样写出来的用例只会测到「函数能被调用」。
 *
 * 这一支**不碰盘、不碰库**（解析器是纯函数），钉的是「字节 → 段」这一层：
 *   ① PDF 逐页抽取、`page` 非 0（设计稿要求命中结果能显示页码）；
 *   ② docx 的标题进面包屑、表格**不被拆成一个个单元格**；
 *   ③ xlsx 多工作表都进、空工作表跳过、表名进 `heading`；
 *   ④ 「抽不到正文」（`unsupported`）与「读不动」（抛出 ⇒ 记 `failed`）是两种失败，
 *      且前者文案**不许**说「文件损坏」。
 * 落库那一侧（`parse_state` 的推进、FTS 真能搜到）在 `kb-b-endtoend.spec.ts`。
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chunkBlocks } from '../src/query/kb/chunk.ts'
import { assertExcelContainer, assertWordContainer, sniffContainer } from '../src/query/kb/container-guard.ts'
import { parseFileByExtAsync, isAnyParsableExt, isAsyncParsableExt } from '../src/query/kb/parse-async.ts'
import { parseDocx } from '../src/query/kb/parse-docx.ts'
import { parsePdf } from '../src/query/kb/parse-pdf.ts'
import { parseFileByExt } from '../src/query/kb/parse-plain.ts'
import { parseXlsx } from '../src/query/kb/parse-xlsx.ts'
import { PENDING_PARSER_EXTS, isAcceptedExt, isParsableExt } from '../src/query/kb/types.ts'

/** 夹具目录（真文件，随仓库提交）。 */
const FIXTURES = fileURLToPath(new URL('./fixtures/kb-b/', import.meta.url))

/** 读一份夹具的字节。 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES + name))
}

describe('注册表：B 档是「能解，但不能**同步**解」', () => {
  it('两档分工：isAsyncParsableExt 认它、isParsableExt 不认它、用户能选它', () => {
    for (const ext of PENDING_PARSER_EXTS) {
      expect(isAsyncParsableExt(ext), `${ext} 该走异步解析`).toBe(true)
      expect(isAnyParsableExt(ext), `${ext} 该被判为「有解析出路」`).toBe(true)
      expect(isAcceptedExt(ext), `${ext} 该在白名单里（否则用户选不进来）`).toBe(true)
      // `isParsableExt` 的语义是「**同步**可解」，B 档不属于它 —— 这条同时钉住
      // `registerKbFile` 的分流依据（它靠这个判断「当场解」还是「排队」）。
      expect(isParsableExt(ext), `${ext} 被误判成同步可解，分流会走错`).toBe(false)
    }
  })

  it('异步档与 PENDING_PARSER_EXTS 是同一个集合（多一个 / 少一个都算漂）', () => {
    const probe = [
      ...PENDING_PARSER_EXTS,
      'txt', 'md', 'csv', 'html', 'htm', 'png', 'jpg', 'zip', 'doc', 'wps', '', 'PDF',
      // 原型链上的键：扩展名是用户可控的字符串，`.constructor` 是合法文件名。
      'constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf',
    ]
    for (const ext of probe) {
      const expected = (PENDING_PARSER_EXTS as readonly string[]).includes(ext)
      expect(isAsyncParsableExt(ext), `${ext} 的档位判断与注册表不一致`).toBe(expected)
    }
  })
})

describe('pdfjs：逐页抽取，page 非 0', () => {
  it('三页的 PDF 抽成三段，页码 1 / 2 / 3 各归各的', async () => {
    const out = await parsePdf(fixture('季度报告.pdf'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('pdfjs')
    expect(out.blocks.map(b => b.page)).toEqual([1, 2, 3])
    // 每段都是正文（PDF 里没有标题语义可提取，heading 只能为空 —— 不假装知道）。
    expect(out.blocks.every(b => b.kind === 'prose' && b.heading === '')).toBe(true)
    // ★ 这一条是「逐页抽取」的实证：第 2 页那句不能跑到第 1 页去。
    expect(out.blocks[1]!.text).toContain('Warehouse throughput reached 12000 parcels per day.')
    expect(out.blocks[2]!.text).toContain('Supplier concentration remains the top risk.')
    expect(out.blocks[0]!.text).toContain('Revenue grew by 18 percent')
  })

  it('页码一直带到分块产物里（检索结果要靠它定位）', async () => {
    const out = await parsePdf(fixture('季度报告.pdf'))
    const res = chunkBlocks(out.blocks)
    expect(res.chunkCount).toBe(3)
    expect(res.chunks.map(c => c.page)).toEqual([1, 2, 3])
  })

  it('★ 中文 CID PDF（无 ToUnicode）抽得出汉字 —— 少传 cMapUrl 会整页抽成空', async () => {
    // 这条钉的是阶段 D 收尾实测到的一个真缺陷：`getDocument` 少传 `cMapUrl` 时，
    // 「CID 字体（`/Encoding /UniGB-UCS2-H` + `/Ordering (GB1)`）且**不带 ToUnicode**」
    // 的中文 PDF 会把整页抽成空串，于是被判成 `unsupported`，界面上说
    // 「多半是扫描件或纯图片」—— **与事实相反**：这份文件有完整的文字层。
    // 危害不是「少抽了点字」，而是用户拿着完好的文件去反复重新导出。
    //
    // 为什么必须先钉夹具的字节特征：若有人用普通字体重造这份 PDF，
    // 不接 cmaps 也照样能抽出字，这条用例会**静默变成假绿**。
    // 所以先断言它仍是那个「硬案例」——三个特征缺一不可。
    const pdfRaw = readFileSync(FIXTURES + '中文地层报告.pdf').toString('latin1')
    expect(pdfRaw).toContain('/Subtype /Type0')          // 复合字体（单字节表处理不了）
    expect(pdfRaw).toContain('/Encoding /UniGB-UCS2-H')  // 双字节 UCS-2 编码
    expect(pdfRaw).toContain('/Ordering (GB1)')           // CIDSystemInfo → Adobe-GB1
    expect(pdfRaw).not.toContain('/ToUnicode')            // ★ 没有它，字节→汉字只能靠 cmaps

    const out = await parsePdf(fixture('中文地层报告.pdf'))
    expect(out.state).toBe('ready')                       // 修之前这里是 unsupported
    expect(out.parser).toBe('pdfjs')
    // 跨页：两页各一段，页码 1 / 2 各归各的（与英文夹具同一口径）。
    expect(out.blocks.map(b => b.page)).toEqual([1, 2])
    // ★ 核心断言：汉字必须是**真的汉字**（不是 \uFFFD、不是空串）。
    // `玄武岩层理` 这四个字在文件里是 2 字节 CID，唯一映射依据就是 cmaps。
    expect(out.blocks[0]!.text).toContain('玄武岩层理构造')
    expect(out.blocks[1]!.text).toContain('复核结论：玄武岩层理 与邻区剖面可比。')
    // 同页的 ASCII 也一并抽到 —— 防「整页只剩汉字」这种另一种坏法。
    expect(out.blocks[0]!.text).toContain('CidFixtureMarker')
    // 误判成扫描件是这次缺陷的表现形式，单独钉住那句文案不许出现。
    expect(out.note).not.toContain('OCR')

    // 页码一路带到分块产物（检索结果要靠它定位）。
    const res = chunkBlocks(out.blocks)
    expect(res.chunkCount).toBe(2)
    expect(res.chunks.map(c => c.page)).toEqual([1, 2])
  }, 30000)

  it('格式对但一个字都抽不出来 ⇒ unsupported（扫描件），文案不许说「损坏」', async () => {
    const out = await parsePdf(fixture('空白.pdf'))
    expect(out.state).toBe('unsupported')
    expect(out.blocks).toEqual([])
    expect(out.note.length).toBeGreaterThan(0)
    expect(out.note).toContain('OCR')
    expect(out.note).not.toContain('损坏')
    expect(out.note).not.toContain('失败')
  })

  it('读不动（不是 PDF）⇒ **抛出**，由执行器记 failed —— 这是另一种失败', async () => {
    // 与上一条刻意成对：同样「没有正文」，但原因一个是「本机没做 OCR」、
    // 一个是「这份文件根本不是 PDF」，用户该做的事完全不同。
    await expect(parsePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 9, 9, 9])))
      .rejects.toThrow()
  })
})

describe('mammoth：标题进面包屑，表格独占一块', () => {
  it('h1 / h2 决定 breadcrumb，正文块各自继承所在节', async () => {
    const out = await parseDocx(fixture('项目周报.docx'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('mammoth')

    const byText = (needle: string) => out.blocks.find(b => b.text.includes(needle))
    expect(byText('玄武区交付节点')?.heading).toBe('项目周报 › 本周进展')
    expect(byText('盘点差异 37 件')?.heading).toBe('项目周报 › 本周进展')
    // ★ h1 之后 h2 必须被清掉：写成 `项目周报 › 下周计划` 就是面包屑没清栈的经典症状。
    expect(byText('完成三季度复盘材料')?.heading).toBe('下周计划')
  })

  it('表格是一个 kind:table 段，不是一堆「每个单元格一段」', async () => {
    const out = await parseDocx(fixture('项目周报.docx'))
    const tables = out.blocks.filter(b => b.kind === 'table')
    expect(tables.length).toBe(1)
    expect(tables[0]!.text.split('\n')[0]).toBe('负责人\t事项\t截止日')
    expect(tables[0]!.text).toContain('张伟\t交付验收\t10 月 12 日')
    // 拆开的话「张伟」会独立成段 —— 那一块脱离表头后对模型毫无意义。
    expect(out.blocks.some(b => b.text.trim() === '张伟')).toBe(false)
  })

  it('表格块分块后**表头与数据在同一块里**，且面包屑带上「列名」', async () => {
    const out = await parseDocx(fixture('项目周报.docx'))
    const res = chunkBlocks(out.blocks)
    const tableChunk = res.chunks.find(c => c.text.includes('负责人'))
    expect(tableChunk).toBeDefined()
    expect(tableChunk!.text).toContain('张伟')
    expect(tableChunk!.heading).toBe('项目周报 › 遗留问题 › 列名 负责人\t事项\t截止日')
  })

  it('读不动（不是 zip / 拷了一半 / 是别的 Office 文件改了扩展名）⇒ **抛出**', async () => {
    await expect(parseDocx(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/不是有效的 Word 文档/)
    // 截断：预检直接给「内容不完整」，而不是 jszip 那句英文 ——
    // 这句文案会进 `kb_files.parse_error` 显示给用户，必须是他能照着做的一句话。
    await expect(parseDocx(fixture('项目周报.docx').slice(0, 40))).rejects.toThrow(/不完整/)
    // 改名的 xlsx：ZIP 合法，但里面没有 word/document.xml。
    await expect(parseDocx(fixture('设备台账.xlsx'))).rejects.toThrow(/word\/document\.xml/)
  })
})

describe('SheetJS：多工作表都进、空表跳过', () => {
  it('两张有数据的表各成一段，表名进 heading；空表不产生段', async () => {
    const out = await parseXlsx(fixture('设备台账.xlsx'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('xlsx')
    expect(out.blocks.map(b => b.heading)).toEqual(['设备台账', '耗材清单'])
    expect(out.blocks.every(b => b.kind === 'table' && b.page === 0)).toBe(true)
    // 表名之外的说明要如实写出来（用户会问「我的空白表怎么没了」）。
    expect(out.note).toContain('1 个工作表是空的')
  })

  it('单元格值取**显示文本**而不是原始值（日期不能变成序列号）', async () => {
    // 夹具里的值本身都是 inlineStr（真样本 `员工名单.xlsx` 也是这种写法，
    // 没有 sharedStrings.xml）—— 这条同时证明「内联字符串被正确读出」。
    const out = await parseXlsx(fixture('设备台账.xlsx'))
    const first = out.blocks[0]!.text
    expect(first.split('\n')[0]).toBe('设备编号\t名称\t存放位置\t状态')
    expect(first).toContain('EQ-1002\t高压清洗机\t二层库房\t维修中')
  })

  it('多表分块后每块各自带着自己那张表的表头与表名', async () => {
    const out = await parseXlsx(fixture('设备台账.xlsx'))
    const res = chunkBlocks(out.blocks)
    expect(res.chunks.length).toBe(2)
    expect(res.chunks[0]!.heading).toBe('设备台账 › 列名 设备编号\t名称\t存放位置\t状态')
    expect(res.chunks[1]!.heading).toBe('耗材清单 › 列名 耗材名称\t规格\t库存')
    expect(res.chunks[1]!.text.split('\n')[0]).toBe('耗材名称\t规格\t库存')
  })

  it('工作表全是空的 ⇒ unsupported（不是 ready + 0 块：那会显示成「已就绪」）', async () => {
    const out = await parseXlsx(fixture('空台账.xlsx'))
    expect(out.state).toBe('unsupported')
    expect(out.blocks).toEqual([])
    expect(out.note).toContain('都是空的')
    expect(out.note).not.toContain('损坏')
    expect(out.note).not.toContain('失败')
  })

  it('读不动（不是工作簿）⇒ **抛出**（记 failed，不是 unsupported）', async () => {
    // 这几条钉的是 SheetJS 的「宽容」：它**不抛**，而是静默回退到 HTML/CSV 解析器，
    // 于是我们在加预检之前会把一份根本不是工作簿的文件显示成「已就绪」——
    // 假成功比报错更坏（用户会以为它进了检索，实际搜到的是一串隐形控制字符）。
    await expect(parseXlsx(new Uint8Array([1, 2, 3]))).rejects.toThrow(/不是有效的 Excel 工作簿/)
    // 把 PDF 当 xlsx 读：SheetJS 会产出一张「每个单元格是一行 PDF 源码」的表，用户能搜到
    // `<< /Type /Catalog >>` 这种当证据 —— 也必须抛。
    await expect(parseXlsx(fixture('季度报告.pdf'))).rejects.toThrow(/不是有效的 Excel 工作簿/)
    await expect(parseXlsx(fixture('项目周报.docx'))).rejects.toThrow(/xl\/workbook\.xml/)
  })

  it('★ 截断的 xlsx ⇒ 立刻抛出，不再挂起（SheetJS 曾在这一条上永久卡死）', async () => {
    // 这是本次修复存在的**首要理由**：实测把 xlsx 截到前 40 字节后交给 SheetJS，
    // 它会永久挂起（子进程 8 秒后被 SIGTERM 强杀）。删掉预检，这一条只会以「超时」
    // 的形式变红 —— 而超时红看不出是谁挂的，所以这里显式给一个短超时，
    // 让「挂起」被明确归因到这一条上。
    await expect(parseXlsx(fixture('设备台账.xlsx').slice(0, 40))).rejects.toThrow(/不完整/)
  }, 5000)
})

/**
 * 预检的**另一个方向**。
 *
 * 上面几段钉的是「该拦的拦住了」；这一段钉的是「不该拦的别拦」——而后者更要紧：
 * 坏文件少报一条错误，用户损失一次点击；好文件进不来，功能就是坏的。
 * 闸门最容易写错的一处是**只认 ZIP**，那会把所有旧版 `.xls` 一起误杀（它们是 OLE2，
 * 不是 ZIP），以及「导出成 HTML 的 .xls」报表（企业系统里极常见）。
 */
describe('容器预检：误杀防线', () => {
  it('三类良性容器都放行：ZIP(.xlsx) / OLE2(旧版 .xls) / markup(SpreadsheetML 与 HTML 报表)', () => {
    // ZIP：真实样本这一侧。
    expect(() => assertExcelContainer(fixture('设备台账.xlsx'))).not.toThrow()
    expect(() => assertExcelContainer(fixture('空台账.xlsx'))).not.toThrow()

    // 旧版 .xls 是 OLE2 复合文档（D0 CF 11 E0 …），**不是 ZIP**。
    // 这里用「真签名 + 足够长度」的字节，只为验闸门的分流；真 .xls 的正文解析
    // 由 SheetJS 负责，不在本用例的射程内（也没有真 .xls 夹具）。
    const ole2 = new Uint8Array(600)
    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
    expect(sniffContainer(ole2)).toBe('ole2')
    expect(() => assertExcelContainer(ole2)).not.toThrow()
    // OLE2 头但体积不足 512 字节 ⇒ 截断（这是闸门唯一会拦 OLE2 的情况）
    expect(() => assertExcelContainer(ole2.slice(0, 100))).toThrow(/不完整/)

    // markup：SpreadsheetML 2003 与「导出成 HTML 却存成 .xls」的报表 —— 两种 SheetJS 都能读。
    const html = new Uint8Array(Buffer.from('<html><table><tr><td>甲</td></tr></table></html>', 'utf8'))
    expect(sniffContainer(html)).toBe('markup')
    expect(() => assertExcelContainer(html)).not.toThrow()
    // 带 BOM 的 XML 工作簿同样放行（真实导出里 BOM 很常见）。
    const xml = new Uint8Array(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"/>', 'utf8'),
    ]))
    expect(sniffContainer(xml)).toBe('markup')
  })

  it('嗅探：认不出来的字节是 unknown，闸门据此说「不是 Excel」而不是「损坏」', () => {
    expect(sniffContainer(new Uint8Array([1, 2, 3]))).toBe('unknown')
    expect(sniffContainer(new Uint8Array(0))).toBe('unknown')
    // `%PDF` 与 `PK\\x03\\x04` 各归各的，不能互相认领。
    expect(sniffContainer(fixture('季度报告.pdf'))).toBe('unknown')
    expect(sniffContainer(fixture('项目周报.docx'))).toBe('zip')
  })
})

describe('异步分派器：A / A′ 档行为逐字节不变，B 档才换路', () => {
  it('A / A′ 档走的就是同步那条路径（结果深等于 parseFileByExt）', async () => {
    const cases: Array<[string, Uint8Array]> = [
      ['txt', new Uint8Array(Buffer.from('甲\n\n乙', 'utf8'))],
      ['md', new Uint8Array(Buffer.from('# 标题\n\n正文。', 'utf8'))],
      ['html', new Uint8Array(Buffer.from('<p>甲</p>', 'utf8'))],
      ['csv', new Uint8Array(Buffer.from('a,b\n1,2', 'utf8'))],
      ['png', new Uint8Array([1, 2, 3])],
      ['zip', new Uint8Array([1, 2, 3])],
      ['', new Uint8Array([1])],
    ]
    for (const [ext, bytes] of cases) {
      expect(await parseFileByExtAsync(ext, bytes), `${ext} 的异步分派改了同步档的行为`)
        .toEqual(parseFileByExt(ext, bytes))
    }
  })

  it('B 档走异步路径：真的解出了段（而不是沿用「本机还没有解析器」那句）', async () => {
    const out = await parseFileByExtAsync('docx', fixture('项目周报.docx'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('mammoth')
  })

  it('.xls 与 .xlsx 指向同一个解析器（旧版二进制流由 SheetJS 一起读）', async () => {
    const out = await parseFileByExtAsync('xls', fixture('设备台账.xlsx'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('xlsx')
  })

  it('★ 依赖没装上 ⇒ unsupported，文案指向**组件**而不是「文件损坏」', async () => {
    // 造一个「装漏了」的现场：抛的正是 Node 在模块缺失时给的那个错误码。
    // 这条路径真实存在（打包白名单漏了 / 用户手工删过 node_modules），
    // 而它一旦写错，用户会拿着完好的 PDF 去反复换文件。
    vi.resetModules()
    vi.doMock('../src/query/kb/parse-pdf.ts', () => ({
      parsePdf: () => {
        const e = new Error("Cannot find package 'pdfjs-dist' imported from lib/index.js") as Error & { code?: string }
        e.code = 'ERR_MODULE_NOT_FOUND'
        throw e
      },
    }))
    try {
      const mod = await import('../src/query/kb/parse-async.ts')
      const out = await mod.parseFileByExtAsync('pdf', new Uint8Array([1]))
      expect(out.state).toBe('unsupported')
      expect(out.parser).toBe('')
      expect(out.blocks).toEqual([])
      expect(out.note).toContain('pdfjs-dist')
      expect(out.note).not.toContain('损坏')
      expect(out.note).not.toContain('失败')
    } finally {
      vi.doUnmock('../src/query/kb/parse-pdf.ts')
      vi.resetModules()
    }
  })

  it('依赖装上了但读不动 ⇒ 仍然抛（不能被「模块缺失」那条兜底吞掉）', async () => {
    // 反过来咬一口：兜底若写成宽松的 `catch (e) { return unsupported }`，
    // 「这份 PDF 有密码」就会被显示成「本机没装组件」，方向完全跑偏。
    await expect(parseFileByExtAsync('pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9])))
      .rejects.toThrow()
  })
})
