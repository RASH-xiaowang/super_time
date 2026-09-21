/**
 * `query/export.ts` 的「落盘与上下文：原子写、zip 原子落地、data URL、导出上下文」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-io
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ZipFileWriter, zipFiles, partialPath, reportProgress, throwIfCancelled } from './zip.ts'
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
