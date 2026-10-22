// @vitest-environment node
/**
 * 阶段 A（G-01 + G-04 稀疏）—— 知识库接入问答链路的回归用例。
 *
 * 这一层要钉住的**不是**「kb 通道被调用了」，而是几处**错了也不报错**的不变量：
 *
 *   ① **docKey 格式**：块键必须是 `kb:<kbId>:<chunkId>`，且只能由 `kbDocKey` 产出。
 *      融合去重、反馈归因都读它 —— 手拼一个 `chunk:<id>` 或漏掉前缀，检索照常返回结果，
 *      只是「这条引用有用」永远归因不到任何特征向量（调参静默失效）。
 *   ② **块 → 统一文档的映射**：`username` 必须是 `kb:<kbId>:<fileId>`（**按文件分组**）。
 *      按库分组或给空串会让压缩阶段把「同一文件的后续块」当成「这段对话已经进过上下文」
 *      而跳过 —— 命中三块的合同在上下文里只剩一块。
 *   ③ **压缩阶段的 KB 豁免**：文件块不做窗口展开、且必须绕开 `chosen` 去重。
 *      这条最隐蔽：豁免掉之后 `create_time=0` + 同 `username` 会让第二个块起全部消失，
 *      而**任何断言都不会红**（列表长度、条数、引用序号全都自洽）。
 *   ④ **来源区分渲染**：`formatAskContext` 对 KB 块必须写明「文件内容，不是聊天记录」
 *      且不写时间（`create_time=0`，编一个日期就是递给模型一条可以照抄的假事实）。
 *   ⑤ **依据行只数消息**：KB 的 `username` 不是会话（它按文件分组），把它算进「N 个会话」
 *      就是一句用户一数就对不上的谎话；文件另按**文件**去重单列。
 *   ⑥ **库隔离**：kbId 指向另一个库时命中必须换库（甲库的文件不许出现在乙库的答案里）。
 *      这条断言必须**两半都做**（同一问题在甲库确实召回、在乙库确实不召回），
 *      否则「看不到对方的结果」只是空集，测的不是隔离。
 *
 * 全部用例走真实 sqlite 与真实写入路径（`registerKbFile` 读字节 → 解析 → 分块 → FTS），
 * 不是 mock。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { KbHit } from '../src/types.ts'
import type { IntentKind } from '../src/query/retrieval/types.ts'
import type { RetrievedDoc, RankedDoc } from '../src/query/retrieval/types.ts'
import { citationDocKey, kbChannel, kbDocFromHit, kbDocKey } from '../src/query/retrieval/kb-channel.ts'
import { compressContext, docToRanked } from '../src/query/retrieval/compress.ts'
import { defaultPolicyFor, defaultRetrievalConfig } from '../src/query/retrieval/config.ts'
import { runRetrievalPipeline } from '../src/query/retrieval/pipeline.ts'
import { formatAskContext, parseCitedIndexes } from '../src/query/ask.ts'
import { auditGrounding } from '../src/query/grounding.ts'
import { registerKbFile, setKbFileRagFlag } from '../src/query/kb-files.ts'
import { getPrivacyStateSnapshot } from '../src/query/privacy-audit.ts'
import { buildSearchIndex } from '../src/query/search.ts'
import { WechatDataGateway } from '../src/gateway.ts'
import { at } from '../../tests/helpers/strict-index.ts'

let root = ''
let decrypted = ''
let srcDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-ask-channel-'))
  // 与线上同一布局：`<root>/data/decrypted` 是解密根，`wechat_kb_files.db` 在它的**父目录**。
  decrypted = join(root, 'data', 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** 造一个真文件，返回路径。 */
function fixture(name: string, content: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

/** 登记并断言成功（失败就把原因抛出来，免得用例在「少了一个夹具」的状态下继续跑）。 */
function register(name: string, content: string, kbId = 1, includeInRag = true): number {
  const r = registerKbFile(decrypted, { kbId, srcPath: fixture(name, content), includeInRag })
  if (!r.ok || r.file === undefined) throw new Error(`夹具登记失败：${name} → ${r.code}: ${r.error}`)
  return r.file.id
}

/** 一句只可能出现在我们夹具里的短语。 */
const UNIQUE = '蓝鲸协议第七附则'
/** 另一库的可搜内容（用于「换库必须换命中」的反向一半）。 */
const OTHER = '玄武纪要第九附录'
/** 不许出网的文件里的独有短语。 */
const SECRET = '独角兽备忘录第十七条'

/** 含独有短语的合同正文（同时带一个金额，供接地审计用例用）。 */
function contractText(): string {
  return [
    '# 蓝鲸合同',
    '',
    '## 第七附则',
    '',
    '本附则约定：验收款为 12000 元，签约后三十日内支付。',
    '',
    UNIQUE + '自双方盖章之日起生效。',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 适配层（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

/** 一条知识库命中（形状取自 `searchKb` 的产物）。 */
function kbHit(over: Partial<KbHit> = {}): KbHit {
  return {
    fileId: 7,
    fileName: '蓝鲸合同.md',
    fileExt: 'md',
    chunkId: 42,
    ordinal: 3,
    page: 2,
    heading: '蓝鲸合同 › 第七附则',
    snippet: '…' + UNIQUE + '…',
    text: contractText(),
    marks: [],
    score: 3.5,
    ranks: { sparse: 1 },
    ...over,
  }
}

describe('适配层：块 → 统一文档（docKey / username / 来源判别）', () => {
  it('docKey 恒为 kb:<kbId>:<chunkId>，与消息键天然不冲突', () => {
    expect(kbDocKey(3, 9)).toBe('kb:3:9')
    // 消息键是 `username:local_id`（微信 username 不以 `kb:` 开头）——
    // 若两键空间重叠，融合阶段会把「文件块」和「某条消息」去重成一条。
    expect(kbDocKey(1, 2)).not.toBe('wxid_lisi:2')
    expect(kbDocKey(1, 2).startsWith('kb:')).toBe(true)
  })

  it('块 → 文档：username 按文件分组、时间留 0、kb 明细齐备', () => {
    const d = kbDocFromHit(5, kbHit())
    expect(d.docKey).toBe('kb:5:42')
    // 按**文件**分组（fileId=7）而不是按库、也不是空串 —— 压缩阶段的同源去重靠它。
    expect(d.username).toBe('kb:5:7')
    expect(d.source).toBe('kb')
    expect(d.local_id).toBe(0)
    // 0 = 「无时间」的哨兵：给假时间戳会让新鲜度衰减把文件算成「刚发生的事」。
    expect(d.create_time).toBe(0)
    // name 只放文件名，面包屑走 kb.heading（界面要分开展示）。
    expect(d.name).toBe('蓝鲸合同.md')
    expect(d.text).toBe(contractText())
    expect(d.kb).toEqual({
      kbId: 5, fileId: 7, fileName: '蓝鲸合同.md', fileExt: 'md',
      chunkId: 42, ordinal: 3, page: 2, heading: '蓝鲸合同 › 第七附则',
    })
  })

  it('块正文为空时退化用摘要（重排的词覆盖率要在全文上判命中）', () => {
    const d = kbDocFromHit(1, kbHit({ text: '', snippet: '只有摘要' }))
    expect(d.text).toBe('只有摘要')
  })

  it('引用 → 归因键：与检索侧 docKey 逐字相同（反馈调参的唯一依据）', () => {
    const d = kbDocFromHit(5, kbHit())
    // 两个产出点必须给出同一个字符串，否则「这条引用有用」静默归因不到特征向量。
    expect(citationDocKey({ source: 'kb', kb: { kbId: 5, chunkId: 42 } })).toBe(d.docKey)
    // KB 引用缺明细时退化为空串（宁可归因不到，也不要错配到别人身上）。
    expect(citationDocKey({ source: 'kb' })).toBe('')
    // 消息引用仍是 `username:local_id`。
    expect(citationDocKey({ source: 'msg', username: 'wxid_a', local_id: 9 })).toBe('wxid_a:9')
    expect(citationDocKey({ username: 'wxid_a' })).toBe('wxid_a:0')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. kbChannel：作用域、降级、RAG 开关
// ─────────────────────────────────────────────────────────────────────────────

describe('kb 通道：降级必须如实、不许假装有内容', () => {
  it('没传当前库 → 不参与，并说明原因（没有「所有库」这种模式）', async () => {
    for (const bad of [undefined, 0, -1, Number.NaN]) {
      const r = await kbChannel(decrypted, bad, '合同', 20)
      expect(r.active).toBe(false)
      expect(r.hits).toEqual([])
      expect(r.note).toBeTruthy()
    }
    expect((await kbChannel(decrypted, undefined, '合同', 20)).note).toContain('未指定知识库')
  })

  it('无检索词 / 配额为 0 → 不参与（不谎报「知识库是空的」）', async () => {
    expect((await kbChannel(decrypted, 1, '   ', 20)).active).toBe(false)
    expect((await kbChannel(decrypted, 1, '合同', 0)).active).toBe(false)
  })

  it('真库命中：文档来源、按文件分组的 username、名次递增', async () => {
    const fileId = register('蓝鲸合同.md', contractText())
    // 不传 opts ⇒ 稠密子路径**根本不跑**（T3 老路），降级说明如实透传。
    const r = await kbChannel(decrypted, 1, UNIQUE, 20)
    expect(r.active).toBe(true)
    expect(r.hits.length).toBeGreaterThan(0)
    const h = r.hits[0]!
    expect(h.doc.source).toBe('kb')
    expect(h.doc.kb?.fileId).toBe(fileId)
    expect(h.doc.username).toBe(`kb:1:${fileId}`)
    expect(h.rank).toBe(1)
    // 稠密没跑 ⇒ 降级必须被看见（不能装作有稠密通道）。
    // 「稠密**跑过**之后这条说明必须消失」的另一半，钉在 kb-vectors.spec.ts 的 E 段。
    expect(r.note).toContain('仅关键词')
  })

  it('没有匹配 → active:false（不许把「没搜到」报成「搜到了」）', async () => {
    register('蓝鲸合同.md', contractText())
    const r = await kbChannel(decrypted, 1, '完全不存在的词组甲', 20)
    expect(r.active).toBe(false)
    expect(r.hits).toEqual([])
  })

  it('`onlyRag:true` 把「不许送进模型」的文件挡在候选之外', async () => {
    const secretId = register('机密.md', '内部资料。' + SECRET + '。', 1, false)
    // 问答路径恒带 onlyRag ⇒ 一开始就搜不到。
    expect((await kbChannel(decrypted, 1, SECRET, 20)).active).toBe(false)
    // 把开关打开 → **确实搜得到**。这半步不可省：没有它，下面的「搜不到」可能只是空转。
    expect(setKbFileRagFlag(decrypted, 1, secretId, true).ok).toBe(true)
    expect((await kbChannel(decrypted, 1, SECRET, 20)).active).toBe(true)
    // 关回去 → 立刻从问答路径消失。
    expect(setKbFileRagFlag(decrypted, 1, secretId, false).ok).toBe(true)
    expect((await kbChannel(decrypted, 1, SECRET, 20)).active).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 压缩阶段：同文件多块不得互相吞掉
// ─────────────────────────────────────────────────────────────────────────────

/** 一个能跑压缩的数据根（消息侧取不到窗口时会退化为「单条即窗口」）。 */
function emptyDataRoot(): string {
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  return decrypted
}

const OPTS = { maxChars: 6000, maxChunks: 10, linesPerChunk: 6, dedupThreshold: 0.85 }

describe('压缩阶段：同文件的多个块必须全部留在上下文里', () => {
  it('同一文件命中三块 → 三块都进上下文（不被「同会话已给过」吞掉）', () => {
    const hits = [
      kbHit({ chunkId: 11, ordinal: 0, text: '第一块：' + UNIQUE }),
      kbHit({ chunkId: 12, ordinal: 1, text: '第二块：验收款 12000 元' }),
      kbHit({ chunkId: 13, ordinal: 2, text: '第三块：违约金按日万分之五' }),
    ]
    const ranked: RankedDoc[] = hits.map((h, i) => docToRanked(kbDocFromHit(1, h), 6 - i))
    const { chunks } = compressContext(emptyDataRoot(), ranked, OPTS)

    // 关键断言：三块都在。若绕开 `chosen` 去重的豁免被删掉，这里会是 1。
    expect(chunks.length).toBe(3)
    expect(chunks.map(c => c.anchor.kb?.chunkId)).toEqual([11, 12, 13])
    expect(chunks.map(c => c.lines.length)).toEqual([1, 1, 1])
    expect(chunks[1]!.lines[0]!.text).toContain('验收款 12000 元')
    for (const c of chunks) {
      expect(c.anchor.source).toBe('kb')
      // 块不做窗口展开、也不编时间：时间留空才是如实的。
      expect(c.anchor.time).toBe('')
      expect(c.lines[0]!.time).toBe('')
      expect(c.lines[0]!.sender).toBe('')
      // 整块一行，不再按 linesPerChunk 二次切分（块本身已有语义边界）。
      expect(c.createTime).toBe(0)
    }
  })

  it('对照：消息命中走窗口展开、KB 命中不展开 —— 豁免是**按来源分支**的', () => {
    const mk = (localId: number, text: string): RetrievedDoc => ({
      docKey: `wxid_lisi:${localId}`,
      username: 'wxid_lisi',
      name: '李四',
      local_id: localId,
      create_time: 1700000000 + localId * 60,
      text,
      snippet: text,
    })
    const kbDocs = [
      kbDocFromHit(1, kbHit({ chunkId: 31, ordinal: 0, text: '块一：' + UNIQUE })),
      kbDocFromHit(1, kbHit({ chunkId: 32, ordinal: 1, text: '块二：' + UNIQUE + '（甲）' })),
    ]
    const { chunks } = compressContext(
      emptyDataRoot(),
      [docToRanked(mk(1, '合同的附件我发你'), 9), ...kbDocs.map((d, i) => docToRanked(d, 8 - i))],
      OPTS,
    )
    // 消息侧：仍按「命中消息 + 所在对话窗口」展开 —— 锚点带真实时间戳，也没有来源域字段。
    const msgChunks = chunks.filter(c => c.anchor.source !== 'kb')
    expect(msgChunks.length).toBeGreaterThan(0)
    for (const c of msgChunks) expect(c.anchor.time).not.toBe('')
    // KB 侧：两块都留、都不带时间、都保留来源身份（大小写：豁免一旦被删，这两条立刻变红）。
    const kbChunks = chunks.filter(c => c.anchor.source === 'kb')
    expect(kbChunks.map(c => c.anchor.kb?.chunkId)).toEqual([31, 32])
    for (const c of kbChunks) {
      expect(c.anchor.time).toBe('')
      expect(c.anchor.kb?.fileName).toBe('蓝鲸合同.md')
    }
  })

  it('KB 块不越权：maxChunks 与字符预算对它一样有约束', () => {
    const hits = [1, 2, 3].map(i => kbHit({ chunkId: 20 + i, ordinal: i, text: `块${i}：` + UNIQUE.repeat(3) }))
    const ranked = hits.map(h => docToRanked(kbDocFromHit(1, h)))
    expect(compressContext(emptyDataRoot(), ranked, { ...OPTS, maxChunks: 2 }).chunks.length).toBe(2)
    // 预算：每块 cost = text.length + 8，第一块装得下、第二块超预算即止。
    const cost = ranked[0]!.doc.text.length + 8
    expect(compressContext(emptyDataRoot(), ranked, { ...OPTS, maxChars: cost + 5 }).chunks.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. 上下文渲染：两种来源必须长得不一样
// ─────────────────────────────────────────────────────────────────────────────

describe('上下文渲染：编号连续、来源可辨', () => {
  /** 混排：消息 → 文件块 → 另一会话的消息。 */
  function mixedChunks(): ReturnType<typeof compressContext>['chunks'] {
    const msg = (localId: number, username: string, name: string, text: string): RetrievedDoc => ({
      docKey: `${username}:${localId}`, username, name, local_id: localId,
      create_time: 1700000000 + localId, text, snippet: text,
    })
    const ranked = [
      docToRanked(msg(1, 'wxid_lisi', '李四', '合同的附件我发你邮箱了'), 9),
      docToRanked(kbDocFromHit(1, kbHit()), 8),
      docToRanked(msg(1, '12345@chatroom', '项目组', '收到，我今晚看'), 7),
    ]
    return compressContext(emptyDataRoot(), ranked, OPTS).chunks
  }

  it('三类来源共用一个连续编号，KB 块写明「文件内容，不是聊天记录」且不带时间', () => {
    const chunks = mixedChunks()
    expect(chunks.map(c => c.anchor.source ?? 'msg')).toEqual(['msg', 'kb', 'msg'])
    const ctx = formatAskContext(chunks.map(c => c.anchor), { terms: ['合同'] }, chunks)

    expect(ctx).toContain('[1] 李四（')
    // KB 块：文件名 + 页码 + 面包屑 + 显式声明来源域。
    expect(ctx).toContain('[2] 知识库文件《蓝鲸合同.md》')
    expect(ctx).toContain('第 2 页')
    expect(ctx).toContain('第七附则')
    expect(ctx).toContain('**文件内容，不是聊天记录**')
    expect(ctx).toContain('没有发生时间')
    expect(ctx).toContain('[3] 项目组（')
    // KB 块不许出现消息块才有的「命中时间」字样（文件没有发生时间）。
    const kbBlock = ctx.split('[2] ')[1]!.split('\n\n[3] ')[0]!
    expect(kbBlock).not.toContain('命中时间')
    // 混有文件时，末尾总说明从「聊天记录…对话片段」改为「相关材料」。
    expect(ctx).toContain('相关材料')
  })

  it('只有消息时不改措辞（避免无谓的措辞漂移）', () => {
    const chunks = mixedChunks().filter(c => c.anchor.source !== 'kb')
    const ctx = formatAskContext(chunks.map(c => c.anchor), undefined, chunks)
    expect(ctx).toContain('微信聊天记录中检索到的相关对话片段')
    expect(ctx).not.toContain('相关材料')
  })

  it('退化路径（没有 chunks）时，KB 引用也走文件格式', () => {
    const d = kbDocFromHit(1, kbHit())
    const ctx = formatAskContext([{
      name: d.name, time: '', snippet: d.snippet, username: d.username, local_id: 0,
      source: 'kb', kb: d.kb,
    }], undefined, undefined)
    expect(ctx).toContain('知识库文件《蓝鲸合同.md》')
    expect(ctx).toContain('**文件内容，不是聊天记录**')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. 引用序号是「位置性」的，与来源无关
// ─────────────────────────────────────────────────────────────────────────────

describe('引用序号与接地：序号对混排列表是位置性的', () => {
  it('parseCitedIndexes 只认位置，不看来源；越界的不算', () => {
    const answer = '合同里写着 12000 元 [2]，聊天里提到过 [1]，另外乱标的 [9] 不算。'
    expect(parseCitedIndexes(answer, 3)).toEqual([1, 2])
    // 同一条被引两次只算一次。
    expect(parseCitedIndexes('[2][2][1]', 2)).toEqual([1, 2])
  })

  it('接地审计对文件块同样有效：文件里有的值放行、没有的报出', () => {
    const kbEvidence = ['知识库文件《蓝鲸合同.md》 第七附则\n    本附则约定：验收款为 12000 元，签约后三十日内支付。']
    expect(auditGrounding('验收款是 12000 元 [1]。', kbEvidence, 1).ok).toBe(true)
    const bad = auditGrounding('验收款是 9000 元 [1]。', kbEvidence, 1)
    expect(bad.ok).toBe(false)
    expect(bad.unsupported.map(v => v.value)).toEqual(['9000元'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. 端到端：gateway.askWechat 的 kbId 透传、依据行口径、库隔离
// ─────────────────────────────────────────────────────────────────────────────

const LISI = 'wxid_lisi'
const GROUP = '12345678@chatroom'

/** 建「能真检索」的消息侧：单聊 + 群 + 联系人/会话表。 */
function seedChatData(): void {
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'contact'), { recursive: true })

  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
  const insC = cdb.prepare('INSERT INTO contact VALUES (?,?,?,0)')
  insC.run(LISI, '李四', '李四')
  insC.run(GROUP, '项目组', '项目组')
  cdb.close()

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insS = sdb.prepare("INSERT INTO SessionTable VALUES (?,?,1700000000,1700000000,0,1,'')")
  insS.run(LISI, '李四')
  insS.run(GROUP, '项目组')
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const table = (u: string): string => 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
  const bodies = new Map<string, Array<[number, string]>>([
    [LISI, [[1, '合同的附件我发你邮箱了，蓝鲸协议那版'], [2, '收到，我今晚看']]],
    [GROUP, [[1, LISI + ':\n合同的模板我改好了，验收款那一栏再确认下']]],
  ])
  for (const [u, rows] of bodies) {
    mdb.exec(`CREATE TABLE "${table(u)}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = mdb.prepare(`INSERT INTO "${table(u)}" VALUES (?,?,1,0,?,1,?,?, '')`)
    rows.forEach(([id, text], i) => ins.run(id, id, 1700000000 + id, text, 'srv' + i))
  }
  mdb.close()
}

/**
 * 只提供 askWechat 真正用到的表面（`llm.stream` + 默认模型）。
 *
 * 带工具清单的是工具选择轮：微信问答留空，交给运行时用 `search_hybrid` 兜底；
 * ClawBot 只允许 `search_kb`，因此显式产出一个知识库检索调用。只有不带工具
 * 清单的综合轮才进入 `replies`，这样回炉调用不会被工具选择分支吞掉。
 */
function makeCtx(replies: string[], embed?: (texts: string[]) => Promise<number[][]>, usage?: { inputTokens: number, outputTokens: number, totalTokens?: number }): { ctx: Context; prompts: string[]; contents: Array<Array<{ type?: string, text?: string, data?: string, mediaType?: string }>>; selectionCalls: () => number } {
  const prompts: string[] = []
  /** 每次「综合生成」用户消息的完整 content（2026-10-18：断言图片块真的进消息）。 */
  const contents: Array<Array<{ type?: string, text?: string, data?: string, mediaType?: string }>> = []
  let synth = 0
  let selections = 0
  const llm = {
    // 只有显式传入时才挂 `embed`：缺省时 `makeEmbedFn` 返回 undefined ⇒ 稠密通道整体降级。
    // 这很重要 —— 否则 C3 引入的出网点会改变本文件其它用例的运行环境（它们都在纯稀疏下断言）。
    ...(embed ? { embed } : {}),
    async *stream(opts: {
      system?: string
      tools?: Array<{ name?: string }>
      messages?: Array<{ content?: Array<{ type?: string, text?: string, data?: string, mediaType?: string }> }>
    }) {
      const toolNames = (opts.tools ?? []).map(tool => String(tool.name ?? ''))
      if (toolNames.length > 0) {
        selections += 1
        // ClawBot 没有 search_hybrid 兜底，必须显式选择唯一允许的 search_kb。
        if (toolNames.includes('search_kb') && !toolNames.includes('search_hybrid')) {
          const question = opts.messages?.[0]?.content?.[0]?.text ?? ''
          // 模拟模型构造可命中的检索词：关键词索引不接受整句自然语言。
          // 金额用例要召回含「验收款」的块，其余合同用例用夹具独有短语。
          const query = question.includes('验收款')
            ? '验收款'
            : question.includes('蓝鲸') ? UNIQUE : question
          const args = JSON.stringify({ query })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' as const }
          yield {
            type: 'tool-call-delta',
            index: 0,
            id: 'call_kb',
            name: 'search_kb',
            argumentsDelta: args,
          }
          yield {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call' as const, id: 'call_kb', name: 'search_kb', arguments: args },
          }
        }
        if (usage) yield { type: 'usage', usage }
        return
      }
      const content = opts.messages?.[0]?.content ?? []
      contents.push(content)
      prompts.push(content[0]?.text ?? '')
      const text = replies[Math.min(synth, replies.length - 1)] ?? ''
      synth += 1
      yield { type: 'text-delta', index: 0, text }
      if (usage) yield { type: 'usage', usage }
    },
  }
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => undefined,
    emit: () => {},
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
  }
  return { ctx: ctx as unknown as Context, prompts, contents, selectionCalls: () => selections }
}

/** 引用的值都能在材料里找到 ⇒ 不触发回炉（只调一次模型，便于断言模型看到的上下文）。 */
const ANSWER = '文件里写着验收款 12000 元 [1]，聊天里也提到过合同附件 [2]。'

/** 装好消息 + 文件的网关（甲库放合同、乙库放别的）。 */
async function gatewayWith(
  kb1File: string,
  reply: string | string[] = ANSWER,
  embed?: (texts: string[]) => Promise<number[][]>,
  usage?: { inputTokens: number, outputTokens: number, totalTokens?: number },
): Promise<{ gw: WechatDataGateway; prompts: string[]; contents: Array<Array<{ type?: string, text?: string, data?: string, mediaType?: string }>>; selectionCalls: () => number }> {
  seedChatData()
  await buildSearchIndex(decrypted, true)
  register('蓝鲸合同.md', kb1File, 1)
  register('玄武纪要.md', '内部纪要：' + OTHER + '。', 2)
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(decrypted, 'decoded_images'))
  const m = makeCtx(Array.isArray(reply) ? reply : [reply], embed, usage)
  return { gw: new WechatDataGateway(m.ctx), prompts: m.prompts, contents: m.contents, selectionCalls: m.selectionCalls }
}

describe('端到端：模型 usage 记账（2026-10-19）', () => {
  it('同一轮问答的多次模型调用累加后随 AskResult 返回', async () => {
    const { gw } = await gatewayWith(contractText(), ANSWER, undefined, {
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    })
    const r = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', kbId: 1 })
    // 实际 3 次：工具选择 + 综合生成 + 接地未通过后的一次回炉，每次 10/5/15。
    // `prompts` 只记录综合生成轮（2 条），不能拿它当总调用数。
    expect(r.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 })
  })
})

describe('端到端：自动回复的图片（2026-10-18）', () => {
  it('mini 宿主没有附件服务：图片块直接进用户消息，由 llm-bridge 投影成 image_url', async () => {
    const { gw, contents } = await gatewayWith(contractText())
    // 网关类的公开类型只暴露客户端会传的字段；`dataScope`/`source` 是 ClawBot 自动回复
    // 直接走 `askDeep.askWechat` 的内部参数，这里用同一形状做白盒断言。
    const ask = gw.askWechat.bind(gw) as unknown as (o: {
      question: string
      kbId?: number
      dataScope?: 'wechat' | 'kb-only'
      source?: string
      history?: Array<{ role: 'user' | 'assistant', content: string }>
      images?: Array<{ data: string, mediaType: string, name?: string }>
    }) => Promise<unknown>
    // dataScope kb-only + 一句「看这张图」：这是 ClawBot 自动回复的真实入口参数形状。
    await ask({
      question: '分析一下图中右边那辆车是什么车？',
      kbId: 1,
      dataScope: 'kb-only',
      source: 'auto',
      history: [
        { role: 'user', content: '[图片]' },
        { role: 'assistant', content: '你好呀，有事吗' },
      ],
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png', name: 'wx-image-7' }],
    })
    // 至少有一次「综合生成」的用户消息带图片块（工具选择轮只有文本）。
    const imageParts = contents.flat().filter((p) => p.type === 'image')
    expect(imageParts.length).toBeGreaterThan(0)
    expect(imageParts[0]?.data).toBe('aGVsbG8=')
    expect(imageParts[0]?.mediaType).toBe('image/png')
  })
})

describe('端到端：自动回复的接地协议（2026-10-20）', () => {
  type AutoAsk = (o: {
    question: string
    kbId?: number
    dataScope?: 'wechat' | 'kb-only'
    source?: string
    images?: Array<{ data: string, mediaType: string, name?: string }>
  }) => Promise<{
    answer: string
    basis?: string
    insufficient?: boolean
    status?: string
    withheld?: boolean
    grounding?: { checked: number, unsupported: string[], cited: number, repaired: boolean }
  }>

  it('未启用知识库时在工具选择前阻断，不调用模型或工具', async () => {
    const { gw, prompts, contents, selectionCalls } = await gatewayWith(contractText(), '不应被调用')
    const ask = gw.askWechat.bind(gw) as unknown as AutoAsk
    const r = await ask({
      question: '在吗',
      dataScope: 'kb-only',
      source: 'auto',
    })
    expect(selectionCalls()).toBe(0)
    expect(prompts).toHaveLength(0)
    expect(contents).toHaveLength(0)
    expect(r.answer).toContain('未选择知识库')
    expect(r.status).toBe('blocked')
    expect(r.insufficient).toBe(false)
  })

  it('禁止角标的自然回复不再被强制回炉或拒答，金额仍能通过接地核对', async () => {
    const natural = '验收款是 12000 元，签约后三十日内支付。'
    const { gw, prompts } = await gatewayWith(contractText(), natural)
    const ask = gw.askWechat.bind(gw) as unknown as AutoAsk
    const r = await ask({
      question: '蓝鲸协议第七附则里的验收款是多少',
      kbId: 1,
      dataScope: 'kb-only',
      source: 'auto',
    })
    // 工具选择调用不计入 prompts；这里只有一次综合生成，说明没有因缺 [n] 而回炉。
    expect(prompts).toHaveLength(1)
    expect(r.answer).toBe(natural)
    expect(r.answer).not.toMatch(/\[\d+\]/)
    expect(r.withheld).toBeUndefined()
    expect(r.grounding?.unsupported).toEqual([])
    expect(r.basis).toContain('依据知识库')
    expect(r.basis).not.toContain('依据本机记录')
  })

  it('无出处的金额触发一次自然口吻重写，重写轮仍携带原图片', async () => {
    const first = '验收款是 9000 元。'
    const fixed = '验收款我这边没法确认，我先问下本人。'
    const { gw, prompts, contents } = await gatewayWith(contractText(), [first, fixed])
    const ask = gw.askWechat.bind(gw) as unknown as AutoAsk
    const r = await ask({
      question: '蓝鲸协议第七附则里的验收款是多少',
      kbId: 1,
      dataScope: 'kb-only',
      source: 'auto',
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png', name: 'wx-image-9' }],
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toContain('必须紧跟对应的 [n]')
    expect(r.answer).toBe(fixed)
    expect(r.grounding?.repaired).toBe(true)
    expect(r.grounding?.unsupported).toEqual([])
    expect(r.withheld).toBeUndefined()
    // 首答与回炉都必须带图；否则视觉问题在重写时已经看不到原图。
    expect(contents).toHaveLength(2)
    for (const content of contents) {
      expect(content.some(p => p.type === 'image' && p.data === 'aGVsbG8=')).toBe(true)
    }
  })

  it('重写后仍有编造数字时不把内部审计文案发到微信，改用自然兜底', async () => {
    const ghost = '验收款是 9000 元。'
    const { gw } = await gatewayWith(contractText(), [ghost, ghost])
    const ask = gw.askWechat.bind(gw) as unknown as AutoAsk
    const r = await ask({
      question: '蓝鲸协议第七附则里的验收款是多少',
      kbId: 1,
      dataScope: 'kb-only',
      source: 'auto',
    })
    expect(r.withheld).toBe(true)
    expect(r.answer).toBe('这个数字我这边没法确认，我先问下本人。')
    expect(r.answer).not.toContain('审计')
    expect(r.answer).not.toContain('证据')
    expect(r.answer).not.toContain('9000')
  })
})

describe('端到端：问答接入知识库（kbId 透传 / 依据行口径 / 库隔离）', () => {
  it('消息与文件同时被引用；依据行只把消息算会话，文件另按文件数单列', async () => {
    const { gw, prompts } = await gatewayWith(contractText())
    const r = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', kbId: 1 })

    const kbCites = r.citations.filter(c => c.source === 'kb')
    const msgCites = r.citations.filter(c => c.source !== 'kb' && c.source !== 'agg' && c.source !== 'resource')
    // 两半都要成立，否则下面「会话数只数消息」的断言是空转（0 个会话也是 0 个）。
    expect(kbCites.length).toBeGreaterThan(0)
    expect(msgCites.length).toBeGreaterThan(0)

    const kb = kbCites[0]!
    expect(kb.kb?.kbId).toBe(1)
    expect(kb.kb?.fileName).toBe('蓝鲸合同.md')
    expect(kb.kb?.chunkId).toBeGreaterThan(0)
    // 归因键必须能由引用复算出来（与检索侧 docKey 同一套规则）。
    expect(citationDocKey(kb)).toBe(`kb:1:${kb.kb!.chunkId}`)
    // 统一运行时的公开引用不再把知识库伪装成会话；文件身份由 `kb` 明细承载。
    expect(kb.username).toBe('')

    const msgSessions = new Set(msgCites.map(c => c.username ?? '')).size
    const kbFiles = new Set(kbCites.map(c => c.kb?.fileId)).size
    expect(r.basis).toContain(`${msgSessions} 个会话`)
    expect(r.basis).toContain(`${kbFiles} 个知识库文件`)
    // 把 KB 也当成会话时的那个数，必须**不**出现。
    expect(r.basis).not.toContain(`${msgSessions + 1} 个会话`)
    expect(r.basis).toContain(`${msgCites.length} 条聊天原文`)
    // 原文数只等于聊天消息数；不能把 KB 块混进「条原文」。
    expect(r.basis).not.toContain(`${r.citations.length} 条聊天原文`)
    expect(r.basis).toContain('回答引用了其中')

    // 模型看到的上下文里，文件块被显式标注来源域。
    // 断言的是**第一次**综合调用收到的上下文（若触发回炉，prompts 会有第二条，但第二条是在
    // 第一条之上追加的指令，本条断言不依赖它）。
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts[0]).toContain('**文件内容，不是聊天记录**')
    expect(prompts[0]).toContain('蓝鲸合同.md')
  }, 60_000)

  it('kbId 缺省 / 非法 → 不检索文件，但消息侧问答照常（降级而不是失败）', async () => {
    const { gw } = await gatewayWith(contractText())
    for (const options of [{}, { kbId: 0 }, { kbId: -3 }, { kbId: Number.NaN }]) {
      const r = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', ...options })
      expect(r.citations.some(c => c.source === 'kb')).toBe(false)
      expect(r.citations.length).toBeGreaterThan(0)
      expect(r.basis).not.toContain('个知识库文件')
    }
  }, 90_000)

  it('库隔离：同一问题在甲库召回甲库文件，切到乙库看不到甲库的块', async () => {
    const { gw } = await gatewayWith(contractText())

    const inA = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', kbId: 1 })
    expect(inA.citations.some(c => c.source === 'kb' && c.kb?.fileName === '蓝鲸合同.md')).toBe(true)

    const inB = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', kbId: 2 })
    // 反向一半：乙库**确实**有可搜内容（换个词就能搜到），所以「搜不到甲库的块」不是空集。
    const other = await gw.askWechat({ question: OTHER, kbId: 2 })
    expect(other.citations.some(c => c.source === 'kb' && c.kb?.fileName === '玄武纪要.md')).toBe(true)
    expect(inB.citations.some(c => c.source === 'kb' && c.kb?.kbId === 1)).toBe(false)
  }, 90_000)

  it('回答里的文件引用照常过接地审计（无出处的值会被报出）', async () => {
    const { gw } = await gatewayWith(contractText(), '验收款是 9000 元 [1]。')
    const r = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', kbId: 1 })
    expect(r.grounding?.unsupported).toContain('9000元')
  }, 60_000)

  // ── C3：知识库建索引是**新的出网点**，必须过闸门、必须留下可分辨的审计 ──
  it('知识库建索引：文件正文经 kb_embed 闸门出网，且不许出网的正文从未出网', async () => {
    /** 桩 embedding：字符直方图（与 kb-vectors.spec 同一套，只为让管线跑通）。 */
    const seen: string[] = []
    const embed = async (texts: string[]): Promise<number[][]> => {
      seen.push(...texts)
      return texts.map((t) => {
        const v = new Array<number>(16).fill(0)
        for (const ch of t) { const k = (ch.codePointAt(0) ?? 0) % 16; v[k] = (v[k] ?? 0) + 1 }
        return v
      })
    }
    const { gw } = await gatewayWith(contractText(), ANSWER, embed)
    // 甲库里再放一份**明确关闭**「参与 RAG」的文件：它的正文一次都不该被送去出网。
    register('机密.md', '内部资料。' + SECRET + '。', 1, false)

    const r = await gw.askWechat({ question: '蓝鲸协议第七附则里的验收款是多少', kbId: 1 })
    expect(r.citations.some(c => c.source === 'kb')).toBe(true)

    // ① 参与 RAG 的文件块正文**确实**被送去了 embedding（不是「建了个空索引」）
    const sent = seen.join('\n')
    expect(sent, '文件块正文没有出现在 embedding 的输入里').toContain(UNIQUE)
    // ② 关掉「参与 RAG」的文件正文**从未**出网 —— 这是用户对「这份不许送进模型」的显式表态
    expect(sent, '不许出网的正文被送去了 embedding').not.toContain(SECRET)
    // ③ 审计里出现独立的功能名 kb_embed（与消息侧的 ask_embed 分开记，
    //    否则「我把哪一类数据发出去了」在审计表里分不开）
    const feats = getPrivacyStateSnapshot(decrypted).audit.byFeature.map(f => f.feature)
    expect(feats, 'kb_embed 没有进审计：出网点绕过了隐私闸门').toContain('kb_embed')
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// G. 默认配置：这是一条「条件通道」，默认开着且每个意图策略都带它
// ─────────────────────────────────────────────────────────────────────────────

describe('默认配置：kb 是条件通道', () => {
  it('默认开启；所有意图策略的通道表里都有 kb', () => {
    expect(defaultRetrievalConfig().channels.kb.enabled).toBe(true)
    const intents: IntentKind[] = ['recency_lookup', 'entity_lookup', 'time_range', 'aggregation', 'comparison', 'open_qa']
    for (const intent of intents) {
      const policy = defaultPolicyFor(intent)
      expect(policy.channels).toContain('kb')
      expect(policy.channelTopK.kb).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// H. dataScope=kb-only：聚合通道不得读本机消息，知识库通道仍须工作
// ─────────────────────────────────────────────────────────────────────────────

describe('kb-only 数据面隔离：聚合通道', () => {
  it('聚合意图不执行 runAggregate，知识库命中照常返回', async () => {
    seedChatData()
    expect((await buildSearchIndex(decrypted, true)).status).toBe('ok')
    register('蓝鲸合同.md', contractText(), 1)

    const base = {
      decryptedDir: decrypted,
      question: '我一共收到多少份蓝鲸协议合同？',
      subQueries: ['蓝鲸协议', '合同'],
      limit: 10,
      config: defaultRetrievalConfig(),
      kbId: 1,
    }

    // 对照：同一夹具在允许微信数据时确实会产出聚合事实，证明下面的空结果不是空转。
    const wechat = await runRetrievalPipeline(base)
    expect(wechat.stats.intent).toBe('aggregation')
    expect(wechat.stats.channels.some(c => c.channel === 'agg')).toBe(true)

    const kbOnly = await runRetrievalPipeline({ ...base, wechatDataEnabled: false })
    expect(kbOnly.stats.intent).toBe('aggregation')
    expect(kbOnly.stats.channels.some(c => c.channel === 'agg')).toBe(false)
    expect(kbOnly.stats.channels.find(c => c.channel === 'kb')?.active).toBe(true)
    expect(kbOnly.citations.length).toBeGreaterThan(0)
    // PipelineOutput.citations 的公开形状不带 source；KB 引用的 username 恒为 `kb:<id>:<fileId>`。
    expect(kbOnly.citations.every(c => c.username.startsWith('kb:1:'))).toBe(true)
  })
})
