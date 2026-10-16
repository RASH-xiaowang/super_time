/**
 * 「同一个类、多个文件」的联合读法（M21 结构刀）。
 *
 * `WechatDataGateway` 原先是 `gateway.ts` 里的一整个类；现在拆成继承链：
 * 状态 / 构造 / 共享私有辅助 / 各域处理器的 ctx 装配在 `gateway-core.ts` 的
 * `GatewayCore` 里，195 个 `@Remote` 方法面按域分布在继承链的各个方法面壳中。
 *
 * 于是**按路径读源码的守卫**只读 `gateway.ts` 就会看不到接线（构造器里的实时同步、
 * `privacyGate`、`saveAskHistory`…都在核里），把「搬家」误报成「回归」。
 * 本模块给出两种口径，由调用方按**意图**选：
 * - `gatewayClassSource()` —— 只看这个类自己（继承链文件），用于「接线必须在网关里、
 *   不许散进实现模块」这类判据；
 * - `gatewaySource()` —— 类 + `remotes/**` 域处理器，用于「实现体搬到哪儿都算」的判据。
 * 两者都**不去注释**（各 spec 原本各自的 strip 口径不同，保持原样才谈得上「断言一条没改」）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

/** `src/backend/wechat-data/src` */
export const GW_DIR = join(ROOT, 'src', 'backend', 'wechat-data', 'src')

/** `src/client/ui-wechat/src/client/pages/wechat-data` */
export const API_DIR = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')

/**
 * 前端镜像联合读法需要的文件。清单由 `scripts/sync-remote-files.mjs` 从
 * `api.ts` 的 `export * from './api-*.ts'` 推导后写入 manifest，不再在这里手抄。
 */
interface RemoteFilesManifest {
  gatewayClassFiles: string[]
  gatewayApiFiles: string[]
}

const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'remote-files.json'), 'utf8'),
) as RemoteFilesManifest

/** 组成 `WechatDataGateway` 这个类的文件（按继承顺序：核在前、各层方法面壳居中、叶子最后）。 */
export const GATEWAY_CLASS_FILES = MANIFEST.gatewayClassFiles

/** 前端 `WechatRemote` 镜像的转发桶与所有域模块。 */
export const API_FILES = MANIFEST.gatewayApiFiles

export function gatewayClassSource(): string {
  return GATEWAY_CLASS_FILES.map((f) => readFileSync(join(GW_DIR, f), 'utf8')).join('\n')
}

/**
 * 类 + `remotes/**` + **全部 `gateway-*` 协作者模块**（#20 拆出来的隐私闸 / 模型解析 / LLM 工厂）。
 *
 * 后缀清单用 readdir 而不是手写数组：搬出一族就少一个文件，手写清单必然漏 ——
 * 而漏掉的后果不是报错，是读这份联合的守卫**静默失去靶子**（本仓已经踩过一次：
 * `chats-source.ts` 只扫 `.tsx`，把逻辑搬进 `.ts` 之后一条"实时处理器不许刷列表"的判据
 * 差点变成恒真，那次靠「找不到 onUpdated」的哨兵才报出来）。
 * 因此联合的覆盖面由 `gateway-collaborators.spec.ts` 里的哨兵兜着：那几个模块名必须出现。
 */
export function gatewaySource(): string {
  const remotes = readdirSync(join(GW_DIR, 'remotes'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(GW_DIR, 'remotes', f))
  const collaborators = readdirSync(GW_DIR)
    .filter((f) => /^gateway-.+\.ts$/.test(f) && !GATEWAY_CLASS_FILES.includes(f))
    .sort()
    .map((f) => readFileSync(join(GW_DIR, f), 'utf8'))
  return [gatewayClassSource(), ...collaborators, ...remotes.map((f) => readFileSync(f, 'utf8'))].join('\n')
}
