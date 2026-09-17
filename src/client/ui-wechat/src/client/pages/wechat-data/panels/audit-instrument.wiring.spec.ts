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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const audit = readFileSync(join(ROOT, 'scripts', 'panel-audit.mjs'), 'utf8')

describe('审计工具：落定判定', () => {
  it('必须同时要求：文字稳定 3 次 + 无加载措辞 + 无骨架 + 最短等待', () => {
    expect(audit).toMatch(/stable >= 3/)
    expect(audit).toMatch(/Date\.now\(\) - t0 > minMs/)
    expect(audit, '缺少骨架检测').toMatch(/\.nm-skel/)
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
