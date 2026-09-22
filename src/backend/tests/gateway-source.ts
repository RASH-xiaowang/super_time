/**
 * 「同一个类、两个文件」的联合读法（M21 结构刀）。
 *
 * `WechatDataGateway` 原先是 `gateway.ts` 里的一整个类；现在拆成继承链：
 * 方法面（161 个 `@Remote` 壳）留在 `gateway.ts`，状态 / 构造 / 共享私有辅助 /
 * 各域处理器的 ctx 装配在 `gateway-core.ts` 的 `GatewayCore` 里。
 *
 * 于是**按路径读源码的守卫**只读 `gateway.ts` 就会看不到接线（构造器里的实时同步、
 * `privacyGate`、`cdnSwitches`、`saveAskHistory`…都在核里），把「搬家」误报成「回归」。
 * 本模块给出两种口径，由调用方按**意图**选：
 * - `gatewayClassSource()` —— 只看这个类自己（两个文件），用于「接线必须在网关里、
 *   不许散进实现模块」这类判据；
 * - `gatewaySource()` —— 类 + `remotes/**` 域处理器，用于「实现体搬到哪儿都算」的判据。
 * 两者都**不去注释**（各 spec 原本各自的 strip 口径不同，保持原样才谈得上「断言一条没改」）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `src/backend/wechat-data/src` */
export const GW_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-data', 'src')

/** 组成 `WechatDataGateway` 这个类的文件（按声明顺序：核在前、方法面在后）。 */
export const GATEWAY_CLASS_FILES = ['gateway-core.ts', 'gateway.ts']

export function gatewayClassSource(): string {
  return GATEWAY_CLASS_FILES.map((f) => readFileSync(join(GW_DIR, f), 'utf8')).join('\n')
}

export function gatewaySource(): string {
  const remotes = readdirSync(join(GW_DIR, 'remotes'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(GW_DIR, 'remotes', f))
  return [gatewayClassSource(), ...remotes.map((f) => readFileSync(f, 'utf8'))].join('\n')
}
