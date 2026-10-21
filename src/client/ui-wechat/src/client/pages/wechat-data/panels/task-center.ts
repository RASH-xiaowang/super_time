/**
 * 「任务信息 / 任务触发记录」面板的**纯逻辑**（2026-10-19）。
 *
 * 按 `docs/CONTRIBUTING.md` §6 的面板分工：状态与副作用在钩子/容器里
 * （`TaskCenter.tsx`），**纯算术放这里**，渲染在 `.tsx`；三份各自有 spec。
 * 本文件因此**不许 import react**（`pages/**` 会被 `layer-direction` 与
 * `react-free-logic` 那类源码判据扫到，也不该为了几个字符串去拉半棵 React）。
 *
 * 这里放的都是「渲染层反复要问、又必须与容器口径一致」的问题：
 *  · 状态/回调状态的中文文案与色调（Badge 的 tone 只有那几个）；
 *  · 回调 URL 的前端校验与「主机名」展示；
 *  · 触发时间/记录的格式化（**手写**而不用 `toLocaleString`：SSR 冒烟在
 *    Node 里渲染，国际化输出随 ICU/时区变化，判据会变成环境依赖）；
 *  · 选中项失效后的下一个值（任务被删后右栏必须回「全部记录」而不是越界）；
 *  · 关键词的增删与草稿校验（编辑表单与单测共用同一份规则）。
 *
 * @module task-center
 */
import type {
  TaskCallbackDispatchResult,
  TaskInfo,
  TaskInfoInput,
  TaskInfoStatus,
  TaskTriggerCallbackStatus,
  TaskTriggerMethod,
  TaskTriggerRecord,
  TaskTriggerScanResult,
} from '@deepseek-ai/dsh-wechat-data/types'
import { fmtDateTimeSec } from '../utils/format.ts'

/** Badge 支持的颜色档（与 `ui/kit-shell.tsx` 的 `Tone` 同集，避免纯逻辑层 import React 模块）。 */
export type TaskCenterTone = 'default' | 'cyan' | 'green' | 'red' | 'amber' | 'purple' | 'blue'

/** 一条状态/事件的中文文案 + 色调 + 一句话解释。 */
export interface TaskCenterMeta {
  label: string
  tone: TaskCenterTone
  hint: string
}

/**
 * 任务状态（待完善 / 已完善）。
 *
 * 语义是**后端定的**：只有 `ready` 才参与触发与投递（见 `types-taskcenter.ts`），
 * 所以「待完善」用 amber 而不是 red —— 它不是错误，只是还没配完。
 */
export const TASK_STATUS_META: Record<TaskInfoStatus, TaskCenterMeta> = {
  incomplete: { label: '待完善', tone: 'amber', hint: '待完善的任务不参与触发，也不会投递（Webhook / 八爪鱼 RPA）；配好并标记「已完善」后才生效' },
  ready: { label: '已完善', tone: 'green', hint: '已完善的任务会参与触发与投递（Webhook / 八爪鱼 RPA）' },
}

/**
 * 触发记录的回调投递状态。
 *
 * `skipped` 的中文是「未配置」而不是「已跳过」：用户在面板里能看到的真实原因是
 * 任务根本没配置当前触发方式所需的地址/凭据，说「跳过」会让人以为是程序主动放弃。
 */
export const CALLBACK_STATUS_META: Record<TaskTriggerCallbackStatus, TaskCenterMeta> = {
  pending: { label: '待投递', tone: 'amber', hint: '等待投递到任务配置的触发目标（Webhook 地址 / 八爪鱼流程）' },
  sent: { label: '已投递', tone: 'green', hint: '已成功投递到任务配置的触发目标（Webhook / 八爪鱼 RPA）' },
  failed: { label: '投递失败', tone: 'red', hint: '触发目标请求失败（可在弹窗里重新投递）' },
  skipped: { label: '未配置', tone: 'default', hint: '任务没有填写当前触发方式所需的 Webhook 地址或八爪鱼配置，因此不投递' },
}

/**
 * 取任务状态文案。
 * @param status - 后端状态。
 * @returns 文案 / 色调 / 解释。
 */
export function taskStatusMeta(status: TaskInfoStatus): TaskCenterMeta {
  return TASK_STATUS_META[status] ?? TASK_STATUS_META.incomplete
}

/**
 * 取回调状态文案。
 * @param status - 后端状态。
 * @returns 文案 / 色调 / 解释。
 */
export function callbackStatusMeta(status: TaskTriggerCallbackStatus): TaskCenterMeta {
  return CALLBACK_STATUS_META[status] ?? CALLBACK_STATUS_META.skipped
}

/**
 * 照片数量区间（与后端 `photoLimit` 的语义一致：0 = 不带图片，上限 9）。
 *
 * 2026-10-19：编辑表单从「0/1/3/6/9 档位 chips」改为可直接输入，所以这里不再列可选值，
 * 只保留区间与夹取规则（输入 2 张、5 张现在都是合法的）。
 */
export const PHOTO_LIMIT_MIN = 0
export const PHOTO_LIMIT_MAX = 9

/**
 * 把输入框里的任意数字收进合法区间。
 * @param value - 用户输入。
 * @returns 0..9 的整数；非有限数归 0，小数向下取整。
 */
export function clampPhotoLimit(value: number): number {
  if (!Number.isFinite(value)) return PHOTO_LIMIT_MIN
  return Math.min(PHOTO_LIMIT_MAX, Math.max(PHOTO_LIMIT_MIN, Math.trunc(value)))
}

/**
 * 触发时间 → `YYYY-MM-DD HH:mm`（本地时区）。
 *
 * 实现复用 `utils/format.ts` 的 `fmtDateTimeSec`（全仓唯一的时间格式化出处，
 * 手写拼接、无 ICU/时区依赖 —— SSR 冒烟在 Node 里也稳定）。本函数只是**单位适配**：
 * 触发记录里存的是**毫秒**，而 `fmtDateTimeSec` 收的是**秒**（单位写进名字是该模块的纪律）。
 * 名字刻意不叫 `fmt*`/`format*`：那正是 `format-single-source.spec.ts` 盯的“第二份实现”形状，
 * 这里没有第二份换算，只有一次 `Math.floor(ms / 1000)`。
 * @param ts - 毫秒时间戳。
 * @returns 可读时间；非法值/0 由 `fmtDateTimeSec` 返回「—」。
 */
export function triggerTimeText(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  return fmtDateTimeSec(Math.floor(ts / 1000))
}

/**
 * 「最近触发」一行文案。
 * @param ts - 最近触发时间（可缺省）。
 * @returns 文案。
 */
export function lastTriggeredLabel(ts?: number): string {
  return ts === undefined || ts <= 0 ? '尚未触发' : `最近触发 ${triggerTimeText(ts)}`
}

/**
 * 触发次数文案。
 * @param count - 记录数。
 * @returns 文案。
 */
export function triggerCountLabel(count: number): string {
  return `${String(Math.max(0, count))} 次触发`
}

/**
 * 照片张数文案（任务配置侧）。
 * @param limit - 照片数量。
 * @returns 文案。
 */
export function photoLimitLabel(limit: number): string {
  return limit <= 0 ? '不带图片' : `${String(limit)} 张图片`
}

/**
 * 记录里图片张数文案（列表行/弹窗用）。
 * @param count - 图片数。
 * @returns 文案。
 */
export function recordImageCountLabel(count: number): string {
  return count <= 0 ? '无图片' : `图片 ${String(count)} 张`
}

/**
 * 把任意文本收成一行可展示的摘要（换行/连续空白折成单空格）。
 * @param text - 原文。
 * @returns 单行文本。
 */
export function plainText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 列表行的文本摘要：单行截断（长文本靠 `title` 兜底全文）。
 * @param text - 触发文本。
 * @param max - 最多保留的字符数（默认 90）。
 * @returns 摘要。
 */
export function recordSummary(text: string, max = 90): string {
  const one = plainText(text)
  if (one === '') return '（无文本）'
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/**
 * 关键词 chips 的展示切片：最多显示 `limit` 个，其余折成「+N」。
 * @param keywords - 任务关键词。
 * @param limit - 最多显示几个（默认 3）。
 * @returns 展示用列表与隐藏数。
 */
export function visibleKeywords(keywords: readonly string[], limit = 3): { shown: readonly string[]; hidden: number } {
  const shown = keywords.slice(0, Math.max(0, limit))
  return { shown, hidden: Math.max(0, keywords.length - shown.length) }
}

/**
 * 回调 URL 是否合法（只认 http/https，且必须能解析出主机名）。
 * @param url - 用户输入。
 * @returns 是否合法；空串按「未填」处理并返回 false。
 */
export function isHttpCallbackUrl(url: string): boolean {
  const raw = url.trim()
  if (raw === '') return false
  try {
    const parsed = new URL(raw)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
  } catch {
    return false
  }
}

/**
 * Webhook 地址的主机名（列表行展示用；未填/非法时返回空串）。
 * @param url - Webhook 地址。
 * @returns 形如 `example.com` / `example.com:8080`。
 */
export function callbackHostname(url: string): string {
  const raw = url.trim()
  if (raw === '') return ''
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/**
 * Webhook 地址的一行文案：有主机名给主机名，否则「未填 Webhook」。
 * @param url - Webhook 地址。
 * @returns 展示文案。
 */
export function callbackUrlLabel(url: string): string {
  return callbackHostname(url) || '未填 Webhook'
}

/* ── 触发方式（Webhook / 八爪鱼 RPA，2026-10-21）────────────────────────
 *
 * 任务本身仍由微信群消息命中关键词触发；这里选的是**命中之后往哪投递**：
 * `webhook` = 原有整条记录 JSON POST；`bazhuayu` = 调八爪鱼启动流程接口，
 * 把触发记录映射成 room_name / content / at_name（详见 `docs/TASK-CENTER.md`）。
 * 文案是 SSR / E2E 与后端错误文案共用的字面量，不要意译。
 */

/** 触发方式选项（Segmented 与 spec 共用，顺序即展示顺序）。 */
export const TASK_TRIGGER_METHOD_OPTIONS: ReadonlyArray<{ value: TaskTriggerMethod; label: string }> = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'bazhuayu', label: '八爪鱼 RPA' },
]

/**
 * 触发方式的中文名（徽标 / 表单 / 提示复用）。
 * @param method - 后端触发方式。
 * @returns `Webhook` 或 `八爪鱼 RPA`。
 */
export function triggerMethodLabel(method: TaskTriggerMethod): string {
  return method === 'bazhuayu' ? '八爪鱼 RPA' : 'Webhook'
}

/**
 * 任务行的一行触发摘要（用户一眼看出这条任务命中后往哪投递）。
 * @param task - 任务。
 * @returns `八爪鱼 RPA · <flowId>`；webhook 沿用 `Webhook <host>` / `未填 Webhook`。
 */
export function taskTriggerSummary(task: TaskInfo): string {
  if (task.triggerMethod === 'bazhuayu') {
    const flowId = task.bazhuayuFlowId.trim()
    return flowId === '' ? '八爪鱼 RPA · 未填 FlowId' : `八爪鱼 RPA · ${flowId}`
  }
  const host = callbackHostname(task.callbackUrl)
  return host === '' ? '未填 Webhook' : `Webhook ${host}`
}

/**
 * 「标记已完善」还需要补什么（表单在 Segmented 下方给一行说明，与后端错误文案同口径）。
 * @param method - 当前选择的触发方式。
 * @returns 一句话提示。
 */
export function readyRequirementHint(method: TaskTriggerMethod): string {
  return method === 'bazhuayu'
    ? '标记已完善前需填写八爪鱼 FlowId 与 API Key'
    : '标记已完善前需填写 Webhook 地址'
}

/** 八爪鱼 FlowId 的长度上限（与后端校验同口径）。 */
export const BAZHUAYU_FLOW_ID_MAX = 128
/** 八爪鱼 API Key 的长度上限（与后端校验同口径）。 */
export const BAZHUAYU_API_KEY_MAX = 512

/**
 * 八爪鱼 FlowId 的形态：`[A-Za-z0-9_-]{1,128}`（空串 = 待完善任务还没填，不算非法）。
 * @param value - 用户输入。
 * @returns 去掉首尾空白后是否仍是合法形态。
 */
export function isValidBazhuayuFlowId(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{1,${String(BAZHUAYU_FLOW_ID_MAX)}}$`).test(value.trim())
}

/**
 * 八爪鱼 API Key 的形态：非空、trim 后无任何空白/控制字符、不超过 512 字。
 * （Key 由用户从八爪鱼开放平台复制，本机只校验「像不像一个可用的请求头值」。）
 * @param value - 用户输入。
 * @returns 是否合法；空串按「未填」处理并返回 false。
 */
export function isValidBazhuayuApiKey(value: string): boolean {
  const raw = value.trim()
  if (raw === '' || raw.length > BAZHUAYU_API_KEY_MAX) return false
  return !/[\s\u0000-\u001F\u007F]/.test(raw)
}

/**
 * 右栏按当前选中任务过滤（`null` = 全部记录）。
 *
 * 服务端已按 `taskId` 过滤过一次；这里再兜一层，是因为「选中任务被删/切换的瞬间」
 * 两栏的刷新不是同一次 RPC 落地 —— 不兜的话会短暂把上一个任务的记录画在新任务名下。
 * @param records - 触发记录快照。
 * @param taskId - 当前选中任务 id（null = 全部）。
 * @returns 过滤后的记录（保持原顺序）。
 */
export function filterTriggersByTask(records: readonly TaskTriggerRecord[], taskId: number | null): readonly TaskTriggerRecord[] {
  if (taskId === null) return records
  return records.filter((r) => r.taskId === taskId)
}

/** 触发记录搜索词上限（与后端 `TRIGGER_SEARCH_MAX` 同口径）。 */
export const TRIGGER_SEARCH_MAX = 100

/**
 * 限制搜索框原始输入长度，不提前 trim（受控输入要保留用户正在输入的空格）。
 * @param value - 输入框原文。
 * @returns 最多 100 字。
 */
export function capTriggerSearchInput(value: string): string {
  return value.slice(0, TRIGGER_SEARCH_MAX)
}

/**
 * 提交给后端的搜索词：先 trim，再截到 100 字。
 * @param value - 输入框原文。
 * @returns 稳定查询词。
 */
export function normalizeTriggerSearch(value: string): string {
  return value.trim().slice(0, TRIGGER_SEARCH_MAX)
}

/**
 * 左栏任务搜索（客户端过滤全部已加载任务）。
 *
 * 任务列表本身一次性取全，所以这里不需要服务端查询；空关键词返回原数组身份，
 * 避免搜索框刚聚焦就让整列产生无意义的重渲染。匹配范围与用户能在行里看到的身份字段
 * 一致：任务名、关键词、会话/对象及其 username，另外带上 Webhook 地址 / 八爪鱼 FlowId
 * 便于定位触发方式配置。
 * @param tasks - 全部任务。
 * @param query - 搜索框原文。
 * @returns 命中任务；空搜索时就是入参本身。
 */
export function filterTasksBySearch(tasks: readonly TaskInfo[], query: string): readonly TaskInfo[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return tasks
  return tasks.filter((task) => {
    const fields = [
      task.name,
      task.chatName,
      task.chatUsername,
      task.targetName,
      task.targetUsername,
      task.callbackUrl,
      task.bazhuayuFlowId,
      ...task.keywords,
    ]
    return fields.some((field) => field.toLowerCase().includes(needle))
  })
}

/**
 * 把下一页追加进当前列表（按记录 id 去重，再按服务端同一排序归并）。
 *
 * 翻页请求与后台扫描可能同时发生；用 id 去重可避免两页边界重叠时 React 出现重复 key。
 * @param current - 已加载的记录。
 * @param next - 新一页记录。
 * @returns 追加后的新数组（不修改入参）。
 */
export function appendTriggerPage(
  current: readonly TaskTriggerRecord[],
  next: readonly TaskTriggerRecord[],
): readonly TaskTriggerRecord[] {
  if (next.length === 0) return current
  const seen = new Set(current.map((r) => r.id))
  const appended = next.filter((r) => !seen.has(r.id))
  if (appended.length === 0) return current
  const ordered = [...current, ...appended]
  ordered.sort((a, b) => {
    if (a.triggeredAt !== b.triggeredAt) return b.triggeredAt - a.triggeredAt
    return b.id - a.id
  })
  return ordered
}

/**
 * 触发记录静默刷新时，判断是否需要按原加载范围续取后续页。
 *
 * 第一页刷新只能安全替换第一页；已加载多页时，如果只拿第一页替换，列表会从
 * N 条缩回一页，右栏高度骤降，滚动位置也会被浏览器钳回顶部。这个判断保持为
 * 纯函数，hook 只负责按游标补齐。
 * @param loadedCount - 刷新前已加载条数。
 * @param pageSize - 服务端页大小。
 * @returns 是否需要续取后续页。
 */
export function needsTriggerPageBackfill(loadedCount: number, pageSize: number): boolean {
  if (!Number.isFinite(loadedCount) || !Number.isFinite(pageSize) || pageSize <= 0) return false
  return loadedCount > Math.floor(pageSize)
}

/**
 * 任务列表刷新后，选中项的下一个值。
 *
 * 语义：**选中项只在任务仍存在时有效**；被删则回「全部记录」（null），
 * 绝不保留一个指向已消失任务的 id（右栏会一直空、用户又看不出为什么）。
 * 选中项本来就为空时也返回 null（不制造新选中）。
 * @param tasks - 最新任务列表。
 * @param current - 当前选中 id。
 * @returns 仍然有效的 id 或 null。
 */
export function nextSelectedTaskId(tasks: readonly TaskInfo[], current: number | null): number | null {
  if (current === null) return null
  return tasks.some((t) => t.id === current) ? current : null
}

/**
 * 展开编辑项的下一个值（同 {@link nextSelectedTaskId} 的口径，删除后收起抽屉）。
 *
 * 2026-10-21 起 `expandedTaskId` 的语义是「**正在编辑**的任务 id」：编辑入口从行内展开
 * 改成了右侧抽屉，任务刷新后不存在时这里返回 null，容器据此关抽屉。
 * @param tasks - 最新任务列表。
 * @param current - 当前展开 id。
 * @returns 仍然有效的 id 或 null。
 */
export function nextExpandedTaskId(tasks: readonly TaskInfo[], current: number | null): number | null {
  return nextSelectedTaskId(tasks, current)
}

/** 批量删除一次最多处理的记录数（与后端 `TASK_BATCH_DELETE_MAX` 同口径）。 */
export const TASK_BATCH_DELETE_MAX = 500

/** 批量选择切换单个 id（返回新 Set，不修改入参）。 */
export function toggleSelectedId(selected: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** 批量「全选」：只选中当前可见的 id（搜索过滤后不会误选隐藏项）。 */
export function selectAllIds(ids: readonly number[]): ReadonlySet<number> {
  return new Set(ids)
}

/** 刷新后清理已不存在的选中 id，避免删除请求带上已经消失的记录。 */
export function retainSelectedIds(
  selected: ReadonlySet<number>,
  availableIds: readonly number[],
): ReadonlySet<number> {
  if (selected.size === 0) return selected
  const available = new Set(availableIds)
  const next = new Set([...selected].filter((id) => available.has(id)))
  if (next.size === selected.size && [...selected].every((id) => next.has(id))) return selected
  return next
}

/** 批量操作栏的选中计数文案。 */
export function selectionCountText(count: number): string {
  return `已选 ${String(Math.max(0, count))} 条`
}

/** 是否超过批量删除上限（超限时按钮禁用并给出一次说清的原因）。 */
export function exceedsBatchLimit(count: number): boolean {
  return count > TASK_BATCH_DELETE_MAX
}

/** 任务计数（页头/工具栏的「任务 N · 待完善 M」）。 */
export interface TaskCounts {
  total: number
  incomplete: number
  ready: number
  triggers: number
}

/**
 * 统计任务状态与触发数（容器把两栏快照一起传进来）。
 * @param tasks - 任务列表。
 * @returns 计数。
 */
export function taskCounts(tasks: readonly TaskInfo[]): TaskCounts {
  let incomplete = 0
  let ready = 0
  let triggers = 0
  for (const t of tasks) {
    if (t.status === 'ready') ready += 1
    else incomplete += 1
    triggers += Math.max(0, t.triggerCount)
  }
  return { total: tasks.length, incomplete, ready, triggers }
}

/** 编辑表单的草稿（受控值全集；校验与提交都只看它）。 */
export interface TaskEditDraft {
  name: string
  keywords: string[]
  photoLimit: number
  mentionMeOnly: boolean
  /** 触发方式：`webhook`（整条记录 POST）或 `bazhuayu`（八爪鱼 RPA 启动流程）。 */
  triggerMethod: TaskTriggerMethod
  callbackUrl: string
  bazhuayuFlowId: string
  /**
   * API Key 的**输入框内容**（不是已保存的 Key）。
   *
   * Remote 返回值里只有 `bazhuayuApiKeySet: boolean`、从不回读 Key 原文，所以草稿恒从空串开始；
   * 用户不输入 = 保留旧 Key（保存时不带 `bazhuayuApiKey` 字段）。
   */
  bazhuayuApiKeyInput: string
}

/**
 * 从任务快照生成表单初值。
 * @param task - 任务。
 * @returns 草稿（关键字/回调/FlowId 均原样，不做 trim —— 用户一进表单就改字符会丢输入）。
 */
export function draftFromTask(task: TaskInfo): TaskEditDraft {
  return {
    name: task.name,
    keywords: [...task.keywords],
    photoLimit: task.photoLimit,
    mentionMeOnly: task.mentionMeOnly,
    // 旧快照（类型升上来之前的缓存）可能没有该字段：缺省按 webhook 渲染，行为不变。
    triggerMethod: task.triggerMethod === 'bazhuayu' ? 'bazhuayu' : 'webhook',
    callbackUrl: task.callbackUrl,
    bazhuayuFlowId: task.bazhuayuFlowId,
    bazhuayuApiKeyInput: '',
  }
}

/** 表单校验错误（字段名 → 行内文案）。 */
export interface TaskDraftErrors {
  name?: string
  keywords?: string
  photoLimit?: string
  callbackUrl?: string
  bazhuayuFlowId?: string
  bazhuayuApiKey?: string
}

/**
 * 校验编辑草稿。
 *
 * 规则（与后端一致的最小集）：任务名非空、关键词至少 1 个；两种触发方式**各自只校验
 * 当前方式**的配置（切换方式时另一方式的字段保留不清空，但不该拦住这次保存）：
 *  · `webhook`：地址**可空**（待完善任务允许先不填），一旦填了就必须是 http/https；
 *  · `bazhuayu`：FlowId 可空，填了必须是 `[A-Za-z0-9_-]{1,128}`；API Key 可空
 *    （空 = 保留旧 Key / 尚未配置），填了必须无空白且 ≤512。
 * 「标记已完善」的必填前置不在这里，而在表单 submit 里按方式分支（见 `readyRequirementHint`）。
 * @param draft - 草稿。
 * @returns 错误集合；全合法时为空对象。
 */
export function validateTaskDraft(draft: TaskEditDraft): TaskDraftErrors {
  const errors: TaskDraftErrors = {}
  if (draft.name.trim() === '') errors.name = '任务名不能为空'
  const keywords = draft.keywords.filter((k) => k.trim() !== '')
  if (keywords.length === 0) errors.keywords = '至少填写 1 个触发关键词'
  if (!Number.isInteger(draft.photoLimit) || draft.photoLimit < PHOTO_LIMIT_MIN || draft.photoLimit > PHOTO_LIMIT_MAX) {
    errors.photoLimit = `照片数量需为 ${String(PHOTO_LIMIT_MIN)}–${String(PHOTO_LIMIT_MAX)} 的整数（0 = 不带图片）`
  }
  if (draft.triggerMethod === 'bazhuayu') {
    const flowId = draft.bazhuayuFlowId.trim()
    if (flowId !== '' && !isValidBazhuayuFlowId(flowId)) {
      errors.bazhuayuFlowId = `FlowId 只能包含字母、数字、下划线或短横线，且不超过 ${String(BAZHUAYU_FLOW_ID_MAX)} 个字符`
    }
    const apiKey = draft.bazhuayuApiKeyInput.trim()
    if (apiKey !== '' && !isValidBazhuayuApiKey(apiKey)) {
      errors.bazhuayuApiKey = `API Key 不能包含空白字符，且不超过 ${String(BAZHUAYU_API_KEY_MAX)} 个字符`
    }
  } else {
    const callback = draft.callbackUrl.trim()
    if (callback !== '' && !isHttpCallbackUrl(callback)) errors.callbackUrl = 'Webhook 地址必须是 http/https 链接'
  }
  return errors
}

/**
 * 把逗号/分号/顿号/换行分隔的一串输入拆成关键词。
 * @param raw - 输入框内容（也可能是粘贴的一串）。
 * @returns 去空白后的关键词；空串返回空数组。
 */
export function splitKeywordInput(raw: string): string[] {
  return raw
    .split(/[,，;；、\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 追加关键词（去重：大小写不敏感，保留首次出现的写法）。
 * @param list - 现有列表（不修改入参）。
 * @param raw - 输入框内容（可含多个分隔符）。
 * @returns 新列表。
 */
export function addKeywords(list: readonly string[], raw: string): string[] {
  const next = [...list]
  const seen = new Set(next.map((k) => k.toLowerCase()))
  for (const kw of splitKeywordInput(raw)) {
    const key = kw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push(kw)
  }
  return next
}

/**
 * 删除一个关键词（大小写不敏感）。
 * @param list - 现有列表。
 * @param keyword - 要删的词。
 * @returns 新列表。
 */
export function removeKeyword(list: readonly string[], keyword: string): string[] {
  const key = keyword.toLowerCase()
  return list.filter((k) => k.toLowerCase() !== key)
}

/**
 * 草稿 → 保存入参（补齐任务自身的会话/目标字段，`id` 必带 = 更新）。
 *
 * 触发方式的保存语义（与后端 `ResolvedTaskFields` 同口径）：
 *  · `triggerMethod` 总是带上（用户可能刚从另一种方式切过来）；
 *  · `bazhuayuFlowId` 总是带上（空串 = 清空，与「旧值沿用」区分开）；
 *  · `bazhuayuApiKey` **只在输入框非空时带上**：空输入 = 用户没改 Key，
 *    整个字段缺省（undefined）后端才保留旧 Key；传空串的语义是**清空**，表单不提供该入口。
 * @param task - 被编辑的任务。
 * @param draft - 已经校验过的草稿。
 * @returns `apiSaveTaskInfo` 的入参。
 */
export function taskSaveInput(task: TaskInfo, draft: TaskEditDraft): TaskInfoInput {
  const input: TaskInfoInput = {
    id: task.id,
    name: draft.name.trim(),
    chatUsername: task.chatUsername,
    chatName: task.chatName,
    chatType: task.chatType,
    targetUsername: task.targetUsername,
    targetName: task.targetName,
    keywords: draft.keywords.map((k) => k.trim()).filter((k) => k !== ''),
    photoLimit: clampPhotoLimit(draft.photoLimit),
    mentionMeOnly: task.chatType === 'group' && draft.mentionMeOnly,
    triggerMethod: draft.triggerMethod,
    callbackUrl: draft.callbackUrl.trim(),
    bazhuayuFlowId: draft.bazhuayuFlowId.trim(),
  }
  const apiKey = draft.bazhuayuApiKeyInput.trim()
  if (apiKey !== '') input.bazhuayuApiKey = apiKey
  return input
}

/**
 * 扫描结果 → 一条提示文案。
 * @param result - `apiScanTaskTriggers` 的返回值。
 * @returns 用户可读的一句话。
 */
export function scanResultText(result: TaskTriggerScanResult): string {
  if (!result.ok) {
    const extra = result.error !== undefined && result.error !== '' ? `：${result.error}` : ''
    return `扫描失败${extra}`
  }
  const failed = result.errors?.length ?? 0
  const suffix = failed > 0 ? `（${String(failed)} 个任务失败）` : ''
  return `扫描完成：检查 ${String(result.scanned)} 条新消息，新增 ${String(result.created)} 条触发记录，投递 ${String(result.dispatched)} 条回调${suffix}`
}

/**
 * 手动重投的结果 → 提示文案。
 * @param result - `apiDispatchTaskCallback` 的返回值。
 * @returns 用户可读的一句话。
 */
export function dispatchResultText(result: TaskCallbackDispatchResult): string {
  if (!result.ok) {
    const extra = result.error !== undefined && result.error !== '' ? `：${result.error}` : ''
    return `重新投递失败${extra}`
  }
  return result.status === 'sent' ? '已重新投递' : `投递结果：${callbackStatusMeta(result.status).label}`
}

/**
 * 右栏标题（选中任务时带上任务名，用户才知道列表被筛过）。
 * @param task - 当前选中的任务（null = 未选中）。
 * @returns 标题文案。
 */
export function triggerPaneTitle(task: TaskInfo | null): string {
  return task === null ? '任务触发记录' : `任务触发记录 · ${task.name}`
}

/**
 * 选中任务的会话/目标一行（`chatName → targetName`；单聊且同名时不重复）。
 * @param task - 任务。
 * @returns 展示文案。
 */
export function taskScopeLabel(task: TaskInfo): string {
  const chat = task.chatName || task.chatUsername || '未知会话'
  const target = task.targetName || task.targetUsername || '未知对象'
  if (task.chatType === 'private' && chat === target) return chat
  return `${chat} → ${target}`
}
