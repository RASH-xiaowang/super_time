/**
 * 拆分模块的 **ctx 接线守卫**（M21 第二十/二十一刀）。
 *
 * 为什么单独立一份：`registerXxxIpc(ctx)` 把原来靠模块作用域的依赖改成从 `ctx` 拿，
 * 于是「哪些字段」成为**两处事实** —— 模块里的 `const { … } = ctx` 与 main.js 的实参字面量。
 * 两种错法都只在运行期炸，静态检查抓不到：
 *   · 解构了但调用点没传 ⇒ 拿到 `undefined`（`installWebContentsGuards` 漏传时，
 *     `app.on('web-contents-created')` 那条**惰性回调**注册期不报错，真开窗才抛 ⇒ 安全守卫静默失效）；
 *   · 模块里没解构就直接用 ⇒ `ReferenceError`（`backendStatus` 在 `wechat:backend-state` 里
 *     每次都炸；`installWebContentsGuards` 也在另一分支上炸过一次）。
 *
 * 关键设计（踩过一次）：**名字全集的来源必须独立于被检查的文件**。第一版把「全集」取成
 * 「各模块解构字段的并集」—— 于是把某个字段从解构里删掉，它同时从全集里消失了，检查自己失明
 * （变异测试当场证明：漏解构 `ipcMain` 时三条断言只红一条）。现在全集取自 **main.js 的实参键**
 * （另一侧的事实）加上「只走 getter 的量名」（这类名字永远不在实参里）。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { grp } from './helpers/strict-index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const BACKEND = join(ROOT, 'src', 'backend')
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')

/** 拆分出来的模块：`src/backend/ipc-*.js`（`ipc-misc.js` / `ipc-wechat.js` / 以后每一刀）。 */
const MODULES = readdirSync(BACKEND).filter((f) => /^ipc-[a-z-]+\.js$/.test(f)).sort()

/**
 * 只经 **getter** 暴露的量名：`wechatBackend` / `wechatBoot` / `backendStatus` / `mainWindow`。
 * 调用点传的是 `getBackendStatus` 这类 getter，所以这些名字**永远不在实参里** ——
 * 从 main.js 取全集时看不见它们，必须显式列出（`...backendStatus` 这种裸用正好从缝里漏过）。
 */
const GETTER_ONLY = ['wechatBackend', 'wechatBoot', 'backendStatus', 'mainWindow'] as const

/** 模块里 `const { a, b } = ctx;` 的字段名（可以有多处解构）。 */
function ctxFields(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*ctx\s*;/g)) {
    for (const part of grp(m, 1, 'ctx 解构').split(',')) {
      const name = (part.split(':')[0] ?? '').trim()
      if (name) out.push(name)
    }
  }
  return out
}

/** 模块里的注册函数名（`function registerWechatIpc(ctx) {`）。 */
function registrar(src: string): string | null {
  const m = /function\s+(register\w*Ipc)\s*\(\s*ctx\s*\)/.exec(src)
  return m ? grp(m, 1, '注册函数名') : null
}

/** `fn({ … })` 实参对象字面量顶层的键（含缩写键 `app`）；没有调用点则返回 null。 */
function callKeys(src: string, fn: string): string[] | null {
  const at = src.indexOf(fn + '({')
  if (at < 0) return null
  const start = src.indexOf('{', at)
  let depth = 0
  let end = -1
  for (let i = start; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{' || c === '(' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) throw new Error(`${fn} 的实参对象字面量没有闭合`)
  const keys: string[] = []
  let seg = ''
  let d = 0
  // 行注释先摘掉，免得注释里的逗号被当成字段分隔
  for (const c of src.slice(start + 1, end).replace(/\/\/[^\n]*/g, '')) {
    if (c === '{' || c === '(' || c === '[') d += 1
    else if (c === '}' || c === ')' || c === ']') d -= 1
    if (c === ',' && d === 0) { keys.push(seg); seg = '' } else seg += c
  }
  keys.push(seg)
  return keys.map((s) => (s.split(':')[0] ?? '').trim()).filter(Boolean)
}

/** 剥掉注释与字符串字面量：只留下真实代码。 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
}

/** 模块里**裸用**了哪些 ctx 名字（既不解构、也不是本地声明）。 */
function bareCtxUses(src: string, universe: readonly string[]): string[] {
  const code = codeOnly(src)
  const destructured = new Set(ctxFields(src))
  const local = new Set<string>([
    ...code.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g),
  ].map((m) => grp(m, 1, '本地声明')))
  const bad: string[] = []
  for (const name of universe) {
    if (destructured.has(name) || local.has(name)) continue
    // 普通裸用：前面不是 `.` / 标识符字符
    const bare = new RegExp('(?<![.\\w$])' + name + '\\b')
    // 展开：`...backendStatus`（前面的 `.` 会骗过上面的 lookbehind，必须单独抓）
    const spread = new RegExp('\\.\\.\\.\\s*' + name + '\\b')
    if (bare.test(code) || spread.test(code)) bad.push(name)
  }
  return bad
}

const LOADED = MODULES.map((f) => { const src = readFileSync(join(BACKEND, f), 'utf8'); return { file: f, src, registrar: registrar(src) } })

/** 全集 = main.js 各调用点的实参键（独立于模块内容）∪ 只走 getter 的量名。 */
const UNIVERSE = [...new Set([
  ...LOADED.flatMap((m) => (m.registrar ? callKeys(mainSrc, m.registrar) ?? [] : [])),
  ...GETTER_ONLY,
])].sort()

describe('拆分模块的 ctx 接线：两侧事实必须对得上', () => {
  it('守卫覆盖到了拆分模块（防空转：模块与字段都不能是空）', () => {
    expect(MODULES.length, 'src/backend 下没找到 ipc-*.js').toBeGreaterThan(0)
    expect(UNIVERSE.length, '从 main.js 一个实参键都没解析出来（正则或写法变了？）').toBeGreaterThan(10)
    for (const m of LOADED) {
      expect(m.registrar, `${m.file} 里找不到 register*Ipc(ctx) —— 守卫无法定位调用点`).not.toBeNull()
    }
  })

  for (const { file, src, registrar: fn } of LOADED) {
    const passed = fn ? callKeys(mainSrc, fn) : null
    const need = ctxFields(src)

    it(`${file} → ${fn}：main.js 里有调用点，且解构的每个字段都传了`, () => {
      expect(passed, `main.js 里找不到 ${fn}({…}) 调用点`).not.toBeNull()
      for (const f of need) {
        expect(passed, `main.js 没给 ${fn} 传 \`${f}\` —— 模块里会拿到 undefined，直到那行代码真被执行才炸`)
          .toContain(f)
      }
    })

    it(`${file}：main.js 传了但模块不解构的字段要清掉（两份清单别各走各的）`, () => {
      for (const f of passed ?? []) {
        expect(need, `main.js 传了 \`${f}\`，但 ${file} 并不解构它（要么删实参，要么补解构）`).toContain(f)
      }
    })

    it(`${file}：不许裸用 ctx 名字（漏解构就是 ReferenceError）`, () => {
      const bad = bareCtxUses(src, UNIVERSE)
      expect(bad, `${file} 里这些名字既没解构也没声明：${bad.join(', ')}`).toEqual([])
    })
  }
})
