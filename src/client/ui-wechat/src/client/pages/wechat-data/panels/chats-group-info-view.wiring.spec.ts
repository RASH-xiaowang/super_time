/**
 * 群聊信息抽屉的**接线**守卫（#19 第五刀的另一半）。
 *
 * 这一刀搬了两样东西：抽屉的 JSX（`chats-view.tsx` → `chats-group-info-view.tsx`）与
 * 成员那一族的算术（钩子 → `chats-member-view.ts`）。两边都可能出现"搬完没人挂"——
 * 界面不坏、用例还全绿（新模块自己的用例只测模块本身），所以逐条钉装配面。
 * 扫描一律 `readStripped`（先剥注释）：这几个文件的说明文字里写着被钉的那些字样。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsxCall, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname

/** 旧形状：抽屉就地长在渲染树里时的拼法，回到 `chats-view.tsx` 就是没搬干净。 */
const VIEW_FINGERPRINTS = [
  'data-st-dialog="chats-groupinfo"',
  'memberEmptyClear',
  '暂不支持邀请',
  'groupInfoAnnToggle',
  'showsAddTile(',
] as const

/** 搬走之后这些必须在抽屉模块里（少一支就是搬漏了，而不是"两边都没有"）。 */
const MOD_MARKS = [
  'if (!open || !isGroup) return null',
  '!groupInfoErr && groupInfo',
  'aria-disabled="true"',
  'data-clamp={!annExpanded || undefined}',
  'hasMoreMembers(',
  'memberMoreLabel(',
  'onMouseEnter=',
  'onMouseLeave=',
] as const

/** 钩子里不许再留的旧算术（都该改叫 `chats-member-view.ts` 里那五个函数）。 */
const HOOK_OLD_MATH = [
  'memberSearch.trim().toLowerCase()',
  'memberExpanded ? 200 : 24',
  'rect.left - width - 10',
  'window.innerHeight - 170',
] as const

const HOOK_NEW_CALLS = ['memberQueryOf(', 'filterMembers(', 'memberLimitOf(', 'profileAnchor('] as const

describe('群聊信息抽屉的接线', () => {
  const view = readStripped(join(HERE, 'chats-view.tsx'))
  const mod = readStripped(join(HERE, 'chats-group-info-view.tsx'))
  const hook = readStripped(join(HERE, 'chats-group-info.tsx'))
  const thread = readStripped(join(HERE, 'chats-thread.tsx'))

  it('四张清单都不是空的（被清空 ⇒ 下面几组判据全变恒真）', () => {
    expect(VIEW_FINGERPRINTS.length).toBeGreaterThanOrEqual(5)
    expect(MOD_MARKS.length).toBeGreaterThanOrEqual(8)
    expect(HOOK_OLD_MATH.length).toBeGreaterThanOrEqual(4)
    expect(HOOK_NEW_CALLS.length).toBe(4)
  })

  it('哨兵：四份都真读到了东西（读空 ⇒ 上面的「不含」全恒真）', () => {
    expect(view.length, 'chats-view.tsx 没读到').toBeGreaterThan(5000)
    expect(mod.length, 'chats-group-info-view.tsx 没读到').toBeGreaterThan(3000)
    expect(hook.length, 'chats-group-info.tsx 没读到').toBeGreaterThan(1200)
    expect(thread.length, 'chats-thread.tsx 没读到').toBeGreaterThan(3000)
  })

  /**
   * 第九刀之后这一屏改成整袋展开：`isGroup` / `open` 两个**派生**道具仍写在调用点
   * （它们不住在袋里 —— 面板没有同名状态）。找调用点必须用 `jsxCall`：
   * `indexOf('<ChatsGroupInfoView')` 会先撞上袋里那行 `Omit<ChatsGroupInfoViewProps, …>`。
   */
  it('渲染树真的挂上 <ChatsGroupInfoView，并把"是不是群聊"交出去', () => {
    expect(view).toContain("from './chats-group-info-view.tsx'")
    const call = jsxCall(view, 'ChatsGroupInfoView', '群信息调用点')
    expect(call).toContain('{...groupInfo}')
    expect(call).toContain("isGroup={curSession?.type === 'group'}")
    expect(call).toContain('open={groupInfoOpen}')
  })

  it('抽屉的 JSX 不许再长在渲染树里', () => {
    for (const fp of VIEW_FINGERPRINTS) {
      expect(view, `chats-view.tsx 里又出现了 ${fp} —— 那一屏要待在 chats-group-info-view.tsx`).not.toContain(fp)
    }
  })

  it('chats-group-info-view.tsx 八件齐全（少一件就是搬漏了一支）', () => {
    for (const mark of MOD_MARKS) {
      expect(mod, `chats-group-info-view.tsx 里少了 ${mark}`).toContain(mark)
    }
  })

  /**
   * 「＋ 添加」那颗方块的本事全在"它不是什么"：不是 button、没有 onClick、带 aria-disabled。
   * 键盘可达性靠的是它在 DOM 里不是可聚焦元素 ⇒ 只钉文本还不够，得钉它**不在** button 上。
   */
  it('死控件仍然是 div，且成员头像仍然包在懒挂载里', () => {
    expect(mod).not.toMatch(/<button[^>]*aria-disabled="true"/)
    const lazy = mod.indexOf('<LazyMount')
    const avatar = mod.indexOf('<Avatar', lazy)
    expect(lazy, '成员方块不再走 LazyMount ⇒ 展开到 200 人又是一次 200 个头像请求').toBeGreaterThan(-1)
    expect(avatar).toBeGreaterThan(lazy)
    expect(mod.slice(lazy, avatar)).toContain('placeholder=')
  })

  it('钩子改叫纯函数，旧算术一行都不留', () => {
    for (const call of HOOK_NEW_CALLS) {
      expect(hook, `chats-group-info.tsx 不再调用 ${call} —— 那一族又写回钩子了`).toContain(call)
    }
    for (const old of HOOK_OLD_MATH) {
      expect(hook, `钩子里又出现了 ${old} —— 算术要有唯一出处`).not.toContain(old)
    }
  })

  /** 抽屉侧的 `!groupInfoErr` 只是兜底；真正该做的是失败时别把上一个群的快照留着。 */
  it('取群信息失败时把快照一起丢掉（否则错误下面挂着别的群的人）', () => {
    expect(thread).toContain('setGroupInfoErr((e as Error).message); setGroupInfo(null)')
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = view + '\nconst leak = <span aria-disabled="true">暂不支持邀请</span>\n'
    const bites = VIEW_FINGERPRINTS.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(view, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})

describe('实时刷新接线（2026-10-13）', () => {
  const LIVE = readStripped(join(HERE, 'chats-info-live.ts'))
  const HOOK = readStripped(join(HERE, 'chats-group-info.tsx'))
  const PANEL = readStripped(join(HERE, 'Chats.tsx'))

  it('哨兵：三份都真读到了东西（读空 ⇒ 下面的断言全恒真）', () => {
    expect(LIVE.length, 'chats-info-live.ts 没读到').toBeGreaterThan(500)
    expect(HOOK.length, 'chats-group-info.tsx 没读到').toBeGreaterThan(1200)
    expect(PANEL.length, 'Chats.tsx 没读到').toBeGreaterThan(5000)
  })

  it('刷新件订着两条事件：宿主数据事件 + 群信息缓存刷新广播（少一条界面就停在旧数上）', () => {
    expect(LIVE, '必须订阅宿主数据事件').toContain('useWechatDataUpdated(refresh)')
    expect(LIVE, '必须订阅群信息缓存刷新广播（60s TTL 内的旧缓存靠它顶新）').toContain('`${SNAPSHOT_REFRESHED_EVENT}:group`')
    expect(LIVE, '落地前必须过归属闸').toContain('infoRefreshApplies(')
  })

  it('状态袋接上 useGroupInfoLive，面板把当前会话 talker 传进去（漏传会拿错刷新范围）', () => {
    expect(HOOK, '群信息状态袋没有接上 useGroupInfoLive').toContain('useGroupInfoLive({')
    expect(PANEL, '面板没有把当前会话 talker 传进群信息状态袋').toContain('useChatsGroupInfo({ talkerRef: messagesTalkerRef')
  })
})

describe('微信对齐（D0–D2）：行语法、箭头纪律与六区骨架', () => {
  const ROWS_CSS = readStripped(join(HERE, 'chats-rows.module.css'))
  const INFO_CSS = readStripped(join(HERE, 'chats-info.module.css'))
  const CARDS_CSS = readStripped(join(HERE, 'chats-cards.module.css'))
  const SHELL_CSS = readStripped(join(HERE, 'chats-shell.module.css'))
  const CONTACT_CSS = readStripped(join(HERE, 'chats-contact-info.module.css'))
  const CONTACT_VIEW = readStripped(join(HERE, 'chats-contact-info-view.tsx'))
  const ROWS_TSX = readStripped(join(HERE, 'chats-info-rows.tsx'))
  const PROFILE_TSX = readStripped(join(HERE, 'chats-member-profile.tsx'))
  const VIEW = readStripped(join(HERE, 'chats-group-info-view.tsx'))

  it('行语法：标签 12 / 值 14 / 行高 48 / 1px 分隔（官方列表行，D2）', () => {
    expect(INFO_CSS, '标签不是 12px 档（--wx-info-meta）').toMatch(/\.infoLabel \{[^}]*font-size:\s*var\(--wx-info-meta/)
    expect(INFO_CSS, '值不是 14px 档（--wx-info-text）').toMatch(/\.infoValue \{[^}]*font-size:\s*var\(--wx-info-text/)
    expect(INFO_CSS, '行高不在官方 44–56 区间（min-height 48）').toMatch(/\.infoRow \{[^}]*min-height:\s*48px/)
    expect(INFO_CSS, '行分隔不是 1px').toMatch(/\.infoRow \{[^}]*border-top:\s*1px solid/)
  })

  it('成员网格：名单行省略 + 头像 48（D3）', () => {
    expect(ROWS_CSS, '成员名又折行（官方单行省略）').toMatch(/\.memberName \{[^}]*white-space:\s*nowrap/)
    expect(ROWS_CSS, '＋ 占位没跟到 48px（网格会高低不齐）').toMatch(/\.memberAdd \{[^}]*width:\s*var\(--wx-info-avatar/)
    expect(CARDS_CSS, '群抽屉没定义 --wx-info-avatar: 48px').toMatch(/--wx-info-avatar:\s*48px/)
  })

  /**
   * 2026-10-19：区③ 四条只读开关行按用户要求删除，`ReadOnlySwitch` 与 `.infoSwitch*`
   * 一族随之清空（没有消费者还留着一套 ⇒ 下一个人会为了「填满抽屉」把它复活）。
   * 这一格钉的是「不许复活」：组件、CSS 规则、行内开关三处都不许回来。
   */
  it('只读开关一族已随区③ 删除：组件、CSS、开关行三处都不许复活', () => {
    expect(ROWS_TSX, 'ReadOnlySwitch 又回来了（用户已要求删除区③ 四行）').not.toContain('ReadOnlySwitch')
    expect(ROWS_TSX, 'InfoRow 又在接 switchOn ⇒ 又承诺了本应用没有的写回能力').not.toContain('switchOn')
    expect(ROWS_TSX, '行语法三件套变回四件 ⇒ 那份没有消费者的开关又长出来了').not.toContain('三件套')
    expect(INFO_CSS, '.infoSwitch 一族又回来了').not.toMatch(/\.infoSwitch/)
    expect(VIEW, '抽屉里又出现开关行（switchOn 是画开关的唯一入口）').not.toContain('switchOn')
    for (const label of ['消息免打扰', '置顶聊天', '保存到通讯录', '显示群成员昵称']) {
      expect(VIEW, `「${label}」那一行又回来了（用户已要求删除区③）`).not.toContain(`label="${label}"`)
    }
  })

  it('底部动作位（D7 / 2026-10-19 重排）：群抽屉是滚动区外的固定 footer，单聊抽屉仍贴底', () => {
    // 群抽屉：导出槽是 `groupInfo` 的固定 footer，不参与滚动 —— 这才是用户要的「不挡住内容」。
    expect(SHELL_CSS, '群抽屉导出槽没固定为 footer').toMatch(/\.groupExport \{[^}]*flex:\s*0 0 auto/)
    expect(SHELL_CSS, '群抽屉导出槽又用 margin-top:auto 挤在滚动区里 ⇒ 内容一高就会压住资料行').not.toMatch(
      /\.groupExport \{[^}]*margin-top:\s*auto/,
    )
    // 单聊抽屉的空间分配与群抽屉不同，仍是内容内贴底。
    expect(CONTACT_CSS, '单聊抽屉导出槽没贴底').toMatch(/\.exportRow \{[^}]*margin-top:\s*auto/)
  })

  /**
   * 2026-10-19 重排后：滚动区（`.groupInfoBody`）自己吃剩余高度并滚动；内容包
   * （`.groupZones`）**不再** flex-grow / min-height:0 —— 那个旧写法会让内容溢出
   * body，导出槽再高的 z-index 也挡不住它压住成员名。
   */
  it('滚动区只负责滚动，内容包不再抢剩余高度（旧 flex:1 写法会让内容溢出 body）', () => {
    expect(SHELL_CSS, '群抽屉滚动区没有 flex:1 1 auto').toMatch(/\.groupInfoBody \{[^}]*flex:\s*1 1 auto/)
    expect(SHELL_CSS, '群抽屉滚动区没有 min-height:0 ⇒ 压不下去').toMatch(/\.groupInfoBody \{[^}]*min-height:\s*0/)
    expect(SHELL_CSS, '群抽屉滚动区没有可滚动声明').toMatch(/\.groupInfoBody \{[^}]*overflow-y:\s*auto/)
    expect(CARDS_CSS, '内容包又在抢剩余高度 ⇒ 会溢出滚动区盖住 footer').not.toMatch(
      /\.groupZones \{[^}]*flex:\s*1 1 auto/,
    )
    expect(CARDS_CSS, '内容包又写 min-height:0 ⇒ 旧布局复活').not.toMatch(
      /\.groupZones \{[^}]*min-height:\s*0/,
    )
  })

  /**
   * 2026-10-19 用户截图「导出聊天记录压住成员名/查看更多」的回归位。
   *
   * 旧布局把导出槽放在 `.groupInfoBody` **内部**、内容包之后；滚动区里的
   * `margin-top:auto` 只在内容不足一屏时生效，内容一高就变成压在资料行上。
   * 新布局把它移到滚动区**之外**，作为 `groupInfo` 的第三个直接子元素：
   * `header` → `groupInfoBody` → `groupExport`。
   */
  it('群抽屉导出槽在滚动区外、且排在滚动区之后（不能又挪回 body 里）', () => {
    const bodyAt = VIEW.indexOf('cssshell.groupInfoBody')
    const zonesAt = VIEW.indexOf('csscards.groupZones')
    const exportAt = VIEW.indexOf('cssshell.groupExport')
    expect(bodyAt, '抽屉滚动区 groupInfoBody 没找到').toBeGreaterThan(-1)
    expect(zonesAt, '内容包 groupZones 没找到').toBeGreaterThan(-1)
    expect(exportAt, '导出槽 groupExport 没找到').toBeGreaterThan(-1)
    expect(exportAt, '导出槽不在内容包之后').toBeGreaterThan(zonesAt)
    // 滚动区必须以 `\n      </div>` 收尾（组件里的缩进层级）；导出槽必须在这之后。
    const bodyEnd = VIEW.indexOf('\n      </div>', bodyAt)
    expect(bodyEnd, '滚动区的收尾没找到').toBeGreaterThan(bodyAt)
    expect(exportAt, '导出槽又跑回滚动区内部了 ⇒ margin-top:auto 失效、按钮压住内容').toBeGreaterThan(bodyEnd)
    // 抽屉外壳的收尾之前：它是 groupInfo 的直接子元素，不是外壳外的孤儿。
    const shellEnd = VIEW.indexOf('\n    </div>', exportAt)
    expect(shellEnd, '抽屉外壳的收尾没找到').toBeGreaterThan(exportAt)

    // 反例自证：把导出槽块挪回 body 内，上面的位置断言必须红。
    const slotRe = /^[ \t]*<div className=\{cssshell\.groupExport\}>[\s\S]*?^[ \t]*<\/div>\n/m
    const m = slotRe.exec(VIEW)
    expect(m, '这份文件里没有导出槽块（形状变了？）').not.toBeNull()
    const at = m?.index ?? 0
    const slotText = m?.[0] ?? ''
    const without = VIEW.slice(0, at) + VIEW.slice(at + slotText.length)
    const badBodyEnd = without.indexOf('\n      </div>', without.indexOf('cssshell.groupInfoBody'))
    const broken = without.slice(0, badBodyEnd) + slotText + without.slice(badBodyEnd)
    const bExport = broken.indexOf('cssshell.groupExport')
    const bBodyEnd = broken.indexOf('\n      </div>', broken.indexOf('cssshell.groupInfoBody'))
    expect(bExport, '合成违例没有把导出槽挪回滚动区内部 ⇒ 这道闸抓不住坏形状').toBeLessThan(bBodyEnd)
  })

  it('单聊六区：单 tile 网格 + 本机统计分组；profile 横排块退役（D5/D6）', () => {
    expect(CONTACT_VIEW, '单聊顶部不是网格语法的 tile').toContain('cssshell.memberGrid')
    expect(CONTACT_VIEW, '本机统计没有独立分组（又混进资料行）').toContain('SectionTitle')
    expect(CONTACT_VIEW, 'profile 横排块又回来了（D5 复发）').not.toContain('css.profile')
  })

  it('群抽屉补官方区（D1/D4）：群主标 + 成员数；区③ 四条开关行已按用户要求删除', () => {
    expect(VIEW, '群主标没了（官方在群主头像下标群主）').toContain('memberBadge')
    expect(VIEW, '成员数没进网格右下（D10）').toContain('共 {memberTotal} 位成员')
    // 2026-10-19：免打扰 / 置顶 / 存通讯录 / 显成员昵称 四行删除位 —— 不许再长回来。
    // 尤其是"为了填满抽屉"而复活它们：那是 D1 当年的理由，今天已被用户否决。
    for (const label of ['消息免打扰', '置顶聊天', '保存到通讯录', '显示群成员昵称']) {
      expect(VIEW, `「${label}」那一行又回来了（用户已要求删除区③）`).not.toContain(`label="${label}"`)
    }
  })

  it('成员卡：头像居左 + 签名值占满行宽（D9）', () => {
    expect(PROFILE_TSX, '头像又居中了（官方桌面端成员卡是头像居左）').toContain('memberProfileHead')
    expect(PROFILE_TSX, '签名没有占满行宽的栈式行（又挤右列窄槽）').toContain('memberProfileStack')
  })
})
