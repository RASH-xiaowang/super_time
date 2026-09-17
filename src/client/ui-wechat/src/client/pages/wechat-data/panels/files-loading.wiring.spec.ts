/**
 * 「文件与存储」加载期口径守卫 + 审计工具的落定口径守卫。
 *
 * 本轮实测（真实 4305 个文件）暴露出两个**互相叠加**的问题：
 *
 *  ① 面板在首屏取数期间把计数写成 0：进入本页后前 3–6 秒头部显示
 *     「共 0 项 · 图片 0 / 视频 0 / 文件 0」，分类标签也是「全部 (0) 图片 (0) …」。
 *     用户看到的是"我的文件不见了"，而不是"还在统计"。后端在同一时刻返回的是
 *     `total=4305 counts={image:3309,file:864,video:132}`（已用 Remote 直调验证）。
 *
 *  ② 审计脚本把这种"首屏空面板"当成了落定：它只看文字长度是否稳定、有没有"加载中"字样，
 *     而「共 0 项」既稳定又没有加载措辞 —— 于是量出"空白带 651px / 占比 88%"，
 *     把一个**加载态**记成了布局缺陷。量错的工具比不量更危险，所以这里一并锁住。
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
const files = readFileSync(join(HERE, 'Files.tsx'), 'utf8')
const audit = readFileSync(join(ROOT, 'scripts', 'panel-audit.mjs'), 'utf8')

describe('文件与存储：加载期不许把计数写成 0', () => {
  it('首屏加载且尚无数据时，页头说的是"正在统计"而不是"共 0 项"', () => {
    expect(files, '页头缺少加载分支').toMatch(/loading && total === 0\s*\?\s*'正在统计本机文件索引…'/)
    // 反例：直接无条件拼接计数（就是本轮修掉的写法）
    expect(files).not.toMatch(/desc=\{`共 \$\{total\} 项/)
  })

  it('分类标签在加载期不显示 (0)', () => {
    expect(files, '分类标签缺少去掉 (0) 的处理').toMatch(/loading && countAll === 0 \? \{ \.\.\.o, label: o\.label\.replace/)
  })

  it('加载中必须有骨架，且骨架的列宽与真实 fileGrid 一致（否则数据到了会"跳一下"）', () => {
    expect(files).toContain('{loading && <ListSkeleton rows={10} grid minCol={200} />}')
    // 真实网格是 minmax(200px)，骨架必须用同一个下限
    const listCss = readFileSync(join(HERE, 'list-panel.module.css'), 'utf8')
    expect(listCss).toMatch(/\.fileGrid\s*\{\s*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(200px/)
    expect(readFileSync(join(HERE, 'hooks.tsx'), 'utf8'), 'ListSkeleton 不支持自定义列宽').toMatch(/ListSkeleton\(\{ rows = 8, grid = false, minCol = 120 \}/)
    // 只有真加载完、且确实没有文件时，才允许出现空状态（且要能自证"为什么是 0"）
    expect(files).toMatch(/!loading && !error && visible\.length === 0 && \(/)
    expect(files).toMatch(/<EmptyMaybeSyncing[\s\S]{0,400}note="文件索引来自本机解密库的 hardlink 记录/)
  })
})

describe('审计工具：不能把加载态当成落定', () => {
  it('落定判定必须同时看：文字稳定 + 无加载措辞 + 无骨架元素 + 最短等待', () => {
    expect(audit, '缺少骨架检测').toMatch(/skel\s*[:=]/)
    // 骨架要真的参与落定判定：骨架在 → 视为仍在加载
    expect(audit, '骨架没有参与落定判定').toMatch(/loading = st\.loading \|\| st\.skel > 0/)
    expect(audit, '落定没有看加载态').toMatch(/settled = st\.len === prevLen && !loading/)
    expect(audit, '缺少最短等待（首屏空面板会骗过纯稳定性判定）').toMatch(/Date\.now\(\) - t0 > minMs/)
    expect(audit, '稳定性要求至少 3 次').toMatch(/stable >= 3/)
  })

  it('每行结果带上面板正文开头，便于人眼复核"这一屏到底是什么状态"', () => {
    expect(audit).toContain('head:')
    expect(audit).toMatch(/「\$\{r\.head\}」/)
  })
})
