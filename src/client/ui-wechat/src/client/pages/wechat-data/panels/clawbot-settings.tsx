/**
 * ClawBot 实例设置视图（C3 重排，2026-10-13）。
 *
 * 三张卡通栏：**当前实例卡**（绑定详情 + 环境自检 + 危险区）/ **行为卡**（AI 自动回复升格）/
 * **常见问题**。单列而非上一稿的双列：实例轨已吃掉左栏宽度，且绑定卡与自检已合并 ——
 * 双列的动机（两张矮卡并排填空）不存在了（R3 反转，见 clawbot-layout.spec.ts）。
 *
 * ## 与上一稿的差异（都是实测驱动的）
 *
 * - **当前实例的信息只在这里显示一遍**：实例卡（clawbot-instances.tsx）整卡拆解 —— 导航进实例轨、
 *   配置进本视图的行为卡、删除进本卡危险区；「状态 / wxid / 今日 / 累计 / 通道显示两遍」（P3）消失；
 * - **kvGrid 去掉两个无信息项**：「微信昵称」恒为「未提供」（iLink 不下发）、「实例编号」在卡标题里；
 * - **N 档键值行改键上值下**：单列时 space-between 会把键值对横跨 750px 拉散（P5）；
 * - **自动回复有重量**：switch 形态 + 两行说明（走哪条管道 / 在哪审计）；审计入口是**文案指引**
 *   而不是跳转按钮 —— 路由 hash 只在挂载时读（WechatDataPanel.tsx:482），按钮会是死控件；
 * - **读失败不冒充配置**：实例列表 readError 时开关保持原状并明说，不清成「关」。
 *
 * @module panels/clawbot-settings
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClawbotAutoReplyStage, ClawbotAutoReplyStats, ClawbotBindQr, ClawbotBindingSnapshot, ClawbotEnvSnapshot, ClawbotInstance, ClawbotInstanceConfig } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiCheckClawbotEnv,
  apiCreateClawbotBindQr,
  apiDeleteClawbotInstance,
  apiGetClawbotDefaultPrompt,
  apiGetKbs,
  apiListClawbotInstances,
  apiSetClawbotInstanceConfig,
  apiUnbindClawbot,
} from '../api.ts'
import { Card } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { useTransientNotice } from './hooks.tsx'
import { ClawbotBindModal } from './clawbot-bind-modal.tsx'
import { CLAWBOT_STATUS_LABEL, statusClass, statusDot } from './clawbot-status.ts'
import css from './clawbot.module.css'

/** 官方 FAQ 三条（腾讯云《微信 ClawBot 接入指南》原文口径）。 */
const FAQ: ReadonlyArray<{ q: string, a: string }> = [
  {
    q: '页面一直停留「绑定中」怎么办？',
    a: '① 确认 Super Time 正在运行且网络正常；② 关闭当前页面后重新进入；③ 如仍不行，重启 Super Time 后重新绑定。',
  },
  {
    q: '扫码后没有显示已绑定？',
    a: '① 确认扫描的是你希望绑定的微信账号；② 等待几秒让状态同步；③ 若二维码已失效，点「重新生成」后再扫一次。',
  },
  {
    q: '微信里发消息没有响应？',
    a: '① 确认 Super Time 仍在运行；② 回到本页检查集成状态是否仍为「已绑定」；③ 必要时先解绑再重新扫码绑定。',
  },
]

const AUTO_REPLY_STAGE_LABEL: Record<ClawbotAutoReplyStage, string> = {
  idle: '空闲',
  recovering: '恢复中',
  generating: '生成中',
  sending: '发送中',
  completing: '收尾中',
}

/** 一行可扫描的自动回复运行指标；详细错误放在 title 里。 */
function autoReplyMetricsText(stats: ClawbotAutoReplyStats): string {
  return `待处理 ${String(stats.pending)} · ${AUTO_REPLY_STAGE_LABEL[stats.stage]}` +
    ` · 生成成功/失败 ${String(stats.generationSucceeded)}/${String(stats.generationFailed)}` +
    ` · 发送成功/重试/永久失败 ${String(stats.sendSucceeded)}/${String(stats.sendRetried)}/${String(stats.sendFailedPermanently)}` +
    ` · 恢复 ${String(stats.recovered)} · 合并 ${String(stats.coalesced)}` +
    ` · 恢复续跑 ${String(stats.recoveryContinuations)} · 租约丢失 ${String(stats.leaseLost)}` +
    ` · 丢弃 ${String(stats.dropped)} · 背压 ${String(stats.backpressure)}`
}

/** 知识库下拉的选项（只取展示需要的两列）。 */
interface KbOption { id: number, name: string }

/**
 * 卡内**分区**（2026-10-17 重设计）：一张卡里的一个语义块，用**标题 + 上分隔线**划分，
 * 而不是各自一张带边框的卡片。
 *
 * 为什么要有它：设置视图原先三张独立卡（绑定 / 自动回复 / 常见问题），每张都有自己的
 * 边框、圆角与标题栏 —— 视觉上像三个互不相干的板块，而它们其实是**同一个实例的设置**。
 * 合并成一张卡 + 内部分区后，读起来是「一个实例」而不是「三件事」。
 *
 * `collapsible` 用于低频内容（环境自检 / 常见问题）：默认收起，需要时才展开 ——
 * 它们占的纵向空间不小，但日常操作根本用不到。
 * @param props.title - 分区标题。
 * @param props.hint - 标题右侧的补充说明（弱化色）。
 * @param props.collapsible - 是否可折叠（默认展开）。
 * @param props.defaultOpen - 可折叠时的初始展开态。
 * @param props.children - 分区内容。
 */
function Section({ title, hint, collapsible = false, defaultOpen = true, children }: {
  title: string
  hint?: string
  collapsible?: boolean
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (!collapsible) {
    return (
      <div className={css.section}>
        <div className={css.sectionHd}>
          <span className={css.sectionTitle}>{title}</span>
          {hint !== undefined && <span className={css.sectionHint}>{hint}</span>}
        </div>
        <div className={css.sectionBd}>{children}</div>
      </div>
    )
  }
  return (
    <details className={css.section} open={defaultOpen}>
      <summary className={css.sectionHd}>
        <span className={css.sectionTitle}>{title}</span>
        {hint !== undefined && <span className={css.sectionHint}>{hint}</span>}
      </summary>
      <div className={css.sectionBd}>{children}</div>
    </details>
  )
}

function stamp(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 归一提示词草稿（2026-10-17）：与默认值**逐字相同**时存空串。
 *
 * 为什么：输入框预填了默认提示词，用户可能只是点进去又点出来（没改）。
 * 若把整份默认值存进库，以后**改了默认值**这个实例会停在旧的那份 ——
 * 而用户以为自己「用的就是默认」。存空串保持「用默认」语义。
 * @param draft - 输入框内容。
 * @param defaultPrompt - 内置默认提示词。
 * @returns 要落库的值（空串 = 用默认）。
 */
function normalizePrompt(draft: string, defaultPrompt: string): string {
  return draft.trim() === defaultPrompt.trim() ? '' : draft
}

/**
 * 自动回复是否有可运行的知识库作用域。
 *
 * 后端 `clawbot-auto` 是 kb-only + requireKb：没有有效知识库时开启自动回复只会得到
 * 一个“看起来已开启、实际永不发送”的配置。前端必须使用同一判定提前锁住开关。
 */
function hasRunnableKb(cfg: ClawbotInstanceConfig): boolean {
  return cfg.kbEnabled === true
    && cfg.kbId !== null
    && Number.isSafeInteger(cfg.kbId)
    && cfg.kbId > 0
}

/**
 * 行为分区（P4）：会替你给微信联系人发消息的开关，视觉重量与说明要配得上它的后果。
 * switch 形态（非裸 checkbox）+ 两行说明（走哪条管道 / 在哪审计）；读失败不冒充配置。
 *
 * 2026-10-17 重设计：从**独立卡片**改成**同一张卡里的分区**（`Section`）——
 * 设置视图原先三张卡（绑定 / 自动回复 / 常见问题）各自带边框与标题栏，
 * 视觉上像三个互不相干的板块；合并成一张卡 + 内部分区后，读起来是「一个实例的设置」。
 * 模块级组件：让 `ClawbotSettingsView` 留在 function-size-ratchet 的 250 行线内。
 * @param props.cfg - 当前实例的行为配置（null = 读不到 / 读失败）。
 * @param props.kbs - 知识库下拉选项。
 * @param props.cfgBusy - 配置保存中（逐个禁用，避免并发写）。
 * @param props.readError - 实例列表读失败原因（非空时明说，开关保持原状）。
 * @param props.onPatch - 部分更新配置（只覆盖传进来的字段）。
 */
function AutoReplySection({ cfg, kbs, cfgBusy, readError, defaultPrompt, onPatch }: {
  cfg: ClawbotInstanceConfig | null
  kbs: readonly KbOption[]
  cfgBusy: boolean
  readError: string
  /** 内置的拟人化默认提示词（2026-10-17）：输入框为空时**预填**它，让用户看得到默认值。 */
  defaultPrompt: string
  onPatch: (p: { autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean }) => Promise<void>
}): React.JSX.Element {
  /*
   * 提示词草稿（2026-10-17）：受控输入 + **失焦/点保存才提交**。
   * 为什么不做「每次按键都保存」：提示词是长文本，逐键写库既浪费又会让
   * 「保存中」状态一直闪；而用户改到一半切走时，失焦提交能兜住。
   *
   * ⚠️ **空配置预填默认提示词**（2026-10-17 用户要求「将默认提示词在输入框中显示出来」）：
   * 用户此前面对一个空框，看不到默认值长什么样、也不知道从哪改起。
   * 预填后可直接在默认值上改；保存时若内容与默认值**逐字相同**则存空串
   * （保持「用默认」语义 —— 否则以后改了默认值，这个实例会停在旧的那份）。
   */
  const saved = cfg?.systemPrompt ?? ''
  const [draft, setDraft] = useState(saved !== '' ? saved : defaultPrompt)
  // 配置从外部变化（切实例 / 重新读）时同步草稿 —— 否则会显示上一个实例的提示词。
  useEffect(() => { setDraft(saved !== '' ? saved : defaultPrompt) }, [saved, defaultPrompt, cfg?.slot])
  const dirty = draft !== (saved !== '' ? saved : defaultPrompt)
  const kbReady = cfg !== null && hasRunnableKb(cfg)
  // 已开启的历史矛盾配置仍允许关闭，避免锁死用户；只有“从关切的开启动作”被前置阻断。
  const autoReplyBlocked = !kbReady && cfg?.autoReply !== true
  return (
    <Section title="自动回复" hint="会替你发消息，请确认">
      {readError !== '' && (
        <div className={css.instReadError} role="alert">
          实例配置读取失败：{readError}
          <div className={css.muted}>开关保持原状 —— 读不到不等于「关」。</div>
        </div>
      )}
      <label className={css.autoRow}>
        <input
          type="checkbox"
          role="switch"
          checked={cfg?.autoReply ?? false}
          disabled={cfgBusy || cfg === null || autoReplyBlocked} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ autoReply: e.target.checked }) }}
        />
        <span className={css.autoText}>
          <span className={css.autoTitle}>AI 自动回复</span>
          <span className={css.autoDesc}>
            开启前必须先在下方开启知识库增强并选择一个有效知识库。开启后：收到微信消息时，
            Super Time 用设置里的「对话模型」生成回答，且只用该知识库作为事实来源并发送；
            每次回复写一行操作日志（category=clawbot），可在「行动与维护 → 操作日志」里逐条审计。
          </span>
        </span>
      </label>
      {cfg !== null && !kbReady && (
        <span className={css.instWarn}>
          {cfg.autoReply
            ? '当前自动回复不会运行：自动回复需要选择知识库。请开启知识库增强并选择一个有效知识库；保存知识库设置后，无法运行的自动回复状态会自动关闭。'
            : '自动回复需要选择知识库：请先开启下方知识库增强并选择一个有效知识库，之后才能打开自动回复。'}
        </span>
      )}
      <label className={css.autoRow}>
        <input
          type="checkbox"
          role="switch"
          checked={cfg?.kbEnabled ?? false}
          disabled={cfgBusy || cfg === null} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ kbEnabled: e.target.checked }) }}
        />
        <span className={css.autoText}>
          <span className={css.autoTitle}>知识库增强</span>
          <span className={css.autoDesc}>
            自动回复的唯一数据来源。开启后请在下方选择一个有效知识库；关闭增强或清空选择时，
            无法继续运行的自动回复会一并关闭，避免显示已开启却不发送。
          </span>
        </span>
      </label>
      {cfg?.kbEnabled === true && (
        <select
          className={css.instSelect}
          value={cfg.kbId === null ? '' : String(cfg.kbId)}
          disabled={cfgBusy} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ kbId: e.target.value === '' ? null : Number(e.target.value) }) }}
          aria-label="自动回复检索的知识库"
        >
          <option value="">选择知识库…</option>
          {kbs.map((k) => <option key={k.id} value={String(k.id)}>{k.name}</option>)}
        </select>
      )}
      {cfg?.kbEnabled === true && kbs.length === 0 && (
        <span className={css.instWarn}>还没有可用知识库：请先到「知识库」创建并完成索引，再回到这里选择。</span>
      )}

      {/* 系统提示词（2026-10-17）：人设 / 语气 / 回复风格。留空 = 用内置拟人化默认值。 */}
      <div className={css.promptBlock}>
        <div className={css.promptHd}>
          <span className={css.autoTitle}>系统提示词</span>
          <span className={css.promptHint}>
            决定它怎么说话（人设 / 语气 / 风格）。留空则用内置的拟人化默认值 —— 不是「没有提示词」。
          </span>
        </div>
        <textarea
          className={css.promptInput}
          value={draft}
          rows={16}
          disabled={cfgBusy || cfg === null} {...desktopActionProps()}
          placeholder="（默认提示词加载中…）"
          aria-label="实例的系统提示词"
          onChange={(e) => { setDraft(e.target.value) }}
          onBlur={() => { if (dirty) void onPatch({ systemPrompt: normalizePrompt(draft, defaultPrompt) }) }}
        />
        <div className={css.promptFoot}>
          <span className={css.muted}>
            {saved === '' ? '当前：内置默认提示词（可直接在上面改）' : `当前：自定义（${String(saved.length)} 字）`}
            {dirty ? ' · 有未保存的修改' : ''}
          </span>
          <Button
            size="sm" variant="outline"
            disabled={cfgBusy || cfg === null || !dirty}
            onClick={() => { void onPatch({ systemPrompt: normalizePrompt(draft, defaultPrompt) }) }}
            {...desktopActionProps()}
          >保存提示词</Button>
          <Button
            size="sm" variant="outline"
            disabled={cfgBusy || cfg === null || saved === ''}
            onClick={() => { setDraft(defaultPrompt); void onPatch({ systemPrompt: '' }) }}
            {...desktopActionProps()}
          >恢复默认</Button>
        </div>
      </div>

      {/* 分段发送（2026-10-17）：微信里一条几千字读起来很累，且容易被折叠。 */}
      <label className={css.autoRow}>
        <input
          type="checkbox"
          role="switch"
          checked={cfg?.splitReply ?? true}
          disabled={cfgBusy || cfg === null} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ splitReply: e.target.checked }) }}
        />
        <span className={css.autoText}>
          <span className={css.autoTitle}>长回复分段发送</span>
          <span className={css.autoDesc}>
            回复较长时按语义切成几条依次发出（每段不超过 30 字、整条不超过 300 字），像人连发几条那样；
            关闭则整条一次发出，仍不超过 300 字。
          </span>
        </span>
      </label>
    </Section>
  )
}

/**
 * 当前实例分区（2026-10-17 布局重设计）：头像 + 状态 + 绑定动作 + 键值对。
 *
 * 为什么抽成模块级组件：布局重设计后主视图要同时管两栏与四个分区，
 * 留在 `ClawbotSettingsView` 里会撞 function-size-ratchet 的 250 行线。
 *
 * 键值对在**宽栏**里是「键左值右」的两列网格，在**窄栏**（两栏布局的左栏）里
 * 退成单列 —— 左栏只有 ~340px，两列会把值挤成一条缝。
 * @param props.snapshot - 绑定快照（通道状态 / 今日与累计消息）。
 * @param props.inst - 当前实例行（botId / lastMessageAt）。
 * @param props.slot - 当前实例编号。
 * @param props.busy - 绑定/解绑/移除进行中。
 * @param props.onBind - 发起绑定（取码）。
 * @param props.onUnbind - 解绑。
 */
function InstanceSection({ snapshot, inst, slot, busy, onBind, onUnbind }: {
  snapshot: ClawbotBindingSnapshot | null
  inst: ClawbotInstance | null
  slot: number | null
  busy: boolean
  onBind: () => void
  onUnbind: () => void
}): React.JSX.Element {
  const binding = snapshot?.binding ?? null
  const status = binding?.status ?? 'unbound'
  return (
    <Section title={`当前实例 · 实例 ${slot ?? '—'}`} hint="扫码即可绑定，无需 App ID / App Secret">
      <div className={css.bindRow}>
        <div className={css.bindAvatar} aria-hidden="true">{'🦞'}</div>
        <div className={css.bindGrow}>
          <div className={css.bindStatus}>
            <StateDot state={statusDot(status)} />
            <span className={statusClass(status)}>{CLAWBOT_STATUS_LABEL[status]}</span>
            {binding?.wxid && <span className={css.mono} title={binding.wxid}>{binding.wxid}</span>}
          </div>
        </div>
        {(status === 'unbound' || status === 'unbound-by-user') && (
          <Button size="sm" variant="primary" disabled={busy} onClick={onBind} {...desktopActionProps()}>
            {status === 'unbound' ? '绑定微信' : '重新绑定'}
          </Button>
        )}
        {status === 'binding' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onBind} {...desktopActionProps()}>重新生成</Button>
        )}
        {status === 'bound' && (
          <Button size="sm" variant="danger" disabled={busy} onClick={onUnbind} {...desktopActionProps()}>解绑</Button>
        )}
      </div>

      <div className={css.kvGrid}>
        {status === 'bound' && (
          <>
            <div className={css.kvItem}><span className={css.kvKey}>绑定时间</span><span className={css.kvVal}>{stamp(binding?.boundAt ?? null)}</span></div>
            <div className={css.kvItem}>
              <span className={css.kvKey}>接收通道</span>
              <span className={css.kvVal} title={snapshot?.channel.error ?? undefined}>
                {(snapshot?.channel.running ?? false) ? '运行中（长轮询）' : (snapshot?.channel.error ?? '') !== '' ? '异常（见下方自检）' : '未运行'}
              </span>
            </div>
            <div className={css.kvItem}><span className={css.kvKey}>今日消息</span><span className={css.kvVal}>{snapshot?.todayMessages ?? 0}</span></div>
            <div className={css.kvItem}><span className={css.kvKey}>累计消息</span><span className={css.kvVal}>{snapshot?.totalMessages ?? 0}</span></div>
            {/* 2026-10-17 补全实例信息：机器人 id（公开标识，非凭证）与最后活跃时间。 */}
            {inst?.botId != null && (
              <div className={css.kvItem}><span className={css.kvKey}>机器人 id</span><span className={css.kvVal} title={inst.botId}>{inst.botId}</span></div>
            )}
            <div className={css.kvItem}>
              <span className={css.kvKey}>最后消息</span>
              <span className={css.kvVal}>{(inst?.lastMessageAt ?? 0) > 0 ? stamp(inst?.lastMessageAt ?? null) : '还没有消息'}</span>
            </div>
          </>
        )}
        {status === 'unbound-by-user' && (
          <>
            <div className={css.kvItem}><span className={css.kvKey}>上次绑定</span><span className={css.kvVal}>{binding?.userName ?? binding?.wxid ?? '—'}</span></div>
            <div className={css.kvItem}><span className={css.kvKey}>解绑时间</span><span className={css.kvVal}>{stamp(binding?.unboundAt ?? null)}</span></div>
          </>
        )}
      </div>
    </Section>
  )
}

/**
 * 取内置的拟人化默认提示词（2026-10-17）。
 *
 * 为什么单独抽一个 hook：它是**常量**（内置在 worker 里），不随实例/绑定变化 ——
 * 放进 `loadInst` 会让每次切实例都白跑一次 IPC。取不到就留空串（输入框显示
 * placeholder），不影响其余功能。
 * @returns 默认提示词全文（未取到时为空串）。
 */
function useDefaultPrompt(): string {
  const [prompt, setPrompt] = useState('')
  useEffect(() => {
    void apiGetClawbotDefaultPrompt().then(setPrompt).catch(() => { /* 取不到就留空 */ })
  }, [])
  return prompt
}

export function ClawbotSettingsView({ snapshot, slot, onRefresh }: {
  snapshot: ClawbotBindingSnapshot | null
  /** 当前实例编号（多实例）：绑定卡片、自检、配置与删除全部作用于它。 */
  slot: number | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const confirm = useConfirm()
  const notice = useTransientNotice()
  const [env, setEnv] = useState<ClawbotEnvSnapshot | null>(null)
  /** 当前实例行（行为配置 + 会话计数）；null = 读不到或读失败（不冒充配置）。 */
  const [inst, setInst] = useState<ClawbotInstance | null>(null)
  const [instReadError, setInstReadError] = useState('')
  const [kbs, setKbs] = useState<KbOption[]>([])
  /** 内置的拟人化默认提示词（2026-10-17）：输入框为空时预填它。 */
  const defaultPrompt = useDefaultPrompt()
  const [busy, setBusy] = useState(false)
  const [cfgBusy, setCfgBusy] = useState(false)
  /** 进行中的扫码弹窗（取码成功后打开；确认/取消后置空）。 */
  const [bindQr, setBindQr] = useState<ClawbotBindQr | null>(null)

  const refreshEnv = useCallback(async (): Promise<void> => {
    try {
      setEnv(await apiCheckClawbotEnv(slot === null ? undefined : { slot }))
    } catch {
      // 自检拿不到不是致命错误：卡片本身就是「排障指引」，缺一行不拦人。
      setEnv(null)
    }
  }, [slot])

  const loadInst = useCallback(async (): Promise<void> => {
    try {
      // 实例列表与知识库列表**并行**取：两者互不依赖，串行只是白等一个往返
      // （切实例时这一对会跟着 `snapshot` 重跑，串行的代价直接落在点击响应上）。
      const [s, kb] = await Promise.all([
        apiListClawbotInstances(),
        apiGetKbs().catch(() => null),
      ])
      if (s.readError !== undefined) {
        // 读失败 ≠ 没有配置：开关保持原状（这里即清空展示并明说），不冒充「全关」。
        setInst(null)
        setInstReadError(s.readError)
        return
      }
      setInstReadError('')
      setInst(slot === null ? null : (s.instances.find((i) => i.slot === slot) ?? null))
      if (kb !== null && kb.readError === undefined) setKbs(kb.items.map((k) => ({ id: k.id, name: k.name })))
    } catch (e) {
      setInst(null)
      setInstReadError((e as Error).message)
    }
  }, [slot])

  // 卡片上的「接收通道」行与行为配置要跟着绑定/解绑/切换变化 —— 快照刷新时重取。
  useEffect(() => { void refreshEnv() }, [refreshEnv, snapshot])
  useEffect(() => { void loadInst() }, [loadInst, snapshot])

  const binding = snapshot?.binding ?? null
  const status = binding?.status ?? 'unbound'

  const startBind = async (): Promise<void> => {
    setBusy(true)
    try {
      const qr = await apiCreateClawbotBindQr(slot === null ? undefined : { slot })
      setBindQr(qr)
      await onRefresh()
    } catch (e) {
      notice.flash('✗ ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doUnbind = async (): Promise<void> => {
    const ok = await confirm({
      title: '确认解绑？',
      message: binding?.userName || binding?.wxid
        ? `将解除与「${binding.userName ?? ''}${binding.wxid ? `（${binding.wxid}）` : ''}」的绑定。接入会话不会被删除：解绑只是断开微信通道，历史消息仍保留在本机，重新绑定后可继续查看。`
        : '将解除当前绑定。接入会话不会被删除，重新绑定后可继续查看。',
      tone: 'danger',
      confirmText: '确认解绑',
    })
    if (!ok) return
    setBusy(true)
    try {
      const after = await apiUnbindClawbot(slot === null ? undefined : { slot })
      // 解绑成功但库读回失败（罕见）：如实说，不把「读不到」说成「已解绑」。
      notice.flash(after.readError ? '⚠️ 已执行解绑，但状态回读失败：' + after.readError : '✓ 已解绑（接入会话保留）')
      await onRefresh()
    } catch (e) {
      notice.flash('✗ 解绑失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const patch = async (p: { autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean }): Promise<void> => {
    if (slot === null) return
    setCfgBusy(true)
    try {
      await apiSetClawbotInstanceConfig({ slot, ...p })
      await loadInst()
    } catch (e) {
      notice.flash('✗ 保存失败：' + (e as Error).message)
    } finally {
      setCfgBusy(false)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (slot === null || inst === null) return
    const total = inst.totalMessages
    const label = inst.userName ?? inst.wxid ?? '未绑定'
    const ok = await confirm({
      title: `确认移除实例 ${slot}？`,
      message: total > 0
        ? `将删除该实例（${label}）的绑定信息与行为配置，以及它的 ${String(total)} 条接入会话 —— 会话不可恢复。其余实例不受影响。`
        : `将删除该实例（${label}）的绑定信息与行为配置。它还没有接入会话。其余实例不受影响。`,
      tone: 'danger',
      confirmText: '确认移除',
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await apiDeleteClawbotInstance({ slot })
      notice.flash(`✓ 已移除实例 ${slot}（连带删除 ${String(r.removedMessages)} 条接入会话）`)
      await onRefresh()
    } catch (e) {
      notice.flash('✗ 移除失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const cfg = inst?.config ?? null
  /** 自检有异常项时默认展开（用户打开设置多半就是来排障的）。 */
  const envHasIssue = env !== null && env.items.some((it) => it.state !== 'ok')

  return (
    <>
      {/*
        2026-10-17 布局重设计（第二次）：**宽面板两栏 / 窄面板单列**。
        上一稿是「一张卡 + 五个分区单列通栏」—— 在 1016px 宽的面板里，
        键值对横跨 700px 拉散、提示词框占满整宽但内容行很短、右半边大片空白。
        本稿把「实例信息 + 危险区」放左栏（窄、稳定），「自动回复 + 提示词 + 自检 + FAQ」放右栏
        （宽、弹性）—— 两栏信息密度均衡，键值对不再横跨整宽。
        ⚠️ 两栏只在 ≥1201px 生效（与 `.shell` 的实例轨断点同档）；窄面板塌成单列，
        顺序仍是「实例 → 自动回复 → 提示词 → 自检 → FAQ → 危险区」（阅读顺序不变）。
      */}
      <div className={css.settingsCol}>
        <Card className={css.fillCard}>
          <div className={css.settingsGrid}>
            <div className={css.settingsAside}>
              <InstanceSection
                snapshot={snapshot} inst={inst} slot={slot} busy={busy}
                onBind={() => { void startBind() }} onUnbind={() => { void doUnbind() }}
              />
              <div className={css.dangerZone}>
                <Button size="sm" variant="danger" disabled={busy || inst === null} onClick={() => { void doRemove() }} {...desktopActionProps()}>移除该实例</Button>
                <span className={css.muted}>连带删除它的绑定、行为配置与全部接入会话（不可恢复）。其余实例不受影响。</span>
              </div>
            </div>

            <div className={css.settingsMain}>
              <AutoReplySection cfg={cfg} kbs={kbs} cfgBusy={cfgBusy} readError={instReadError} defaultPrompt={defaultPrompt} onPatch={patch} />

              <Section title="环境自检" hint={envHasIssue ? '有异常项' : '全部正常'} collapsible defaultOpen={envHasIssue}>
                {env === null
                  ? <div className={css.muted}>自检信息暂不可用。</div>
                  : (
                    <div>
                      {env.items.map((it) => (
                        <div key={it.key} className={css.chk}>
                          <span className={it.state === 'ok' ? css.tickOk : css.tickBad} aria-hidden="true">{it.state === 'ok' ? '✓' : '!'}</span>
                          <span className={css.chkLabel}>{it.label}</span>
                          <span className={css.chkDetail} title={it.detail}>{it.detail}</span>
                        </div>
                      ))}
                      {cfg?.autoReply === true && (
                        <div className={css.chk}>
                          <span className={env.autoReplyStats.lastError === null ? css.tickOk : css.tickBad} aria-hidden="true">
                            {env.autoReplyStats.lastError === null ? '✓' : '!'}
                          </span>
                          <span className={css.chkLabel}>自动回复（本进程）</span>
                          <span
                            className={css.chkDetail}
                            title={env.autoReplyStats.lastError ?? autoReplyMetricsText(env.autoReplyStats)}
                          >
                            {autoReplyMetricsText(env.autoReplyStats)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
              </Section>

              <Section title="常见问题" collapsible defaultOpen={false}>
                {FAQ.map((f) => (
                  <details key={f.q} className={css.faq}>
                    <summary className={css.faqQ}>{f.q}</summary>
                    <div className={css.faqA}>{f.a}</div>
                  </details>
                ))}
              </Section>
            </div>
          </div>
          {notice.notice && <div className={css.noticeOk}>{notice.notice}</div>}
        </Card>
      </div>

      {bindQr !== null && (
        <ClawbotBindModal
          qr={bindQr}
          {...(slot === null ? {} : { slot })}
          onConfirmed={(b) => {
            setBindQr(null)
            notice.flash(`✓ 已绑定 ${b.binding.wxid ?? ''}（在微信里给它发条消息试试）`)
            void onRefresh()
          }}
          onClose={() => { setBindQr(null) }}
        />
      )}
    </>
  )
}
