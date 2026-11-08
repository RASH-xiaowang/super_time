/**
 * 多模态图片输入优化：只压缩大图，任何异常都回退原图。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const input = require('../wechat-image-input.js') as {
  createVisionImageOptimizer: (options: Record<string, unknown>) => (
    buffer: Buffer,
    mediaType: string,
  ) => {
    buffer: Buffer
    mediaType: string
    optimized: boolean
    width: number
    height: number
  }
}

function mockImage(width: number, height: number, output: Buffer) {
  const resized = {
    toJPEG: vi.fn(() => output),
    getSize: () => ({ width: 1600, height: 1200 }),
  }
  const resize = vi.fn(() => resized)
  return {
    image: {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize,
      toJPEG: vi.fn(() => output),
    },
    resize,
  }
}

describe('createVisionImageOptimizer', () => {
  it('把超长边图片缩到 1600 并转成 JPEG', () => {
    const jpeg = Buffer.alloc(120_000, 7)
    const { image, resize } = mockImage(3200, 2400, jpeg)
    const optimize = input.createVisionImageOptimizer({
      nativeImage: { createFromBuffer: () => image },
    })

    const output = optimize(Buffer.alloc(2_000_000, 1), 'image/png')
    expect(resize).toHaveBeenCalledWith({ width: 1600, quality: 'good' })
    expect(output).toEqual({
      buffer: jpeg,
      mediaType: 'image/jpeg',
      optimized: true,
      width: 1600,
      height: 1200,
    })
  })

  it('小图不重新编码，避免无收益的画质损失', () => {
    const original = Buffer.alloc(80_000, 1)
    const { image } = mockImage(800, 600, Buffer.alloc(10_000, 2))
    const optimize = input.createVisionImageOptimizer({
      nativeImage: { createFromBuffer: () => image },
    })

    expect(optimize(original, 'image/png')).toEqual({
      buffer: original,
      mediaType: 'image/png',
      optimized: false,
      width: 800,
      height: 600,
    })
  })

  it('解码失败或压缩结果更大时回退原图', () => {
    const original = Buffer.alloc(4_000_000, 1)
    const broken = input.createVisionImageOptimizer({
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
    })
    expect(broken(original, 'image/jpeg').buffer).toBe(original)

    const { image } = mockImage(3200, 2400, Buffer.alloc(5_000_000, 3))
    const larger = input.createVisionImageOptimizer({
      nativeImage: { createFromBuffer: () => image },
    })
    expect(larger(original, 'image/jpeg').buffer).toBe(original)
  })
})
