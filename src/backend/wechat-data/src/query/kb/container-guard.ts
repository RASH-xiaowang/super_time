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

/** ZIP 本地文件头（普通条目）。 */
const SIG_LOCAL = [0x50, 0x4b, 0x03, 0x04] as const
/** ZIP 分卷标记。 */
const SIG_SPANNED = [0x50, 0x4b, 0x07, 0x08] as const
/** ZIP 中央目录结束记录（EOCD）。 */
const SIG_EOCD = [0x50, 0x4b, 0x05, 0x06] as const
/** ZIP 中央目录条目。 */
const SIG_CENTRAL = [0x50, 0x4b, 0x01, 0x02] as const
/** OLE2 复合文档头（旧版 `.xls` / `.doc` 的容器）。 */
const SIG_OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const

/** EOCD 固定部分长度（不含尾部注释）。 */
const EOCD_BYTES = 22
/** ZIP 注释的最大长度（规范上界，决定从文件尾部往回找 EOCD 的回溯距离）。 */
const MAX_ZIP_COMMENT = 0xffff
/** 中央目录条目的固定部分长度。 */
const CENTRAL_ENTRY_BYTES = 46
/** OLE2 头固定 512 字节：比这更小的一定是截断文件。 */
const OLE2_MIN_BYTES = 512

/**
 * 解压后总体积上限（zip 炸弹闸门）。
 *
 * `kb-files.ts` 的 `MAX_FILE_BYTES` 把**输入**卡在 32MB，但 deflate 的压缩比可以到
 * 上千倍 —— 32MB 的恶意包能声明出几十 GB。512MB 对真实表格足够宽松（一份 32MB 的
 * xlsx 解压后通常在 100MB 量级），同时把明显的炸弹挡在外面。
 */
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

/** 容器家族。 */
export type ContainerKind = 'zip' | 'ole2' | 'markup' | 'unknown'

/** 字节序列在 `at` 处是否等于 `magic`。越界时返回 false（而不是抛）。 */
function hasMagic(bytes: Uint8Array, at: number, magic: readonly number[]): boolean {
  if (at < 0 || at + magic.length > bytes.length) return false
  for (let i = 0; i < magic.length; i += 1) if (bytes[at + i] !== magic[i]) return false
  return true
}

/** 小端 u16。越界返回 0（随后的一致性校验会把它变成一条可读的错误）。 */
function u16(bytes: Uint8Array, at: number): number {
  if (at + 2 > bytes.length) return 0
  return (bytes[at] as number) | ((bytes[at + 1] as number) << 8)
}

/** 小端 u32（无符号：`>>> 0` 是必须的，否则 >2GB 的值会变成负数）。 */
function u32(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.length) return 0
  return (
    ((bytes[at] as number)
      | ((bytes[at + 1] as number) << 8)
      | ((bytes[at + 2] as number) << 16)
      | ((bytes[at + 3] as number) << 24)) >>> 0
  )
}

/**
 * 取一段字节按 latin1 拼成字符串。
 *
 * 只用于看签名与**中央目录里的条目名**（ZIP 规范里条目名是 ASCII 或 UTF-8，
 * 两种情况下的 ASCII 部分都能这样正确取到），不做任何正文解码。
 * @param bytes - 字节。
 * @param at - 起始偏移。
 * @param len - 长度。
 * @returns 该段对应的字符串（可能短于 `len`，若越界）。
 */
function asciiAt(bytes: Uint8Array, at: number, len: number): string {
  const end = Math.min(bytes.length, at + len)
  let s = ''
  for (let i = at; i < end; i += 1) s += String.fromCharCode(bytes[i] as number)
  return s
}

/**
 * 嗅探容器家族。
 *
 * 只看开头几个字节。`markup` 分支要跳过 UTF-8 BOM 与前导空白，因为
 * SpreadsheetML 与「导出成 HTML 的 .xls」正是长这样（真实企业导出里很常见）。
 * @param bytes - 文件字节。
 * @returns 容器家族；认不出来时 `'unknown'`。
 */
export function sniffContainer(bytes: Uint8Array): ContainerKind {
  if (hasMagic(bytes, 0, SIG_LOCAL) || hasMagic(bytes, 0, SIG_SPANNED) || hasMagic(bytes, 0, SIG_EOCD)) return 'zip'
  if (hasMagic(bytes, 0, SIG_OLE2)) return 'ole2'

  let at = 0
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3
  while (at < bytes.length) {
    const c = bytes[at] as number
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) { at += 1; continue }
    break
  }
  if (bytes[at] === 0x3c) return 'markup' // '<'
  return 'unknown'
}

/** ZIP 结构检查结果。 */
export interface ZipInspection {
  /** 结构是否自洽到可以交给解析库。 */
  ok: boolean
  /** 不通过时的人话原因（可直接进 `kb_files.parse_error`）。通过时为空串。 */
  reason: string
  /** 中央目录里的条目名（已转小写）。ZIP64 时无法枚举 ⇒ `null`。 */
  names: string[] | null
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
export function inspectZip(bytes: Uint8Array): ZipInspection {
  const len = bytes.length
  if (len < EOCD_BYTES) {
    return { ok: false, names: null, reason: '文件不完整：它比一个最小的 ZIP 容器还小' }
  }

  let eocd = -1
  const lowest = Math.max(0, len - EOCD_BYTES - MAX_ZIP_COMMENT)
  for (let p = len - EOCD_BYTES; p >= lowest; p -= 1) {
    if (!hasMagic(bytes, p, SIG_EOCD)) continue
    // 注释长度要把 EOCD 之后的字节刚好解释完（容许更多的尾部垃圾也不拒绝 ——
    // 宁可放宽这一条，也不要误杀带尾部填充的文件）。
    if (p + EOCD_BYTES + u16(bytes, p + 20) <= len) { eocd = p; break }
  }
  if (eocd < 0) {
    return {
      ok: false,
      names: null,
      reason: '文件内容不完整（找不到 ZIP 的中央目录结束记录，常见于拷贝或下载只完成了一部分）',
    }
  }

  const entries = u16(bytes, eocd + 10)
  const cdSize = u32(bytes, eocd + 12)
  const cdOffset = u32(bytes, eocd + 16)

  // ZIP64：>4GB 时这三个字段会被写成占位值，真值在 ZIP64 记录里。本用途的输入被
  // `MAX_FILE_BYTES`(32MB) 卡住，正常永远走不到这里；真遇到就放行交给 SheetJS
  // （它支持 ZIP64），而不是在这里现写一段没人验证过的 ZIP64 解析。
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
    return { ok: true, reason: '', names: null }
  }
  if (cdOffset + cdSize > eocd) {
    return { ok: false, names: null, reason: '文件内容不完整（中央目录越出了文件末尾）' }
  }
  if (entries === 0) {
    return { ok: false, names: [], reason: '这个容器里没有任何条目（不是有效的工作簿）' }
  }

  const names: string[] = []
  const end = cdOffset + cdSize
  let p = cdOffset
  let total = 0
  while (names.length < entries) {
    if (p + CENTRAL_ENTRY_BYTES > end) {
      return { ok: false, names: null, reason: '文件内容不完整（中央目录的条目数不够，目录被截断了）' }
    }
    if (!hasMagic(bytes, p, SIG_CENTRAL)) {
      return { ok: false, names: null, reason: '文件内容不完整（中央目录里的条目损坏）' }
    }
    total += u32(bytes, p + 24) // 未压缩大小
    if (total > MAX_UNCOMPRESSED_BYTES) {
      return { ok: false, names: null, reason: '这个文件解压后超过 512 MB，本机不解析这么大的表格' }
    }
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    names.push(asciiAt(bytes, p + CENTRAL_ENTRY_BYTES, nameLen).toLowerCase())
    p += CENTRAL_ENTRY_BYTES + nameLen + extraLen + commentLen
  }
  return { ok: true, reason: '', names }
}

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
export function assertExcelContainer(bytes: Uint8Array): void {
  const kind = sniffContainer(bytes)
  if (kind === 'ole2') {
    if (bytes.length < OLE2_MIN_BYTES) {
      throw new Error('这个文件内容不完整（旧版 Excel 的体积比 512 字节还小，多半是拷贝只完成了一部分）')
    }
    return
  }
  // SpreadsheetML 2003 的 `.xls`、以及「导出成 HTML 但存成 .xls」的报表：
  // 两者都是真实存在的、SheetJS 能正确读的形态，交给它判断，这里不拦。
  if (kind === 'markup') return
  if (kind !== 'zip') {
    throw new Error(
      '这个文件不是有效的 Excel 工作簿（内容既不是 xlsx 的 ZIP 容器，也不是旧版 xls 的二进制格式，'
      + '常见于把别的类型的文件直接改了扩展名；如果它其实是 CSV / 文本，请按 .csv 或 .txt 添加）',
    )
  }
  const zip = inspectZip(bytes)
  if (!zip.ok) throw new Error(zip.reason)
  if (zip.names !== null && !zip.names.some(n => n.endsWith('xl/workbook.xml') || n.endsWith('xl/workbook.bin'))) {
    throw new Error(
      '这个文件里没有 Excel 的工作簿结构（缺少 xl/workbook.xml），'
      + '多半是别的 Office 文件改了扩展名（例如把 .docx 直接改成了 .xlsx）',
    )
  }
}

/**
 * 登记 `.docx` 之前的预检。不通过**抛出**（⇒ 执行器记 `failed`）。
 *
 * `.docx` 恒为 ZIP，所以没有 OLE2 分支；旧版 `.doc` 不在白名单内（见 `types.ts`）。
 * 判据是 `word/document.xml` 存在 —— 这是 OOXML 规范强制要求的正文部件，
 * 用它来分辨「改名的 xlsx」比等 mammoth 报一句英文更准、也更早。
 * @param bytes - 文件字节。
 */
export function assertWordContainer(bytes: Uint8Array): void {
  if (sniffContainer(bytes) !== 'zip') {
    throw new Error('这个文件不是有效的 Word 文档（.docx 必须是一个 ZIP 容器；本机不支持旧版的 .doc）')
  }
  const zip = inspectZip(bytes)
  if (!zip.ok) throw new Error(zip.reason)
  if (zip.names !== null && !zip.names.some(n => n.endsWith('word/document.xml'))) {
    throw new Error(
      '这个 ZIP 里没有 Word 的正文（缺少 word/document.xml），'
      + '多半是别的 Office 文件改了扩展名（例如把 .xlsx 直接改成了 .docx）',
    )
  }
}
