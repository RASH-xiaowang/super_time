// @vitest-environment node
/**
 * 搜索索引构建的进度与取消**接线**（W3-11.5 铺到第二个入口）。
 *
 * 后端行为由 `search-index-build-hooks.spec.ts` 钉（分片口径、回滚、不留半份）。
 * 本文件钉另一半：那一半全对、界面却什么都看不到 —— `ui-entry` 不中继、hook 不带 jobId、
 * 按钮还是那个禁用的「构建中…」—— 三者任意一处被改回去都不会有编译错误、也不会有用例失败。
 * 事件名钉**两处取出来比对**而不是各写一遍常量：写两遍的话，改名只改一边会假绿。
 *
 * 与 `laya-analysis-progress.wiring.spec.ts` 是同款两件，但**槽位必须不同**：
 * 搜索（`_searchJobs`）与构建（`_searchIndexJobs`）会同时在跑，共用一格的话
 * 「停止构建」会把用户正在等的搜索打断。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')
const entry = read(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'ui-entry.tsx')
/**
 * 事件映射表（2026-10-14 从 ui-entry 的内联 if-else 抽出）：手机浏览器的 SSE 那条路
 * 也要用同一份映射，两边各写一份必然漂（症状是「桌面进度条会动、手机不会」）。
 * 所以原来查 ui-entry 的判据改成查**表 + ui-entry 的接线**。
 */
const events = read(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'wechat-events.ts')
const hook = read(HERE, 'chats-msg-search.tsx')
const view = read(HERE, 'chats-view.tsx')
/** 两条远端链路：构建本体与取消口。 */
const remotes = read(HERE, '..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'remotes', 'graphsearch.ts')
const core = read(HERE, '..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'gateway-core.ts')
const build = read(HERE, '..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'query', 'search-build.ts')

const BACKEND_EVENT = 'search-index/progress'

/** 从映射表里取这条后端事件对应的 DOM 事件名。 */
function domNameFor(backendEvent: string): string {
  const re = new RegExp(`\\{\\s*from:\\s*'${backendEvent.replace('/', '\\/')}',\\s*to:\\s*'([^']+)'`)
  return re.exec(events)?.[1] ?? ''
}

describe('搜索索引构建：进度与取消的接线', () => {
  it('ui-entry 把后端事件原名中继成 DOM 事件', () => {
    expect(domNameFor(BACKEND_EVENT), `映射表里不再中继 ${BACKEND_EVENT}`).not.toBe('')
    expect(domNameFor(BACKEND_EVENT), '后端事件名与中继出去的 DOM 事件名对不上').toMatch(/^dsh-search-index-/)
    expect(entry, 'ui-entry 没有把共用的映射表接到 IPC 事件上（表就成了死数据）')
      .toContain('onEvent(dispatchWechatEvent)')
  })

  it('hook 监听的正是中继出去的那个名字，且卸载时摘掉监听', () => {
    const entryDom = domNameFor(BACKEND_EVENT)
    expect(entryDom, '取不到中继出去的 DOM 事件名').not.toBe('')
    expect(hook).toContain(`addEventListener('${entryDom}'`)
    expect(hook, '卸载时不摘监听 ⇒ 面板反复开合会累积监听器').toContain(`removeEventListener('${entryDom}'`)
  })

  it('进度按 jobId 认领（迟到的事件不许把上一次构建的进度画回来）', () => {
    expect(hook).toMatch(/d\.jobId !== indexJobRef\.current/)
  })

  it('批次序号是 ref 而不是局部变量（局部变量每渲染重置 ⇒ 所有构建都是同一个 jobId）', () => {
    expect(hook, '批次序号必须是 useRef').toMatch(/indexJobSeqRef = useRef\(0\)/)
    expect(hook).toContain('++indexJobSeqRef.current')
    expect(hook, '局部 let 计数器会让每次构建的 jobId 相同').not.toMatch(/\n\s*let indexJobSeq\b/)
  })

  it('请求带上 jobId，且 finally 归还槽位（否则下一次「停止」会打到已结束的那次）', () => {
    expect(hook).toMatch(/apiBuildSearchIndex\(\{ force: false, jobId \}\)/)
    expect(hook, '槽位没在 finally 里清').toMatch(/if \(indexJobRef\.current === jobId\) indexJobRef\.current = ''/)
    expect(remotes, '后端 finally 里必须归还槽位').toMatch(/\} finally \{\s*ctl\?\.done\(\)/)
  })

  it('后端只在带了 jobId 时才推送（没带就静默建完，别把事件打成洪水）', () => {
    const at = remotes.indexOf('const jobId =')
    expect(at, 'graphsearch 远端里找不到 jobId 提取').toBeGreaterThan(-1)
    const block = remotes.slice(at, at + 700)
    expect(block, '空 jobId 时不该建回调').toMatch(/jobId === ''\s*\?\s*undefined/)
    expect(block).toContain(`'${BACKEND_EVENT}'`)
    expect(block, '事件载荷必须带 jobId，否则 hook 那侧的认领永远不成立')
      .toMatch(/emit\('search-index\/progress',\s*\{\s*jobId/)
  })

  it('取消与搜索各占各的槽（共用一格 ⇒「停止构建」会打断正在跑的搜索）', () => {
    expect(core).toMatch(/protected readonly _searchIndexJobs = new Map<string, AbortController>\(\)/)
    expect(core, '构建的取消槽不该复用 _searchJobs').not.toMatch(/_searchJobs\.set\(id, ctrl\)[\s\S]{0,80}searchIndex/)
    expect(remotes).toContain('rc.searchIndexSignal(jobId)')
    expect(remotes).toContain('rc.cancelSearchIndexJob(id)')
  })

  it('取消检查同时在「进事务前」和「分片内的让出点」（只有边界的话十万行的分片停不下来）', () => {
    expect(build, '进事务前没有查取消 ⇒ 已取消的构建会先 DROP 掉旧索引再回滚').toMatch(/throwIfCanceled\(\)\r?\n\s*let shardsDone/)
    // 让出点那次：进度上报与取消检查挨着（渲染层就是靠这个回调发取消的）。
    expect(build, '分片内的让出点没有查取消').toMatch(/reportProgress\(shardsDone, shardCount, inserted\)\s*\r?\n\s*\/\/[^\n]*\r?\n(?:\s*\/\/[^\n]*\r?\n)*\s*throwIfCanceled\(\)/)
  })

  it('取消 ⇒ ROLLBACK + status cancelled（不抛错，也不留半份索引）', () => {
    expect(build).toMatch(/db\.exec\('ROLLBACK'\)[\s\S]{0,200}code === INDEX_BUILD_CANCELED[\s\S]{0,200}status: 'cancelled'/)
  })

  it('进度里的行数是「已写入」而不是收尾时的 COUNT（后者整段构建恒为 0）', () => {
    expect(build).toMatch(/let inserted = 0/)
    expect(build).toMatch(/inserted \+= 1/)
    // 分片内那次不许用 `total`。
    const inShard = build.match(/reportProgress\(shardsDone, shardCount, ([a-zA-Z]+)\)/g) ?? []
    expect(inShard.length, '没有找到分片级进度上报').toBeGreaterThan(0)
    for (const call of inShard) expect(call, '分片级进度必须用 inserted（用 total 会全程显示 0）').toContain('inserted')
  })

  it('界面上有分片进度与「停止」按钮（不再是那个禁用态的「构建中…」）', () => {
    expect(view).toMatch(/正在构建\{indexProgress && indexProgress\.total > 0/)
    expect(view, '进度读数里要能看到分片位置与已入库行数')
      .toMatch(/\$\{indexProgress\.done\}\/\$\{indexProgress\.total\} 个分片 · 已入库 \$\{indexProgress\.rows\} 条/)
    expect(view).toMatch(/onClick=\{\(\) => \{ void onCancelIndexBuild\?\.\(\) \}\}>停止</)
    // 进度与取消口都是**袋外独立 prop**（不进 state 袋）：平铺字段棘轮只许变小。
    expect(view).toMatch(/indexProgress\?: \{ done: number; total: number; rows: number \} \| null/)
    expect(view).toMatch(/onCancelIndexBuild\?: \(\) => void \| Promise<void>/)
    expect(view, '构建中时不该还挂着那个 disabled 的构建按钮（用户会以为只能等）')
      .not.toMatch(/onClick=\{\(\) => \{ void buildIndex\(\) \}\} disabled=\{indexBuilding\}/)
  })
})