/**
 * 「任务信息」页签的**接线守卫**（源码级，2026-10-19）。
 *
 * 仓库没有组件/DOM 测试环境，所以“页面接上了没有”只能读源码断言。这条守卫盯的是
 * **最容易静默失效的几处**（界面照样能打开，但功能悄悄没有了）：
 *   · 导航/懒加载/`renderTab` 三处缺任何一处 ⇒ 新页签根本进不去，或首屏静态打包；
 *   · 面板没订阅 `TASK_CENTER_UPDATED_EVENT` ⇒ 新建/编辑/删除后右栏不刷新；
 *   · 右栏没按 `selectedTaskId` 过滤 ⇒ 点任务列表右栏不变（本页的核心交互）；
 *   · 弹窗缺五组内容中的一组 ⇒ 用户看不到“触发时的完整内容”；
 *   · 编辑表单缺回调地址/标记已完善 ⇒ 任务永远无法参与触发与回调；
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
const NEW_SOURCES = ['TaskCenter.tsx', 'task-center.ts', 'task-center-edit-form.tsx', 'task-center-record-modal.tsx'] as const

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

  it('导出容器与纯展示视图（SSR 冒烟直接渲染后者）', () => {
    expect(code).toContain('export function TaskCenterPanel(')
    expect(code).toContain('export function TaskCenterView(')
  })

  it('任务与触发记录都走 useFreshData（打开即查 + 读失败不进缓存 + WAL 静默刷新）', () => {
    expect(code, '任务列表的缓存键不是 taskCenter:tasks').toContain("useFreshData('taskCenter:tasks'")
    expect(code, '触发记录的缓存键没带上选中任务').toContain("'taskCenter:triggers:' +")
    expect((code.match(/shouldCache: \(d\) => !d\.readError/g) ?? []).length, '两栏都应把「读失败」挡在缓存外').toBe(2)
    expect((code.match(/liveRefresh: true/g) ?? []).length, '两栏都应订阅 WAL 静默刷新').toBe(2)
  })

  it('调用了任务中心的读接口与「立即检查」', () => {
    expect(code).toContain('apiListTaskInfos()')
    expect(code).toContain('apiListTaskTriggers(')
    expect(code).toContain('apiScanTaskTriggers()')
  })

  it('写动作全部经 api-task-center（保存/状态/删除/重投）', () => {
    for (const fn of ['apiSaveTaskInfo', 'apiSetTaskInfoStatus', 'apiDeleteTaskInfo', 'apiDispatchTaskCallback']) {
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
    expect(code, '触发记录查询没带选中任务').toContain('selectedTaskId !== null ? { taskId: selectedTaskId } : undefined')
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

  it('配置项齐全：任务名 / 触发关键词 / 照片数量 / 回调地址', () => {
    for (const label of ['任务名', '触发关键词', '照片数量', '回调地址']) {
      expect(code, `编辑表单缺少「${label}」`).toContain(label)
    }
    expect(code, '照片数量没有做成可输入项').toContain('type="number"')
    expect(code, '照片数量输入没有夹取').toContain('clampPhotoLimit')
  })

  it('三个动作：保存 / 标记已完善（可逆） / 删除走二次确认', () => {
    expect(code).toContain('保存')
    expect(code).toContain('标记已完善')
    expect(code).toContain('标记待完善')
    expect(code, '删除没有二次确认（useConfirm）').toContain('useConfirm()')
    expect(code, '没有「删除」入口').toContain('删除')
  })

  it('回调为空时本地拦截「标记已完善」并把焦点指到回调输入框', () => {
    expect(code, '标记已完善前没有校验回调地址').toContain('标记「已完善」前必须填写回调地址')
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

  it('SSR 冒烟脚本存在，渲染 TaskCenterView 并含关键文案与失败退出码', () => {
    const script = readText(join(ROOT, 'scripts', 'task-center-ssr.tsx'))
    expect(script).toContain("import { TaskCenterView")
    expect(script).toContain('renderToStaticMarkup')
    expect(script, 'SSR 冒烟没有失败退出码').toContain('process.exitCode = 1')
    for (const text of ['触发记录', '待完善', '已完善', '触发时间']) {
      expect(script, `SSR 冒烟没有断言「${text}」`).toContain(text)
    }
  })

  it('`pages/**` 的新文件不许 import node: 内建（layer-direction 判据）', () => {
    for (const file of NEW_SOURCES) {
      const code = panelRead(file)
      expect(code, `${file} import 了 node: 内建`).not.toMatch(/from 'node:/)
    }
  })
})
