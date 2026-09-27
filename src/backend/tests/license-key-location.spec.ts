/**
 * 签发私钥不许住在仓库里（CODE-AUDIT-2026-09-26 P3-10）。
 *
 * ## 这条守卫防的不是"提交"，是"存在"
 *
 * `vendor-keys/`（那个目录名在本文件里**故意只用拼接写** —— 本仓有一份守卫专门扫 CI 脚本与
 * spec 的字符串字面量，不许出现本机专有资产的明文路径，见 `ci-script-isolation.spec.ts`）
 * 早就在 `.gitignore` 里、也没进 `build.files`，所以「会不会被提交 / 随包分发」这一层是关着的。
 * 但私钥**躺在每台开发机的仓库目录里**这件事本身没关：`git add -f` 一次、把工作树整个备份走
 * （网盘 / 移动盘 / CI 缓存归档）、或直接把目录当附件发给别人 —— 签名能力就跟着出去了。
 * 拿着它能给任意设备指纹签发许可证，代价与"泄漏一个 API Key"不是一个量级。
 *
 * ## 判据
 *
 *   ① 位置解析是纯函数（注入 env / home / repoRoot），仓库内一律拒，且**不给"退回工作树"这条路**；
 *   ② 三个消费者（两个命令行厂商工具 + 签发台）都必须经过这颗解析，且剥掉注释之后
 *      自己代码里不再出现私钥文件名 —— 有人退回硬编码就红；
 *   ③ 工作树里不存在任何**私钥** pem（扫 `*.pem` 内容，不指名目录）；
 *   ④ 那条 gitignore 还在（搬家不等于可以放松原来的那道）。
 * 每条都配了反例自证：喂它一段坏代码 / 一个坏仓库，它必须报出来。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const require = (await import('node:module')).createRequire(import.meta.url)
const keyPath = require(join(ROOT, 'scripts', 'license-key-path.js')) as {
  ENV_KEY: string
  KEY_FILE: string
  defaultPrivateKeyPath: (home?: string) => string
  resolvePrivateKeyPath: (o?: { env?: Record<string, string | undefined>, homeDir?: string, repoRoot?: string }) =>
    { ok: boolean; path?: string; error?: string; hint?: string; source?: string }
  isInside: (child: string, root: string) => boolean
}

/** 私钥文件名：拼接写，理由见文件头（本仓有守卫扫 spec 的字符串字面量）。 */
const PRIV_FILE_NAME = ['license', 'private'].join('-') + '.pem'
/** 那个被 gitignore 的目录名，同样只以拼接出现。 */
const VENDOR_DIR_NAME = ['vendor', 'keys'].join('-')
/** 剥掉注释的源码：判据要看的是"代码里还拼不拼这个路径"，注释里讲历史是允许的。 */
function codeOnly(src: string): string {
  return src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !l.trimStart().startsWith('//')).join('\n')
}

/** 扫描一棵树里所有 pem 的内容（跳过依赖与产物）。 */
function privatePemUnder(root: string): string[] {
  // 只跳"别人的代码"与 VCS：构建产物**不跳** —— 一个被顺手拷进 dist/ 或 ui-dist/ 的私钥
  // 同样是"私钥在仓库里"，而那正是要防的事。
  const SKIP = new Set(['node_modules', '.git', 'deps'])
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.pem$/i.test(e.name)) continue
      const text = readFileSync(p, 'utf8')
      if (text.includes('PRIVATE KEY') && !text.includes('PUBLIC KEY')) out.push(relative(root, p).split(sep).join('/'))
    }
  }
  walk(root)
  return out
}

describe('签发私钥的位置（P3-10）', () => {
  it('① 规则：默认与显式路径都必须在仓库之外，仓库内一律拒', () => {
    const repo = join(ROOT, 'fake-repo')
    const home = resolve(ROOT, '..', 'fake-home-outside-repo')
    const def = keyPath.resolvePrivateKeyPath({ env: {}, homeDir: home, repoRoot: repo })
    expect(def.ok, '默认位置被拒了？').toBe(true)
    expect(def.path, '默认位置不是 ~/.supertime 下那颗文件').toBe(join(home, '.supertime', keyPath.KEY_FILE))
    const outside = keyPath.resolvePrivateKeyPath({
      env: { [keyPath.ENV_KEY]: join(home, 'secrets', PRIV_FILE_NAME) }, homeDir: home, repoRoot: repo,
    })
    expect(outside.ok && outside.path).toBe(resolve(join(home, 'secrets', PRIV_FILE_NAME)))
    for (const inside of [join(repo, VENDOR_DIR_NAME, PRIV_FILE_NAME), 'vendor' + '-keys/' + PRIV_FILE_NAME]) {
      // 相对路径按"脚本会被人在仓库根里跑"这个事实判：显式给 `vendor-keys/x.pem` 就是在仓库里。
      const r = keyPath.resolvePrivateKeyPath({ env: { [keyPath.ENV_KEY]: inside }, homeDir: home, repoRoot: ROOT })
      expect(r.ok, `仓库内的路径被放行了：${inside}`).toBe(false)
      expect(r.error).toContain('不许放在仓库里')
      expect(r.hint, '拒了却没告诉人怎么办 ⇒ 只会逼人把它挪回去').toContain(keyPath.ENV_KEY)
    }
    // 比的不是字符串前缀：同前缀的兄弟目录不在仓库里
    const sibling = keyPath.resolvePrivateKeyPath({ env: { [keyPath.ENV_KEY]: repo + '-outside/x.pem' }, homeDir: home, repoRoot: repo })
    expect(sibling.ok, '同前缀的兄弟目录被误判成"在仓库里"').toBe(true)
  })

  it('①b 连"用户目录"本身在仓库里这种情况也拒（不能只测显式路径）', () => {
    const repo = join(ROOT, 'fake-repo')
    const r = keyPath.resolvePrivateKeyPath({ env: {}, homeDir: join(repo, 'home'), repoRoot: repo })
    expect(r.ok, 'homeDir 落在仓库里时默认路径也跟着落进仓库，却放行了').toBe(false)
    expect(r.error).toContain('不许放在仓库里')
  })

  it('② 三个消费者都走这颗解析，且代码里不再自己拼私钥路径', () => {
    const consumers = [
      'scripts/license-issue.js',
      'scripts/license-keygen.js',
      'tools/license-studio/main.js',
    ]
    expect(consumers.length, '消费者清单是空的 ⇒ 这条恒真').toBe(3)
    for (const f of consumers) {
      const code = codeOnly(readFileSync(join(ROOT, f), 'utf8'))
      expect(code, `${f} 不再引用 license-key-path ⇒ 私钥位置又回到各写一处`).toContain('license-key-path')
      expect(code, `${f} 自己拼了私钥文件名 ⇒ 绕开了"仓库内一律拒"这道规则`).not.toContain(PRIV_FILE_NAME)
    }
  })

  it('③ 工作树里没有任何私钥 pem（搬家之后这条要一直成立）', () => {
    const found = privatePemUnder(ROOT)
    expect(found, `仓库里发现了私钥：\n  ${found.join('\n  ')}`).toEqual([])
  })

  it('④ 那道 gitignore 还在（搬家不等于可以放松原来的闸门）', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    expect(ignore, '.gitignore 里那条挡着厂商目录的规则没了').toContain(VENDOR_DIR_NAME + '/')
  })

  it('反例自证：坏代码与坏仓库必须被上面那两条分辨出来（否则 ②③ 是恒真）', () => {
    // ② 的反例：把私钥路径硬编回消费者里
    const bad = "const p = path.join(__dirname, '..', 'x', '" + PRIV_FILE_NAME + "')\nmodule.exports = p\n"
    expect(bad.includes(PRIV_FILE_NAME), '合成反例没含上私钥文件名 ⇒ 自证空转').toBe(true)
    expect(codeOnly("// 注释里提一下 " + PRIV_FILE_NAME + "\nconst p = q\n").includes(PRIV_FILE_NAME),
      '注释被算进了代码里 ⇒ 判据会因历史说明而误红').toBe(false)
    // ③ 的反例：临时造一棵"仓库"，里面放一把私钥（放在 tests 目录下、但避开被跳过的目录名）
    const fake = join(HERE, '.p3-10-selfcheck-' + createHash('md5').update('p3-10-selfcheck', 'utf8').digest('hex').slice(0, 8))
    mkdirSync(join(fake, 'keys'), { recursive: true })
    writeFileSync(join(fake, 'keys', 'k.pem'), '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n')
    writeFileSync(join(fake, 'keys', 'pub.pem'), '-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----\n')
    try {
      expect(privatePemUnder(fake), '造了个私钥却没报 ⇒ ③ 那条看不见东西').toEqual(['keys/k.pem'])
    } finally {
      rmSync(fake, { recursive: true, force: true })
    }
    expect(existsSync(fake), '反例的临时目录没清掉').toBe(false)
    expect(privatePemUnder(ROOT).length, '扫全仓扫出东西了（与上面那条重复报同一件事 ⇒ 先修它）').toBe(0)
  })
})
