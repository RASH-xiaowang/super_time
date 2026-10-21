/**
 * ClawBot 前端接线守卫：接口镜像 / 包装 / 事件转发 / 面板订阅，四处缺一即静默失效。
 *
 * 四个断点各自的症状（都真实发生过同族事故）：
 *   · `api-core.ts` 镜像缺成员 → typecheck 红（这条最幸运）；
 *   · `api-clawbot.ts` 包装没接上 → 面板 import 不到、编译期就红；
 *   · `ui-entry.tsx` 没转发事件 → 界面上「实时」永远不动，且**没有任何报错**；
 *   · 面板没订阅 → 同上，更难查（事件到了 DOM、没人听）。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoot, readStripped, readText, readUnion } from '../../../test-helpers/wiring-kit.ts'

const ROOT = findRoot(import.meta.dirname)
const read = (...p: string[]): string => readText(join(ROOT, ...p))

const CLAWBOT_REMOTES = [
  'getClawbotBinding',
  'createClawbotBindQr',
  'getClawbotBindState',
  'unbindClawbot',
  'listClawbotMessages',
  'checkClawbotEnv',
  'sendClawbotMessage',
  'getClawbotMedia',
  'listClawbotInstances',
  'createClawbotInstance',
  'deleteClawbotInstance',
  'setClawbotInstanceConfig',
  'renameClawbotInstance',
] as const

const PANELS = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels']
const DATA = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data']

describe('ClawBot 前端接线', () => {
  it('api-core.ts 的 WechatRemote 镜像含全部十三个成员（多实例后 +4，别名 +1）', () => {
    const core = read(...DATA, 'api-core.ts')
    for (const name of CLAWBOT_REMOTES) {
      expect(core, `WechatRemote 缺 ${name}（remote-contract.spec.ts 会红）`).toContain(`${name}(`)
    }
  })

  it('api-clawbot.ts 十三个包装各自 remote().方法名，且被 api.ts 转发', () => {
    const wrap = readStripped(join(ROOT, ...DATA, 'api-clawbot.ts'))
    for (const name of CLAWBOT_REMOTES) {
      expect(wrap, `api-clawbot.ts 里没有 remote().${name}(`).toContain(`remote().${name}(`)
    }
    const barrel = read(...DATA, 'api.ts')
    expect(barrel, 'api.ts 没有转发 api-clawbot.ts').toContain("export * from './api-clawbot.ts'")
  })

  it('两条 clawbot 事件被转发成 DOM 事件（名字与面板订阅逐字一致）', () => {
    // 2026-10-14：中继从 ui-entry 的内联 if-else 抽成了 `wechat-events.ts` 的一张映射表，
    // 因为手机浏览器那条路（SSE）也要用同一份 —— 两边各写一份必然漂，症状是
    // 「桌面端 ClawBot 有新消息会提示、手机端不会」，只在一端复现。
    // 所以这里查两处：表里有这两条，且 ui-entry 真的把表接到了 IPC 的 onEvent 上。
    const events = read('src', 'client', 'ui-app', 'wechat-events.ts')
    const entry = read('src', 'client', 'ui-app', 'ui-entry.tsx')
    expect(events, 'clawbot/message 要转发成 dsh-clawbot-message')
      .toMatch(/from:\s*'clawbot\/message',\s*to:\s*'dsh-clawbot-message'/)
    expect(events, 'clawbot/binding-changed 要转发成 dsh-clawbot-binding-changed')
      .toMatch(/from:\s*'clawbot\/binding-changed',\s*to:\s*'dsh-clawbot-binding-changed'/)
    // 两条都带 detail（面板要从 detail 里拿 lastId / 绑定状态），别在抽表时丢了
    expect(events, 'clawbot/message 的 detail 口径丢了').toMatch(/'clawbot\/message',\s*to:\s*'dsh-clawbot-message',\s*detail:\s*true/)
    expect(events, 'clawbot/binding-changed 的 detail 口径丢了')
      .toMatch(/'clawbot\/binding-changed',\s*to:\s*'dsh-clawbot-binding-changed',\s*detail:\s*true/)
    expect(entry, 'ui-entry 没有把共用的映射表接到 IPC 事件上（表就成了死数据）')
      .toContain('onEvent(dispatchWechatEvent)')
  })

  it('多实例：会话按 slot 分家、事件带 slot、面板可切实例（2026-10-13）', () => {
    const chat = read(...PANELS, 'clawbot-chat.tsx')
    const panel = read(...PANELS, 'ClawBotPanel.tsx')
    const instances = read(...PANELS, 'clawbot-instances.tsx')
    // C2（2026-10-13）：切号入口从指挥条 <select> 收进实例轨；断言跟着搬（union 纪律同上）。
    const rail = read(...PANELS, 'clawbot-rail.tsx')
    // 会话查询与发送都必须带**当前实例**：这一条守的是「多实例下最隐蔽的错位」——
    // 界面照样有内容、也照样能发，只是那些内容与消息属于**别的号**。
    expect(chat, '会话查询没带 slot ⇒ 会读到缺省实例的会话').toMatch(/if \(slot !== null\) q\.slot = slot/)
    expect(chat, '发送没带 slot ⇒ 消息会发到缺省那个号上').toMatch(/apiSendClawbotMessage\(slot === null \? \{ text \} : \{ text, slot \}\)/)
    // 实时事件带 slot ⇒ 只刷当前实例（别的号来消息不该搅动当前列表）。
    expect(chat, '会话视图没有按 slot 过滤实时事件').toMatch(/typeof d\.slot === 'number' && d\.slot !== slot/)
    // 面板：切换器 + 按 slot 取快照 + 缺省规则收敛成一个纯函数。
    expect(rail, '实例轨不是切号入口（多实例下只能看缺省那个）').toContain('onPick(it.slot)')
    expect(panel, '面板没把实例列表交给轨（轨会读不到实例）').toMatch(/<ClawbotRail[\s\S]{0,220}instances=\{instances\}/)
    expect(panel, '面板取绑定快照没带 slot').toMatch(/apiGetClawbotBinding\(\{ slot: resolved \}\)/)
    expect(panel, '缺省实例规则没有收敛成一个纯函数').toContain('pickDefaultSlot')
    expect(instances, '缺省实例规则的实现不见了（前后端会各写一套）').toContain('export function pickDefaultSlot')
  })

  it('面板侧：会话视图订阅实时事件、可发可收（发送入口走真实包装），且打码在展示层', () => {
    // C1（2026-10-13）：媒体呈现（取数 hook / MediaCell / 缩图占位）搬进了 clawbot-thread.tsx
    // （对话流是它的主消费者，明细表格复用）。断言改读 chat + thread 的 **union** ——
    // 组件搬家不该让守卫静默失效（CONTRIBUTING 四件套③的 union 纪律）。
    const chat = readUnion(join(ROOT, ...PANELS), /^clawbot-(?:chat|thread)\.tsx$/, ['clawbot-chat.tsx'])
    expect(chat, '会话视图没有订阅实时事件').toContain("addEventListener('dsh-clawbot-message'")
    expect(chat, '关键词必须在服务端过滤（q 进查询）').toMatch(/q\.q = kw/)
    expect(chat, '打码走 maskSensitiveText').toContain('maskSensitiveText')
    expect(chat, '「接入会话」要有发送入口（可发可收）').toContain('apiSendClawbotMessage')
    expect(chat, '发送入口要有输入框').toContain('composerInput')
    expect(chat, '输入法组字期间的回车不许误触发送').toContain('isComposing')
    expect(chat, '附件取数要走后端（后端自动取回；界面只读缓存/重试）').toContain('apiGetClawbotMedia')
    expect(chat, '非图片附件用系统应用打开').toContain('apiOpenPath')
    expect(chat, '图片小图要能放大看').toContain('mediaZoom')
    expect(chat, '图片应出现即自动取小图（不再要人点「加载」）').toContain('void media.load(row)')
    expect(chat, '图片以缩图直接呈现（不再显示「[图片]」占位文字）').toContain('thumbImg')
    expect(chat, '缩图的取回中/失败重试各有形态（同尺寸占位框，列表不跳高）').toContain('thumbBox')

    // 订阅（binding-changed）收在容器里：它刷新快照、再把新值作为 props 发给两个视图 ——
    // 视图自己不订阅（一处订阅、两处消费，事件才不会因某个视图忘了订阅而漏刷新）。
    const settings = read(...PANELS, 'clawbot-settings.tsx')
    expect(settings, '绑定按钮要走真实取码').toContain('apiCreateClawbotBindQr')
    expect(settings, '取码成功后要打开扫码弹窗').toContain('ClawbotBindModal')
    // 反向：通道已接入，「未接入」的旧态与旧字段都不许回来。
    expect(settings, '设置视图里又出现了「通道未接入」的过期文案').not.toContain('通道未接入')
    expect(settings, '绑定卡片又拿 channelReady 做判断（那个字段已经不存在）').not.toContain('channelReady')
    expect(settings, '绑定卡片要显示接收通道运行态').toContain('snapshot?.channel')

    // 弹窗：状态轮询（每次 = 后端中继一次上游长轮询）与自绘二维码，两件缺一即「扫了没反应」。
    const modal = read(...PANELS, 'clawbot-bind-modal.tsx')
    expect(modal, '弹窗没有轮询绑定状态').toContain('apiGetClawbotBindState')
    expect(modal, '二维码不是自绘的（renderer 不该引远程图片）').toMatch(/encodeQr\(|qrSvgPath\(/)

    const panel = read(...PANELS, 'ClawBotPanel.tsx')
    expect(panel, '容器要订阅绑定变化（切视图与卡片刷新都靠它）').toContain("addEventListener('dsh-clawbot-binding-changed'")
  })

  it('UI 文案不提前宣称结果：扫码/绑定成功类字样只许出现在真实发生之后', () => {
    const all = ['ClawBotPanel.tsx', 'clawbot-settings.tsx', 'clawbot-chat.tsx', 'clawbot-thread.tsx', 'clawbot-bind-modal.tsx']
      .map(f => read(...PANELS, f)).join('\n')
    expect(all).not.toMatch(/扫码绑定成功|已成功绑定/)
  })

  it('分类标签：ClawBot 审计在操作日志里可见（下拉选项由标签映射驱动）', () => {
    const oplog = read(...PANELS, 'OperationLogPanel.tsx')
    expect(oplog, 'OP_CATEGORY_LABEL 缺 clawbot ⇒ Record 类型会红、下拉也会缺项').toMatch(/clawbot:\s*'ClawBot'/)
    expect(oplog, '下拉用 Object.keys(OP_CATEGORY_LABEL) 驱动（改了映射就自动带上）').toContain('Object.keys(OP_CATEGORY_LABEL)')
  })

  it('自动回复的数据面限定为「知识库 + 上下文 + 模型」，不许检索本机微信数据（2026-10-17）', () => {
    /*
     * 为什么这条必须钉在**源码**上：`ask` 是注入的（测试里是假的），
     * 所以「自动回复到底查了什么」在单测里看不见 —— 只有源码断言能防它被改回去。
     *
     * 症状（改回去之后）：微信里随便一个人发一句话，就能让本机把**全部聊天记录**
     * 检索一遍并送去模型 —— 这是用户没有逐条同意过的出网。
     */
    const gw = read('src', 'backend', 'wechat-data', 'src', 'gateway-clawbot.ts')
    expect(gw, '自动回复的 askWechat 没传 dataScope: kb-only ⇒ 会全库检索本机微信数据')
      .toContain("dataScope: 'kb-only'")
    // 数据面开关必须真的落到检索通道上（只写在调用方 = 没生效）。
    const pipeline = read('src', 'backend', 'wechat-data', 'src', 'query', 'retrieval', 'pipeline.ts')
    expect(pipeline, 'pipeline 没有 wechatDataEnabled 开关 ⇒ 数据面限定形同虚设')
      .toContain('const wechatOk = input.wechatDataEnabled !== false')
    // 微信侧四通道都要真的被它管住（漏一个 = 那条通道照跑）。
    for (const ch of ['sparse', 'dense', 'structured', 'time']) {
      expect(pipeline, `微信侧通道 ${ch} 没被 wechatOk 管住 ⇒ 本机数据仍会被检索`)
        .toContain(`wechatOk &&`)
    }
    // 知识库通道**不许**被这个开关关掉（否则「只限知识库」退化成「什么都不查」）。
    const kbAt = pipeline.indexOf("policy.channels.includes('kb')")
    expect(kbAt, '找不到知识库通道的开关').toBeGreaterThan(-1)
    expect(pipeline.slice(kbAt - 120, kbAt), '知识库通道被 wechatOk 一起关掉了 ⇒ 自动回复永远答不出文件里的内容')
      .not.toContain('wechatOk')
  })

  it('自动回复的系统提示词链路完整（2026-10-17）：实例配置 → ask → 覆盖 system', () => {
    /*
     * 用户要求「为实例增加系统提示词的内容输入版块」+「写一套拟人化的默认提示词」。
     * 这条链路有四个断点，缺一即静默失效（用户改了提示词但回复没变）：
     *   ① 实例配置存了 `systemPrompt`；
     *   ② 自动回复把它传给 `ask`；
     *   ③ 装配层把空串换成内置默认值（**不是「没有提示词」**）；
     *   ④ `askWechat` 真的用它覆盖 system。
     */
    const gw = read('src', 'backend', 'wechat-data', 'src', 'gateway-clawbot.ts')
    expect(gw, '自动回复没把 systemPrompt 传给 ask ⇒ 用户改的提示词不生效')
      // 2026-10-18：第 5 参是上下文（最近对话 + 图片）；systemPrompt 仍是第 4 参。
      .toMatch(/ask:\s*async \(slot, text, kbId, systemPrompt(?:, context)?\)/)
    // ⚠️ 断言**完整表达式**而不是「字符串存在」：变异把回落逻辑删掉后常量名还在，咬不住。
    expect(gw, '空提示词没回落到内置默认值 ⇒ 模型会写成报告腔')
      .toContain("systemPromptOverride: systemPrompt.trim() !== '' ? systemPrompt : DEFAULT_CLAWBOT_SYSTEM_PROMPT,")
    const askdeep = read('src', 'backend', 'wechat-data', 'src', 'remotes', 'askdeep.ts')
    expect(askdeep, 'askWechat 没有 systemPromptOverride 参数 ⇒ 提示词传不进来')
      .toContain('systemPromptOverride')
    expect(askdeep, 'systemPromptOverride 没真的覆盖 system（只声明不用）')
      .toContain('resolveSystemPrompt(options.systemPromptOverride, options.dataScope)')
    // 默认提示词必须真的存在且是拟人化的（不是空串、不是报告腔）。
    const prompt = read('src', 'backend', 'wechat-data', 'src', 'query', 'clawbot', 'clawbot-prompt.ts')
    expect(prompt, '没有内置默认提示词常量').toContain('DEFAULT_CLAWBOT_SYSTEM_PROMPT')
    expect(prompt, '默认提示词没要求「像真人发微信那样」').toContain('像真人发微信那样')
    expect(prompt, '默认提示词没禁止报告腔').toContain('综上所述')
    expect(prompt, '默认提示词没禁止引用角标（微信里没有可点的角标）').toContain('[1]')
  })

  it('长回复分段发送（2026-10-17）：切段函数 + 配置开关 + 逐条发出', () => {
    const prompt = read('src', 'backend', 'wechat-data', 'src', 'query', 'clawbot', 'clawbot-prompt.ts')
    expect(prompt, '没有分段函数').toContain('export function splitReplyText')
    expect(prompt, '分段上限常量不见了').toContain('CLAWBOT_REPLY_CHUNK_CHARS')
    const reply = read('src', 'backend', 'wechat-data', 'src', 'query', 'clawbot', 'clawbot-auto-reply.ts')
    expect(reply, '自动回复没按配置决定是否分段').toContain('cfg.splitReply ? splitReplyText(text) : [text]')
    expect(reply, '分段后没逐条发送（只发了第一段）').toMatch(/for \(const part of parts\)/)
  })

  it('默认提示词在输入框中显示出来（2026-10-17）：暴露常量 + 预填 + 归一', () => {
    /*
     * 用户要求「将默认提示词请在输入框中显示出来」。
     * 此前输入框是空的（「留空 = 用默认值」），用户**看不到**默认值长什么样 ——
     * 想改也不知道从哪改起。这条链路有三个断点，缺一即静默退回空框：
     *   ① 后端把内置常量暴露成 `@Remote('getClawbotDefaultPrompt')`；
     *   ② 前端包装 `apiGetClawbotDefaultPrompt` 真的调它；
     *   ③ 设置视图在 `systemPrompt === ''` 时**预填**默认值（而不是空串）。
     */
    const gw = read('src', 'backend', 'wechat-data', 'src', 'gateway-clawbot.ts')
    expect(gw, '后端没暴露默认提示词 ⇒ 前端拿不到，输入框只能空着')
      .toContain("@Remote('getClawbotDefaultPrompt')")
    expect(gw, '暴露的方法没返回内置常量（返回了别的东西）')
      .toContain('return { prompt: DEFAULT_CLAWBOT_SYSTEM_PROMPT }')
    const api = read('src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'api-clawbot.ts')
    expect(api, '前端没有取默认提示词的包装').toContain('export async function apiGetClawbotDefaultPrompt')
    expect(api, '包装没真的调 remote 方法').toContain('unwrap(await remote().getClawbotDefaultPrompt()).prompt')
    const view = read('src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'clawbot-settings.tsx')
    // ⚠️ 断言**完整表达式**：变异把预填删掉后 `defaultPrompt` 这个名字还在，只查名字咬不住。
    expect(view, '输入框没预填默认提示词 ⇒ 用户又面对一个空框')
      .toContain("const [draft, setDraft] = useState(saved !== '' ? saved : defaultPrompt)")
    expect(view, '草稿没跟着默认值同步（切实例/取到默认值后不刷新）')
      .toContain('setDraft(saved !== \'\' ? saved : defaultPrompt)')
    // 归一：与默认值逐字相同时存空串，保持「用默认」语义（否则以后改默认值这个实例会停在旧的）。
    expect(view, '保存时没把「等于默认值」归一成空串 ⇒ 以后改默认值这个实例会停在旧的那份')
      .toContain('return draft.trim() === defaultPrompt.trim() ? \'\' : draft')
  })

  it('自动回复的回答规则按数据面分叉（2026-10-17 修「回复带 [n] 角标 + 不分段」）', () => {
    /*
     * 症状（真机实测）：自动回复的正文里带 `[1]` `[2]` `[4]` 角标，且 184 字一条发出。
     *
     * 根因：回答规则写在**用户消息**（`synthPrompt`）里，比 system 更「近」，模型优先遵守。
     * 此前只有一套规则，第 3 条硬性要求「每条事实后面标 [n]」—— 于是即使 system 换成了
     * 拟人化提示词，模型仍然标角标、并把话说长（为了「标全来源」）。
     *
     * 修复：抽 `buildSynthRules(dataScope, timeGuardRule)`，`kb-only`（自动回复）走**聊天版**
     * （不标角标 + 每条 ≤30 字 + 要求分段），缺省（手动问答）走**检索版**（保留角标）。
     */
    const askdeep = read('src', 'backend', 'wechat-data', 'src', 'remotes', 'askdeep.ts')
    expect(askdeep, '没有按数据面分叉的规则构造函数').toContain('function buildSynthRules(')
    expect(askdeep, '调用点没传 dataScope（分叉无从生效）')
      .toContain('${buildSynthRules(options.dataScope, timeGuardRule)}')
    // 聊天版必须**明确禁止**角标（只说「不要报告腔」不够 —— 旧版也说了，但被第 3 条压过）。
    expect(askdeep, '聊天版没禁止 [n] 角标 ⇒ 微信里会出现乱码角标')
      .toContain('**不要标 [n] 角标**')
    // 聊天版必须给出**字数硬要求**（只说「简短」模型会写 100+ 字）。
    expect(askdeep, '聊天版没给字数硬要求 ⇒ 模型会写长')
      .toContain('**每条不超过 30 字**')
    // 检索版必须**保留**角标要求（手动问答的界面要能点、能核对）。
    expect(askdeep, '检索版丢了 [n] 角标要求 ⇒ 手动问答的引用不可点')
      .toContain('**每条事实后面标 [n]**')
    // 自动回复的 maxTokens 要收紧（400），否则模型仍会写长。
    expect(askdeep, '自动回复没收紧 maxTokens ⇒ 模型仍会写长')
      .toContain("options.dataScope === 'kb-only' ? 400 : 1200")
    // 单条上限 30 字 + 总长上限 300 字（= 最多 10 条）。
    const prompt = read('src', 'backend', 'wechat-data', 'src', 'query', 'clawbot', 'clawbot-prompt.ts')
    // ⚠️ 用**正则带行尾**而不是 `toContain`：`'...= 30'` 是 `'...= 300'` 的前缀，
    // 只查子串时变异把 30 改成 300 仍然命中（本轮实测 M615 第一次没咬住）。
    expect(prompt, '单条上限不是 30 字（用户要求「每次回复不能超过 30 字」）')
      .toMatch(/export const CLAWBOT_REPLY_CHUNK_CHARS = 30\n/)
    expect(prompt, '默认提示词没写「每条不超过 30 字」（与切段上限脱节）')
      .toContain('**每条不超过 30 字**')
    const reply = read('src', 'backend', 'wechat-data', 'src', 'query', 'clawbot', 'clawbot-auto-reply.ts')
    expect(reply, '总长上限不是 300 字（30 字 × 10 条）')
      .toMatch(/export const MAX_REPLY_CHARS = 300\n/)
  })

  it('检索 0 命中时自动回复仍调模型（2026-10-17 真机实测：否则只会复读一句硬编码文案）', () => {
    /*
     * 真机实测：开了自动回复但没配知识库时，8 个场景（「你好」「在吗」「谢谢」…）
     * **全部**返回同一句「知识库里没有检索到与这个问题相关的原文…」——
     * 因为 `citations.length === 0` 时直接短路、**根本不调模型**。
     *
     * 那条短路对**手动问答**是对的（防止模型凭常识编造聊天记录），
     * 但对**自动回复**是灾难：微信里绝大多数消息是寒暄与闲聊，它们本来就不该命中知识库。
     *
     * 修复：抽模块级 `resolveEmptyAnswer`，`kb-only` 走「调模型 + 聊天版兜底提示词」，
     * `wechat` 保持短路。
     */
    const askdeep = read('src', 'backend', 'wechat-data', 'src', 'remotes', 'askdeep.ts')
    expect(askdeep, '没有 0 命中分支的处理函数').toContain('async function resolveEmptyAnswer(')
    // 自动回复分支必须**真的调模型**（不是返回硬编码文案）。
    expect(askdeep, '自动回复 0 命中时没调模型 ⇒ 只会复读一句硬编码文案')
      .toContain('chatAnswer = await deps.runChat(')
    // 兜底提示词必须**明说「没有材料」**并要求不编造。
    expect(askdeep, '没有兜底对话提示词').toContain('function buildEmptyChatPrompt(')
    expect(askdeep, '兜底提示词没明说「没有材料」').toContain('你**没有**任何可参考的材料')
    expect(askdeep, '兜底提示词没禁止编造').toContain('**绝对不要编造**具体事实')
    // 兜底提示词不许提「知识库 / 检索」这类词（对方不知道你在查什么）。
    expect(askdeep, '兜底提示词没禁止提「知识库」这类词')
      .toContain('不要提「知识库」「检索」「材料」这类词')
    // 兜底提示词不许解释自己（真机实测：模型写了「（注：实在没有可引用的记录，就不编号了）」）。
    expect(askdeep, '兜底提示词没禁止解释自己 ⇒ 模型会写「注：」「（不编号了）」这类元信息')
      .toContain('**不要解释你自己**')
    // ⚠️ 兜底提示词也必须禁角标（真机实测：3 次里 1 次冒出 `[1]`）——
    // 它是**用户消息**，比 system 更「近」，只在 system 里禁不够。
    // ⚠️ 断言要**限定在 `buildEmptyChatPrompt` 函数体内** —— 正常链路的聊天版规则里
    // 也有同一句「不要标 [n] 角标」，只查全文时变异改掉兜底那处仍然命中（本轮实测没咬住）。
    const emptyFn = askdeep.slice(askdeep.indexOf('function buildEmptyChatPrompt('), askdeep.indexOf('async function resolveEmptyAnswer('))
    expect(emptyFn, '兜底提示词没禁 [n] 角标 ⇒ 模型会冒出角标（真机实测 3 次里 1 次）')
      .toContain('**不要标 [n] 角标**')
    // 兜底提示词也要禁「万能开场」与要求「先回应内容」（与默认提示词同口径）。
    expect(emptyFn, '兜底提示词没禁「万能开场」').toContain('开场跟着对方的话走')
    expect(emptyFn, '兜底提示词没要求「先回应对方说的内容」').toContain('先回应对方说的内容')
    // 手动问答必须**保持短路**（不编造聊天记录是硬底线）。
    expect(askdeep, '手动问答丢了短路 ⇒ 模型会凭常识编造聊天记录')
      .toContain("if (deps.dataScope !== 'kb-only') {")
  })
})
