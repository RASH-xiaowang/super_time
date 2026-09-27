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
