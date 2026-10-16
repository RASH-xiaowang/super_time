/**
 * `queryAnnualAssets` 的「总量盘点」口径（新模块，2026-09-30 首次立判据）。
 *
 * ## 这份用例守的是什么
 *
 * ① **总量，不是按年**：收藏表与文件表没有可靠的按年时间列（理由与逐列分析写在
 *    `annual-assets.ts` 的文件头）。所以接口**根本没有 year 参数** —— 这里用一条
 *    「签名里不许出现 year」的守卫把这件事钉在类型/调用层，避免将来有人加个 `year`
 *    就把口径悄悄改成"某年收藏了几条"。
 * ② **`available` 与 0 分得开**：库不存在 / 表不存在 ⇒ `available: false`；
 *    库和表都在、只是空的 ⇒ `available: true` 且计数是真实的 0。
 * ③ **取不到大小就不计入 `bytes`**：不许用 0 冒充。夹具里刻意放一条没有
 *    `<totallen>` 的文件消息，断言 `files` 加了 1、`bytes` 一分没加。
 * ④ **只认文件类 appmsg**：同为 `local_type = 49` 的链接 / 引用消息不许算进 `files`。
 *
 * 没有真实解密库，所以全部用临时目录 + 自己造的 SQLite 库；库结构照
 * `favorites.ts`（`fav_db_item`）、`meta.ts#loadShardMeta`（`Name2Id` + `Msg_*` + `real_sender_id`）
 * 认的形态写。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryAnnualAssets } from '../src/query/annual-assets.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个空目录作为解密数据根。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'annual-assets-'))
  scratch.push(root)
  return root
}

/**
 * 造一条文件消息 XML（`local_type = 49`，`<appmsg><type>6</type>`）。
 * @param name - 文件名（写进 `<title>`）。
 * @param bytes - 字节数；**传 null 表示这条没有 `<totallen>`**（用来测"取不到大小"）。
 * @returns 完整消息 XML。
 */
function fileMsgXml(name: string, bytes: number | null): string {
  return fileMsgWithAttach(name, bytes === null ? '' : `<totallen>${bytes}</totallen>`)
}

/**
 * 同 {@link fileMsgXml}，但 `<appattach>` 的内容由调用方给（用来造 `filesize` 的两种形态）。
 * @param name - 文件名。
 * @param attachBody - `<appattach>` 里的 XML 片段。
 * @returns 完整消息 XML。
 */
function fileMsgWithAttach(name: string, attachBody: string): string {
  return '<?xml version="1.0"?><msg><appmsg>'
    + `<title>${name}</title><type>6</type>`
    + `<appattach>${attachBody}<fileext>pdf</fileext></appattach>`
    + '</appmsg></msg>'
}

/** 造一条**非**文件类的 appmsg（链接卡，同样是 local_type = 49）。 */
function linkMsgXml(): string {
  return '<?xml version="1.0"?><msg><appmsg><title>一篇文章</title><type>5</type><url>https://mp.weixin.qq.com/s/x</url></appmsg></msg>'
}

/** 一条待写入的消息。 */
interface Msg { content: string; fromSelf: boolean }

/**
 * 写一个消息分片（`message/message_0.db`），含 `Name2Id` 与一张 `Msg_*` 表。
 * `Name2Id` 里**带一行 user_name 为空的行**（微信用它表示登录账号自己，见 `meta.ts` 的注释）。
 * @param root - 解密数据根。
 * @param msgs - 要写入的消息。
 * @param table - `Msg_*` 表名（默认按一个 md5 形态的会话名）。
 * @param withSenderCol - 是否带 `real_sender_id` 列（false = 老版本库，没有归属信息）。
 */
function writeShard(root: string, msgs: Msg[], table = 'Msg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', withSenderCol = true): void {
  const dir = join(root, 'message')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'message_0.db'))
  db.exec('CREATE TABLE Name2Id (user_name TEXT)')
  db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (1, ''), (2, 'wxid_other')")
  db.exec(`CREATE TABLE "${table}" (create_time INTEGER, local_type INTEGER, message_content BLOB${withSenderCol ? ', real_sender_id INTEGER' : ''})`)
  const ins = withSenderCol
    ? db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?)`)
    : db.prepare(`INSERT INTO "${table}" VALUES (?,?,?)`)
  let ts = 1700000000
  for (const m of msgs) {
    ts += 60
    // rowid 1 = user_name 为空 = 「我」（`meta.ts#loadShardMeta` 明确写了这条约定）
    if (withSenderCol) ins.run(ts, 49, m.content, m.fromSelf ? 1 : 2)
    else ins.run(ts, 49, m.content)
  }
  db.close()
}

/**
 * 写一个收藏库（`favorite/favorite.db` 的 `fav_db_item`）。
 * @param root - 解密数据根。
 * @param rows - 收藏条数。
 */
function writeFavorites(root: string, rows: number): void {
  const dir = join(root, 'favorite')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'favorite.db'))
  db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, content TEXT)')
  const ins = db.prepare('INSERT INTO fav_db_item VALUES (?,?,?)')
  for (let i = 0; i < rows; i += 1) ins.run(i + 1, 1, '<favitem><desc>文本</desc></favitem>')
  db.close()
}

describe('queryAnnualAssets：数据源可用性', () => {
  it('整棵树什么都没有 ⇒ available:false、各计数为 0', async () => {
    const root = makeRoot()
    expect(await queryAnnualAssets(root)).toEqual({
      favorites: 0, files: 0, bytes: 0, sentFiles: 0, available: false,
    })
  })

  it('库文件在但没有表（favorite.db 无 fav_db_item、message_0.db 无 Msg_*）⇒ available:false', async () => {
    const root = makeRoot()
    mkdirSync(join(root, 'favorite'), { recursive: true })
    const fav = new DatabaseSync(join(root, 'favorite', 'favorite.db'))
    fav.exec('CREATE TABLE unrelated (a INTEGER)')
    fav.close()
    mkdirSync(join(root, 'message'), { recursive: true })
    const msg = new DatabaseSync(join(root, 'message', 'message_0.db'))
    msg.exec('CREATE TABLE Name2Id (user_name TEXT)')
    msg.close()
    const r = await queryAnnualAssets(root)
    expect(r.available, '缺表被当成了「真的是 0」').toBe(false)
    expect(r.favorites).toBe(0)
  })

  it('两个库都在、表也都在但全是空表 ⇒ available:true 且计数是**真实的 0**', async () => {
    const root = makeRoot()
    writeFavorites(root, 0)
    writeShard(root, [])
    const r = await queryAnnualAssets(root)
    expect(r.available, '空表被当成了「没读到数据」').toBe(true)
    expect(r.favorites).toBe(0)
    expect(r.files).toBe(0)
    expect(r.bytes).toBe(0)
  })

  it('只有收藏库（没解出消息分片）⇒ 仍然 available:true，收藏数照给', async () => {
    const root = makeRoot()
    writeFavorites(root, 3)
    const r = await queryAnnualAssets(root)
    expect(r.available).toBe(true)
    expect(r.favorites).toBe(3)
    expect(r.files).toBe(0)
  })
})

describe('queryAnnualAssets：正常聚合', () => {
  it('收藏条数 + 文件条数 + 字节数 + 我发出的条数一次算全', async () => {
    const root = makeRoot()
    writeFavorites(root, 7)
    writeShard(root, [
      { content: fileMsgXml('报告.pdf', 1000), fromSelf: true },
      { content: fileMsgXml('合同.docx', 2000), fromSelf: false },
      { content: fileMsgXml('数据.xlsx', 3000), fromSelf: true },
      { content: linkMsgXml(), fromSelf: true },
    ])
    const r = await queryAnnualAssets(root, 'wxid_me')
    expect(r.available).toBe(true)
    expect(r.favorites).toBe(7)
    expect(r.files, '链接卡不能算进文件数').toBe(3)
    expect(r.bytes).toBe(6000)
    expect(r.sentFiles).toBe(2)
  })

  it('取不到大小 ⇒ files 加 1、bytes **一分不加**（不许用 0 冒充）', async () => {
    const root = makeRoot()
    writeShard(root, [
      { content: fileMsgXml('有大小.bin', 4096), fromSelf: false },
      { content: fileMsgXml('没有大小.bin', null), fromSelf: false },
    ])
    const r = await queryAnnualAssets(root, 'wxid_me')
    expect(r.files).toBe(2)
    expect(r.bytes, '把读不到大小的那条当成 0 会让总量偏小且看不出来').toBe(4096)
  })

  it('大小字段的两种形态都认：`<totallen>` 子标签 / `<filesize>` 子标签', async () => {
    const root = makeRoot()
    // 两种形态在不同微信版本/不同消息里都出现过；少认一种，那种消息就被当成"没有大小"、bytes 偏小。
    // 形态只有**子标签**这一种（`<appattach><filesize>555</filesize></appattach>`）——
    // 属性形态（`<appattach filesize="…">`）在既有解析器（`parse-rich.ts#parseFileAttach`）里
    // 同样是取不到值的，本模块跟它保持一致，不在这里发明第三种写法。
    const filesizeTag = fileMsgWithAttach('c.pdf', '<filesize>555</filesize>')
    writeShard(root, [
      { content: fileMsgXml('a.pdf', 100), fromSelf: false },
      { content: filesizeTag, fromSelf: false },
    ])
    const r = await queryAnnualAssets(root, 'wxid_me')
    expect(r.files).toBe(2)
    expect(r.bytes).toBe(100 + 555)
  })

  it('没有 real_sender_id 列（老版本库）⇒ 文件照数，sentFiles 恒为 0（少报不多报）', async () => {
    const root = makeRoot()
    writeShard(root, [
      { content: fileMsgXml('a.pdf', 100), fromSelf: true },
      { content: fileMsgXml('b.pdf', 200), fromSelf: true },
    ], 'Msg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', false)
    const r = await queryAnnualAssets(root, 'wxid_me')
    expect(r.files).toBe(2)
    expect(r.bytes).toBe(300)
    expect(r.sentFiles).toBe(0)
  })

  it('分片里没有「我」的 wxid ⇒ 退回 Name2Id 的空 user_name 行（它是登录账号自己）', async () => {
    const root = makeRoot()
    writeShard(root, [
      { content: fileMsgXml('a.pdf', 100), fromSelf: true },
      { content: fileMsgXml('b.pdf', 200), fromSelf: false },
    ])
    // `selfUsername` 在这个分片里查不到 ⇒ 按 `meta.ts#loadShardMeta` 的约定兜底到空 user_name 那行
    // （夹具里是 rowid 1）。那条约定是错的会让真机上「我发出的文件」全塌成 0，所以这里必须钉住。
    const r = await queryAnnualAssets(root, 'wxid_nobody')
    expect(r.files).toBe(2)
    expect(r.bytes).toBe(300)
    expect(r.sentFiles, '兜底行里的那条应当仍算「我发出的」').toBe(1)
  })

  it('不传 selfUsername ⇒ 不做归属判断，sentFiles 为 0 但 files/bytes 照给', async () => {
    const root = makeRoot()
    writeShard(root, [{ content: fileMsgXml('a.pdf', 100), fromSelf: true }])
    const r = await queryAnnualAssets(root)
    expect(r.files).toBe(1)
    expect(r.sentFiles).toBe(0)
  })
})

describe('queryAnnualAssets：总量口径（不是按年）', () => {
  it('接口**没有** year 参数：跨年的收藏与文件一律并进同一个总量', async () => {
    const root = makeRoot()
    writeFavorites(root, 5)
    // 消息的 create_time 相差两年（夹具里是递增的 60 秒，这里直接另写一张表验证"不筛时间"）
    const dir = join(root, 'message')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'message_1.db'))
    db.exec('CREATE TABLE Name2Id (user_name TEXT)')
    db.exec("INSERT INTO Name2Id (rowid, user_name) VALUES (1, '')")
    db.exec('CREATE TABLE "Msg_cccccccccccccccccccccccccccccccc" (create_time INTEGER, local_type INTEGER, message_content BLOB, real_sender_id INTEGER)')
    const ins = db.prepare('INSERT INTO "Msg_cccccccccccccccccccccccccccccccc" VALUES (?,?,?,?)')
    ins.run(1500000000, 49, fileMsgXml('2017 年的文件.pdf', 111), 2)   // 2017
    ins.run(1800000000, 49, fileMsgXml('2027 年的文件.pdf', 222), 2)   // 2027
    db.close()
    const r = await queryAnnualAssets(root, 'wxid_me')
    expect(r.files, '按年分桶就会因为"没有可靠的年列"而漏掉其中一条').toBe(2)
    expect(r.bytes).toBe(333)
  })

  it('源码守卫：实现里不得出现 year 参数/按年分桶（口径一改，界面文案就对不上）', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'annual-assets.ts'), 'utf8')
    // 只查**导出签名**那一行：注释里必须能提「按年」（那是在解释为什么不能按年）。
    const sig = /export async function queryAnnualAssets\(([^)]*)\)/.exec(src)
    expect(sig, 'queryAnnualAssets 的签名没了').not.toBeNull()
    expect(sig?.[1] ?? '', '总量盘点不该有 year 参数').not.toContain('year')
    expect(src).toContain('总量')
  })
})
