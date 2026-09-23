/**
 * 链接建议（`query/kb/suggest.ts` + `@Remote('suggestKbLinks')`）与实体抽取的
 * 网关级验收 —— `docs/KB-MODEL-CONFIG.md` 的 P4 / V6。
 *
 * 这一层的产品契约只有一句话：**模型只出建议，写不写由人决定**。
 * 但围绕它有四种会静默失效的写法，前三种在纯模块测试里看不见：
 *   ① 建议把**正在写的正文**发出去 —— 所以它必须过与摘要同一道隐私闸，且
 *      「已连上的目标」不该再建议（那说明实现没读正文）；
 *   ② 「不写库」是个**否定**契约：没有任何测试会因为它多写了一行而变红，
 *      除非专门断言「调用前后笔记一字未变」；
 *   ③ 抽取实体与建索引是两笔不同的出网账：审计功能名必须各是各的
 *      （`kb_extract` / `kb_link_suggest`），混成一个就没法回答「我把哪类数据发出去了」；
 *   ④ 排序本身（纯函数部分）：阈值、去重、已连目标过滤、池上限、失败要如实带回原因。
 *
 * LLM 全程用桩：`embed.calls` / `stream.calls` 存着每次真实发出去的文本，
 * 所以「没出网」是可断言的（`calls.length === 0`），而不是「看起来没报错」。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { readPrivacySettings, writePrivacySettings } from '../src/query/privacy-audit.ts'
import { alreadyLinked, rankLinkCandidates, SUGGEST_POOL_MAX } from '../src/query/kb/suggest.ts'
import { at } from '../../tests/helpers/strict-index.ts'

let root = ''
let decrypted = ''
let srcDir = ''

describe('① 排序纯函数：候选从哪来不管，只管排序与边界', () => {
  /** 字符直方图向量：与正文共享字符越多的标题分越高（确定性、可断言）。 */
  function stubEmbed(dim = 24): { calls: string[][]; fn: (texts: string[]) => Promise<number[][]> } {
    const stub = { calls: [] as string[][], fn: async (texts: string[]): Promise<number[][]> => {
      stub.calls.push(texts)
      return texts.map(t => {
        const v = new Array<number>(dim).fill(0)
        for (const ch of t) { const k = (ch.codePointAt(0) ?? 0) % dim; v[k] = (v[k] ?? 0) + 1 }
        return v
      })
    } }
    return stub
  }

  it('已经 [[连过]] 的目标不再建议（正文都读了却没过滤，等于没读）', () => {
    const set = alreadyLinked('交付节奏见 [[项目组]]，另有 [[ 项目组 ]] 与 [[不存在的笔记|显示名]]')
    expect([...set].sort()).toEqual(['不存在的笔记', '项目组'])
    // 防空转：完全没链接的正文必须得到空集合，否则上一条可能只是「解析出一个假集合」
    expect(alreadyLinked('一句话，没有链接').size).toBe(0)
  })

  it('按相似度降序、过阈值、截到 topK', async () => {
    const e = stubEmbed()
    const r = await rankLinkCandidates('项目组的交付节奏与验收标准', [
      { label: '项目组', kind: 'note' },
      { label: '量子色动力学', kind: 'entity' },
      { label: '交付节奏', kind: 'note' },
    ], e.fn, { topK: 2 })
    expect(r.ranked.length).toBeLessThanOrEqual(2)
    expect(at(r.ranked, 0, 'ranked').label).toBe('项目组')
    expect(at(r.ranked, 0, 'ranked').score).toBeGreaterThanOrEqual(at(r.ranked, r.ranked.length - 1, 'ranked').score)
    // 与正文毫不相干的那个不该混进来（阈值存在的意义）
    expect(r.ranked.map(x => x.label)).not.toContain('量子色动力学')
  })

  it('同名只留一个（笔记标题与实体重名时不重复出芯片）', async () => {
    const e = stubEmbed()
    const r = await rankLinkCandidates('张三的会议记录', [
      { label: '张三', kind: 'note' },
      { label: '张三', kind: 'entity' },
    ], e.fn)
    expect(r.ranked.filter(x => x.label === '张三')).toHaveLength(1)
    // 一次请求里也不该带重复文本
    expect(r.pool).toBe(1)
  })

  it('候选池有上限，且发给模型的就是截断后的那批', async () => {
    const e = stubEmbed()
    const many = Array.from({ length: SUGGEST_POOL_MAX + 30 }, (_, i) => ({ label: `标题${i}`, kind: 'note' as const }))
    // 查询词刻意不以「标题」开头：否则下面 filter 会把它也数进去，看不出池子截到哪
    const r = await rankLinkCandidates('第 7 号事项相关的讨论内容', many, e.fn)
    expect(r.pool).toBe(SUGGEST_POOL_MAX)
    const sent = e.calls.flat().filter(t => t.startsWith('标题'))
    expect(sent.length).toBe(SUGGEST_POOL_MAX)
    // 分批：40 条一批 ⇒ 80 条候选两次请求，不含第一次的查询向量
    expect(e.calls.length).toBe(3)
  })

  it('正文为空时一次都不发（没内容可建议，出网就是白出）', async () => {
    const e = stubEmbed()
    const r = await rankLinkCandidates('   ', [{ label: '任意', kind: 'note' }], e.fn)
    expect(e.calls.length).toBe(0)
    expect(r.ranked).toEqual([])
  })

  it('embedding 抛错 ⇒ 空结果 + 原样带回原因，不抛出异常', async () => {
    const r = await rankLinkCandidates('正文正文正文', [{ label: '甲', kind: 'note' }],
      async () => { throw new Error('429 限流') })
    expect(r.ranked).toEqual([])
    expect(r.note ?? '').toContain('429 限流')
  })

  it('源码层：本模块没有任何写路径，也不碰笔记/文件模块', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'kb', 'suggest.ts'), 'utf8')
    for (const w of ['INSERT', 'UPDATE ', 'DELETE ', 'saveNote', 'saveDocEntities', 'writeFileSync']) {
      expect(src, `suggest.ts 里出现了写路径 ${w}`).not.toContain(w)
    }
    // 依赖方向：只允许 import 向量数学（取候选是 gateway 的事）
    const imports = [...src.matchAll(/^import .*from '(.+)'$/gm)].map(m => m[1])
    expect(imports).toEqual(['../vector-math.ts'])
  })
})

/* ── 网关级：两个新出网点的接线 ─────────────────────────────────────── */

interface Stub {
  chatCalls: string[]
  embedCalls: string[]
  /** 让某个文件的抽取抛错（模拟超时/限流）。 */
  failOn: string | null
  embedModel: string
  /** true = 复刻「用户还没配语言模型」：整条 chat 选择链给空串。 */
  chatModelOff: boolean
}

let gw: WechatDataGateway
let stub: Stub
let kbId = 0
let disposers: Array<() => void> = []

function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  const s: Stub = {
    chatCalls: [], embedCalls: [], failOn: null, embedModel: 'stub-embed-v1', chatModelOff: false,
  }
  stub = s
  const llm = {
    // eslint-disable-next-line require-yield
    stream: async function* (o: unknown): AsyncGenerator<{ type: string; index: number; text: string }> {
      const msgs = (o as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []
      const prompt = msgs[0]?.content?.[0]?.text ?? ''
      s.chatCalls.push(prompt)
      if (s.failOn !== null && prompt.includes(s.failOn)) throw new Error('模型超时')
      yield { type: 'text-delta', index: 0, text: 'person|张三|90\ntopic|交付节奏' }
    },
    embed: async (texts: string[]): Promise<number[][]> => {
      s.embedCalls.push(...texts)
      return texts.map(t => {
        const v = new Array<number>(24).fill(0)
        for (const ch of t) { const k = (ch.codePointAt(0) ?? 0) % 24; v[k] = (v[k] ?? 0) + 1 }
        return v
      })
    },
    embeddingModelName: () => s.embedModel,
    rerankModelName: () => '',
    config: { model: '' },
  }
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: s.chatModelOff ? '' : 'stub-model' }) },
  } as unknown as Context
}

function addFile(name: string, content: string, includeInRag = true): number {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  const r = gw.addKbFiles({ kbId, paths: [p], includeInRag })
  if (!r.ok) throw new Error(`夹具登记失败：${r.error ?? '?'}`)
  const hit = gw.getKbFiles(kbId, { limit: 500 }).items.find(f => f.name === name)
  if (hit === undefined) throw new Error(`夹具里找不到 ${name}`)
  return hit.id
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-kbsuggest-'))
  decrypted = join(root, 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  gw = new WechatDataGateway(fakeCtx())
  kbId = Number(gw.createKb({ name: '建议与抽取测试库' }).id)
})

afterEach(() => {
  for (const d of disposers) { try { d() } catch { /* 已释放 */ } }
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('② extractKbEntities：出网意愿与进度', () => {
  it('既开了出站拦截、又没配模型时，说的是拦截（顺序不能反）', async () => {
    writePrivacySettings(decrypted, { ...readPrivacySettings(decrypted), blockOutbound: true })
    stub.chatModelOff = true
    addFile('plan.md', '项目背景与交付节奏说明。'.repeat(6))
    const r = await gw.extractKbEntities({ kbId })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('拦截')
    expect(r.error ?? '').not.toContain('未配置')
    expect(stub.chatCalls.length, '被拦下了还发请求').toBe(0)
  })

  it('没配语言模型时的说法是「未配置」，且同样一次都不发', async () => {
    stub.chatModelOff = true
    addFile('plan.md', '项目背景与交付节奏说明。'.repeat(6))
    const r = await gw.extractKbEntities({ kbId })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('未配置')
    expect(stub.chatCalls.length).toBe(0)
  })

  it('关掉「参与语义检索」的文件不进这一轮，一次正文都不发', async () => {
    const off = addFile('private.md', '合同金额一百万元，违约金按日万分之五计。', false)
    expect(off).toBeGreaterThan(0)
    const r = await gw.extractKbEntities({ kbId })
    expect(r.files, `不该把不出网的文件算进本轮：${JSON.stringify(r.failed)}`).toBe(0)
    expect(stub.chatCalls.length).toBe(0)
    // 进度那一行也必须按同一个口径数：把不出网的文件算进「可抽」，界面就会一直
    // 显示「还有 1 个没抽」，而那个文件是用户明确说过不出网的。
    const view = gw.getKbModelConfig({ kbId })
    expect(view.entities.ragFiles).toBe(0)
    expect(view.entities.pending).toBe(0)
  })

  it('抽完落库、进度看得见的变化（弹层那一行读的就是它）', async () => {
    addFile('plan.md', '项目背景与交付节奏说明，参与方为某某科技与张三。'.repeat(6))
    const before = gw.getKbModelConfig({ kbId })
    expect(before.entities.entities).toBe(0)
    const r = await gw.extractKbEntities({ kbId })
    expect(r.saved).toBeGreaterThan(0)
    const after = gw.getKbModelConfig({ kbId })
    expect(after.entities.entities).toBe(r.saved)
    expect(after.entities.pending).toBe(0)
    expect(after.settings.entitiesAt).toBeGreaterThan(0)
    expect(after.resolved.chat.model).toBe('stub-model')
  })

  it('一个文件失败不拖垮整轮：失败原因逐条带回', async () => {
    addFile('ok.md', '正常文件的正文内容，讲交付节奏。'.repeat(6))
    addFile('bad.md', '这个文件的名字会被模型超时命中。'.repeat(6))
    stub.failOn = 'bad.md'
    const r = await gw.extractKbEntities({ kbId })
    expect(r.ok, '部分成功应当算成功').toBe(true)
    expect(r.files).toBe(2)
    expect(r.failed).toHaveLength(1)
    expect(at(r.failed, 0, 'failed').error).toContain('超时')
    expect(r.saved).toBeGreaterThan(0)
  })
})

describe('③ suggestKbLinks：只出建议，不写正文', () => {
  it('正常路径：本库标题进候选，正在编辑的那篇被排除', async () => {
    gw.saveNote(kbId, { title: '交付节奏', body: '每周三对齐一次。' })
    gw.saveNote(kbId, { title: '验收标准', body: '见合同附件二。' })
    const r = await gw.suggestKbLinks({ kbId, text: '今天的会把交付节奏再往前压一周，需要和项目组对齐。' })
    expect(r.ok).toBe(true)
    expect(r.candidates.map(c => c.label)).toContain('交付节奏')
    expect(r.pool).toBe(2)
    expect(r.model).toBe('stub-embed-v1')
    const self = await gw.suggestKbLinks({ kbId, text: '交付节奏要压一周', excludeTitle: '交付节奏' })
    expect(self.candidates.map(c => c.label)).not.toContain('交付节奏')
  })

  it('建议**不写任何数据**：调用前后笔记与实体一字未变', async () => {
    gw.saveNote(kbId, { title: '交付节奏', body: '每周三对齐一次。' })
    const notesBefore = JSON.stringify(gw.getNotes(kbId, { limit: 100 }))
    const r = await gw.suggestKbLinks({ kbId, text: '交付节奏需要更多人参与' })
    expect(r.candidates.length).toBeGreaterThan(0)
    expect(JSON.stringify(gw.getNotes(kbId, { limit: 100 }))).toBe(notesBefore)
    // 建议用的是嵌入通道，不该顺手把正文发给语言模型（那会是第二次出网、另一个功能名）
    expect(stub.chatCalls.length).toBe(0)
  })

  it('被拦截时一次 embed 都不发，且说的是拦截', async () => {
    gw.saveNote(kbId, { title: '交付节奏', body: '每周三对齐一次。' })
    writePrivacySettings(decrypted, { ...readPrivacySettings(decrypted), blockOutbound: true })
    const r = await gw.suggestKbLinks({ kbId, text: '交付节奏还要不要提前' })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('拦截')
    expect(stub.embedCalls.length, '被拦下了还发请求').toBe(0)
  })

  it('正文太短 / 没配嵌入模型：各自一句实话，不混为一谈', async () => {
    gw.saveNote(kbId, { title: '交付节奏', body: 'x' })
    const short = await gw.suggestKbLinks({ kbId, text: '短' })
    expect(short.ok).toBe(false)
    expect(short.error ?? '').toContain('太短')
    expect(stub.embedCalls.length, '正文太短也去问模型').toBe(0)
    stub.embedModel = ''
    const none = await gw.suggestKbLinks({ kbId, text: '交付节奏还要不要提前，先看看人力' })
    expect(none.ok).toBe(false)
    expect(none.error ?? '').toContain('未配置')
  })

  it('已经连过的目标不再建议（发出去的正文被真读了一遍）', async () => {
    gw.saveNote(kbId, { title: '交付节奏', body: '每周三对齐一次。' })
    gw.saveNote(kbId, { title: '验收标准', body: '见合同附件二。' })
    const r = await gw.suggestKbLinks({ kbId, text: '交付节奏见 [[交付节奏]]，其余另行安排与人员分工说明' })
    expect(r.candidates.map(c => c.label)).not.toContain('交付节奏')
    expect(stub.embedCalls.some(t => t === '交付节奏'), '被过滤的候选还是发出去了').toBe(false)
  })
})
