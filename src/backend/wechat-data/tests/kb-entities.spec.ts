/**
 * 文档实体层的单元测试。
 *
 * 覆盖两件事，缺一不可：
 *   ① `normalizeHeading` 的规则 —— 用例全部取自**真机库里实测到的 heading 原文**
 *      （12 份测试文档 / 29 个分块跑出来的那一组），不是编的理想值。空串、`（续 N）`、
 *      `列名 姓名⇥部门⇥…` 这三种噪音都是真实存在的，规则必须对它们成立。
 *   ② `readDocEntities` / `findFilesMentioning` 的 SQL —— 用真 schema 建临时库。
 *      走 `openStore()` 而不是在这里手抄一份 `CREATE TABLE`：抄来的 schema 会与
 *      `kb-files.ts` 各自漂移，而漂移的后果（列名变了、FTS 建法变了）恰好是这两条
 *      查询最容易坏的地方，测试却照样绿。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openStore } from '../src/query/kb-files.ts'
import { bigramTokens } from '../src/query/search.ts'
import {
  DOC_NODE_PREFIX, MAX_SECTIONS_PER_FILE, FILE_NODE_PREFIX,
  findFilesMentioning, normalizeHeading, readDocEntities,
} from '../src/query/kb/entities.ts'

describe('normalizeHeading：真机实测过的 heading 形态', () => {
  it('正常章节标题原样保留', () => {
    expect(normalizeHeading('二、里程碑')).toBe('二、里程碑')
    expect(normalizeHeading('一、项目背景')).toBe('一、项目背景')
    expect(normalizeHeading('HTML 测试文件')).toBe('HTML 测试文件')
  })

  it('取 `›` 的末段：键里不能带各文件自己的文档名，否则跨文件合并不了', () => {
    // 实测原文 `测试说明文档（Markdown） › 简介`。留全串的话，任何文档的「简介」
    // 都只会和自己的文档名绑在一起，这一层最有价值的跨文档连接就没了。
    expect(normalizeHeading('测试说明文档（Markdown） › 简介')).toBe('简介')
    expect(normalizeHeading('三、成员 › 列名 角色\t姓名')).toBe(null)
  })

  it('剥掉硬切产生的 `（续 N）` 后缀', () => {
    expect(normalizeHeading('二、里程碑（续 2）')).toBe('二、里程碑')
    // 整条 heading 本来就空时，withContinuation 会产出光秃秃的 `（续 3）` —— 它不是一节的名字。
    expect(normalizeHeading('（续 3）')).toBe(null)
    expect(normalizeHeading('（续 2）')).toBe(null)
  })

  it('丢弃表格列名摘要（xlsx / csv）：它描述表结构，且含制表符', () => {
    expect(normalizeHeading('员工名单 › 列名 姓名\t部门\t工号\t月薪\t入职日期')).toBe(null)
    expect(normalizeHeading('列名 姓名,部门,工号,月薪,入职日期')).toBe(null)
  })

  it('空值与长度越界都不成为节点', () => {
    expect(normalizeHeading('')).toBe(null)
    expect(normalizeHeading('   ')).toBe(null)
    expect(normalizeHeading('要')).toBe(null)
    expect(normalizeHeading('x'.repeat(41))).toBe(null)
    expect(normalizeHeading('x'.repeat(40))).toBe('x'.repeat(40))
  })
})

describe('readDocEntities / findFilesMentioning：真 schema 的临时库', () => {
  let dir = ''
  let db: DatabaseSync

  const KB = 16
  const OTHER_KB = 17

  /** 插一个文件；`chunks` 是 `[heading, text]` 列表。 */
  function seedFile(id: number, kbId: number, name: string, chunks: Array<[string, string]>): void {
    // `sha256` 必须逐文件唯一：库上有 `UNIQUE(kb_id, sha256)`（去重按**内容**而不是文件名），
    // 全填空串会让第二个文件起就撞约束 —— 那正好是这条索引该拦下来的情形。
    const sha = String(id).padStart(64, '0')
    db.prepare(
      'INSERT INTO kb_files (id, kb_id, name, ext, src_path, sha256, blob_name, size_bytes, '
      + "parse_state, parser, parse_error, chunk_count, char_count, include_in_rag, created_at, updated_at) "
      + `VALUES (${id}, ${kbId}, '${name}', 'txt', '', '${sha}', '', 0, 'ready', '', '', ${chunks.length}, 0, 1, 1, 1)`,
    ).run()
    chunks.forEach(([heading, text], i) => {
      const r = db.prepare(
        'INSERT INTO kb_chunks (file_id, kb_id, ordinal, text, tokens, char_count, page, heading) '
        + 'VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
      ).run(id, kbId, i, text, bigramTokens(text), heading)
      db.prepare('INSERT INTO kb_chunks_fts(rowid, tokens, heading_tokens) VALUES (?, ?, ?)')
        .run(Number(r.lastInsertRowid), bigramTokens(text), bigramTokens(heading))
    })
  }

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'kb-entities-'))
    // ⚠ 传进去的必须是 `<数据根>/decrypted` 这一层，而不是数据根本身：
    // `kbFilesDbPath()` 取的是 `dirname(decryptedDir)`（产物与 `decrypted/` 同级，
    // 见 `kb-paths.ts` 的口径注释）。直接把临时根传进来，库就会落到**系统临时目录**，
    // 于是每一次测试运行都复用同一个 `%TEMP%/wechat_kb_files.db` —— 第二次运行起
    // 全部 INSERT 撞 UNIQUE，症状看起来像产品代码错了，其实是夹具走漏到了共享目录。
    dir = join(root, 'decrypted')
    db = openStore(dir)
    seedFile(37, KB, '项目计划书.docx', [
      ['一、项目背景', '本项目用于验证交付节奏与预算约束。'],
      ['二、里程碑', '第一个里程碑在三月底完成候选版本。'],
      ['二、里程碑（续 2）', '第二个里程碑在六月底完成冻结。'],
      ['测试说明文档（Markdown） › 简介', '简介部分说明验收标准。'],
    ])
    seedFile(38, KB, '验收标准.md', [
      ['', '这份文件没有结构，只有一个块。'],
      ['简介', '验收标准由测试组维护。'],
    ])
    seedFile(39, KB, '无结构.pdf', [['', '整份文档解析出来只有一个块，没有标题。']])
    seedFile(40, OTHER_KB, '别的库.txt', [['跨库章节', '这一节属于另一个库。']])
  })

  afterAll(() => {
    db.close()
    // 删的是**数据根**（库在 `dirname(decryptedDir)`，删 decrypted 子目录会留一个空库在临时目录里）
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  it('文件节点齐全，且只含当前库', () => {
    const { files } = readDocEntities(db, KB)
    // 只断言成员，不锁顺序：真实排序是 `created_at DESC, id DESC`，而夹具里 created_at
    // 全相同，顺序就成了「按 id 倒序」—— 锁它等于把一条实现细节写成契约。
    expect(files.map(f => f.id).sort()).toEqual([37, 38, 39])
    expect(files.find(f => f.id === 37)?.label).toBe('项目计划书.docx')
    expect(files.find(f => f.id === 37)?.ext).toBe('txt')
  })

  it('空 heading 不成节点；`（续 N）` 与母题合并；跨文件同名章节归并成一个', () => {
    const { sections } = readDocEntities(db, KB)
    const keys = sections.map(s => s.key)
    expect(keys).not.toContain('')
    // 「二、里程碑」出现 3 次：母题一次、`（续 2）` 归并一次、另一份文件的「简介」独立。
    const milestone = sections.find(s => s.key === '二、里程碑')
    expect(milestone?.occurrences).toBe(2)
    expect(milestone?.files.map(f => f.id)).toEqual([37])
    // 带文档名前缀的「简介」与另一份文件里裸的「简介」必须归并成同一个节点 ——
    // 这正是取末段的意义。
    const intro = sections.find(s => s.key === '简介')
    expect(intro?.files.map(f => f.id).sort()).toEqual([37, 38])
    expect(intro?.occurrences).toBe(2)
    expect(keys).toContain('一、项目背景')
  })

  it('节点 id 前缀由调用方拼，本层只给归一化键', () => {
    expect(DOC_NODE_PREFIX).toBe('doc:')
    expect(FILE_NODE_PREFIX).toBe('file:')
    const { sections } = readDocEntities(db, KB)
    expect(sections.every(s => !s.key.startsWith(DOC_NODE_PREFIX))).toBe(true)
  })

  it('每文件章节数有上限，且上限是按文件算的', () => {
    const many: Array<[string, string]> = []
    for (let i = 0; i < MAX_SECTIONS_PER_FILE + 10; i += 1) many.push([`章节${i}标题`, `正文${i}`])
    seedFile(41, KB, '超长.docx', many)
    const { sections } = readDocEntities(db, KB)
    const big = sections.filter(s => s.files.some(f => f.id === 41))
    expect(big.length).toBe(MAX_SECTIONS_PER_FILE)
    // 别的文件不受影响：上限若是全局的，这里就会一起被截掉。
    expect(sections.find(s => s.key === '简介')?.files.map(f => f.id)).toContain(37)
    db.prepare('DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE file_id = 41)').run()
    db.prepare('DELETE FROM kb_chunks WHERE file_id = 41').run()
    db.prepare('DELETE FROM kb_files WHERE id = 41').run()
  })

  it('不串库：另一个库的章节与文件都不许出现在这里', () => {
    const { sections, files } = readDocEntities(db, KB)
    expect(sections.map(s => s.key)).not.toContain('跨库章节')
    expect(files.map(f => f.id)).not.toContain(40)
    const other = readDocEntities(db, OTHER_KB)
    expect(other.sections.map(s => s.key)).toContain('跨库章节')
  })

  it('findFilesMentioning 命中正文与标题，且按库过滤', () => {
    expect(findFilesMentioning(db, KB, '验收标准').sort()).toEqual([37, 38])
    expect(findFilesMentioning(db, KB, '候选版本')).toEqual([37])
    expect(findFilesMentioning(db, KB, '跨库章节')).toEqual([])
    expect(findFilesMentioning(db, OTHER_KB, '跨库章节')).toEqual([40])
  })

  it('没有可检索字词时返回空而不是抛（单字标题会被 bigram 切成无意义查询）', () => {
    expect(findFilesMentioning(db, KB, '')).toEqual([])
    expect(findFilesMentioning(db, KB, '！？。')).toEqual([])
  })
})
