/**
 * 聊天记录查看器的**接线**守卫（#19 第六刀的另一半）。
 *
 * 这一刀的三件事都容易"搬完静默失效"：
 * ① 抽屉的 DOM 名字 —— `useDialogFocus` 是按 `'[data-st-dialog="chats-chatlog"]'` 这个字符串
 *    找焦点宿主的，改了名字不会有任何编译错误，只会让抽屉打开时焦点还在后面的消息流上（键盘用户）；
 * ② 头像只能交给 `RemoteImg` —— 搬动时"顺手改成 `<img src>` "是最近的一条路，而那是 M23 整套
 *    出网纪律（主机白名单 / 两个开关 / 操作记录 / 本机缓存）的绕过口；
 * ③ `ChatlogFrame` 这个形状收成了一份出处 —— 再抄一遍字面量，加字段时就会漏掉某一处。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from '../../../test-helpers/wiring-kit.ts'
import { readChatsSource } from '../../../test-helpers/chats-source.ts'

const HERE = import.meta.dirname

const VIEW_FINGERPRINTS = [
  'data-st-dialog="chats-chatlog"',
  'chatlogNested',
  'chatlogAvatar',
  '暂无内层消息',
  '解析聊天记录',
] as const

const MOD_MARKS = [
  'if (!frame) return null',
  'depth > 1 &&',
  'onClick={onBack}',
  'onClick={onCloseAll}',
  'e.target === e.currentTarget',
  'records.length === 0 && !resolving',
  'rel="noopener noreferrer"',
  'e.preventDefault()',
  'chatlogBodyOf(r)',
  'chatlogNestedLabel(r)',
  'chatlogFallbackChar(r)',
] as const

describe('聊天记录查看器的接线', () => {
  const view = readStripped(join(HERE, 'chats-view.tsx'))
  const mod = readStripped(join(HERE, 'chats-chatlog-dialog.tsx'))
  const search = readStripped(join(HERE, 'chats-msg-search.tsx'))
  const all = readChatsSource()

  it('两张清单不是空的（被清空 ⇒ 下面两组判据全变恒真）', () => {
    expect(VIEW_FINGERPRINTS.length).toBeGreaterThanOrEqual(5)
    expect(MOD_MARKS.length).toBeGreaterThanOrEqual(11)
  })

  it('哨兵：四份都真读到了东西（读空 ⇒ 上面的「不含」全恒真）', () => {
    expect(view.length, 'chats-view.tsx 没读到').toBeGreaterThan(5000)
    expect(mod.length, 'chats-chatlog-dialog.tsx 没读到').toBeGreaterThan(2000)
    expect(search.length, 'chats-msg-search.tsx 没读到').toBeGreaterThan(1200)
    expect(all.length, 'chats 联合没读到').toBeGreaterThan(20000)
  })

  it('渲染树挂上 <ChatsChatlogView，栈深/栈顶/两条退路都接对了', () => {
    const at = view.indexOf('<ChatsChatlogView')
    expect(at, '渲染树不再挂聊天记录查看器 ⇒ 内层卡片点不动').toBeGreaterThan(-1)
    const blk = view.slice(at, at + 700)
    expect(blk).toContain('depth={chatlogStack.length}')
    expect(blk).toContain('frame={chatlogOpen}')
    expect(blk).toContain('resolving={chatlogResolving}')
    expect(blk).toContain('onCloseAll={() => { setChatlogStack([]) }}')
    expect(blk).toContain('onBack={() => { setChatlogStack(prev => prev.slice(0, -1)) }}')
  })

  it('抽屉的 JSX 不许再长在渲染树里', () => {
    for (const fp of VIEW_FINGERPRINTS) {
      expect(view, `chats-view.tsx 里又出现了 ${fp} —— 那一屏要待在 chats-chatlog-dialog.tsx`).not.toContain(fp)
    }
  })

  it('chats-chatlog-dialog.tsx 十一件齐全（少一件就是搬漏了一支）', () => {
    for (const mark of MOD_MARKS) {
      expect(mod, `chats-chatlog-dialog.tsx 里少了 ${mark}`).toContain(mark)
    }
  })

  /** 焦点宿主按 DOM 名字找：两处字符串必须仍然对得上，否则焦点管理静默失效。 */
  it('抽屉的 `data-st-dialog` 名字与焦点守卫找的那个字符串一字不差', () => {
    expect(search).toContain("useDialogFocus(chatlogStack.length > 0, '[data-st-dialog=\"chats-chatlog\"]')")
    expect(mod).toContain('data-st-dialog="chats-chatlog"')
  })

  /** 出网纪律：这一屏不许自己去要 `<sourceheadurl>`，只能把地址交给 `RemoteImg`。 */
  it('头像只能交给 RemoteImg（不直接挂外链、不自己调代理接口）', () => {
    expect(mod).toContain("import { RemoteImg } from './remote-img.tsx'")
    expect(mod).toContain('<RemoteImg src={r.head')
    expect(mod, '渲染层直接挂 <img> ⇒ 绕过主机白名单与出网开关').not.toContain('<img')
    expect(mod, '组件自己去要代理地址 = 把 RemoteImg 那套缓存与开关整个跳过').not.toContain('apiGetRemoteImageUrl')
  })

  it('`ChatlogFrame` 是这个家族里唯一的栈帧形状（抄第二份字面量就是要漏改一处）', () => {
    expect((all.match(/title: string; records:/g) ?? []).length, '又有人把栈帧形状抄了一遍').toBe(0)
    expect(all).toContain('ChatlogFrame')
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = view + '\nconst leak = <span data-st-dialog="chats-chatlog" />\n'
    const bites = VIEW_FINGERPRINTS.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(view, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})
