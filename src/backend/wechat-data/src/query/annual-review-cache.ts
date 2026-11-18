/**
 * 年报按数据签名缓存。界面先画渲染缓存，但 worker 以前每次打开仍逐条重扫该年。
 * 消息分片和通讯录都没变时直接返回上次的结果。
 */
import { join } from 'node:path'
import type { AnnualReview } from './annual-review-types.ts'
import { queryAnnualReview as computeAnnualReview } from './annual-review.ts'
import { cachedBySigAsync, fileSigOf, shardCatalogSig } from './meta.ts'

export async function queryAnnualReview(decryptedDir: string, year: number, selfUsername = ''): Promise<AnnualReview> {
  const self = (selfUsername ?? '').trim()
  const sig = [
    shardCatalogSig(decryptedDir, ['message', 'bizchat']),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
  ].join('|')
  return cachedBySigAsync(
    'annual-review:' + decryptedDir + ':' + String(year) + ':' + self,
    sig,
    () => computeAnnualReview(decryptedDir, year, self),
  )
}
