/**
 * 模型名解析（#20 第二个协作者）：三个角色在某一次调用里**到底该用哪个模型名**。
 *
 * 为什么从 `GatewayCore` 里搬出来：这套优先级原先散在类方法里，测一次就要起一个真网关；
 * 而它守着的是一条出过实错的红线（§7 F1）——「记账用的名字」与「发请求用的名字」必须是
 * **同一个解析**，两处各算一次就会漂移：向量库里记着 `'default'`、实际发的是 `llm.json` 的值，
 * 于是"换没换嵌入模型"的判定永远不触发重建，旧向量被当成新模型的用。
 * 搬成以桥为参数的纯函数之后，这条红线可以用假桥逐格钉住（不需要 electron、不需要宿主配置）。
 *
 * `GatewayCore` 仍保留同样签名的 `protected` 包装，子类与 remotes 一行都不用改。
 */
import { readKbModelSettings, resolveModelRef } from './query/kb/model-config.ts'
import type { KbModelRole, ResolvedModel } from './query/kb/model-config.ts'
import { loadRetrievalConfig } from './query/retrieval/config.ts'

/** 解析一处模型名所需要的三个来源：LLM 桥、宿主上下文、已解密数据根。 */
export interface ModelSource {
  /** `ctx.llm`：唯一知道「实际会发出去什么」的地方。 */
  bridge: unknown
  /** `ctx`：默认模型选择器（`agentDefaultModel`）挂在它上面。 */
  host: unknown
  /** 已解密数据根（检索配置与库级覆盖都读这里）。 */
  decryptedDir: string
}

type LlmBridge = {
  embeddingModelName?: (override?: string) => string
  rerankModelName?: () => string
  config?: { model?: string; rerankModel?: string }
}

type HostCtx = { agentDefaultModel?: { currentSelection?: () => { provider?: string; model?: string } } }

/**
 * 「这次 embedding 实际用的模型名」—— 由 LLM 桥回答，与它自己发请求时用的是**同一个解析**。
 *
 * 为什么不在网关这边再拼一遍优先级：那等于第二次实现宿主侧的
 * `override || embeddingModel || model` 规则，两处一旦漂移，向量库里记的模型名
 * 就成了一个没人用得上的字符串（§7 F1 就是这么来的）。所以记账名**必须**由发送方给出。
 * @param bridge - `ctx.llm`。
 * @param override - 显式指定的模型名（可空）。
 * @returns 生效模型名；未配置时为空串。桥未提供该方法时（测试桩）退回 override 本身。
 */
export function embedModelNameOf(bridge: unknown, override = ''): string {
  const llm = bridge as LlmBridge
  if (typeof llm?.embeddingModelName !== 'function') return override
  return String(llm.embeddingModelName(override) ?? '')
}

/**
 * 某个角色的**全局**生效模型名（还没叠库级覆盖）。
 *
 * 三个角色都从宿主桥取值：桥是唯一知道「实际会发出去什么」的地方，
 * 网关自己再拼一遍优先级就会重新制造 §7 F1 那种两条链各算一次的局面。
 * @param source - 桥 / 宿主 / 数据根。
 * @param role - 语言 / 嵌入 / 重排序。
 * @returns 模型名；空串 = 这个角色没配。
 */
export function globalModelNameOf(source: ModelSource, role: KbModelRole): string {
  const llm = source.bridge as LlmBridge
  const host = source.host as HostCtx
  if (role === 'embed') return embedModelNameOf(llm, loadRetrievalConfig(source.decryptedDir).embedding.model)
  if (role === 'rerank') {
    if (typeof llm?.rerankModelName === 'function') return String(llm.rerankModelName() ?? '')
    return String(llm?.config?.rerankModel ?? '')
  }
  const sel = host?.agentDefaultModel?.currentSelection?.()
  return String(sel?.model ?? llm?.config?.model ?? '')
}

/**
 * 某个库、某个角色**实际该用的**模型名（库级覆盖叠在全局之上）。
 *
 * 每次调用都重读设置：`llm.json` 那条链就是「改完下一次生效、不必重启」的语义，
 * 这里缓存住就会让库级覆盖比全局配置更难改。一次 SQLite 主键查是微秒级，不心疼。
 * @param source - 桥 / 宿主 / 数据根。
 * @param kbId - 知识库 id（非法时等价于「没有库级覆盖」）。
 * @param role - 哪个角色。
 * @returns 解析结果（含来源，界面与审计都要用它说话）。
 */
export function kbModelOf(source: ModelSource, kbId: number, role: KbModelRole): ResolvedModel {
  const s = readKbModelSettings(source.decryptedDir, kbId)
  const ref = role === 'chat' ? s.chatRef : role === 'embed' ? s.embedRef : s.rerankRef
  return resolveModelRef(ref, globalModelNameOf(source, role))
}
