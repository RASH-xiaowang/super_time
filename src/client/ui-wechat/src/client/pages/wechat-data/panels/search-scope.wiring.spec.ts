/**
 * 搜索范围（前端接线）：关键词必须交给服务端，而不是「拉一批回来本地过滤」。
 *
 * 这些是**源码级**守卫（不渲染 UI），钉住审计出的四类回归点：
 *   ① 文件 / 操作日志 / 收藏 / 撤回 四个面板不再「搜索时一次性拉 N 条」，
 *      而是把 `q` 传进分页请求（`limit: 500` 那套写法必须消失）；
 *   ② 文件面板不能再出现 `(fileName || md5)` 这种短路写法（md5 会永远不参与比较）；
 *   ③ 表情包的 `packages` 必须参与过滤（此前渲染直接用 `packages.slice()`）；
 *   ④ 全局搜索的命中要把关键词带进目标面板（此前只 `setActive`）。
 *
 * 为什么要源码级：这些面板的数据依赖真实本机数据，SSR 冒烟跑不到「输入关键词」这一步；
 * 而它们一旦退回本地过滤，界面上**没有任何提示**，只有真跑真实数据才看得见。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const PANELS = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')
const WDP = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx')

const read = (p: string): string => readFileSync(p, 'utf8')
const panel = (name: string): string => read(join(PANELS, name))

describe('搜索框：关键词交给服务端（不再「拉一批再本地过滤」）', () => {
  const cases: Array<{ file: string; api: string }> = [
    { file: 'Files.tsx', api: 'apiGetFiles' },
    { file: 'Favorites.tsx', api: 'apiGetFavorites' },
  ]

  /** 撤回面板特殊：它保留了一个 500 条分支，但只服务于「类型筛选」。 */
  it('Revoked.tsx：搜索走服务端分页，500 条只留给类型筛选', () => {
    const src = panel('Revoked.tsx')
    // ① 分页请求带上关键词
    expect(src).toMatch(/apiGetRevoked\(\{ limit, offset, \.\.\.kwOpt \}\)/)
    // ② 「拉 500 条」只出现在 typeFilter 分支里（类型后端没有参数，只能本端筛；
    //    类型是有限枚举，不是自由文本，所以这个上限不会像关键字那样静默漏结果）
    expect(src).toMatch(/if \(typeFilter\) \{[\s\S]*?apiGetRevoked\(\{ limit: 500, \.\.\.kwOpt \}\)/)
    // ③ 搜索不再触发「一次性拉 500 条」（旧的 `searching || typeFilter` 必须消失）
    expect(src).not.toMatch(/searching \|\| typeFilter/)
    // ④ 本地关键字过滤必须消失
    expect(src).not.toMatch(/it\.sender \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/)
    expect(src).toMatch(/useDebouncedValue\(/)
  })

  for (const c of cases) {
    it(`${c.file}：分页请求带上 q，且不再出现「搜索时拉 500 条」`, () => {
      const src = panel(c.file)
      // ① fetchPage / 取数处必须带 q
      // 文件 / 收藏写成 q: kw；撤回抽成了 ...kwOpt —— 两种写法都要认
      expect(src).toMatch(new RegExp(c.api + '\\(\\{[^}]*(q: kw|\\.\\.\\.kwOpt)'))
      // ② 本地关键字过滤必须消失（否则又是「只搜已加载那一页」）
      expect(src).not.toMatch(/limit: 500/)
      // ③ 防抖：不能每敲一个字就打一次请求
      expect(src).toMatch(/useDebouncedValue\(/)
    })
  }

  it('OperationLogPanel：buildQuery 带上 q，且不再本地过滤 rows', () => {
    const src = panel('OperationLogPanel.tsx')
    expect(src).toMatch(/q\.q = opKw/)
    expect(src).toMatch(/const rows = opRows\s*$|const rows = opRows\b/)
    expect(src).not.toMatch(/limit: 500/)
    expect(src).not.toMatch(/opRows\.filter\(/)
  })

  it('Files：搜索不再用 `(fileName || md5)` 短路（md5 会被永久跳过）', () => {
    const src = panel('Files.tsx')
    // 注意：显示名回退里仍有 `f.fileName || f.md5`（无文件名时展示 md5），那是合理的；
    // 被禁掉的是**搜索过滤**里那个 —— 它让 md5 永远不参与比较。
    expect(src).not.toMatch(/\.filter\(f => \(f\.fileName \|\| f\.md5\)/)
    expect(src).toMatch(/const searched = files/)
  })
})

describe('表情：表情包也参与搜索', () => {
  const src = panel('Emoticons.tsx')

  it('packages 走过滤后的集合，不再直接 slice 全量', () => {
    expect(src).toMatch(/filteredPackages/)
    expect(src).toMatch(/filteredPackages\.slice\(0, pkgCount\)/)
    expect(src).not.toMatch(/packages\.slice\(0, pkgCount\)/)
  })

  it('过滤条件是表情包名称', () => {
    expect(src).toMatch(/p\.name\.toLowerCase\(\)\.includes\(q\)/)
  })

  it('搜不到时给出空态，而不是一片空白', () => {
    expect(src).toMatch(/filteredPackages\.length === 0/)
  })
})

describe('全局搜索：命中跳转带关键词', () => {
  const src = read(WDP)

  it('四个面板都收到 seedQuery', () => {
    // 注意：这些 JSX 的行里带 `=>`，`[^>]*` 跨不过去 —— 所以按行判断而不是整段正则。
    const lines = src.split('\n')
    for (const name of ['FilesPanel', 'FavoritesPanel', 'RecordsPanel', 'ContactsPanel']) {
      const hit = lines.filter(l => l.includes('<' + name) && l.includes('seedQuery='))
      expect(hit.length, name + ' 没有收到 seedQuery').toBeGreaterThan(0)
    }
  })

  it('命中点击走 seedTo（而不是只切页签的 setActive）', () => {
    for (const tab of ['contacts', 'favorites', 'files', 'records']) {
      expect(src, `${tab} 的命中点击没有带关键词`).toMatch(new RegExp("seedTo\\('" + tab + "', gsQuery\\)"))
    }
    // 「只切页签」的老写法必须消失（会话/消息/朋友圈仍走各自的定位，不算）
    expect(src).not.toMatch(/setSearchOpen\(false\); setActive\('files'\)/)
  })

  it('seed 带 nonce：同一个词连点两次也能重新种入', () => {
    expect(src).toMatch(/setSeed\(\{ tab, q, nonce: Date\.now\(\) \}\)/)
    for (const name of ['Files.tsx', 'Favorites.tsx', 'Records.tsx', 'Contacts.tsx']) {
      expect(panel(name), `${name} 没有按 nonce 重新种入`).toMatch(/\[seedQuery\?\.nonce\]/)
    }
  })
})
