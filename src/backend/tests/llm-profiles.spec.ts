/**
 * 「已保存的模型配置」（llm.json 的 `profiles`）：懒迁移、成套切换、增删、与顶层字段的关系。
 *
 * 为什么值得单独测：这条链路的**核心不变量是「成套切换」**——
 * provider / model / apiUrl / apiKey / embeddingModel 必须一起换。只要漏掉其中一项
 * （历史上「套用厂商模板只改前三个、Key 保留旧值」就是这么写的），用户会得到
 * 「A 家的地址 + B 家的 Key」这种组合，下一次提问必然 401，而界面上一点提示都没有。
 * 另外三条容易写坏的：① 顶层扁平字段必须始终等于「当前生效值」（老读者与 `loadLlmConfig`
 * 只认它，回退到旧版本也不能坏）；② 删掉使用中的那条要自动落到另一条上；
 * ③ 至少保留一条，否则切换条与「已配置」徽标会互相矛盾。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import {
  activateLlmProfile,
  configure,
  deleteLlmProfile,
  loadLlmConfig,
  loadLlmStore,
  saveLlmConfig,
  upsertLlmProfile,
} from '../wechat-paths.js'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 每个用例一个独立 userData，并**先写占位 llm.json** 再 configure()
 *  （开发态的 legacy 迁移会把仓库 wechat/llm.json 复制进来，污染断言）。 */
function initState(): { file: string; read: () => Record<string, unknown>; write: (o: unknown) => void } {
  const root = mkdtempSync(join(tmpdir(), 'llm-profiles-'))
  scratch.push(root)
  mkdirSync(join(root, 'wechat'), { recursive: true })
  const file = join(root, 'wechat', 'llm.json')
  writeFileSync(file, '{}', 'utf8')
  writeFileSync(join(root, 'wechat', 'config.json'), '{}', 'utf8')
  configure({ userDataPath: root })
  return {
    file,
    read: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>,
    write: (o) => { writeFileSync(file, JSON.stringify(o, null, 2), 'utf8') },
  }
}

const DEEPSEEK = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-deepseek', apiUrl: 'https://api.deepseek.com/v1' }
const MIMO = { provider: 'mimo', model: 'mimo-v2.5', apiKey: 'sk-mimo', apiUrl: 'https://token-plan-cn.xiaomimimo.com/v1' }

describe('模型配置集：首次保存与懒迁移', () => {
  it('首次保存后出现一条配置，并被标为「使用中」', () => {
    const { read } = initState()
    saveLlmConfig(DEEPSEEK)
    const store = loadLlmStore()
    expect(store.profiles).toHaveLength(1)
    expect(store.activeProfileId).toBe(store.profiles[0]!.id)
    expect(store.profiles[0]!.model).toBe('deepseek-chat')
    expect(store.profiles[0]!.apiKey).toBe('sk-deepseek')
    // 顶层扁平字段仍在（loadLlmConfig / 旧版本只认它）
    expect(read()['model']).toBe('deepseek-chat')
    expect(loadLlmConfig().apiKey).toBe('sk-deepseek')
  })

  it('老文件（只有扁平字段、没有 profiles）读取时懒迁移出一条，id 稳定为 p1', () => {
    const { write } = initState()
    write({ ...DEEPSEEK, apiPath: '/chat/completions', embedPath: '/embeddings', timeoutMs: 120000 })
    const store = loadLlmStore()
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0]!.id).toBe('p1')
    expect(store.activeProfileId).toBe('p1')
    expect(store.profiles[0]!.apiUrl).toBe(DEEPSEEK.apiUrl)
  })

  it('什么都没配时不凭空造配置（避免「徽标说已配置」）', () => {
    initState()
    const store = loadLlmStore()
    expect(store.profiles).toEqual([])
    expect(store.activeProfileId).toBe('')
  })

  it('懒迁移出来的那条会在下次保存时落盘', () => {
    const { write, read } = initState()
    write({ ...DEEPSEEK })
    saveLlmConfig({ ...DEEPSEEK, model: 'deepseek-reasoner' })
    const raw = read() as { profiles?: Array<{ model: string }>; activeProfileId?: string }
    expect(raw.profiles).toHaveLength(1)
    expect(raw.profiles![0]!.model).toBe('deepseek-reasoner')
    expect(raw.activeProfileId).toBe('p1')
  })
})

describe('模型配置集：三个角色（语言 / 嵌入 / 重排序）成套', () => {
  // 这一组守的是 `docs/KB-MODEL-CONFIG.md` 的 V5：角色字段一旦没进 `LLM_PROFILE_FIELDS`，
  // 切换 profile 就会留下上一条的值 —— 那正是这套功能当初要消灭的「A 家地址 + B 家 Key」，
  // 只是换到了嵌入/精排这两个新角色上，而且更难发现（401 会变成「静默用错模型」）。
  const SILICON = {
    ...MIMO,
    embeddingModel: 'BAAI/bge-m3',
    embeddingApiUrl: 'https://api.siliconflow.cn/v1',
    embeddingApiKey: 'sk-embed-silicon',
    rerankModel: 'BAAI/bge-reranker-v2',
    rerankApiUrl: 'https://api.siliconflow.cn/v1',
    rerankApiKey: 'sk-rerank-silicon',
    rerankTimeoutMs: 15000,
  }

  it('一条 profile 能带全套三角色字段，保存后读回来一个不少', () => {
    initState()
    saveLlmConfig(SILICON)
    const cfg = loadLlmConfig()
    expect(cfg.embeddingModel).toBe('BAAI/bge-m3')
    expect(cfg.embeddingApiKey).toBe('sk-embed-silicon')
    expect(cfg.rerankModel).toBe('BAAI/bge-reranker-v2')
    expect(cfg.rerankApiKey).toBe('sk-rerank-silicon')
    expect(cfg.rerankTimeoutMs).toBe(15000)
    // 没填 path 时按默认，而不是留成空串（读取端假定它有值）
    expect(cfg.rerankPath).toBe('/rerank')
  })

  it('切到一条不含精排字段的旧 profile ⇒ 上一条的 rerank 必须被清掉，而不是留着', () => {
    initState()
    saveLlmConfig(SILICON)
    const siliconId = loadLlmStore().profiles[0]!.id
    const plainId = upsertLlmProfile({ config: DEEPSEEK }).activeProfileId
    expect(plainId).not.toBe(siliconId)

    const back = activateLlmProfile(plainId)
    expect(back.config.rerankModel).toBe('')
    expect(back.config.rerankApiKey).toBe('')
    expect(back.config.rerankApiUrl).toBe('')
    expect(back.config.embeddingModel).toBe('')
    // 嵌入的独立 Key 也要跟着清 —— 漏掉它就等于「用 A 家的向量端点 + B 家的 Key」，
    // 症状是每次建索引都 401，而界面上两条配置看起来都完好。
    expect(back.config.embeddingApiKey).toBe('')
    expect(back.config.embeddingApiUrl).toBe('')
    // 落盘也要一致（界面下次读的是文件）
    expect(loadLlmConfig().rerankModel).toBe('')
    // 切回硅基流动那条：三角色又成套回来
    const again = activateLlmProfile(siliconId)
    expect(again.config.rerankModel).toBe('BAAI/bge-reranker-v2')
    expect(again.config.embeddingApiKey).toBe('sk-embed-silicon')
  })

  it('只改重排序模型不会换掉 chat 的 Key（角色字段各归各）', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    saveLlmConfig({ ...DEEPSEEK, rerankModel: 'new-reranker' })
    const cfg = loadLlmConfig()
    expect(cfg.apiKey).toBe('sk-deepseek')
    expect(cfg.apiUrl).toBe(DEEPSEEK.apiUrl)
    expect(cfg.rerankModel).toBe('new-reranker')
    // 且只有一条 profile（改的是使用中那条，不是新增一条）
    expect(loadLlmStore().profiles).toHaveLength(1)
  })

  it('手写的坏超时（0 / 负数 / 非数）按默认收敛，两个超时各自独立', () => {
    initState()
    saveLlmConfig({ ...DEEPSEEK, timeoutMs: 0, rerankTimeoutMs: -5 })
    const cfg = loadLlmConfig()
    expect(cfg.timeoutMs).toBe(120000)
    expect(cfg.rerankTimeoutMs).toBe(20000)
  })
})

describe('模型配置集：成套切换（核心不变量）', () => {
  it('切换时 供应商/模型/地址/Key 一起换，绝不拼出一半一半的组合', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    const dsId = loadLlmStore().profiles[0]!.id
    const afterAdd = upsertLlmProfile({ config: MIMO })
    const mimoId = afterAdd.activeProfileId
    expect(mimoId).not.toBe(dsId)

    // 新增即使用中：现在连的是 MiMo
    expect(loadLlmConfig().apiUrl).toBe(MIMO.apiUrl)
    expect(loadLlmConfig().apiKey).toBe('sk-mimo')

    // 切回 DeepSeek：地址与 Key 必须**同时**回到 DeepSeek
    const back = activateLlmProfile(dsId)
    expect(back.config.provider).toBe('deepseek')
    expect(back.config.model).toBe('deepseek-chat')
    expect(back.config.apiUrl).toBe(DEEPSEEK.apiUrl)
    expect(back.config.apiKey).toBe('sk-deepseek')
    // 而且真的落盘了（不是只改了内存）
    expect(loadLlmConfig().apiUrl).toBe(DEEPSEEK.apiUrl)
    expect(loadLlmConfig().apiKey).toBe('sk-deepseek')
    expect(loadLlmStore().activeProfileId).toBe(dsId)
  })

  it('两条配置各自的 Key 与地址互不污染', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    upsertLlmProfile({ config: MIMO })
    const store = loadLlmStore()
    const byProvider = new Map(store.profiles.map(p => [p.provider, p]))
    expect(byProvider.get('deepseek')!.apiKey).toBe('sk-deepseek')
    expect(byProvider.get('mimo')!.apiKey).toBe('sk-mimo')
    expect(byProvider.get('mimo')!.apiUrl).toBe(MIMO.apiUrl)
  })

  it('切换会记录 usedAt（列表里的「上次使用」靠它）', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    const dsId = loadLlmStore().profiles[0]!.id
    const mimoId = upsertLlmProfile({ config: MIMO }).activeProfileId
    const store = loadLlmStore()
    expect(store.profiles.find(p => p.id === mimoId)!.usedAt).toBeGreaterThan(0)
    expect(store.profiles.find(p => p.id === dsId)!.usedAt).toBeGreaterThan(0)
  })

  it('切到不存在的配置 → 报错（不静默停在旧配置上）', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    expect(() => activateLlmProfile('p99')).toThrow(/已不存在/)
  })

  it('切到缺模型名 / 缺地址与 Key 的配置 → 报错', () => {
    const { write } = initState()
    saveLlmConfig(DEEPSEEK)
    const store = loadLlmStore()
    write({
      ...DEEPSEEK,
      activeProfileId: store.activeProfileId,
      profiles: [
        ...store.profiles,
        { id: 'broken', label: '缺模型', provider: 'x', model: '', apiKey: '', apiUrl: '' },
      ],
    })
    expect(() => activateLlmProfile('broken')).toThrow(/模型名/)
  })
})

describe('模型配置集：新增与编辑', () => {
  it('upsert 默认把新配置设为使用中；activate:false 时保持原使用中不变', () => {
    initState()
    const first = upsertLlmProfile({ config: DEEPSEEK })
    const second = upsertLlmProfile({ config: MIMO, activate: false })
    expect(second.activeProfileId).toBe(first.activeProfileId)
    expect(second.profiles).toHaveLength(2)
    // 原来的那条没被动过
    expect(second.profiles.find(p => p.id === first.activeProfileId)!.apiKey).toBe('sk-deepseek')
    expect(loadLlmConfig().apiKey).toBe('sk-deepseek')
  })

  it('label 缺省按「供应商 · 模型」派生；用户改过名字则保留', () => {
    initState()
    const s1 = upsertLlmProfile({ config: DEEPSEEK })
    expect(s1.profiles[0]!.label).toBe('deepseek · deepseek-chat')
    const s2 = upsertLlmProfile({ id: s1.activeProfileId, config: DEEPSEEK, label: '我的 DeepSeek' })
    expect(s2.profiles[0]!.label).toBe('我的 DeepSeek')
  })

  it('编辑「使用中的那条」时，配置集里的那条跟着更新（否则切换条显示旧值）', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    saveLlmConfig({ ...DEEPSEEK, model: 'deepseek-reasoner', apiKey: 'sk-ds-2' })
    const store = loadLlmStore()
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0]!.model).toBe('deepseek-reasoner')
    expect(store.profiles[0]!.apiKey).toBe('sk-ds-2')
    // 自动派生的名字跟着内容走
    expect(store.profiles[0]!.label).toBe('deepseek · deepseek-reasoner')
  })

  it('用户起过名字的那条被编辑时，名字不被自动派生覆盖', () => {
    initState()
    const s = upsertLlmProfile({ config: DEEPSEEK, label: '主力' })
    saveLlmConfig({ ...DEEPSEEK, model: 'deepseek-reasoner' })
    const p = loadLlmStore().profiles.find(x => x.id === s.activeProfileId)!
    expect(p.label).toBe('主力')
    expect(p.model).toBe('deepseek-reasoner')
  })

  it('新增时缺模型名 / 缺地址与 Key 都拒绝（否则会存下一条切不过去的死配置）', () => {
    initState()
    expect(() => upsertLlmProfile({ config: { ...DEEPSEEK, model: '' } })).toThrow(/模型名/)
    expect(() => upsertLlmProfile({ config: { ...DEEPSEEK, apiUrl: '', apiKey: '' } })).toThrow(/API 地址/)
  })
})

describe('模型配置集：删除', () => {
  it('删非使用中的那条：使用中不变、顶层字段不变', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    const dsId = loadLlmStore().profiles[0]!.id
    upsertLlmProfile({ config: MIMO })
    const after = deleteLlmProfile(dsId)
    expect(after.profiles).toHaveLength(1)
    expect(after.profiles[0]!.provider).toBe('mimo')
    expect(after.config.apiKey).toBe('sk-mimo')
  })

  it('删掉使用中的那条：自动切到另一条，并把顶层字段摊平过去', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    const mimoId = upsertLlmProfile({ config: MIMO }).activeProfileId
    const after = deleteLlmProfile(mimoId)
    expect(after.activeProfileId).not.toBe(mimoId)
    expect(after.config.apiKey).toBe('sk-deepseek')
    expect(after.config.apiUrl).toBe(DEEPSEEK.apiUrl)
    expect(loadLlmConfig().apiKey).toBe('sk-deepseek')
  })

  it('只剩一条时拒绝删除（删空之后切换条与「已配置」徽标必然矛盾）', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    const only = loadLlmStore().profiles[0]!.id
    expect(() => deleteLlmProfile(only)).toThrow(/至少保留一条/)
  })

  it('删一个不存在的 id 时原样返回，不报错', () => {
    initState()
    saveLlmConfig(DEEPSEEK)
    const before = loadLlmStore()
    const after = deleteLlmProfile('p404')
    expect(after.profiles).toHaveLength(before.profiles.length)
    expect(after.activeProfileId).toBe(before.activeProfileId)
  })
})

describe('模型配置集：手工编辑文件的容错', () => {
  it('重复 id 只保留第一条（留着会让「切换」指向不确定的那条）', () => {
    const { write } = initState()
    write({
      ...DEEPSEEK,
      activeProfileId: 'dup',
      profiles: [
        { id: 'dup', provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-1', apiUrl: DEEPSEEK.apiUrl },
        { id: 'dup', provider: 'mimo', model: 'mimo-v2.5', apiKey: 'sk-2', apiUrl: MIMO.apiUrl },
      ],
    })
    const store = loadLlmStore()
    expect(store.profiles).toHaveLength(1)
    expect(store.profiles[0]!.apiKey).toBe('sk-1')
  })

  it('profiles 不是数组 / activeProfileId 指向不存在的条目 → 都能收敛', () => {
    const { write } = initState()
    write({ ...DEEPSEEK, profiles: 'oops', activeProfileId: 'nope' })
    const store = loadLlmStore()
    // profiles 非法 ⇒ 退回懒迁移（按扁平字段造一条），activeProfileId 不指向不存在的东西
    expect(store.profiles).toHaveLength(1)
    expect(store.activeProfileId).toBe(store.profiles[0]!.id)
  })

  it('缺字段的条目被补上默认值，不会把 undefined 带进界面', () => {
    const { write } = initState()
    write({
      profiles: [{ id: 'p1', provider: 'mimo', model: 'mimo-v2.5' }],
      activeProfileId: 'p1',
    })
    const p = loadLlmStore().profiles[0]!
    expect(p.apiKey).toBe('')
    expect(p.apiUrl).toBe('')
    expect(p.apiPath).toBe('/chat/completions')
    expect(p.timeoutMs).toBe(120000)
    expect(p.label).toBe('mimo · mimo-v2.5')
  })

  it('顶层扁平字段始终等于「当前生效值」，老读者 loadLlmConfig 不受影响', () => {
    const { read } = initState()
    saveLlmConfig(DEEPSEEK)
    const dsId = loadLlmStore().profiles[0]!.id
    upsertLlmProfile({ config: MIMO })
    activateLlmProfile(dsId)
    const raw = read() as Record<string, unknown>
    const cfg = loadLlmConfig()
    expect(raw['apiUrl']).toBe(cfg.apiUrl)
    expect(raw['apiKey']).toBe(cfg.apiKey)
    expect(raw['provider']).toBe('deepseek')
    expect(raw['model']).toBe('deepseek-chat')
  })
})
