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
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSettledContract, findRoot, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const files = readText(join(HERE, 'Files.tsx'))
const audit = readText(join(ROOT, 'scripts', 'panel-audit.mjs'))

describe('文件与存储：加载期不许把计数写成 0', () => {
  it('首屏加载且尚无数据时，页头说的是"正在统计"而不是"共 0 项"', () => {
    expect(files, '页头缺少加载分支').toMatch(/loading && total === 0\s*\?\s*'正在统计本机文件索引…'/)
    // 反例：直接无条件拼接计数（就是本轮修掉的写法）
    expect(files).not.toMatch(/desc=\{`共 \$\{total\} 项/)
  })

  it('分类标签在加载期不显示 (0)', () => {
    expect(files, '分类标签缺少去掉 (0) 的处理').toMatch(/loading && countAll === 0 \? \{ \.\.\.o, label: o\.label\.replace/)
  })

  it('加载中显示统一加载态（旋转指示 + 加载中…），不再画骨架条，也不把计数写成 0', () => {
    expect(files).toContain('{loading && <ListSkeleton rows={10} grid minCol={200} />}')
    // 2026-10-18：`ListSkeleton` 已统一到 `LoadingState`（旋转指示 + 文案），旧参数仅为兼容保留
    const hooks = readText(join(HERE, 'hooks.tsx'))
    expect(hooks, 'ListSkeleton 没接统一加载态').toMatch(/return <LoadingState variant="compact" label="加载中…" \/>/)
    expect(hooks, 'ListSkeleton 还在渲染骨架条').not.toMatch(/className=\{`nm-skel|className="nm-skel/)
    // 只有真加载完、且确实没有文件时，才允许出现空状态（且要能自证"为什么是 0"）
    expect(files).toMatch(/!loading && !error && visible\.length === 0 && \(/)
    expect(files).toMatch(/<EmptyMaybeSyncing[\s\S]{0,400}note="文件索引来自本机解密库的 hardlink 记录/)
  })
})

describe('审计工具：不能把加载态当成落定', () => {
  it('落定判定必须同时看：文字稳定 + 无加载措辞 + 无骨架元素 + 最短等待', () => {
    // 五条契约收在 wiring-kit 的 assertSettledContract 里（其余面板的加载态守卫共用同一份）。
    assertSettledContract(audit)
  })

  it('每行结果带上面板正文开头，便于人眼复核"这一屏到底是什么状态"', () => {
    expect(audit).toContain('head:')
    expect(audit).toMatch(/「\$\{r\.head\}」/)
  })
})
