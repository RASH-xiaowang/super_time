/**
 * L4：冒烟脚本**不许写仓库**。
 *
 * 起因：`scripts/license-smoke.js` 曾经把测试公钥写进 `src/license/public-key.js`、跑完在
 * `finally` 里还原。这有两个问题：① 中断（Ctrl+C / 抛出 / 断电）就会把**仓库里的正式公钥**
 * 换成一张测试公钥，症状是「所有正式许可证都验签失败」，排查时毫无线索；② 靠 `finally`
 * 还原的写法在「读断言」时看着是对的 —— 所以必须有**行为级**守卫，而不是断言源码里有某段文本。
 *
 * 三条断言各管一件事：
 *   · 跑一次真实脚本 → 仓库文件逐字节不变（行为级）；
 *   · 注入 helper 在进程内生效且不残留（否则「注入」可能只是个空壳）；
 *   · AST 扫脚本：**一个 fs 写调用都没有**（注释/字符串骗不过它，也不再依赖 finally 还原）。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { grp } from './helpers/strict-index.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'license-smoke.js')
const requireCjs = createRequire(import.meta.url)
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** fs 的写入口：出现在被测脚本里就说明它可能改仓库。 */
const WRITE_APIS = new Set([
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
  'createWriteStream', 'truncateSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync',
])

/** 收集源码里**真实调用**的函数名（注释、字符串里的同名文本不算）。 */
function calledNames(src: string, filename: string): string[] {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) out.push(node.expression.text)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) out.push(node.expression.name.text)
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('license-smoke 不写仓库（L4）', () => {
  it('跑完脚本后仓库里的 public-key.js 逐字节不变，且脚本本身仍然全绿', () => {
    const pub = join(ROOT, 'src', 'license', 'public-key.js')
    const before = sha256(pub)
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    expect(r.status, out).toBe(0)
    expect(out).toContain('importLicense 成功')
    expect(out).toContain('仓库里的 public-key.js 未被本脚本改写')
    expect(sha256(pub), '脚本改了仓库里的公钥文件').toBe(before)
  })

  it('注入的测试公钥在 service 加载期间生效，退出后不残留', () => {
    const { withTestPublicKey, PUBLIC_KEY_PATH } = requireCjs(SCRIPT) as {
      withTestPublicKey: <T>(pem: string, fn: () => T) => T
      PUBLIC_KEY_PATH: string
    }
    const pemHit = /"([^"]+)"/.exec(readFileSync(PUBLIC_KEY_PATH, 'utf8'))
    if (!pemHit) throw new Error(`${PUBLIC_KEY_PATH} 里没有形如 "…" 的一行 —— 提取口径失效，这条用例就空转了`)
    const realPem = grp(pemHit, 1, '公钥字面量').replace(/\\n/g, '\n')
    const fakePem = '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n'
    expect(fakePem).not.toBe(realPem)
    expect(requireCjs(PUBLIC_KEY_PATH).PUBLIC_KEY_PEM, '注入前应当是仓库里的正式公钥').toBe(realPem)

    const seen = withTestPublicKey(fakePem, () => {
      // service 就是按这个路径 require 公钥的：缓存里换成假的，它就拿假的（与旧写法等效，但不落盘）。
      const pub = requireCjs(PUBLIC_KEY_PATH).PUBLIC_KEY_PEM
      const service = requireCjs(join(ROOT, 'src', 'license', 'service.js'))
      return { pub, hasService: typeof service.getLicenseStatus === 'function' }
    })
    expect(seen.pub).toBe(fakePem)
    expect(seen.hasService).toBe(true)
    expect(requireCjs(PUBLIC_KEY_PATH).PUBLIC_KEY_PEM, '退出后必须读回正式公钥').toBe(realPem)
  })

  it('脚本里没有任何 fs 写调用（AST 判定，注释/字符串骗不过）', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const writes = calledNames(src, 'license-smoke.js').filter((n) => WRITE_APIS.has(n))
    expect(writes, `license-smoke.js 里出现了写调用：${writes.join(', ')}`).toEqual([])
    // 防空转：解析必须真的读到调用（否则 visits 失效会让上面恒真）。
    expect(calledNames(src, 'license-smoke.js').length).toBeGreaterThan(10)
  })
})
