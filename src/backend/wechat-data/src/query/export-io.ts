/**
 * `query/export.ts` 的「落盘与上下文：原子写、zip 原子落地、data URL、导出上下文」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-io
 */

import { copyFileSync, createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFileWriter, zipFiles, partialPath, reportProgress, throwIfCancelled, type StreamControl } from './zip.ts'
import { getConfig } from './config.ts'
import { resolveImageKeyPair } from './image-key.ts'

/** Decode a base64 data URL to bytes (returns null when not a base64 data URL). */
/**
 * moments 打包的媒体条目上限。
 *
 * 与改造前保持一致：旧代码是「push 之后判断 `entries.length > 5000` 才 break」，
 * 而 entries 里第一个是 moments.json，所以媒体最多 5000 条。
 * 初版流式改造写成 `>= 4999`，饱和时会少导一条（评审复刻两循环实测出来的 off-by-one）。
 */
export const MAX_MOMENT_MEDIA = 5000

/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 直接 writeFileSync 到目标路径时，中途失败（磁盘满、进程被杀、超时被掐）会留下一个
 * **看起来正常、实际截断**的导出文件 —— 比没有产出更糟，因为用户会以为导出成功了。
 * 同目录 rename 在 Windows 上同样是原子的（同一卷内不发生拷贝）。
 */
export function writeFileAtomicSync(filePath: string, data: string | Uint8Array): void {
  const tmp = partialPath(filePath)
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, filePath)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e
  }
}

/**
 * Copy a local media file into its destination without transcoding.
 *
 * Videos can be hundreds of megabytes, so buffering the whole source before
 * writing is unnecessary. The temporary-file + rename sequence keeps a failed
 * copy from leaving a truncated file that looks valid.
 */
export function copyFileAtomicSync(sourcePath: string, destinationPath: string): void {
  const tmp = partialPath(destinationPath)
  try {
    copyFileSync(sourcePath, tmp)
    renameSync(tmp, destinationPath)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* cleanup failure must not hide the original error */
    }
    throw e
  }
}

/**
 * Copy, verify the copied snapshot, then atomically rename it.
 *
 * Verifying the source before `copyFileSync` leaves a TOCTOU window while
 * WeChat may still be writing the source. The verifier runs on the completed
 * temporary copy instead, so the final destination is exactly the snapshot
 * whose bytes passed validation. The verifier returns the final destination
 * so callers can correct an extension from the copied container format.
 */
export async function copyFileVerifiedAtomicSync(
  sourcePath: string,
  requestedDestination: string,
  verify: (temporaryPath: string) => Promise<string> | string,
): Promise<string> {
  const tmp = partialPath(requestedDestination)
  try {
    await copyFile(sourcePath, tmp)
    const finalDestination = await verify(tmp)
    renameSync(tmp, finalDestination)
    return finalDestination
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* cleanup failure must not hide the original error */
    }
    throw e
  }
}

/**
 * 异步分块复制并校验。大视频/附件复制期间可以上报字节进度，也能在每个块边界取消。
 *
 * 与 `copyFileVerifiedAtomicSync` 的区别只在传输实现：验证仍在临时文件完成后进行，
 * 因而微信同时写源文件时不会把“读了一部分”的字节当成已经校验过的快照。
 */
export async function copyFileVerifiedAtomic(
  sourcePath: string,
  requestedDestination: string,
  verify: (temporaryPath: string) => Promise<string> | string,
  ctrl?: StreamControl,
): Promise<string> {
  const tmp = partialPath(requestedDestination)
  const total = statSync(sourcePath).size
  let copied = 0
  try {
    reportProgress(ctrl, 'copy', 0, total)
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        try {
          throwIfCancelled(ctrl?.signal)
          copied += chunk.length
          reportProgress(ctrl, 'copy', copied, total)
          callback(null, chunk)
        } catch (e) {
          callback(e as Error)
        }
      },
    })
    await pipeline(createReadStream(sourcePath), meter, createWriteStream(tmp))
    const finalDestination = await verify(tmp)
    throwIfCancelled(ctrl?.signal)
    renameSync(tmp, finalDestination)
    return finalDestination
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* cleanup failure must not hide the original error */
    }
    throw e
  }
}

/**
 * 异步原子写内存中的导出字节，并在分块落盘时上报进度/响应取消。
 * `Buffer` 本身已在内存里，这里解决的是大视频一次性同步写盘会独占事件循环的问题。
 */
export async function writeFileAtomicWithProgress(
  filePath: string,
  data: string | Uint8Array,
  ctrl?: StreamControl,
): Promise<void> {
  const tmp = partialPath(filePath)
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  let written = 0
  const writeChunks = async function* (): AsyncGenerator<Buffer> {
    // `Readable.from([bytes])` feeds the whole file as one chunk, so cancellation
    // cannot run until the synchronous write has already finished. Slice the
    // in-memory payload instead; cancellation and progress now happen between
    // write backpressure boundaries.
    const chunkSize = 256 * 1024
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      throwIfCancelled(ctrl?.signal)
      yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    }
  }
  try {
    reportProgress(ctrl, 'write-bytes', 0, bytes.length)
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        try {
          throwIfCancelled(ctrl?.signal)
          written += chunk.length
          reportProgress(ctrl, 'write-bytes', written, bytes.length)
          callback(null, chunk)
        } catch (e) {
          callback(e as Error)
        }
      },
    })
    await pipeline(Readable.from(writeChunks()), meter, createWriteStream(tmp))
    throwIfCancelled(ctrl?.signal)
    renameSync(tmp, filePath)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* cleanup failure must not hide the original error */
    }
    throw e
  }
}

/**
 * 流式产出一个 ZIP 并原子落地。
 *
 * 与单文件版同理，但内容由 `produce` 现场逐条写入 —— 峰值内存只与**单个条目**相关，
 * 而不是所有条目之和（整账号归档最多 1000 个会话，原先会把全部文本堆在内存里）。
 * 每条写入都会 await 背压，因此也把事件循环让给同进程里的其它查询。
 *
 * @param filePath - 最终目标路径。
 * @param produce - 往写入器里添加条目的回调。
 */
export async function writeZipAtomic(
  filePath: string,
  produce: (zip: ZipFileWriter) => Promise<void>,
): Promise<void> {
  const tmp = partialPath(filePath)
  let zip: ZipFileWriter | null = null
  try {
    // create 也放在 try 里：打开失败同样可能已经留下一个 0 字节的临时文件。
    zip = await ZipFileWriter.create(tmp)
    await produce(zip)
    await zip.close()
    renameSync(tmp, filePath)
  } catch (e) {
    // 失败必须删掉半成品：一个截断的 .zip 看起来是有效归档，打开才发现坏。
    if (zip) await zip.abort()
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 已删除 */
    }
    throw e
  }
}

export function dataUrlToBuffer(url: string): Buffer | null {  const m = url.match(/^data:[^;,]+;base64,(.*)$/)
  if (!m || !m[1]) return null
  try { return Buffer.from(m[1], 'base64') } catch { return null }
}

/** Media-resolution context (raw base dir + image AES/xor keys) from config. */
export function exportMediaCtx(decrypted: string): { base: string | undefined; aesKey: string | undefined; xorKey: number } {
  const cfg = getConfig(decrypted)
  const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
  let base = ''
  if (dbDir) {
    const parts = dbDir.replace(/[\\/]+$/, '').split(/[\\/]/)
    base = (parts[parts.length - 1] ?? '') === 'db_storage' ? parts.slice(0, -1).join('/') : ''
  }
  // 密钥对只在 `image-key.ts` 一处判定（config/secrets 优先，回退 keys.json 的自动获取结果）
  const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
  return { base: base || undefined, aesKey, xorKey }
}
