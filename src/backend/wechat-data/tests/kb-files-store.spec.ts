/**
 * 知识库文件存储（`query/kb-files.ts`）的回归用例。
 *
 * 这一支是**碰盘的**（sqlite + 文件系统），所以每个用例都在自己的临时数据根里
 * 造一套真夹具：真文件、真副本、真库。断言全部落在**可观察的事实**上
 * （库里有几行、副本还在不在、原文件有没有被动过），而不是内部函数调过几次。
 *
 * 钉的五件事（对齐计划 §2.1 的 T2 验收）：
 *   ① 同库按**内容**（sha256）去重，跨库允许同内容；
 *   ② `ready` 与它的 chunk 行**同事务** —— 用「让 FTS 写入必然失败」来证伪：
 *      结构不对的 FTS 表不会被 `migrate` 重建（`IF NOT EXISTS` 认得它），
 *      于是插入必抛，此时 `kb_files` 里不该留下那一行；
 *   ③ 删除级联**顺序**（chunks → FTS → 向量 → blob → 登记）且删完**不碰 `src_path`**；
 *   ④ 崩溃恢复**只在进程启动时重置一次**（同根第二次 skipped）；
 *   ⑤ 跨库副本共用：删一个库的文件不删副本，删到最后一个引用才删。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_FILE_PAGE,
  KB_FILE_DELETE_ORDER,
  MAX_CHUNK_PAGE,
  MAX_FILES_PER_KB,
  countKbFiles,
  countKbFilesByKb,
  deleteKbFile,
  kbBlobsDir,
  kbFilesDbPath,
  kbFilesOnKbDelete,
  listKbFileChunks,
  listKbFiles,
  openStore,
  recoverInterrupted,
  registerKbFile,
  resetRecoveryGuardForTest,
  setKbFileRagFlag,
} from '../src/query/kb-files.ts'
import { at } from '../../tests/helpers/strict-index.ts'

let root = ''
/** 数据根（库与 blob 都落在它下面）。 */
let dataRoot = ''
/** 解密目录（只是数据根的兄弟，用来确定库的相对位置）。 */
let decrypted = ''
/** 原文件目录（模拟「用户电脑上的某处」）。 */
let srcDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-files-'))
  dataRoot = join(root, 'data')
  decrypted = join(dataRoot, 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  // 每个用例都是「一次全新的进程启动」：把「只做一次」的记忆清掉，
  // 否则用例之间的顺序会影响崩溃恢复的断言。
  resetRecoveryGuardForTest()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个真文件，返回它的路径。 */
function fixture(name: string, content: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

/** 直接开库做原始断言（表已由上一次 `registerKbFile` 建好）。 */
function raw(): DatabaseSync {
  return new DatabaseSync(kbFilesDbPath(decrypted))
}

/** 某个文件行现有多少条 chunk。 */
function chunkCountOf(fileId: number): number {
  const db = raw()
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE file_id = ?').get(fileId) as Record<string, unknown>
    return Number(r['n'] ?? 0)
  } finally {
    db.close()
  }
}

/** FTS 表里现有多少行。 */
function ftsRows(): number {
  const db = raw()
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks_fts').get() as Record<string, unknown>
    return Number(r['n'] ?? 0)
  } finally {
    db.close()
  }
}

/** 登记一段文本，返回结果。 */
function register(name: string, content: string, kbId = 1) {
  return registerKbFile(decrypted, { kbId, srcPath: fixture(name, content) })
}

const LONG_MD = [
  '# 项目组周报',
  '',
  '本周完成了转账对账模块的联调，下周开始做导出功能。',
  '',
  '## 风险',
  '',
  '支付通道的证书还有两周到期，需要提前申请续期。',
].join('\n')

describe('登记 · 去重与拒绝', () => {
  it('同库内同内容（即便文件名不同）被判为重复，并指出撞上的是哪一行', () => {
    const first = register('合同 A.txt', '同一份内容')
    expect(first.ok).toBe(true)
    // 改名重传：文件名不同、内容相同 → 仍然是重复。
    const second = register('合同 B.txt', '同一份内容')
    expect(second.ok).toBe(false)
    expect(second.code).toBe('duplicate')
    expect(second.duplicateOf?.id).toBe(first.file?.id)
    expect(second.duplicateOf?.name).toBe('合同 A.txt')
    expect(second.error).toContain('按内容判定')
    expect(countKbFiles(decrypted, 1)).toBe(1)
  })

  it('不同的库可以各自存一份同样的内容', () => {
    expect(register('a.txt', '共用内容', 1).ok).toBe(true)
    const other = register('a.txt', '共用内容', 2)
    expect(other.ok).toBe(true)
    expect(countKbFiles(decrypted, 2)).toBe(1)
  })

  it('内容不同、文件名相同 → 都收下（去重只看内容）', () => {
    expect(register('重名.txt', '第一版', 1).ok).toBe(true)
    const second = register('重名.txt', '第二版', 1)
    expect(second.ok).toBe(true)
    expect(countKbFiles(decrypted, 1)).toBe(2)
  })

  it('白名单外的类型被拒，且原因是「类型」而不是「损坏」', () => {
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: fixture('打包.zip', 'PK') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not-accepted')
    expect(r.error).toContain('不支持的类型')
    expect(r.error).not.toContain('损坏')
  })

  it('没有扩展名也被拒（白名单是枚举，不是「除黑名单外都行」）', () => {
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: fixture('README', 'hello') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not-accepted')
  })

  it('路径不存在 → 读不到，而不是当成空文件收下', () => {
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: join(srcDir, '并不存在.txt') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('read-failed')
    expect(r.error).toContain('读不到')
  })

  it('路径指向目录 → 也判读不到', () => {
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: srcDir })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('read-failed')
  })

  it('超过大小上限 → 在读入之前就被拒（先看 size，不先把内存吃掉）', () => {
    const p = join(srcDir, '巨大.txt')
    writeFileSync(p, 'x')
    truncateSync(p, 33 * 1024 * 1024)
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: p })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('too-large')
    expect(r.error).toContain('上限')
    expect(countKbFiles(decrypted, 1)).toBe(0)
  })

  it('漏传库标识 → 明确报缺，而不是落进某个「默认库」', () => {
    const r = registerKbFile(decrypted, { kbId: 0, srcPath: fixture('a.txt', 'x') })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('bad-kb')
  })

  it('空文件是 ready + 0 块（不是失败）', () => {
    const r = register('空.txt', '')
    expect(r.ok).toBe(true)
    expect(r.file?.parseState).toBe('ready')
    expect(r.file?.chunkCount).toBe(0)
    expect(r.file?.charCount).toBe(0)
    expect(r.file?.parseError).toBe('')
  })

  it('库内文件数达上限 → 拒绝新增', () => {
    // 直接灌行，比真的上传 5000 个文件快得多（这里验的是上限这道闸，不是上传本身）。
    const db = openStore(decrypted)
    db.exec('BEGIN')
    const st = db.prepare('INSERT INTO kb_files(kb_id, name, ext, src_path, sha256, size_bytes, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 0, ?, ?)')
    for (let i = 0; i < MAX_FILES_PER_KB; i += 1) st.run('f' + i, 'txt', '/x/f' + i, 'sha' + i, i, i)
    db.exec('COMMIT')
    db.close()
    const r = register('再来一个.txt', '内容')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('too-many')
  })
})

describe('登记 · 写入与原子性', () => {
  it('落库的行数与块数一致，FTS 与 chunks 一一对应', () => {
    const r = register('周报.md', LONG_MD)
    expect(r.ok).toBe(true)
    const file = r.file
    expect(file).toBeDefined()
    if (file === undefined) return
    expect(file.kbId).toBe(1)
    expect(file.ext).toBe('md')
    expect(file.parser).toBe('markdown')
    expect(file.parseState).toBe('ready')
    expect(file.sizeBytes).toBe(Buffer.byteLength(LONG_MD, 'utf8'))
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(file.chunkCount).toBeGreaterThan(0)
    expect(chunkCountOf(file.id)).toBe(file.chunkCount)
    expect(ftsRows()).toBe(file.chunkCount)
  })

  it('ready 与 chunk 行同事务：FTS 写入失败时整行回滚，不留「状态正常但没内容」的假成功', () => {
    // 先让库建好，再把 FTS 换成**列数不对**的表：`migrate` 的 IF NOT EXISTS 认得它、
    // 不会重建，于是后续插入必然抛错 —— 这是能在不破坏实现的前提下造出的
    // 「写 kb_files 成功、写 chunk 失败」的场景。
    const db = openStore(decrypted)
    db.exec('DROP TABLE kb_chunks_fts')
    db.exec("CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(only_one_column)")
    db.close()

    const r = register('会失败.md', LONG_MD)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('store-failed')
    // 回滚生效：这一行不该存在，chunk 更不该存在。
    expect(countKbFiles(decrypted, 1)).toBe(0)
    const check = raw()
    try {
      const c = check.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as Record<string, unknown>
      expect(Number(c['n'] ?? 0)).toBe(0)
    } finally {
      check.close()
    }
  })

  it('B 档登记后落 queued 而不是 unsupported（解析已搬进后台队列 —— 阶段 D / G-05）', () => {
    // ⚠ 这一条在阶段 D 之前断言的是 `unsupported` + 「本机还没有解析器」，那是
    // 「同步路径解不了 PDF」时代的契约。现在 B 档走**异步队列**：登记只落一行
    // `queued` 就立刻返回（不冻住界面，也不挡住别的接口），真正解它的是
    // `drainKbQueue`（端到端在 `kb-b-endtoend.spec.ts`）。
    // 若这里退回到 `unsupported`，说明分流走错了档：界面上会显示
    // 「解析器接入后会自动补上正文」，而用户永远等不到那一天。
    const r = register('手册.pdf', '%PDF-1.7 fake')
    expect(r.ok).toBe(true)
    expect(r.file?.parseState).toBe('queued')
    expect(r.file?.parser).toBe('')
    expect(r.file?.chunkCount).toBe(0)
    // `queued` 不是失败：此刻什么都没出错，`parse_error` 里就不许出现「损坏 / 失败」
    // 这类词（它是直接显示给用户的一行字）。
    expect(r.file?.parseError ?? '').not.toContain('损坏')
    expect(r.file?.parseError ?? '').not.toContain('失败')
  })

  it('解析降级（编码回退）写进 parse_error，但仍算 ready', () => {
    const p = join(srcDir, 'gbk.txt')
    // 真实的 GBK 字节（「中文」），不是「先写 UTF-8 再假装」。
    writeFileSync(p, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: p })
    expect(r.ok).toBe(true)
    expect(r.file?.parseState).toBe('ready')
    expect(r.file?.parseError).toContain('gb18030')
  })

  it('blob 副本落盘且内容与原文件一致，副本名是内容指纹', () => {
    const r = register('副本.txt', '副本内容')
    const file = r.file
    expect(file).toBeDefined()
    if (file === undefined) return
    expect(file.blobName).toBe(file.sha256 + '.txt')
    const copied = join(kbBlobsDir(decrypted), file.blobName)
    expect(existsSync(copied)).toBe(true)
    expect(readFileSync(copied, 'utf8')).toBe('副本内容')
  })

  it('登记不写、不改原文件（原文件内容与 mtime 意义上的字节都不变）', () => {
    const path = fixture('原文件.txt', '原封不动')
    const before = readFileSync(path)
    expect(registerKbFile(decrypted, { kbId: 1, srcPath: path }).ok).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('同一份内容重复登记不会重写副本（内容寻址）', () => {
    const first = register('一.txt', '共享内容', 1)
    const copied = join(kbBlobsDir(decrypted), first.file?.blobName ?? '')
    const second = register('二.txt', '共享内容', 2)
    expect(second.ok).toBe(true)
    // 两个库各一行，副本名相同（同一份内容）。
    expect(second.file?.blobName).toBe(first.file?.blobName)
    expect(existsSync(copied)).toBe(true)
  })
})

describe('中文检索口径', () => {
  it('FTS 里存的是 bigram 切分后的 token，中文词因此可被检索到', () => {
    const r = register('聊天.txt', '微信转账收到转账通知')
    expect(r.ok).toBe(true)
    const db = raw()
    try {
      const hits = db.prepare('SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?').all('"转账"') as Array<Record<string, unknown>>
      // 若哪天有人把 tokens 换成原文，unicode61 会把整串汉字当一个 token，
      // 「转账」将永远匹配不到 —— 这条断言就是那个时候的警报。
      expect(hits.length).toBeGreaterThan(0)
      const none = db.prepare('SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?').all('"并不存在的词"') as Array<Record<string, unknown>>
      expect(none.length).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('列表 · 作用域与分页', () => {
  it('按库隔离：一个库的文件不会出现在另一个库的列表里', () => {
    register('甲1.txt', '甲一', 1)
    register('甲2.txt', '甲二', 1)
    register('乙1.txt', '乙一', 2)
    const a = listKbFiles(decrypted, 1)
    const b = listKbFiles(decrypted, 2)
    expect(a.total).toBe(2)
    expect(a.items.map((f) => f.name).sort()).toEqual(['甲1.txt', '甲2.txt'])
    expect(b.total).toBe(1)
    expect(b.items.map((f) => f.name)).toEqual(['乙1.txt'])
    expect(a.readError).toBeUndefined()
    expect(a.kbId).toBe(1)
  })

  it('没有文件的库返回空列表（而不是 readError）', () => {
    const r = listKbFiles(decrypted, 99)
    expect(r.total).toBe(0)
    expect(r.items).toEqual([])
    expect(r.readError).toBeUndefined()
  })

  it('新登记的在前', () => {
    register('早.txt', '早')
    register('晚.txt', '晚')
    const r = listKbFiles(decrypted, 1)
    expect(r.items[0]?.name).toBe('晚.txt')
  })

  it('分页可用，且 total 是全量而不是当页', () => {
    register('一.txt', '一')
    register('二.txt', '二')
    register('三.txt', '三')
    const page = listKbFiles(decrypted, 1, { limit: 2, offset: 0 })
    expect(page.items.length).toBe(2)
    expect(page.total).toBe(3)
    const next = listKbFiles(decrypted, 1, { limit: 2, offset: 2 })
    expect(next.items.length).toBe(1)
    expect(next.total).toBe(3)
  })

  it('非法分页参数被夹住而不是抛错', () => {
    register('一.txt', '一')
    expect(listKbFiles(decrypted, 1, { limit: 0 }).items.length).toBe(1)
    expect(listKbFiles(decrypted, 1, { limit: -5, offset: -3 }).items.length).toBe(1)
    expect(DEFAULT_FILE_PAGE).toBeGreaterThan(0)
  })

  it('库读不到时给 readError，而不是把空列表伪装成「一个文件都没有」', () => {
    const brokenRoot = mkdtempSync(join(tmpdir(), 'kb-files-broken-'))
    const brokenDir = join(brokenRoot, 'decrypted')
    mkdirSync(brokenDir, { recursive: true })
    // 让库文件的位置上是个**目录** → 打不开。
    mkdirSync(kbFilesDbPath(brokenDir), { recursive: true })
    try {
      const r = listKbFiles(brokenDir, 1)
      expect(r.items).toEqual([])
      expect(r.total).toBe(0)
      expect((r.readError ?? '').length).toBeGreaterThan(0)
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true })
    }
  })

  it('文件库与笔记库是两个不同的文件（可独立回退）', () => {
    expect(kbFilesDbPath(decrypted)).toBe(join(dataRoot, 'wechat_kb_files.db'))
    expect(kbFilesDbPath(decrypted)).not.toContain('wechat_notes.db')
    expect(kbBlobsDir(decrypted)).toBe(join(dataRoot, 'kb-blobs'))
  })
})

describe('删除 · 级联顺序与来源保护', () => {
  it('级联顺序是唯一真源，且含五个步骤', () => {
    expect(KB_FILE_DELETE_ORDER).toEqual(['chunks', 'fts', 'vectors', 'blob', 'file'])
    // chunks 必须早于 fts（FTS 的 rowid = chunk id，先删 chunk 就问不出来了）；
    // blob 必须早于 file（判断「还有没有别人引用」要趁登记行还在）。
    expect(KB_FILE_DELETE_ORDER.indexOf('chunks')).toBeLessThan(KB_FILE_DELETE_ORDER.indexOf('fts'))
    expect(KB_FILE_DELETE_ORDER.indexOf('blob')).toBeLessThan(KB_FILE_DELETE_ORDER.indexOf('file'))
  })

  it('删文件连带清掉 chunk / FTS / 副本，但**原文件仍在**', () => {
    const path = fixture('要删的.txt', '删除测试内容')
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: path })
    expect(r.ok).toBe(true)
    const file = r.file
    if (file === undefined) return
    expect(file.chunkCount).toBeGreaterThan(0)
    const copied = join(kbBlobsDir(decrypted), file.blobName)
    expect(existsSync(copied)).toBe(true)

    const del = deleteKbFile(decrypted, 1, file.id)
    expect(del.ok).toBe(true)
    expect(del.removedChunks).toBe(file.chunkCount)
    expect(del.removedBlob).toBe(true)
    expect(countKbFiles(decrypted, 1)).toBe(0)
    expect(chunkCountOf(file.id)).toBe(0)
    expect(ftsRows()).toBe(0)
    expect(existsSync(copied)).toBe(false)
    // ★ 本模块最重要的对外承诺：删的是「库里的这一份」，不是用户电脑上的文件。
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('删除测试内容')
  })

  it('删不存在的文件 → 明确报不存在，不是静默成功', () => {
    const r = deleteKbFile(decrypted, 1, 12345)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
  })

  it('删非法 id → 拒绝', () => {
    expect(deleteKbFile(decrypted, 1, 0).ok).toBe(false)
    expect(deleteKbFile(decrypted, 1, Number.NaN).ok).toBe(false)
  })

  it('跨库共享的副本：删掉一个库的文件不删副本，删到最后一个引用才删', () => {
    const inA = register('甲.txt', '两个库都在用', 1)
    const inB = register('乙.txt', '两个库都在用', 2)
    expect(inA.ok && inB.ok).toBe(true)
    const copied = join(kbBlobsDir(decrypted), inA.file?.blobName ?? '')
    expect(existsSync(copied)).toBe(true)

    const delA = deleteKbFile(decrypted, 1, inA.file?.id ?? 0)
    expect(delA.ok).toBe(true)
    expect(delA.removedBlob).toBe(false)
    expect(existsSync(copied)).toBe(true)

    const delB = deleteKbFile(decrypted, 2, inB.file?.id ?? 0)
    expect(delB.ok).toBe(true)
    expect(delB.removedBlob).toBe(true)
    expect(existsSync(copied)).toBe(false)
  })

  it('拿别的库的 fileId 来删 → 拒绝（kbId 是守卫，不是附加信息）', () => {
    const mine = register('我的.txt', '我的内容', 1)
    const id = mine.file?.id ?? 0
    const wrong = deleteKbFile(decrypted, 2, id)
    expect(wrong.ok).toBe(false)
    // 拒绝之后那一行、它的分块与副本都还在。
    expect(countKbFiles(decrypted, 1)).toBe(1)
    expect(chunkCountOf(id)).toBe(mine.file?.chunkCount ?? 0)
    expect(deleteKbFile(decrypted, 1, id).ok).toBe(true)
    expect(countKbFiles(decrypted, 1)).toBe(0)
  })

  it('拿别的库的 fileId 来开关出网 → 拒绝，且那一行不变', () => {
    const mine = register('开关.txt', '开关内容', 1)
    const id = mine.file?.id ?? 0
    expect(setKbFileRagFlag(decrypted, 2, id, false).ok).toBe(false)
    expect(listKbFiles(decrypted, 1).items[0]?.includeInRag).toBe(true)
    expect(setKbFileRagFlag(decrypted, 1, id, false).ok).toBe(true)
    expect(listKbFiles(decrypted, 1).items[0]?.includeInRag).toBe(false)
  })

  it('非法 kbId → 拒绝', () => {
    const mine = register('随便.txt', '内容', 1)
    expect(deleteKbFile(decrypted, 0, mine.file?.id ?? 0).ok).toBe(false)
    expect(setKbFileRagFlag(decrypted, 0, mine.file?.id ?? 0, false).ok).toBe(false)
  })

  it('只删自己的 chunk，不误伤同库其他文件', () => {
    const a = register('甲.txt', '甲的内容')
    const b = register('乙.txt', '乙的内容')
    if (a.file === undefined || b.file === undefined) return
    expect(deleteKbFile(decrypted, 1, a.file.id).ok).toBe(true)
    expect(chunkCountOf(b.file.id)).toBe(b.file.chunkCount)
    expect(ftsRows()).toBe(b.file.chunkCount)
    expect(countKbFiles(decrypted, 1)).toBe(1)
  })
})

describe('崩溃恢复 · 只在进程启动时重置一次', () => {
  it('把 parsing / chunking / embedding 打回 queued，ready 不受影响', () => {
    const r = register('文件.txt', '内容')
    const fileId = r.file?.id ?? 0
    const db = openStore(decrypted)
    // 造三行中间态（真实场景里它们来自「解析到一半进程被杀」）。
    for (const st of ['parsing', 'chunking', 'embedding']) {
      const res = db.prepare('INSERT INTO kb_files(kb_id, name, ext, src_path, sha256, size_bytes, parse_state, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 0, ?, 0, 0)')
        .run(st + '.txt', 'txt', '/x/' + st, 'sha-' + st, st)
      void res
    }
    db.close()

    const report = recoverInterrupted(decrypted)
    expect(report.skipped).toBe(false)
    expect(report.reset).toBe(3)

    const check = raw()
    try {
      const rows = check.prepare('SELECT parse_state, COUNT(*) AS n FROM kb_files GROUP BY parse_state').all() as Array<Record<string, unknown>>
      const byState = new Map(rows.map((x) => [String(x['parse_state']), Number(x['n'] ?? 0)]))
      expect(byState.get('queued')).toBe(3)
      expect(byState.get('ready')).toBe(1)
      for (const st of ['parsing', 'chunking', 'embedding']) expect(byState.has(st)).toBe(false)
      // 已经解析好的那一行没被动过内容。
      const still = check.prepare('SELECT chunk_count FROM kb_files WHERE id = ?').get(fileId) as Record<string, unknown>
      expect(Number(still['chunk_count'] ?? 0)).toBe(r.file?.chunkCount)
    } finally {
      check.close()
    }
  })

  it('同一个数据根第二次调用直接跳过（这就是「只在启动时做一次」）', () => {
    const db = openStore(decrypted)
    db.prepare('INSERT INTO kb_files(kb_id, name, ext, src_path, sha256, size_bytes, parse_state, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 0, ?, 0, 0)')
      .run('x.txt', 'txt', '/x/x', 'sha-x', 'parsing')
    db.close()

    expect(recoverInterrupted(decrypted).reset).toBe(1)
    const again = recoverInterrupted(decrypted)
    expect(again.skipped).toBe(true)
    expect(again.reset).toBe(0)

    // 再来一行中间态，第二次调用也**不会**顺手把它重置 ——
    // 这正是「读列表时判断」那种写法的 bug：正在解析的文件会被读操作打断。
    const db2 = openStore(decrypted)
    db2.prepare('INSERT INTO kb_files(kb_id, name, ext, src_path, sha256, size_bytes, parse_state, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 0, ?, 0, 0)')
      .run('y.txt', 'txt', '/x/y', 'sha-y', 'parsing')
    db2.close()
    expect(recoverInterrupted(decrypted).reset).toBe(0)
  })

  it('不同的数据根各做各的', () => {
    const other = mkdtempSync(join(tmpdir(), 'kb-files-other-'))
    const otherDir = join(other, 'decrypted')
    mkdirSync(otherDir, { recursive: true })
    try {
      expect(recoverInterrupted(decrypted).skipped).toBe(false)
      expect(recoverInterrupted(otherDir).skipped).toBe(false)
      expect(recoverInterrupted(decrypted).skipped).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('库打不开时给 readError，不伪装成「没有残留」', () => {
    const brokenRoot = mkdtempSync(join(tmpdir(), 'kb-files-recover-'))
    const brokenDir = join(brokenRoot, 'decrypted')
    mkdirSync(brokenDir, { recursive: true })
    mkdirSync(kbFilesDbPath(brokenDir), { recursive: true })
    try {
      const r = recoverInterrupted(brokenDir)
      expect(r.reset).toBe(0)
      expect((r.readError ?? '').length).toBeGreaterThan(0)
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true })
    }
  })
})

describe('出网开关（文件级）', () => {
  it('默认参与，可关可开，且只改自己那一行', () => {
    const a = register('甲.txt', '甲')
    const b = register('乙.txt', '乙')
    expect(a.file?.includeInRag).toBe(true)

    expect(setKbFileRagFlag(decrypted, 1, a.file?.id ?? 0, false).ok).toBe(true)
    const after = listKbFiles(decrypted, 1).items
    const byName = new Map(after.map((f) => [f.name, f.includeInRag]))
    expect(byName.get('甲.txt')).toBe(false)
    expect(byName.get('乙.txt')).toBe(true)

    expect(setKbFileRagFlag(decrypted, 1, a.file?.id ?? 0, true).ok).toBe(true)
    expect(listKbFiles(decrypted, 1).items.find((f) => f.name === '甲.txt')?.includeInRag).toBe(true)
    expect(b.file?.includeInRag).toBe(true)
  })

  it('登记时可以直接指定不参与', () => {
    const r = registerKbFile(decrypted, { kbId: 1, srcPath: fixture('敏感.txt', '合同'), includeInRag: false })
    expect(r.ok).toBe(true)
    expect(r.file?.includeInRag).toBe(false)
  })

  it('对不存在的文件开关 → 报错', () => {
    expect(setKbFileRagFlag(decrypted, 1, 999, false).ok).toBe(false)
  })
})

describe('删库时的文件处理', () => {
  it('purge：文件、chunk、副本、登记全部清掉', () => {
    const a = register('甲1.txt', '甲一', 1)
    register('甲2.txt', '甲二', 1)
    register('乙1.txt', '乙一', 2)
    const copied = join(kbBlobsDir(decrypted), a.file?.blobName ?? '')

    const report = kbFilesOnKbDelete(decrypted, 1)
    expect(report.ok).toBe(true)
    expect(report.removedFiles).toBe(2)
    expect(report.movedFiles).toBe(0)
    expect(countKbFiles(decrypted, 1)).toBe(0)
    expect(countKbFiles(decrypted, 2)).toBe(1)
    expect(existsSync(copied)).toBe(false)

    const db = raw()
    try {
      const c = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE kb_id = 1').get() as Record<string, unknown>
      expect(Number(c['n'] ?? 0)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('reassign：登记与分块一起换归属，检索隔离不被破坏', () => {
    register('迁徙.txt', '要被迁移的内容', 1)
    register('留守.txt', '留在原库', 2)

    const report = kbFilesOnKbDelete(decrypted, 1, 2)
    expect(report.ok).toBe(true)
    expect(report.movedFiles).toBe(1)
    expect(report.removedFiles).toBe(0)
    expect(countKbFiles(decrypted, 1)).toBe(0)
    expect(countKbFiles(decrypted, 2)).toBe(2)

    const db = raw()
    try {
      const c = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE kb_id = 1').get() as Record<string, unknown>
      // 分块也必须换归属，否则新库检索不到它、旧库又能搜到。
      expect(Number(c['n'] ?? 0)).toBe(0)
      const t = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE kb_id = 2').get() as Record<string, unknown>
      expect(Number(t['n'] ?? 0)).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('reassign 撞上目标库已有同内容 → 该文件不迁移，计入 removedFiles（不静默合并）', () => {
    const path = fixture('共用.txt', '两边都有的内容')
    expect(registerKbFile(decrypted, { kbId: 2, srcPath: path }).ok).toBe(true)
    expect(registerKbFile(decrypted, { kbId: 1, srcPath: path }).ok).toBe(true)

    const report = kbFilesOnKbDelete(decrypted, 1, 2)
    expect(report.ok).toBe(true)
    expect(report.movedFiles).toBe(0)
    expect(report.removedFiles).toBe(1)
    expect(countKbFiles(decrypted, 1)).toBe(0)
    // 目标库仍然只有原来那一行 —— 没有被合并成两行。
    expect(countKbFiles(decrypted, 2)).toBe(1)
    expect(existsSync(path)).toBe(true)
  })

  it('目标库就是自己 → 视为 purge（否则等于什么都没做还回执「迁移成功」）', () => {
    register('自己.txt', '自己', 1)
    const report = kbFilesOnKbDelete(decrypted, 1, 1)
    expect(report.removedFiles).toBe(1)
    expect(countKbFiles(decrypted, 1)).toBe(0)
  })

  it('空库 → ok 且两个计数都是 0（没什么可做不是失败）', () => {
    const report = kbFilesOnKbDelete(decrypted, 7)
    expect(report.ok).toBe(true)
    expect(report.removedFiles).toBe(0)
    expect(report.movedFiles).toBe(0)
  })

  it('非法库标识 → 拒绝', () => {
    expect(kbFilesOnKbDelete(decrypted, 0).ok).toBe(false)
  })
})

/* ── 读正文（就地展开）──────────────────────────────────────────────────
 * 这条接口返回的是**内容**而不是计数，所以作用域守卫比 `listKbFiles` 那边更要紧：
 * 只卡 `file_id` 的话，传一个别的库的 fileId 就能把那个库的正文读出来 ——
 * 单库夹具全绿，多库才漏，而且漏的是用户资料本身。
 */
describe('读正文 · 作用域与分页', () => {
  it('按文档原有顺序返回解析出来的正文块', () => {
    const r = register('周报.md', LONG_MD)
    expect(r.ok).toBe(true)
    const page = listKbFileChunks(decrypted, 1, (r.file?.id ?? 0))
    expect(page.readError).toBeUndefined()
    expect(page.total).toBe(chunkCountOf((r.file?.id ?? 0)))
    expect(page.items.length).toBeGreaterThan(0)
    // ordinal 升序 = 文档原有顺序；打乱了就不是「读这篇文档」而是读一堆碎片
    expect(page.items.map(c => c.ordinal)).toEqual([...page.items.map(c => c.ordinal)].sort((a, b) => a - b))
    expect(page.items.map(c => c.text).join('\n')).toContain('转账对账')
    expect(page.totalChars).toBe(page.items.reduce((s, c) => s + c.charCount, 0))
  })

  it('跨库读不到：只凭 fileId 拿不到别的库的正文', () => {
    const r = register('私密.md', LONG_MD, 1)
    const page = listKbFileChunks(decrypted, 2, (r.file?.id ?? 0))
    // 一条正文都不许漏出去，而且要**说明原因**，不能静默给空数组
    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
    expect(page.readError ?? '').toContain('不属于当前知识库')
  })

  it('kbId / fileId 非法时给 readError 而不是抛', () => {
    const r = register('非法参数.md', LONG_MD)
    // 先确认夹具真的给了一个合法 id —— 否则下面三条会因为「id 本来就是 0」而假通过
    expect((r.file?.id ?? 0) > 0).toBe(true)
    expect(listKbFileChunks(decrypted, 0, r.file?.id ?? 0).readError).toBeTruthy()
    expect(listKbFileChunks(decrypted, 1, 0).readError).toBeTruthy()
    expect(listKbFileChunks(decrypted, 1, 999999).readError).toBeTruthy()
  })

  it('分页：limit 只影响本次返回量，total 仍是全量；offset 往后接', () => {
    const r = register('分页.md', LONG_MD)
    const first = listKbFileChunks(decrypted, 1, (r.file?.id ?? 0), { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.total).toBeGreaterThan(1)
    const second = listKbFileChunks(decrypted, 1, (r.file?.id ?? 0), { limit: 1, offset: 1 })
    expect(second.items).toHaveLength(1)
    // 两页不能重叠，否则界面上的「继续加载」会把同一段贴两遍
    expect(at(second.items, 0, '第二页').ordinal).not.toBe(at(first.items, 0, '第一页').ordinal)
  })

  it('limit 被夹在上限内：一次调用不可能把整份大文件拉进内存', () => {
    const r = register('夹上限.md', LONG_MD)
    const page = listKbFileChunks(decrypted, 1, (r.file?.id ?? 0), { limit: 999999 })
    expect(page.items.length).toBeLessThanOrEqual(MAX_CHUNK_PAGE)
  })
})
