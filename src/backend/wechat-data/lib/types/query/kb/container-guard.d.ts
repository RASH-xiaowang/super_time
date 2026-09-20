/**
 * 容器格式预检：把字节交给第三方解析库**之前**的一道纯函数闸门。
 *
 * ── 为什么必须有这道闸门（实测，不是推测）─────────────────────────────
 *   三个 B 档库里，两个（pdfjs / mammoth）对畸形输入的表现是教科书式的：
 *   抛一个可读的异常。**SheetJS 不是** —— 实测三种畸形输入下它给出三种坏结果：
 *
 *     · 随机字节 ⇒ **不抛**。它静默回退到 HTML / CSV / DIF 解析器，产出一张装着
 *       隐形控制字符的「表」，于是我们把一份根本不是工作簿的文件标成「已就绪」；
 *     · 把 PDF 当 xlsx 读 ⇒ **不抛**，产出一张「每个单元格是一行 PDF 源码」的表
 *       —— 用户能搜到 `<< /Type /Catalog >>` 这种当证据；
 *     · 截断的 xlsx（只留前 40 字节）⇒ **永久挂起**（子进程 8 秒后被 SIGTERM 强杀）。
 *       这一条最坏：真实表现是「添加后一直停在『解析中』，日志一行没有」。
 *
 *   所以「读不动就抛出」这条纪律在 Excel 这一档**不能**指望库来实现，必须自己先看。
 *   而这两类坏输入（真垃圾 / 被截断）恰好都能在**不解析内容**的前提下被识破：
 *   ZIP 的中央目录结束记录（EOCD）就在文件末尾，被截断的文件必然没有它；
 *   PDF / 图片 / 文本的字节又不可能以 `PK` 起头。这就是本模块的全部依据 ——
 *   **只读结构、不读内容**，因此既快又纯，而且自身不可能挂起。
 *
 * ── 为什么不用「超时看门狗」──────────────────────────────────────────
 *   `XLSX.read` 是**同步**的。它一旦进入死循环，事件循环被占满，`setTimeout` 的回调
 *   根本没有机会执行 —— `Promise.race([read(), timeout])` 对同步挂起**完全无效**
 *   （唯一的真解是 worker 线程 + `terminate()`，代价是多一个打包入口）。预检把这类
 *   输入直接挡在门外，于是看门狗不再必要，也不必付那份打包代价。
 *
 * ── 误杀防线（比「挡住坏文件」更需要小心的一侧）─────────────────────────
 *   闸门一旦过紧，坏的不是「少显示一条错误」，而是**用户正当的文件进不来**。
 *   所以按容器家族分流，而不是只看一个签名：
 *     · ZIP      —— xlsx / xlsm 等 OOXML；
 *     · OLE2     —— 旧版 `.xls`（BIFF 二进制流，**不是** ZIP）；
 *     · markup   —— SpreadsheetML 2003 与「导出成 HTML 的 .xls」，SheetJS 能正确读。
 *   这三类都放行。真实样本上的三条肯定用例（`设备台账.xlsx` 能读出两张表）钉住
 *   放行的一侧，畸形输入的用例钉住拦截的一侧，两边都不能只靠推理。
 */
/** 容器家族。 */
export type ContainerKind = 'zip' | 'ole2' | 'markup' | 'unknown';
/**
 * 嗅探容器家族。
 *
 * 只看开头几个字节。`markup` 分支要跳过 UTF-8 BOM 与前导空白，因为
 * SpreadsheetML 与「导出成 HTML 的 .xls」正是长这样（真实企业导出里很常见）。
 * @param bytes - 文件字节。
 * @returns 容器家族；认不出来时 `'unknown'`。
 */
export declare function sniffContainer(bytes: Uint8Array): ContainerKind;
/** ZIP 结构检查结果。 */
export interface ZipInspection {
    /** 结构是否自洽到可以交给解析库。 */
    ok: boolean;
    /** 不通过时的人话原因（可直接进 `kb_files.parse_error`）。通过时为空串。 */
    reason: string;
    /** 中央目录里的条目名（已转小写）。ZIP64 时无法枚举 ⇒ `null`。 */
    names: string[] | null;
}
/**
 * 检查 ZIP 结构是否自洽，并顺带列出条目名。
 *
 * 三件事一次做完：
 *   ① **找 EOCD** —— 它在文件末尾（其后最多跟 65535 字节注释）。截断的文件没有它，
 *      这是「下载到一半」唯一需要的判据；
 *   ② **验中央目录边界** —— 目录必须整个落在 EOCD 之前，且条目数能走完；
 *   ③ **累加解压后体积** —— zip 炸弹闸门（见 `MAX_UNCOMPRESSED_BYTES`）。
 *
 * 条目名是白拿的：走目录时顺手取，于是调用方能在这里就分辨「这是一个工作簿」
 * 还是「这是一个改了扩展名的 docx」—— 不必等 SheetJS 报一句英文出来。
 * @param bytes - 文件字节。
 * @returns 检查结果。
 */
export declare function inspectZip(bytes: Uint8Array): ZipInspection;
/**
 * 登记 `.xlsx` / `.xls` 之前的预检。不通过**抛出**（⇒ 执行器记 `failed`）。
 *
 * 放行三类良性容器（见文件头「误杀防线」），其余一律抛人话错误。
 * 抛出的三类错误在文案上刻意分开，因为它们指向用户三种不同的动作：
 *   · 「不是有效的 Excel 工作簿」⇒ 换文件（或改回正确的扩展名）；
 *   · 「内容不完整」⇒ 重新拷贝 / 重新下载；
 *   · 「解压后过大」⇒ 拆分表格。
 * @param bytes - 文件字节。
 */
export declare function assertExcelContainer(bytes: Uint8Array): void;
/**
 * 登记 `.docx` 之前的预检。不通过**抛出**（⇒ 执行器记 `failed`）。
 *
 * `.docx` 恒为 ZIP，所以没有 OLE2 分支；旧版 `.doc` 不在白名单内（见 `types.ts`）。
 * 判据是 `word/document.xml` 存在 —— 这是 OOXML 规范强制要求的正文部件，
 * 用它来分辨「改名的 xlsx」比等 mammoth 报一句英文更准、也更早。
 * @param bytes - 文件字节。
 */
export declare function assertWordContainer(bytes: Uint8Array): void;
