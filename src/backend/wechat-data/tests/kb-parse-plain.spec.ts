/**
 * A / A' 档解析器（`query/kb/parse-plain.ts`）的回归用例。
 *
 * 这一支同样是零依赖纯函数：输入字节、输出「段」。它要守住三类容易静默出错的判断：
 *   ① **解码**：不能靠 `fatal: false` 解完数替换字符来猜编码（那样一段合法 GBK 会被
 *      静默解成 U+FFFD 而没人报错）—— 必须先在严格模式下让它抛；
 *   ② **取文本**：`<script>` / `<style>` / `<head>` 的子树绝不能进正文，否则用户搜
 *      任何词都会命中一堆代码，这是最糟的一种「有结果」；
 *   ③ **分派**：B 档（pdf/docx/xlsx）与 C 档（图片）返回 `unsupported` 且**必须**给出
 *      人话原因 —— 且绝不许把「本机还没有解析器」写成「文件损坏」（排查方向完全不同）。
 *
 * 另有两条与「空文件」有关的断言：空文件是 `ready` + 0 段，**不是** `unsupported`
 * 也不是 `failed` —— 读得出内容、只是内容为空，用户该看到的文案完全不同。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  decodeText,
  normalizeProse,
  normalizeTable,
  parseDelimited,
  parseFileByExt,
  parseHtml,
  parseMarkdown,
  parsePlainText,
  tableText,
} from '../src/query/kb/parse-plain.ts'
import { ACCEPTED_EXTS, extOf, isAcceptedExt, isParsableExt } from '../src/query/kb/types.ts'
import { chunkBlocks } from '../src/query/kb/chunk.ts'

const enc = new TextEncoder()

/** 把字符串编成 UTF-8 字节。 */
const bytes = (s: string): Uint8Array => enc.encode(s)

/** 「中文」二字的 GBK 编码，用来验「非法 UTF-8 回退 GB18030」。 */
const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])

describe('解析器 · 解码', () => {
  it('UTF-8 BOM 被剥掉并如实上报', () => {
    expect(decodeText(bytes('\ufeff你好'))).toEqual({ text: '你好', encoding: 'utf-8', bom: true })
  })

  it('无 BOM 的 UTF-8 中文按 utf-8 解，不会误判成 GB18030', () => {
    const d = decodeText(bytes('中文内容'))
    expect(d.encoding).toBe('utf-8')
    expect(d.text).toBe('中文内容')
    expect(d.bom).toBe(false)
  })

  it('非法 UTF-8 字节回退 GB18030（而不是吐出替换字符）', () => {
    // 「先严格后回退」的依据就在这条断言里：同一串字节在严格模式下必须抛。
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(GBK_ZHONGWEN)).toThrow()

    const d = decodeText(GBK_ZHONGWEN)
    expect(d.text).toBe('中文')
    expect(d.encoding).toBe('gb18030')
    expect(d.bom).toBe(false)
  })

  it('UTF-16LE / UTF-16BE BOM 各自识别', () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])))
      .toEqual({ text: 'AB', encoding: 'utf-16le', bom: true })
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42])))
      .toEqual({ text: 'AB', encoding: 'utf-16be', bom: true })
  })

  it('空字节 → 空文本，不抛错', () => {
    expect(decodeText(new Uint8Array(0))).toEqual({ text: '', encoding: 'utf-8', bom: false })
  })
})

describe('解析器 · 归一化', () => {
  it('normalizeProse 收掉换行/空白/零宽字符，并保留段落边界', () => {
    expect(normalizeProse('\u200b  甲   乙\t丙\r\n\r\n\r\n丁  \ufeff')).toBe('甲 乙 丙\n\n丁')
  })

  it('normalizeTable 只去行首尾空白，绝不折字段内的空白', () => {
    expect(normalizeTable('a, b\r\n\r\n c ,d\n')).toBe('a, b\nc ,d')
    // 二者不可互换：表格里 `,` 是数据分隔符，折空白等于把文件改坏。
    expect(normalizeProse('a,   b\nc,   d')).toBe('a, b\nc, d')
    expect(normalizeTable('a,   b\nc,   d')).toBe('a,   b\nc,   d')
  })
})

describe('解析器 · CSV / TSV', () => {
  it('解析 RFC4180 式的引号字段（含分隔符、含翻倍的引号）', () => {
    const csv = 'name,note\n张三,"含,逗号"\n李四,"含""引号"""\n王五,普通'
    expect(parseDelimited(csv, ',')).toEqual([
      ['name', 'note'],
      ['张三', '含,逗号'],
      ['李四', '含"引号"'],
      ['王五', '普通'],
    ])
  })

  it('字段内的换行被折成空格（「一行 = 一条记录」是行组分块的前提）', () => {
    expect(parseDelimited('a,"第一行\n第二行"\nb,c', ','))
      .toEqual([['a', '第一行 第二行'], ['b', 'c']])
  })

  it('逗号后带空格的引号字段同样被识别', () => {
    expect(parseDelimited('a, "b,c"', ',')).toEqual([['a', 'b,c']])
  })

  it('tableText 重新序列化时可逆（含分隔符的字段被重新加引号）', () => {
    const src = 'name,note\n张三,"含,逗号"\n李四,"含""引号"""'
    const out = tableText(src, ',')
    expect(out).toBe(src)
    // 可逆才是关键：不止「看着对」，再解一次必须得到同一张表。
    expect(parseDelimited(out, ',')).toEqual(parseDelimited(src, ','))
  })

  it('TSV 用制表符作分隔符', () => {
    expect(parseDelimited('a\tb\nc\td', '\t')).toEqual([['a', 'b'], ['c', 'd']])
    expect(tableText('a\tb\tc', '\t')).toBe('a\tb\tc')
  })

  it('空输入产出空表，不抛错', () => {
    expect(parseDelimited('', ',')).toEqual([])
    expect(tableText('', ',')).toBe('')
    expect(tableText('\n\n', ',')).toBe('')
  })
})

describe('解析器 · HTML', () => {
  const page = [
    '<html><head><title>标题不当正文</title>',
    '<style>body{color:red}</style>',
    '<script>var marker = "SCRIPT_MARKER"</script></head>',
    '<body><h1>第一章</h1><p>正文一。</p><p>正文二。</p></body></html>',
  ].join('')

  it('script / style / head 子树整体不进正文', () => {
    const blocks = parseHtml(page)
    const all = blocks.map(b => b.text).join('\n')
    expect(all).not.toContain('SCRIPT_MARKER')
    expect(all).not.toContain('color:red')
    expect(all).not.toContain('标题不当正文')
    expect(blocks.map(b => b.text)).toEqual(['正文一。', '正文二。'])
  })

  it('h1..h6 写入面包屑，且首行就是 h2 时不以分隔符开头', () => {
    const blocks = parseHtml('<h2>二级</h2><p>甲。</p><h3>三级</h3><p>乙。</p><h1>一级</h1><p>丙。</p>')
    expect(blocks.map(b => b.heading)).toEqual(['二级', '二级 › 三级', '一级'])
    // 定长标题槽的意义：`slice(0, level-1)` 的写法会产出 ' › 二级' 这种空洞面包屑。
    expect(blocks.every(b => !b.heading.startsWith(' ›') && !b.heading.endsWith(' ›'))).toBe(true)
  })

  it('注释不成为正文', () => {
    expect(parseHtml('<p>甲</p><!-- 注释 SHOULD_NOT_APPEAR --><p>乙</p>').map(b => b.text)).toEqual(['甲', '乙'])
  })

  it('块级标签与 <br> 都触发分段', () => {
    // `<br>` 没有斜杠、不是自闭合标签：只靠「自闭合」判据的话，用 <br> 分行的文本会被拼成一大段。
    expect(parseHtml('<p>第一行<br>第二行</p>').map(b => b.text)).toEqual(['第一行', '第二行'])
    expect(parseHtml('<div>甲</div><div>乙</div>').map(b => b.text)).toEqual(['甲', '乙'])
  })

  it('正文里的实体被解码', () => {
    expect(parseHtml('<p>A &amp; B</p><p>价格 &lt; 100 元</p>').map(b => b.text))
      .toEqual(['A & B', '价格 < 100 元'])
  })

  it('decodeEntities 的边界：&amp; 必须最后解', () => {
    expect(decodeEntities('A &amp; B')).toBe('A & B')
    expect(decodeEntities('&lt;div&gt;')).toBe('<div>')
    // `&amp;lt;` 是「字面量 &lt;」：先解 &amp; 的话会被再解一次成 `<`。
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeEntities('&#65;&#x42;')).toBe('AB')
    expect(decodeEntities('&nbsp;')).toBe(' ')
  })

  it('只有空白的页面产出 0 段（readable but empty）', () => {
    expect(parseHtml('<html><body>   </body></html>')).toEqual([])
  })
})

describe('解析器 · Markdown / 纯文本', () => {
  it('Markdown 标题改面包屑，空行分段', () => {
    const md = '# 标题一\n\n第一段。\n\n第二段。\n\n## 子标题\n\n第三段。'
    expect(parseMarkdown(md).map(b => [b.heading, b.text])).toEqual([
      ['标题一', '第一段。'],
      ['标题一', '第二段。'],
      ['标题一 › 子标题', '第三段。'],
    ])
  })

  it('纯文本按空行分段，不按行（日志/字幕一行一句，按行分段会切出无意义的碎块）', () => {
    expect(parsePlainText('甲\n乙\n\n丙\n\n\n丁').map(b => b.text)).toEqual(['甲\n乙', '丙', '丁'])
  })

  it('产出的段都是 prose 且 page 为 0（不假装知道页码）', () => {
    expect(parsePlainText('甲').every(b => b.kind === 'prose' && b.page === 0)).toBe(true)
  })
})

describe('解析器 · parseFileByExt 分派', () => {
  it('txt → plain，段文本正确，无降级说明', () => {
    const out = parseFileByExt('txt', bytes('甲\n\n乙'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('plain')
    expect(out.blocks.map(b => b.text)).toEqual(['甲', '乙'])
    expect(out.note).toBe('')
  })

  it('md → markdown；html → html；jsonl → plain（不整份 parse）', () => {
    expect(parseFileByExt('md', bytes('# 标题\n\n正文。')).parser).toBe('markdown')
    expect(parseFileByExt('html', bytes('<p>甲</p>')).parser).toBe('html')
    const jsonl = parseFileByExt('jsonl', bytes('{"a":1}\n{"a":2}'))
    expect(jsonl.parser).toBe('plain')
    expect(jsonl.blocks[0]!.text).toBe('{"a":1}\n{"a":2}')
  })

  it('csv / tsv → 单个 table 段', () => {
    const csv = parseFileByExt('csv', bytes('name,age\n张三,30'))
    expect(csv.state).toBe('ready')
    expect(csv.parser).toBe('csv')
    expect(csv.blocks.length).toBe(1)
    expect(csv.blocks[0]!.kind).toBe('table')
    expect(csv.blocks[0]!.text).toBe('name,age\n张三,30')

    const tsv = parseFileByExt('tsv', bytes('a\tb\n1\t2'))
    expect(tsv.parser).toBe('tsv')
    expect(tsv.blocks[0]!.kind).toBe('table')
  })

  it('csv 路径过归一化：行尾回车不会粘进字段', () => {
    const out = parseFileByExt('csv', bytes('a,b\r\n1,2\r\n'))
    expect(out.blocks[0]!.text).toBe('a,b\n1,2')
  })

  it('合法单行 JSON 被重排成多行（换行本身就是分块器的切点）', () => {
    const out = parseFileByExt('json', bytes('{"a":1,"b":{"c":2}}'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('json')
    expect(out.blocks[0]!.text.split('\n').length).toBeGreaterThanOrEqual(5)
  })

  it('非法 JSON 不判失败，按纯文本处理', () => {
    const out = parseFileByExt('json', bytes('{ 这不是 json'))
    expect(out.state).toBe('ready')
    expect(out.parser).toBe('plain')
  })

  it('非 UTF-8 文件在 note 里说明实际编码', () => {
    const out = parseFileByExt('txt', GBK_ZHONGWEN)
    expect(out.state).toBe('ready')
    expect(out.blocks[0]!.text).toBe('中文')
    expect(out.note).toContain('gb18030')
  })

  it('空文件 = ready + 0 段 + 0 块（不是 unsupported，也不是 failed）', () => {
    const txt = parseFileByExt('txt', new Uint8Array(0))
    expect(txt.state).toBe('ready')
    expect(txt.blocks).toEqual([])
    expect(chunkBlocks(txt.blocks).chunkCount).toBe(0)

    expect(parseFileByExt('csv', new Uint8Array(0)).state).toBe('ready')
    expect(parseFileByExt('csv', new Uint8Array(0)).blocks).toEqual([])
    expect(parseFileByExt('html', bytes('<html><body>   </body></html>')).state).toBe('ready')
    expect(parseFileByExt('html', bytes('<html><body>   </body></html>')).blocks).toEqual([])
  })

  it('B 档一律 unsupported，且原因里不许出现「损坏 / 失败」', () => {
    for (const ext of ['pdf', 'docx', 'xlsx', 'xls']) {
      const out = parseFileByExt(ext, new Uint8Array([1, 2, 3]))
      expect(out.state).toBe('unsupported')
      expect(out.parser).toBe('')
      expect(out.blocks).toEqual([])
      expect(out.note.length).toBeGreaterThan(0)
      expect(out.note).not.toContain('损坏')
      expect(out.note).not.toContain('失败')
    }
    expect(parseFileByExt('pdf', new Uint8Array(0)).note).toContain('PDF')
    expect(parseFileByExt('docx', new Uint8Array(0)).note).toContain('Word')
  })

  it('C 档图片：已登记但未识别，文案指向「按文件名」', () => {
    const out = parseFileByExt('png', new Uint8Array([1]))
    expect(out.state).toBe('unsupported')
    expect(out.note).toContain('按文件名')
  })

  it('无扩展名 / 白名单外的类型各自有人话原因', () => {
    expect(parseFileByExt('', new Uint8Array([1])).note).toContain('没有扩展名')
    expect(parseFileByExt('zip', new Uint8Array([1])).note).toContain('不支持的类型')
    expect(parseFileByExt('doc', new Uint8Array([1])).note).toContain('不支持的类型')
  })
})

describe('扩展名注册表', () => {
  it('extOf 只认最后一个点之后的段，隐藏文件不算扩展名', () => {
    expect(extOf('我的报告.v2.PDF')).toBe('pdf')
    expect(extOf('归档.tar.gz')).toBe('gz')
    expect(extOf('/a/b/c.txt')).toBe('txt')
    expect(extOf('C:\\dir\\x.MD')).toBe('md')
    expect(extOf('noext')).toBe('')
    expect(extOf('.gitignore')).toBe('')
    expect(extOf('')).toBe('')
  })

  it('「能不能选」与「现在能不能解」是两件事', () => {
    expect(isParsableExt('txt')).toBe(true)
    expect(isParsableExt('html')).toBe(true)
    expect(isParsableExt('csv')).toBe(true)
    // B 档要等 T5：现在解不了，但用户**能选**（选完会看到「本机还没有解析器」）。
    expect(isParsableExt('pdf')).toBe(false)
    expect(isAcceptedExt('pdf')).toBe(true)
    expect(isAcceptedExt('png')).toBe(true)
  })

  it('白名单排除本期明确不做的类型（选择时就看不到，而不是传进来才说不行）', () => {
    for (const ext of ['zip', 'doc', 'wps', 'ppt', 'pptx', 'pages', 'mp3', 'mp4']) {
      expect(isAcceptedExt(ext)).toBe(false)
    }
  })

  it('ACCEPTED_EXTS 无重复，且大小写不敏感地可用', () => {
    expect(ACCEPTED_EXTS.length).toBe(new Set(ACCEPTED_EXTS).size)
    expect(isAcceptedExt(extOf('样本.TXT'))).toBe(true)
  })
})

describe('解析 → 分块 的接口对接', () => {
  it('一份 md 端到端：段非空、块非空、每块正文非空', () => {
    const md = [
      '# 项目说明', '',
      '这是一个用于验证解析与分块接口对得上的样本文件。',
      '', '## 安装', '',
      '执行安装命令，然后等待依赖下载完成。',
      '', '## 使用', '',
      '打开面板，选择目标会话，然后提问。',
    ].join('\n')
    const out = parseFileByExt('md', bytes(md))
    expect(out.blocks.length).toBeGreaterThan(0)

    const res = chunkBlocks(out.blocks)
    expect(res.chunkCount).toBeGreaterThan(0)
    expect(res.chunks.every(c => c.text.trim() !== '')).toBe(true)
    // 面包屑来自解析器，块把它原样带过去（首块不带「续 N」）。
    expect(res.chunks[0]!.heading).toBe('项目说明')
    expect(res.chunks.every(c => c.charCount === c.text.length)).toBe(true)
  })
})
