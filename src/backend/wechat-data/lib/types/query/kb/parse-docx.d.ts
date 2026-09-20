/**
 * B 档解析器之二：Word（`.docx`，依赖 `mammoth`，**惰性加载**）。
 *
 * ── 为什么要过一道 HTML ─────────────────────────────────────────────
 *   `.docx` 的正文在 `word/document.xml` 里，但「标题」不是靠 `<w:p>` 本身表达的，
 *   而是 `w:pStyle → 样式表 → 大纲级别` 的一条间接链，列表编号又是另一套
 *   （`numbering.xml` + `numPr`，要自己推算每级的序号）。`mammoth` 把这条链解完，
 *   输出**语义化 HTML**（`<h1>` / `<ul><li>`），正好是本仓 A' 档已有的输入形态。
 *
 *   于是本文件的核心不是「怎么读 XML」，而是**怎么把表格从 HTML 里安全地摘出来**：
 *   `parseHtml` 把 `<tr>` / `<td>` 当块级标签，直接喂给它会让每个单元格各成一段、
 *   各成一个检索块（表里「张三」独立成块后，模型不知道那是谁的名字）。
 *   做法见 `extractTables`：整个 `<table>` 换成一个**标记段落**，跑完 `parseHtml`
 *   再按标记换回 `kind: 'table'` 的段 —— 这样表头（列名）留在同一块里，
 *   而面包屑（`<h1>` 决定的 heading）由 `parseHtml` 按文档顺序算好，一行都不用自己维护。
 *
 * ── 标题为什么必须进面包屑 ────────────────────────────────────────────
 *   命中一个块时，块正文常常是「张三 / 项目经理」这种脱离上下文读不懂的碎片。
 *   `heading` 里带着「三、成员」，检索结果与送给模型的证据才有落点（设计稿 §5.1）。
 *   真实样本 `项目计划书.docx` 用的是 `Heading1` 样式，mammoth 输出 `<h1>` ⇒ 直接成立。
 *
 * ── 一个真实样本上观察到的边界（写在这里，免得后人当成我们的 bug）──────
 *   mammoth 对**未识别的段落样式**会退回普通段落并在 `messages` 里报一句
 *   （该样本的 `Title` 样式就是这种）。这是格式转换的正常降级，不是失败：
 *   正文一字不少，只是少了那一级的层级信息。我们把 messages 汇总进 `note`，
 *   让「为什么这一节没有标题」能被看见。
 */
import type { ParseOutcome } from './types.ts';
/**
 * 解析一份 `.docx`。
 *
 * 与 `parse-pdf.ts` 同一套失败语义：抽不出文字 ⇒ 返回 `unsupported`；
 * 读不动（不是 zip、不是 docx、加密）⇒ 抛出，由执行器记 `failed`。
 * 其中「不是 docx / 拷了一半」由 `container-guard.ts` 的**容器预检**负责，
 * 判据是 OOXML 规范强制要求的 `word/document.xml` 是否存在 —— 这比把字节交给
 * mammoth、再读回一句英文的 zip 报错更早、也更准。
 * @param bytes - 文件字节。
 * @returns 解析产物。
 */
export declare function parseDocx(bytes: Uint8Array): Promise<ParseOutcome>;
