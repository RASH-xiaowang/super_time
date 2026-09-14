/**
 * 朋友圈（SNS）CDN 媒体密钥流：微信自研的 `WxIsaac64`。
 *
 * ## 为什么用 vendored 的 WASM 而不是自己实现
 *
 * 微信 CDN 上的朋友圈视频/封面是**客户端加密**的（下载回来头不是 `ftyp`），解密方式为
 * 「前 `min(131072, size)` 字节与 WxIsaac64 密钥流做 XOR」，种子是朋友圈 XML 里的
 * `<enc key="NNNN">` 十进制数（实测：用它对 3 条本机已有明文的视频解密，整文件 md5
 * 与 XML 里的 md5 完全一致）。
 *
 * 名字虽叫 Isaac64，但它**不是** Jenkins 的 ISAAC-64：
 *  · 用真实数据对照过「标准 ISAAC-64 核心 × 6 种播种 × 2 种输出顺序 × 4 种字节序」，
 *    与 WASM 输出**零字节重合**（连 64 位字的多重集都不相交）；
 *  · WASM 二进制里也搜不到 Jenkins 的 golden 常量 `0x9E3779B97F4A7C15`（两种字节序都没有）。
 * 它是一套自研 PRNG，只能以权威实现为准 —— 这里 vendored 微信 weflow 的密钥流 WASM
 * （来源与许可见同目录 PROVENANCE.md），验收标准是「解出的明文 md5 == XML 的 md5」。
 *
 * ## 调用方式
 *
 * Emscripten 产物需要类浏览器全局环境：按参考实现的做法用 `node:vm` 造 mock global 跑
 * 胶水 JS，再从 `Module.WxIsaac64` 生成密钥流（结果经 `wasm_isaac_generate` 回填 HEAP，
 * 整段倒序后截断）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/** 头这一段是加密的（字节数）。 */
export const SNS_HEAD_ENCRYPTED_BYTES = 131072

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 定位资产目录。
 *
 * `import.meta.url` 在**构建产物**里指向 `src/backend/wechat-data/lib/index.js`（源码布局是
 * `src/query/`），两者上溯的级数不同 —— 所以按候选逐个探测，而不是写死一个相对路径。
 */
/**
 * `process.resourcesPath` 只有 Electron 主进程有（@types/node 里没有这个字段）。
 * 后端 bundle 也会在纯 Node 下被跑（测试/冒烟），所以取不到时返回空串。
 */
function processResourcesPath(): string {
  const p = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return typeof p === 'string' ? p : ''
}

function resolveAssetDir(): string {
  const candidates = [
    join(HERE, '..', 'native', 'weflow-isaac64'), // 构建产物：lib/ → wechat-data/native
    join(HERE, '..', '..', 'native', 'weflow-isaac64'), // 源码布局：src/query/ → wechat-data/native
    join(processResourcesPath(), 'app.asar.unpacked', 'src', 'backend', 'wechat-data', 'native', 'weflow-isaac64'),
  ]
  for (const c of candidates) {
    try {
      if (readFileSync(join(c, 'wasm_video_decode.wasm')).length > 0) return c
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 WxIsaac64 WASM 资产（native/weflow-isaac64）')
}

interface IsaacInstance {
  generate(n: number): void
  delete?: () => void
}
interface WasmModule {
  HEAPU8: Uint8Array
  WxIsaac64?: new (seed: string) => IsaacInstance
  asm?: { WxIsaac64?: new (seed: string) => IsaacInstance }
}
interface Runtime {
  module: WasmModule
  /** 最近一次生成的密钥流（由胶水回调写入）。 */
  readCaptured: () => Uint8Array | null
}

let runtimePromise: Promise<Runtime> | null = null

/** 初始化 WASM 运行时（只做一次）。 */
function loadRuntime(): Promise<Runtime> {
  if (runtimePromise) return runtimePromise
  runtimePromise = (async () => {
    const assetDir = resolveAssetDir()
    const wasmBinary = readFileSync(join(assetDir, 'wasm_video_decode.wasm'))
    const glueJs = readFileSync(join(assetDir, 'wasm_video_decode.js'), 'utf8')
    let captured: Uint8Array | null = null
    let resolveInit: () => void = () => {}
    let rejectInit: (e: unknown) => void = () => {}
    const initPromise = new Promise<void>((res, rej) => { resolveInit = res; rejectInit = rej })

    const globals: Record<string, unknown> = {
      console: { log: () => {}, error: () => {} },
      Buffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
      Float32Array, Float64Array, BigInt64Array, BigUint64Array,
      Array, Object, Function, String, Number, Boolean, Error, Promise, Date, Math, JSON,
      require, process, setTimeout, clearTimeout, setInterval, clearInterval,
    }
    const Module: Record<string, unknown> = {
      onRuntimeInitialized: () => resolveInit(),
      wasmBinary,
      print: () => {},
      printErr: () => {},
    }
    globals.Module = Module
    globals.self = globals
    globals.Window = function () {}
    globals.WorkerGlobalScope = function () {}
    globals.importScripts = () => {}
    globals.location = { href: join(assetDir, 'wasm_video_decode.js') }
    globals.VTS_WASM_URL = `file://${join(assetDir, 'wasm_video_decode.wasm')}`
    // 胶水通过这个全局回调把生成的密钥流交出来
    globals.wasm_isaac_generate = (ptr: number, n: number) => {
      captured = new Uint8Array((Module.HEAPU8 as Uint8Array).buffer, ptr, n)
    }
    try {
      const context = vm.createContext(globals)
      new vm.Script(glueJs, { filename: 'wasm_video_decode.js' }).runInContext(context)
    } catch (e) {
      rejectInit(e)
    }
    await initPromise
    const mod = Module as unknown as WasmModule
    if (!mod.WxIsaac64 && mod.asm?.WxIsaac64) mod.WxIsaac64 = mod.asm.WxIsaac64
    if (!mod.WxIsaac64) throw new Error('WxIsaac64 未在 WASM 模块中找到')
    return { module: mod, readCaptured: () => captured }
  })()
  return runtimePromise
}

const keystreamCache = new Map<string, Buffer>()

/**
 * 生成 WxIsaac64 密钥流。
 * @param seed - 朋友圈 XML 里 `<enc key="NNNN">` 的十进制字符串。
 * @param size - 需要的字节数。
 * @returns 密钥流（长度 = size）。
 */
export async function wxIsaac64Keystream(seed: string, size: number): Promise<Buffer> {
  const key = String(seed ?? '').trim()
  if (!key) throw new Error('缺少密钥流种子（XML 未给出 <enc key>）')
  const n = Math.max(0, Math.floor(size))
  if (n === 0) return Buffer.alloc(0)
  const cacheKey = `${key}:${n}`
  const hit = keystreamCache.get(cacheKey)
  if (hit) return hit

  const rt = await loadRuntime()
  const isaac = new rt.module.WxIsaac64!(key)
  isaac.generate(Math.ceil(n / 8) * 8)
  if (isaac.delete) isaac.delete()
  const raw = rt.readCaptured()
  if (!raw) throw new Error('未能取到密钥流输出')
  // 参考实现：整段倒序后再截断（WASM 写回的顺序与使用顺序相反）
  const bytes = Buffer.from(raw).reverse().subarray(0, n)
  if (keystreamCache.size > 64) keystreamCache.clear()
  keystreamCache.set(cacheKey, bytes)
  return bytes
}

/**
 * 解密 SNS 媒体的加密头（返回新 Buffer，不改入参）。
 * @param buf - CDN 取回的原始字节。
 * @param seed - `<enc key>` 十进制字符串。
 * @returns 解密后的字节与实际解密的长度。
 */
export async function decryptSnsHead(buf: Buffer, seed: string): Promise<{ bytes: Buffer; decrypted: number }> {
  const key = String(seed ?? '').trim()
  if (!key || buf.length === 0) return { bytes: buf, decrypted: 0 }
  const size = Math.min(SNS_HEAD_ENCRYPTED_BYTES, buf.length)
  const ks = await wxIsaac64Keystream(key, size)
  const out = Buffer.from(buf)
  for (let i = 0; i < size && i < ks.length; i += 1) out[i] = (out[i] ?? 0) ^ (ks[i] ?? 0)
  return { bytes: out, decrypted: size }
}
