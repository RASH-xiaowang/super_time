/**
 * 令牌引用门禁：CSS 里不许出现「从未定义、且没有兜底值」的 `--nm-*`。
 *
 * 起因是 `kb-switcher.module.css` 整份按一套**本项目不存在的**令牌名写的
 * （`--nm-surface-1/2/3`、`--nm-line-2/3`、`--nm-overlay`、`--nm-shadow-lg`）。
 * 自定义属性引用一个未定义且无兜底的变量时，声明会在计算期失效：
 *   · `background: var(--nm-surface-1)` → 计算成 `rgba(0,0,0,0)`（全透明）；
 *   · `border: 1px solid var(--nm-line-2)` → 整条丢弃，计算成 `0px none`。
 * 于是知识库的「⋯」菜单与三个弹层**没有底**，底下的正文直接透上来 —— 而构建、
 * 类型检查、SSR 冒烟全绿，只有肉眼看得到。这类缺陷静态检查看不见，所以把口径钉在这里。
 *
 * 判定故意保守：只报「未定义 **且** 无兜底值」的引用。带兜底的（如 `var(--nm-r-sm, 6px)`）
 * 是历史写法，会退化成字面量而不是消失，不在这次治理范围内。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 扫描根：整个前端源码（令牌定义散在 scifi-theme.css / light-theme.css 里）。 */
const CLIENT_ROOT = join(HERE, '..', '..', '..', '..', '..')

/**
 * 递归列出目录下匹配后缀的文件。
 * @param dir - 目录绝对路径。
 * @param exts - 允许的后缀集合。
 * @returns 文件绝对路径列表。
 */
function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, exts))
    else if (exts.test(e.name)) out.push(p)
  }
  return out
}

describe('主题令牌引用', () => {
  it('CSS 里不存在「未定义且无兜底」的 --nm-* 引用', () => {
    // 定义侧同时看 .ts/.tsx：有些令牌是运行期在 TS 里 setProperty 上去的。
    const defined = new Set<string>()
    for (const f of walk(CLIENT_ROOT, /\.(css|ts|tsx)$/)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(--nm-[a-z0-9-]+)\s*:/g)) defined.add(m[1])
    }
    expect(defined.size, '一个令牌定义都没抓到 ⇒ 扫描根配错了').toBeGreaterThan(50)

    const dangling: string[] = []
    for (const f of walk(CLIENT_ROOT, /\.css$/)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/var\((--nm-[a-z0-9-]+)(\s*,)?/g)) {
          if (!defined.has(m[1]) && !m[2]) {
            dangling.push(`${relative(CLIENT_ROOT, f)}:${i + 1} 引用了未定义的 ${m[1]}`)
          }
        }
      })
    }
    expect(dangling, '这些声明会静默失效（背景变透明 / 整条 border 被丢弃）：\n' + dangling.join('\n')).toEqual([])
  })
})
