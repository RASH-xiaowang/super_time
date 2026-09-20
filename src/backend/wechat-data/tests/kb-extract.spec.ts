/**
 * 文档实体抽取（推断层）的回归用例 —— `docs/KB-MODEL-CONFIG.md` 的 P4 / V6。
 *
 * 这一层最容易写坏的四件事，全都不在「模型准不准」上：
 *   ① **格式宽容但结构不猜**：模型回 `- person | 张三`、`张三|person`、`"org","某公司"` 都要能吃下；
 *      而吃不下的行必须**丢并计数**，不能硬猜成某个类别 —— 猜错的类别会直接画进图里；
 *   ② **重跑是替换不是追加**：同一个文件再抽一次，旧结果不是「另一批事实」，
 *      而是同一个问题的旧答案。追加会让图谱里一个文件挂出两套互相矛盾的主题词；
 *   ③ **不许越出自己的库与自己的文件**：`kb_id` 与 `include_in_rag` 都写在 SQL 里。
 *      拿甲库的 fileId 配乙库的 kbId 去抽，物理上会读到乙库不该读的东西；
 *   ④ **合并成节点时的口径**：该合的合（同名同类跨文件）、不该合的别合（同名不同类）。
 *      两侧前缀（`ent:`）还是前后端的接口面，不一致时边会被静默吃掉。
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerKbFile } from '../src/query/kb-files.ts'
import { kbFilesDbPath } from '../src/query/kb-paths.ts'
import {
  ENTITY_KINDS,
  MAX_ENTITIES_PER_FILE,
  buildExtractPrompt,
  extractFileEntities,
  mergeDocEntities,
  parseEntityLines,
  readDocEntities,
  saveDocEntities,
  type DocEntity,
} from '../src/query/kb/extract.ts'

let root = ''
let decrypted = ''
let srcDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-kbextract-'))
  // ⚠ 产物在 `dirname(decryptedDir)`：decryptedDir 必须是子目录（否则多个夹具互相看见）。
  decrypted = join(root, 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 登记一个文件，返回 fileId。 */
function addFile(kbId: number, name: string, content: string, includeInRag = true): number {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  const r = registerKbFile(decrypted, { kbId, srcPath: p, includeInRag })
  if (!r.ok || r.file === undefined) throw new Error(`夹具登记失败：${name} → ${r.code}: ${r.error}`)
  return r.file.id
}

describe('① 解析：宽容格式，但不猜结构', () => {
  it('标准行、Markdown 列表、引号包裹、TAB 分隔都能吃下', () => {
    const raw = [
      'person|张三|90',
      '- org|某某科技有限公司',
      '* "product"\t"蓝鲸系统"',
      'topic | 交付节奏',
    ].join('\n')
    const { items } = parseEntityLines(raw)
    expect(items.map(i => `${i.kind}:${i.label}`)).toEqual([
      'person:张三', 'org:某某科技有限公司', 'product:蓝鲸系统', 'topic:交付节奏',
    ])
    expect(items[0].weight).toBe(90)
    // 没给重要度时按 50，而不是 0（0 会让它在图上看不见）
    expect(items[1].weight).toBe(50)
  })

  it('kind 与 label 顺序颠倒也认（模型常犯）', () => {
    const { items } = parseEntityLines('张三|person\n某公司|org')
    expect(items).toEqual([
      { label: '张三', kind: 'person', weight: 50 },
      { label: '某公司', kind: 'org', weight: 50 },
    ])
  })

  it('只给名字 ⇒ 归 topic；类别词不认识 ⇒ 也归 topic 而不是照收', () => {
    expect(parseEntityLines('交付节奏').items[0]).toMatchObject({ label: '交付节奏', kind: 'topic' })
    const weird = parseEntityLines('animal|东北虎')
    // `animal` 不在白名单里：这一行按「label|kind」也解释不通 ⇒ 名字留下、类别归 topic
    expect(weird.items.every(i => (ENTITY_KINDS as readonly string[]).includes(i.kind))).toBe(true)
  })

  it('吃不下的行被丢弃并计数，不会污染结果', () => {
    // 那行长文本**必须**超过 MAX_LABEL(40)：它测的是「解释性整句不会被当成实体名收下」，
    // 只写 38 个字就会静默地什么也没测（第一版正是这样）。
    const long = '这是一句超过四十个字的解释性长文本，用来测试上限截断的行为是否真的生效，以及它会不会被误当成一个实体名收下来'
    expect(long.length).toBeGreaterThan(40)
    const { items, dropped } = parseEntityLines(`${long}\nperson|李四`)
    expect(items.map(i => i.label)).toEqual(['李四'])
    expect(dropped).toBeGreaterThan(0)
  })

  it('同一个 kind+label 只留一条（模型爱重复）', () => {
    const { items, dropped } = parseEntityLines('person|张三\nperson|张三\nPERSON|张三')
    expect(items).toHaveLength(1)
    expect(dropped).toBe(2)
  })

  it('封顶：一个文件最多 MAX_ENTITIES_PER_FILE 条（不封顶会把图画成一团毛线）', () => {
    const raw = Array.from({ length: MAX_ENTITIES_PER_FILE + 30 }, (_, i) => `topic|主题${i}`).join('\n')
    expect(parseEntityLines(raw).items).toHaveLength(MAX_ENTITIES_PER_FILE)
  })
})

describe('提示词', () => {
  it('被截断时把「只是开头部分」写进 prompt', () => {
    expect(buildExtractPrompt('a.md', '正文', true)).toContain('被截掉了')
    expect(buildExtractPrompt('a.md', '正文', false)).toContain('全文')
    expect(buildExtractPrompt('合同书.pdf', '正文', false)).toContain('合同书.pdf')
  })
})

describe('② 落库：重跑是替换', () => {
  it('同一文件写两次，只剩第二次那批', () => {
    const f = addFile(1, 'a.md', '第一段正文内容用于分块。'.repeat(12))
    saveDocEntities(decrypted, 1, f, [{ label: '旧主题', kind: 'topic', weight: 60 }], 'm1')
    const r = saveDocEntities(decrypted, 1, f, [{ label: '新主题', kind: 'topic', weight: 70 }], 'm2')
    expect(r.ok).toBe(true)
    const { items } = readDocEntities(decrypted, 1)
    expect(items.map(i => i.label)).toEqual(['新主题'])
    expect(items[0].model).toBe('m2')
  })

  it('按库隔离：乙库读不到甲库的实体', () => {
    const f1 = addFile(1, 'a.md', '第一段正文内容用于分块。'.repeat(12))
    addFile(2, 'b.md', '另一个库的正文内容。'.repeat(12))
    saveDocEntities(decrypted, 1, f1, [{ label: '甲库主题', kind: 'topic', weight: 60 }], 'm1')
    expect(readDocEntities(decrypted, 1).items.map(i => i.label)).toEqual(['甲库主题'])
    expect(readDocEntities(decrypted, 2).items).toEqual([])
  })

  it('从没抽过的库：空列表而不是报错（表还不存在也要能回答）', () => {
    addFile(1, 'a.md', '正文内容。'.repeat(12))
    const r = readDocEntities(decrypted, 1)
    expect(r.items).toEqual([])
    expect(r.readError).toBeUndefined()
  })
})

describe('③ 抽取入口：作用域与出网意愿', () => {
  it('拿别的库的 fileId 来抽 ⇒ 拒绝，且一次模型调用都不发', async () => {
    const mine = addFile(1, 'a.md', '第一段正文内容用于分块。'.repeat(12))
    addFile(2, 'other.md', '另一个库的正文内容。'.repeat(12))
    let calls = 0
    const r = await extractFileEntities(decrypted, 2, mine, async () => { calls += 1; return 'topic|x' }, 'm')
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('不属于当前知识库')
    expect(calls, '越界的抽取照样把正文发出去了').toBe(0)
  })

  it('关掉「参与语义检索」的文件：不发请求，错误里点明原因', async () => {
    const off = addFile(1, 'private.md', '合同金额一百万元，违约金按日万分之五计。', false)
    let calls = 0
    const r = await extractFileEntities(decrypted, 1, off, async () => { calls += 1; return 'person|张三' }, 'm')
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('参与语义检索')
    expect(calls).toBe(0)
  })

  it('模型抛错（被拦截 / 断网）⇒ 原样带回原因，且不写任何实体', async () => {
    const f = addFile(1, 'a.md', '第一段正文内容用于分块。'.repeat(12))
    const r = await extractFileEntities(decrypted, 1, f, async () => { throw new Error('出站拦截：已按设置禁止') }, 'm')
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('出站拦截')
    expect(readDocEntities(decrypted, 1).items).toEqual([])
    const db = new DatabaseSync(kbFilesDbPath(decrypted))
    expect(() => db.prepare('SELECT COUNT(*) AS c FROM kb_doc_entities').get()).not.toThrow()
    db.close()
  })

  it('成功路径：解析出的实体落库，并带上模型名与时间', async () => {
    const f = addFile(1, '项目计划.md', '项目背景与交付节奏说明。'.repeat(20))
    const r = await extractFileEntities(decrypted, 1, f, async () => 'org|某某科技\nperson|张三\ntopic|交付节奏', 'deepseek/deepseek-chat')
    expect(r.ok).toBe(true)
    expect(r.saved).toBe(3)
    const { items } = readDocEntities(decrypted, 1)
    expect(items.map(i => i.kind)).toContain('org')
    expect(items.every(i => i.model === 'deepseek/deepseek-chat')).toBe(true)
    expect(items.every(i => i.at > 0)).toBe(true)
    expect(items.every(i => i.fileName === '项目计划.md')).toBe(true)
  })
})

/* ── ④ 合并成图谱节点 ────────────────────────────────────────────────
 * 逐文件抽出来的是**行**（一个文件一条），图谱要的是**节点**（同名实体一个点）。
 * 这一步写坏的两种方式都不会报错，只会让图悄悄失真：
 *   · 该合的没合（「张三 」与「张三」两个点）→ 看起来像两个人；
 *   · 不该合的合了（人名「张三」与主题词「张三」并成一点）→ 实体类别是假的，
 *     而类别正是详情里那句「模型推断的人名」的全部内容。
 * 边上的 `ent:` 前缀是前后端的接口面：前端按 `'ent:' + key` 造节点，两边不一致时
 * 边会被「两端节点都存在才保留」那道过滤静默吃掉 —— 图上不报错，只是线没了。
 */
describe('④ 合并成图谱节点：该合的合、不该合的别合', () => {
  /** 造一行实体（只给合并用得上的字段）。 */
  const row = (fileId: number, label: string, kind: string, extra: Partial<DocEntity> = {}): DocEntity => ({
    fileId, fileName: `f${fileId}.md`, label, kind: kind as DocEntity['kind'], weight: 50, model: 'm1', at: 1000, ...extra,
  })

  it('同名同类跨文件 ⇒ 一个节点、两份来源、一条边/文件', () => {
    const g = mergeDocEntities([row(37, '某某科技', 'org'), row(38, '某某科技', 'org')])
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0]).toMatchObject({ key: 'org:某某科技', label: '某某科技', kind: 'org', occurrences: 2 })
    expect(g.nodes[0].files.map(f => f.id)).toEqual([37, 38])
    expect(g.edges).toEqual([
      { source: 'file:37', target: 'ent:org:某某科技', weight: 50, kind: 'suggest' },
      { source: 'file:38', target: 'ent:org:某某科技', weight: 50, kind: 'suggest' },
    ])
  })

  it('大小写与首尾空白折叠后算同一个（不折叠就会画成两个点）', () => {
    const g = mergeDocEntities([row(37, 'DeepSeek', 'product'), row(38, ' deepseek ', 'product')])
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].key).toBe('product:deepseek')
    expect(g.nodes[0].files.map(f => f.id)).toEqual([37, 38])
    // 刻意**不**去掉词内空格：与章节层同一口径，「张 三」是不是同一个人名由语义决定，
    // 由字符串规则来判定会把两个不同的人并成一个。
    expect(mergeDocEntities([row(37, '张 三', 'person'), row(38, '张三', 'person')]).nodes).toHaveLength(2)
  })

  it('同名不同类**不合并**：人名「张三」与主题词「张三」是两个点', () => {
    const g = mergeDocEntities([row(37, '张三', 'person'), row(38, '张三', 'topic')])
    expect(g.nodes.map(n => n.key).sort()).toEqual(['person:张三', 'topic:张三'])
    expect(g.nodes.every(n => n.files.length === 1)).toBe(true)
  })

  it('一个文件里重复出现的同一实体：取最高 weight，occurrences 记真实次数', () => {
    const g = mergeDocEntities([row(37, '张三', 'person', { weight: 40 }), row(37, '张三', 'person', { weight: 80 })])
    expect(g.nodes[0].files).toEqual([{ id: 37, weight: 80 }])
    expect(g.nodes[0].occurrences).toBe(2)
    expect(g.edges).toHaveLength(1)
  })

  it('换过模型后：节点上留的是**最近一次**的模型与时间', () => {
    const g = mergeDocEntities([
      row(37, '张三', 'person', { model: 'old-model', at: 2000 }),
      row(38, '张三', 'person', { model: 'new-model', at: 5000 }),
      row(39, '张三', 'person', { model: 'oldest-model', at: 100 }),
    ])
    expect(g.nodes[0].model).toBe('new-model')
    expect(g.nodes[0].at).toBe(5000)
  })

  it('节点按「铺得多广」降序（截断时留下的是跨文件实体，而不是碰巧排在前面的）', () => {
    const g = mergeDocEntities([
      row(1, '窄词', 'topic'),
      row(1, '宽词', 'topic'), row(2, '宽词', 'topic'), row(3, '宽词', 'topic'),
    ])
    expect(g.nodes.map(n => n.label)).toEqual(['宽词', '窄词'])
    expect(g.nodes[0].files).toHaveLength(3)
  })

  it('空输入 ⇒ 空节点空边（没抽过的库不该造出幽灵点）', () => {
    expect(mergeDocEntities([])).toEqual({ nodes: [], edges: [] })
  })
})
