/**
 * 「任务信息」页签的**接线守卫**（源码级，2026-10-19）。
 *
 * 仓库没有组件/DOM 测试环境，所以“页面接上了没有”只能读源码断言。这条守卫盯的是
 * **最容易静默失效的几处**（界面照样能打开，但功能悄悄没有了）：
 *   · 导航/懒加载/`renderTab` 三处缺任何一处 ⇒ 新页签根本进不去，或首屏静态打包；
 *   · 面板没订阅 `TASK_CENTER_UPDATED_EVENT` ⇒ 新建/编辑/删除后右栏不刷新；
 *   · 右栏没按 `selectedTaskId` 过滤 ⇒ 点任务列表右栏不变（本页的核心交互）；
 *   · 弹窗缺五组内容中的一组 ⇒ 用户看不到“触发时的完整内容”；
 *   · 编辑表单缺 Webhook 地址/标记已完善 ⇒ 任务永远无法参与触发与投递；
 *   · 新文件 import `node:` 内建 ⇒ 违反 `layer-direction` 的 `pages/**` 约束。
 *
 * 断言口径与 `docs/CONTRIBUTING.md` §5 一致：**先归一 CRLF 再剥注释**（helper 里已做），
 * 否则注释里的旧写法会把 `not.toContain` 判成假绿。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoot, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'
import { NAV_GROUPS, TAB_LABELS, type WechatTab } from '../nav-config.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const DATA_DIR = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
const PANELS = join(DATA_DIR, 'panels')
const panelRead = (file: string): string => readStripped(join(PANELS, file))
const dataRead = (file: string): string => readStripped(join(DATA_DIR, file))

/** 本任务新增的前端文件（`pages/**` 的非 spec 源码，不许 import `node:` 内建）。 */
const NEW_SOURCES = [
  'TaskCenter.tsx',
  'task-center.ts',
  'task-center-panes.tsx',
  'task-center-edit-form.tsx',
  'task-center-record-modal.tsx',
  'task-delete-button.tsx',
  'use-task-center-triggers.ts',
] as const

describe('导航与懒加载：taskinfo 是一个可见入口', () => {
  it('WechatTab 联合里有 taskinfo，TAB_LABELS 给它「任务信息」', () => {
    const tab: WechatTab = 'taskinfo'
    expect(TAB_LABELS[tab]).toBe('任务信息')
  })

  it('「行动与维护」组里有可见的 taskinfo 条目（不是 hidden）', () => {
    const group = NAV_GROUPS.find((g) => g.label === '行动与维护')
    expect(group, '「行动与维护」分组不见了（nav-config 改结构时请同步本用例）').toBeDefined()
    const item = group?.items.find((it) => it.tab === 'taskinfo')
    expect(item, '「行动与维护」里没有 taskinfo 条目').toBeDefined()
    expect(item?.label).toBe('任务信息')
    expect(item?.hidden, 'taskinfo 被标成 hidden —— 侧栏就看不到这个入口了').not.toBe(true)
    expect(item?.icon, '图标为空（SVG 会被渲染成空白）').toContain('<path')
  })

  it('panel-loaders 用 lazy 懒加载 TaskCenterPanel，且目标文件存在', () => {
    const loaders = dataRead('panel-loaders.tsx')
    expect(loaders, 'panel-loaders 没导出 TaskCenterPanel').toContain('export const TaskCenterPanel = lazy(')
    expect(loaders, 'TaskCenterPanel 的懒加载目标不是 panels/TaskCenter.tsx').toContain("import('./panels/TaskCenter.tsx')")
    expect(existsSync(join(PANELS, 'TaskCenter.tsx')), 'panels/TaskCenter.tsx 不存在').toBe(true)
  })

  it('WechatDataPanel 有 taskinfo 的 renderTab 分支，且只经 panel-loaders 取面板', () => {
    const shell = dataRead('WechatDataPanel.tsx')
    expect(shell, 'WechatDataPanel 没 import TaskCenterPanel').toContain('TaskCenterPanel,')
    expect(shell, 'renderTab 里没有 taskinfo 分支').toContain("case 'taskinfo': return <TaskCenterPanel />")
    expect(shell, '面板不该被静态 import（会失去按页签懒加载）').not.toContain("from './panels/TaskCenter.tsx'")
  })

  it('主容器头注的页签数/可见数跟着真源改了（docs-consistency 会现算比对）', () => {
    const shell = readText(join(DATA_DIR, 'WechatDataPanel.tsx'))
    const nav = readStripped(join(DATA_DIR, 'nav-config.ts'))
    const union = sliceBetween(nav, 'export type WechatTab =', 'export interface NavItem', 'WechatTab 联合')
    const tabs = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1] ?? '')
    const nHidden = [...nav.matchAll(/hidden: true/g)].length
    expect(shell, 'WechatDataPanel 头注的页签数没跟着 nav-config 改').toContain(`可路由页签共 **${String(tabs.length)}**（其余 ${String(nHidden)} 项`)
    expect(shell, 'WechatDataPanel 头注的侧栏可见数没跟着改').toContain('侧栏可见 **15** 项')
  })
})

describe('数据容器：取数、事件联动、选中过滤', () => {
  const code = panelRead('TaskCenter.tsx')
  const panes = panelRead('task-center-panes.tsx')
  const triggers = panelRead('use-task-center-triggers.ts')

  it('导出容器与纯展示视图（SSR 冒烟直接渲染后者）', () => {
    expect(code).toContain('export function TaskCenterPanel(')
    expect(code).toContain('export function TaskCenterView(')
  })

  it('任务与触发记录都走 useFreshData（打开即查 + 读失败不进缓存 + WAL/按钮静默刷新）', () => {
    expect(code, '任务列表的缓存键不是 taskCenter:tasks').toContain("useFreshData('taskCenter:tasks'")
    expect(code, '触发记录取数没有走专用 hook').toContain('useTaskCenterTriggers(')
    expect(triggers, '触发记录的缓存键没带上选中任务与搜索词').toContain("'taskCenter:triggers:' + triggerQueryKey")
    expect((code.match(/shouldCache: \(d\) => !d\.readError/g) ?? []).length, '任务列表应把「读失败」挡在缓存外').toBe(1)
    expect((triggers.match(/shouldCache: \(d\) => !d\.readError/g) ?? []).length, '触发记录应把「读失败」挡在缓存外').toBe(1)
    expect((code.match(/liveRefresh: true/g) ?? []).length + (triggers.match(/liveRefresh: true/g) ?? []).length, '两栏都应订阅 WAL 静默刷新').toBe(2)
    expect(code, '任务栏刷新按钮没有接静默 reloadSilent').toContain('const reloadTasks = taskState.reloadSilent')
    expect(code, '触发记录刷新按钮没有接静默 reloadSilent').toContain('const reloadTriggers = triggerState.reloadSilent')
    expect(triggers, '触发记录 hook 没有透出静默刷新').toContain('reloadSilent: fresh.reloadSilent')
  })

  it('调用了任务中心的读接口与「立即检查」', () => {
    expect(code).toContain('apiListTaskInfos()')
    expect(triggers, '触发记录读接口没有走分页搜索 hook').toContain('apiListTaskTriggers(')
    expect(code).toContain('apiScanTaskTriggers()')
  })

  it('写动作全部经 api-task-center（保存/状态/单删/批删/重投）', () => {
    for (const fn of [
      'apiSaveTaskInfo', 'apiSetTaskInfoStatus', 'apiDeleteTaskInfo',
      'apiDeleteTaskInfos', 'apiDeleteTaskTriggers', 'apiDispatchTaskCallback',
    ]) {
      expect(code, `容器没有接线 ${fn}`).toContain(`${fn}(`)
    }
  })

  it('订阅 TASK_CENTER_UPDATED_EVENT 并回源**两栏**；宿主事件也接了', () => {
    expect(code).toContain('TASK_CENTER_UPDATED_EVENT')
    expect(code, '没有监听 TASK_CENTER_UPDATED_EVENT').toContain('window.addEventListener(TASK_CENTER_UPDATED_EVENT')
    expect(code, '没有用宿主 WAL 推送的订阅').toContain('useWechatDataUpdated(')
    expect(code, '事件后应同时重取两栏（否则左栏变了右栏不刷）').toContain('Promise.all([reloadTasks(), reloadTriggers()])')
  })

  it('右栏按 selectedTaskId 过滤（服务端查 + 客户端兜一层）', () => {
    expect(triggers, '触发记录查询没带选中任务').toContain('selectedTaskId !== null')
    expect(triggers, '触发记录查询没带 taskId').toContain('taskId: selectedTaskId')
    expect(code, '视图没有按 selectedTaskId 再过一遍').toContain('filterTriggersByTask(props.triggers, props.selectedTaskId)')
  })

  it('选中/展开项失效后回落并提示（不越界、不留空右栏）', () => {
    expect(code).toContain('nextSelectedTaskId(')
    expect(code).toContain('nextExpandedTaskId(')
    expect(code, '选中任务被删后没有可见提示').toContain('选中的任务已不存在')
  })

  it('手机/浏览器态对「仅桌面」写操作降级（扫描是写库动作）', () => {
    expect(code, '没有对仅桌面动作做降级（手机端点下去会报 METHOD_NOT_ALLOWED_REMOTE）').toContain('desktopActionProps()')
    expect(code, '没有给只读视图的说明文案').toContain('desktopAction()')
  })

  it('提示语走 useTransientNotice（不手写 setTimeout 清提示）', () => {
    expect(code).toContain('useTransientNotice(')
    expect(code).not.toContain('setNotice')
  })

  it('弹窗按 id 从最新快照解析记录（找不到时显示不可用，而不是过期副本）', () => {
    expect(code).toContain('triggerItems.find((r) => r.id === openRecordId)')
  })

  it('触发记录分页：只认服务端 nextCursor，切任务/刷新回第一页，失败不清空已加载列表', () => {
    expect(triggers, '加载更多与多页补齐都应消费服务端 nextCursor').toContain('nextTriggerCursorRef.current = snapshot.nextCursor')
    expect(triggers, '加载更多仍应把服务端 nextCursor 写回推进游标').toContain('nextTriggerCursorRef.current = page.nextCursor')
    expect(triggers, '是否有下一页必须进入 React state 才会触发重渲染').toContain('nextCursor: TaskTriggerCursor | undefined')
    expect(triggers, '加载更多没有向 API 传游标').toContain('cursor,')
    expect(triggers, '没有在筛选变化时重置分页').toContain('nextTriggerCursorRef.current = undefined')
    expect(triggers, '加载更多失败没有走独立的底部错误').toContain('setLoadMoreError((e as Error).message)')
    expect(triggers, '加载更多失败时不应替换整份列表').not.toMatch(/catch[\s\S]{0,180}setLoadedTriggers\(\[\]\)/)
    expect(triggers, '切筛选时应忽略仍指向上一筛选的旧 data 对象').toContain('observed?.page === page && observed.key !== triggerQueryKey')
    expect(triggers, '首屏与后续页应显式使用同一个 limit').toContain('limit: TRIGGER_PAGE_SIZE')
    expect(triggers, '第一页刷新后应让在途的旧分页请求失效').toContain('triggerQueryRef.current += 1')
    expect(triggers, '分页接口的 readError 应转成底部错误').toContain('setLoadMoreError(page.readError)')
    expect(triggers, '列表与总数必须是同一个状态快照（避免新列表 + 旧总数的中间帧）').toContain('items: triggerList.items')
    expect(triggers, '接管第一页快照时列表与总数应一起替换').toContain('total: page.total')
    expect(triggers, '多页静默刷新没有按已加载范围补齐').toContain('needsTriggerPageBackfill(')
    expect(triggers, '补齐后续页失败时不应清空当前列表').toContain('backfillFirstPage')
    expect(triggers, '同一份第一页快照不应因 effect 重跑重复接管').toContain('if (acceptedPageRef.current === page) return')
  })

  it('触发记录搜索：服务端查询带 search，输入防抖与后端 100 字上限同源', () => {
    expect((triggers.match(/^\s{6,}search,$/gm) ?? []).length, '首屏、加载更多与多页补齐都应带服务端 search').toBe(3)
    expect(triggers, '搜索输入没有防抖').toContain('TRIGGER_SEARCH_DEBOUNCE_MS')
    expect(triggers, '搜索提交没有归一为 trim + 100 字').toContain('normalizeTriggerSearch(searchDraft)')
    expect(triggers, '输入框没有复用共享长度上限').toContain('capTriggerSearchInput(value)')
    expect(triggers, '缓存键没有包含搜索词').toContain("+ ':' + search")
  })

  it('任务搜索是客户端过滤，搜索状态由容器持有，SSR 仍可本地输入', () => {
    expect(panes, '左栏没有使用客户端搜索过滤').toContain('filterTasksBySearch(tasks, search)')
    expect(code, '任务搜索状态没有提升到容器').toContain('const [taskSearch, setTaskSearch] = useState')
    expect(code, '视图没有接任务搜索回调').toContain('onTaskSearchChange={setTaskSearch}')
    expect(code, '视图缺省状态无法供 SSR 使用').toContain('props.taskSearch ?? localTaskSearch')
  })

  it('删除成功等待两栏静默回源后再给组件成功提示', () => {
    expect(code, '删除成功后没有等待刷新').toContain('await refreshBoth()')
    const deleteAt = code.indexOf('const handleDeleteTask = useCallback')
    const deleteEnd = code.indexOf('const handleDispatch = useCallback', deleteAt)
    expect(deleteAt, '找不到删除动作，断言失去参照').toBeGreaterThan(0)
    expect(deleteEnd, '找不到删除动作的结束边界').toBeGreaterThan(deleteAt)
    const deleteBody = code.slice(deleteAt, deleteEnd)
    expect(deleteBody, '删除刷新仍被 fire-and-forget').not.toContain('void refreshBoth()')
  })

  it('手动刷新无感：不弹成功提示、按钮只显示在途状态，不清空当前内容', () => {
    const refreshAt = code.indexOf('const handleRefresh = useCallback')
    const scanAt = code.indexOf('const handleScan = useCallback', refreshAt)
    expect(refreshAt, '找不到手动刷新动作').toBeGreaterThan(0)
    expect(scanAt, '找不到手动刷新动作的结束边界').toBeGreaterThan(refreshAt)
    const refreshBody = code.slice(refreshAt, scanAt)
    expect(refreshBody, '手动刷新不该再弹「已刷新」提示条').not.toContain('已刷新最新数据')
    expect(code, '首屏加载 / 静默刷新期间刷新按钮都应暴露 aria-busy').toContain('aria-busy={refreshBusy}')
    expect(code, '首屏加载 / 静默刷新期间刷新按钮都应禁用，防重复点击').toContain('disabled={refreshBusy}')
    expect(code, 'refreshBusy 没有包含首屏两项 loading').toContain('const refreshBusy = props.refreshing === true || props.tasksLoading || props.triggersLoading')
  })

  it('刷新在途时再次收到事件会排一次尾随补刷，不把最后一次变更丢掉', () => {
    const refreshAt = code.indexOf('const refreshBoth = useCallback')
    const scheduleAt = code.indexOf('const scheduleRefresh = useCallback', refreshAt)
    expect(refreshAt, '找不到 refreshBoth').toBeGreaterThan(0)
    expect(scheduleAt, '找不到 refreshBoth 的结束边界').toBeGreaterThan(refreshAt)
    const refreshBody = code.slice(refreshAt, scheduleAt)
    expect(refreshBody, '并发刷新直接 return，会丢掉尾随事件').toContain('refreshPendingRef.current = true')
    expect(refreshBody, '没有在首轮结束后补刷').toContain('while (refreshPendingRef.current)')
  })

  it('多页静默刷新有请求上界，超界时保留旧列表而不是截断', () => {
    expect(triggers, '缺少补齐页数上界').toContain('TRIGGER_BACKFILL_MAX_PAGES')
    expect(triggers, '超界时没有放弃这一轮').toContain('fetchedPages >= TRIGGER_BACKFILL_MAX_PAGES')
    expect(triggers, '目标范围超出上界时必须整轮放弃').toContain('target > TRIGGER_PAGE_SIZE * TRIGGER_BACKFILL_MAX_PAGES')
  })

  it('批量删除：选择态、全选/清空、确认文案、500 上限与桌面降级都接线', () => {
    expect(code).toContain('onDeleteTasks')
    expect(code).toContain('onDeleteTriggers')
    expect(code).toContain('selectedTaskIds')
    expect(code).toContain('selectedTriggerIds')
    expect(code).toContain('toggleSelectedId(')
    expect(code).toContain('retainSelectedIds(')
    expect(panes).toContain('删除所选 (')
    expect(code).toContain('删除所选 ${String(ids.length)} 个任务？')
    expect(code).toContain('删除所选 ${String(ids.length)} 条触发记录？')
    expect(code, '任务批删确认没有说明历史记录保留').toContain('已产生的触发记录会保留')
    expect(code, '触发记录批删确认没有说明重算统计').toContain('触发次数与最近触发时间会按剩余记录重算')
    expect(panes, '批量删除没有受桌面端权限控制').toContain('desktopActionProps()')
    expect(panes, '缺少 500 条上限').toContain('TASK_BATCH_DELETE_MAX')
    expect(code, '删任务后没有清理失效的选中/展开项').toContain('setExpandedTaskId')
    expect(code, '删触发记录后没有清理失效的弹窗').toContain('setOpenRecordId')
    expect(code, '改搜索草稿时要立即清空触发记录选择').toContain('triggerState.searchDraft')
    expect(code, '等待防抖提交后才清空会让用户删到旧筛选下的记录')
      .toContain('}, [selectedTaskId, triggerState.searchDraft])')
    expect(code).toContain('await refreshBoth()')
  })
})

describe('记录弹窗：完整内容五组 + 图片按需解码 + 可访问性', () => {
  const code = panelRead('task-center-record-modal.tsx')

  it('五组内容都在：触发时间 / 触发群聊 / 触发对象 / 触发图片 / 触发文本', () => {
    for (const label of ['触发时间', '触发群聊', '触发对象', '触发图片', '触发文本']) {
      expect(code, `弹窗缺少「${label}」`).toContain(label)
    }
    expect(code, '弹窗没有展示命中的关键词').toContain('命中关键词')
  })

  it('图片按需批量解码（记录里只存引用）', () => {
    expect(code).toContain('apiGetImageDataUrlsBatch(')
    expect(code, '图片请求没有用记录的 chatUsername').toContain('record.chatUsername')
    expect(code, '单张失败没有占位').toContain('图片解码失败')
  })

  it('可访问性：role=dialog + aria-modal + Esc/焦点两套钩子都真的调用', () => {
    expect(code).toContain('role="dialog"')
    expect(code).toContain('aria-modal="true"')
    expect(code).toContain('aria-labelledby="task-record-title"')
    expect(/useEscapeToClose\s*\(/.test(code), '没有调用 useEscapeToClose').toBe(true)
    expect(/useDialogFocus\s*\(/.test(code), '没有调用 useDialogFocus').toBe(true)
    expect(code, '没有 data-st-dialog 锚点（useDialogFocus 按它找宿主）').toContain('data-st-dialog="task-center-record"')
  })

  it('关闭方式三种：右上角 × / 底部关闭 / 点遮罩', () => {
    expect(code).toContain('aria-label="关闭触发记录"')
    expect(code).toContain('aria-label="关闭大图"')
    expect(code).toContain('e.target === e.currentTarget')
  })

  it('记录已不可用与重新投递都有落地', () => {
    expect(code).toContain('记录已不可用')
    expect(code).toContain('重新投递')
  })

  it('重新投递在手机端降级（会向外部地址出网）', () => {
    expect(code).toContain('desktopActionProps()')
  })
})

describe('编辑表单：配置项与三个动作', () => {
  const code = panelRead('task-center-edit-form.tsx')
  const remove = panelRead('task-delete-button.tsx')

  it('配置项齐全：任务名 / 触发关键词 / 照片数量 / Webhook 地址', () => {
    for (const label of ['任务名', '触发关键词', '照片数量', 'Webhook 地址']) {
      expect(code, `编辑表单缺少「${label}」`).toContain(label)
    }
    expect(code, '照片数量没有做成可输入项').toContain('type="number"')
    expect(code, '照片数量输入没有夹取').toContain('clampPhotoLimit')
  })

  it('群聊编辑支持「仅匹配@我的文本」，单聊不显示且保存归一为 false', () => {
    expect(code, '编辑表单没有渲染「仅匹配@我的文本」').toContain('仅匹配@我的文本')
    expect(code, '勾选项没有只在群聊显示').toContain("task.chatType === 'group'")
    expect(code, '勾选项没有接到草稿').toContain('checked={draft.mentionMeOnly}')
    expect(panelRead('task-center.ts'), '保存没有强制单聊为 false')
      .toContain("mentionMeOnly: task.chatType === 'group' && draft.mentionMeOnly")
  })

  it('三个动作：保存 / 标记已完善（可逆） / 删除复用共享入口', () => {
    expect(code).toContain('保存')
    expect(code).toContain('标记已完善')
    expect(code).toContain('标记待完善')
    expect(code, '编辑表单没有复用共享删除按钮').toContain('<TaskDeleteButton')
    expect(remove, '共享删除按钮没有二次确认（useConfirm）').toContain('useConfirm()')
    expect(remove, '删除按钮没有危险色').toContain('variant="danger"')
    expect(remove, '删除按钮没有桌面端降级').toContain('desktopActionProps()')
    expect(remove, '确认文案没有说明历史记录保留').toContain('已产生的触发记录会保留')
    expect(code, '行内删除入口没有使用共享按钮').toContain('TaskDeleteButton')
  })

  it('回调为空时本地拦截「标记已完善」并把焦点指到回调输入框', () => {
    expect(code, '标记已完善前没有校验 Webhook 地址').toContain('标记「已完善」前必须填写 Webhook 地址')
    expect(code, '没有把焦点指到回调输入框').toContain('callbackRef.current?.focus()')
  })

  it('关键词支持回车/逗号添加与去重、移除', () => {
    expect(code).toContain('onKeywordKeyDown')
    expect(code).toContain('addKeywords(')
    expect(code).toContain('removeKeyword(')
  })

  it('保存/改状态/删除在手机端降级（都是本机写动作）', () => {
    expect(code).toContain('desktopActionProps()')
  })
})

describe('样式与 SSR 冒烟', () => {
  it('样式文件存在，双栏 ≥900px 并排、<900px 上下堆叠', () => {
    const css = readText(join(PANELS, 'task-center.module.css'))
    expect(css).toContain('.board {')
    expect(css).toContain('grid-template-columns: minmax(300px, 3fr) minmax(0, 7fr)')
    expect(css, '缺少 ≤900px 堆叠断点').toContain('@media (max-width: 900px)')
    expect(css, '弹窗没有高度上界（窄屏会顶出视口）').toContain('max-height: min(86vh, 820px)')
  })

  it('样式只用设计令牌，不写裸色值（浅色主题读不清的根因）', () => {
    const css = readText(join(PANELS, 'task-center.module.css'))
    expect(css).toContain('var(--nm-')
    expect(css, '出现裸 hex 色值').not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css, '出现裸 rgb()/rgba() 色值').not.toMatch(/rgba?\(/)
  })

  it('栏内搜索框位于栏标题行，占据弹性宽度并由栏头换行兜底', () => {
    const css = readText(join(PANELS, 'task-center.module.css'))
    expect(css, '栏头不允许窄屏换行').toMatch(/\.paneHd\s*\{[\s\S]*?flex-wrap:\s*wrap/)
    const rule = sliceBetween(css, '.paneSearch {', '}', 'paneSearch 规则')
    expect(rule, '搜索框没有占据标题与计数之间的弹性宽度').toContain('flex: 1 1 160px')
    expect(rule, '搜索框在窄栏里会缩到无法输入').toContain('min-width: 140px')
  })

  it('SSR 冒烟脚本存在，渲染 TaskCenterView 并含关键文案与失败退出码', () => {
    const script = readText(join(ROOT, 'scripts', 'task-center-ssr.tsx'))
    expect(script).toContain("import { TaskCenterView")
    expect(script).toContain('renderToStaticMarkup')
    expect(script, 'SSR 冒烟没有失败退出码').toContain('process.exitCode = 1')
    for (const text of ['触发记录', '待完善', '已完善', '触发时间']) {
      expect(script, `SSR 冒烟没有断言「${text}」`).toContain(text)
    }
    expect(script, 'SSR 冒烟没有覆盖「加载更多」').toContain('加载更多（已 2 / 5）')
    expect(script, 'SSR 冒烟没有左右两个搜索框').toContain('搜索任务名 / 关键词 / 会话')
    expect(script, 'SSR 冒烟没有触发记录搜索框').toContain('搜索正文 / 任务 / 会话 / 关键词')
    expect(script, 'SSR 冒烟没有覆盖清除按钮').toContain('aria-label="清除搜索"')
    expect(script, 'SSR 冒烟没有覆盖任务行删除入口').toContain('aria-label="删除任务')
  })

  it('`pages/**` 的新文件不许 import node: 内建（layer-direction 判据）', () => {
    for (const file of NEW_SOURCES) {
      const code = panelRead(file)
      expect(code, `${file} import 了 node: 内建`).not.toMatch(/from 'node:/)
    }
  })
})
