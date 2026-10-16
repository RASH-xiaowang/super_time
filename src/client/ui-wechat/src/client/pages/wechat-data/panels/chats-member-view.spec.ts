// @vitest-environment node
/**
 * 群成员那一族的算术守卫（#19 第五刀：`chats-member-view.ts`）。
 *
 * 这一族原先整族零用例：过滤口径、折叠/展开给多少条、「查看更多」该不该出现、
 * 悬浮资料卡翻不翻边，全都只在钩子里写着。其中**有一条是真 bug**：
 * 搜索态的「还有更多」拿"当前上限"当门槛，而那个上限展开后会从 24 变成 200 ⇒
 * 命中 100 位时点「展开更多匹配」之后按钮整颗消失，用户收不回来（非搜索态一直比总数，没这个洞）。
 * `hasMoreMembers` 那组用例钉的就是这个不对称。
 */
import { describe, expect, it } from 'vitest'
import {
  MEMBER_EXPANDED_PAGE, MEMBER_PAGE, filterMembers, hasMoreMembers, memberLimitOf,
  memberMoreLabel, memberQueryOf, profileAnchor, showsAddTile,
} from './chats-member-view.ts'
import type { GroupMember } from '@deepseek-ai/dsh-wechat-data/types'

const m = (username: string, name: string): GroupMember => ({ username, name } as GroupMember)
const MANY = Array.from({ length: 100 }, (_, i) => m(`wxid_${i}`, `成员${i}`))

describe('搜索词与过滤', () => {
  it('搜索词去首尾空白并转小写；纯空白等于「没有查询词」', () => {
    expect(memberQueryOf('  ZhangSan ')).toBe('zhangsan')
    expect(memberQueryOf('   ')).toBe('')
    expect(memberQueryOf('   ') ? 'truthy' : 'falsy').toBe('falsy')
  })

  it('空查询词原样返回（同一个引用 ⇒ 折叠/展开不该重排或复制）', () => {
    const list = [m('a', '甲'), m('b', '乙')]
    expect(filterMembers(list, '')).toBe(list)
  })

  it('昵称与微信号都能命中，且大小写不敏感（两侧都归一）', () => {
    const list = [m('wxid_Zhang', '张三'), m('wxid_Li', '李四')]
    expect(filterMembers(list, 'zhang').map((x) => x.username)).toEqual(['wxid_Zhang'])
    expect(filterMembers(list, '李').map((x) => x.username)).toEqual(['wxid_Li'])
    expect(filterMembers(list, '三').map((x) => x.username)).toEqual(['wxid_Zhang'])
    expect(filterMembers(list, '不存在')).toEqual([])
  })
})

describe('分页与「还有更多」', () => {
  it('折叠 24 条、展开 200 条（展开不是无限：千人群一次画完会卡住整屏）', () => {
    expect(MEMBER_PAGE).toBe(24)
    expect(MEMBER_EXPANDED_PAGE).toBe(200)
    expect(memberLimitOf(false)).toBe(24)
    expect(memberLimitOf(true)).toBe(200)
  })

  /** 回归：旧写法在搜索态比 `filtered.length > memberLimit`，展开后门槛跟着涨到 200 ⇒ 按钮消失、收不回来。 */
  it('「还有更多」只跟折叠门槛比，与展开态无关（否则展开后收不回来）', () => {
    expect(hasMoreMembers(100, 100, '成员')).toBe(true)
    expect(hasMoreMembers(100, 100, '')).toBe(true)
    expect(hasMoreMembers(24, 24, '成员')).toBe(false)
    expect(hasMoreMembers(25, 5, '成员')).toBe(true)
    // 非搜索态看的是**总数**：命中数被折叠不影响按钮该不该在
    expect(hasMoreMembers(24, 300, '')).toBe(true)
  })

  it('按钮文案：展开后一律「收起」；搜索态报命中数，非搜索态报总人数', () => {
    expect(memberMoreLabel(true, 100, 100, '成员')).toBe('收起')
    expect(memberMoreLabel(true, 100, 100, '')).toBe('收起')
    expect(memberMoreLabel(false, 100, 300, '成员')).toBe('展开更多匹配（共 100 位）')
    expect(memberMoreLabel(false, 100, 300, '')).toBe('查看更多（300 人）')
  })

  it('搜索结果里不挂「＋ 添加」方块（只有无查询词时才有）', () => {
    expect(showsAddTile('')).toBe(true)
    expect(showsAddTile('张')).toBe(false)
  })
})

describe('悬浮资料卡落点', () => {
  it('左边放得下就摆左边（rect.left − 232 − 10）', () => {
    expect(profileAnchor({ left: 600, right: 640, top: 200 }, 900).left).toBe(600 - 232 - 10)
  })

  it('左边放不下才翻到右边（rect.right + 10）；边界是「还剩 8px 边距」', () => {
    expect(profileAnchor({ left: 200, right: 240, top: 200 }, 900).left).toBe(250)
    expect(profileAnchor({ left: 250, right: 290, top: 10 }, 900).left).toBe(8)
    expect(profileAnchor({ left: 249, right: 289, top: 10 }, 900).left).toBe(299)
  })

  it('垂直夹在视口里：太靠下按「视口高 − 170」，太靠上按 8px，正常就贴着卡片顶', () => {
    expect(profileAnchor({ left: 600, right: 640, top: 40 }, 900).top).toBe(40)
    expect(profileAnchor({ left: 600, right: 640, top: 895 }, 900).top).toBe(730)
    expect(profileAnchor({ left: 600, right: 640, top: 2 }, 900).top).toBe(8)
  })
})

describe('反例自证', () => {
  it('MANY 这份夹具本身要能撑住上面的判据（夹具退化 ⇒ 全表恒真）', () => {
    expect(MANY).toHaveLength(100)
    expect(filterMembers(MANY, 'wxid_7')).toHaveLength(11)
    expect(filterMembers(MANY, '成员7')).toHaveLength(11)
  })
})
