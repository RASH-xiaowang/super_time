/**
 * 面板级空态守卫（W3-11.3）：整屏「暂无 X」必须说清「可能是还在同步」。
 *
 * ## 为什么单独立这条
 *
 * 第 62 轮普查拍到过现场：冷启动后台要跑 1–2 分钟同步，`getFiles` / 表情包返回**空快照**，
 * 界面显示「共 0 项 / 暂无文件」—— 数字没错（快照确实是空的），但读起来像数据丢了。
 * `EmptyMaybeSyncing` 就是为这个歧义造的（一句「若这是刚启动，后台可能仍在同步…自动刷新」）。
 *
 * 问题是它只被两个面板用上，而**每个**读解密库的面板都有同一个首启窗口。本条判据把它变成
 * 机械约束：
 *
 *   面板级空态 = `{!loading && !error && …length === 0 && <div className={kitCss.emptyInline}>暂无…}` 这一形状。
 *   命中就必须 import `EmptyMaybeSyncing`（用了别的方式说清同步可能性的也可以，见 EXEMPT）。
 *
 * 口径边界（刻意排除的，别再扩）：
 *   · **区块级**空态（卡片里某个分区为空：「暂无点赞数据」「暂无记录」）不在此列 ——
 *     那种情况下面板已经有数据了，用户不会以为数据丢了，加同步说明反而是噪声；
 *   · 与解密同步无关的面板（知识库：内容是用户自己导入的）不在此列，见 EXEMPT。
 *
 * 变异自证：把任一命中文件的 import 摘掉 → 转红（「EmptyState 那类自带 desc 的也要能过」见下）。
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本 spec 住在 panels/ 下，往上一路找到仓库根（以根 package.json 的 name 为锚，数层级数会错）。 */
function findRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 20; i += 1) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }
        if (j.name === 'super-time-electron') return dir
      } catch { /* 不是那份 package.json，继续往上 */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到仓库根（package.json name=super-time-electron）')
}
const ROOT = findRoot(HERE)
const PANELS = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')

/**
 * 豁免：文件 → 理由。
 *
 * 准则是「这个面板的空态**已经**把『为什么空 + 下一步』说清了」—— 用 `EmptyState`
 * （带 desc/action）或自编文案达标的都算，不强制只能用 `EmptyMaybeSyncing`。
 */
const EXEMPT: Array<{ file: string; why: string }> = [
  {
    // 知识库的内容是用户自己导入的文件/笔记，与解密同步无关；`EmptyMaybeSyncing` 用在这里
    // 会说假话（模块头 2026-09-22 已明确写过这条）。
    file: 'KnowledgeBase.tsx',
    why: '内容来自用户导入，与解密同步无关，同步说明在此为假话',
  },
  {
    // 面板级空态用的是 `EmptyState`（带 desc + 去配置的动作），比同步说明更具体。
    file: 'Favorites.tsx',
    why: '已用 EmptyState 给出 desc与下一步动作',
  },
]

/** 面板级空态的形状：首屏加载完、无错、列表空，且渲染的是裸 emptyInline「暂无…」。 */
const BARE_PANEL_EMPTY = /\{!loading && !error &&[^\n]*length === 0[\s\S]{0,200}?emptyInline[^\n]{0,40}暂无/

function panelFiles(): string[] {
  return readdirSync(PANELS, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name))
    .map((e) => e.name)
    .sort()
}

function code(file: string): string {
  return readFileSync(join(PANELS, file), 'utf8').replace(/\r\n/g, '\n')
}

describe('面板级空态必须说清「可能还在同步」（W3-11.3）', () => {
  const files = panelFiles()

  /**
   * 防空转：用**合成样例**证明正则还咬得动。
   *
   * 为什么不能写成「仓库里至少有一个命中」：这条判据的期望态是**零命中**（该修的都修完了），
   * 那种哨兵会永远红。合成样例是唯一还能证明「正则没写坏」的办法 —— 本仓
   * `panel-feedback-matrix.spec.ts` 的「合成违例必须被抓住」是同一个套路。
   */
  it('防空转：合成坏形状必须命中，好形状必须不命中', () => {
    const bad = '        {!loading && !error && grouped.length === 0 && <div className={kitCss.emptyInline}>暂无联系人</div>}\n'
    expect(BARE_PANEL_EMPTY.test(bad), '合成坏形状没被命中 ⇒ 这条判据是恒真').toBe(true)
    const good = '        {!loading && !error && grouped.length === 0 && <EmptyMaybeSyncing text="暂无联系人" />}\n'
    expect(BARE_PANEL_EMPTY.test(good), '已经接入 EmptyMaybeSyncing 的又被判成违规 ⇒ 判据过严').toBe(false)
    // 区块级空态（卡片内某分区为空）刻意不算违规：那时面板已有数据，加同步说明是噪声
    const section = '            {snap.recent.length === 0 ? (\n              <div className={kitCss.emptyInline}>暂无记录</div>\n'
    expect(BARE_PANEL_EMPTY.test(section), '区块级空态被误判 ⇒ 判据过宽').toBe(false)
  })

  it('命中的面板要么接入 EmptyMaybeSyncing，要么在豁免里带理由', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (!BARE_PANEL_EMPTY.test(code(f))) continue
      if (code(f).includes('EmptyMaybeSyncing')) continue
      const ex = EXEMPT.find((e) => e.file === f)
      if (ex) continue
      offenders.push(f)
    }
    expect(offenders,
      '这些面板的整屏空态还是裸「暂无…」（首启同步期会被读成「数据丢了」）：\n  '
      + offenders.join('\n  ')
      + '\n  要么改用它，要么把理由写进本文件的 EXEMPT。').toEqual([])
  })

  it('豁免必须仍指向真实文件（文件被改名/删掉时这条要红）', () => {
    for (const e of EXEMPT) expect(files, `豁免里写着不存在的面板：${e.file}`).toContain(e.file)
  })
})
