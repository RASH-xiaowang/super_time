/**
 * 后端读失败契约（CODE-AUDIT-2026-09-26 P1-1 的下半：§七 第二批 #9）。
 *
 * ## 这条契约说的是什么
 *
 * **读取失败**与**确实是空集**必须是两件事。前端早就有 `read-error-visibility.spec.ts`
 * 守这一点（从类型推「哪些快照带 `readError` ⇒ 哪些面板必须读它」），但后端还有一批查询
 * 在 catch 里直接回 `[]` / 回一句「本机没有」，把两种情况压成一个值。
 *
 * ## 为什么判据是「喂真缺陷」而不是「数 catch」
 *
 * `catch { return [] }` 这个形状本身不坏 —— 逐个文件跳过损坏项是对的（那是一条数据的事）。
 * 坏的是**整棵子树读不动时还说「没有」**。所以这里不数 catch，而是把每种「读不动」真的造出来：
 *   · 库损坏 → 把 `sns.db` / `wechat_privacy.db` 写成垃圾字节（`new DatabaseSync` 必然抛）；
 *   · 目录读不动 → 把 `cache` 造成一个**普通文件**（`readdirSync` 必然抛 ENOTDIR）。
 *     这是 Windows 上唯一可移植的「目录读不动」造法 —— `chmod 000` 在本机不生效，
 *     而 ACL 相关的用例（`secure-fs.spec.ts`）要真管理员权限、也不该塞进每次单测。
 *
 * 反向哨兵同样重要：**确认空**的那几条必须 `readError` 缺席，否则「一律报读失败」
 * 也能让上面那几条全绿（判据就退化成常量了）。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { createTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'
import { listExportHistory } from '../src/query/export-history.ts'
import { queryMomentsMonthly } from '../src/query/moments-monthly.ts'
import { missWithScanNotes, snsMonthRoots, type ScanNotes } from '../src/query/sns-scan.ts'
import { resolveSnsImageDataUrl } from '../src/query/sns-image.ts'
import { resolveSnsVideoCoverDataUrl } from '../src/query/sns-video.ts'

const workspaces: TempWorkspace[] = []
const ws = (tag: string): TempWorkspace => {
  const w = createTempWorkspace(tag)
  workspaces.push(w)
  return w
}
afterEach(async () => {
  const list = workspaces.splice(0, workspaces.length)
  for (const w of list) await w.cleanup()
})

/** 造一份能读的 sns.db（表名/列名与真库一致）。 */
function makeSnsDb(w: TempWorkspace, rows: Array<{ tid: number; user: string; xml: string }>): void {
  const file = w.path(join('sns', 'db_sns', 'sns.db'))
  mkdirSync(dirname(file), { recursive: true })
  const db = w.db(join('sns', 'db_sns', 'sns.db'))
  db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
  const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?,?,?)')
  for (const r of rows) ins.run(r.tid, r.user, r.xml)
  db.close()
  expect(readFileSync(file).length, '夹具库没写出来').toBeGreaterThan(0)
}

describe('朋友圈月度分布：读失败与「没有动态」分开', () => {
  it('压根没有 sns.db ⇒ 确认空：months 空，且 readError 必须缺席', () => {
    const w = ws('mom-empty')
    const snap = queryMomentsMonthly(w.dir)
    expect(snap.months).toEqual([])
    expect(snap.readError, `没有库是「从没拉过朋友圈」，不该算读失败：${String(snap.readError)}`).toBeUndefined()
  })

  it('sns.db 是坏文件 ⇒ readError 说清原因，且句柄没漏（坏文件也删得掉）', () => {
    const w = ws('mom-bad')
    mkdirSync(join(w.dir, 'sns', 'db_sns'), { recursive: true })
    writeFileSync(w.path(join('sns', 'db_sns', 'sns.db')), '这不是 SQLite 文件', 'utf8')
    const snap = queryMomentsMonthly(w.dir)
    expect(snap.months, '读失败时不许夹带条目').toEqual([])
    expect(typeof snap.readError, '读失败必须带原因').toBe('string')
    expect(String(snap.readError)).toContain('朋友圈月度分布读取失败')
    // Windows 上只要还开着连接，删文件就会 EPERM —— 这条同时是 P0-1 那一族的现场证据。
    rmSync(w.path(join('sns', 'db_sns', 'sns.db')), { force: true })
  })

  it('正常库 ⇒ 按月聚对，且不带 readError（反向哨兵：不许一见空列表就报读失败）', () => {
    const w = ws('mom-ok')
    makeSnsDb(w, [
      { tid: 1, user: 'wxid_a', xml: '<timeline><createTime>1700000000</createTime></timeline>' },
      { tid: 2, user: 'wxid_a', xml: '<timeline><createTime>1700000100</createTime></timeline>' },
      { tid: 3, user: 'wxid_b', xml: '<timeline><createTime>1704000000</createTime></timeline>' },
      { tid: 4, user: 'wxid_b', xml: '<desc>没有 create_time 的一条</desc>' },
    ])
    const snap = queryMomentsMonthly(w.dir)
    expect(snap.readError).toBeUndefined()
    const total = snap.months.reduce((a, m) => a + m.count, 0)
    expect(total, '三条有时间的应全部计入').toBe(3)
    expect(snap.months.map(m => m.month), '月份必须升序').toEqual([...snap.months.map(m => m.month)].sort())
  })
})

describe('导出历史：库读不动不许画成「还没有导出记录」', () => {
  /** 数据根里再套一层 `decrypted`：`openStore` 算的是 `<dirname(decryptedDir)>/wechat_privacy.db`，
   *  不套这一层的话坏库会落到系统临时目录根上，和并行跑的其它用例撞同一个文件。 */
  const roots = (w: TempWorkspace): { dec: string; store: string } => {
    const dec = join(w.dir, 'decrypted')
    mkdirSync(dec, { recursive: true })
    return { dec, store: join(w.dir, 'wechat_privacy.db') }
  }

  it('隐私库损坏 ⇒ readError 非空、items 空', () => {
    const w = ws('hist-bad')
    const { dec, store } = roots(w)
    writeFileSync(store, '这不是 SQLite 文件', 'utf8')
    const snap = listExportHistory(dec)
    expect(snap.items).toEqual([])
    expect(typeof snap.readError, '读不动却没报 readError ⇒ 界面会显示「还没有导出记录」').toBe('string')
    expect(String(snap.readError)).toContain('导出历史读取失败')
  })

  it('第一次读之前库不存在 ⇒ 确认空（openStore 会自建），readError 缺席', () => {
    const w = ws('hist-empty')
    const { dec, store } = roots(w)
    const snap = listExportHistory(dec)
    expect(snap.items).toEqual([])
    expect(snap.total).toBe(0)
    expect(snap.readError, `自建空库不该算读失败：${String(snap.readError)}`).toBeUndefined()
    expect(existsSync(store), '自建库没写出来 ⇒ 上面那条「确认空」可能是别的原因').toBe(true)
  })
})

describe('媒体目录扫描：「没扫全」不许说成「本机没有」', () => {
  it('cache 是个普通文件 ⇒ 根目录列不出来，但 notes 必须记下这一处', () => {
    const w = ws('scan-file')
    writeFileSync(join(w.dir, 'cache'), '占位：本该是目录', 'utf8')
    const notes: ScanNotes = []
    expect(snsMonthRoots(w.dir, 'Img', notes)).toEqual([])
    expect(notes.length, 'readdir 抛了却没记 ⇒ 后面的「本机没有」就是谎话').toBe(1)
    expect(notes[0]).toContain('cache')
    const msg = missWithScanNotes('未找到匹配的本地图片', notes)
    expect(msg).toContain('媒体缓存目录没扫全')
    expect(msg).toContain('未找到匹配的本地图片')
  })

  it('notes 为空 ⇒ 原句一字不动（否则「扫得全」也会被带上可疑口吻）', () => {
    expect(missWithScanNotes('未找到匹配的本地图片', [])).toBe('未找到匹配的本地图片')
  })

  it('图片解析：cache 读不动时 error 里要能看到原因', () => {
    const w = ws('img-scan')
    writeFileSync(join(w.dir, 'cache'), '占位', 'utf8')
    const r = resolveSnsImageDataUrl(w.dir, undefined, 0x00, 'd'.repeat(32))
    expect(r.url).toBeUndefined()
    expect(r.error, '没返回图就必须说清为什么').toBeDefined()
    expect(String(r.error)).toContain('媒体缓存目录没扫全')
  })

  /**
   * 这条是本轮改出来的**真缺陷**回归：旧实现把「扫不到」无条件记进 `idx.misses`，
   * 而目录读不动时 `roots` 是空的 ⇒ 签名也不会变 ⇒ 这条 md5 从此永远查不到，
   * 直到重启后端。修复后「只有扫全了才配记 miss」。
   */
  it('视频封面：先扫不动、之后目录修好 ⇒ 第二次必须能找到（misses 不许记住读不动）', () => {
    const w = ws('vid-recover')
    const hello = Buffer.from('hello')
    const want = createHash('md5').update(hello).digest('hex')
    writeFileSync(join(w.dir, 'cache'), '占位：读不动', 'utf8')
    const first = resolveSnsVideoCoverDataUrl(w.dir, want)
    expect(first.url, '第一次本来就扫不到').toBeUndefined()
    expect(String(first.error)).toContain('媒体缓存目录没扫全')

    rmSync(join(w.dir, 'cache'), { force: true })
    const dir = join(w.dir, 'cache', '2026-09', 'Sns', 'Video', want.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, want.slice(2) + '.jpg'), hello)
    const second = resolveSnsVideoCoverDataUrl(w.dir, want)
    expect(second.error, '目录修好之后仍然「找不到」= 上一次的读失败被记成了永久 miss：'
      + String(second.error)).toBeUndefined()
    expect(String(second.url)).toContain('data:image/')
  })
})

describe('契约形状（客户端那道类型驱动守卫看得见的部分）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  /** 仓库根：tests → wechat-data → backend → src → 根。 */
  const ROOT = join(HERE, '..', '..', '..', '..')
  const SRC = join(ROOT, 'src', 'backend', 'wechat-data', 'src')
  const UI = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
  it('扫描口只有一份实现（两个 sns 模块不许再各自咽掉 readdir 失败）', () => {
    const video = readFileSync(join(SRC, 'query', 'sns-video.ts'), 'utf8')
    const image = readFileSync(join(SRC, 'query', 'sns-image.ts'), 'utf8')
    expect(video, 'sns-video 又自带 safeReaddir ⇒ 失败被咽掉的那份回来了').not.toMatch(/function safeReaddir\(/)
    expect(video, 'sns-video 又自带月份根目录函数 ⇒ 两处口径会漂').not.toMatch(/function snsVideoMonthRoots\(/)
    expect(image, 'sns-image 又自带根目录函数 ⇒ 同上').not.toMatch(/function sns(ImgRoots|MonthRoots)\(/)
    expect(image).toMatch(/from '\.\/sns-scan\.ts'/)
    expect(video).toMatch(/from '\.\/sns-scan\.ts'/)
  })

  it('月度分布回的是**具名快照**，不是裸数组（否则 read-error 守卫从类型上看不见）', () => {
    const gw = readFileSync(join(SRC, 'gateway-read.ts'), 'utf8')
    expect(gw, 'getMomentsMonthly 又返回数组 ⇒ readError 无处安放').toMatch(
      /getMomentsMonthly\([^)]*\): MomentsMonthlySnapshot/)
    const api = readFileSync(join(UI, 'api-core.ts'), 'utf8')
    expect(api, '远端接口声明与后端不一致').toMatch(/Promise<RemoteResult<MomentsMonthlySnapshot>>/)
  })
})
