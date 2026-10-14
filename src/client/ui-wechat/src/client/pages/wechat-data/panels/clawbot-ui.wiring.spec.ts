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
] as const

const PANELS = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels']
const DATA = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data']

describe('ClawBot 前端接线', () => {
  it('api-core.ts 的 WechatRemote 镜像含全部十二个成员（多实例后 +4）', () => {
    const core = read(...DATA, 'api-core.ts')
    for (const name of CLAWBOT_REMOTES) {
      expect(core, `WechatRemote 缺 ${name}（remote-contract.spec.ts 会红）`).toContain(`${name}(`)
    }
  })

  it('api-clawbot.ts 十二个包装各自 remote().方法名，且被 api.ts 转发', () => {
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
})
