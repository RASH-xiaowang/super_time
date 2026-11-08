// @vitest-environment jsdom
/**
 * 微信原生 OCR API 接缝：既接受主进程的 Remote 信封，也接受迁移期的裸结果，
 * 但任何非 `wechat-native` 引擎都必须被拒绝。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageOcrResult } from '../../contracts.ts'
import { apiOcrImage } from './api-media.ts'

const sample: ImageOcrResult = {
  engine: 'wechat-native',
  text: '微信识别文字',
  lines: [{ text: '微信识别文字', left: 1, top: 2, right: 30, bottom: 20, rate: 0.99 }],
  width: 320,
  height: 240,
  elapsedMs: 21,
}

let ocrImage: ReturnType<typeof vi.fn>

beforeEach(() => {
  ocrImage = vi.fn()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    wechat: { ocrImage },
  }
})

describe('apiOcrImage', () => {
  it('解包 Remote 信封', async () => {
    ocrImage.mockResolvedValue({ ok: true, value: sample })
    await expect(apiOcrImage('data:image/png;base64,AAAA')).resolves.toEqual(sample)
  })

  it('兼容直接返回识别结果', async () => {
    ocrImage.mockResolvedValue(sample)
    await expect(apiOcrImage('wechat-media://decoded/a.jpg')).resolves.toEqual(sample)
  })

  it('把主进程错误信封转成可显示的错误', async () => {
    ocrImage.mockResolvedValue({ ok: false, error: { message: '微信 OCR 插件不可用' } })
    await expect(apiOcrImage('data:image/png;base64,AAAA')).rejects.toThrow('微信 OCR 插件不可用')
  })

  it('拒绝非微信原生引擎，不静默降级到系统 OCR', async () => {
    ocrImage.mockResolvedValue({ ...sample, engine: 'windows-ocr' })
    await expect(apiOcrImage('data:image/png;base64,AAAA')).rejects.toThrow('无法识别的结果')
  })
})
