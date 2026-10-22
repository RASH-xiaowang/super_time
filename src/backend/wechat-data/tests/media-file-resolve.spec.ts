/**
 * @vitest-environment node
 *
 * 为什么这份文件必须是 node 环境：被测函数读的是磁盘上真实的 `msg/file/<月份>/<文件名>`，
 * 夹具要现写文件、并用 `utimesSync` 把 mtime 摆成想要的先后。
 *
 * P1-7 里被点名「零 spec 引用」的本地文件定位（CODE-AUDIT-2026-09-26 `query/media-file.ts`；
 * 它的池子选择逻辑正是审查说的「含池选择逻辑无测」那一处）。
 *
 * ## 要守的事实
 *
 * 微信把收到的文件**平铺**在 `msg/file/<月份>/<原文件名>`，目录不区分会话 ⇒ 同名文件在
 * 一个账号里可能有 N 份副本。旧实现按文件名全库找、取 mtime 最新的那份，于是
 * **点开 A 会话的文件、读到的是 B 会话的同名文件**。现在用消息自带的两条线索收敛：
 * `createTime` → 月份目录（就近优先）、`fileSize` → 精确字节数（优先于新旧）。
 *
 * 判据统一写成「把返回的 data URL 解回字节，比对是**哪一份**文件的字节」，而不是
 * 「调用没抛错」或「有 url 字段」：这两种写法对「永远返回第一个命中的文件」「永远返回
 * 最新的那个」这类桩件都是绿的，而本模块全部价值就在**选中哪一份**上。
 * 每条用例都用 `mtime` 把「就近/按体积」与「取最新」两条策略的结论**故意错开** —— 否则
 * 线索失效与线索生效给出同一个答案，用例就成了恒真。
 * 夹具文件名互不相同（`fileCache` 是模块级、跨用例活的），且全部落在临时目录里。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMessageFileDataUrl } from '../src/query/media-file.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：用来证明「测试没在仓库里落东西」。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 造一个假的微信原始目录根（`<临时目录>/msg/file` 由调用方按需 mkdir）。
 * @param tag - 目录前缀，便于失败时认人。
 * @returns 根目录路径（可直接当 wechatBaseDir 传）。
 */
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wx-media-file-${tag}-`))
  scratch.push(root)
  return root
}

/**
 * 写一份「已下载」的文件。
 * @param root - 微信原始目录根。
 * @param month - 月份目录名（`YYYY-MM`）；空串表示直接放在 `msg/file` 下。
 * @param name - 文件名（磁盘上叫什么就叫什么，不做清洗）。
 * @param body - 内容（判据靠它认出选中的是哪一份）。
 * @param mtimeSec - 可选的 mtime（unix 秒），用来把「取最新」这条策略摆到想要的方向上。
 * @returns 写入路径。
 */
function putFile(root: string, month: string, name: string, body: string, mtimeSec?: number): string {
  const dir = month ? join(root, 'msg', 'file', month) : join(root, 'msg', 'file')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body)
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec)
  return p
}

/** 本地时区的某日中午 —— 月份目录名按本地月算，用例两端都靠它。 */
function tsLocal(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day, 12, 0, 0, 0).getTime() / 1000)
}

/**
 * 把返回的 data URL 解回字节。解不出来就直接失败并打印 error —— 判据是「拿到的是哪份文件」。
 * @param r - resolveMessageFileDataUrl 的返回值。
 * @returns 文件内容。
 */
function bodyOf(r: { url?: string; error?: string }): string {
  const url = r.url ?? ''
  const at = url.indexOf(';base64,')
  expect(at, `没拿到 data URL，错误是：${String(r.error ?? '(无)')}`).toBeGreaterThan(0)
  return Buffer.from(url.slice(at + 8), 'base64').toString('utf8')
}

/** MD5 of a file body, matching what WeChat stores in appmsg. */
function md5Of(body: string): string {
  return createHash('md5').update(body).digest('hex')
}

describe('resolveMessageFileDataUrl：同名副本里挑出属于这条消息的那一份', () => {
  it('月份线索优先于「取最新」；不带 createTime 时退回全库取最新（键含月份 ⇒ 两次请求不串）', () => {
    const root = makeRoot('month')
    // 一月那份 mtime 更新：只看 mtime 的老策略会挑它。
    putFile(root, '2024-01', '月份线索.pdf', '一月那份', 1_800_000_000)
    putFile(root, '2024-05', '月份线索.pdf', '五月那份', 1_600_000_000)
    const may = resolveMessageFileDataUrl(root, '月份线索.pdf', { createTime: tsLocal(2024, 5, 10) })
    expect(may.url, `没拿到 data URL：${String(may.error ?? '')}`).toMatch(/^data:application\/pdf;base64,/)
    expect(bodyOf(may), '消息在五月，却读到了别的会话同名的那份').toBe('五月那份')
    // 同名的请求不带 createTime ⇒ 走全库回退，此时才轮到「取最新」。
    expect(bodyOf(resolveMessageFileDataUrl(root, '月份线索.pdf', {}))).toBe('一月那份')
    // 走到这里「五月」那条键已经缓存过一次；再显式要一月，必须是一月的字节
    // （缓存键里没月份的话，这一句会直接吃回五月的命中）。
    expect(bodyOf(resolveMessageFileDataUrl(root, '月份线索.pdf', { createTime: tsLocal(2024, 1, 10) }))).toBe('一月那份')
    // 仓库里不落任何东西（本仓有过测试在仓库建目录、照红无关打包守卫的教训）。
    expect(isAbsolute(relative(REPO_ROOT, root)), '夹具跑进仓库里了').toBe(true)
    expect(existsSync(join(REPO_ROOT, 'msg')), '仓库根被建出了 msg/').toBe(false)
  })

  it('月末/月初换月：月份目录名补零（2024-02 不是 2024-2），否则就近收敛会整段失效', () => {
    const root = makeRoot('monthdir')
    putFile(root, '2024-01', '边界.pdf', '一月', 2_000_000_000) // 更新
    putFile(root, '2024-02', '边界.pdf', '二月', 1_900_000_000)
    // 一月内 ⇒ 一月那份。
    expect(bodyOf(resolveMessageFileDataUrl(root, '边界.pdf', { createTime: tsLocal(2024, 1, 31) }))).toBe('一月')
    // 二月内 ⇒ 必须是二月那份；目录名一旦写成 `2024-2`（不补零）就匹配不上，
    // 于是走全库回退、取 mtime 最新 ⇒ 拿到「一月」，这条当场红。
    expect(bodyOf(resolveMessageFileDataUrl(root, '边界.pdf', { createTime: tsLocal(2024, 2, 1) }))).toBe('二月')
  })

  it('体积精确匹配优先于 mtime：字节数对不上的那份再新也不是这条消息的文件', () => {
    const root = makeRoot('size')
    putFile(root, '2024-01', '体积.pdf', 'K'.repeat(23), 2_000_000_000) // 新，23 字节
    putFile(root, '2024-02', '体积.pdf', 'S'.repeat(5), 1_900_000_000)  // 旧，5 字节
    // 消息报 5 字节 ⇒ 必须是**更小也更旧**的那份；只看 mtime 的老策略会挑到 23 字节的新的那份。
    const bySize = resolveMessageFileDataUrl(root, '体积.pdf', { size: 5 })
    expect(bodyOf(bySize)).toBe('S'.repeat(5))
    expect(bySize.url?.startsWith('data:application/pdf;base64,')).toBe(true)
    // 反过来报 23 字节 ⇒ 大的那份。两条一起才说明「体积」真的参与了挑选。
    expect(bodyOf(resolveMessageFileDataUrl(root, '体积.pdf', { size: 23 }))).toBe('K'.repeat(23))
    // appmsg 的 `<totallen>` 是浮点/字符串口径，截断成整数后再比（5.4 必须仍当 5 用）。
    expect(bodyOf(resolveMessageFileDataUrl(root, '体积.pdf', { size: 5.4 }))).toBe('S'.repeat(5))
    // 对不上任何体积时仍要出数（totallen 可能缺）：退回「取最新」。
    expect(bodyOf(resolveMessageFileDataUrl(root, '体积.pdf', { size: 999_999 }))).toBe('K'.repeat(23))
  })

  it('文件名清洗成安全名再查；越出 msg/file 的写法被压回文件名，不会读到目录外的同名文件', () => {
    const root = makeRoot('sanitize')
    putFile(root, '2024-03', '报告_最终_版.pdf', '清洗后的那份')
    expect(bodyOf(resolveMessageFileDataUrl(root, '报告/最终:版.pdf', {}))).toBe('清洗后的那份')
    // `../` 被逐个替换成 `_` ⇒ 只会在月份目录里找一个怪名字，不会往上跳。
    putFile(root, '2024-03', '.._.._.._escape.pdf', '月份目录内那份')
    writeFileSync(join(root, 'escape.pdf'), '目录外那份（永远不该被读到）')
    expect(bodyOf(resolveMessageFileDataUrl(root, '../../../escape.pdf', {}))).toBe('月份目录内那份')
    // 清洗后为空 ⇒ 明确报「缺少文件名」，而不是退化成「把整个目录当结果」。
    expect(resolveMessageFileDataUrl(root, '   ').error).toBe('缺少文件名')
    // 只由非法字符组成的名字清洗成 `_`（非空），照普通未命中处理，不抛错也不越界。
    expect(resolveMessageFileDataUrl(root, '///').error).toBe('本地未找到该文件（需在微信中先打开/下载）')
  })

  it('月份目录存在但没有这个文件（转发/更早接收）要能退回全库；同名目录不算命中', () => {
    const root = makeRoot('fallback')
    putFile(root, '2024-03', '转发来的.pdf', '三月那份')
    // 四月（消息所在的月份）里只有**一个同名的目录** —— `statSync().isFile()` 不认它。
    mkdirSync(join(root, 'msg', 'file', '2024-04', '转发来的.pdf'), { recursive: true })
    const r = resolveMessageFileDataUrl(root, '转发来的.pdf', { createTime: tsLocal(2024, 4, 5) })
    // 少了 isFile 这道闸，这里会是 readFileSync(EISDIR) 抛错 ⇒ 断言的是 url 有没有。
    expect(bodyOf(r), '同名目录把回退路径挤掉了').toBe('三月那份')
  })

  it('MIME 按扩展名给（大小写不敏感），认不出的回 octet-stream', () => {
    const root = makeRoot('mime')
    putFile(root, '2024-06', '合同扫描件.PDF', 'A')
    putFile(root, '2024-06', '语音片段.m4a', 'A')
    putFile(root, '2024-06', '未知格式.qqq', 'A')
    putFile(root, '2024-06', '没有扩展名', 'A')
    expect(resolveMessageFileDataUrl(root, '合同扫描件.PDF', {}).url).toBe('data:application/pdf;base64,QQ==')
    expect(resolveMessageFileDataUrl(root, '语音片段.m4a', {}).url).toBe('data:audio/mp4;base64,QQ==')
    expect(resolveMessageFileDataUrl(root, '未知格式.qqq', {}).url).toBe('data:application/octet-stream;base64,QQ==')
    expect(resolveMessageFileDataUrl(root, '没有扩展名', {}).url).toBe('data:application/octet-stream;base64,QQ==')
  })

  it('三种「拿不到」各有各的文案，不许合并成一句泛化错误（用户要看懂下一步做什么）', () => {
    const root = makeRoot('errors')
    expect(resolveMessageFileDataUrl(undefined, '任何.pdf').error).toBe('未配置微信原始目录，无法定位文件')
    expect(resolveMessageFileDataUrl('', '任何.pdf').error).toBe('未配置微信原始目录，无法定位文件')
    // 根目录在，但 `msg/file` 还没生成 ⇒ 这台机器根本没下载过文件。
    expect(resolveMessageFileDataUrl(root, '没下过.pdf').error).toBe('msg/file 目录不存在，文件尚未下载')
    mkdirSync(join(root, 'msg', 'file', '2024-08'), { recursive: true })
    expect(resolveMessageFileDataUrl(root, '下过但删了.pdf').error).toBe('本地未找到该文件（需在微信中先打开/下载）')
    // 上面每条都只能有 error、不能带 url：带着空 url 出去，界面就是「点开一片白」。
    expect(resolveMessageFileDataUrl(root, '下过但删了.pdf').url).toBeUndefined()
  })

  it('负缓存只顶 60 秒：文件后来下载好了，这条消息要能自己活过来（不必重启后端）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-09-10T12:00:00Z'))
    try {
      const root = makeRoot('negative-cache')
      mkdirSync(join(root, 'msg', 'file', '2024-09'), { recursive: true })
      const first = resolveMessageFileDataUrl(root, '补下的.pdf', {})
      expect(first.error).toBe('本地未找到该文件（需在微信中先打开/下载）')
      // 用户在微信里点了下载 ⇒ 文件现在真实存在了。
      putFile(root, '2024-09', '补下的.pdf', '现在有了')
      expect(existsSync(join(root, 'msg', 'file', '2024-09', '补下的.pdf'))).toBe(true)

      // 60 秒之内仍然吃缓存：这不是「每次点都要扫一遍全库」的那一面 ——
      // 反例用例（同一个文件反复点）守的就是这条不许变成永不停止的重扫。
      const withinTtl = resolveMessageFileDataUrl(root, '补下的.pdf', {})
      expect(withinTtl.url, 'TTL 还没过就该回缓存').toBeUndefined()
      expect(withinTtl.error).toBe('本地未找到该文件')

      vi.setSystemTime(new Date('2024-09-10T12:01:01Z'))
      const after = resolveMessageFileDataUrl(root, '补下的.pdf', {})
      expect(after.error, '负缓存过期后必须重新去看磁盘 —— 旧实现是**永久**的，只能重启').toBeUndefined()
      expect(bodyOf(after)).toBe('现在有了')
    } finally {
      vi.useRealTimers()
    }
  })

  it('缓存键含数据根：换目录/换账号之后同名同体积的文件不许读到上一个目录的字节', () => {
    const rootA = makeRoot('cache-a')
    const rootB = makeRoot('cache-b')
    putFile(rootA, '2024-07', '同名同体积.pdf', 'AAAA')
    putFile(rootB, '2024-07', '同名同体积.pdf', 'BBBB')
    // 对照：rootB 自己目录里的另一个文件读得出来 —— 下面那个结果不是「rootB 根本读不到」。
    putFile(rootB, '2024-07', '对照.pdf', 'BBBB-对照')
    expect(bodyOf(resolveMessageFileDataUrl(rootB, '对照.pdf', {}))).toBe('BBBB-对照')
    expect(bodyOf(resolveMessageFileDataUrl(rootA, '同名同体积.pdf', {}))).toBe('AAAA')
    // 旧实现的键是 `name|size|month`，不含根目录 ⇒ 这里会拿到 'AAAA'：
    // 点开的是 B 账号的文件，回来的却是 A 账号的内容（跨账号串数据）。
    expect(bodyOf(resolveMessageFileDataUrl(rootB, '同名同体积.pdf', {})), '缓存键没带目录 ⇒ 换账号串了内容').toBe('BBBB')
  })

  it('同名同大小时按 fileMd5 命中较旧副本，并允许正确副本在别的月份', () => {
    const root = makeRoot('md5-disambiguate')
    const older = 'OLDER-COPY'
    const newer = 'NEWER-COPY'
    expect(older.length).toBe(newer.length)
    putFile(root, '2024-01', '合同.pdf', older, 1_700_000_000)
    putFile(root, '2024-02', '合同.pdf', newer, 1_800_000_000)

    // 消息报二月，但 MD5 属于一月那份：必须扫全库，不能拿当月的同名文件冒充。
    const byMd5 = resolveMessageFileDataUrl(root, '合同.pdf', {
      size: older.length,
      createTime: tsLocal(2024, 2, 10),
      fileMd5: md5Of(older),
    })
    expect(bodyOf(byMd5), '同名同大小时没有按 MD5 选中较旧副本').toBe(older)
    // 体积线索失真时也不能把 MD5 已确认的副本排除掉。
    expect(bodyOf(resolveMessageFileDataUrl(root, '合同.pdf', {
      size: older.length + 100,
      fileMd5: md5Of(older),
    }))).toBe(older)
  })

  it('给了 fileMd5 但没有任何候选匹配时明确失败，不按 mtime 猜', () => {
    const root = makeRoot('md5-miss')
    putFile(root, '2024-03', '不存在匹配.pdf', 'AAAA', 1_700_000_000)
    putFile(root, '2024-04', '不存在匹配.pdf', 'BBBB', 1_900_000_000)
    const miss = resolveMessageFileDataUrl(root, '不存在匹配.pdf', {
      fileMd5: 'f'.repeat(32),
    })
    expect(miss.url).toBeUndefined()
    expect(miss.error).toContain('MD5')
    expect(miss.error).toContain('停止猜测')
  })

  it('fileMd5 格式非法时在扫描前明确拒绝', () => {
    const root = makeRoot('md5-invalid')
    putFile(root, '2024-05', '坏键.pdf', 'AAAA')
    const r = resolveMessageFileDataUrl(root, '坏键.pdf', { fileMd5: 'not-an-md5' })
    expect(r.url).toBeUndefined()
    expect(r.error).toBe('文件 MD5 格式不正确，无法校验同名文件')
  })
})
