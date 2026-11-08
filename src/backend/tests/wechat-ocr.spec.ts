/**
 * 微信原生 OCR 服务层：路径发现、来源白名单、临时文件清理、结果归一化与
 * utilityProcess 生命周期。这里不调用真实微信，也不把 OCR 正文写进断言输出。
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

type OcrLine = {
  text: string
  left?: number
  top?: number
  right?: number
  bottom?: number
  rate?: number
}

type OcrResult = {
  engine: string
  text: string
  lines: OcrLine[]
  width: number
  height: number
  elapsedMs: number
}

type PreparedImage = {
  imagePath: string
  cleanup: () => void
}

type OcrService = {
  recognize: (source: unknown) => Promise<OcrResult>
  stats: () => { queued: number; maxQueue: number; timeoutMs: number }
}

type ServiceOptions = {
  utilityProcess?: { fork: (...args: unknown[]) => FakeChild }
  workerPath?: string
  wrapperDllPath?: string
  timeoutMs?: number
  maxQueue?: number
  getDecodedRoot?: () => string
  tempRoot?: string
  maxDataUrlLength?: number
  findWeChatOcrDll?: () => string | null
  findWechatInstallDir?: () => string
  appData?: string
  wechatDir?: string
  runWorker?: (payload: Record<string, string>) => Promise<string>
}

type OcrModule = {
  findWeChatOcrDll: (options?: { appData?: string }) => string | null
  findWechatInstallDir: (options?: { explicitDir?: string; registryPath?: string }) => string
  parseImageDataUrl: (source: string, maxLength?: number) => { bytes: Buffer; ext: string }
  materializeImageSource: (
    source: unknown,
    options?: { decodedRoot?: string; tempRoot?: string; maxDataUrlLength?: number },
  ) => PreparedImage
  normalizeOcrResult: (raw: string, elapsedMs?: number) => OcrResult
  createWechatOcrService: (options: ServiceOptions) => OcrService
}

const ocr = require('../wechat-ocr.js') as OcrModule

class FakeChild extends EventEmitter {
  stdout = { resume: vi.fn() }
  stderr = { resume: vi.fn() }
  posted: Array<{ type?: string; payload?: Record<string, string> }> = []
  killed = false

  postMessage(message: { type?: string; payload?: Record<string, string> }): void {
    this.posted.push(message)
  }

  kill(): void {
    this.killed = true
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'super-time-ocr-test-'))
  roots.push(dir)
  return dir
}

function writeFile(file: string, content = 'x'): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function makeFixture() {
  const root = tempRoot()
  const appData = join(root, 'AppData')
  const pluginRoot = join(appData, 'Tencent', 'xwechat', 'XPlugin', 'Plugins', 'WeChatOcr')
  const oldDll = join(pluginRoot, '8096', 'extracted', 'wxocr.dll')
  const latestDll = join(pluginRoot, '10000', 'extracted', 'wxocr.dll')
  writeFile(oldDll)
  writeFile(latestDll)

  const wechatRoot = join(root, 'Weixin')
  const wechatDir = join(wechatRoot, '4.1.15.13')
  writeFile(join(wechatDir, 'mmmojo_64.dll'))
  writeFile(join(wechatRoot, '3.9.0.0', 'mmmojo_64.dll'))

  const wrapperDll = join(root, 'wcocr.dll')
  writeFile(wrapperDll, 'fake-wrapper')
  const temp = join(root, 'temp')
  mkdirSync(temp, { recursive: true })
  const decodedRoot = join(root, 'decoded')
  const decodedImage = join(decodedRoot, 'wxid_a', 'photo.jpg')
  writeFile(decodedImage, 'fake-image')
  return { root, appData, latestDll, wechatRoot, wechatDir, wrapperDll, temp, decodedRoot, decodedImage }
}

function fakeUtility(onPost: (child: FakeChild) => void = () => {}): {
  utilityProcess: { fork: (...args: unknown[]) => FakeChild }
  child: FakeChild
} {
  const child = new FakeChild()
  const original = child.postMessage.bind(child)
  child.postMessage = (message) => {
    original(message)
    onPost(child)
  }
  return {
    child,
    utilityProcess: {
      fork: vi.fn(() => child),
    },
  }
}

describe('微信 OCR 组件发现', () => {
  it('大小写不敏感地找 WeChatOcr，并选择最新版本', () => {
    const f = makeFixture()
    expect(ocr.findWeChatOcrDll({ appData: f.appData })).toBe(f.latestDll)
  })

  it('注册表安装根会继续选择含 mmmojo_64.dll 的版本目录', () => {
    const f = makeFixture()
    expect(ocr.findWechatInstallDir({ registryPath: f.wechatRoot })).toBe(f.wechatDir)
    expect(ocr.findWechatInstallDir({ explicitDir: f.wechatDir })).toBe(f.wechatDir)
  })

  it('中文安装路径不会在版本目录解析时丢失', () => {
    const root = tempRoot()
    const wechatRoot = join(root, '微信安装目录')
    const wechatDir = join(wechatRoot, '4.1.15.13')
    writeFile(join(wechatDir, 'mmmojo_64.dll'))
    expect(ocr.findWechatInstallDir({ registryPath: wechatRoot })).toBe(wechatDir)
  })

  it('缺失组件时给出可操作的错误，而不是运行期空指针', () => {
    const f = makeFixture()
    expect(() => ocr.findWechatInstallDir({ registryPath: join(f.root, 'missing') }))
      .toThrow(/未找到微信运行目录.*mmmojo_64\.dll/)
  })
})

describe('来源校验与临时文件', () => {
  it('data URL 写进随机临时目录，cleanup 后目录不残留', () => {
    const f = makeFixture()
    const prepared = ocr.materializeImageSource(
      'data:image/png;base64,' + Buffer.from('fake-png').toString('base64'),
      { tempRoot: f.temp },
    )
    expect(existsSync(prepared.imagePath)).toBe(true)
    expect(dirname(prepared.imagePath).startsWith(f.temp)).toBe(true)
    prepared.cleanup()
    expect(readdirSync(f.temp)).toEqual([])
  })

  it('wechat-media:// 只从 decoded 根内解析，越界和非法协议直接拒绝', () => {
    const f = makeFixture()
    const prepared = ocr.materializeImageSource('wechat-media://decoded/wxid_a/photo.jpg?w=320', {
      decodedRoot: f.decodedRoot,
    })
    expect(prepared.imagePath).toBe(f.decodedImage)
    expect(() => ocr.materializeImageSource('wechat-media://decoded/../secret.jpg', {
      decodedRoot: f.decodedRoot,
    })).toThrow(/图片文件不存在|图片地址无效/)
    expect(() => ocr.materializeImageSource('https://example.com/a.jpg', {
      decodedRoot: f.decodedRoot,
    })).toThrow(/图片地址无效/)
  })
})

describe('OCR 结果归一化', () => {
  it('过滤空行、拼接正文并保留可用的坐标', () => {
    const result = ocr.normalizeOcrResult(JSON.stringify({
      errcode: 0,
      width: 1484,
      height: 1081,
      ocr_response: [
        { text: ' 第一行 ', left: 1, top: 2, right: 3, bottom: 4, rate: 0.9 },
        { text: '   ' },
        { text: '第二行', left: 'bad', top: 6 },
      ],
    }), 123)
    expect(result).toMatchObject({
      engine: 'wechat-native',
      text: '第一行\n第二行',
      width: 1484,
      height: 1081,
      elapsedMs: 123,
    })
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]).toMatchObject({ text: '第一行', left: 1, rate: 0.9 })
  })

  it('空文本是成功结果，不是异常', () => {
    const result = ocr.normalizeOcrResult('{"errcode":0,"width":10,"height":20,"ocr_response":[]}')
    expect(result.text).toBe('')
    expect(result.lines).toEqual([])
  })

  it('errcode 非零与坏 JSON 都给出中文错误', () => {
    expect(() => ocr.normalizeOcrResult('{"errcode":7}')).toThrow(/错误码 7/)
    expect(() => ocr.normalizeOcrResult('not-json')).toThrow(/无法解析/)
  })
})

describe('createWechatOcrService', () => {
  it('通过一次性 utilityProcess 返回归一化结果，成功与失败都 kill 进程', async () => {
    const f = makeFixture()
    const fake = fakeUtility((child) => {
      queueMicrotask(() => child.emit('message', {
        type: 'result',
        json: JSON.stringify({
          errcode: 0,
          width: 640,
          height: 480,
          ocr_response: [{ text: '识别结果', left: 1, top: 2 }],
        }),
      }))
    })
    const service = ocr.createWechatOcrService({
      utilityProcess: fake.utilityProcess,
      wrapperDllPath: f.wrapperDll,
      tempRoot: f.temp,
      findWeChatOcrDll: () => f.latestDll,
      findWechatInstallDir: () => f.wechatDir,
    })
    const result = await service.recognize(
      'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64'),
    )
    expect(result.text).toBe('识别结果')
    expect(fake.child.killed).toBe(true)
    expect(fake.child.posted[0]?.payload?.imagePath).toBeTruthy()
    expect(existsSync(String(fake.child.posted[0]?.payload?.imagePath))).toBe(false)
  })

  it('超时会杀 worker，并返回明确中文提示', async () => {
    const f = makeFixture()
    const fake = fakeUtility()
    const service = ocr.createWechatOcrService({
      utilityProcess: fake.utilityProcess,
      wrapperDllPath: f.wrapperDll,
      tempRoot: f.temp,
      timeoutMs: 10,
      findWeChatOcrDll: () => f.latestDll,
      findWechatInstallDir: () => f.wechatDir,
    })
    await expect(service.recognize(
      'data:image/png;base64,' + Buffer.from('fake').toString('base64'),
    )).rejects.toThrow(/超时/)
    expect(fake.child.killed).toBe(true)
    expect(readdirSync(f.temp), '超时也必须清理 data URL 临时目录').toEqual([])
  })

  it('worker 主动回报错误时立即收敛，不白等超时', async () => {
    const f = makeFixture()
    const fake = fakeUtility((child) => {
      queueMicrotask(() => child.emit('message', {
        type: 'error',
        message: '微信原生 OCR 启动失败，请确认微信已登录',
      }))
    })
    const service = ocr.createWechatOcrService({
      utilityProcess: fake.utilityProcess,
      wrapperDllPath: f.wrapperDll,
      timeoutMs: 5_000,
      findWeChatOcrDll: () => f.latestDll,
      findWechatInstallDir: () => f.wechatDir,
    })
    await expect(service.recognize('data:image/png;base64,eA=='))
      .rejects.toThrow(/微信已登录/)
    expect(fake.child.killed).toBe(true)
  })

  it('插件缺失时不启动子进程，并提示启动/登录微信', async () => {
    const f = makeFixture()
    const fake = fakeUtility()
    const service = ocr.createWechatOcrService({
      utilityProcess: fake.utilityProcess,
      wrapperDllPath: f.wrapperDll,
      findWeChatOcrDll: () => null,
      findWechatInstallDir: () => f.wechatDir,
    })
    await expect(service.recognize('data:image/png;base64,eA=='))
      .rejects.toThrow(/微信原生 OCR 组件.*微信/)
    expect(fake.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('非法 source 不启动子进程', async () => {
    const f = makeFixture()
    const fake = fakeUtility()
    const service = ocr.createWechatOcrService({
      utilityProcess: fake.utilityProcess,
      wrapperDllPath: f.wrapperDll,
      findWeChatOcrDll: () => f.latestDll,
      findWechatInstallDir: () => f.wechatDir,
    })
    await expect(service.recognize('file:///C:/secret.jpg')).rejects.toThrow(/图片地址无效/)
    expect(fake.utilityProcess.fork).not.toHaveBeenCalled()
  })
})
