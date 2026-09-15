/**
 * H14：Remote 接口参考必须与 `gateway.ts` 一致。
 *
 * 背景：这份文档以前是手写的，于是「方法数三方打架」—— 源码 132、RAG 文档 126、
 * 后端 README 114、启动页也写 114。现在文档由 `scripts/gen-api-docs.js` 从
 * `@Remote` 装饰器生成，这条用例守两件事：
 *   ① `docs/API.md` 与源码的方法集合双向无差集（且计数不是空转的）；
 *   ② 生成与校验的**接线**还在（npm script、CI 步骤、启动页上那个用户可见的数字）。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const gateway = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts'), 'utf8')
const docPath = join(ROOT, 'docs', 'API.md')

/** 源码里的方法集合（去重，便于发现重复注册）。 */
const remoteNames = [...gateway.matchAll(/@Remote\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
const remoteSet = new Set(remoteNames)

/** 文档明细里的方法集合。 */
const docText = existsSync(docPath) ? readFileSync(docPath, 'utf8') : ''
const docSet = new Set([...docText.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]))

describe('H14：Remote 接口参考', () => {
  it('文档存在，且声明的数量与源码一致', () => {
    expect(existsSync(docPath), 'docs/API.md 不存在：请运行 npm run docs:api').toBe(true)
    // 防空转：解析失效时（两个集合都空）这条必须红
    expect(remoteSet.size).toBeGreaterThan(100)
    const declared = /当前共 \*\*(\d+)\*\* 个 Remote 方法/.exec(docText)?.[1]
    expect(declared).toBe(String(remoteSet.size))
  })

  it('文档与源码双向无差集', () => {
    const missing = [...remoteSet].filter((n) => !docSet.has(n))
    const extra = [...docSet].filter((n) => !remoteSet.has(n))
    expect(missing, '源码里有、文档里没有的方法（忘记重生成？）').toEqual([])
    expect(extra, '文档里有、源码里没有的方法').toEqual([])
  })

  it('源码里没有重复注册的 @Remote 名字', () => {
    // 重复会给「按名字调用」带来歧义（历史上 getSnsVideoCoverDataUrl 曾被挂两次装饰器）
    expect(remoteNames.length).toBe(remoteSet.size)
  })

  it('生成/校验脚本与 CI 接线都在（否则这条门禁可被静默移除）', () => {
    expect(existsSync(join(ROOT, 'scripts', 'gen-api-docs.js'))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['docs:api']).toContain('gen-api-docs.js')
    expect(pkg.scripts['docs:api:check']).toContain('--check')
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('docs:api:check')
  })

  it('启动页上用户可见的方法数与源码一致', () => {
    // 启动页 rail 上写着「REMOTE API 132」这类数字，属于用户可见的契约声明。
    // 它以前是 114（严重过期），而且没有任何东西会发现 —— 这条就是那个「东西」。
    const shell = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'onboarding', 'OnboardingShell.tsx'), 'utf8')
    const m = /k:\s*'REMOTE API'\s*,\s*v:\s*'(\d+)'/.exec(shell)
    expect(m, '启动页里找不到 REMOTE API 的计数（若已改版请同步本用例）').toBeTruthy()
    expect(m![1], '启动页的 Remote 方法数已过期：改成 gateway.ts 里的实际值').toBe(String(remoteSet.size))
  })

  /**
   * M22：文档里的方法数必须与源码一致（此前「三方打架」）。
   *
   * M22 的处置是「修正引用 + 让数字有唯一来源」：这几处文档要么写明权威值，
   * 要么显式声明「以 `docs/API.md` 为准」；**任何过期数字（114/126/129）都不许再出现**。
   * 允许「不写数字、指向 docs/API.md」是因为那才是不会腐坏的形式。
   */
  it('文档里的方法数不再过期（M22）', () => {
    const N = String(remoteSet.size)
    const docs: Array<{ path: string; note: string }> = [
      { path: join('src', 'client', 'README.md'), note: '前端 README' },
      { path: join('docs', 'rag', 'RAG-ARCHITECTURE.md'), note: 'RAG 架构文档' },
      { path: join('src', 'backend', 'README.md'), note: '后端 README' },
    ]
    for (const { path, note } of docs) {
      const abs = join(ROOT, path)
      if (!existsSync(abs)) continue
      const text = readFileSync(abs, 'utf8')
      for (const stale of ['114', '126', '129']) {
        // 只盯「N 个 Remote 方法 / 方法数 … 114」这类声明，别把版本号/行号误伤
        const claim = new RegExp(`方法数[^\\n]{0,24}\\b${stale}\\b|\\b${stale}\\b\\s*个\\s*Remote`)
        expect(claim.test(text), `${note} 里仍有过期方法数 ${stale}：请改成 ${N} 或改为「以 docs/API.md 为准」`).toBe(false)
      }
      // 要么写明权威值，要么显式指向自动生成的清单
      const ok = text.includes(N) || text.includes('docs/API.md')
      expect(ok, `${note} 既没写出 ${N} 也没指向 docs/API.md —— M22 的修复没有落地`).toBe(true)
    }
  })
})
