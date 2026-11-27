/**
 * R7 收口守卫：页头口径（U12）、落地/空态口径（U14）、年度报告的自适应回退。
 *
 * 三条都来自本轮实测：
 *  ① `朋友圈` 是**唯一**没有 `desc` 的面板 —— 页头三件套（标题 / 一句"这页是什么" / 操作）
 *     在别处都成立，只此一处漏了，界面上一眼看不出"少了什么"；
 *  ② `撤回消息`（574px）与 `周期报告`（515px）的空态只有一两行字，下面整片空白，
 *     而且都没说"下一步做什么"；
 *  ③ 年度报告的回退条件 `@media (max-height:779px)` 看的是**视口**高度（本机 900），
 *     真正被压缩的是**面板**高度（约 700）→ 海报模式照常启用，9 张卡片各把
 *     20–30% 文字切掉。改成按"卡片是否真被切"判定，并复用同一套瀑布流规则。
 * @vitest-environment node
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const read = (f: string): string => readText(join(HERE, f))
const annualCss = read('annual.module.css')
const annualTsx = read('Annual.tsx')

describe('U12 · 页头不铺功能说明', () => {
  it('页头可以没有 desc，说明性长句不再写在标题下面', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.tsx'))
    atLeast(files.length, 25, 'panels 下的 tsx 文件数')
    const narration = [
      '一屏纵览',
      '只检索本机，回答带来源',
      '只分析通讯录好友',
      '本机聊天记录的年度回顾',
      '命中关键词后记录触发',
      '从最近 7 天聊天提取',
      '本地笔记：新建',
      '定时总结任务 + 总结阅览',
      '按时间范围总结聊天',
      '基于微信 general.db',
      '来自消息资源库的只读统计',
      '数据边界 · AI 出网说明',
      'Super Time 统一授权',
      '任务首次触发、局域网',
      '按日期区间汇总聊天要点',
      '图片 / 文件 / 视频规模',
      '仅记录操作元数据',
      '解密库/索引/插件存储',
      '本地快照（目录拷贝',
      '本地检测 · 数据库密钥',
      'gh_* 账号消息',
      '本地解码 · 无注入',
      '扫描手机号 / 身份证',
      '语音/视频通话统计（来自消息库',
    ]
    const hits: string[] = []
    const visibleOf = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const file of files) {
      const src = visibleOf(read(file))
      for (const phrase of narration) {
        if (src.includes(phrase)) hits.push(`${file}: ${phrase}`)
      }
    }
    expect(hits, `这些说明还留在界面上：\n${hits.join('\n')}`).toEqual([])
  })
})

describe('U3 · 骨架与真实栅格同形（列宽下限必须逐字对齐）', () => {
  /**
   * 骨架的列宽下限与真实网格不一致时，数据到了会"跳一下"：
   * 骨架按 120px 排 10 列、真实是 minmax(200px) 排 6 列。这一条用一张表把两处绑起来 ——
   * 加新面板时照着加一行即可，不用再各写一条断言。
   */
  const PAIRS: ReadonlyArray<{ panel: string, tsx: string, css: string, cls: string, minCol: number }> = [
    { panel: '文件与存储', tsx: 'Files.tsx', css: 'list-panel.module.css', cls: 'fileGrid', minCol: 200 },
    { panel: '通讯录', tsx: 'Contacts.tsx', css: 'contacts.module.css', cls: 'list', minCol: 240 },
  ]

  for (const { panel, tsx, css, cls, minCol } of PAIRS) {
    it(`${panel}：骨架用网格模式，且 minCol 等于 .${cls} 的 minmax 下限`, () => {
      expect(read(tsx), `${panel} 的骨架还在用单列行模式`).toContain(`<ListSkeleton rows={`)
      expect(read(tsx), '骨架没有开网格模式').toMatch(new RegExp(`<ListSkeleton rows=\\{\\d+\\} grid minCol=\\{${minCol}\\} />`))
      expect(read(css), `.${cls} 的列宽下限改了就要同步会话骨架的 minCol`).toMatch(new RegExp(`\\.${cls}\\s*\\{[^}]*minmax\\(${minCol}px`))
    })
  }

  it('收藏与表情**不该**跟着改成网格（它的真实布局就是单列卡片）', () => {
    // 写下来免得后人"顺手统一"：`.favCard` 是 `display: flex` 的单列卡片行，
    // 在 `.scroll` 里竖着排。给它套网格骨架反而是错的。
    expect(read('list-panel.module.css'), '.favCard 是单列卡片行').toMatch(/\.favCard\s*\{[^}]*display:\s*flex/)
    expect(read('Favorites.tsx'), '收藏的骨架应保持行模式').toMatch(/<ListSkeleton rows=\{8\} \/>/)
  })
})

describe('U14 · 空态只留标题和动作', () => {
  it('撤回消息：标题和刷新，不再铺三种原因', () => {
    const src = read('Revoked.tsx')
    expect(src).toContain('暂无撤回消息记录')
    expect(src).toContain('刷新重读')
    expect(src).not.toContain('本机确实没人撤回过')
    expect(src).not.toContain('归档没赶上')
  })

  it('总结工作台：未生成时只留标题和生成按钮', () => {
    const parts = read('SummaryParts.tsx')
    expect(parts).toContain('还没有这一段的总结')
    expect(parts).not.toContain('emptySteps')
    expect(parts).toMatch(/onOpenSettings\?\.\('ai'\)/)
  })

  it('这两处的设置跳转都要真的接上（renderTab 里传进去）', () => {
    const shell = readText(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx'))
    expect(shell).toContain('<RevokedPanel onOpenSettings={onOpenSettings} />')
    // 2026-10-17：周期总结并入 `SummaryWorkbench`，跳转出口跟着搬过去。
    expect(shell).toContain('<SummaryWorkbench onOpenSettings={onOpenSettings} />')
  })

  it('群聊公告和表情包空态不再写成长说明', () => {
    expect(read('GroupInsights.tsx')).toContain('暂无群公告')
    expect(read('GroupInsights.tsx')).not.toContain('六分之一')
    expect(read('GroupInsights.tsx')).not.toContain('入群之前')
    expect(read('Emoticons.tsx')).toContain('暂无表情包')
    expect(read('Emoticons.tsx')).not.toContain('表情商店」的本地缓存')
  })
})

describe('年度报告 · 版面容器（2026-09-30 合并下段；2026-11-19 换成自由画布）', () => {
  it('海报的 12 列固定网格与"被切检测"都已移除', () => {
    expect(annualTsx, '旧的 12 列海报网格又回来了').not.toContain('css.wrap')
    expect(annualTsx, '被切检测（compact）又回来了').not.toContain('data-compact')
  })

  /**
   * 2026-11-19 用户要求「改为画布形式、不限制网格、卡片随内容自适应、支持拖拽」。
   * 首屏因此从 `<MasonryGrid>` 换成 `<CardCanvas>` —— 这条判据跟着换对象，
   * 守的东西没变：**整页必须有且只有一个主版面容器**（不许一半画布一半网格）。
   */
  it('首屏用自由画布，而不是密排网格', () => {
    expect(annualTsx, '首屏没有用画布').toContain('<CardCanvas')
    expect(annualTsx, '首屏不该再包在 MasonryGrid 里').not.toMatch(/<MasonryGrid>\s*<HeroCard/)
  })

  it('样式层面确认画布与折叠区网格都在位', () => {
    // 2026-11-19：画布类迁到 `card-canvas.module.css`（M21 行数棘轮），两处都要查。
    const canvasCss = read('card-canvas.module.css')
    expect(canvasCss, '画布容器样式必须在').toContain('.canvas {')
    expect(canvasCss, '卡片定位样式必须在').toContain('.canvasCard {')
    // 折叠区仍是 12 列网格（默认收起，不改）。
    expect(annualCss, '折叠区的看板网格样式必须在').toContain('.board {')
    expect(annualCss, '滚动容器必须常开').toMatch(/\.scrollBody \{[^}]*overflow-y: auto/)
  })
})
