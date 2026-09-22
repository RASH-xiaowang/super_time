/**
 * 「解图片用哪对密钥」只有一个判定处的守卫。
 *
 * 起因（2026-09-20）：`query/image-key.ts` 里那条 keys.json 回退**没有任何调用方** ——
 * 产物 `lib/index.js` 里搜不到 `resolveImageKeyPair`（被 esbuild 当死代码摇掉了），于是
 * `wechat-data/README.md` 朋友圈媒体一节承诺的「密钥优先 config.json，回退 keys.json」
 * 实际只剩前半句；同时 gateway 与 export 里各自复制了 7 份 `cfg['image_aes_key']` 取数，
 * xor 兜底还写成 `136` / `0` / `0xff` 三种（三者只在「配置里没有该字段」时才会分胜负，
 * 而 `defaultConfig()` 恒给 136，所以那两份不同的常数一直没人察觉）。
 *
 * 本用例钉两件事，方向相反：
 *   ① **解码入口**必须走 `resolveImageKeyPair`，不许再自己读 cfg（新增入口同理）；
 *   ② **上报「已保存的配置」**的几处必须继续只读 cfg —— 让数据配置面板或 `verifyImageKey`
 *      去读 keys.json，会把用户从未保存过的自动密钥显示成「已保存」，那是另一种骗人。
 * 只断言字符串锚点、先剥注释、锚点均为单行（不受行尾影响）。
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
/** M21：域方法体搬进 `remotes/*.ts`（网关只留签名 + 转发）⇒ 源码断言读联合。 */
function gatewayPlusRemotes(p: string): string {
  const dir = join(dirname(p), 'remotes')
  const extra = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => join(dir, f))
    : []
  return [p, ...extra].map((f) => readFileSync(f, 'utf8')).join('\n')
}


const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const gateway = strip(gatewayPlusRemotes(join(SRC, 'gateway.ts')))
// M21 把 query/export.ts 拆成 export-io/format/flows 三个模块；这里读**桶 + 拆出模块**的联合，
// 断言本身不变，类型/函数再搬家也不会误报。
const exportTs = strip(readdirSync(join(SRC, 'query'))
  .filter((f) => /^export(-[a-z]+)?\.ts$/.test(f))
  .sort()
  .map((f) => readFileSync(join(SRC, 'query', f), 'utf8'))
  .join('\n'))

/** 会拿图密钥去解本地 .dat 的 Remote 方法（第三栏/列表里的每一条图片都是它们在服务）。 */
const DECODE_METHODS = [
  'decryptAllImages',
  'getImageDataUrl',
  'getImageDataUrlsBatch',
  'getSnsImageDataUrl',
  'getFileImageDataUrl',
  'getEmoticonDataUrl',
] as const

/**
 * 取某个 `@Remote('name')` 方法的函数体（到下一个 `@Remote(` 之前；中间的 JSDoc 已被剥掉）。
 * @param code - 剥过注释的源码。
 * @param remoteName - 装饰器里的方法名。
 * @returns 方法体文本；找不到装饰器时返回 null。
 */
function methodBody(code: string, remoteName: string): string | null {
  // M21：方法体搬进 `remotes/*.ts`（`@Remote` 处只剩一行转发）⇒ 取**实现**那段
  const implAt = code.lastIndexOf(`${remoteName}(`)
  if (implAt >= 0 && code.slice(implAt).includes('rc.')) {
    const rest = code.slice(implAt)
    const end = rest.indexOf('\n    },')
    return end > 0 ? rest.slice(0, end) : rest
  }
  const at = code.indexOf(`@Remote('${remoteName}')`)
  if (at < 0) return null
  const next = code.indexOf("@Remote('", at + 1)
  return code.slice(at, next < 0 ? code.length : next)
}

describe('图片密钥的单一解析点', () => {
  it('每个解码入口都走 resolveImageKeyPair，且不再自己读 cfg', () => {
    for (const name of DECODE_METHODS) {
      const body = methodBody(gateway, name)
      expect(body, `找不到 @Remote('${name}') —— 改名或删除时请同步本用例`).not.toBeNull()
      expect(body!.includes('resolveImageKeyPair('), `${name} 必须通过 resolveImageKeyPair 取密钥`).toBe(true)
      expect(body!.includes('image_aes_key'), `${name} 不该再自己读 cfg['image_aes_key']（回退会丢）`).toBe(false)
      expect(body!.includes('image_xor_key'), `${name} 不该再自己读 cfg['image_xor_key']（兜底常数会各写一份）`).toBe(false)
    }
  })

  it('导出的媒体上下文同样走单一解析点', () => {
    const at = exportTs.indexOf('function exportMediaCtx')
    expect(at, '找不到 exportMediaCtx —— 改名后请同步本用例').toBeGreaterThan(-1)
    const body = exportTs.slice(at, exportTs.indexOf('\n}', at))
    expect(body.includes('resolveImageKeyPair('), '导出路径的图密钥也要走单一解析点').toBe(true)
    expect(body.includes('image_aes_key'), '导出路径不许自己读 cfg 里的密钥').toBe(false)
  })

  it('gateway 里剩下的 image_aes_key 读点只有「上报已保存配置」那三处', () => {
    // 白名单式计数：放宽它必须是有意识的决定。三处各自的正当理由 ——
    //   ① getWechatConfigFull：界面要显示**用户保存过什么**；
    //   ② autoGetImageKey 的「已保存且能验证就直接用」短路；
    //   ③ verifyImageKey：验证的是配置里那一版密钥。
    const readLines = gateway.split('\n').filter((line) => line.includes('image_aes_key')).length
    expect(readLines, `gateway 里读 image_aes_key 的地方变成 ${String(readLines)} 处了（解码入口必须走 resolveImageKeyPair）`).toBe(3)
  })

  it('单一解析点自己同时读 config 与 keys.json，且回退带归属校验', () => {
    const impl = strip(readFileSync(join(SRC, 'query', 'image-key.ts'), 'utf8'))
    expect(impl.includes("getAccountKeysFromStore("), 'keys.json 回退必须真的存在（这条链路的全部意义）').toBe(true)
    expect(impl.includes('resolveSelfUsername('), '回退必须校验密钥属于当前账号').toBe(true)
    // 反向守卫：取用库存密钥之前必须先过归属判定（放行只允许发生在「证据不足」那条分支上）
    expect(impl.includes('!storedKeyOwnedBySelf(stored, decrypted)'),
      '库存密钥必须在归属判定之后才被取用').toBe(true)
  })
})
