// @vitest-environment node
/**
 * 「新建任务」纯逻辑（`task-create.ts`）的行为守卫（2026-10-19）。
 *
 * 这一族规则**画错了不会报错**：关键词重复了用户以为配了两条、第 21 个被静默吞掉、
 * 群聊没选目标用户却提交成功、照片档位被写成 3 以外的数——界面都不报错，只有单测能钉住。
 * 所以这里逐条钉：切分/去重/上限/长度、校验顺序、默认任务名、单聊目标回填、成员截断。
 */
import { describe, expect, it } from 'vitest'
import type { GroupMember } from '@deepseek-ai/dsh-wechat-data/types'
import {
  DEFAULT_PHOTO_LIMIT, GROUP_TARGET_REQUIRED, KEYWORD_MAX_COUNT, KEYWORD_MAX_LEN, MEMBER_RENDER_LIMIT,
  PHOTO_LIMIT_MAX, PHOTO_LIMIT_MIN, TASK_NAME_MAX_LEN, addKeywordBatch, buildTaskInfoInput,
  buildTaskInfoInputs, chatTypeLabel, clampPhotoLimit, defaultTaskName, initialTaskCreateForm,
  isValidPhotoLimit, parseKeywordInput, photoHint, pickMembers, removeKeyword, removeTaskTarget,
  toggleTaskTarget, validateTaskCreate, type TaskCreateSession, type TaskCreateTarget,
} from './task-create.ts'

const PRIVATE: TaskCreateSession = { username: 'wxid_a', displayName: '张三', type: 'private' }
const GROUP: TaskCreateSession = { username: '123@chatroom', displayName: '项目群', type: 'group' }

describe('关键词切分 / 添加 / 去重 / 删除', () => {
  it('按中英文逗号与换行切分，去首尾空白，丢空片段', () => {
    expect(parseKeywordInput('报价,合同，付款\n\n 回款 ')).toEqual(['报价', '合同', '付款', '回款'])
    expect(parseKeywordInput('  ')).toEqual([])
    expect(parseKeywordInput('只有一个')).toEqual(['只有一个'])
  })

  it('一次输入多个时按顺序全部加入，重复项（不区分大小写）只留第一个', () => {
    const r = addKeywordBatch([], 'WiFi, wifi，wIfI，报价')
    expect(r.ok).toBe(true)
    expect(r.keywords).toEqual(['WiFi', '报价'])
    expect(r.added).toBe(2)
  })

  it('与已有列表去重时也保留用户原来那条的大小写', () => {
    const r = addKeywordBatch(['WiFi'], 'wifi,合同')
    expect(r.ok).toBe(true)
    expect(r.keywords).toEqual(['WiFi', '合同'])
    expect(r.added).toBe(1)
  })

  it('空输入什么都不做（提交时残留草稿为空不等于错误）', () => {
    const r = addKeywordBatch(['报价'], ' ,  ')
    expect(r).toEqual({ ok: true, keywords: ['报价'], added: 0 })
  })

  it(`最多 ${KEYWORD_MAX_COUNT} 个：到顶后再加整批拒绝，原列表不动`, () => {
    const full = Array.from({ length: KEYWORD_MAX_COUNT }, (_, i) => `k${String(i)}`)
    expect(addKeywordBatch(full, 'k0').ok, '重复项不算新增，不该报"超上限"').toBe(true)
    const over = addKeywordBatch(full, 'new')
    expect(over.ok).toBe(false)
    expect(over.error).toContain(String(KEYWORD_MAX_COUNT))
    expect(over.keywords).toEqual(full)
    // 一次粘 21 个也必须整批拒绝（不做半应用）
    const batch = Array.from({ length: KEYWORD_MAX_COUNT + 1 }, (_, i) => `b${String(i)}`).join(',')
    const bulk = addKeywordBatch([], batch)
    expect(bulk.ok).toBe(false)
    expect(bulk.keywords).toEqual([])
  })

  it(`单条 ≤${KEYWORD_MAX_LEN} 字：正好 ${KEYWORD_MAX_LEN} 收，多一个字整批拒绝`, () => {
    const ok = addKeywordBatch([], 'x'.repeat(KEYWORD_MAX_LEN))
    expect(ok.ok).toBe(true)
    expect(ok.keywords).toEqual(['x'.repeat(KEYWORD_MAX_LEN)])
    const tooLong = 'y'.repeat(KEYWORD_MAX_LEN + 1)
    const bad = addKeywordBatch(['报价'], `合同,${tooLong}`)
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain(String(KEYWORD_MAX_LEN))
    expect(bad.keywords, '失败时必须整批不落地').toEqual(['报价'])
  })

  it('删除按位置且不改原数组', () => {
    const list = ['a', 'b', 'c']
    expect(removeKeyword(list, 1)).toEqual(['a', 'c'])
    expect(list).toEqual(['a', 'b', 'c'])
    expect(removeKeyword(list, -1)).toEqual(['a', 'b', 'c'])
    expect(removeKeyword(list, 9)).toEqual(['a', 'b', 'c'])
  })
})

describe('照片数量（2026-10-19：档位 → 可输入）', () => {
  it('默认 3 张；区间是 0–9', () => {
    expect(PHOTO_LIMIT_MIN).toBe(0)
    expect(PHOTO_LIMIT_MAX).toBe(9)
    expect(DEFAULT_PHOTO_LIMIT).toBe(3)
    expect(initialTaskCreateForm().photoLimit).toBe(3)
  })

  it('合法值：0–9 的整数（2/4/5 这些原来没有档位的值现在也可用）', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(isValidPhotoLimit(n)).toBe(true)
    for (const n of [-1, 10, 24, 1.5, Number.NaN]) expect(isValidPhotoLimit(n)).toBe(false)
  })

  it('输入夹取：越界/小数/NaN 都收进 0–9，不把表单卡死', () => {
    expect(clampPhotoLimit(-3)).toBe(0)
    expect(clampPhotoLimit(100)).toBe(9)
    expect(clampPhotoLimit(1.9)).toBe(1)
    expect(clampPhotoLimit(Number.NaN)).toBe(0)
    expect(clampPhotoLimit(5)).toBe(5)
  })

  it('文案说清「不带图片」与「最近 N 张」', () => {
    expect(photoHint(0)).toContain('不携带图片')
    expect(photoHint(5)).toBe('触发时取该对象最近 5 张图片')
    expect(photoHint(9)).toBe('触发时取该对象最近 9 张图片')
  })
})

describe('提交前校验', () => {
  const base = { chatType: 'private' as const, targetCount: 1, keywords: ['报价'], photoLimit: 3 }

  it('单聊不需要目标用户；合法表单没有错误', () => {
    expect(validateTaskCreate(base)).toBeNull()
  })

  it('群聊未选目标用户 ⇒ 第一条就报错（不能"先校验关键词"把它遮住）', () => {
    expect(validateTaskCreate({ ...base, chatType: 'group', targetCount: 0, keywords: [] })).toBe(GROUP_TARGET_REQUIRED)
    expect(validateTaskCreate({ ...base, chatType: 'group', targetCount: 2 })).toBeNull()
  })

  it('关键词为空 / 超数量 / 超长都能被拦下', () => {
    expect(validateTaskCreate({ ...base, keywords: [] })).toContain('至少填写 1 个')
    expect(validateTaskCreate({ ...base, keywords: Array.from({ length: KEYWORD_MAX_COUNT + 1 }, (_, i) => `k${String(i)}`) })).toContain(String(KEYWORD_MAX_COUNT))
    expect(validateTaskCreate({ ...base, keywords: ['x'.repeat(KEYWORD_MAX_LEN + 1)] })).toContain(String(KEYWORD_MAX_LEN))
  })

  it('照片数量越界 / 非整数就拒绝（防前端传 100 张或 1.5 张）', () => {
    expect(validateTaskCreate({ ...base, photoLimit: 100 })).toContain('0–9')
    expect(validateTaskCreate({ ...base, photoLimit: -1 })).toContain('0–9')
    expect(validateTaskCreate({ ...base, photoLimit: 1.5 })).toContain('整数')
  })
})

describe('任务名与写接口入参', () => {
  it('默认任务名 = 会话 · 目标（群聊时）· 首个关键词', () => {
    expect(defaultTaskName({ chatName: '张三', chatType: 'private', keywords: ['报价'] })).toBe('张三 · 报价')
    expect(defaultTaskName({ chatName: '项目群', chatType: 'group', targetName: '李四', keywords: ['合同'] }))
      .toBe('项目群 · 李四 · 合同')
    expect(defaultTaskName({ chatName: '项目群', chatType: 'private', targetName: '李四', keywords: [] }))
      .toBe('项目群 触发任务')
    expect(defaultTaskName({ chatName: '', chatType: 'private', keywords: [] })).toContain('未命名会话')
  })

  it('单聊把触发对象回填成会话对象本身；状态固定 incomplete', () => {
    const input = buildTaskInfoInput({ chat: PRIVATE, target: null, keywords: ['报价'], photoLimit: 3 })
    expect(input).toMatchObject({
      chatUsername: 'wxid_a',
      chatName: '张三',
      chatType: 'private',
      targetUsername: 'wxid_a',
      targetName: '张三',
      keywords: ['报价'],
      photoLimit: 3,
      status: 'incomplete',
    })
    expect(input.name).toBe('张三 · 报价')
  })

  it('群聊用所选成员当触发对象；用户填了任务名就用用户的', () => {
    const input = buildTaskInfoInput({
      chat: GROUP,
      target: { username: 'wxid_b', name: '李四' },
      keywords: ['合同'],
      photoLimit: 6,
      name: '  项目回款  ',
    })
    expect(input.targetUsername).toBe('wxid_b')
    expect(input.targetName).toBe('李四')
    expect(input.photoLimit).toBe(6)
    expect(input.name).toBe('项目回款')
  })

  it('批量构建：每个成员一条独立任务，目标字段不串线', () => {
    const targets: TaskCreateTarget[] = [
      { username: 'wxid_li', name: '李四', enterpriseName: '甲公司' },
      { username: 'wxid_wang', name: '王五' },
    ]
    const inputs = buildTaskInfoInputs({
      chat: GROUP,
      targets,
      keywords: ['合同'],
      photoLimit: 3,
      mentionMeOnly: true,
    })
    expect(inputs).toHaveLength(2)
    expect(inputs.map((item) => item.targetUsername)).toEqual(['wxid_li', 'wxid_wang'])
    expect(inputs.map((item) => item.targetName)).toEqual(['李四', '王五'])
    expect(inputs.map((item) => item.name)).toEqual(['项目群 · 李四 · 合同', '项目群 · 王五 · 合同'])
    for (const item of inputs) {
      expect(item.chatUsername).toBe(GROUP.username)
      expect(item.keywords).toEqual(['合同'])
      expect(item.photoLimit).toBe(3)
      expect(item.mentionMeOnly).toBe(true)
      expect(item.status).toBe('incomplete')
    }
  })

  it('批量自定义任务名会追加成员名，且仍受任务名长度上限约束', () => {
    const longName = '回款任务'.repeat(20)
    const inputs = buildTaskInfoInputs({
      chat: GROUP,
      targets: [
        { username: 'wxid_li', name: '李四' },
        { username: 'wxid_wang', name: '王五' },
      ],
      keywords: ['回款'],
      photoLimit: 0,
      name: longName,
    })
    expect(inputs[0]?.name).toContain('李四')
    expect(inputs[1]?.name).toContain('王五')
    expect(inputs[0]?.name).not.toBe(inputs[1]?.name)
    for (const item of inputs) expect((item.name ?? '').length).toBeLessThanOrEqual(TASK_NAME_MAX_LEN)
  })

  it('批量构建会去重空/重复成员；单聊始终只有一条并回填会话对象', () => {
    const groupInputs = buildTaskInfoInputs({
      chat: GROUP,
      targets: [
        { username: 'wxid_li', name: '李四' },
        { username: 'wxid_li', name: '重复李四' },
        { username: '  ', name: '空账号' },
      ],
      keywords: ['合同'],
      photoLimit: 0,
    })
    expect(groupInputs).toHaveLength(1)
    expect(groupInputs[0]?.targetName).toBe('李四')

    const privateInputs = buildTaskInfoInputs({
      chat: PRIVATE,
      targets: [{ username: 'ignored', name: '不应使用' }],
      keywords: ['报价'],
      photoLimit: 0,
    })
    expect(privateInputs).toHaveLength(1)
    expect(privateInputs[0]?.targetUsername).toBe(PRIVATE.username)
    expect(privateInputs[0]?.targetName).toBe(PRIVATE.displayName)
  })

  it('群聊勾选「仅匹配@我的文本」时提交 true；未勾选/单聊始终为 false', () => {
    const group = buildTaskInfoInput({
      chat: GROUP,
      target: { username: 'wxid_b', name: '李四' },
      keywords: ['合同'],
      photoLimit: 0,
      mentionMeOnly: true,
    })
    expect(group.mentionMeOnly).toBe(true)
    expect(buildTaskInfoInput({
      chat: GROUP,
      target: { username: 'wxid_b', name: '李四' },
      keywords: ['合同'],
      photoLimit: 0,
    }).mentionMeOnly).toBe(false)

    const privateInput = buildTaskInfoInput({
      chat: PRIVATE,
      target: null,
      keywords: ['合同'],
      photoLimit: 0,
      mentionMeOnly: true,
    })
    expect(privateInput.mentionMeOnly, '单聊没有群 @ 列表，不能保存 true').toBe(false)
  })

  it('关键词是拷贝：调用方之后改原数组不会污染入参', () => {
    const keywords = ['报价']
    const input = buildTaskInfoInput({ chat: PRIVATE, keywords, photoLimit: 0 })
    keywords.push('合同')
    expect(input.keywords).toEqual(['报价'])
  })

  it('会话类型标签只有两种', () => {
    expect(chatTypeLabel('private')).toBe('单聊')
    expect(chatTypeLabel('group')).toBe('群聊')
  })
})

describe('群成员搜索与截断', () => {
  const member = (name: string, username: string): GroupMember => ({ name, username })
  const small = [member('张三', 'wxid_zhang'), member('李四', 'wxid_li'), member('Alice', 'wxid_alice')]

  it('昵称与微信号都参与匹配，大小写不敏感', () => {
    expect(pickMembers(small, 'zhang').items.map((m) => m.username)).toEqual(['wxid_zhang'])
    expect(pickMembers(small, 'ALICE').items.map((m) => m.name)).toEqual(['Alice'])
    expect(pickMembers(small, '李').items.map((m) => m.name)).toEqual(['李四'])
  })

  it('无搜索词时原样返回（引用不复制也行，内容一致即可）', () => {
    const r = pickMembers(small, '')
    expect(r.items.map((m) => m.name)).toEqual(['张三', '李四', 'Alice'])
    expect(r.matched).toBe(3)
    expect(r.hidden).toBe(0)
    expect(r.needQuery).toBe(false)
  })

  it(`一次最多画 ${MEMBER_RENDER_LIMIT} 行，多出来的计入 hidden`, () => {
    const many = Array.from({ length: 120 }, (_, i) => member(`成员${String(i)}`, `wxid_${String(i)}`))
    const r = pickMembers(many, '')
    expect(r.items).toHaveLength(MEMBER_RENDER_LIMIT)
    expect(r.matched).toBe(120)
    expect(r.hidden).toBe(120 - MEMBER_RENDER_LIMIT)
    expect(r.needQuery, '120 人还没到"必须搜索"的门槛').toBe(false)
    // 搜索后仍然只画前 50 行
    const searched = pickMembers(many, '成员1')
    expect(searched.items.length).toBeLessThanOrEqual(MEMBER_RENDER_LIMIT)
  })

  it('超过 200 人且没搜索词 ⇒ 提示先搜索；一输入搜索词就撤掉提示', () => {
    const huge = Array.from({ length: 201 }, (_, i) => member(`成员${String(i)}`, `wxid_${String(i)}`))
    expect(pickMembers(huge, '').needQuery).toBe(true)
    expect(pickMembers(huge, '成员').needQuery).toBe(false)
    expect(pickMembers(huge, '   ').needQuery, '空白搜索词按"没搜"处理').toBe(true)
  })
})

describe('多选触发对象', () => {
  const li: TaskCreateTarget = { username: 'wxid_li', name: '李四', enterpriseName: '甲公司' }
  const wang: TaskCreateTarget = { username: 'wxid_wang', name: '王五' }

  it('按点击顺序添加，重复点击取消，不改原数组', () => {
    const first = toggleTaskTarget([], li)
    expect(first).toEqual([li])
    const both = toggleTaskTarget(first, wang)
    expect(both.map((item) => item.username)).toEqual(['wxid_li', 'wxid_wang'])
    expect(toggleTaskTarget(both, li).map((item) => item.username)).toEqual(['wxid_wang'])
    expect(first).toEqual([li])
  })

  it('空 username 不进入选择；移除按 username 精确处理', () => {
    expect(toggleTaskTarget([], { username: '  ', name: '脏数据' })).toEqual([])
    expect(removeTaskTarget([li, wang], 'wxid_li')).toEqual([wang])
    expect(removeTaskTarget([li, wang], 'missing')).toEqual([li, wang])
  })
})

describe('表单初值', () => {
  it('空关键词、默认 3 张、空任务名、未选目标数组', () => {
    expect(initialTaskCreateForm()).toEqual({
      keywords: [],
      keywordDraft: '',
      photoLimit: 3,
      mentionMeOnly: false,
      name: '',
      targets: [],
    })
  })
})
