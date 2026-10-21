/**
 * 「任务信息」面板的纯逻辑单测（`task-center.ts`）。
 *
 * 这些是被容器、编辑表单、记录弹窗三处共用的口径，任何一条漂移都会表现成
 * 「同一件事在两个地方说法不同」：状态色、回调 URL 校验、选中项失效后的回落、
 * 关键词去重、扫描结果文案。渲染层的接线由 `task-center.wiring.spec.ts` 管。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { TaskInfo, TaskTriggerRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  addKeywords,
  appendTriggerPage,
  callbackHostname,
  callbackStatusMeta,
  callbackUrlLabel,
  capTriggerSearchInput,
  dispatchResultText,
  draftFromTask,
  exceedsBatchLimit,
  filterTasksBySearch,
  filterTriggersByTask,
  triggerTimeText,
  isHttpCallbackUrl,
  lastTriggeredLabel,
  needsTriggerPageBackfill,
  nextExpandedTaskId,
  nextSelectedTaskId,
  normalizeTriggerSearch,
  photoLimitLabel,
  plainText,
  recordImageCountLabel,
  recordSummary,
  retainSelectedIds,
  removeKeyword,
  scanResultText,
  selectAllIds,
  selectionCountText,
  splitKeywordInput,
  taskCounts,
  taskSaveInput,
  taskScopeLabel,
  taskStatusMeta,
  triggerCountLabel,
  triggerPaneTitle,
  TRIGGER_SEARCH_MAX,
  TASK_BATCH_DELETE_MAX,
  toggleSelectedId,
  validateTaskDraft,
  visibleKeywords,
  type TaskEditDraft,
} from './task-center.ts'

/** 造一条任务（只覆盖用到的字段，其余给稳定默认值）。 */
function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 1,
    name: '任务 A',
    chatUsername: 'wxid_chat',
    chatName: '会话名',
    chatType: 'group',
    targetUsername: 'wxid_target',
    targetName: '目标用户',
    keywords: ['报价'],
    photoLimit: 0,
    mentionMeOnly: false,
    callbackUrl: '',
    status: 'incomplete',
    createdAt: 1,
    updatedAt: 2,
    triggerCount: 0,
    ...overrides,
  }
}

/** 造一条触发记录。 */
function makeRecord(overrides: Partial<TaskTriggerRecord> = {}): TaskTriggerRecord {
  return {
    id: 10,
    taskId: 1,
    taskName: '任务 A',
    chatUsername: 'wxid_chat',
    chatName: '会话名',
    targetUsername: 'wxid_target',
    targetName: '目标用户',
    keyword: '报价',
    text: '客户问报价',
    images: [],
    messageLocalId: 100,
    messageSortSeq: 200,
    triggeredAt: new Date(2026, 9, 19, 10, 24, 0).getTime(),
    callbackStatus: 'pending',
    ...overrides,
  }
}

describe('状态文案与色调', () => {
  it('待完善 = amber、已完善 = green，且都有解释', () => {
    expect(taskStatusMeta('incomplete').label).toBe('待完善')
    expect(taskStatusMeta('incomplete').tone).toBe('amber')
    expect(taskStatusMeta('incomplete').hint).toContain('不参与触发')
    expect(taskStatusMeta('ready').label).toBe('已完善')
    expect(taskStatusMeta('ready').tone).toBe('green')
  })

  it('回调状态四种各有独立中文：待投递/已投递/投递失败/未配置', () => {
    expect(callbackStatusMeta('pending').label).toBe('待投递')
    expect(callbackStatusMeta('sent').label).toBe('已投递')
    expect(callbackStatusMeta('failed').label).toBe('投递失败')
    expect(callbackStatusMeta('failed').tone).toBe('red')
    expect(callbackStatusMeta('skipped').label).toBe('未配置')
  })
})

describe('时间与计数文案', () => {
  it('触发时间复用 utils/format.ts 的 fmtDateTimeSec（毫秒→秒适配，非法值给「—」）', () => {
    // `fmtDateTimeSec` 是 `YYYY-MM-DD HH:mm`（秒级入参）；本域存的是毫秒，适配在 triggerTimeText 里。
    expect(triggerTimeText(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04')
    expect(triggerTimeText(0)).toBe('—')
    expect(triggerTimeText(Number.NaN)).toBe('—')
  })

  it('最近触发：有值带时间，无值说「尚未触发」', () => {
    const ts = new Date(2026, 9, 19, 10, 24, 0).getTime()
    expect(lastTriggeredLabel(ts)).toBe('最近触发 2026-10-19 10:24')
    expect(lastTriggeredLabel(undefined)).toBe('尚未触发')
    expect(lastTriggeredLabel(0)).toBe('尚未触发')
  })

  it('次数 / 照片张数 / 记录图片数三处文案口径', () => {
    expect(triggerCountLabel(3)).toBe('3 次触发')
    expect(triggerCountLabel(-1)).toBe('0 次触发')
    expect(photoLimitLabel(0)).toBe('不带图片')
    expect(photoLimitLabel(6)).toBe('6 张图片')
    expect(recordImageCountLabel(0)).toBe('无图片')
    expect(recordImageCountLabel(2)).toBe('图片 2 张')
  })
})

describe('文本摘要与关键词折叠', () => {
  it('多行/连续空白收成一行', () => {
    expect(plainText('  第一行\n\n第二行\t第三行  ')).toBe('第一行 第二行 第三行')
  })

  it('摘要单行截断并补省略号；空文本给「（无文本）」', () => {
    expect(recordSummary('短文本')).toBe('短文本')
    const long = 'a'.repeat(120)
    const summary = recordSummary(long, 10)
    expect(summary).toBe(`${'a'.repeat(10)}…`)
    expect(recordSummary('   ')).toBe('（无文本）')
  })

  it('关键词最多显示 3 个，其余折成隐藏数', () => {
    expect(visibleKeywords(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c'], hidden: 1 })
    expect(visibleKeywords(['a'])).toEqual({ shown: ['a'], hidden: 0 })
    expect(visibleKeywords([], 3)).toEqual({ shown: [], hidden: 0 })
  })
})

describe('Webhook 地址校验与展示', () => {
  it('只认 http/https，且必须能解析出主机名', () => {
    expect(isHttpCallbackUrl('http://example.com/hook')).toBe(true)
    expect(isHttpCallbackUrl(' https://example.com:8443/hook ')).toBe(true)
    expect(isHttpCallbackUrl('ftp://example.com')).toBe(false)
    expect(isHttpCallbackUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpCallbackUrl('example.com')).toBe(false)
    expect(isHttpCallbackUrl('')).toBe(false)
  })

  it('主机名展示（含端口）；空/非法回落「未填 Webhook」', () => {
    expect(callbackHostname('https://example.com:8443/a/b')).toBe('example.com:8443')
    expect(callbackHostname('')).toBe('')
    expect(callbackHostname('not a url')).toBe('')
    expect(callbackUrlLabel('https://example.com/x')).toBe('example.com')
    expect(callbackUrlLabel('')).toBe('未填 Webhook')
  })
})

describe('右栏过滤与选中一致性', () => {
  const records = [makeRecord({ id: 1, taskId: 1 }), makeRecord({ id: 2, taskId: 2 }), makeRecord({ id: 3, taskId: 1 })]

  it('未选中 = 全部记录；选中 = 只留该任务', () => {
    expect(filterTriggersByTask(records, null)).toHaveLength(3)
    expect(filterTriggersByTask(records, 1).map((r) => r.id)).toEqual([1, 3])
    expect(filterTriggersByTask(records, 9)).toEqual([])
  })

  it('选中项只在任务仍存在时有效（任务被删则回 null）', () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })]
    expect(nextSelectedTaskId(tasks, 2)).toBe(2)
    expect(nextSelectedTaskId(tasks, 9)).toBeNull()
    expect(nextSelectedTaskId(tasks, null)).toBeNull()
    expect(nextSelectedTaskId([], 1)).toBeNull()
  })

  it('展开编辑项同口径（删除后收起表单）', () => {
    const tasks = [makeTask({ id: 1 })]
    expect(nextExpandedTaskId(tasks, 1)).toBe(1)
    expect(nextExpandedTaskId(tasks, 2)).toBeNull()
  })
})

describe('左栏任务搜索', () => {
  const searchableTasks: readonly TaskInfo[] = [
    makeTask({ id: 1, name: '客户报价跟进', keywords: ['报价', 'Quote'], chatName: '报价群', targetName: '客户经理' }),
    makeTask({ id: 2, name: '上线通知', keywords: ['Deploy'], chatName: '发布群', targetName: '运维值班' }),
  ]

  it('任务名 / 关键词 / 会话 / 对象均可搜，大小写不敏感', () => {
    expect(filterTasksBySearch(searchableTasks, '报价').map((t) => t.id)).toEqual([1])
    expect(filterTasksBySearch(searchableTasks, 'QUOTE').map((t) => t.id)).toEqual([1])
    expect(filterTasksBySearch(searchableTasks, '发布群').map((t) => t.id)).toEqual([2])
    expect(filterTasksBySearch(searchableTasks, '运维').map((t) => t.id)).toEqual([2])
  })

  it('空搜索保持原数组身份；无命中返回空数组', () => {
    expect(filterTasksBySearch(searchableTasks, '   ')).toBe(searchableTasks)
    expect(filterTasksBySearch(searchableTasks, '不存在的任务')).toEqual([])
  })
})

describe('触发记录搜索词归一', () => {
  it('提交前 trim 并把长度限制到与后端相同的 100 字', () => {
    expect(TRIGGER_SEARCH_MAX).toBe(100)
    expect(normalizeTriggerSearch('  报价  ')).toBe('报价')
    expect(normalizeTriggerSearch(`  ${'a'.repeat(120)}  `)).toBe('a'.repeat(100))
    expect(normalizeTriggerSearch('   ')).toBe('')
  })

  it('输入框保留原文但同样截到上限（不提前 trim）', () => {
    expect(capTriggerSearchInput('  报价 ')).toBe('  报价 ')
    expect(capTriggerSearchInput('b'.repeat(120))).toBe('b'.repeat(100))
  })
})

describe('触发记录分页归并', () => {
  it('下一页按 id 去重，并按 triggeredAt DESC、id DESC 归并', () => {
    const current = [
      makeRecord({ id: 9, triggeredAt: 3000 }),
      makeRecord({ id: 7, triggeredAt: 2000 }),
    ]
    const next = [
      makeRecord({ id: 9, triggeredAt: 3000 }),
      makeRecord({ id: 8, triggeredAt: 2000 }),
      makeRecord({ id: 6, triggeredAt: 1000 }),
    ]
    expect(appendTriggerPage(current, next).map((r) => r.id)).toEqual([9, 8, 7, 6])
  })

  it('空页或整页都是重复项时保留原数组，不制造多余渲染', () => {
    const current = [makeRecord({ id: 9 })]
    expect(appendTriggerPage(current, [])).toBe(current)
    expect(appendTriggerPage(current, [makeRecord({ id: 9 })])).toBe(current)
  })

  it('多页静默刷新需要补齐：只有超过一页时才续取后续页', () => {
    expect(needsTriggerPageBackfill(100, 100)).toBe(false)
    expect(needsTriggerPageBackfill(101, 100)).toBe(true)
    expect(needsTriggerPageBackfill(0, 100)).toBe(false)
    expect(needsTriggerPageBackfill(120, 0)).toBe(false)
  })
})

describe('任务计数', () => {
  it('按状态分组，并把 triggerCount 累加', () => {
    const counts = taskCounts([
      makeTask({ id: 1, status: 'incomplete', triggerCount: 2 }),
      makeTask({ id: 2, status: 'ready', triggerCount: 3 }),
      makeTask({ id: 3, status: 'ready', triggerCount: -4 }),
    ])
    expect(counts).toEqual({ total: 3, incomplete: 1, ready: 2, triggers: 5 })
    expect(taskCounts([])).toEqual({ total: 0, incomplete: 0, ready: 0, triggers: 0 })
  })
})

describe('批量选择与删除上限', () => {
  it('单个切换返回新 Set，不修改原选择；再次切换取消', () => {
    const original = new Set([1, 2])
    const added = toggleSelectedId(original, 3)
    expect([...added]).toEqual([1, 2, 3])
    expect([...original]).toEqual([1, 2])
    expect([...toggleSelectedId(added, 2)]).toEqual([1, 3])
  })

  it('全选只覆盖当前可见 id；刷新后清掉不存在的选择', () => {
    expect([...selectAllIds([4, 2])]).toEqual([4, 2])
    const selected = new Set([1, 2, 3])
    expect([...retainSelectedIds(selected, [2, 3, 4])]).toEqual([2, 3])
    const unchanged = new Set([1])
    expect(retainSelectedIds(unchanged, [1]), '未变化时保留原引用').toBe(unchanged)
    expect(retainSelectedIds(new Set(), [1])).toEqual(new Set())
  })

  it('计数文案与 500 条上限同源；超过上限必须整单拒绝', () => {
    expect(selectionCountText(3)).toBe('已选 3 条')
    expect(selectionCountText(-1)).toBe('已选 0 条')
    expect(TASK_BATCH_DELETE_MAX).toBe(500)
    expect(exceedsBatchLimit(TASK_BATCH_DELETE_MAX)).toBe(false)
    expect(exceedsBatchLimit(TASK_BATCH_DELETE_MAX + 1)).toBe(true)
  })
})

describe('编辑草稿：生成、校验、保存入参', () => {
  it('草稿从任务快照复制关键词（改草稿不会污染任务）', () => {
    const task = makeTask({ keywords: ['报价', '合同'] })
    const draft = draftFromTask(task)
    draft.keywords.push('交付')
    expect(task.keywords).toEqual(['报价', '合同'])
  })

  it('校验：任务名非空 / 关键词至少 1 个 / Webhook 可空但填了必须 http(s)', () => {
    const base: TaskEditDraft = { name: '  ', keywords: [], photoLimit: 0, mentionMeOnly: false, callbackUrl: '' }
    expect(validateTaskDraft(base)).toEqual({ name: '任务名不能为空', keywords: '至少填写 1 个触发关键词' })
    expect(validateTaskDraft({ ...base, name: '任务', keywords: ['x'] })).toEqual({})
    expect(validateTaskDraft({ name: '任务', keywords: ['  '], photoLimit: 0, mentionMeOnly: false, callbackUrl: '' }))
      .toEqual({ keywords: '至少填写 1 个触发关键词' })
    expect(validateTaskDraft({ name: '任务', keywords: ['x'], photoLimit: 0, mentionMeOnly: false, callbackUrl: 'ftp://x' }))
      .toEqual({ callbackUrl: 'Webhook 地址必须是 http/https 链接' })
    expect(validateTaskDraft({ name: '任务', keywords: ['x'], photoLimit: 0, mentionMeOnly: false, callbackUrl: 'https://x.test/h' })).toEqual({})
  })

  it('关键词拆分：逗号（半/全角）、分号、顿号、换行都能分隔，空串丢掉', () => {
    expect(splitKeywordInput('报价,合同，打款;交付；上线、测试\n验收')).toEqual(['报价', '合同', '打款', '交付', '上线', '测试', '验收'])
    expect(splitKeywordInput('  ,,，  ')).toEqual([])
  })

  it('追加关键词去重（大小写不敏感、保留首次写法）；删除同样大小写不敏感', () => {
    const list = addKeywords(['报价'], '合同, 报价, Quote')
    expect(list).toEqual(['报价', '合同', 'Quote'])
    expect(addKeywords(list, 'quote')).toEqual(['报价', '合同', 'Quote'])
    expect(removeKeyword(list, 'QUOTE')).toEqual(['报价', '合同'])
  })

  it('保存入参带 id 与会话/目标字段，关键词/回调 trim，照片数夹回 0–9', () => {
    const task = makeTask({ id: 7, chatUsername: 'wxid_chat', chatName: '群名', targetUsername: 'wxid_t', targetName: '对象' })
    const input = taskSaveInput(task, { name: '  新名  ', keywords: [' 报价 '], photoLimit: 5, mentionMeOnly: true, callbackUrl: ' https://x.test/h ' })
    expect(input.id).toBe(7)
    expect(input.name).toBe('新名')
    expect(input.keywords).toEqual(['报价'])
    expect(input.photoLimit, '2/5 这类原来没有档位的数现在应当原样保留').toBe(5)
    expect(input.mentionMeOnly, '群聊编辑保存必须携带勾选状态').toBe(true)
    expect(input.callbackUrl).toBe('https://x.test/h')
    expect(input.chatUsername).toBe('wxid_chat')
    expect(input.chatName).toBe('群名')
    expect(input.targetUsername).toBe('wxid_t')
    expect(input.targetName).toBe('对象')
    expect(taskSaveInput(task, { name: '任务', keywords: ['x'], photoLimit: 100, mentionMeOnly: false, callbackUrl: '' }).photoLimit).toBe(9)
    expect(taskSaveInput(task, { name: '任务', keywords: ['x'], photoLimit: -3, mentionMeOnly: false, callbackUrl: '' }).photoLimit).toBe(0)
    expect(taskSaveInput(task, { name: '任务', keywords: ['x'], photoLimit: 1.7, mentionMeOnly: false, callbackUrl: '' }).photoLimit).toBe(1)
  })

  it('照片数量校验：0–9 的整数，越界/小数被拦下（输入框之外的兜底）', () => {
    const base: TaskEditDraft = { name: '任务', keywords: ['x'], photoLimit: 3, mentionMeOnly: false, callbackUrl: '' }
    expect(validateTaskDraft(base)).toEqual({})
    expect(validateTaskDraft({ ...base, photoLimit: 0 })).toEqual({})
    expect(validateTaskDraft({ ...base, photoLimit: 9 })).toEqual({})
    expect(validateTaskDraft({ ...base, photoLimit: 10 }).photoLimit).toContain('0–9')
    expect(validateTaskDraft({ ...base, photoLimit: -1 }).photoLimit).toContain('0–9')
    expect(validateTaskDraft({ ...base, photoLimit: 1.5 }).photoLimit).toContain('整数')
  })

  it('草稿保留「仅匹配 @我」；单聊保存时强制归一为 false', () => {
    const groupTask = makeTask({ chatType: 'group', mentionMeOnly: true })
    const groupDraft = draftFromTask(groupTask)
    expect(groupDraft.mentionMeOnly).toBe(true)
    expect(taskSaveInput(groupTask, groupDraft).mentionMeOnly).toBe(true)

    const privateTask = makeTask({ chatType: 'private', targetUsername: 'wxid_chat', targetName: '会话名' })
    expect(taskSaveInput(privateTask, { ...draftFromTask(privateTask), mentionMeOnly: true }).mentionMeOnly).toBe(false)
  })
})

describe('操作结果文案', () => {
  it('扫描成功：检查数 / 新增数 / 投递数一句话说清', () => {
    expect(scanResultText({ ok: true, tasks: 2, scanned: 12, created: 3, dispatched: 1 }))
      .toBe('扫描完成：检查 12 条新消息，新增 3 条触发记录，投递 1 条回调')
    expect(scanResultText({ ok: true, tasks: 2, scanned: 12, created: 0, dispatched: 0, errors: ['任务 A 失败'] }))
      .toContain('（1 个任务失败）')
    expect(scanResultText({ ok: false, tasks: 0, scanned: 0, created: 0, dispatched: 0, error: '未配置回调' }))
      .toBe('扫描失败：未配置回调')
  })

  it('重投结果：成功/失败/非 sent 状态都有文案', () => {
    expect(dispatchResultText({ ok: true, status: 'sent' })).toBe('已重新投递')
    expect(dispatchResultText({ ok: true, status: 'skipped' })).toBe('投递结果：未配置')
    expect(dispatchResultText({ ok: false, status: 'failed', error: 'HTTP 500' })).toBe('重新投递失败：HTTP 500')
  })
})

describe('标题与作用域文案', () => {
  it('未选中 = 「任务触发记录」；选中带任务名', () => {
    expect(triggerPaneTitle(null)).toBe('任务触发记录')
    expect(triggerPaneTitle(makeTask({ name: '客户报价' }))).toBe('任务触发记录 · 客户报价')
  })

  it('会话 → 目标；单聊同名时不重复', () => {
    expect(taskScopeLabel(makeTask({ chatName: '群名', targetName: '对象' }))).toBe('群名 → 对象')
    expect(taskScopeLabel(makeTask({ chatType: 'private', chatName: '张三', targetName: '张三' }))).toBe('张三')
  })
})
