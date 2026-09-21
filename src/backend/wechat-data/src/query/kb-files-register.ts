/**
 * `kb-files.ts` 的「登记与读取：registerKbFile、列表/分块分页、中断恢复」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-register
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  KbFileChunkPage,
  KbFileListSnapshot,
  KbFileMeta,
  KbFileMutationResult,
  KbFileParseState,
  KbFileRecoveryReport,
  KbFileRegisterInput,
  KbFileRegisterResult,
  KbFilesDeleteReport,
} from '../types.ts'
import { MAX_CHUNKS_PER_FILE, chunkBlocks } from './kb/chunk.ts'
import type { ChunkResult } from './kb/types.ts'
import { isAsyncParsableExt } from './kb/parse-async.ts'
import { parseFileByExt } from './kb/parse-plain.ts'
import { extOf, isAcceptedExt } from './kb/types.ts'
import { kbBlobsDir, kbFilesDbPath } from './kb-paths.ts'
import { deleteKbVectorsForFile, reassignKbVectors } from './kb-vectors.ts'
import { BUSY_TEXT, DEFAULT_FILE_PAGE, INTERRUPTED_STATES, KB_FILE_DELETE_ORDER, KbFileDeleteStep, MAX_FILES_PER_KB, MAX_FILE_BYTES, blobFileName, cellStr, composeParseNote, errorText, formatBytes, inTransaction, insertChunks, isBusyError, migrate, normalizePositive, openStore, removeBlobIfUnreferenced, rowToFileMeta, warn, writeBlob } from './kb-files-store.ts'

/**
 * 登记一个文件：读原文件字节 → 算指纹 → 查重 → 落 blob 副本 → 解析 → 分块 → 入库。
 *
 * 为什么**分两档**而不是一刀切：
 *   · A / A' 档（纯文本 / HTML / CSV）一步做完 —— 解析是**同步毫秒级**的，拆成两步
 *     只会凭空造出一个中途态，用户看到「正在解析」闪一下又没了；
 *   · B 档（pdf / docx / xlsx / xls）只落一行 `queued`，正文由 `kb-queue.ts` 的执行器
 *     稍后填（那三个库要几百毫秒到几秒，见 `kb/parse-async.ts`）。
 *
 * ⚠ 用户点下「添加」到正文可检索，B 档中间有一段等待。触发执行器的**不是**这里
 * （那会让存储层反向依赖队列），而是 `gateway.addKbFiles` 与网关启动时的清扫
 * —— 两个入口都在 `gateway.ts` 里，一处不漏地看得见。
 *
 * 失败一律**返回**而不是抛：调用方是 `@Remote`，抛出去会变成一句无从下手的
 * 「调用失败」，而这里的每一种失败都能说清楚（重复 / 太大 / 类型不支持 / 读不到）。
 * @param decryptedDir - 解密数据根（库与 blob 都在它的父目录下）。
 * @param input - 目标库、原文件路径、是否参与向量化。
 * @returns 成功时带上落地的那一行；失败时带 `code` 与人话原因。
 */
export function registerKbFile(decryptedDir: string, input: KbFileRegisterInput): KbFileRegisterResult {
  const kbId = normalizePositive(input?.kbId)
  if (kbId === undefined) return { ok: false, code: 'bad-kb', error: '没有指定知识库（可能界面漏传了库标识）' }
  const srcPath = typeof input?.srcPath === 'string' ? input.srcPath.trim() : ''
  if (!srcPath) return { ok: false, code: 'bad-path', error: '没有拿到文件路径' }
  const includeInRag = input?.includeInRag === false ? false : true

  const name = basename(srcPath)
  const ext = extOf(name)

  let bytes: Buffer
  try {
    const st = statSync(srcPath)
    // 「它是不是文件」必须**先于**「类型认不认得」判定：给一个目录报「不支持的类型」
    // 是归因错误（目录根本没有类型），而这两种情况的排查方向完全不同 ——
    // 与「文件损坏」那句同理，属于本模块的文案纪律。
    if (!st.isFile()) return { ok: false, code: 'read-failed', error: '这个路径不是文件：' + name }
    // 对话框的 filters 是白名单，正常路径下选不到别的类型；这一层挡的是绕过对话框的
    // 调用（拖拽 / 直接调 RPC），并且要说清楚是**类型**不支持。
    if (!isAcceptedExt(ext)) {
      return {
        ok: false,
        code: 'not-accepted',
        error: '不支持的类型：' + (ext ? '.' + ext : '（没有扩展名）'),
      }
    }
    if (st.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        code: 'too-large',
        error: '文件过大（' + formatBytes(st.size) + '），上限 ' + formatBytes(MAX_FILE_BYTES),
      }
    }
    bytes = readFileSync(srcPath)
  } catch (e) {
    return { ok: false, code: 'read-failed', error: '读不到这个文件：' + errorText(e) }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')

  let db: DatabaseSync
  try {
    db = openStore(decryptedDir)
  } catch (e) {
    // 打不开也可能是「别人正拿着锁」—— `openStore` 里的 `migrate` 要写 PRAGMA。
    // 那一类说成「写库失败」会把人引去查磁盘，而真正的动作只是等一下再来。
    return { ok: false, code: 'store-failed', error: isBusyError(e) ? BUSY_TEXT : errorText(e) }
  }

  try {
    const dup = db.prepare('SELECT id, name FROM kb_files WHERE kb_id = ? AND sha256 = ?').get(kbId, sha256) as Record<string, unknown> | undefined
    if (dup !== undefined) {
      const existing = { id: Number(dup['id'] ?? 0), name: cellStr(dup['name']) }
      return {
        ok: false,
        code: 'duplicate',
        duplicateOf: existing,
        // 按**内容**判定：改名重传不会被当成新文件。
        error: '该文件已在当前库中（按内容判定）：' + (existing.name || '未命名'),
      }
    }

    const cntRow = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE kb_id = ?').get(kbId) as Record<string, unknown> | undefined
    if (Number(cntRow?.['n'] ?? 0) >= MAX_FILES_PER_KB) {
      return { ok: false, code: 'too-many', error: '当前库的文件数已达上限 ' + MAX_FILES_PER_KB + ' 个' }
    }

    // 副本先落盘：解析失败也要有副本，否则「重新解析」得让用户再找一次原文件。
    let blobName = ''
    let blobNote = ''
    try {
      blobName = blobFileName(sha256, ext)
      writeBlob(decryptedDir, blobName, bytes)
    } catch (e) {
      blobName = ''
      // 不因此拒绝入库：磁盘满 / 权限受限时用户仍然应该能用「读取原文件」的这条路，
      // 只是要知道代价 —— 原文件一旦被移动或删除，这份内容就需要重新上传。
      blobNote = '无法保存内容副本（' + errorText(e) + '），原文件被移动或删除后需要重新上传'
      warn(blobNote)
    }

    /**
     * B 档 ⇒ **不在这里解析**，只落一行 `queued`。
     *
     * 为什么不 `await` 到底：本函数是 `@Remote('addKbFiles')` 的同步实现，而 PDF / Word /
     * Excel 的解析要几百毫秒到几秒。在这里等，用户点下「确定」之后界面整个冻住，
     * 而且 IPC 期间**所有**其它接口都会被一起挡住（计划 H4 的验收就是这一条）。
     * 立刻返回还有一个好处：多选 10 个 PDF 时回执当场就能给「10 个都进来了」，
     * 而不是等十几秒才弹一次结果。
     *
     * 代价是「登记成功」与「能被检索到」之间多了一段等待 —— 这由 `parse_state`
     * 如实呈现（界面上是「等待解析 → 正在解析 → 已就绪」），而不是假装已经好了。
     */
    const asyncParsed = isAsyncParsableExt(ext)
    let parseState: KbFileParseState = 'queued'
    let parser = ''
    let parseError = blobNote
    let chunked: ChunkResult = { chunks: [], truncated: false, chunkCount: 0, charCount: 0 }

    if (!asyncParsed) {
      const outcome = parseFileByExt(ext, new Uint8Array(bytes))
      parser = outcome.parser
      parseState = outcome.state === 'ready' ? 'ready' : 'unsupported'
      if (outcome.state === 'ready') chunked = chunkBlocks(outcome.blocks)
      parseError = [blobNote, composeParseNote(outcome.note, chunked.truncated)].filter(Boolean).join('；')
    }

    const now = Date.now()
    let fileId = 0
    // 不变量 ②：`ready` 与它的 chunk 行在同一个事务里。
    inTransaction(db, () => {
      const res = db.prepare(
        'INSERT INTO kb_files(kb_id, name, ext, src_path, sha256, blob_name, size_bytes, parse_state, parser, parse_error, chunk_count, char_count, include_in_rag, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        kbId, name, ext, srcPath, sha256, blobName, bytes.length,
        parseState, parser, parseError, chunked.chunkCount, chunked.charCount,
        includeInRag ? 1 : 0, now, now,
      )
      fileId = Number(res.lastInsertRowid)
      insertChunks(db, fileId, kbId, chunked.chunks)
    })

    const row = db.prepare('SELECT * FROM kb_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined
    return { ok: true, file: rowToFileMeta(row ?? {}) }
  } catch (e) {
    return { ok: false, code: 'store-failed', error: isBusyError(e) ? BUSY_TEXT : errorText(e) }
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 列表
// ────────────────────────────────────────────────────────────────────────────

/** 列表分页参数。 */
export interface KbFileListOptions {
  limit?: number
  offset?: number
}

/**
 * 列出一个库里的文件（新上传的在前）。
 *
 * ⚠ **每一处查询都带 `WHERE kb_id = ?`** —— 少一处，单库测试全绿、多库才串数据，
 * 而那时已经很难归因了（这是计划里点名的「静默失效」之一，变异测试第 1 条咬的就是它）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param opts - 分页。
 * @returns 列表；库读不到时给 `readError`，而不是把空列表伪装成「一个文件都没有」。
 */
export function listKbFiles(decryptedDir: string, kbId: number, opts: KbFileListOptions = {}): KbFileListSnapshot {
  const kb = normalizePositive(kbId) ?? 0
  const rawLimit = Math.trunc(Number(opts.limit ?? DEFAULT_FILE_PAGE))
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_FILE_PAGE, 1), MAX_FILES_PER_KB)
  const rawOffset = Math.trunc(Number(opts.offset ?? 0))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT * FROM kb_files WHERE kb_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(kb, limit, offset) as Array<Record<string, unknown>>
      const cntRow = db.prepare('SELECT COUNT(*) AS n FROM kb_files WHERE kb_id = ?').get(kb) as Record<string, unknown> | undefined
      return { kbId: kb, items: rows.map(rowToFileMeta), total: Number(cntRow?.['n'] ?? 0) }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[kb-files] 文件列表读取失败：' + kbFilesDbPath(decryptedDir) + ': ' + readError)
    return { kbId: kb, items: [], total: 0, readError }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 读某个文件的正文（分块）
// ────────────────────────────────────────────────────────────────────────────

/** 一次最多回多少个块。 */
export const MAX_CHUNK_PAGE = 200
/** 默认每页块数（一屏读得完的量）。 */
export const DEFAULT_CHUNK_PAGE = 60

/**
 * 列出一个文件解析出来的正文块。
 *
 * 这是「读这篇文档」的唯一出口：界面上原先只有登记台账（大小 / 块数 / 指纹 / 路径），
 * 正文虽然确实进了 `kb_chunks.text`，却只在**搜索命中**时以摘要片段的形式露出来 ——
 * 不输入关键词就读不到内容。
 *
 * ⚠ **两个作用域条件都要**：`file_id` 定位文件，`kb_id` 确认它属于当前库。
 * 只卡 `file_id` 的话，传一个别的库的 fileId 就能读到那个库的正文 ——
 * 单库测试全绿，多库才串，而且这条串的是**内容**不是计数，比 `listKbFiles` 那边更严重。
 *
 * 返回的是**解析出来的文本**，不是原文件的排版：PDF/DOCX 的表格、图片、页眉页脚
 * 在解析阶段就已经丢了。所以界面上必须说清「这是检索与问答实际看到的正文」，
 * 不能让用户以为在看原稿 —— 那两种读法得到的结论可以不一样。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库（必填，没有「所有库」模式）。
 * @param fileId - 目标文件。
 * @param opts - 分页（按 `ordinal` 升序，即文档原有顺序）。
 * @returns 块列表与总数；读不到或文件不在本库时给 `readError`。
 */
export function listKbFileChunks(
  decryptedDir: string, kbId: number, fileId: number, opts: { limit?: number; offset?: number } = {},
): KbFileChunkPage {
  const kb = normalizePositive(kbId) ?? 0
  const file = normalizePositive(fileId) ?? 0
  const empty: KbFileChunkPage = { kbId: kb, fileId: file, items: [], total: 0, totalChars: 0 }
  if (kb === 0 || file === 0) return { ...empty, readError: '参数无效：kbId 与 fileId 都必须是正整数' }
  const rawLimit = Math.trunc(Number(opts.limit ?? DEFAULT_CHUNK_PAGE))
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_CHUNK_PAGE, 1), MAX_CHUNK_PAGE)
  const rawOffset = Math.trunc(Number(opts.offset ?? 0))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
  try {
    const db = openStore(decryptedDir)
    try {
      // 先确认这个文件在**当前库**里：不在就直接返回，一条正文都不读。
      const owner = db.prepare('SELECT id FROM kb_files WHERE id = ? AND kb_id = ?').get(file, kb) as Record<string, unknown> | undefined
      if (owner === undefined) {
        return { ...empty, readError: '文件不存在，或不属于当前知识库' }
      }
      const rows = db.prepare(
        'SELECT ordinal, page, heading, text, char_count FROM kb_chunks '
        + 'WHERE file_id = ? AND kb_id = ? ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?',
      ).all(file, kb, limit, offset) as Array<Record<string, unknown>>
      const cnt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(char_count), 0) AS c FROM kb_chunks WHERE file_id = ? AND kb_id = ?')
        .get(file, kb) as Record<string, unknown> | undefined
      return {
        kbId: kb,
        fileId: file,
        items: rows.map(r => ({
          ordinal: Number(r['ordinal'] ?? 0),
          page: Number(r['page'] ?? 0),
          heading: cellStr(r['heading']),
          text: cellStr(r['text']),
          charCount: Number(r['char_count'] ?? 0),
        })),
        total: Number(cnt?.['n'] ?? 0),
        totalChars: Number(cnt?.['c'] ?? 0),
      }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[kb-files] 文件正文读取失败：' + kbFilesDbPath(decryptedDir) + ': ' + readError)
    return { ...empty, readError }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 崩溃恢复
// ────────────────────────────────────────────────────────────────────────────

/**
 * 已经做过崩溃恢复的数据根（按库文件路径记）。
 *
 * **只在进程启动时重置一次**，而不是每次读列表时判断 —— 后者是这类功能最常见的
 * 走捷径写法，它的 bug 是：用户正在上传一个大文件（状态 = `parsing`），
 * 此时任何一次列表刷新都会把它判成「崩溃残留」并打回 `queued`，
 * 于是一次正常的解析被自己的读操作打断（计划 R7）。
 */
export const recoveredRoots = new Set<string>()

/**
 * 把上次进程留下的中间态重置为 `queued`。
 *
 * **调用点是网关启动时一次**，不要在读路径里调。
 * 同一个数据根在本进程内只做一次：第二次返回 `{ reset: 0, skipped: true }`，
 * 好让「只做一次」这件事可被断言，而不是只能靠读代码相信。
 * @param decryptedDir - 解密数据根。
 * @returns 本次重置的行数与是否被跳过。
 */
export function recoverInterrupted(decryptedDir: string): KbFileRecoveryReport {
  const key = kbFilesDbPath(decryptedDir)
  if (recoveredRoots.has(key)) return { reset: 0, skipped: true }
  // 先登记再干活：万一这次失败，也不该在每次读列表时重试同一件大概率仍会失败的事
  // （失败原因通过 readError 暴露给启动日志）。
  recoveredRoots.add(key)
  try {
    const db = openStore(decryptedDir)
    try {
      const placeholders = INTERRUPTED_STATES.map(() => '?').join(', ')
      const res = db.prepare('UPDATE kb_files SET parse_state = \'queued\', updated_at = ? WHERE parse_state IN (' + placeholders + ')')
        .run(Date.now(), ...INTERRUPTED_STATES)
      return { reset: Number(res.changes ?? 0), skipped: false }
    } finally {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
  } catch (e) {
    const readError = errorText(e)
    warn('崩溃恢复失败：' + readError)
    return { reset: 0, skipped: false, readError }
  }
}

/** 仅供用例清掉「只做一次」的进程内记忆（`recoverInterrupted` 的守卫本身不被绕过）。 */
export function resetRecoveryGuardForTest(): void {
  recoveredRoots.clear()
}

// ────────────────────────────────────────────────────────────────────────────
// 删除
// ────────────────────────────────────────────────────────────────────────────

/** 级联删除的上下文：字段在步骤之间传递（`chunks` 填 `chunkIds`，`fts` 用）。 */
export interface CascadeContext {
  db: DatabaseSync
  decryptedDir: string
  fileId: number
  sha256: string
  blobName: string
  chunkIds: number[]
  removedChunks: number
  removedBlob: boolean
}

/**
 * 五个删除步骤的实现表。**键就是 `KB_FILE_DELETE_ORDER` 的元素** ——
 * 顺序由那个数组决定，这里只管每一步做什么，不重复表达次序。
 */
export const CASCADE_STEPS: Record<KbFileDeleteStep, (c: CascadeContext) => void> = {
  chunks: (c) => {
    // 先取 id 再删表：FTS 行的 rowid 就是 chunk id，删完表就问不出来了。
    const rows = c.db.prepare('SELECT id FROM kb_chunks WHERE file_id = ?').all(c.fileId) as Array<Record<string, unknown>>
    c.chunkIds = rows.map((r) => Number(r['id'] ?? 0))
    c.removedChunks = c.chunkIds.length
    c.db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(c.fileId)
  },
  fts: (c) => {
    if (c.chunkIds.length === 0) return
    const del = c.db.prepare('DELETE FROM kb_chunks_fts WHERE rowid = ?')
    for (const id of c.chunkIds) del.run(id)
  },
  vectors: (c) => {
    /**
     * 向量在**另一个库文件**里（`wechat_kb_vectors.db`）—— 跨库在 SQLite 里就是两个连接、
     * 两次独立提交，**没有事务可依赖**。这正是 `KB_FILE_DELETE_ORDER` 把这一步排在 `blob`
     * 之前的另一半理由：它无论如何都不是原子的，那就让它在「还拿得到 chunkIds」之后尽早做完。
     *
     * best-effort 为什么站得住：`searchKbDense` 回读时会重新 JOIN `kb_chunks` / `kb_files`
     * 并**再判一次** `include_in_rag`，残留的派生行既进不了结果、也绕不过隐私开关。
     * 删不掉由 `deleteKbVectorsForFile` 自己留痕（不抛）—— 登记行该删还是要删。
     */
    deleteKbVectorsForFile(c.decryptedDir, c.fileId)
  },
  blob: (c) => {
    c.removedBlob = removeBlobIfUnreferenced(c.db, c.decryptedDir, c.sha256, c.blobName)
  },
  file: (c) => {
    c.db.prepare('DELETE FROM kb_files WHERE id = ?').run(c.fileId)
  },
}
