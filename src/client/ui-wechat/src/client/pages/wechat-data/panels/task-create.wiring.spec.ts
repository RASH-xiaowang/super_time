// @vitest-environment node
/**
 * 「新建任务」弹窗的**接线守卫**（2026-10-19）。
 *
 * 弹窗写好了却没人挂 = 界面少一屏，而且所有行为用例照样绿（本仓反复踩过）。这里读源码断言：
 *  ① 三处入口（会话头部「更多」/ 群信息抽屉底部 / 单聊聊天信息抽屉底部）都真的有「新建任务」
 *    且真的引用了 `TaskCreateDialog`；
 *  ② 弹窗真的调 `apiSaveTaskInfo`（写任务）与 `apiGetGroupInfo`（群成员）；
 *  ③ 产品语义的关键字样都在：关键词、目标用户、照片档位、「待完善」说明、后端错误回显；
 *  ④ 旧收集弹窗彻底退场（文件不在了、引用为 0），防止它被"顺手挂回去"变成第二个入口。
 *
 * 不读 CSS 皮肤细节，只断言本弹窗关键的几个类存在（关键词 chips / 成员列表 / 抽屉动作位），
 * 并钉住错误行复用 kit 的 `.error`（`state-components.wiring.spec.ts` 禁止面板自造错误样式）——
 * 类名被删掉时 CSS Modules 只静默返回 undefined，界面不报错、也不会让任何行为用例变红。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const HEAD = readStripped(join(HERE, 'chats-head-actions.tsx'))
const GROUP_VIEW = readStripped(join(HERE, 'chats-group-info-view.tsx'))
const CONTACT_VIEW = readStripped(join(HERE, 'chats-contact-info-view.tsx'))
const DIALOG = readStripped(join(HERE, 'task-create-dialog.tsx'))
const LOGIC = readStripped(join(HERE, 'task-create.ts'))
const API_TASK = readStripped(join(HERE, '..', 'api-task-center.ts'))
const API_SEARCH = readStripped(join(HERE, '..', 'api-search.ts'))
const API_BARREL = readStripped(join(HERE, '..', 'api.ts'))
const CSS = readText(join(HERE, 'task-create.module.css'))
const PANEL_FILES = readdirSync(HERE)

/**
 * 旧素材收集弹窗的痕迹：三个文件，任何一处重新出现都说明"第二个新建任务入口"回来了。
 *
 * 名字**拆开拼**而不是写整词：旧流程退场后，仓库自检按旧弹窗名 grep 应该 0 命中，
 * 只有本守卫还要提到那段旧名字；拆开拼能让外部按整词核对"旧流程真的没了"时不被守卫自身干扰。
 */
const OLD_DIALOG_NAME = ['ChatsCollect', 'Dialog'].join('')
const OLD_PREFIX = ['chats', 'collect'].join('-')
const OLD_FILES = [`${OLD_PREFIX}-dialog.tsx`, `${OLD_PREFIX}.wiring.spec.ts`, `${OLD_PREFIX}.module.css`] as const
const OLD_MARKERS = [OLD_DIALOG_NAME, `${OLD_PREFIX}-dialog`, `${OLD_PREFIX}.module.css`] as const

describe('新建任务（触发式任务）前端接线', () => {
  it('哨兵：几份源码都读到了（读空 ⇒ 下面的"含/不含"全部恒真）', () => {
    expect(HEAD.length, 'chats-head-actions.tsx 没读到').toBeGreaterThan(3000)
    expect(GROUP_VIEW.length, 'chats-group-info-view.tsx 没读到').toBeGreaterThan(3000)
    expect(CONTACT_VIEW.length, 'chats-contact-info-view.tsx 没读到').toBeGreaterThan(3000)
    expect(DIALOG.length, 'task-create-dialog.tsx 没读到').toBeGreaterThan(5000)
    expect(LOGIC.length, 'task-create.ts 没读到').toBeGreaterThan(3000)
    expect(CSS.length, 'task-create.module.css 没读到').toBeGreaterThan(1000)
  })

  it('入口①：「更多」菜单里的新建任务打开 TaskCreateDialog', () => {
    expect(HEAD, '「更多」菜单里没有「新建任务」').toContain('新建任务')
    expect(HEAD, '菜单项没有打开新弹窗').toContain('setTaskOpen(true)')
    expect(HEAD, '「更多」里没挂 TaskCreateDialog').toContain('TaskCreateDialog')
    expect(HEAD, '头部动作没从新弹窗模块 import').toContain("from './task-create-dialog.tsx'")
    expect(HEAD, '旧收集弹窗又长回来了').not.toContain(OLD_DIALOG_NAME)
  })

  it('入口②：群信息抽屉底部动作位有「新建任务」，并用群信息构造群会话', () => {
    expect(GROUP_VIEW, '群信息抽屉底部没有「新建任务」').toContain('新建任务')
    expect(GROUP_VIEW, '群信息抽屉没挂 TaskCreateDialog').toContain('TaskCreateDialog')
    expect(GROUP_VIEW, '群信息抽屉没从新弹窗模块 import').toContain("from './task-create-dialog.tsx'")
    expect(GROUP_VIEW, '群会话没从 groupInfo 构造（username/name 必须来自群信息本身）')
      .toContain("session={{ username: groupInfo.username, displayName: groupInfo.name, type: 'group' }}")
    expect(GROUP_VIEW, '按钮没打开弹窗').toContain('setTaskOpen(true)')
  })

  it('入口③：单聊聊天信息抽屉底部动作位有「新建任务」，并把当前会话交给弹窗', () => {
    expect(CONTACT_VIEW, '聊天信息抽屉底部没有「新建任务」').toContain('新建任务')
    expect(CONTACT_VIEW, '聊天信息抽屉没挂 TaskCreateDialog').toContain('TaskCreateDialog')
    expect(CONTACT_VIEW, '聊天信息抽屉没从新弹窗模块 import').toContain("from './task-create-dialog.tsx'")
    expect(CONTACT_VIEW, '单聊没把当前会话交给弹窗').toContain('<TaskCreateDialog session={session}')
    expect(CONTACT_VIEW, '按钮没打开弹窗').toContain('setTaskOpen(true)')
  })

  it('弹窗真的调写接口与群成员接口，且成功/失败都有出口', () => {
    expect(API_TASK, 'api-task-center.ts 没有 apiSaveTaskInfo').toContain('apiSaveTaskInfo')
    expect(API_BARREL, 'api.ts 没转发 api-task-center').toContain("export * from './api-task-center.ts'")
    expect(API_SEARCH, 'api-search.ts 没有 apiGetGroupInfo').toContain('apiGetGroupInfo')
    expect(DIALOG, '弹窗没调写接口').toContain('apiSaveTaskInfo(')
    expect(DIALOG, '弹窗没调群成员接口').toContain('apiGetGroupInfo(')
    // 后端校验失败要原样回显（吞掉它 = 用户只看到"点了没反应"）
    expect(DIALOG, '没有把后端 error 文案显示出来').toContain('result.error')
    expect(DIALOG, '错误行没有 role=alert').toContain('role="alert"')
    expect(DIALOG, '没有把 api 层广播后的成功态画出来').toContain('已加入任务信息 · 待完善')
    expect(DIALOG, '成功文案没讲清"完善回调地址后启用"').toContain('完善回调地址后启用')
  })

  it('弹窗覆盖产品语义：关键词 / 目标用户 / 照片数量 / 待完善', () => {
    expect(DIALOG, '关键词输入框没有"回车或逗号"提示').toContain('输入关键词后按回车或逗号添加')
    expect(DIALOG, '丢了「任一关键词命中即触发」的口径').toContain('任一关键词命中即触发')
    expect(DIALOG, '群聊未选目标用户的提示没了').toContain('群聊需选择目标用户')
    expect(DIALOG, '没有引用关键词/照片数量的纯逻辑').toContain('addKeywordBatch')
    expect(DIALOG, '照片数量没有渲染成可输入的 number 框').toContain('type="number"')
    expect(DIALOG, '照片数量输入没有夹取（用户敲 100 会直接提交）').toContain('clampPhotoLimit')
    expect(DIALOG, '没有「触发时携带最近 N 张」的说明').toContain('photoHint(')
    expect(DIALOG, '手机/浏览器态没有降级到 desktopAction').toContain('desktopAction()')
    expect(DIALOG, '降级按钮没有 spread desktopActionProps（等于只是禁用了一句没接上）').toContain('desktopActionProps()')
    expect(LOGIC, '写接口入参没有固定 incomplete 状态').toContain("status: 'incomplete'")
    expect(LOGIC, '写接口入参没有 targetUsername').toContain('targetUsername')
    expect(LOGIC, '写接口入参没有 photoLimit').toContain('photoLimit')
    expect(LOGIC, '照片数量上限不是 9').toContain('PHOTO_LIMIT_MAX = 9')
    expect(LOGIC, '关键词上限不是 20').toContain('KEYWORD_MAX_COUNT = 20')
    expect(LOGIC, '单个关键词上限不是 64').toContain('KEYWORD_MAX_LEN = 64')
    expect(LOGIC, '成员列表没有"超过 200 提示搜索"的门槛').toContain('MEMBER_FILTER_THRESHOLD = 200')
    expect(LOGIC, '成员列表没有"最多画 50 行"的上限').toContain('MEMBER_RENDER_LIMIT = 50')
  })

  it('弹窗自己带 Esc 关闭、焦点陷阱与遮罩判空', () => {
    expect(DIALOG, '弹窗没有 Esc 关闭').toContain('useEscapeToClose(')
    expect(DIALOG, '弹窗没有焦点陷阱').toContain('useDialogFocus(')
    expect(DIALOG, '打开时焦点没有落到关键词输入框').toContain('keywordRef.current?.focus()')
    expect(DIALOG, '点遮罩没判 e.target === e.currentTarget（点弹窗内容会把弹窗关掉）')
      .toContain('if (e.target === e.currentTarget) onClose()')
    expect(DIALOG, '缺少 dialog 标识（useDialogFocus 按它找宿主）').toContain('data-st-dialog="task-create"')
  })

  it('旧素材收集弹窗彻底退场：文件没了、引用为 0', () => {
    for (const file of OLD_FILES) {
      expect(existsSync(join(HERE, file)), `${file} 应该已被替换掉（旧的"收集最近 N 条"流程不再是新建任务）`).toBe(false)
    }
    expect(PANEL_FILES.filter((f) => f.startsWith(OLD_PREFIX)), 'panels/ 里还留着旧收集弹窗的文件').toEqual([])
    for (const [name, src] of [['chats-head-actions.tsx', HEAD], ['task-create-dialog.tsx', DIALOG]] as const) {
      for (const marker of OLD_MARKERS) {
        expect(src, `${name} 里还引用着旧弹窗痕迹 ${marker}`).not.toContain(marker)
      }
    }
  })

  it('本弹窗自己的样式类在（类名删了 CSS Modules 只会静默给 undefined）', () => {
    for (const cls of ['.chip {', '.memberList {', '.drawerActions {', '.successTitle {']) {
      expect(CSS, `task-create.module.css 里少了 ${cls}`).toContain(cls)
    }
  })

  it('错误行复用 kit 的 .error（不许在面板 CSS 里另造一份）', () => {
    // 2026-10-19 集成：`state-components.wiring.spec.ts` 明令 panels/*.module.css 不得定义
    // `.error` / `.errBanner`。所以本弹窗的错误行改用 kitCss.error，这里把口径钉在「复用了」上，
    // 不要写成「CSS 里没有 .error」—— 那是一条空断言（删文件也能过）。
    expect(DIALOG, '新建任务弹窗的错误行没有复用 kit 的 .error').toContain('kitCss.error')
    expect(CSS, 'task-create.module.css 又把 .error 造回来了').not.toMatch(/(?:^|\n)\.error(?![A-Za-z0-9_-])/)
  })

  it('反例自证：把旧弹窗字样混进合成源码，同一批判据必须咬住', () => {
    const fake = HEAD + `\n<${OLD_DIALOG_NAME} />\n`
    const bites = OLD_MARKERS.filter((marker) => fake.includes(marker))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ OLD_MARKERS 是空的').toBeGreaterThan(0)
    // 真源码里本来就不许有这些指纹 —— 否则上面那条"引用为 0"是假绿
    expect(HEAD).not.toContain(bites[0]!)
  })
})
