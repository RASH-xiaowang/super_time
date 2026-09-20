/**
 * M1：把含密钥的目录/文件限制到当前用户。
 *
 * 断言的是**可观察的权限事实**（Windows 用 `icacls` 读回，POSIX 用 stat mode），
 * 而不是「构造函数被调用过」。所以这里真的建目录、真的收紧、再读回权限核对。
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { SENSITIVE_FILES, restrictDir, restrictFile, restrictWechatState } from '../secure-fs.js'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 收紧后仍应可删；失败不掩盖用例结论 */ }
  }
  scratch.length = 0
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'secure-fs-'))
  scratch.push(dir)
  return dir
}

/** 用 icacls 读回某路径的 ACL 文本。 */
function aclOf(target: string): string {
  return execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true })
}

/**
 * 逐条 ACE（去掉 icacls 的「Successfully processed」汇总行）。
 *
 * 注意**不要**用「icacls 输出包含当前用户名」当断言：icacls 会回显路径，而路径本身
 * 就含 `\Users\<user>\` —— 断言恒真（复审用 SYSTEM-only 的 ACL 实测过）。
 */
function aceLines(target: string): string[] {
  return aclOf(target)
    .split(/\r?\n/)
    .map((l) => l.trim())
    // 只留 ACE 行（形如 `主体:(权限)`）；顺便滤掉 icacls 的汇总行 —— 它是**本地化**的
    // （本机是「已成功处理 N 个文件…」），按英文文案过滤会漏掉。
    .filter((l) => l.includes(':('))
    // 首行是「路径 + 第一个 ACE」：必须把路径剥掉，否则「ACE 含当前用户」会被路径里的
    // `\Users\Administrator\` 命中而恒真（这就是复审指出的空转断言）。
    .map((l) => (l.startsWith(target) ? l.slice(target.length).trim() : l))
}

/**
 * 当前用户身份：**显式用 System32 下的 whoami.exe**。
 *
 * 直接 `execFileSync('whoami', …)` 在 Git Bash 里解析到的是 coreutils 的 `whoami`，
 * 它不认 `/user`（报 `extra operand '/user'`）—— 于是这四条用例在有 Git Bash 的机器上
 * 恒失败，看起来像产品坏了。走绝对路径即可两边都对（`secure-fs.js` 也是靠 `os.userInfo()`
 * 兜底才在同一环境活下来的）。
 */
function whoamiExe(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const exe = join(root, 'System32', 'whoami.exe')
  return existsSync(exe) ? exe : 'whoami'
}

/** 当前用户名（`domain\user` 形态，与 icacls 回显一致）。 */
function currentUserName(): string {
  return execFileSync(whoamiExe(), [], { encoding: 'utf8', windowsHide: true }).trim()
}

/** 当前进程令牌里的 SID（与 secure-fs.js 的授权口径一致）。 */
function currentSid(): string {
  const out = execFileSync(whoamiExe(), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  return (out.match(/"(S-1-[\d-]+)"/) || [])[1] ?? ''
}

/**
 * 平台自带的特权主体：放行它们**不是**放宽安全口径 ——
 * `BUILTIN\Administrators` 可以夺取所有权、`NT AUTHORITY\SYSTEM` 是内核，
 * 谁都拦不住它们读，把它们算成「泄漏」既不成立也没意义。
 *
 * 2026-09-20 实测：GitHub 的 windows runner 把这两个主体**显式**写进 `%TEMP%` 子目录的
 * ACL（本机是继承来的、被 `/inheritance:r` 清得掉，runner 上清不掉），于是原来那条
 * 「除当前用户外任何 ACE 都算违规」在 CI 上必红。仍然拦住其它一切主体
 * （`BUILTIN\Users`、`Everyone`、用户组、别的账号）—— 那才是这条断言要防的。
 * 名字与 SID 两种形态都认（icacls 解析不出名字时会回显 SID）。
 */
const PRIVILEGED_ACE = /^(?:NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators|S-1-5-18|S-1-5-32-544):/i

/**
 * 收紧后的不变量：**可见主体只有当前用户与上述特权主体**。
 *
 * `allowInherited` 区分两种对象：**被直接收紧的目录/文件**不该再有 `(I)` 条目
 * （`/inheritance:r` 生效）；而**它下面新建的子文件**恰恰应该带 `(I)` —— 那正是
 * 靠目录继承生效的证据，不是问题。
 *
 * 断言写成「逐条 ACE 枚举」而不是「输出里含某些关键词」：后者在本机是**空转**的
 * ——`%TEMP%` 的继承 ACL 里本来就没有 `Everyone`/`BUILTIN\Users`，所以去掉
 * `/inheritance:r` 也照样通过（复审用变异 m9 实测）。这里改成：除了当前用户与
 * 两个平台特权主体，**不允许出现任何其它 ACE**（别的账号、用户组、Everyone 都算）。
 */
function expectOnlyCurrentUser(target: string, allowInherited: boolean): void {
  const lines = aceLines(target)
  expect(lines.length, '该对象应当有 ACE：' + JSON.stringify(lines)).toBeGreaterThan(0)
  const mine = lines.filter(isCurrentUserAce)
  expect(mine.length, 'ACE 里应有当前用户：' + JSON.stringify(lines)).toBeGreaterThan(0)
  const others = lines.filter((l) => !isCurrentUserAce(l) && !PRIVILEGED_ACE.test(l))
  expect(others, '不该有当前用户之外的任何主体：' + JSON.stringify(lines)).toEqual([])
  if (!allowInherited) {
    expect(lines.some((l) => /\(I\)/.test(l)), '被直接收紧的对象不该有继承条目：' + JSON.stringify(lines)).toBe(false)
  }
}

/** 某条 ACE 是不是「当前用户」的（用 SID 或 domain\user 或裸用户名判定）。 */
function isCurrentUserAce(line: string): boolean {
  const low = line.toLowerCase()
  const me = currentUserName().toLowerCase() // whoami 形态：domain\user
  const bare = me.includes('\\') ? me.slice(me.indexOf('\\') + 1) : me
  const sid = currentSid()
  // 三种命中方式都要留：icacls 按名字回显时是 `DOMAIN\user`，解析不出域名时可能只给裸名，
  // 而授权本来是按 SID 做的 —— 不能只认一种形态（复审指出旧断言「含用户名」恒真且脆弱）。
  return low.includes(me) || low.includes(`\\${bare}:`) || low.startsWith(`${bare}:`) || (sid !== '' && low.includes(sid.toLowerCase()))
}

describe('ACL 收紧', () => {
  const isWin = process.platform === 'win32'

  it('目录收紧后只剩当前用户，且不再继承（Windows）', () => {
    if (!isWin) return
    const dir = join(tempDir(), 'wechat')
    const r = restrictDir(dir)
    expect(r.ok).toBe(true)
    // 只剩当前用户 + **没有 (I) 条目**（后者正是 /inheritance:r 是否生效的判别）
    expectOnlyCurrentUser(dir, false)
    expect(aceLines(dir).join('\n')).toMatch(/\(OI\)\(CI\)/)
  })

  it('目录的 (OI)(CI) 继承会作用到之后新建的文件', () => {
    if (!isWin) return
    const dir = join(tempDir(), 'wechat')
    restrictDir(dir)
    const inside = join(dir, 'secrets.json')
    writeFileSync(inside, '{"db_enc_key":"x"}', 'utf8')
    // 新文件靠目录继承拿到权限 —— 所以这条**应当**带 (I) 条目（与上一条相反）
    expectOnlyCurrentUser(inside, true)
  })

  it('文件收紧同样只留当前用户', () => {
    if (!isWin) return
    const f = join(tempDir(), 'config.json')
    writeFileSync(f, '{}', 'utf8')
    expect(restrictFile(f).ok).toBe(true)
    expectOnlyCurrentUser(f, false)
  })

  it('POSIX 上设成 0700 / 0600', () => {
    if (isWin) return
    const dir = join(tempDir(), 'wechat')
    restrictDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const f = join(dir, 'secrets.json')
    writeFileSync(f, '{}', 'utf8')
    restrictFile(f)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('收紧后**没有把自己锁在外面**：当前用户仍可写入与删除', () => {
    // 这条是从真实故障里长出来的：早先用 process.env.USERNAME 授权（本机该变量是 SYSTEM），
    // 结果目录被锁成连自己都 EPERM —— 应用下一次启动就写不进配置了。
    const root = tempDir()
    const dir = join(root, 'wechat')
    expect(restrictDir(dir).ok).toBe(true)
    const f = join(dir, 'secrets.json')
    expect(() => writeFileSync(f, '{"k":1}', 'utf8')).not.toThrow()
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ k: 1 })
    expect(restrictFile(f).ok).toBe(true)
    expect(() => writeFileSync(f, '{"k":2}', 'utf8')).not.toThrow() // 收紧文件后仍可写
    expect(() => rmSync(f, { force: true })).not.toThrow()
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow()
    expect(existsSync(dir)).toBe(false)
  })
  it('restrictWechatState 覆盖状态目录与数据根下的密钥文件，且不存在的不报错', () => {
    const stateDir = join(tempDir(), 'wechat')
    const dataRoot = join(tempDir(), 'wechat-data')
    const r = restrictWechatState({ stateDir, dataRoot })
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
    expect(existsSync(stateDir)).toBe(true)
    expect(existsSync(dataRoot)).toBe(true)
  })

  it('空参数/不存在的文件不抛，只返回失败说明（加固失败不能拖垮启动）', () => {
    expect(() => restrictDir('')).not.toThrow()
    expect(restrictDir('').ok).toBe(false)
    expect(() => restrictFile(join(tempDir(), 'nope.json'))).not.toThrow()
    expect(restrictFile(join(tempDir(), 'nope.json')).ok).toBe(false)
    expect(() => restrictWechatState({})).not.toThrow()
  })

  it('目录内已有文件的权限在收紧目录时一并被收紧', () => {
    if (!isWin) return
    const dir = join(tempDir(), 'wechat')
    restrictDir(dir)
    const f = join(dir, 'keys.json')
    writeFileSync(f, '{}', 'utf8')
    restrictWechatState({ stateDir: dir })
    const text = readFileSync(f, 'utf8') // 收紧后当前用户仍读得回来
    expect(text).toBe('{}')
    expectOnlyCurrentUser(f, false)
  })

  it('SENSITIVE_FILES 覆盖全部含密钥的文件名（清单漏一个 = 那个文件不受保护）', () => {
    // 为什么直接断言清单：Windows 上对目录收紧会把可继承 ACE 传播到既有子文件，
    // 所以「子文件被收紧了」这个行为断言即使清单里漏了 secrets.json 也照样通过
    // （复审用变异 m11 实测）。
    for (const name of ['config.json', 'secrets.json', 'keys.json', 'llm.json', 'all_keys.json']) {
      expect(SENSITIVE_FILES, '清单缺少 ' + name).toContain(name)
    }
  })
})
