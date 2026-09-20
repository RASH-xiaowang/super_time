/**
 * B 档（PDF / Word / Excel）的**异步**解析分派器 —— 与 `parse-plain.ts` 的同步分派并列。
 *
 * ── 为什么不塞进 `parseFileByExt` ───────────────────────────────────
 * `parseFileByExt` 是**同步纯函数**：A / A' 档（txt / md / csv / html）的解码与去标签
 * 都是毫秒级的，同步调用最省事，而且它已被 `kb-parse-plain.spec.ts` 逐条钉住
 * —— 包括 `isParsableExt('pdf') === false` 这一条。那个断言**现在依然是对的**：
 * 它回答的是「能不能**同步**解」，而「能不能解」是另一个问题（`isAsyncParsableExt`）。
 *
 * 把 B 档塞进同一个函数只有一种写法：让它变成 async。代价是三重的 ——
 * 那个纯函数不再纯（T1 的整支用例要跟着改）、`registerKbFile` 被拖成异步
 * （`@Remote` 的入参形状与错误语义跟着变）、以及「A 档零依赖」这条性质被一起弄丢
 * （B 档要 `await` 三个第三方库）。所以刻意分家：**同步的归 `parseFileByExt`，
 * 异步的归本文件**，两边共用同一份 `ParseOutcome` 契约与同一条文案纪律。
 *
 * ── B 档为什么必须异步（C5 / R3）────────────────────────────────────
 * 一份 PDF 要几百毫秒到几秒。同步跑在 Electron 主进程上会把**所有** `@Remote`
 * 一起卡住 —— H4 的验收就是「解析一份大 PDF 期间，`listKbFiles` 仍在 200ms 内返回」。
 * 三个解析器各自在内部按页 / 按工作表让出事件循环，本文件只负责把 `await` 串起来，
 * 并把「谁在解」这件事写进 `ParseOutcome.parser`。
 *
 * ── 惰性加载：为什么入口写成 `import()` 而不是顶层 import ──────────────
 * ① 后端 bundle 用 `packages: 'external'` 构建（见 `scripts/build-wechat-bundle.js`），
 *    裸模块留到运行时解析 —— 但**顶层** `import 'pdfjs-dist/...'` 会让「只是想打开
 *    应用、根本没上传过 PDF」的每一次启动都去解 34MB 的 pdfjs；
 * ② 依赖缺失（打包白名单漏了、用户手工删过 node_modules）时，顶层 import 会让
 *    **整个 gateway 模块加载失败** —— 表现为「应用起不来」，而那时的正确表现是
 *    「知识库能用，只是 PDF 解析不了」。
 * `import()` 把这两个问题一起消掉：只在真的要解这一档文件时才付代价，
 * 且失败被收敛成一次可读的 `unsupported`。
 */

import { parseDocx } from './parse-docx.ts'
import { parsePdf } from './parse-pdf.ts'
import { parseFileByExt } from './parse-plain.ts'
import { parseXlsx } from './parse-xlsx.ts'
import type { ParseOutcome } from './types.ts'
import { isParsableExt } from './types.ts'

/** 一个 B 档扩展名的解析出处。 */
interface AsyncParserEntry {
  /** npm 包名（写进「本机缺少什么」的文案，用户据此能自己查）。 */
  dep: string
  /** 给人看的档位名（出现在文案里与日志里）。 */
  label: string
  parse: (bytes: Uint8Array) => Promise<ParseOutcome>
}

/**
 * B 档扩展名 → 解析器。**键必须与 `PENDING_PARSER_EXTS` 完全相同**（由用例断言）。
 *
 * `.xls` 与 `.xlsx` 指向同一个解析器：SheetJS 两种容器都读（旧版是 BIFF 二进制流、
 * 新版是 ZIP+XML），分成两个入口只会让「一份文件到底谁解的」更难回答。
 */
const ASYNC_PARSERS: Record<string, AsyncParserEntry> = {
  pdf: { dep: 'pdfjs-dist', label: 'PDF', parse: parsePdf },
  docx: { dep: 'mammoth', label: 'Word', parse: parseDocx },
  xlsx: { dep: 'xlsx', label: 'Excel', parse: parseXlsx },
  xls: { dep: 'xlsx', label: 'Excel', parse: parseXlsx },
}

/**
 * 该扩展名是否走异步（B 档）解析。
 *
 * 用 `hasOwnProperty` 而不是 `in`：`in` 会把 `constructor` / `toString` 这类
 * 继承自原型的键也判成真，而扩展名是用户可控的字符串（`文件名.constructor` 是合法文件名）。
 * @param ext - 小写扩展名。
 * @returns B 档时为 true。
 */
export function isAsyncParsableExt(ext: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASYNC_PARSERS, ext)
}

/**
 * 该扩展名是否有解析出路（A / A' 同步 + B 档异步）。
 *
 * 与 `isParsableExt` 并存而不是取代它：`isParsableExt` 的语义是「**同步**可解」，
 * 它被 `registerKbFile` 用来决定「要不要走异步队列」，改它的含义会把那条分流写错。
 * @param ext - 小写扩展名。
 * @returns 任一档可解时为 true。
 */
export function isAnyParsableExt(ext: string): boolean {
  return isParsableExt(ext) || isAsyncParsableExt(ext)
}

/**
 * 「模块没装上」判定。
 *
 * 三种写法都要认，因为同一件事在三种加载形态下报的错码不同：
 * ESM 动态 `import()` 抛 `ERR_MODULE_NOT_FOUND`、CJS `require` 抛 `MODULE_NOT_FOUND`
 * （`node:sqlite` 这类内置模块不存在时还会用 `ERR_UNKNOWN_BUILTIN_MODULE`，
 * 但那种情形不属于本判定）。错误码拿不到时退一步看消息文本 ——
 * 打包工具改写过的报错常常只剩文本可用。
 * @param e - 捕获到的异常。
 * @returns 像「模块不存在」时为 true。
 */
function looksLikeMissingModule(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
  const msg = (e as { message?: unknown } | null)?.message
  if (typeof msg !== 'string') return false
  // 只认 Node 自己那两句；不要用宽松的 /not found/ —— 那会把
  // 「pdfjs 说这份文件里找不到 xref」之类的解析失败误判成「组件没装」，
  // 于是用户被告知去重装软件，而真正该做的是换一份文件。
  return /Cannot find (?:module|package) '[^']*'/.test(msg)
}

/**
 * 按扩展名分派解析（异步）。
 *
 * 分派规则（与 `parseFileByExt` 一脉相承，只是多了一档）：
 *   · A / A' 档 ⇒ 直接交给同步的 `parseFileByExt`（**行为完全不变**）；
 *   · B 档 ⇒ 交给对应的惰性加载解析器；
 *   · 其余（C 档、白名单外、无扩展名）⇒ **也交给 `parseFileByExt`**，
 *     由它给出那句「已登记，未识别内容」/「不支持的类型 .zip」的人话原因 ——
 *     同一件事只在一个地方写文案，两处各写一份迟早会漂。
 *
 * 失败语义：
 *   · 抽不出文字 ⇒ 各解析器自己返回 `unsupported` + 人话原因（**不是** `failed`）；
 *   · 读不动（有密码 / 不是那种格式 / 结构损坏）⇒ **抛出**，由执行器记 `failed`；
 *   · 依赖没装上 ⇒ 这里收敛成 `unsupported`。它是「本机没有这个组件」，
 *     不是「这份文件读不了」—— 与 `parse-plain.ts` 的 `PENDING_NOTE` 同一条纪律
 *     （两者给用户的动作完全不同：一个是重装软件，一个是换一份文件）。
 * @param ext - 小写扩展名。
 * @param bytes - 文件字节。
 * @returns 解析产物。
 */
export async function parseFileByExtAsync(ext: string, bytes: Uint8Array): Promise<ParseOutcome> {
  const entry = isAsyncParsableExt(ext) ? ASYNC_PARSERS[ext] : undefined
  if (entry === undefined) return parseFileByExt(ext, bytes)

  try {
    return await entry.parse(bytes)
  } catch (e) {
    if (looksLikeMissingModule(e)) {
      return {
        state: 'unsupported',
        parser: '',
        blocks: [],
        note: '本机缺少 ' + entry.label + ' 解析组件（' + entry.dep
          + ' 未安装，可能是打包不完整或组件被删过），重新安装或更新 Super Time 后即可解析',
      }
    }
    throw e
  }
}
