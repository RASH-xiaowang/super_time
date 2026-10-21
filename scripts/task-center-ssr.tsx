/**
 * 「任务信息」双栏面板的离屏冒烟（SSR，无浏览器，2026-10-19）。
 *
 * 为什么需要它：仓库没有组件级 DOM 测试环境（见 `docs/CONTRIBUTING.md` §7 与 M13/M15
 * 的既定结论），而这一页有几件**只有真渲染一次才看得到**的事实：
 *   · 双栏标题、状态徽标、关键词折叠（超 3 个折「+N」）是否真的画出来；
 *   · 弹窗分组是否含「触发时间 / 触发群聊 / 触发对象 / 触发图片 / 触发文本」五组；
 *   · 编辑表单是否含「Webhook 地址」「照片数量」「标记已完善」等入口；
 *   · 右栏是否真的按选中任务过滤（未选中任务的那条记录不该出现）。
 *
 * 做法与 `scripts/wordcloud-ssr.tsx` 同一范式：直接渲染**纯展示组件**
 * `TaskCenterView`（取数/副作用在 `TaskCenterPanel`，SSR 不会跑 effect），
 * 数据用 fixture 喂；断言只看静态 HTML，不碰后端、不联网。
 *
 * 运行：`node scripts/ui-ask-smoke.js scripts/task-center-ssr.tsx`
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  TaskCallbackDispatchResult,
  TaskInfo,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoStatus,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import { TaskCenterView, type TaskCenterActions } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx'
import { triggerTimeText } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center.ts'

/** 本地时区构造时间戳：断言里的「本地化时间」在任何 TZ 下都是同一串字符。 */
const T = (y: number, mo: number, d: number, hh: number, mm: number, ss: number): number => new Date(y, mo - 1, d, hh, mm, ss).getTime()

/** 任务 A：待完善；4 个关键词（触发「+1」折叠）。 */
const TASK_A: TaskInfo = {
  id: 1,
  name: '客户报价跟进',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  chatType: 'group',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keywords: ['报价', '合同', '打款', '交付'],
  photoLimit: 3,
  mentionMeOnly: true,
  callbackUrl: '',
  status: 'incomplete',
  createdAt: T(2026, 10, 18, 9, 0, 0),
  updatedAt: T(2026, 10, 18, 9, 0, 0),
  lastTriggeredAt: T(2026, 10, 19, 10, 24, 0),
  triggerCount: 2,
}

/** 任务 B：已完善，带 Webhook 地址。 */
const TASK_B: TaskInfo = {
  id: 2,
  name: '上线通知',
  chatUsername: 'wxid_group_b',
  chatName: '发布群',
  chatType: 'group',
  targetUsername: 'wxid_target_b',
  targetName: '运维值班',
  keywords: ['上线'],
  photoLimit: 1,
  mentionMeOnly: false,
  callbackUrl: 'https://example.com/supertime/callback',
  status: 'ready',
  createdAt: T(2026, 10, 17, 8, 30, 0),
  updatedAt: T(2026, 10, 19, 8, 30, 0),
  lastTriggeredAt: T(2026, 10, 19, 11, 2, 0),
  triggerCount: 1,
}

/** 触发记录 1（任务 A，有图，已投递）。 */
const RECORD_1: TaskTriggerRecord = {
  id: 101,
  taskId: 1,
  taskName: '客户报价跟进',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keyword: '报价',
  text: '客户问：这批货的报价单能今天发一份吗？顺便把上次的合同版本也带上。',
  images: [
    { localId: 9001, createTime: T(2026, 10, 19, 10, 23, 40), sender: '客户经理' },
    { localId: 9002, createTime: T(2026, 10, 19, 10, 23, 52), sender: '客户经理' },
  ],
  messageLocalId: 5001,
  messageSortSeq: 70001,
  triggeredAt: T(2026, 10, 19, 10, 24, 0),
  callbackStatus: 'sent',
  callbackAt: T(2026, 10, 19, 10, 24, 1),
}

/** 触发记录 2（任务 A，无图，待投递）。 */
const RECORD_2: TaskTriggerRecord = {
  id: 102,
  taskId: 1,
  taskName: '客户报价跟进',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keyword: '合同',
  text: '合同盖章版我这边收到了，下午走流程。',
  images: [],
  messageLocalId: 5002,
  messageSortSeq: 70002,
  triggeredAt: T(2026, 10, 19, 9, 5, 30),
  callbackStatus: 'pending',
}

/** 触发记录 3（任务 B）：选中任务 A 时**不该出现**在右栏。 */
const RECORD_OTHER: TaskTriggerRecord = {
  id: 103,
  taskId: 2,
  taskName: '上线通知',
  chatUsername: 'wxid_group_b',
  chatName: '发布群',
  targetUsername: 'wxid_target_b',
  targetName: '运维值班',
  keyword: '上线',
  text: '该记录应被过滤掉',
  images: [],
  messageLocalId: 5003,
  messageSortSeq: 70003,
  triggeredAt: T(2026, 10, 19, 11, 2, 0),
  callbackStatus: 'skipped',
}

/** SSR 用的动作桩：视图只把它们挂到事件上，渲染期不会调用。 */
const OK_MUTATION: TaskInfoMutationResult = { ok: true }
const OK_DISPATCH: TaskCallbackDispatchResult = { ok: true, status: 'sent' }
const ACTIONS: TaskCenterActions = {
  onSelectTask: () => { /* noop */ },
  onToggleEdit: () => { /* noop */ },
  onOpenRecord: () => { /* noop */ },
  onCloseRecord: () => { /* noop */ },
  onRefresh: () => { /* noop */ },
  onScan: () => { /* noop */ },
  onSaveTask: (_task: TaskInfo, _input: TaskInfoInput) => Promise.resolve(OK_MUTATION),
  onSetStatus: (_id: number, _status: TaskInfoStatus) => Promise.resolve(OK_MUTATION),
  onDeleteTask: (_id: number) => Promise.resolve(OK_MUTATION),
  onDeleteTasks: (_ids: number[]) => Promise.resolve({ ok: true, removed: 0 }),
  onDeleteTriggers: (_ids: number[]) => Promise.resolve({ ok: true, removed: 0 }),
  onDispatch: (_triggerId: number) => Promise.resolve(OK_DISPATCH),
  onNotice: () => { /* noop */ },
}

let passed = 0
let failed = 0

/** 断言块（与 wordcloud-ssr 同一口径：一项失败不打断其余项）。 */
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}

/** 极简断言。 */
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** 主场景：选中任务 A、展开任务 A 的编辑表单、打开记录 1 的弹窗。 */
const html = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [TASK_A, TASK_B],
  triggers: [RECORD_1, RECORD_2, RECORD_OTHER],
  selectedTaskId: 1,
  expandedTaskId: 1,
  openRecordId: 101,
  openRecord: RECORD_1,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  tasksStale: false,
  triggersStale: false,
  triggersTotal: 5,
  triggersHasMore: true,
  triggersLoadingMore: false,
  triggersLoadMoreError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  refreshing: false,
  notice: null,
  taskSearch: '报价',
  triggerSearch: '报价',
  triggerSearchDraft: '报价',
  taskBatchMode: false,
  selectedTaskIds: new Set([1]),
  triggerBatchMode: false,
  selectedTriggerIds: new Set([101]),
  actions: ACTIONS,
}))

console.log('任务信息双栏面板 SSR 冒烟')

check('双栏标题与说明渲染出来了', () => {
  ok(html.includes('任务信息'), '缺少左栏标题「任务信息」')
  ok(html.includes('任务触发记录'), '缺少右栏标题「任务触发记录」')
  ok(html.includes('客户报价跟进'), '缺少任务名（左栏没画出来）')
  ok(html.includes('触发记录'), '缺少「触发记录」相关文案')
})

check('任务状态徽标：待完善 / 已完善 都在（颜色档由 Badge 的 data-tone 决定）', () => {
  ok(html.includes('待完善'), '缺少「待完善」')
  ok(html.includes('已完善'), '缺少「已完善」')
  ok(html.includes('data-tone="amber"'), '「待完善」没有 amber 色调')
  ok(html.includes('data-tone="green"'), '「已完善」没有 green 色调')
})

check('任务行信息：会话→目标、关键词折叠 +1、照片张数、未填 Webhook、触发次数', () => {
  ok(html.includes('报价群') && html.includes('客户经理'), '缺少「会话 → 目标」')
  ok(html.includes('>+1<'), '4 个关键词没有折成「+1」')
  ok(html.includes('3 张图片'), '缺少照片张数')
  ok(html.includes('未填 Webhook'), '空 Webhook 地址没有显示「未填 Webhook」')
  ok(html.includes('2 次触发'), '缺少触发次数')
  ok(html.includes(triggerTimeText(RECORD_1.triggeredAt)), '缺少最近触发时间')
})

check('右栏按选中任务过滤：任务 B 的记录不出现', () => {
  ok(html.includes('合同盖章版'), '任务 A 的记录没出现')
  ok(!html.includes('该记录应被过滤掉'), '任务 B 的记录没有被过滤掉（右栏没按 selectedTaskId 过滤）')
  ok(html.includes('报价群') && html.includes('客户经理'), '缺少触发记录的「群聊 / 对象」')
})

check('记录弹窗五组内容齐全（触发时间 / 触发群聊 / 触发对象 / 触发文本 / 触发图片）', () => {
  for (const label of ['触发时间', '触发群聊', '触发对象', '命中关键词', '触发文本', '触发图片']) {
    ok(html.includes(label), `弹窗缺少「${label}」这一组`)
  }
  ok(html.includes('role="dialog"'), '弹窗没有 role="dialog"')
  ok(html.includes('aria-modal="true"'), '弹窗没有 aria-modal')
  ok(html.includes('data-st-dialog="task-center-record"'), '弹窗没有 data-st-dialog 锚点（焦点管理找不到宿主）')
  ok(html.includes('客户问：这批货的报价单'), '缺少触发文本全文')
  ok(html.includes('正在解码触发图片'), '有图片时没有解码中的加载态')
})

check('弹窗回调区：状态徽标 + 重新投递入口', () => {
  ok(html.includes('已投递'), '缺少「已投递」回调状态')
  ok(html.includes('重新投递'), '缺少「重新投递」按钮')
  ok(html.includes('投递时间'), '缺少回调投递时间')
})

check('编辑表单：任务名 / 触发关键词 / 照片数量 / Webhook 地址 / 标记已完善 / 删除', () => {
  for (const label of ['任务名', '触发关键词', '照片数量', 'Webhook 地址', '标记已完善', '删除', '保存']) {
    ok(html.includes(label), `编辑表单缺少「${label}」`)
  }
  ok(html.includes('aria-label="Webhook 地址"'), 'Webhook 地址输入框没有可访问名')
  ok(html.includes('aria-label="编辑任务：客户报价跟进"'), '表单没有可访问名')
  ok(html.includes('仅匹配@我的文本'), '群聊编辑表单缺少「仅匹配@我的文本」')
  ok(html.includes('@所有人不算'), '勾选项缺少结构化 @ 的边界说明')
})

check('工具条：「刷新」「立即检查」与计数都在', () => {
  ok(html.includes('刷新'), '缺少「刷新」')
  ok(html.includes('立即检查'), '缺少「立即检查」')
  ok(/任务\s*(?:<!-- -->)?\s*2/.test(html), '缺少任务计数')
})

check('两栏搜索：任务与触发记录都有搜索框、占位符和清除按钮', () => {
  ok(html.includes('aria-label="搜索任务"'), '左栏缺少搜索框')
  ok(html.includes('搜索任务名 / 关键词 / 会话'), '左栏搜索占位符不对')
  ok(html.includes('aria-label="搜索触发记录"'), '右栏缺少搜索框')
  ok(html.includes('搜索正文 / 任务 / 会话 / 关键词'), '右栏搜索占位符不对')
  ok((html.match(/aria-label="清除搜索"/g) ?? []).length >= 1, '搜索框没有清除按钮')
})

check('任务行直接提供删除入口（复用危险色共享按钮）', () => {
  ok(html.includes('aria-label="删除任务「客户报价跟进」"'), '任务行缺少直接删除入口')
  ok(html.includes('>删除<'), '任务行删除按钮没有可见文案')
})

/** 批量模式单独渲染：同一场景下切换两栏的批量选择状态。 */
const batchProps = {
    tasks: [TASK_A, TASK_B],
    triggers: [RECORD_1, RECORD_2, RECORD_OTHER],
    selectedTaskId: 1,
    expandedTaskId: null,
    openRecordId: null,
    openRecord: null,
    tasksLoading: false,
    triggersLoading: false,
    tasksError: null,
    triggersError: null,
    tasksReadError: null,
    triggersReadError: null,
    triggersTotal: 3,
    triggersHasMore: false,
    triggersLoadingMore: false,
    triggersLoadMoreError: null,
    onLoadMoreTriggers: () => { /* noop */ },
    scanning: false,
    notice: null,
    taskSearch: '',
    triggerSearch: '',
    triggerSearchDraft: '',
    taskBatchMode: true,
    selectedTaskIds: new Set([1]),
    triggerBatchMode: true,
    selectedTriggerIds: new Set([101]),
    actions: ACTIONS,
} satisfies React.ComponentProps<typeof TaskCenterView>
const batchHtml = renderToStaticMarkup(h(TaskCenterView, batchProps))

check('批量模式：两栏都有全选/清空/删除所选与选中计数', () => {
  for (const label of ['任务批量操作', '触发记录批量操作', '删除所选 (1)', '已选 1 条']) {
    ok(batchHtml.includes(label), `批量模式缺少「${label}」`)
  }
  ok((batchHtml.match(/>全选</g) ?? []).length >= 2, '两栏没有都提供全选')
  ok((batchHtml.match(/>清空</g) ?? []).length >= 2, '两栏没有都提供清空')
  ok(batchHtml.includes('role="checkbox"'), '批量模式行没有复选框语义')
  ok(!batchHtml.includes('aria-label="删除任务「客户报价跟进」"'), '批量模式仍暴露单条删除入口')
})

check('左栏搜索按任务名过滤，未命中的任务不出现', () => {
  ok(html.includes('客户报价跟进'), '命中的任务没有出现')
  ok(!html.includes('上线通知'), '未命中的任务仍被画出来（客户端过滤没生效）')
  ok(html.includes('1 / 2 个任务'), '搜索后的任务计数不对')
})

check('触发记录无匹配空态与清除提示', () => {
  const noMatchHtml = renderToStaticMarkup(h(TaskCenterView, {
    tasks: [TASK_A, TASK_B],
    triggers: [],
    selectedTaskId: null,
    expandedTaskId: null,
    openRecordId: null,
    openRecord: null,
    tasksLoading: false,
    triggersLoading: false,
    tasksError: null,
    triggersError: null,
    tasksReadError: null,
    triggersReadError: null,
    onLoadMoreTriggers: () => { /* noop */ },
    scanning: false,
    notice: null,
    taskSearch: '',
    triggerSearch: '不存在',
    triggerSearchDraft: '不存在',
    actions: ACTIONS,
  }))
  ok(noMatchHtml.includes('没有匹配的触发记录'), '缺少触发记录无匹配空态')
  ok(noMatchHtml.includes('当前搜索「不存在」没有命中'), '无匹配空态没有回显搜索词')
  ok(noMatchHtml.includes('可换个词或清除搜索'), '无匹配空态没有清除搜索引导')
})

check('分页入口：显示真实总数与当前已加载条数', () => {
  ok(html.includes('2 / 5 条'), '右栏标题没有显示「已加载 / 总数」')
  ok(html.includes('加载更多（已 2 / 5）'), '缺少「加载更多」按钮或计数不对')
})

/** 空态场景：没有任务时给出去哪创建的引导，而不是一片空白。 */
const emptyHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  actions: ACTIONS,
}))

check('空态：没有任务时给「在聊天会话/聊天信息里点新建任务」的引导', () => {
  ok(emptyHtml.includes('还没有任务信息'), '缺少任务空态标题')
  ok(emptyHtml.includes('新建任务'), '缺少「新建任务」引导')
  ok(emptyHtml.includes('还没有任何触发记录'), '缺少记录空态标题')
  ok(!emptyHtml.includes('role="dialog"'), '空态不该渲染记录弹窗')
})

/** 读错误场景：必须与「确实没有」分开说。 */
const errorHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: 'database is locked',
  triggersReadError: 'database is locked',
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  actions: ACTIONS,
}))

check('读错误：显式错误条（不是「暂无任务」），且带 role="alert"', () => {
  ok(errorHtml.includes('database is locked'), '缺少读错误详情')
  ok(errorHtml.includes('任务库读取失败'), '任务读错误没有独立文案')
  ok(errorHtml.includes('不是「没有任务」'), '任务读错误没有与空态区分')
  ok(errorHtml.includes('触发记录读取失败'), '触发记录读错误没有独立文案')
  ok(errorHtml.includes('role="alert"'), '错误条没有 role="alert"')
  ok(!errorHtml.includes('还没有任务信息'), '读失败时仍画成了「还没有任务信息」空态')
})

console.log(`\n${failed ? '❌' : '✅'} 任务信息面板冒烟：通过 ${String(passed)} 项${failed ? `，失败 ${String(failed)} 项` : ''}`)
if (failed > 0) process.exitCode = 1
