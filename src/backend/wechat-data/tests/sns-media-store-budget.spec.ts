// @vitest-environment node
/**
 * W3-4.3：朋友圈原图仓的**双上限**淘汰（字节 + 条数）。
 *
 * ## 为什么条数也要一个上限
 *
 * 字节上限在「平均大小稳定」时有效，但有两类情形它管不到：
 *   ① 很多小图（表情、缩略图，几十 KB）—— 字节远没到，条数已经上万；
 *   ② 同一张图被反复重新保存 —— 字节不涨，条数涨。
 * 后者耗的是 inode/目录项，Windows 上一个目录数万条之后列目录会明显变慢。
 *
 * ## 判据怎么量
 *
 * 造三种形状的仓，分别只超一种上限：
 *   A. 只有字节超（少量大文件）⇒ 删到字节内；
 *   B. 只有条数超（大量小文件，总字节很小）⇒ 删到条数内 ——**这条是新增的**，
 *      字节口径下它一条都不删（`return 0`），所以是纯增量；
 *   C. 都不超 ⇒ 一条不删（反向哨兵：否则判据退化成"见文件就删"）。
 * 另外钉删除顺序仍按 `mtime` 升序（最旧的先走），以及两个默认常量的分工。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  SNS_MEDIA_STORE_BUDGET_BYTES,
  SNS_MEDIA_STORE_BUDGET_FILES,
  SNS_MEDIA_STORE_SUBDIR,
  saveOriginal,
  sweepOriginalStore,
} from '../src/query/sns-media-store.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0, scratch.length)) rmSync(d, { recursive: true, force: true })
})

/** 在原图仓里直接写一个文件（绕过 saveOriginalBytes 的格式嗅探，方便控制大小与 mtime）。 */
function writeFile(root: string, md5: string, ext: string, size: number, mtimeSec: number): void {
  const shard = join(root, SNS_MEDIA_STORE_SUBDIR, md5.slice(0, 2))
  mkdirSync(shard, { recursive: true })
  const p = join(shard, `${md5}.${ext}`)
  writeFileSync(p, Buffer.alloc(size, 1))
  utimesSync(p, mtimeSec, mtimeSec)
}

const md5hex = (i: number): string => String(i).padStart(32, '0')

describe('W3-4.3：原图仓双上限', () => {
  it('A. 只有字节超 ⇒ 删到字节内', () => {
    const root = mkdtempSync(join(tmpdir(), 'sms-bytes-'))
    scratch.push(root)
    writeFile(root, md5hex(1), 'jpg', 90, 100)
    writeFile(root, md5hex(2), 'jpg', 90, 200)
    writeFile(root, md5hex(3), 'jpg', 90, 300) // 共 270
    // 预算 200：删最旧的 1（90）⇒ 剩 180
    expect(sweepOriginalStore(root, 200, 1_000_000)).toBe(1)
  })

  it('B. 只有条数超（总字节很小）⇒ 删到条数内 —— 字节口径下这条一条都不删', () => {
    const root = mkdtempSync(join(tmpdir(), 'sms-files-'))
    scratch.push(root)
    for (let i = 1; i <= 10; i += 1) writeFile(root, md5hex(i), 'jpg', 10, 100 + i)
    // 字节预算给得极大：确认「只超条数」也会触发淘汰（这正是新增的那一半）。
    const dropped = sweepOriginalStore(root, 10 * 1024 * 1024, 4)
    expect(dropped, '条数超限却没删 ⇒ 双上限没有生效').toBe(6)
    // 剩 4 个，且是最新的 4 个（按 mtime 升序删）
    expect(sweepOriginalStore(root, 10 * 1024 * 1024, 4), '再扫一次应当无事可做').toBe(0)
  })

  it('B2. 条数淘汰同样按 mtime 升序（先刪最旧的）'.replace('刪', '删'), async () => {
    const root = mkdtempSync(join(tmpdir(), 'sms-order-'))
    scratch.push(root)
    for (let i = 1; i <= 5; i += 1) writeFile(root, md5hex(i), 'jpg', 10, 100 + i)
    // 删 2 个 ⇒ 应当删掉 mtime 最小的 1、2
    expect(sweepOriginalStore(root, 10 * 1024 * 1024, 3)).toBe(2)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, SNS_MEDIA_STORE_SUBDIR, md5hex(1).slice(0, 2), md5hex(1) + '.jpg'))).toBe(false)
    expect(existsSync(join(root, SNS_MEDIA_STORE_SUBDIR, md5hex(3).slice(0, 2), md5hex(3) + '.jpg'))).toBe(true)
  })

  it('C. 两个上限都没超 ⇒ 一条不删（反向哨兵）', () => {
    const root = mkdtempSync(join(tmpdir(), 'sms-none-'))
    scratch.push(root)
    for (let i = 1; i <= 3; i += 1) writeFile(root, md5hex(i), 'jpg', 10, 100 + i)
    expect(sweepOriginalStore(root, 10 * 1024 * 1024, 100)).toBe(0)
  })

  it('D. 默认常量有分工，且都可被环境变量覆盖（测试与「我想少留点」）', () => {
    expect(SNS_MEDIA_STORE_BUDGET_BYTES).toBeGreaterThan(1024 * 1024 * 1024)
    expect(SNS_MEDIA_STORE_BUDGET_FILES).toBeGreaterThan(1000)
    // 平均值口径：条数上限换算成单张平均字节，应当落在「原图」量级而不是缩略图。
    const avg = SNS_MEDIA_STORE_BUDGET_BYTES / SNS_MEDIA_STORE_BUDGET_FILES
    expect(avg, '平均单张小于 20KB ⇒ 存的更像缩略图，条数上限失去意义').toBeGreaterThan(20 * 1024)
  })

  it('E. 经 saveOriginalBytes 写进去的也能被扫到（接线不是空的）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sms-save-'))
    scratch.push(root)
    // 1x1 透明 PNG（saveOriginalBytes 嗅探格式用）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/6r/KQAAAABJRU5ErkJggg==',
      'base64',
    )
    for (let i = 0; i < 3; i += 1) saveOriginal(root, md5hex(i), png)
    expect(sweepOriginalStore(root, 1, 100), '预算 1 字节 ⇒ 全删').toBe(3)
  })
})