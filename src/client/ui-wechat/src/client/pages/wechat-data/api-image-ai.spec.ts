// @vitest-environment jsdom
/**
 * 图片 AI API 接缝：兼容 RemoteEnvelope / 裸结果，并拒绝被其它引擎冒名顶替。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAiJsonResult } from '../../contracts.ts'
import { apiImageAiJson } from './api-media.ts'

const sample: ImageAiJsonResult = {
  engine: 'configured-llm',
  model: 'vision-test',
  json: {
    姓名: '张三',
    性别: '男',
    民族: '汉',
    出生日期: '1990年1月2日',
    住址: '示例省示例市示例区示例路1号',
    公民身份号码: '110101199001021234',
  },
  elapsedMs: 31,
}

let imageAiJson: ReturnType<typeof vi.fn>

beforeEach(() => {
  imageAiJson = vi.fn()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    wechat: { imageAiJson },
  }
})

describe('apiImageAiJson', () => {
  it('解包 Remote 信封', async () => {
    imageAiJson.mockResolvedValue({ ok: true, value: sample })
    await expect(apiImageAiJson('data:image/png;base64,AAAA')).resolves.toEqual(sample)
  })

  it('兼容直接返回结果', async () => {
    imageAiJson.mockResolvedValue(sample)
    await expect(apiImageAiJson('wechat-media://decoded/a.jpg')).resolves.toEqual(sample)
  })

  it('把主进程错误信封转成可显示错误', async () => {
    imageAiJson.mockResolvedValue({
      ok: false,
      error: { message: '请切换支持图片输入的多模态模型', code: 'IMAGE_AI_MODEL_UNSUPPORTED' },
    })
    await expect(apiImageAiJson('data:image/png;base64,AAAA'))
      .rejects.toThrow('请切换支持图片输入的多模态模型')
  })

  it('拒绝非 AI 引擎、数组和空 JSON 对象', async () => {
    imageAiJson.mockResolvedValueOnce({ ...sample, engine: 'wechat-native' })
    await expect(apiImageAiJson('data:image/png;base64,AAAA')).rejects.toThrow('无法识别的结果')

    imageAiJson.mockResolvedValueOnce({ ...sample, json: ['x'] })
    await expect(apiImageAiJson('data:image/png;base64,AAAA')).rejects.toThrow('无法识别的结果')

    imageAiJson.mockResolvedValueOnce({ ...sample, json: {} })
    await expect(apiImageAiJson('data:image/png;base64,AAAA')).rejects.toThrow('无法识别的结果')
  })
})
