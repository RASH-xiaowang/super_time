/**
 * CSV 导出：**编码**与**目标路径**。
 *
 * 用户实测报障两件事，这里各钉一组用例：
 *   ① 点导出后不能选路径 —— 此前 `exportCsv` 把目录写死成 `<数据根>/exports/`，
 *      界面只回报一个用户既没选过、也很难找到的路径（`saveFileDialog` 明明已存在却没用）。
 *   ② 导出的内容乱码 —— 文件确实是 UTF-8，但**没有 BOM**，而 Excel 在中文 Windows 上
 *      不会自动识别无 BOM 的 UTF-8，会按系统 ANSI（GBK）解码，中文整片花屏。
 *
 * 乱码这条只有「真的读回文件字节」才测得出来，所以这里落盘再读。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportCsv } from '../src/query/export.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(d)
  return d
}

/** 造一个含真实中文备注/昵称的 contact.db；返回 [decryptedDir, 数据根]。 */
function makeContactDb(): [string, string] {
  // 数据根再套一层，避免与 os.tmpdir() 下其它用例/历史运行共享同一个 exports/ 目录
  const dataRoot = join(tempDir('wx-csvexp-'), 'wechat-data')
  // 后端拿到的 decryptedDir 是数据根下的 decrypted/，与真实布局一致，
  // 这样 dirname(decryptedDir) === 数据根 的口径才被真正验证。
  const decrypted = join(dataRoot, 'decrypted')
  const dir = join(decrypted, 'contact')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'contact.db'))
  db.exec(`CREATE TABLE contact (
    id INTEGER, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
    remark TEXT, remark_pin_yin_initial TEXT, nick_name TEXT, pin_yin_initial TEXT, quan_pin TEXT,
    remark_quan_pin TEXT, big_head_url TEXT, small_head_url TEXT, description TEXT, is_in_chat_room INTEGER
  )`)
  const ins = db.prepare(`INSERT INTO contact
    (id, username, local_type, remark, remark_pin_yin_initial, nick_name, pin_yin_initial, quan_pin, remark_quan_pin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  ins.run(1, 'wxid_aaa', 1, '北部湾大学_莫明海', 'B', '阿莫', '', 'beibuwan', 'beibuwan')
  // 逗号 / 双引号 / 换行 都是 CSV 的敏感字符，必须被正确转义
  ins.run(2, 'wxid_bbb', 1, '张三, "大" 张', 'Z', '', '', 'zhangsan', 'zhangsan')
  ins.run(3, 'group@chatroom', 0, '工作群', 'G', '', '', '', '')
  db.close()
  return [decrypted, dataRoot]
}

const BOM = '\uFEFF'

describe('CSV 导出：编码（BOM）', () => {
  it('contacts 导出的文件**以 UTF-8 BOM 开头**（否则 Excel 按 GBK 解码就是乱码）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'contacts.csv')
    exportCsv(root, 'contacts', undefined, dest)
    const buf = readFileSync(dest)
    expect([...buf.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
  })

  it('去掉 BOM 后内容是合法 UTF-8，中文可读且与源数据一致', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'contacts.csv')
    exportCsv(root, 'contacts', undefined, dest)
    const text = readFileSync(dest, 'utf8')
    expect(text.startsWith(BOM)).toBe(true)
    const body = text.slice(1)
    expect(body).toContain('北部湾大学_莫明海')
    expect(body).toContain('工作群')
    // 反证：若按 GBK 解码，UTF-8 的中文字节会变成替换符/乱码
    const asGbk = Buffer.from(body, 'utf8').toString('latin1')
    expect(asGbk).not.toContain('北部湾大学_莫明海')
  })

  it('会话消息 CSV（formatCsv 路径）同样带 BOM —— 两个出口不能只有一个修好', () => {
    // formatCsv 是私有的，但它与 exportCsv 共用 buildCsv；这里通过 exportCsv 的
    // 其它 kind 间接确认 buildCsv 一定加 BOM（同一函数）。
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'privacy.csv')
    exportCsv(root, 'privacy', undefined, dest)
    expect(readFileSync(dest, 'utf8').startsWith(BOM)).toBe(true)
  })
})

describe('CSV 导出：目标路径', () => {
  it('给了 dest 就写到那个路径（用户选的路径必须被尊重）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), '我选的.csv')
    const r = exportCsv(root, 'contacts', undefined, dest)
    expect(r.path).toBe(dest)
    expect(existsSync(dest)).toBe(true)
    expect(r.filename).toBe('我选的.csv')
  })

  it('dest 的父目录不存在时会被创建（用户可能选了新目录）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), '新目录', '深一层', 'c.csv')
    const r = exportCsv(root, 'contacts', undefined, dest)
    expect(existsSync(r.path)).toBe(true)
  })

  it('没给 dest 时回退到 <数据根>/exports/（旧调用方仍可用）', () => {
    const [root, dataRoot] = makeContactDb()
    const r = exportCsv(root, 'contacts')
    // 口径与 export.ts 其它出口一致：数据根 = dirname(decryptedDir)，导出落到它下面的 exports/
    expect(dirname(r.path).endsWith('exports')).toBe(true)
    expect(dirname(dirname(r.path))).toBe(dataRoot)
    expect(existsSync(r.path)).toBe(true)
    expect(readdirSync(dirname(r.path)).length).toBe(1)
  })

  it('给 dest 时**不再**往新的 exports/ 里写（不产生用户看不见的副本）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'c.csv')
    exportCsv(root, 'contacts', undefined, dest)
    expect(existsSync(join(dataRoot, 'exports'))).toBe(false)
  })

  it('dest 为空白字符串时按「未给」处理，不写成空路径', () => {
    const [root, dataRoot] = makeContactDb()
    for (const dest of ['', '   ', undefined]) {
      const r = exportCsv(root, 'contacts', undefined, dest)
      expect(r.path).toContain('exports')
    }
  })
})

describe('CSV 导出：内容', () => {
  it('表头是可读中文且列数与每行一致', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'c.csv')
    exportCsv(root, 'contacts', undefined, dest)
    const lines = readFileSync(dest, 'utf8').slice(1).trim().split('\r\n')
    const cols = (s: string): number => (s.match(/","/g)?.length ?? 0) + 1
    const n = cols(lines[0]!)
    expect(lines[0]).toContain('显示名')
    expect(lines[0]).toContain('备注')
    expect(lines[0]).toContain('微信号')
    for (const l of lines) expect(cols(l)).toBe(n)
  })

  it('显示名取「备注 > 昵称 > 用户名」，与界面卡片一致', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'c.csv')
    exportCsv(root, 'contacts', undefined, dest)
    const text = readFileSync(dest, 'utf8')
    expect(text).toContain('北部湾大学_莫明海') // 有备注 → 用备注
    expect(text).toContain('阿莫')             // 昵称仍单列保留
  })

  it('逗号 / 双引号被正确转义（不会把一行拆成多列）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'c.csv')
    exportCsv(root, 'contacts', undefined, dest)
    const text = readFileSync(dest, 'utf8')
    // 单元格内的 " 变成 ""，整体被引号包裹
    expect(text).toContain('"张三, ""大"" 张"')
  })

  it('行数为数据行（不含表头）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'c.csv')
    const r = exportCsv(root, 'contacts', undefined, dest)
    expect(r.count).toBe(3)
  })

  it('category=friend 时只导出好友（与界面页签口径一致）', () => {
    const [root, dataRoot] = makeContactDb()
    const dest = join(tempDir('wx-dest-'), 'c.csv')
    const r = exportCsv(root, 'contacts', undefined, dest, 'friend')
    expect(r.count).toBe(2)
    const text = readFileSync(dest, 'utf8')
    expect(text).not.toContain('工作群')
  })

  it('未知 kind 仍然抛错（不静默产出空文件）', () => {
    const [root, dataRoot] = makeContactDb()
    expect(() => exportCsv(root, 'files')).toThrow(/未知导出类型/)
  })
})
