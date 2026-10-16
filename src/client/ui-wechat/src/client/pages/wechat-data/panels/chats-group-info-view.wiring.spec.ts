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

describe('微信对齐（D0–D2）：行语法、只读纪律与六区骨架', () => {
  const ROWS_CSS = readStripped(join(HERE, 'chats-rows.module.css'))
  const INFO_CSS = readStripped(join(HERE, 'chats-info.module.css'))
  const CARDS_CSS = readStripped(join(HERE, 'chats-cards.module.css'))
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

  it('只读开关是死控件纪律（L13）：role=switch + aria-disabled，且不挂 onChange', () => {
    expect(ROWS_TSX, '开关没有 switch 语义').toContain('role="switch"')
    expect(ROWS_TSX, '只读开关没了 aria-disabled ⇒ 变成假可用控件').toContain('aria-disabled="true"')
    expect(ROWS_TSX, '只读开关挂上了 onChange ⇒ 承诺了本应用没有的写回能力').not.toContain('onChange')
  })

  it('底部动作位贴底（D7）：两抽屉的导出槽都 margin-top:auto', () => {
    expect(CARDS_CSS, '群抽屉导出槽没贴底').toMatch(/\.groupExport \{[^}]*margin-top:\s*auto/)
    expect(CONTACT_CSS, '单聊抽屉导出槽没贴底').toMatch(/\.exportRow \{[^}]*margin-top:\s*auto/)
  })

  it('单聊六区：单 tile 网格 + 本机统计分组；profile 横排块退役（D5/D6）', () => {
    expect(CONTACT_VIEW, '单聊顶部不是网格语法的 tile').toContain('cssshell.memberGrid')
    expect(CONTACT_VIEW, '本机统计没有独立分组（又混进资料行）').toContain('SectionTitle')
    expect(CONTACT_VIEW, 'profile 横排块又回来了（D5 复发）').not.toContain('css.profile')
  })

  it('群抽屉补官方区（D1/D4）：群主标 + 成员数 + 四条只读开关行', () => {
    expect(VIEW, '群主标没了（官方在群主头像下标群主）').toContain('memberBadge')
    expect(VIEW, '成员数没进网格右下（D10）').toContain('共 {memberTotal} 位成员')
    expect(VIEW, '免打扰开关行没了（D1 复发：抽屉又空半屏）').toContain('switchOn={groupInfo.settings.muted}')
    expect(VIEW, '显示群成员昵称开关行没了').toContain('switchOn={groupInfo.settings.showMemberNickname}')
  })

  it('成员卡：头像居左 + 签名值占满行宽（D9）', () => {
    expect(PROFILE_TSX, '头像又居中了（官方桌面端成员卡是头像居左）').toContain('memberProfileHead')
    expect(PROFILE_TSX, '签名没有占满行宽的栈式行（又挤右列窄槽）').toContain('memberProfileStack')
  })
})
