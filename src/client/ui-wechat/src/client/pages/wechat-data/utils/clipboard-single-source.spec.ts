// @vitest-environment jsdom
/**
 * 剪贴板只许一份实现（P3 同族：同一件事的第二份写法）。
 *
 * ## 这条为什么值得钉
 *
 * `utils/misc.ts#copyTextToClipboard` 一直是本仓的**唯一**复制出口：它把
 * 「异步 Clipboard API 被拒」（窗口失焦、权限被挡是常态）收敛成 `false`，
 * 并且还会试 `execCommand('copy')` 那条退路。
 * 而实测有 **8 个面板里的 10 处**各自手写 `navigator.clipboard.writeText(...)` + `catch`：
 * 那些站点**没有退路**，被拒时只能说「复制失败」（其实本可以复制成功），
 * 其中 `moments-panel` 更把失败静默吞掉（`.catch(() => {})`），用户看到的还是「已复制」的下一步。
 * `ReplySuggest.tsx` 早在一次整改里写过一条**只管自己那个文件**的判据
 * （`reply-suggest.wiring.spec.ts`：复制必须走共享助手）—— 这正是「规则没有全仓化」的下场：
 * 修了一处，另外九处原地不动。这里把那条升成零容忍闸门。
 *
 * ## 判据的口径
 *
 *  1. **零容忍扫描**：`navigator.clipboard` / `document.execCommand` 只许出现在唯一出处；
 *     扫描走 AST 取成员访问，注释里写的那句 `navigator.clipboard.writeText` 不算
 *     （`ReplySuggest.tsx` 的注释里就有，按文本匹配会误报 —— 与 `module-cycle-guard` 同一个理由）。
 *  2. **行为**：成功不碰退路；被拒走退路；两边都坏才 `false`；退路抛异常也要把临时 textarea 摘干净。
 *  3. **反例自证**：判据对一段「手写版」夹具必须报出来，否则第 1 条是恒真。
 * @module clipboard-single-source
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { copyTextToClipboard } from './misc.ts'

/**
 * 仓库根：往上找到 `vitest.config.ts` 为止。
 * 两个坑都实测踩过：① 数 `'..'` 的层数会少数一层（第一版扫到 `src/src/client` 直接 ENOENT）；
 * ② 以 `package.json` 为标记会停在 `ui-wechat` 子包上（那里也有一份），扫描面只剩一半。
 */
function findRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 12; i += 1) {
    if (statSync(join(dir, 'vitest.config.ts'), { throwIfNoEntry: false })?.isFile()) return dir
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  throw new Error('找不到仓库根（一路上没有 vitest.config.ts）')
}

const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'src', 'client')
const OWNER = 'src/client/ui-wechat/src/client/pages/wechat-data/utils/misc.ts'

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'ui-dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { sources(p, out); continue }
    if (!statSync(p).isFile()) continue
    if (!/\.(ts|tsx)$/.test(e.name) || e.name.endsWith('.d.ts') || /\.spec\./.test(e.name)) continue
    out.push(p)
  }
  return out
}

/**
 * 取一份源码里**真的在用**剪贴板的表达式（注释里的字样在语法树里不是节点）。
 * @param file - 绝对路径。
 * @returns 命中的成员访问文本（去重）。
 */
function clipboardUses(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, code.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(sf)
      if (text === 'navigator.clipboard' || text === 'document.execCommand') hits.add(text)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return [...hits]
}

describe('剪贴板：唯一出处（零容忍）', () => {
  const files = sources(CLIENT)
  /** 每份源码只解析一次：`[相对路径, 命中列表]`。 */
  const scanned = files.map((f) => [relative(ROOT, f).replace(/\\/g, '/'), clipboardUses(f)] as const)
  const hits = scanned.flatMap(([, u]) => u)
  const offenders = scanned.filter(([, u]) => u.length > 0).map(([p]) => p).filter((p) => p !== OWNER)

  it('扫到的是整棵客户端树（少一个子树这条判据就只守半个仓）', () => {
    const seen = new Set(files.map((f) => relative(ROOT, f).replace(/\\/g, '/').split('/')[2]))
    console.log(`[算料|clipboard] 客户端源文件 ${String(files.length)} 个、命中 ${String(hits.length)} 处，子树：${[...seen].sort().join(' / ')}`)
    // 不猜总数的下界（195 是实测，机器/分支不同就漂）；改成钉「两棵产物树都在扫描面里」这一件结构事实
    expect(seen.has('ui-wechat'), '没扫到 ui-wechat ⇒ ROOT 停在了子包里').toBe(true)
    expect(seen.has('ui-app'), '没扫到 ui-app ⇒ 扫描面少了一棵').toBe(true)
    // 两种写法都要认得出来，否则「除唯一出处外没有」可能只是因为提取坏了一个
    expect([...new Set(hits)].sort()).toEqual(['document.execCommand', 'navigator.clipboard'])
  })

  it('除唯一出处外，任何文件都不许自己碰剪贴板', () => {
    expect(offenders, `这些地方绕过共享助手了（没有 execCommand 退路，被拒就等于没复制）：\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('反例自证：一段手写版必须被抓出来', () => {
    const fake = join(CLIENT, 'pages', 'wechat-data', 'panels', '__probe__.tsx')
    const sf = ts.createSourceFile(fake, 'export const f = async (): Promise<void> => {\n  await navigator.clipboard.writeText("x")\n  /* navigator.clipboard 在注释里不算 */\n  document.execCommand("copy")\n}\n', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const hits = new Set<string>()
    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const t = node.getText(sf)
        if (t === 'navigator.clipboard' || t === 'document.execCommand') hits.add(t)
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
    expect([...hits].sort()).toEqual(['document.execCommand', 'navigator.clipboard'])
  })
})

describe('copyTextToClipboard 的行为（被 8 个面板依赖，它自己必须可验）', () => {
  /**
   * jsdom **不实现** `document.execCommand`，所以退路这一支要自己装一个假的：
   * `vi.spyOn` 在那里会直接报「execCommand does not exist」（实测）。
   * @param mode - 'ok' 复制成功 / 'fail' 返回 false / 'throw' 自己抛 / 'absent' 干脆没有这个 API。
   */
  const withExec = (mode: 'ok' | 'fail' | 'throw' | 'absent', fn: (calls: { n: number }) => Promise<void>): Promise<void> => {
    const doc = document as unknown as { execCommand?: (id: string) => boolean }
    const original = doc.execCommand
    const calls = { n: 0 }
    if (mode !== 'absent') {
      doc.execCommand = (): boolean => {
        calls.n += 1
        if (mode === 'throw') throw new Error('boom')
        return mode === 'ok'
      }
    }
    return fn(calls).finally(() => {
      if (original) doc.execCommand = original
      else delete doc.execCommand
    })
  }

  /** 装一个异步 Clipboard API（`writeText` 成功或注定被拒）。 */
  const withClipboard = (impl: 'ok' | 'denied' | 'absent', fn: () => Promise<void>): Promise<void> => {
    const value = impl === 'absent'
      ? undefined
      : { writeText: async (): Promise<void> => { if (impl === 'denied') throw new Error('NotAllowedError') } }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
    return fn().finally(() => { delete (navigator as unknown as { clipboard?: unknown }).clipboard })
  }

  it('异步 API 成功 ⇒ true，且不碰 execCommand 退路', async () => {
    await withExec('ok', async (calls) => {
      await withClipboard('ok', async () => {
        expect(await copyTextToClipboard('甲')).toBe(true)
      })
      expect(calls.n, '成功路径不该再去动退路').toBe(0)
    })
  })

  it('异步 API 被拒 ⇒ 走 execCommand，并如实回它的结果', async () => {
    await withExec('ok', async (calls) => {
      await withClipboard('denied', async () => {
        expect(await copyTextToClipboard('乙')).toBe(true)
      })
      expect(calls.n, '被拒时没试退路 ⇒ 这一支的本意就是补上这条').toBe(1)
    })
  })

  it('两条路都不行才是 false（不许把「试过了」演成「成功了」）', async () => {
    await withExec('fail', async (calls) => {
      await withClipboard('denied', async () => {
        expect(await copyTextToClipboard('丙')).toBe(false)
      })
      expect(calls.n).toBe(1)
    })
  })

  it('没有 navigator.clipboard 时也不炸（老内核 / 非安全上下文）', async () => {
    await withExec('ok', async (calls) => {
      await withClipboard('absent', async () => {
        expect(await copyTextToClipboard('丁')).toBe(true)
      })
      expect(calls.n).toBe(1)
    })
  })

  it('退路自己抛异常也要把临时 textarea 摘干净（否则每次失败留一个隐藏节点）', async () => {
    const before = document.querySelectorAll('textarea').length
    await withExec('throw', async () => {
      await withClipboard('denied', async () => {
        expect(await copyTextToClipboard('戊')).toBe(false)
      })
    })
    expect(document.querySelectorAll('textarea').length, '留下了没摘掉的 textarea').toBe(before)
  })
})
