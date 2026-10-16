/**
 * 审计工具的度量口径守卫（把六轮里踩过的坑一次性钉住）。
 *
 * 这个脚本是后续每一轮的依据，而它已经**三次**给出过错误读数，每次都差点被当成界面缺陷去改：
 *   ① 「文件与存储 0 项 / 651px 空白」→ 其实是加载态（首屏取数前 3–6 秒页头真的写"共 0 项"）；
 *   ② 「朋友圈 裁切 ×11 / console ×3」→ 其实是可滚容器与有意截断，以及 CDN 400；
 *   ③ 「表情包/媒体资产/存储分析… 一片 600px 空白、只有一句统计中」→ 其实是**后端队列**
 *      被前面几屏的重查询堵住了。单独重载进同一页 t=0 就有数据。
 *
 * 所以这些口径不是"实现细节"，而是结论可信度的前提，必须锁住。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoot, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const audit = readText(join(ROOT, 'scripts', 'panel-audit.mjs'))

describe('审计工具：落定判定', () => {
  it('必须同时要求：文字稳定 3 次 + 无加载措辞 + 无骨架 + 最短等待', () => {
    expect(audit).toMatch(/stable >= 3/)
    expect(audit).toMatch(/Date\.now\(\) - t0 > minMs/)
    expect(audit, '缺少骨架检测').toMatch(/\.nm-skel/)
  })

  it('**必须先等落定、再量化**（两个循环都要）—— 反过来的话量到的是加载帧', () => {
    // 2026-09-26 实录：原先两处都是「先 MEASURE、再 settle，settle 只当 flag」，
    // 于是「群聊分析」被量成 `624px 空白 / 84% / 60 字` —— 而同一帧的正文里就写着
    // 「统计中…」。等落定之后那 84% 根本不是空白。量具顺序错了，后面所有空白结论都不可信。
    const starts: number[] = []
    let at = audit.indexOf('const queueMs = await waitQueueIdle()')
    while (at >= 0) { starts.push(at); at = audit.indexOf('const queueMs = await waitQueueIdle()', at + 1) }
    expect(starts.length, '找不到「先等队列排空」这一步，口径可能改了写法').toBeGreaterThanOrEqual(2)
    for (const start of starts) {
      const settleAt = audit.indexOf('await settle(', start)
      const measureAt = audit.indexOf('evaluate(MEASURE)', start)
      expect(settleAt, '这一段没有落定判定').toBeGreaterThan(-1)
      expect(measureAt, '这一段没有量化').toBeGreaterThan(-1)
      expect(settleAt, '必须先等落定再量化（否则量到的是加载帧）').toBeLessThan(measureAt)
    }
  })

  it('加载措辞只在内容很少时才算加载态（否则说明文字里的"统计中"会让人空等）', () => {
    // 口径：hasPhrase && (alwaysPhrase || 内容 < 400 字)
    expect(audit).toMatch(/hasPhrase && \(alwaysPhrase \|\| t\.length < 400\)/)
    expect(audit, '缺少加载措辞判定').toMatch(/const hasPhrase = \/正在\|加载中\|统计中/)
    expect(audit, '隐藏页签那一遍需要"一律算加载中"的开关').toMatch(/phraseAlwaysLoading/)
  })
})

describe('审计工具：后端排队必须先排空', () => {
  it('排队探针必须打到 worker —— `listMethods` 是主进程直接答的，后端再堵它也是 1ms', () => {
    expect(audit, '排队探针没有用打 worker 的方法').toContain("call('getSearchIndexStatus'")
    // 反例：拿 listMethods 当探针（第一版就是这么错的）
    expect(audit).not.toMatch(/await window\.electronAPI\.wechat\.listMethods\(\)\s*\n\s*return Math\.round\(performance\.now\(\) - t\)/)
  })

  it('排队超时要在结果里标出来，避免把"队列堵住"读成"面板空白"', () => {
    expect(audit).toMatch(/queueMs/)
    expect(audit, '没有把排队状态显示在行尾').toMatch(/后端排队/)
  })
})

describe('审计工具：裁切与错误分类', () => {
  it('裁切排除可滚容器、line-clamp 与单行省略号', () => {
    expect(audit).toMatch(/cs\.overflowY === 'auto' \|\| cs\.overflowY === 'scroll'/)
    expect(audit).toMatch(/cs\.webkitLineClamp && cs\.webkitLineClamp !== 'none'/)
    expect(audit).toMatch(/cs\.textOverflow === 'ellipsis' && cs\.whiteSpace === 'nowrap'/)
  })

  it('裁切还要排除 `content-visibility: auto`（那是"还没渲染"的占位，不是被裁）', () => {
    // 设置弹窗的 `.card` 带 `content-visibility: auto` + `contain-intrinsic-size: auto 320px`：
    // 视口外的卡片浏览器不渲染，先按 320px 占位 ⇒ 读出 `clientHeight=320 / scrollHeight=880`，
    // 看着像"切掉 560px"。四个弹窗节各报「裁切 ×4」全是它。
    expect(audit, '没有排除 content-visibility: auto').toMatch(/cs\.contentVisibility === 'auto'/)
  })

  it('裁切必须报出**被裁的是谁**（只报数量就只能靠猜，而两类裁切的修法完全不同）', () => {
    expect(audit, '没有记录被裁元素的身份').toMatch(/clipDetail/)
    expect(audit, 'clipDetail 没进结果对象').toMatch(/clipDetail,\s*\n/)
    expect(audit, '结果表没把身份打出来').toMatch(/r\.clipDetail\?\.length/)
    // 身份里至少要能看出标签、类名与尺寸差
    expect(audit).toMatch(/h=\$\{el\.clientHeight\} sh=\$\{el\.scrollHeight\}/)
  })

  it('外部资源失败与 JS 错误分开：console×N 只表示我们代码的错误', () => {
    // 精确到"console 处理器里把资源失败排除掉"这一步，而不是只要求文件里出现过这句话
    expect(audit).toMatch(/m\.type\(\) === 'error' && !\/Failed to load resource\/i\.test\(m\.text\(\)\)/)
    expect(audit).toMatch(/assetFails\.push/)
    expect(audit).toMatch(/外部资源×/)
  })
})

describe('审计工具：隐藏页签也要覆盖', () => {
  it('从 nav-config 读 hidden 条目，并写 hash + 重载驱动（hash 只在挂载时读一次）', () => {
    expect(audit).toContain('nav-config.ts')
    expect(audit).toMatch(/hidden: true/)
    expect(audit).toMatch(/location\.hash = '#' \+ t/)
    expect(audit).toMatch(/win\.reload\(/)
  })

  it('4 个以「设置」弹窗打开的隐藏页签：等"导航按钮 或 弹窗"任一出现，并改量弹窗本身', () => {
    expect(audit, '等待条件没有兼容弹窗').toMatch(/Promise\.race/)
    expect(audit, "MEASURE 没有优先量弹窗").toMatch(/role="dialog"/)
  })

  it('`--fast` 可跳过隐藏那一遍（日常快跑），`--hidden-only` 可只跑隐藏那一遍', () => {
    expect(audit).toContain("'--fast'")
    expect(audit).toContain("'--hidden-only'")
  })
})
