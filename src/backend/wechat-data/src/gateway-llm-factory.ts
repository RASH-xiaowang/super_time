/**
 * LLM 工厂（#20 第三个协作者）：造「已过隐私闸」的三种出站函数。
 *
 * 为什么排在隐私闸与模型解析之后：这三件东西**同时**要用那两个协作者 ——
 * `makeEmbedFn` 要过闸、`makeChatAsker` 要过闸 + 取库级模型名 + 收流、`makeRerankFn`
 * 要过闸 + 取 rerank 模型名。留在 `GatewayCore` 里时它们靠 `this` 拿依赖，
 * 于是"起半个网关才能测一条出站纪律"；抽成显式依赖之后，纪律本身可以用假桥逐条钉。
 *
 * 三条纪律（少一条都是实质性的漏洞，注释里那三条来自第 59 轮）：
 *   ① 出站前**必须先过隐私闸**（2026-09-30 起闸门只做脱敏与审计，不再有拦截分支）；
 *   ② 一次要发一批的（rerank）必须**整批过闸** —— 只 gate 查询词等于把 N 条正文
 *      裸发出去，而审计表还会记成「已脱敏」；
 *   ③ 失败一律抛出而不是吞掉 —— 由调用方决定降级成什么，并在界面上说清为什么。
 */
import type { PrivacyGateFn } from './gateway-privacy.ts'
import { embedCacheKey, lookupEmbedCache, storeEmbedCache } from './query/embed-cache.ts'
import type { KbModelRole, ResolvedModel } from './query/kb/model-config.ts'
import type { EmbedFn } from './query/retrieval/embedding.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 工厂要的依赖：桥、宿主上下文，以及前两个协作者的入口。 */
export interface LlmFactoryDeps {
  /** `ctx.llm`：实际发请求的那座桥。 */
  llm: unknown
  /** `ctx`：默认模型选择器（`agentDefaultModel`）挂在它上面。 */
  host: unknown
  kbModel: (kbId: number, role: KbModelRole) => ResolvedModel
  privacyGate: PrivacyGateFn
  /** 解密数据根（embedding 缓存落盘位置）。每次现取：换数据根时缓存要跟着改道。 */
  decryptedDir: () => string
  /**
   * 当前是否开启敏感字段脱敏。
   *
   * 为什么要有它：embedding 缓存的键必须把脱敏口径算进去（见 `query/embed-cache.ts` 文件头），
   * 而口径只有闸门内部知道。它读的是**同一个** `readPrivacySettings`；
   * 工厂读它与闸门读它之间没有 `await`（全同步），所以两边不可能读到不一致的值。
   */
  redactMode: () => boolean
}

/** 审计里能分得开的三种 embedding 功能名（数据范围完全不同，不许写死成一个）。 */
export type EmbedFeature = 'ask_embed' | 'kb_embed' | 'kb_link_suggest'

/** 一次性抽取任务的 system 提示：只准出行格式，不解释不寒暄不补全。 */
export const EXTRACT_SYSTEM = '你是一名严格的信息抽取器。只输出要求的行格式，不解释、不寒暄、不补全文档里没有的名字。'

/**
 * 结构化抽取的单次输出预算。
 *
 * 不能再按普通聊天的小上限发：真机复现（2026-10-20，`deepseek-flash`）中，
 * 500 token 被 500 个 reasoning token 全部吃光，`content` 为空；提高到 4096 后
 * 同一份文件用 1544 个 reasoning token 后正常输出 11 条实体。
 *
 * 2026-10-20 再次实测：同一份文件（21.6k 字）换一次请求，4021 个输出 token 中
 * 3980 个仍是 reasoning，正文只剩 41 个 token；4096 恰好会在这种请求上再次耗尽。
 * `deepseek-flash` 支持更大的输出预算，所以这里留到 8192。它只是安全上限，
 * 模型提前结束不会按未用额度计费。
 */
export const EXTRACT_MAX_TOKENS = 8192

type EmbedBridge = { embed?: (texts: string[], opts?: { model?: string }) => Promise<number[][]> }
/**
 * `stream` 的返回元素类型直接从 `BlockAssembler.push` 的参数推 —— 不在这里重declare 一份
 * 收流块的形状：改前那句走的是真桥的类型，自己再造一份口径立刻对不上（TS2345）。
 */
type StreamFn = (o: GenerateOptions) => AsyncIterable<Parameters<BlockAssembler['push']>[0]>
type StreamBridge = { stream?: StreamFn }
type RerankBridge = { rerank?: (q: string, docs: string[], o?: { model?: string }) => Promise<number[]> }
type HostCtx = { agentDefaultModel?: { currentSelection?: () => { provider?: string; model?: string } } }

/**
 * 构造「过隐私闸门」的 embedding 函数。
 *
 * 所有 embedding 调用都必须先过与 chat 出站同一道闸门：开启「敏感字段脱敏」时发送脱敏后的
 * 文本，并写审计。
 * @param deps - 桥 + 前两个协作者的入口。
 * @param model - 向量模型名（空则不带 `model` 选项，由桥按默认发）。
 * @param feature - 审计里的功能名（消息片段 / 知识库文件正文 / 笔记正文与候选标题）。
 * @returns embedding 函数；桥未提供 embed 时 undefined。
 */
export function makeEmbedFnOf(deps: LlmFactoryDeps, model: string, feature: EmbedFeature = 'ask_embed'): EmbedFn | undefined {
  const bridge = deps.llm as EmbedBridge
  if (typeof bridge?.embed !== 'function') return undefined
  const opt = model ? { model } : undefined
  return async (texts: string[]): Promise<number[][]> => {
    const dir = deps.decryptedDir()
    // W3-6.2：键里的命名空间就是脱敏口径 —— `r` 与 `p` 的条目物理上不互通，
    // 所以「关脱敏时算的向量」永远不可能在「开脱敏」时被取出来用。
    const ns = deps.redactMode() ? 'r' : 'p'
    const keys = texts.map((t) => embedCacheKey(ns, model, t))
    const hit = lookupEmbedCache(dir, keys)
    // 命中 ⇒ 这一批没有任何字节离开本机 ⇒ 不过闸、不写审计（写了就是把没发生过的事记成发生过）。
    if (hit) return hit
    const gated = deps.privacyGate(feature, { sessions: 0, messages: texts.length }, texts)
    const vecs = await bridge.embed!(gated, opt)
    // 键与查找时是**同一个**（按原文算），值却是脱敏后的向量。下一次同原文 + 同口径会
    // 重新得到同一份 `gated`，向量自然相等；而口径一变命名空间就变，绝不会跨口径取用。
    storeEmbedCache(dir, keys, vecs)
    return vecs
  }
}

/**
 * 造一个「提示词 → 模型文本」的一次性调用（实体抽取、链接建议这类结构化小任务用）。
 *
 * 与 `summarizeKbFile` 同一套纪律：过闸 + 收流 + 失败抛出。为什么不复用摘要那条路径：
 * 那些地方各自要拼自己的 prompt 与 system，抽出来只共享「过闸 → 发 → 收文本」这三步，
 * 比造一个带一堆选项的大泛型函数诚实。
 * @param deps - 桥 + 前两个协作者的入口。
 * @param kbId - 当前库（取语言模型的库级覆盖）。
 * @param feature - 审计里登记的功能名。
 * @returns 调用函数；桥不支持流式时 undefined（调用方据此报「模型通道不可用」）。
 */
export function makeChatAskerOf(deps: LlmFactoryDeps, kbId: number, feature: string): ((prompt: string) => Promise<string>) | undefined {
  const bridge = deps.llm as StreamBridge
  const stream = bridge?.stream
  if (typeof stream !== 'function') return undefined
  const model = deps.kbModel(kbId, 'chat').model
  const host = deps.host as HostCtx
  const sel = host?.agentDefaultModel?.currentSelection?.()
  const provider = String(sel?.provider ?? '')
  return async (prompt: string): Promise<string> => {
    const [gated] = deps.privacyGate(feature, { sessions: 0, messages: 0 }, [prompt])
    const assembler = new BlockAssembler()
    const opts: GenerateOptions = {
      provider,
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: gated ?? prompt }],
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })],
      system: EXTRACT_SYSTEM,
      maxTokens: EXTRACT_MAX_TOKENS,
    }
    for await (const c of stream(opts)) assembler.push(c)
    return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
  }
}

/**
 * 构造「过隐私闸门」的模型精排函数（问答检索的候选重排）。
 *
 * 见文件头那三条纪律；这里特别钉 ②：rerank 的入参天然是一批文档，
 * **必须一次过 `[query, ...documents]`**。功能名叫 `ask_rerank` 而不是 `kb_rerank`：
 * 这一阶段跑在整个问答检索管道上，候选既可能来自聊天记录也可能来自知识库文件 ——
 * 按知识库命名会让审计里那一列看起来只与文件有关，而它实际覆盖的是全部候选。
 * @param deps - 桥 + 前两个协作者的入口。
 * @param kbId - 当前库（用于取库级覆盖；0 = 没有库上下文）。
 * @returns 精排函数；没配模型或桥不支持时 undefined（管道据此跳过这一段）。
 */
export function makeRerankFnOf(deps: LlmFactoryDeps, kbId: number): ((query: string, documents: string[]) => Promise<number[]>) | undefined {
  const bridge = deps.llm as RerankBridge
  if (typeof bridge?.rerank !== 'function') return undefined
  const model = deps.kbModel(kbId, 'rerank').model
  if (model === '') return undefined
  return async (query: string, documents: string[]): Promise<number[]> => {
    const gated = deps.privacyGate('ask_rerank', { sessions: 0, messages: documents.length }, [query, ...documents])
    const [q, ...rest] = gated
    return bridge.rerank!(q ?? query, rest, { model })
  }
}
