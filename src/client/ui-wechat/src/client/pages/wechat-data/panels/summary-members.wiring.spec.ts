/**
 * 定时任务表单的「关注成员」守卫。
 *
 * ## 背景（2026-10-17 用户报障）
 *
 * 用户截图：选了群「智能回复机器人·ai-3群」，但「关注成员」显示
 * 「未读取到群成员」「已关注 0 位」—— 一个成员都选不了。
 *
 * ## 根因
 *
 * 前端用 `c.category === 'member' && c.groupUsername === group` 筛群成员。
 * 但 `category` 是**联系人类型**（friend / group / official / member…），
 * 而 `categoryOf()` 里 `localType === 1` 一律判成 `friend` ——
 * **加过好友的群成员全被归为 friend**，筛 member 时一个都拿不到。
 *
 * 实测本机（`contact.db`）：70 个群 / 2664 条成员关系，其中
 * **7 个群的成员全是好友**（`lt=1`），这些群在界面上永远选不到成员。
 *
 * ## 正确判据
 *
 * `groupUsername`（后端从 `chatroom_member` 表填的归属）与 `category` **正交**：
 * 好友也可以是群成员。所以只按 `groupUsername` 筛。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const drawer = readFileSync(join(HERE, 'SummaryTaskDrawer.tsx'), 'utf8')
const contacts = readFileSync(
  join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'contacts.ts'),
  'utf8',
)

describe('定时任务：关注成员必须能读到', () => {
  it('筛群成员用 groupUsernames（全部所属群），不许用 category 或单个 groupUsername', () => {
    // ⚠️ 必须剥注释再查：本文件的注释里写了「不许用 category === 'member'」，
    // 不剥就是假阳性（第一版就栽了）。
    const code = drawer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // 正向：按 groupUsernames 筛（一个人可以在多个群）
    expect(code, '没有按 groupUsernames 筛群成员').toMatch(/c\.groupUsernames\?\.includes\(groupUsername\)/)
    // 反例 ①：不许用 category 筛（好友/企业微信成员会被漏掉）
    expect(code, "又用 category === 'member' 筛群成员了 ⇒ 加过好友的成员会全部消失")
      .not.toMatch(/category === 'member'/)
    // 反例 ②：不许只用单个 groupUsername（多群成员会被覆盖）
    expect(code, '只用 groupUsername 筛 ⇒ 多群成员只在其中一个群可见')
      .not.toMatch(/\.filter\(c => c\.groupUsername === groupUsername\)/)
  })

  it('后端 categoryOf 确实会把好友判成 friend（这条 bug 的前提，别被"修"掉）', () => {
    // 如果哪天 categoryOf 改了语义，上面那条反例的注释就过期了 —— 这里钉住前提。
    expect(contacts, 'categoryOf 的 localType===1 → friend 分支没了，请复核本守卫的前提')
      .toMatch(/if \(localType === 1\) return 'friend'/)
  })

  it('后端 memberRooms 必须是「一对多」（一个人可以在多个群）', () => {
    // 反例：`Map<number, number>` 会让后写入的群覆盖前面的
    expect(contacts, 'memberRooms 又退回一对一了 ⇒ 多群成员会被覆盖')
      .toMatch(/const memberRooms = new Map<number, number\[\]>\(\)/)
    expect(contacts, 'memberRooms 没有 push 多个群').toMatch(/list\.push\(rid\)/)
  })

  it('groupUsername 与 groupUsernames 都要填（前者兼容旧字段，后者是完整列表）', () => {
    expect(contacts).toMatch(/contact\.groupUsername = names\[0\]/)
    expect(contacts).toMatch(/contact\.groupUsernames = names/)
  })

  it('groupUsername 不再限定 category === member（好友/企业微信成员也要有归属）', () => {
    // 反例：`else if (category === 'member')` 会让 friend / enterprise 拿不到归属
    expect(contacts, 'groupUsername 又被限定在 member 类别里了')
      .not.toMatch(/else if \(category === 'member'\) \{/)
  })

  it('成员列表为空时给出可操作的提示（不是干巴巴一句"未读取到"）', () => {
    expect(drawer).toContain('没有读到成员数据')
    // 提示要说明"这个群可能真的没有成员数据"，而不是让用户以为程序坏了
    expect(drawer, '缺少"为什么可能为空"的说明').toMatch(/这个群|重新选择群聊/)
  })
})
