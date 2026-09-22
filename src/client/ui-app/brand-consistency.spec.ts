/**
 * 品牌口径守卫：全应用只有一个名字 —— **Super Time**。
 *
 * 背景：产品早期叫「微信+」，改名后旧名散落在窗口标题、引导页、许可页、后端错误文案里
 * （本轮实测：33 个文件 65 处）。这类残留没有任何测试会变红 —— 界面照常渲染，
 * 只是同一个应用在不同位置叫两个名字，而这恰恰是用户第一眼就会看到的。
 *
 * 两处需要区分的措辞，别让守卫把对的判成错的：
 *   · 「微信」单独出现是**数据来源**（WeChat 的本地解密库），不是品牌，必须保留；
 *   · `docs/RELEASE-PLAN.md` 是历史评审记录，里面的旧名是**当时的原话引用**
 *     （用于佐证 main.js 当时的报错文案），改写它会篡改历史，因此**有意排除**。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** src/client/ui-app → 仓库根 */
const ROOT = join(HERE, '..', '..', '..')

/**
 * 有意排除的路径：
 *   · `docs/RELEASE-PLAN.md` —— 历史评审记录，里面的旧名是当时的原话引用
 *     （用来佐证 main.js 当时的报错文案），改写它会篡改历史；
 *   · 本文件自身 —— 守卫的说明与断言描述里必然要提到旧名；
 *   · 构建产物与依赖 —— 由源码生成/第三方，不承载我方口径。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'ui-dist', 'output', '.worktrees', '.workbuddy'])
const SELF = 'src/client/ui-app/brand-consistency.spec.ts'
const SKIP_FILES = new Set(['docs/RELEASE-PLAN.md', SELF])
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|json|css|html|md|yml|yaml)$/i

/** 旧品牌名。拼出来而不是写字面量：否则本文件会命中自己的扫描规则。 */
const LEGACY = '微信' + '+'

/** 递归收集仓库内的文本文件（相对路径，正斜杠）。 */
function walk(rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.tmp-')) continue
      out.push(...walk(r))
    } else if (TEXT_EXT.test(e.name) && !SKIP_FILES.has(r)) {
      out.push(r)
    }
  }
  return out
}

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** 宿主层源码的联合（M21 把 IPC 频道拆进了 src/backend/ipc-*.js：界面文案断言跟到哪份都算数）。 */
const readHost = (): string => [read('main.js')]
  .concat(readdirSync(join(ROOT, 'src', 'backend')).filter((f) => /^ipc-[a-z]+\.js$/.test(f)).sort()
    .map((f) => read(join('src', 'backend', f)))).join('\n')

describe('品牌统一为 Super Time', () => {
  it('仓库（除历史记录文档外）不得再出现旧名「微信+」', () => {
    const files = walk()
    expect(files.length, '扫描到的文件太少，说明遍历逻辑坏了').toBeGreaterThan(100)
    const hits: string[] = []
    for (const rel of files) {
      read(rel).split(/\r?\n/).forEach((line, i) => {
        if (line.includes(LEGACY)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }
    expect(hits, `旧品牌名残留 ${hits.length} 处：\n${hits.join('\n')}`).toEqual([])
  })

  it('「微信」作为数据来源仍然保留（改名不能把数据源一起改掉）', () => {
    expect(read('src/backend/wechat-paths.js')).toContain('微信')
    expect(read('src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx')).toContain('微信数据')
  })

  it('窗口标题与页面标题都是 Super Time（两边是不同来源，都会覆盖 OS 标题栏）', () => {
    // main.js 的 BrowserWindow.title 会被页面 <title> 覆盖，所以两处都得对
    expect(read('main.js')).toContain("title: 'Super Time'")
    expect(read('src/client/ui-app/index.html')).toContain('<title>Super Time</title>')
  })

  it('导航栏里的品牌名是 Super Time（本轮由顶栏迁入的品牌位）', () => {
    const panel = read('src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx')
    const brand = panel.match(/css\.navBrandName\}>([^<]*)</)?.[1] ?? ''
    expect(brand.trim()).toBe('Super Time')
  })

  it('后端错误文案也走新名（这些字符串会直接显示在界面上）', () => {
    expect(readHost()).toContain("'Super Time 后端未初始化'")
    expect(read('src/backend/wechat-worker.js')).toContain("'Super Time 后端未初始化'")
    expect(readHost()).toContain('Super Time 后端连续')
  })
})
