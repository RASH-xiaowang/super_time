/**
 * R4 状态组件守卫：`ErrorState` / `LoadingState` 的形态不变量。
 *
 * 仓库没有组件测试环境（无 jsdom 渲染层），所以这里做**源码级**断言 ——
 * 与 `kit-css-split.wiring.spec.ts` / `transient-notice.wiring.spec.ts` 同一套路。
 *
 * ## 为什么这几条是「真不变量」
 *
 * R4 勘察到的病灶是**形态漂移**：同一个语义在不同面板被写成不同样子，而且没人报错。
 *   · 错误态：48 处渲染横跨 31 个面板，7 个面板自定义 `.error`，6 处漏 `role="alert"`；
 *   · 加载态：同一句「加载中」有骨架 / 一行字 / 复用空态三种形态，
 *     `PrivacyTrust` 的加载与空态**共用 `.emptyInline`** ⇒ 语义塌成一团。
 *
 * 这些断言全部**切片到函数体 / 规则体**，不用「文件里出现过」这种能被 import 行
 * 骗过的写法 —— R3 的变异测试抓出过两条恒真的守卫（`toContain('fnName')` 会被
 * `import { fnName }` 命中），这里不重蹈。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = dirname(HERE) // wechat-data
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const KIT_FIELDS = read(join(HERE, 'kit-fields.tsx'))
const KIT_CSS = read(join(HERE, 'kit.module.css'))

/** 去注释（静态分析前必做 —— 本仓注释里大量出现类名/代码片段，会造成假阳性）。 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * 取一个函数的**完整定义**（含参数类型注解与函数体）。
 *
 * ⚠️ 不能用「第一个顶格 `}`」定位 —— 组件形如
 *   `export function X({ a, b }: {\n  a: T\n  b?: T\n}): React.JSX.Element { … }`
 * 参数类型的闭合 `}` 也是顶格的，会把签名当成函数体（R4 第一版就栽在这里）。
 * 正解：找到参数表闭合的 `)` 之后的第一个 `{`，再从那里配平花括号。
 */
function fnBody(src: string, name: string): string {
  const s = stripComments(src)
  const start = s.indexOf(`export function ${name}(`)
  expect(start, `找不到 export function ${name}`).toBeGreaterThanOrEqual(0)
  // 参数表可能跨行，先配平圆括号找到参数表结束。
  let i = s.indexOf('(', start)
  let pd = 0
  for (; i < s.length; i += 1) {
    if (s[i] === '(') pd += 1
    else if (s[i] === ')') { pd -= 1; if (pd === 0) break }
  }
  // 跳过返回类型注解（如 `: React.JSX.Element`），落到函数体的 `{`。
  const bodyStart = s.indexOf('{', i)
  expect(bodyStart, `${name} 找不到函数体`).toBeGreaterThan(i)
  let d = 0
  let j = bodyStart
  for (; j < s.length; j += 1) {
    if (s[j] === '{') d += 1
    else if (s[j] === '}') { d -= 1; if (d === 0) break }
  }
  expect(d, `${name} 花括号未配平`).toBe(0)
  return s.slice(start, j + 1)
}

describe('R4 ErrorState：红框 + role="alert" 必须绑在一起', () => {
  it('ErrorState 函数体里带 role="alert"', () => {
    expect(fnBody(KIT_FIELDS, 'ErrorState')).toContain('role="alert"')
  })

  it('ErrorState 复用 kit 的 .error 类（不新造类）', () => {
    const body = fnBody(KIT_FIELDS, 'ErrorState')
    // 钉 `css.error` 这个**引用**（`css.errorMain` 等以 .error 开头也会命中，
    // 所以再断言它不是别的 css 名字）。
    expect(body).toMatch(/\bcss\.error\b/)
  })

  it('kit.module.css 有 .error 规则且带红色（danger）', () => {
    const m = /(?:^|\n)\.error \{\n([\s\S]*?)\n\}/.exec(stripComments(KIT_CSS))
    expect(m, '找不到 .error 规则').toBeTruthy()
    expect(m?.[1] ?? '').toContain('--nm-danger')
  })

  it('ErrorState 的 onRetry 渲染一个 button（可重试的失败有出路）', () => {
    const body = fnBody(KIT_FIELDS, 'ErrorState')
    expect(body).toContain('onRetry &&')
    expect(body).toMatch(/<button[^>]*onClick=\{onRetry\}/)
  })
})

describe('R4 LoadingState：任何一档都不得复用空态视觉', () => {
  const body = fnBody(KIT_FIELDS, 'LoadingState')

  it('LoadingState 函数体不含 emptyInline / css.empty（否则又变成「加载 = 没数据」）', () => {
    expect(body).not.toContain('emptyInline')
    // `css.empty` 后面不能跟字母（`css.emptyInto` 之类不算）
    expect(body).not.toMatch(/\bcss\.empty(?![A-Za-z0-9_])/)
  })
  it('LoadingState 的三档由 data-st-loading 标记（便于守卫与调试定位）', () => {
    expect(body).toMatch(/data-st-loading=/)
    for (const v of ['skeleton', 'compact', 'timed']) {
      expect(body, `缺 ${v} 档`).toContain(`'${v}'`)
    }
  })

  it('timed 档接「已等待 Ns」——调用方传 since（hook 调用点不在本组件内）', () => {
    expect(body).toMatch(/since\s*!==\s*undefined|\bsince\b/)
    expect(body).toContain('已等待')
  })

  it('compact / timed 档带 role="status"（读屏可播报状态变化）', () => {
    expect(body).toContain('role="status"')
  })

  it('kit.module.css 的 .loadingState 规则不复用空态的**类**（间距令牌 --nm-empty-pad 是正当复用）', () => {
    const m = /(?:^|\n)\.loadingState \{\n([\s\S]*?)\n\}/.exec(stripComments(KIT_CSS))
    expect(m, '找不到 .loadingState 规则').toBeTruthy()
    const decl = m?.[1] ?? ''
    // 钉「不引用空态**类**」而非「不含 empty 字样」：`var(--nm-empty-pad)` 只是间距令牌，
    // 是正当复用；真正要禁的是 `@extend`/选择器式的类引用（本项目靠显式类名，故不存在，
    // 这条作为将来的防回归闸门）。
    expect(decl).not.toMatch(/\.emptyInline\b/)
    expect(decl).not.toMatch(/\.empty(?![A-Za-z0-9_-])/)
  })
})

describe('R4 全仓：错误态不得再各自造样式', () => {
  const PANEL_CSS_DIR = join(DATA, 'panels')

  it('panels/*.module.css 里不得再定义 .error / .errBanner（一律用 kit 的）', () => {
    const offenders: string[] = []
    for (const f of readdirSync(PANEL_CSS_DIR).filter((n) => n.endsWith('.module.css'))) {
      const src = stripComments(read(join(PANEL_CSS_DIR, f)))
      if (/(?:^|\n)\.(error|errBanner)(?![A-Za-z0-9_-])/.test(src)) offenders.push(f)
    }
    expect(offenders, `这些面板仍自定义错误样式：${offenders.join(', ')}`).toEqual([])
  })

  it('所有用 emptyInline 渲染 *rror / *Err 的地方都改用 ErrorState', () => {
    // 扫全仓 .tsx：找出「错误变量 + 空态样式」的渲染点。
    //
    // ⚠️ R4 第一版只匹配 `{error && <div …}`，于是**漏掉了** `{groupInfoErr && <div …>}`
    // —— 复用 `kitCss.emptyInline` 渲染错误、没有 role="alert"，而且看代码完全不像错误
    // （变量名是 groupInfoErr，不是 error）。用 /[Ee]rr/ 兜住各种命名（err / error /
    // groupInfoErr / scanError / loadErr…），只要求「变量名含 err/Error」。
    // 允许 .spec.tsx 跳过（测试夹具不算产品代码）。
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.tsx') || e.name.endsWith('.spec.tsx')) continue
        stripComments(read(p)).split('\n').forEach((ln) => {
          // 取 `{...}` 里的条件部分（`&&` 之前）再判。
          const cond = /\{([^}]*?)\s*&&\s*<div/.exec(ln)?.[1] ?? ''
          // `errX &&` 才算错误分支；`!xxxError &&`、`foo && !readError &&` 是「没有错误时」，
          // 属正当空态。判定：条件里出现了**未被 `!` 否定的** err 变量。
          // ⚠️ `\w*[Ee]rr\w*` 的首个 `\w*` 必须允许**零个字符**：`error` 的 `err` 就在词首，
          // 写成 `[A-Za-z_$][\w$]*[Ee]rr...`（要求 err 前至少 1 字符）会**匹配不到 error 本体**——
          // R4 变异 M5 就是靠这个假阴性溜过去的。
          const mentioned = [...cond.matchAll(/(?<![A-Za-z0-9_$.])(!?)\s*(\w*[Ee]rr\w*)/g)]
          if (mentioned.length === 0) return
          if (mentioned.every((m) => m[1] === '!')) return
          if (/emptyInline|css\.empty(?![A-Za-z0-9_])/.test(ln)) offenders.push(`${e.name}  ${ln.trim().slice(0, 70)}`)
        })
      }
    }
    walk(DATA)
    expect(offenders, `这些错误态仍在用空态样式渲染（该用 ErrorState）：\n${offenders.join('\n')}`).toEqual([])
  })

  it('所有渲染 error 的地方都带 role="alert" 或用 ErrorState', () => {
    // 扫全仓 .tsx：找出 `{error && <div ...>` 形态的渲染点，要求同一行有 role="alert"
    // 或紧随 ErrorState。允许 .spec.tsx 跳过（测试夹具不算产品代码）。
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.tsx') || e.name.endsWith('.spec.tsx')) continue
        stripComments(read(p)).split('\n').forEach((ln) => {
          const cond = /\{([^}]*?)\s*&&\s*<div/.exec(ln)?.[1] ?? ''
          const mentioned = [...cond.matchAll(/(?<![A-Za-z0-9_$.])(!?)\s*(\w*[Ee]rr\w*)/g)]
          if (mentioned.length === 0 || mentioned.every((m) => m[1] === '!')) return
          if (ln.includes('role="alert"') || ln.includes('ErrorState')) return
          offenders.push(`${e.name}  ${ln.trim().slice(0, 70)}`)
        })
      }
    }
    walk(DATA)
    expect(offenders, `这些渲染点漏了 role="alert"：${offenders.join(', ')}`).toEqual([])
  })
})

describe('R4 全仓：加载态不得复用空态视觉', () => {
  /**
   * 「加载中」文案 + `.emptyInline` / `.empty` = 语义塌成一团（用户分不清「在跑」和「没有」）。
   * R4 前有 13 处这么写，已全部收编到 `<LoadingState variant="compact">`。
   *
   * 白名单用**文件名 + 文案片段**而不是行号 —— 因为扫描前会剥注释、行号会漂，
   * 行号白名单迟早对错行（而且它会随任何一次编辑腐化）。文案片段是稳定的语义锚。
   */
  const LOADING_EMPTY_ALLOW = new Set([
    // 带旋转图标的生成中提示：形态比 compact 更丰富（有 spinner），收编会倒退。
    'DailySummary.tsx|正在收集当日消息并生成总结',
    // `LazyMount` 的 placeholder（「进入可视区后加载」）—— 是**懒挂载占位**，不是正在加载。
    'overview-panel.tsx|地图进入可视区后加载',
  ])

  const LOADING_RE = /加载|正在|统计中|搜索中|检查中/

  it('「加载中/正在/统计中/搜索中」一行提示不得用 emptyInline / empty', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.tsx') || e.name.endsWith('.spec.tsx')) continue
        // ⚠️ 必须**先剥注释再逐行扫**：`kit-fields.tsx` 的文档注释里引用了
        // `PrivacyTrust.tsx:162/187` 与 `.emptyInline`，不剥就是假阳性（第一版就栽了）。
        stripComments(read(p)).split('\n').forEach((ln, i) => {
          if (!/emptyInline|css\.empty(?![A-Za-z0-9_])/.test(ln)) return
          // 只有「加载中」语义的才算违规；空态/未找到是真空态，正当。
          if (!LOADING_RE.test(ln)) return
          if ([...LOADING_EMPTY_ALLOW].some((k) => {
            const [f, frag = ''] = k.split('|')
            return f === e.name && ln.includes(frag)
          })) return
          offenders.push(`${e.name}:${i + 1}  ${ln.trim().slice(0, 60)}`)
        })
      }
    }
    walk(DATA)
    expect(offenders, `这些加载态仍复用空态视觉：\n${offenders.join('\n')}`).toEqual([])
  })

  it('白名单里的每一处都真的存在（防止白名单腐化成永久豁免）', () => {
    for (const key of LOADING_EMPTY_ALLOW) {
      const [file = '', frag = ''] = key.split('|')
      const src = stripComments(read(join(DATA, 'panels', file)))
      expect(src, `白名单 ${key} 的文案已不存在（该豁免应删除）`).toContain(frag)
      const line = src.split('\n').find((l) => l.includes(frag)) ?? ''
      expect(line, `白名单 ${key} 已不再是 loading+empty 形态`).toMatch(/emptyInline|css\.empty/)
    }
  })
})

describe('R4 全仓：长任务必须有真进度', () => {
  /**
   * `ProgressBar` 在 R4 前只有 3 处使用（加密备份 / 导出 / 软件更新），
   * 而**同样长的任务**却只有一行字 —— 隐私体检扫描（`queryPrivacyScan` 实测 1020ms，
   * 冷启更久）是典型。这里钉住「已接进度的这些面板，其后端调用点必须仍在」，
   * 防止有人把进度条删掉退回一行字。
   */
  const MUST_HAVE_PROGRESS: ReadonlyArray<[string, string]> = [
    // 隐私体检扫描：全库敏感信息扫描 >1s，用 indeterminate + 已等待秒数
    ['Privacy.tsx', 'apiGetPrivacyScan'],
  ]

  for (const [file, backendCall] of MUST_HAVE_PROGRESS) {
    it(`${file} 的长任务（${backendCall}）带 ProgressBar 与 useElapsedSeconds`, () => {
      const src = stripComments(read(join(DATA, 'panels', file)))
      expect(src, `${file} 已不再调用 ${backendCall}`).toContain(backendCall)
      // ⚠️ 必须钉**调用点**（`<ProgressBar` / `useElapsedSeconds(`），不能用
      // `toContain('ProgressBar')` —— import 行 `import { …, ProgressBar }` 会命中，
      // 于是删掉使用点也照样绿（R4 变异 M7 实测抓出过这条恒真断言）。
      expect(src, `${file} 的进度条被删了`).toMatch(/<ProgressBar\b/)
      expect(src, `${file} 的已等待计时被删了`).toMatch(/[^A-Za-z0-9_$.]useElapsedSeconds\(/)
    })
  }
})

describe('R4 全仓：列表空态必须有占位（不许塌成 0 高度）', () => {
  /**
   * `.map()` 直接铺在容器里、外面没有 `length === 0` 分支时，数据为空会渲染出一个
   * **空 div** —— 容器塌成 0 高度，标题还在、内容凭空消失，看起来像渲染失败。
   * 这类「空白塌陷」不会被任何类型检查或现有守卫发现（DOM 里确实有个元素，只是没高度）。
   *
   * 这里是**抽样钉点**而非全仓扫描：真正稳定的判定需要渲染层的几何测量（本仓没有组件测试
   * 环境），所以只钉住 R4 明确修过的几处，配 `panel-clip.wiring.spec.ts` 的裁切守卫一起用。
   */
  const EMPTY_GUARDED: ReadonlyArray<[string, string]> = [
    // 省份/城市排行：rows 空时此前是空容器
    ['RegionBoard.tsx', 'regionEmpty'],
  ]

  for (const [file, cls] of EMPTY_GUARDED) {
    it(`${file} 的空列表有占位（.${cls}）`, () => {
      const src = stripComments(read(join(DATA, 'panels', file)))
      expect(src, `${file} 的空态占位被删了`).toContain(cls)
      expect(src, `${file} 缺 rows.length === 0 分支`).toMatch(/rows\.length === 0/)
    })
  }

  it('占位类在本面板 CSS 里有定义（否则空 div 依旧没高度）', () => {
    const reg = stripComments(read(join(DATA, 'panels', 'overview-region.module.css')))
    expect(reg, '.regionEmpty 未定义').toMatch(/(?:^|\n)\.regionEmpty\s*\{/)
  })
})
