/**
 * 解码缓存的**批量预热**（N16 的接线点）：一次按 md5 找齐 .dat，逐张解码写进缓存目录。
 *
 * 为什么住在这一层、又为什么单独成文件：这一族原先在 `GatewayCore` 里，是全类**唯一**直接读写
 * 文件的地方（#20 第五刀按报告 §P2-2 第 2 条把它下沉出 core）。报告点的名是
 * `query/media-image.ts`，但那份当时已经 931 行、而本仓的硬闸门是「单文件 1000 行、白名单只许变短」
 * —— 再并进来只剩 9 行余量，等于给下一位留雷。方向不变（fs 写离开 core、落在 query 层），
 * 位置换成同层的这颗叶子；它只依赖 `media-image.ts` 的三个出口。
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeAesKey } from '../keys/image-key.ts'
import { resolveImageFilePathsByMd5, resolveImageMd5sBatch } from './media-image.ts'
import { decodeDatBytesAsync } from './media-image-async.ts'

/** 预热与单张入口共用的缓存扩展名（命中其中任意一个就不重写）。 */
export const CACHED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif']

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 批量预热「按用户」解码缓存（N16 的接线点，见 `getImageDataUrlsBatch`）。
 *
 * 为什么是「预热」而不是「在这里返回结果」：解码产物与单张入口共用同一份缓存目录/命名
 * （`<decoded>/<username>/<md5>.<ext>`），写进去之后单张入口命中缓存、不再查路径表 ——
 * 于是错误语义、`data_index` 兜底、hevc 判定这些**全部沿用单张入口**，不必在调用方复制一份解码逻辑。
 * 2026-09-27 #20 第五刀：这一族原先住在 `GatewayCore` 里 —— 那是全类**唯一**直接读写文件的地方，
 * 报告 §P2-2 第 2 条要求「含 fs 写的能力下沉回 query 层，core 只做编排」，于是搬到这里。
 *
 * 全程 best-effort：任何一处失败都只是「那张图回退到原来的逐张路径」，不影响其余张；
 * 命中已有缓存的文件不重写。
 * @param decryptedDir - 解密库目录（hardlink.db 所在）。
 * @param decodedDir - 解码缓存根。
 * @param baseDir - 微信原始目录（候选路径的根）。
 * @param items - 待预热的 (username, localId) 列表。
 * @param aesKey - V2 AES key。
 * @param xorKey - XOR key 字节。
 * @param knownMd5s - md5 resolved by the caller in the same pass; optional.
 */
export async function warmDecodedImages(
  decryptedDir: string,
  decodedDir: string,
  baseDir: string,
  items: ReadonlyArray<{ username: string; localId: number }>,
  aesKey: string | undefined,
  xorKey: number,
  knownMd5s?: readonly string[],
): Promise<void> {
  try {
    // md5 也批量查（每个 (username, 分片) 一次 IN）—— 见 `resolveImageMd5sBatch` 的注释：
    // 原本只有下面的路径查询合并了，md5 仍是每张开一次库，在慢机器上等于没省。
    const md5ByItem = knownMd5s ?? resolveImageMd5sBatch(decryptedDir, items)
    const wanted = md5ByItem.filter(m => m.length === 32)
    if (wanted.length === 0) return
    // 唯一一次「按 md5 找 .dat」的查询（N16 的收益点：N 张图从 N 次全表扫降到 1 次 IN）。
    const paths = resolveImageFilePathsByMd5(decryptedDir, baseDir, wanted)
    if (paths.size === 0) return
    const aesBytes = normalizeAesKey(aesKey)
    for (let i = 0; i < items.length; i += 1) {
      const md5 = md5ByItem[i] ?? ''
      // 批量结果是按小写键存的（`resolveImageFilePathsByMd5` 会归一化），这里也归一化，
      // 免得「消息里存的是大写 md5」那一条悄悄退回逐张查询。
      const src = md5 ? paths.get(md5.toLowerCase()) : undefined
      if (!src) continue
      const it = items[i]!
      const outDir = join(decodedDir, it.username)
      let cached = false
      for (const ext of CACHED_IMAGE_EXTS) {
        if (await pathExists(join(decodedDir, md5 + '.' + ext)) || await pathExists(join(outDir, md5 + '.' + ext))) {
          cached = true
          break
        }
      }
      if (cached) continue
      try {
        const dec = await decodeDatBytesAsync(new Uint8Array(await readFile(src)), aesBytes, xorKey)
        if ('error' in dec || dec.format === 'hevc') continue
        await mkdir(outDir, { recursive: true })
        await writeFile(join(outDir, md5 + '.' + dec.format), Buffer.from(dec.bytes))
      } catch { /* 单张解码失败：回退到单张入口的原路径 */ }
    }
  } catch { /* 预热是优化，失败不影响正确性 */ }
}
