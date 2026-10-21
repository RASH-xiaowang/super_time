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
import { createBoundedCache } from './cache-budget.ts'

/**
 * **视频**只有头这一段是加密的（字节数）。
 *
 * ⚠️ 别把它当成 SNS 媒体的通用上限：**图片是整文件加密**（2026-10-08 真机实测 9/9 张，
 * 见 `tests/sns-image-tail-probe.manual.spec.ts`），所以图片走 `decryptSnsAll`。
 * 这个常量只服务于 `decryptSnsHead`（视频链路）。
 */
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
    // 打包态主路径：native/** 已在 asarUnpack 里，资源落在 app.asar.unpacked 下。
    // 排在第一位是**有意的** —— 从 asar 里读要经 Electron 的 fs 补丁、每次冷启动都
    // 解压 3.8MB；unpacked 目录是真实文件，读起来才是设计意图。
    join(processResourcesPath(), 'app.asar.unpacked', 'src', 'backend', 'wechat-data', 'native', 'weflow-isaac64'),
    join(HERE, '..', 'native', 'weflow-isaac64'), // 构建产物：lib/ → wechat-data/native
    join(HERE, '..', '..', 'native', 'weflow-isaac64'), // 源码布局：src/query/ → wechat-data/native
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

const KEYSTREAM_CACHE_MAX_ENTRIES = 64
const KEYSTREAM_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024
const KEYSTREAM_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024
const keystreamCache = createBoundedCache<string, Buffer>({
  label: 'sns-keystream',
  maxEntries: KEYSTREAM_CACHE_MAX_ENTRIES,
  maxTotal: KEYSTREAM_CACHE_MAX_TOTAL_BYTES,
  maxEntry: KEYSTREAM_CACHE_MAX_ENTRY_BYTES,
  sizeOf: (bytes) => bytes.length,
})

/** 密钥流缓存的单测把手；不暴露内部 Map。 */
export function keystreamCacheHandles(): {
  stats: () => { count: number; total: number }
  clear: () => void
  putForTest: (key: string, bytes: Buffer) => void
} {
  return {
    stats: () => ({ count: keystreamCache.size(), total: keystreamCache.total() }),
    clear: () => keystreamCache.clear(),
    putForTest: (key, bytes) => keystreamCache.set(key, bytes),
  }
}

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
  if (hit !== undefined) return hit

  const rt = await loadRuntime()
  const isaac = new rt.module.WxIsaac64!(key)
  // 分块生成。每块生成后**各自倒序再截断**，与参考实现的「整段倒序再截断」逐字节等价 ——
  // 2026-10-08 实测过 131072 / 262144 / 400000 三档，分块与一次性生成结果完全相同
  // （同一个实例连续 `generate` 会推进密钥流状态）。
  //
  // ⚠️ 这里原先注释写「不分块时图片尾部保持密文 ⇒ WASM 一次只填一块」，据此把分块当成修复。
  // 那个归因**是错的**：尾部保持密文是因为当时调的是 `decryptSnsHead`（只解头），
  // 与生成分块无关。分块无害，但它不是修复 —— 别再拿它当证据。
  const parts: Buffer[] = []
  let left = n
  while (left > 0) {
    const chunk = Math.min(SNS_HEAD_ENCRYPTED_BYTES, left)
    isaac.generate(Math.ceil(chunk / 8) * 8)
    const rawChunk = rt.readCaptured()
    if (!rawChunk) throw new Error('未能取到密钥流输出')
    parts.push(Buffer.from(rawChunk).reverse().subarray(0, chunk))
    left -= chunk
  }
  if (isaac.delete) isaac.delete()
  const bytes = Buffer.concat(parts)
  // 长度必须**正好**是 n。少了这一道，密钥流一旦比缓冲短，`decryptSnsAll` 的循环会在
  // `i < ks.length` 处停下，尾部原封不动 —— 现象是「头是 JPEG、尾仍是密文」，
  // 而调用方只看到「解密成功」。宁可抛错，也不要静默交付半个文件。
  if (bytes.length !== n) {
    throw new Error('密钥流长度不符：需要 ' + String(n) + ' 字节，实得 ' + String(bytes.length) + ' 字节')
  }
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

/**
 * 解密 SNS 媒体的**整份**字节。
 *
 * 与 `decryptSnsHead` 的区别：**视频**只有前 128 KB 加密，而**图片是整文件加密**
 * （2026-10-08 真机实测 9/9 张：整份解密后都是合法 JPEG，头 `ff d8 ff e0`；
 * 只解头则 9/9 张都缺结束标记）。所以图片必须走这里。
 *
 * ⚠️ 曾经把「一屏 9 张全挂」归因于本函数缺失，那个归因**是错的**：
 * 真正的拦截点是 `sns-cdn-image.ts` 的结尾判据（微信 CDN 在 EOI 之后恒定挂 24 字节签名块，
 * 旧判据要求最后两字节必须是 `ff d9`）。本函数一直是对的。
 *
 * @param buf - CDN 取回的原始字节。
 * @param seed - `<enc key>` 十进制字符串（图片实际取 `<url key>` / `<thumb key>`）。
 * @returns 解密后的字节与实际解密的长度。
 */
export async function decryptSnsAll(buf: Buffer, seed: string): Promise<{ bytes: Buffer; decrypted: number }> {
  const key = String(seed ?? '').trim()
  if (!key || buf.length === 0) return { bytes: buf, decrypted: 0 }
  const ks = await wxIsaac64Keystream(key, buf.length)
  const out = Buffer.from(buf)
  for (let i = 0; i < out.length && i < ks.length; i += 1) out[i] = (out[i] ?? 0) ^ (ks[i] ?? 0)
  return { bytes: out, decrypted: out.length }
}
