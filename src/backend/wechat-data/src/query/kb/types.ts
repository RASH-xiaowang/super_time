/**
 * 知识库「文件」域的共享类型与常量注册表。
 *
 * 这一层是**纯类型 + 纯常量**：不 import 任何东西、不碰 fs / sqlite / 网络。
 * 本域（`query/kb/**`）的其余模块也只允许是纯函数 —— 见下一条。
 *
 * 边界（与 `notes.ts` 的分工，刻意写在最显眼处）：
 *   · `notes.ts` 的文件头写着「本模块只读写本地库，不出网、不调用模型」。
 *     所以「解析 / 分块 / 嵌入」全部落在 `query/kb/**` 里，**`notes.ts` 一行不改**；
 *   · 本域的可测部分是 `chunk.ts` / `parse-plain.ts` 这两支纯函数（输入字节、输出块），
 *     真正碰盘的部分（复制 blob、建库、入队）在后续步骤里另开模块，让纯逻辑能脱离
 *     数据库与文件系统被单测覆盖。
 */

/**
 * 解析出的一段正文。
 *
 * 为什么在块之前先有「段」：解析（把字节变成文字）与分块（把文字切成可检索单元）
 * 是两件事，失败模式也完全不同 —— 解析失败是「读不出来」，分块失败是「切得不好」。
 * 分成两层之后，`chunk.ts` 可以完全不关心 PDF / HTML / CSV 的区别，
 * 只按 `kind` 与 `heading` 决定怎么切。
 */
export interface ParsedBlock {
  /** 段正文（已归一化换行与空白，无首尾空白）。 */
  text: string
  /** 所属页码（1 基）。非分页形态（txt / csv / html）恒为 0，不假装知道页码。 */
  page: number
  /**
   * 面包屑：这段正文所处的标题路径（`H1 › H2`）。无标题时为 `''`。
   *
   * 它同时服务两件事：给检索结果一个「命中哪一节」的定位（比页码更精确），
   * 以及给模型一个上下文锚点（一段正文脱离标题后经常读不懂）。
   */
  heading: string
  /**
   * 段形态。
   *   · `prose` —— 连续文字：按段落 / 句子 / 硬切三级切点分块；
   *   · `table` —— 表格（CSV / TSV / xlsx）：**按行组分块且每块首行重复表头**，
   *     绝不能按字符切（那会把一行劈成两半，交给模型的证据是残行）。
   */
  kind: 'prose' | 'table'
}

/** 分块产物：即将落进 `kb_chunks` 的一行（此处不含 id / kb_id，那些由存储层补）。 */
export interface ChunkDraft {
  /** 块序（0 基，按文件内出现顺序）。 */
  ordinal: number
  /** 块正文。 */
  text: string
  /** 字符数（= `text.length`，与全项目「字符即预算单位」的口径一致）。 */
  charCount: number
  /** 所属页码；非分页形态为 0。 */
  page: number
  /** 面包屑（含「续 N」后缀时表示这是被硬切开的残段）。 */
  heading: string
}

/** 分块结果。 */
export interface ChunkResult {
  chunks: ChunkDraft[]
  /**
   * 是否因超过 `MAX_CHUNKS_PER_FILE` 而被截断。
   *
   * 单独返回而不是让调用方数数：截断必须能写进 `kb_files.parse_error` 让用户看见
   * （「已截断至 20000 块」），否则用户会以为整份文件都能被检索到。
   */
  truncated: boolean
  /** 实际产出的块数（= `chunks.length`，冗余一列便于调用方直接写库）。 */
  chunkCount: number
  /** 全部块的字符数之和。 */
  charCount: number
}

/** 解析结果的状态。与 `kb_files.parse_state` 的取值域**前两档**对齐。 */
export type ParseState = 'ready' | 'unsupported'

/** 一次解析的产物。 */
export interface ParseOutcome {
  state: ParseState
  /** 实际使用的解析器名（写进 `kb_files.parser`，便于事后归因「这批文件是谁解的」）。 */
  parser: string
  /** 解析出的段（`unsupported` 时为空数组）。 */
  blocks: ParsedBlock[]
  /**
   * 不可用的原因或降级说明。`unsupported` 时**必须非空**。
   *
   * 文案纪律：不许把「本机没有对应解析器」写成「文件损坏」—— 两者的排查方向
   * 完全不同（前者等版本升级，后者要用户换文件）。
   */
  note: string
}

/** 文本解码结果。 */
export interface DecodedText {
  text: string
  /** 实际采用的编码。`gb18030` 是 GBK 超集，优先用它。 */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'latin1'
  /** 是否剥掉了 BOM。 */
  bom: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// 扩展名注册表
//
// 这里刻意用**四个分开的集合**而不是一个带标志位的表：它们回答的是四个不同的问题
// （能不能选、现在能不能解、以后能不能解、为什么只能登记），混成一张表之后
// 「加一个扩展名要改哪一列」会变得需要读代码才知道。
// ────────────────────────────────────────────────────────────────────────────

/** A 档：纯文本族，自实现解码即可，零依赖。 */
export const PLAIN_TEXT_EXTS = [
  'txt', 'md', 'markdown', 'markdn', 'text', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'xml', 'srt', 'vtt', 'ini', 'conf',
] as const

/** A' 档：HTML，去标签取可见文本，零依赖。 */
export const HTML_EXTS = ['html', 'htm', 'xhtml'] as const

/**
 * B 档：需要额外纯 JS 依赖（pdfjs-dist / mammoth / xlsx），T5 已接入。
 *
 * ⚠ **名字里的 `PENDING` 现在指的是「不能同步解」**，不是「还没做」——
 * 这三档由 `kb/parse-async.ts` 异步分派（见该文件头注：为什么它们不与 A / A' 同路）。
 * 之所以不改名：对话框白名单（`ACCEPTED_EXTS`）与前端镜像（`KB_ACCEPTED_EXTS`）
 * 都按这个常量名取项，改名的收益只是好看，代价是一次四分五裂的同步修改。
 */
export const PENDING_PARSER_EXTS = ['pdf', 'docx', 'xlsx', 'xls'] as const

/**
 * C 档：本期只登记元数据，不解析正文。
 *
 * 为什么不接 OCR：中文 OCR 的识别率不足以把结果当**证据**送给模型 ——
 * 给错的证据比不给更糟。界面上要写明「已登记，未识别内容，当前只能按文件名搜到」，
 * 而不是把它显示成失败（它没失败，只是没做）。
 */
export const REGISTER_ONLY_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] as const

/**
 * 对话框白名单（`dialog:open-file` 的 filters 用它）。
 *
 * = A ∪ A' ∪ B ∪ C。**不包括** `.doc / .wps / .ppt / .pptx / .pages / .zip` 与音视频：
 * 让用户在**选择时**就看不到这些类型，而不是传进来之后才告诉他不行。
 */
export const ACCEPTED_EXTS: readonly string[] = [
  ...PLAIN_TEXT_EXTS, ...HTML_EXTS, ...PENDING_PARSER_EXTS, ...REGISTER_ONLY_EXTS,
]

/**
 * 取小写扩展名（不含点）。无扩展名时返回 `''`。
 *
 * 只认最后一个点之后的段：`我的报告.v2.pdf` → `'pdf'`、`归档.tar.gz` → `'gz'`。
 * 这与 `resource-classify.ts` 的既有口径（`fileName.split('.').pop()`）一致 ——
 * 同一份文件在两个面板里被归成不同类别是最难查的一类缺陷。
 * @param name - 文件名或路径。
 * @returns 小写扩展名。
 */
export function extOf(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return '' // dot<=0 同时排除「无点」与「.gitignore」这类隐藏文件
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 该扩展名是否**同步**可解析（A / A' 档）。
 *
 * 「同步可解」是这一族的定义，而不是一个实现细节：`registerKbFile` 用它决定
 * 「当场解完」还是「排进异步队列」。B 档（pdf / docx / xlsx / xls）**能解**但**不能同步解**，
 * 所以这里恒为 false —— 那个问题的答案是 `parse-async.ts` 的 `isAsyncParsableExt`。
 * @param ext - 小写扩展名。
 * @returns 同步可解析时为 true。
 */
export function isParsableExt(ext: string): boolean {
  return (PLAIN_TEXT_EXTS as readonly string[]).includes(ext)
    || (HTML_EXTS as readonly string[]).includes(ext)
}

/**
 * 该扩展名是否在白名单内（可被登记）。
 * @param ext - 小写扩展名。
 * @returns 在白名单内时为 true。
 */
export function isAcceptedExt(ext: string): boolean {
  return ACCEPTED_EXTS.includes(ext)
}
