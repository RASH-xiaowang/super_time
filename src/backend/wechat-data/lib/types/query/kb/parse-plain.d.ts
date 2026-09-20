/**
 * A / A' 档解析器：把**字节**变成「段」（`ParsedBlock[]`）。纯函数，零依赖。
 *
 * 覆盖范围（不超出 `types.ts` 的 `PLAIN_TEXT_EXTS` / `HTML_EXTS` 两个注册表）：
 *   · A  档 —— txt / md / log / json / yaml / xml / srt / ini …：解码 + 归一化；
 *   · A' 档 —— html / htm / xhtml：去标签取可见文本；
 *   · 表格 —— csv / tsv：RFC4180 式的带引号字段解析，产出 `kind: 'table'` 的段。
 *
 * B 档（pdf / docx / xlsx）与 C 档（图片）**在这里一律返回 `unsupported` 并带上原因**，
 * 由存储层写进 `kb_files.parse_state` / `parse_error`。它们不是错误，只是没做 ——
 * 文案上必须区分开（「本机还没有 PDF 解析器」≠「文件损坏」，两者的排查方向完全不同）。
 *
 * ── 三处刻意的取舍 ──────────────────────────────────────────────────────
 *
 * 1) **解码优先 UTF-8 严格模式，失败才回退 GB18030。**
 *    「看起来像文本」不能靠 `fatal: false` 解码后数替换字符 —— 那样一段合法 GBK
 *    会被静默解成一串 U+FFFD 而没人报错。用严格模式让它**抛**，就能干净地判断。
 *    GB18030 是 GBK 的超集，优先用它；Node 未带对应 ICU 时退回 latin1 并在 note 里说明。
 *
 * 2) **表格字段内的换行被替换成空格。**
 *    「一行 = 一条记录」是分块器能按行组切的前提（见 `chunk.ts` 的 `splitTableRows`）；
 *    一个字段里藏着换行会让之后的每一行都错位。这是**有损**的，所以写在函数头上。
 *
 * 3) **超长输入在字节层截断**（`MAX_PARSE_BYTES`），而不是先解码再判。
 *    解码 500MB 文本会先把内存吃光，那时再判「太长」已经晚了。
 */
import type { DecodedText, ParseOutcome, ParsedBlock } from './types.ts';
/**
 * 单次解析允许读入的字节上限（32 MB）。
 *
 * UTF-8 中文约 3 字节/字，32MB ≈ 1000 万字 ≈ 2 万块，正好压在
 * `MAX_CHUNKS_PER_FILE` 附近 —— 这个上限不是凭空取的，它对应
 * 「一个文件最多能产生多少块」。
 */
export declare const MAX_PARSE_BYTES: number;
/**
 * 解码一段字节，返回文本与**实际采用的编码**。
 *
 * BOM 优先（它比任何猜测都可靠）；无 BOM 时先按 UTF-8 严格模式试，抛错才回退 GB18030。
 * @param raw - 原始字节。
 * @returns 文本 + 编码 + 是否剥了 BOM。
 */
export declare function decodeText(raw: Uint8Array): DecodedText;
/**
 * 换行统一成 `\n`（CRLF / 孤立 CR 都收掉）。
 * @param text - 原始文本。
 * @returns 换行已统一的文本。
 */
export declare function normalizeLineEndings(text: string): string;
/**
 * 去掉不可见字符：控制字符、零宽字符、行分隔符、BOM、软连字符。
 *
 * 为什么要清零宽字符：它们不显示，但会让「同一句话」在 BM25 里变成两个不同的词项，
 * 于是用户看着一模一样的词搜不到 —— 这种问题排查起来极其费时。
 * 换行（`\n`）与制表（`\t`）**保留**：它们是有意义的边界。
 * @param text - 原始文本。
 * @returns 清理后的文本。
 */
export declare function stripInvisibles(text: string): string;
/**
 * 正文归一化：统一换行 + 去不可见 + 把不间断/全角空格收成半角 +
 * 行内连续空白折成一个空格 + 连续空行折成一个空行 + 去首尾空白。
 * @param text - 原始文本。
 * @returns 归一化文本。
 */
export declare function normalizeProse(text: string): string;
/**
 * 结构化文本（表格）归一化：**只**统一换行、去不可见、去每行首尾空白。
 *
 * 不比 `normalizeProse` 折空白，是因为 `,` / `\t` 是数据分隔符 ——
 * 把它们折掉就不是归一化了，是把文件改坏。
 * @param text - 原始文本。
 * @returns 归一化文本（空行已丢弃）。
 */
export declare function normalizeTable(text: string): string;
/**
 * 解析分隔符文本（RFC4180 式：双引号包裹的字段内允许分隔符与换行，`""` 表示一个引号）。
 *
 * 没有用 `split(delimiter)` —— 带引号的 CSV（字段里含逗号或换行）在真实文件里很常见，
 * 用 split 会把一条记录切成两条，之后所有行的列都对不上。
 * @param text - 已归一化换行的文本。
 * @param delimiter - 单字符分隔符。
 * @returns 行 × 单元格（每格已去首尾空白）。
 */
export declare function parseDelimited(text: string, delimiter: string): string[][];
/**
 * 把分隔符文件变成一段表格文本（首行是表头）。
 *
 * 重新序列化而不是直接返回原文：字段内的换行被折成空格、每格去首尾空白之后，
 * 「一行 = 一条记录」这条不变量才成立，`splitTableRows` 才能按行组切。
 * 重新序列化是**可逆**的（`parseDelimited(tableText(t))` ≡ `parseDelimited(t)`），
 * 因为需要引号的字段会被重新加上引号。
 * 不补齐列数（不把短行填成与表头等长）：表里本来缺的列就该看得出来。
 * @param text - 已归一化换行的文本。
 * @param delimiter - 单字符分隔符。
 * @returns 表格文本；无内容时返回 `''`。
 */
export declare function tableText(text: string, delimiter: string): string;
/**
 * 把「行 × 单元格」拼成表格文本，**单元格先净化、因此永远不需要引号**。
 *
 * 与 `tableText` 的分工（两者的差别不是风格，而是「数据从哪来」）：
 *   · `tableText` 重排**用户写的分隔符文件**。那种文件里字段内的分隔符是**有意义的**
 *     （`a,"x,y"` 里的逗号属于 `x,y` 这个值），所以必须靠引号转义才能保持可逆；
 *   · 本函数拼接**从结构化来源生成**的表格（docx 的 `<w:tbl>`、xlsx 的单元格）。
 *     这里没有「原文」要保真 —— 分隔符与换行只可能来自版式噪声，收成空格是**修正**
 *     而不是破坏；净化之后分隔符不可能出现在字段里，引号于是成了纯粹的多余字符
 *     （它还会让喂给模型的证据变难读）。所以这一支**故意不复用** `serializeField`。
 *
 * 与 `splitTableRows` 的契约：产出的首行必须是表头、其余每行一条记录
 * —— 所以单元格里的换行必须在这里就收掉，否则「一行一记录」不成立。
 * @param rows - 行 × 单元格（单元格可含换行 / 制表 / 多余空白）。
 * @param delimiter - 单字符分隔符（B 档一律用 `\t`）。
 * @returns 表格文本；无行时返回 `''`。
 */
export declare function structuredTableText(rows: readonly (readonly string[])[], delimiter?: string): string;
/**
 * 常见 HTML 实体 → 字符。
 *
 * 只处理「不处理会让人读错」的那几个：`&amp;` 之类留着会让检索词项对不上，
 * `&nbsp;` 留着会在正文里出现字面的 `nbsp`。`&amp;` **必须最后**解，
 * 否则 `&amp;lt;` 会被先解成 `<` 再被误当成标签起始。
 * @param s - 含实体的文本。
 * @returns 解码后的文本。
 */
export declare function decodeEntities(s: string): string;
/**
 * 把 HTML 转成段。
 *
 * 单遍扫描标签、维护一个标题栈：标题标签把当前累积的文本**先冲出去**
 * （否则标题会挂到上一段上去），再改栈。`script` / `style` / `head` 的子树整体跳过
 * —— 把 CSS 或 JS 当正文索引，用户搜任何词都会命中一堆代码，是最糟的一种「有结果」。
 *
 * 与设计稿的差异（**超集**，写在这里免得被当成写错）：设计稿说「`h1..h3` 写入面包屑」，
 * 这里支持 `h1..h6`（Markdown 侧同样是 1~6 级），层级更深的文档同样能定位到节。
 * @param html - HTML 文本。
 * @returns 段数组。
 */
export declare function parseHtml(html: string): ParsedBlock[];
/**
 * Markdown → 段：`#{1,6}` 开头的行改标题栈，空行分段。
 *
 * 非 Markdown 的纯文本走同一条路径不会有副作用（`#` 开头的行在日志里本来就少见），
 * 所以不去分派两套实现。
 * @param text - markdown 文本。
 * @returns 段数组。
 */
export declare function parseMarkdown(text: string): ParsedBlock[];
/**
 * 纯文本 → 段：**空行分段**（不按行分段）。
 *
 * 为什么不按行：日志、字幕这类文本一行一句，按行分段会让每一段都短到不值得单独成块，
 * 之后 `splitProse` 会把它们合并，等于绕一圈回到这里。而空行是作者真的写下过的边界。
 * @param text - 文本。
 * @returns 段数组。
 */
export declare function parsePlainText(text: string): ParsedBlock[];
/**
 * 按扩展名分派解析。B / C 档与白名单外的类型一律返回 `unsupported` + 原因。
 *
 * 空文件与「只有空白」的文件返回 `ready` + 空的段数组（调用方据此写
 * `chunk_count = 0`）：**读得出内容、只是内容为空**，与「读不出来」是两回事，
 * 后者是 `unsupported` / `failed`。用户看到的文案也因此不同。
 * @param ext - 小写扩展名。
 * @param bytes - 文件字节。
 * @returns 解析产物（`state` 为 `ready` 或 `unsupported`）。
 */
export declare function parseFileByExt(ext: string, bytes: Uint8Array): ParseOutcome;
