/**
 * 知识库文件的**模型摘要**（`summarizeKbFile`）回归用例。
 *
 * 这是一条出网调用，所以这里守的重点不是「摘要写得好不好」（那没法测），而是
 * **什么情况下绝不能发出去**，以及**发出去的东西是否如实报告了覆盖范围**：
 *   ① 「禁止 AI 出网」必须在**任何模型调用之前**判 —— 早于「未配置模型」那类早退。
 *      这条顺序是有实测前例的（第 59 轮）：先判模型会让用户看到「AI 不可用」，
 *      把「拦截真的生效了」这件事盖掉。单看一条早退测不出顺序，故另有一条
 *      「两个条件同时踩住」的用例（见下方「既开了…又没配模型」）。
 *   ② 关掉「参与语义检索（会出网）」的文件必须被拒绝，且**一次请求都不发**。
 *      那个开关的语义就是「这份文件永不出网」，为它生成摘要等于推翻用户的决定。
 *   ③ 只喂前若干字时，`coveredChars` 必须如实小于 `totalChars` —— 界面靠它标出
 *      「这只是前 N 字的摘要」。少了这个标注，局部概括就会顶着「摘要」的名字
 *      被当成整份文件的结论。
 *   ④ 迁移：已经发出去的库里 `kb_files` 没有那四列，加列必须幂等且不破坏既有行。
 *
 * LLM 用桩（与 `summary-run-due.spec.ts` 同一技术）：不联网，`calls` 里存着
 * 每一次真实发出去的 prompt —— 断言「没发出去」就是断言 `calls.length === 0`。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { readPrivacySettings, writePrivacySettings } from '../src/query/privacy-audit.ts'
import { openStore } from '../src/query/kb-files.ts'
import { kbFilesDbPath } from '../src/query/kb-paths.ts'

let root = ''
let decrypted = ''
let srcDir = ''
let disposers: Array<() => void> = []

interface LlmStub { calls: string[]; stream: (opts: unknown) => AsyncGenerator<{ type: string; index: number; text: string }> }

/** 桩 LLM：把每次收到的 prompt 原文记下来，回一段可辨认的文本。 */
function stubLlm(): LlmStub {
  const calls: string[] = []
  return {
    calls,
    // eslint-disable-next-line require-yield
    stream: async function* (o: unknown): AsyncGenerator<{ type: string; index: number; text: string }> {
      const msgs = (o as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []
      calls.push(msgs[0]?.content?.[0]?.text ?? '')
      yield { type: 'text-delta', index: 0, text: '· 要点一\n· 要点二' }
    },
  }
}

function fakeCtx(llm: unknown, withModel = true): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
    llm,
    // withModel=false 复刻「用户还没配模型」：整个 agentDefaultModel 能力不存在
    ...(withModel ? { agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) } } : {}),
  } as unknown as Context
}

let gw: WechatDataGateway
let llm: LlmStub
let kbId = 0

/** 登记一个文件并返回它的 id。 */
function addFile(name: string, content: string, includeInRag = true): number {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  const r = gw.addKbFiles({ kbId, paths: [p], includeInRag })
  if (!r.ok) throw new Error(`夹具登记失败：${r.error ?? '?'} / ${JSON.stringify(r.results)}`)
  const list = gw.getKbFiles(kbId, { limit: 500 })
  const hit = list.items.find(f => f.name === name)
  if (hit === undefined) throw new Error(`夹具里找不到 ${name}`)
  return hit.id
}

/** 直接查库看落库结果（绕开一切界面/缓存假设）。 */
function rowOf(id: number): Record<string, unknown> {
  const db = new DatabaseSync(kbFilesDbPath(decrypted))
  try {
    return db.prepare('SELECT * FROM kb_files WHERE id = ?').get(id) as Record<string, unknown>
  } finally {
    db.close()
  }
}

/** 某个 db 文件里 `kb_files` 的列名（迁移断言只看 schema，不看任何读路径的默认值兜底）。 */
function legacyColumns(file: string): string[] {
  const db = new DatabaseSync(file)
  try {
    return (db.prepare('PRAGMA table_info(kb_files)').all() as Array<Record<string, unknown>>)
      .map(r => String(r['name']))
  } finally {
    db.close()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-kbsum-'))
  decrypted = join(root, 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  llm = stubLlm()
  gw = new WechatDataGateway(fakeCtx(llm))
  kbId = Number(gw.createKb({ name: '摘要测试库' }).id)
})

afterEach(() => {
  for (const d of disposers) { try { d() } catch { /* 已释放 */ } }
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('summarizeKbFile：出网闸门', () => {
  it('开了「禁止 AI 出网」时一次请求都不发，且说的是拦截而不是别的', async () => {
    const id = addFile('a.md', '# 标题\n内容一\n内容二')
    writePrivacySettings(decrypted, { ...readPrivacySettings(decrypted), blockOutbound: true })
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('出站拦截')
    // 这条是重点：拦截必须在模型调用**之前**
    expect(llm.calls).toEqual([])
    expect(rowOf(id).summary).toBe('')
  })

  it('关掉「参与语义检索（会出网）」的文件被拒绝，且不发请求', async () => {
    const id = addFile('private.md', '# 合同\n金额 100 万')
    const off = gw.setKbFileRag({ kbId, id, includeInRag: false })
    expect(off.ok).toBe(true)
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('不得离开本机')
    expect(llm.calls).toEqual([])
  })

  it('未配置模型时报的是「未配置默认模型」，而不是笼统的失败', async () => {
    const id = addFile('b.md', '# 标题\n正文')
    gw = new WechatDataGateway(fakeCtx(stubLlm(), false))
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('未配置默认模型')
  })

  // 上面两条各测一个早退，但测不出**先后**：两个条件同时踩住才钉得住顺序。
  it('既开了出站拦截、又没配模型时，说的是拦截而不是「模型不可用」', async () => {
    const id = addFile('order.md', '# 标题\n正文')
    writePrivacySettings(decrypted, { ...readPrivacySettings(decrypted), blockOutbound: true })
    const noModel = stubLlm()
    gw = new WechatDataGateway(fakeCtx(noModel, false))
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('出站拦截')
    expect(r.error ?? '').not.toContain('未配置默认模型')
    expect(noModel.calls).toEqual([])
  })

  it('放行时过了隐私审计：审计表里能看到 kb_file_summary 这个独立功能名', async () => {
    const id = addFile('c.md', '# 标题\n正文内容')
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(true)
    const snap = gw.getPrivacyState()
    expect(snap.audit.byFeature.some(x => x.feature === 'kb_file_summary')).toBe(true)
  })
})

describe('summarizeKbFile：发出去的内容与落库', () => {
  it('prompt 里确实带着文件名与正文（不是只发个标题让模型编）', async () => {
    const id = addFile('项目计划书.md', '# 项目背景\n交付节奏是每周三出候选版本')
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(true)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toContain('项目计划书.md')
    expect(llm.calls[0]).toContain('每周三出候选版本')
  })

  it('摘要连同模型名与时间落库，并被列表读回来', async () => {
    const id = addFile('d.md', '# 标题\n一段足够长的正文用来看摘要有没有真的写进去')
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(true)
    const row = rowOf(id)
    expect(String(row.summary)).toContain('要点一')
    expect(String(row.summary_model)).toBe('stub/stub-model')
    expect(Number(row.summary_at)).toBeGreaterThan(0)
    const back = gw.getKbFiles(kbId, { limit: 500 }).items.find(f => f.id === id)
    expect(back?.summary).toContain('要点一')
    expect(back?.summaryModel).toBe('stub/stub-model')
  })

  it('超长文件只喂前若干字，且如实报告 covered < total', async () => {
    // 8,000 是摘要预算（SUMMARY_INPUT_CHARS）。夹具要明显越过它，否则这条会在
    // 「碰巧没截断」的情况下绿灯 —— 所以先断言总字数本身 > 8,000 再断言被截。
    const big = Array.from(
      { length: 220 },
      (_, i) => `第 ${i} 段：${'很长的中文正文内容用于撑满分块预算'.repeat(4)}`,
    ).join('\n')
    const id = addFile('big.md', big)
    const before = gw.getKbFiles(kbId, { limit: 500 }).items.find(f => f.id === id)
    expect((before?.charCount ?? 0)).toBeGreaterThan(8000)
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(true)
    expect(r.coveredChars ?? 0).toBeLessThanOrEqual(8000)
    expect(r.coveredChars ?? 0).toBeLessThan(r.totalChars ?? 0)
    // 被截断这件事必须写进 prompt：模型不知道切过，就会理直气壮地概括「全文要点」
    expect(llm.calls[0]).toContain('已截断')
    // 而且必须**落库**。界面读的是列表行（回参只活在这次调用里），
    // 只回不存的话「这只是前 N 字的摘要」那句提示在下次进页面时就消失了。
    const row = rowOf(id)
    expect(Number(row.summary_covered_chars)).toBe(r.coveredChars)
    expect(Number(row.summary_covered_chars)).toBeLessThan(Number(row.char_count))
  })

  it('没有正文块的文件不发起调用（解析失败时不该送一份空内容出去）', async () => {
    const id = addFile('e.md', '# 只有标题')
    // 把块清掉，模拟「登记成功但没有任何正文」
    const db = new DatabaseSync(kbFilesDbPath(decrypted))
    db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(id)
    db.prepare("UPDATE kb_files SET chunk_count = 0, char_count = 0, summary = '', summary_at = 0 WHERE id = ?").run(id)
    db.close()
    const r = await gw.summarizeKbFile({ kbId, id })
    expect(r.ok).toBe(false)
    expect(llm.calls).toEqual([])
  })

  it('拿别的库的 kbId 来摘要 → 拒绝，且不覆盖那一行', async () => {
    const id = addFile('f.md', '# 标题\n正文')
    const other = Number(gw.createKb({ name: '另一个库' }).id)
    const r = await gw.summarizeKbFile({ kbId: other, id })
    expect(r.ok).toBe(false)
    expect(llm.calls).toEqual([])
    expect(String(rowOf(id).summary)).toBe('')
  })
})

describe('kb_files 摘要列的迁移', () => {
  // 单独一份数据根：`beforeEach` 已经把 `root/wechat_kb_files.db` 建好了（当前形状），
  // 在这里就地 CREATE TABLE 只会撞「table already exists」，而那份「老库」也就此变成
  // 一个从未存在过的假设。所以另起一个目录，让 openStore 面对真正的旧文件。
  // 路径口径注意：kbFilesDbPath 取的是 `dirname(decryptedDir)`，所以 decryptedDir
  // 必须是 legacyRoot 的**子目录**，否则又会写到 root 里那份真库上。
  it('老库（没有那四列）打开后自动补列，既有行不被破坏', () => {
    const legacyRoot = join(root, 'legacy')
    const legacyDecrypted = join(legacyRoot, 'decrypted')
    mkdirSync(legacyDecrypted, { recursive: true })
    const file = kbFilesDbPath(legacyDecrypted)

    // 手工建一份**改动之前**的形状：没有 summary / summary_model / summary_at / summary_covered_chars
    const old = new DatabaseSync(file)
    old.exec(
      'CREATE TABLE kb_files ('
      + 'id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id INTEGER NOT NULL DEFAULT 1, '
      + "name TEXT NOT NULL DEFAULT '', ext TEXT NOT NULL DEFAULT '', src_path TEXT NOT NULL DEFAULT '', "
      + "sha256 TEXT NOT NULL DEFAULT '', blob_name TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0, "
      + "parse_state TEXT NOT NULL DEFAULT 'queued', parser TEXT NOT NULL DEFAULT '', parse_error TEXT NOT NULL DEFAULT '', "
      + 'chunk_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0, '
      + 'include_in_rag INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    )
    old.exec("INSERT INTO kb_files (id, kb_id, name, chunk_count, char_count, created_at, updated_at) VALUES (7, 1, '旧行.md', 3, 900, 1, 1)")
    old.close()
    expect(legacyColumns(file)).not.toContain('summary')

    // 走一次正常打开路径（openStore → migrate）
    const up = openStore(legacyDecrypted)
    try {
      expect(legacyColumns(file)).toEqual(expect.arrayContaining(
        ['summary', 'summary_model', 'summary_at', 'summary_covered_chars'],
      ))
      const row = up.prepare('SELECT name, char_count, summary, summary_covered_chars FROM kb_files WHERE id = 7')
        .get() as Record<string, unknown>
      expect(row.name).toBe('旧行.md')
      expect(Number(row.char_count)).toBe(900) // NOT NULL DEFAULT 把既有行一次性置空串，不动别的列
      expect(String(row.summary)).toBe('')
      expect(Number(row.summary_covered_chars)).toBe(0)
    } finally {
      up.close()
    }

    // 再开一次：ALTER 不幂等的话这里就直接抛 duplicate column（用例随之变红）。
    // 连接随手关掉 —— Windows 上留着句柄会让 afterEach 的 rmSync 报 EPERM。
    const again = openStore(legacyDecrypted)
    again.close()
    expect(legacyColumns(file)).toContain('summary')
  })
})
