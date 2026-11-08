/**
 * 图片文字 AI 服务：来源校验、临时文件清理、多模态消息投影、严格 JSON 解析。
 * 不联网，也不把识别正文写入断言失败信息以外的日志。
 * @vitest-environment node
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const ai = require('../wechat-image-ai.js') as {
  parseModelJson: (content: unknown) => Record<string, unknown>
  createWechatImageAiService: (options: Record<string, unknown>) => {
    recognize: (source: unknown) => Promise<{
      engine: string
      model: string
      json: Record<string, unknown>
      elapsedMs: number
    }>
  }
}

const identityJson = {
  姓名: '张三',
  性别: '男',
  民族: '汉',
  出生日期: '1990年1月2日',
  住址: '示例省示例市示例区示例路1号',
  公民身份号码: '110101199001021234',
}
const identityContent = JSON.stringify(identityJson)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'super-time-image-ai-test-'))
  roots.push(dir)
  return dir
}

function dataUrl(text = 'fake-image'): string {
  return 'data:image/jpeg;base64,' + Buffer.from(text).toString('base64')
}

type GenerateRequest = {
  system?: string
  messages?: Array<{ content?: Array<Record<string, unknown>> }>
  maxTokens?: number
  thinking?: unknown
}

function bridge(content = identityContent) {
  const generate = vi.fn(async (_request: GenerateRequest) => ({ content }))
  return {
    configured: true,
    config: { model: 'vision-test' },
    generate,
  }
}

describe('AI 图片文字的 JSON 解析', () => {
  it('接受 Markdown 围栏和 JSON 前后的说明文字', () => {
    expect(ai.parseModelJson([
      '识别结果如下：',
      '```json',
      identityContent,
      '```',
      '以上是结果。',
    ].join('\n'))).toEqual(identityJson)
  })

  it('接受其它证件和普通图片提炼出的字段对象', () => {
    const passport = {
      证件类型: '中华人民共和国护照',
      姓名: '张三',
      护照号码: 'E12345678',
      出生日期: '1990年1月2日',
      签发机关: '中华人民共和国出入境管理局',
      有效期至: '2030年1月1日',
    }
    expect(ai.parseModelJson(JSON.stringify(passport))).toEqual(passport)

    const receipt = {
      发票号码: '12345678',
      购买方: '示例公司',
      价税合计: '100.00 元',
    }
    expect(ai.parseModelJson(JSON.stringify(receipt))).toEqual(receipt)
  })

  it('拒绝空对象、数组、旧 text/lines 结构和非 JSON', () => {
    expect(() => ai.parseModelJson('{}')).toThrow(/JSON 对象为空/)
    expect(() => ai.parseModelJson('["第一行"]')).toThrow(/不是 JSON 对象/)
    expect(() => ai.parseModelJson('{"text":"第一行","lines":["第一行"]}')).toThrow(/旧的 text\/lines 结构/)
    expect(() => ai.parseModelJson('抱歉，我无法识别。')).toThrow(/没有按约定返回 JSON/)
  })
})

describe('createWechatImageAiService', () => {
  it('把图片作为多模态块交给当前模型，并返回结构化 JSON', async () => {
    const temp = tempRoot()
    const model = bridge()
    const service = ai.createWechatImageAiService({
      tempRoot: temp,
      createLlm: () => model,
    })

    const result = await service.recognize(dataUrl())
    expect(result).toMatchObject({
      engine: 'configured-llm',
      model: 'vision-test',
      json: identityJson,
    })
    expect(model.generate).toHaveBeenCalledTimes(1)
    const request = model.generate.mock.calls[0]?.[0] as GenerateRequest
    expect(request.system).toContain('只输出一个严格 JSON 对象')
    expect(request.system).toContain('"姓名"')
    expect(request.system).toContain('"公民身份号码"')
    expect(request.system).toContain('text/lines')
    expect(request.system).toContain('“证件类型”')
    expect(request.system).toContain('护照')
    const content = request.messages?.[0]?.content ?? []
    const prompt = content.find((part) => part.type === 'text')
    expect(prompt?.text).toContain('先判断证件类型')
    const image = content.find((part) => part.type === 'image')
    expect(image).toMatchObject({
      type: 'image',
      mediaType: 'image/jpeg',
      data: Buffer.from('fake-image').toString('base64'),
    })
    expect(request.maxTokens).toBeGreaterThan(0)
    expect(request.thinking).toEqual({ type: 'disabled' })
    expect(readdirSync(temp), '成功路径也必须清理 data URL 临时目录').toEqual([])
  })

  it('发送前使用压缩后的图片内容', async () => {
    const model = bridge()
    const service = ai.createWechatImageAiService({
      createLlm: () => model,
      optimizeImage: () => ({
        buffer: Buffer.from('optimized-image'),
        mediaType: 'image/jpeg',
      }),
    })

    await service.recognize(dataUrl())
    const request = model.generate.mock.calls[0]?.[0] as GenerateRequest
    const image = request.messages?.[0]?.content?.find((part) => part.type === 'image')
    expect(image).toMatchObject({
      type: 'image',
      mediaType: 'image/jpeg',
      data: Buffer.from('optimized-image').toString('base64'),
    })
  })

  it('未配置模型时不发请求，并引导配置多模态模型', async () => {
    const temp = tempRoot()
    const generate = vi.fn()
    const service = ai.createWechatImageAiService({
      tempRoot: temp,
      createLlm: () => ({ configured: false, config: {}, generate }),
    })
    await expect(service.recognize(dataUrl())).rejects.toMatchObject({
      code: 'IMAGE_AI_MODEL_NOT_CONFIGURED',
    })
    expect(generate).not.toHaveBeenCalled()
    expect(readdirSync(temp)).toEqual([])
  })

  it('模型拒绝图片时返回可操作提示，非法 JSON 也会清理临时文件', async () => {
    const temp = tempRoot()
    const unsupported = bridge()
    unsupported.generate.mockRejectedValueOnce(new Error('400 image_url is not supported'))
    const service = ai.createWechatImageAiService({
      tempRoot: temp,
      createLlm: () => unsupported,
    })
    await expect(service.recognize(dataUrl())).rejects.toMatchObject({
      code: 'IMAGE_AI_MODEL_UNSUPPORTED',
    })
    expect(readdirSync(temp)).toEqual([])

    const invalid = bridge('not json')
    const invalidService = ai.createWechatImageAiService({
      tempRoot: temp,
      createLlm: () => invalid,
    })
    await expect(invalidService.recognize(dataUrl())).rejects.toMatchObject({
      code: 'IMAGE_AI_RESULT_INVALID',
    })
    expect(readdirSync(temp)).toEqual([])
  })

  it('模型鉴权失败时提示检查 API Key', async () => {
    const model = bridge()
    model.generate.mockRejectedValueOnce(new Error('LLM HTTP 401: invalid api key'))
    const service = ai.createWechatImageAiService({
      createLlm: () => model,
    })
    await expect(service.recognize(dataUrl())).rejects.toMatchObject({
      code: 'IMAGE_AI_AUTH_FAILED',
    })
  })

  it('非法图片来源不会调用模型', async () => {
    const model = bridge()
    const service = ai.createWechatImageAiService({
      createLlm: () => model,
    })
    await expect(service.recognize('https://example.test/a.jpg')).rejects.toThrow(/图片地址无效/)
    expect(model.generate).not.toHaveBeenCalled()
  })
})
