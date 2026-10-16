/**
 * 渲染层 console → 诊断日志的**接线守卫**（2026-10-08 补）。
 *
 * ## 守的是什么
 *
 * `installRendererConsoleCapture` 本身的行为由 `diag-log.spec.ts` 断言（23 条）。
 * 这里守的是**接线** —— 因为这一层曾经整条链都不存在，而且极易退化：
 *
 *   · 函数写好了但没人调用（**死代码**）—— 本轮动手前就得先核实
 *     `installWebContentsGuards` 是不是真被调用，才发现它经由
 *     `ipc-misc.js` 的 `web-contents-created` 对每个 webContents 生效；
 *   · 只在主窗口生效、弹窗/次级窗口丢日志；
 *   · 默认档位悄悄放宽成全收，把 2 MB × 3 份的轮转冲掉，真正要查的那几行被挤掉 ——
 *     那等于用「有日志」换掉了「日志有用」。
 *
 * 「读源码文本做断言」是本仓源码级守卫的常规手段（见 `debug-gates.spec.ts` 的说明）：
 * 与「import 值断言」是两回事，后者会造成跨层耦合。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')
const miscSrc = readFileSync(join(ROOT, 'src', 'backend', 'ipc-misc.js'), 'utf8')
const diagSrc = readFileSync(join(ROOT, 'src', 'backend', 'diag-log.js'), 'utf8')

/**
 * 剥掉注释。
 *
 * 为什么需要：接线断言要盯的是**代码里真的调了**，而文档里复述这件事
 * （「修复前渲染层一行都进不了 app.log」）不该被算成接线。混在一起查就只能在
 * 「守卫失效」与「文档不敢写」之间二选一。
 */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('渲染层 console 转发：接线不许断', () => {
  it('main.js 真的 import 了转发函数与档位读取器', () => {
    // 注意匹配的是**整条声明**：`const { … } = require('…')` 的解构列表在括号**外面**，
    // 只匹配 `require(...)` 会永远看不到那三个名字（第一版就是这么写错的）。
    const decl = /const\s*\{[^}]*\}\s*=\s*require\(\s*'[^']*diag-log'\s*\)/.exec(code(mainSrc))
    expect(decl, '找不到对 diag-log 的解构 require').not.toBeNull()
    expect(decl![0]).toContain('installRendererConsoleCapture')
    expect(decl![0]).toContain('rendererConsoleLevels')
  })

  it('installWebContentsGuards 里**真的调用了**它（死代码是这一层最容易踩的坑）', () => {
    const m = /function installWebContentsGuards\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(code(mainSrc))
    expect(m, '找不到 installWebContentsGuards 的函数体').not.toBeNull()
    expect(m![1], '守卫函数体里没有调用转发 ⇒ 这条链是死的').toContain('installRendererConsoleCapture(')
    // 档位必须来自 reader，不能写死 —— 否则环境变量那条路就是装饰
    expect(m![1]).toContain('rendererConsoleLevels()')
  })

  it('钩子对**每个** webContents 生效（不是只挂主窗口）', () => {
    // 这条链是 `app.on('web-contents-created') → installWebContentsGuards`。
    // 少一环，弹窗与次级窗口的日志就会静默丢失，而主窗口看着一切正常。
    expect(code(miscSrc)).toMatch(/app\.on\(\s*'web-contents-created'/)
    expect(code(miscSrc)).toMatch(/web-contents-created[\s\S]{0,120}installWebContentsGuards\(contents\)/)
    // main.js 必须把这个钩子交给 ipc-misc（对象**简写**形式，不是 `key: value`）
    expect(code(mainSrc)).toMatch(/installWebContentsGuards\s*,/)
  })

  it('转发函数与档位读取器都从 diag-log 导出（漏 export 就成了 require 到 undefined）', () => {
    const exp = /module\.exports\s*=\s*\{([\s\S]*?)\n\}/.exec(code(diagSrc))
    expect(exp, '找不到 module.exports').not.toBeNull()
    expect(exp![1]).toContain('installRendererConsoleCapture')
    expect(exp![1]).toContain('rendererConsoleLevels')
    expect(exp![1]).toContain('RENDERER_LEVELS')
  })

  it('默认档位是 warn + error，不许悄悄变宽', () => {
    expect(code(diagSrc)).toMatch(/DEFAULT_RENDERER_LEVELS\s*=\s*\['warn',\s*'error'\]/)
    // 环境变量的名字在实现与文档里必须一致，否则用户设了没效果也不知道
    expect(code(diagSrc)).toMatch(/SUPERTIME_RENDERER_LOG_LEVELS/)
    // 默认值必须**拷贝一份**返回：调用方改掉返回数组不该影响后续调用
    expect(code(diagSrc)).toMatch(/DEFAULT_RENDERER_LEVELS\.slice\(\)/)
  })

  it('Electron 四档级别都映射了，且未知档位有兜底（转发是旁路，不能把渲染层带崩）', () => {
    expect(code(diagSrc)).toMatch(/RENDERER_LEVELS\s*=\s*\{\s*0:\s*'verbose',\s*1:\s*'info',\s*2:\s*'warn',\s*3:\s*'error'\s*\}/)
    expect(code(diagSrc)).toMatch(/\?\?\s*'info'/)
  })

  it('日志级别用 renderer 收口，便于与后端的 [backend!] 区分', () => {
    // 混在一起就分不清一行是主进程还是渲染层写的 —— 那正是这次排查缺的东西
    expect(code(diagSrc)).toMatch(/log\.write\(\s*'renderer'/)
  })
})