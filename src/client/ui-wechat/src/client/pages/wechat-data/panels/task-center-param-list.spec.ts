/**
 * 「附加参数（paramList）」纯逻辑单测：默认值 / 草稿读入 / 保存归一化 / 行内校验 /
 * 参数映射保留键 / 行操作 / 值来源选项。
 *
 * 单独成 spec 的原因：`task-center.spec.ts` 已到 M21 的 1000 行上限，而 paramList 的规则
 * 自成一体（`task-center-param-list.ts`），配套 spec 也跟着独立更清晰。
 * 集成路径（`validateTaskDraft` 合并 / 「标记已完善」缺项 / 任务搜索）仍在 `task-center.spec.ts`。
 *
 * 八爪鱼 v1.2.0：descriptor 已删除 `paramMap` 字段（`mapping.mapField` 未声明、`targets: []`），
 * 所有参数都在附加参数里显式添加；另有 `MAP_AND_EXTRAS` 代表仍有内置三参数的通用厂商。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { RpaVendorDescriptor, TaskInfo } from '@deepseek-ai/dsh-wechat-data/types'
import {
  defaultVendorConfig,
  draftFromTask,
  taskSaveInput,
  withVendorDefaults,
  type TaskEditDraft,
} from './task-center.ts'
import {
  ALL_PARAM_SOURCES,
  appendParamEntry,
  maxParamItems,
  newParamEntry,
  normalizeParamListEntries,
  PARAM_SOURCE_LABELS,
  paramEntriesOf,
  paramSourceOptions,
  removeParamEntry,
  resolvedMapKeys,
  updateParamEntry,
  validateParamList,
} from './task-center-param-list.ts'

/** 造一个厂商描述符（只覆盖用到的字段，其余给稳定默认值）。 */
function makeDescriptor(overrides: Partial<RpaVendorDescriptor> = {}): RpaVendorDescriptor {
  return {
    id: 'demo',
    name: '演示厂商',
    vendor: '演示厂商（demo.example）',
    version: '1.0.0',
    summary: '演示用厂商描述符',
    status: 'stable',
    docs: {
      home: 'https://example.com/demo',
      triggerApi: 'https://example.com/demo/trigger',
      lastVerifiedAt: '2026-10-21',
    },
    capabilities: {
      direction: 'outbound',
      synchronous: false,
      completion: 'callback',
      idempotency: 'vendor-key',
      deployment: ['cloud'],
    },
    fields: [],
    auth: { modes: [] },
    mapping: { style: 'object', targets: [] },
    request: { method: 'POST', url: '${config.baseUrl}' },
    response: { okHttpStatus: [200] },
    retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx'] },
    governance: { contentOutbound: true, hosts: [], privacySection: 'G3' },
    risks: ['演示风险'],
    ...overrides,
  }
}

/** 八爪鱼 v1.2.0 描述符：flowId + extraParams（paramList）+ apiKey；没有内置三参数。 */
const BAZHUAYU: RpaVendorDescriptor = makeDescriptor({
  id: 'bazhuayu',
  name: '八爪鱼 RPA',
  summary: '调用八爪鱼启动流程接口',
  fields: [
    {
      key: 'flowId',
      label: '八爪鱼 FlowId',
      type: 'text',
      required: true,
      summary: true,
      ariaLabel: '八爪鱼 FlowId',
      example: '例如 6ad859ccee2df270d53fc6e5',
      pattern: '^[A-Za-z0-9_-]{1,128}$',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: ['room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType', 'taskId', 'recordId', 'fixed', 'template'],
    },
  ],
  auth: {
    modes: [{
      strategy: 'header',
      fields: [
        { key: 'apiKey', label: '八爪鱼 API Key', type: 'password', required: true, secret: true, ariaLabel: '八爪鱼 API Key' },
      ],
    }],
  },
  mapping: { style: 'object', extrasField: 'extraParams', targets: [] },
})

/** 仍有「三个内置参数」+ 附加参数的通用厂商：保留 map 控件与重名校验。 */
const MAP_AND_EXTRAS: RpaVendorDescriptor = makeDescriptor({
  id: 'map-extras',
  name: '映射+附加参数',
  fields: [
    { key: 'paramMap', label: '参数映射', type: 'map', required: false },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: ['room', 'content', 'at', 'keyword', 'fixed', 'template'],
    },
  ],
  mapping: {
    style: 'object',
    mapField: 'paramMap',
    extrasField: 'extraParams',
    targets: [
      { semantic: 'room', defaultKey: 'room_name' },
      { semantic: 'content', defaultKey: 'content' },
      { semantic: 'at', defaultKey: 'at_name' },
    ],
  },
})

/** 造一条任务（只覆盖用到的字段）。 */
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
    triggerMethod: 'webhook',
    triggerConfig: {},
    triggerSecretSet: {},
    triggerVendorVersion: '',
    callbackUrl: '',
    bazhuayuFlowId: '',
    bazhuayuApiKeySet: false,
    status: 'incomplete',
    createdAt: 1,
    updatedAt: 2,
    triggerCount: 0,
    ...overrides,
  }
}

/** 造一份编辑草稿。 */
function makeDraft(overrides: Partial<TaskEditDraft> = {}): TaskEditDraft {
  return {
    name: '任务',
    keywords: ['x'],
    photoLimit: 0,
    mentionMeOnly: false,
    triggerMethod: 'webhook',
    config: {},
    secretInputs: {},
    ...overrides,
  }
}

describe('附加参数（paramList）：值来源 / 默认 / 归一化 / 校验', () => {
  const extrasField = BAZHUAYU.fields.find((field) => field.key === 'extraParams')!

  it('值来源中文名与下拉选项：缺省全量 11 种，paramSources 可收窄', () => {
    expect(ALL_PARAM_SOURCES).toHaveLength(11)
    expect(PARAM_SOURCE_LABELS).toMatchObject({
      room: '会话名', content: '触发文本', at: '触发对象', taskName: '任务名',
      keyword: '触发关键词', triggeredAt: '触发时间', chatType: '会话类型',
      taskId: '任务 id', recordId: '触发记录 id', fixed: '固定值', template: '自定义模板',
    })
    expect(paramSourceOptions(extrasField).map((option) => option.value)).toEqual([...ALL_PARAM_SOURCES])
    expect(paramSourceOptions({ ...extrasField, paramSources: ['room', 'fixed'] }).map((option) => option.label))
      .toEqual(['会话名', '固定值'])
    expect(maxParamItems(extrasField)).toBe(20)
    expect(maxParamItems({ ...extrasField, maxItems: undefined })).toBe(50)
  })

  it('默认配置：paramList 默认空数组；八爪鱼 v1.2.0 不再生成参数映射；通用厂商仍生成三键', () => {
    expect(defaultVendorConfig(BAZHUAYU)).toEqual({ extraParams: [] })
    expect(defaultVendorConfig(MAP_AND_EXTRAS).paramMap).toEqual({ room: 'room_name', content: 'content', at: 'at_name' })
  })

  it('草稿读入保留数组，八爪鱼不再补参数映射；map 厂商仍按 targets 补齐', () => {
    const task = makeTask({
      triggerMethod: 'bazhuayu',
      triggerConfig: {
        flowId: 'f1',
        extraParams: [{ name: 'order_no', source: 'fixed', fixedValue: 'A-001' }],
      },
    })
    const draft = draftFromTask(task, BAZHUAYU)
    expect(draft.config.extraParams).toEqual([{ name: 'order_no', source: 'fixed', fixedValue: 'A-001' }])
    expect(draft.config.paramMap).toBeUndefined()
    const merged = withVendorDefaults(BAZHUAYU, { extraParams: [{ name: 'kw', source: 'keyword' }] })
    expect(merged.extraParams).toEqual([{ name: 'kw', source: 'keyword' }])
    const mapMerged = withVendorDefaults(MAP_AND_EXTRAS, { paramMap: { room: 'group_name' } })
    expect(mapMerged.paramMap).toEqual({ room: 'group_name', content: 'content', at: 'at_name' })
  })

  it('保存归一化：整数组带上、trim 参数名、只保留来源对应字段；八爪鱼不再带 paramMap', () => {
    const task = makeTask({ triggerMethod: 'bazhuayu' })
    const input = taskSaveInput(task, makeDraft({
      triggerMethod: 'bazhuayu',
      config: {
        flowId: 'f1',
        extraParams: [
          { name: ' order_no ', source: 'fixed', fixedValue: ' A-001 ', template: 'ignored' },
          { name: 'kw', source: 'template', template: ' ${record.keyword} ', fixedValue: 'ignored' },
          { name: 'room_src', source: 'room', fixedValue: 'ignored' },
        ],
      },
    }), BAZHUAYU)
    expect(input.triggerConfig?.extraParams).toEqual([
      { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
      { name: 'kw', source: 'template', template: '${record.keyword}' },
      { name: 'room_src', source: 'room' },
    ])
    expect(input.triggerConfig?.paramMap).toBeUndefined()
    const empty = taskSaveInput(task, makeDraft({ triggerMethod: 'bazhuayu', config: { flowId: 'f1' } }), BAZHUAYU)
    expect(empty.triggerConfig?.extraParams).toEqual([])
    expect(empty.triggerConfig?.paramMap).toBeUndefined()
  })

  it('参数名重名只对声明了 mapField 的厂商校验；八爪鱼允许 room_name/content/at_name', () => {
    expect(validateParamList(extrasField, [{ name: 'room_name', source: 'room' }], [])).toEqual({})
    // 八爪鱼没有内置映射：即使配置里残留旧 paramMap，也不再产生保留键。
    expect(resolvedMapKeys(BAZHUAYU, { paramMap: { room: 'group_name', content: 'content', at: 'at_name' } })).toEqual([])
    // 通用 map 厂商：room_name 等三个键仍是保留键（大小写不敏感）。
    const reserved = resolvedMapKeys(MAP_AND_EXTRAS, {})
    expect(reserved).toEqual(['room_name', 'content', 'at_name'])
    expect(validateParamList(extrasField, [{ name: 'room_name', source: 'room' }], reserved)['extraParams:0'])
      .toContain('重名')
    expect(validateParamList(extrasField, [{ name: 'group_name', source: 'room' }], reserved)).toEqual({})
  })

  it('校验：参数名非空/长度/去重/映射键重名/来源/固定值/模板白名单/上限', () => {
    const reserved = ['room_name', 'content', 'at_name']
    expect(validateParamList(extrasField, [], reserved)).toEqual({})
    expect(validateParamList(extrasField, [{ name: '', source: 'room' }], reserved)['extraParams:0']).toContain('缺少参数名')
    expect(validateParamList(extrasField, [{ name: 'a'.repeat(65), source: 'room' }], reserved)['extraParams:0']).toContain('参数名过长')
    expect(validateParamList(extrasField, [{ name: 'a', source: 'room' }, { name: 'A', source: 'room' }], reserved)['extraParams:1']).toContain('参数名重复')
    expect(validateParamList(extrasField, [{ name: 'ROOM_NAME', source: 'fixed', fixedValue: 'x' }], reserved)['extraParams:0'])
      .toContain('重名')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'nope' as never }], reserved)['extraParams:0']).toContain('值来源无效')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'fixed' }], reserved)['extraParams:0']).toContain('固定值')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'fixed', fixedValue: 'v'.repeat(2049) }], reserved)['extraParams:0'])
      .toContain('固定值过长')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'template', template: '' }], reserved)['extraParams:0'])
      .toContain('必须填写模板')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'template', template: '${secret.apiKey}' }], reserved)['extraParams:0'])
      .toContain('record / task')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'template', template: '${record.nope}' }], reserved)['extraParams:0'])
      .toContain('允许清单')
    expect(validateParamList(extrasField, [{ name: 'x', source: 'template', template: '${record.chatName}-${task.name}' }], reserved))
      .toEqual({})
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `p${String(index)}`, source: 'room' as const }))
    const over = validateParamList(extrasField, many, reserved)
    expect(over.extraParams).toContain('最多 20 条')
    expect(Object.keys(over)).not.toContain('extraParams:20')
  })

  it('行操作：追加/更新/删除；达到上限不再追加；默认来源取允许集合第一个', () => {
    const narrowed = { ...extrasField, paramSources: ['fixed', 'room'] as never }
    expect(paramSourceOptions(narrowed).map((option) => option.value)).toEqual(['room', 'fixed'])
    expect(newParamEntry(narrowed)).toEqual({ name: '', source: 'room' })
    let entries = appendParamEntry([], extrasField)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ name: '', source: 'room' })
    entries = updateParamEntry(entries, 0, { name: 'order_no', source: 'fixed', fixedValue: 'A-001' })
    expect(entries).toEqual([{ name: 'order_no', source: 'fixed', fixedValue: 'A-001' }])
    expect(removeParamEntry(entries, 0)).toEqual([])
    const full = Array.from({ length: 20 }, () => newParamEntry(extrasField))
    expect(appendParamEntry(full, extrasField)).toBe(full)
  })

  it('paramEntriesOf 丢弃脏条目；resolvedMapKeys：无 mapField 的厂商返回空，有 mapField 的按配置/默认键', () => {
    expect(paramEntriesOf({
      extraParams: [
        { name: 'ok', source: 'fixed', fixedValue: 'v' },
        { name: 'bad' },
        'nope',
      ] as never,
    }, 'extraParams')).toEqual([{ name: 'ok', source: 'fixed', fixedValue: 'v' }])
    expect(normalizeParamListEntries([
      { name: ' a ', source: 'room', fixedValue: 'ignored' },
      { name: '  ', source: 'room' },
    ])).toEqual([{ name: 'a', source: 'room' }])
    // 八爪鱼 v1.2.0：mapField 未声明 → 没有保留键（旧 paramMap 残留也不参与）。
    expect(resolvedMapKeys(BAZHUAYU, { paramMap: { room: ' group_name ' } })).toEqual([])
    // 通用厂商：用户改过的值优先，缺省回落 defaultKey。
    expect(resolvedMapKeys(MAP_AND_EXTRAS, { paramMap: { room: ' group_name ' } }))
      .toEqual(['group_name', 'content', 'at_name'])
    expect(resolvedMapKeys(MAP_AND_EXTRAS, {})).toEqual(['room_name', 'content', 'at_name'])
  })
})
