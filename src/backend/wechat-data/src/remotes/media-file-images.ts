/**
 * 文件库图片的两个 Remote 实现（2026-10-21 从 `remotes/media.ts` 拆出）。
 *
 * 为什么拆：`remotes/media.ts` 已 1020 行（>1000 棘轮）、`createMediaRemotes` 355 行
 * （登记 317）。这里只搬实现、不动签名：工厂返回同名方法，media.ts 里用
 * `...createFileImageRemotes(rc)` 展开，行为与逐字搬运前一致。
 */
import type { FileImageDataUrlsResult, ImageDataUrlResult } from '../types.ts'
import { ensureFileImageDecoded, ensureFileImagesDecodedBatch } from '../query/file-image-on-demand.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'

/** 这些方法只需要数据根与原目录解析（与其它 media Remote 一致）。 */
export interface FileImageRemoteCtx {
  dirs: () => { decrypted: string; decoded: string }
  rawWechatBase: (decrypted: string) => string
}

/**
 * 构造文件库图片的两个 Remote 方法。
 * @param rc - 运行上下文（`dirs()` / `rawWechatBase()`）。
 * @returns 单张与批量两个方法（签名与拆分前完全一致）。
 */
export function createFileImageRemotes(rc: FileImageRemoteCtx): {
  getFileImageDataUrl: (options: { md5: string; thumbFirst?: boolean }) => Promise<ImageDataUrlResult>
  getFileImageDataUrls: (options: { keys: string[]; thumbFirst?: boolean }) => Promise<FileImageDataUrlsResult>
} {
  /** 取一次密钥/目录（两个方法都要用）。 */
  const context = (): { decryptedDir: string; decodedDir: string; rawBase: string; aesKey?: string | Uint8Array; xorKey: number } => {
    const dec = rc.dirs().decrypted
    const { aesKey, xorKey } = resolveImageKeyPair(dec)
    return { decryptedDir: dec, decodedDir: rc.dirs().decoded, rawBase: rc.rawWechatBase(dec) || '', aesKey, xorKey }
  }
  return {
    /**
     * 文件库图片（附件文件名前缀）→ decoded 相对路径（`wechat-media://` 流式显示）。
     * 按需解密并落缓存；`thumbFirst=true`（网格）优先 `_t` 档，false（灯箱）原图档优先。
     */
    async getFileImageDataUrl(options: { md5: string; thumbFirst?: boolean }): Promise<ImageDataUrlResult> {
      return await ensureFileImageDecoded({ ...context(), key: options.md5, thumbFirst: options.thumbFirst === true })
    },
    /**
     * 批量取文件库图片（一屏 1 次 RPC）：去重、上限 48、块内并行且总解码并发 ≤4。
     * @returns 逐条 `{key, file?, error?}`；按 `key` 回贴，别按下标。
     */
    async getFileImageDataUrls(options: { keys: string[]; thumbFirst?: boolean }): Promise<FileImageDataUrlsResult> {
      const items = await ensureFileImagesDecodedBatch(context(), options?.keys ?? [], options?.thumbFirst !== false)
      return { items }
    },
  }
}
