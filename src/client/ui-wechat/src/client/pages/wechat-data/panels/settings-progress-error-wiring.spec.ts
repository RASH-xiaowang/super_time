// @vitest-environment node
/**
 * 设置页四条长任务的进度收尾守卫。
 *
 * 这四条路的前端进度都靠轮询画出来，而 RPC 若在轮询更新前抛错，
 * 旧实现只把「按钮忙」关掉，进度块会一直停在 active: true ——
 * 用户看到的是一条永远不会结束的进度条。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const state = readStripped(join(HERE, 'settings-state.tsx'))
const decryptAll = sliceBetween(state, 'const decryptAll = ', '\n  const decryptImgs', 'decryptAll 回调体')
const decryptImgs = sliceBetween(state, 'const decryptImgs = ', '\n  const scanOriginals', 'decryptImgs 回调体')
const fetchOriginals = sliceBetween(state, 'const fetchOriginals = ', '\n  const upgradeImgs', 'fetchOriginals 回调体')
const upgradeImgs = sliceBetween(state, 'const upgradeImgs = ', '\n  const keyOk', 'upgradeImgs 回调体')

describe('设置页长任务：异常路径也必须收起进度块', () => {
  it('数据库解密失败时关掉 dbProgress.active', () => {
    expect(decryptAll, 'dbProgress 没有在 finally 里关闭 active')
      .toContain('setDbProgress((prev) => ({ ...prev, active: false }))')
  })

  it('图片解密失败时关掉 imgProgress.active', () => {
    expect(decryptImgs, 'imgProgress 没有在 finally 里关闭 active')
      .toContain('setImgProgress((prev) => ({ ...prev, active: false }))')
  })

  it('批量取原图失败时关掉 origProgress.active', () => {
    expect(fetchOriginals, 'origProgress 没有在 finally 里关闭 active')
      .toContain('setOrigProgress((prev) => ({ ...prev, active: false }))')
  })

  it('原图升级失败时关掉 imgUpgradeProgress.active', () => {
    expect(upgradeImgs, 'imgUpgradeProgress 没有在 finally 里关闭 active')
      .toContain('setImgUpgradeProgress((prev) => ({ ...prev, active: false }))')
  })
})
