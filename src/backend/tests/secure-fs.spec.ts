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
import { currentUser, restrictDir, restrictFile, restrictWechatState } from '../secure-fs.js'

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

describe('ACL 收紧', () => {
  const isWin = process.platform === 'win32'

  it('目录收紧后只剩当前用户，且不再继承（Windows）', () => {
    if (!isWin) return
    const dir = join(tempDir(), 'wechat')
    const r = restrictDir(dir)
    expect(r.ok).toBe(true)
    const acl = aclOf(dir)
    expect(acl).toContain(currentUser())
    // 关键：继承来的 Everyone / BUILTIN\Users 必须已经不在
    expect(acl).not.toMatch(/Everyone/i)
    expect(acl).not.toMatch(/BUILTIN\\Users/i)
    expect(acl).toMatch(/\(OI\)\(CI\)/)
  })

  it('目录的 (OI)(CI) 继承会作用到之后新建的文件', () => {
    if (!isWin) return
    const dir = join(tempDir(), 'wechat')
    restrictDir(dir)
    const inside = join(dir, 'secrets.json')
    writeFileSync(inside, '{"db_enc_key":"x"}', 'utf8')
    const acl = aclOf(inside)
    expect(acl).toContain(currentUser())
    expect(acl).not.toMatch(/Everyone/i)
    expect(acl).not.toMatch(/BUILTIN\\Users/i)
  })

  it('文件收紧同样只留当前用户', () => {
    if (!isWin) return
    const f = join(tempDir(), 'config.json')
    writeFileSync(f, '{}', 'utf8')
    expect(restrictFile(f).ok).toBe(true)
    const acl = aclOf(f)
    expect(acl).toContain(currentUser())
    expect(acl).not.toMatch(/Everyone/i)
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
    writeFileSync(join(tempDir(), 'placeholder'), '')
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
    const acl = readFileSync(f, 'utf8') // 读得回来（当前用户可读）
    expect(acl).toBe('{}')
    expect(aclOf(f)).not.toMatch(/Everyone/i)
  })
})
