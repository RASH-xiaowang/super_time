/**
 * 批量取表情的**计算体**（E1，2026-09-28 性能修复）。
 *
 * ## 为什么单独一个文件
 *
 * ① 它是一段完整的**两趟算法**（先纯本地全过一遍、再只对剩下的并发出网），本身就该能
 *    单测、能单独读；塞在 `createMediaRemotes` 里会让那个函数继续长（本仓有单函数行数
 *    棘轮，且**只许变小**）。
 * ② 与 `image-original-batch.ts` / `remote-image.ts` 同一个形状：`remotes/*.ts` 只留
 *    「取 ctx、解析目录与密钥、一行转发」，算法在 `query/` 下。
 *
 * ## 现场数据（为什么值得做）
 *
 * 日志里 `getEmoticonDataUrl` 13 次、**均 27,253ms、峰值 71,909ms**。两个原因叠在一起：
 * ① 前端逐张发 RPC（与封面的 A1 同病）；② 后端每次未命中都递归扫整棵 `msg/attach`
 * （E2 已改成查索引）。这里解决 ①。
 */
import { resolveImageKeyPair } from './image-key.ts'
import { decodeEmoticonDataUrl, fetchEmoticonRemote, noteEmoticonMissBatch } from './media-image.ts'
import type { EmoticonDataUrlsResult } from '../types.ts'

/**
 * 批量取表情时的并发上限。
 * 与 `article-cover.ts` 的 `COVER_CONCURRENCY` 取同一个数：单条一个网络往返，
 * 太高会被 CDN 限流，太低退化成串行。
 */
const EMOTICON_FETCH_CONCURRENCY = 8

/**
 * 批量取表情（两趟设计）。
 *
 * ## 为什么顺序是「先本地全过一遍，再对剩下的并发取远端」
 *
 * 不能「逐条走完整链」—— 那样每条都要等一次网络往返，N 条就是 N 个往返的时间。
 * 拆成两趟之后：第一趟纯本地（查索引 + 解码，无网络，很快），把命中的直接定下来；
 * 第二趟只对剩下的并发出网，并由 {@link EMOTICON_FETCH_CONCURRENCY} 限流。
 * @param decryptedDir - 解密目录（推导原始微信目录与密钥用）。
 * @param decodedDir - 解码缓存目录（落盘与探测用）。
 * @param base - 原始微信目录（`msg/attach` 的父级）；缺省时只能纯本地 + 无目录兜底。
 * @param items - 待取的表情（自动去重、忽略空 md5）。
 * @returns 逐条结果，`md5` 回信；顺序 = 去重后的入参顺序。
 */
export async function fetchEmoticonDataUrlsBatch(
  decryptedDir: string,
  decodedDir: string,
  base: string | undefined,
  items: ReadonlyArray<{ md5: string; emojiUrl?: string }> | undefined,
): Promise<EmoticonDataUrlsResult> {
  const { aesKey, xorKey } = resolveImageKeyPair(decryptedDir)
  // 去重（同一个表情在一屏里出现多次是常态），并保留原始大小写供远端 URL 使用。
  const seen = new Set<string>()
  const dedup: Array<{ m: string; url?: string }> = []
  for (const it of Array.isArray(items) ? items : []) {
    const m = (it?.md5 ?? '').trim().toLowerCase()
    if (m === '' || seen.has(m)) continue
    seen.add(m)
    dedup.push(it?.emojiUrl ? { m, url: it.emojiUrl } : { m })
  }
  const out: EmoticonDataUrlsResult['items'] = dedup.map(d => ({ md5: d.m }))
  // 第一趟：纯本地。命中的直接定稿，未命中的攒起来。
  // 负缓存不逐条记：这一趟里同一棵 attach 树只查一次索引，屏上几十张缺失表情没必要各记一条。
  const needRemote: number[] = []
  let misses = 0
  for (let i = 0; i < dedup.length; i += 1) {
    const d = dedup[i]!
    const local = decodeEmoticonDataUrl(decryptedDir, decodedDir, base, d.m, aesKey, xorKey)
    if (local.url) {
      out[i] = { md5: d.m, dataUrl: local.url, ...(local.format ? { format: local.format } : {}) }
      continue
    }
    out[i] = { md5: d.m, error: local.error ?? '本地解码失败' }
    // 只有「本机确实没有」才够格去远端；负缓存那条命中时同样走这个分支。
    if (local.error?.includes('未找到表情文件')) misses += 1
    if (d.url !== undefined) needRemote.push(i)
  }
  if (misses > 0 && base) noteEmoticonMissBatch(base, misses)
  // 第二趟：剩下的并发出网，分批限流。
  for (let i = 0; i < needRemote.length; i += EMOTICON_FETCH_CONCURRENCY) {
    const batch = needRemote.slice(i, i + EMOTICON_FETCH_CONCURRENCY)
    await Promise.all(batch.map(async (idx) => {
      const d = dedup[idx]!
      const remote = await fetchEmoticonRemote(d.url as string, decodedDir, d.m,
        base ? { wechatBaseDir: base } : {})
      const prev = out[idx]?.error ?? '本地解码失败'
      out[idx] = remote.url
        ? { md5: d.m, dataUrl: remote.url, ...(remote.format ? { format: remote.format } : {}) }
        : { md5: d.m, error: prev + '；' + (remote.error ?? '远端取图失败') }
    }))
  }
  return { items: out }
}
