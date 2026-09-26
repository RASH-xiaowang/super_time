/**
 * 变异登记表 —— **第三批（#18–#21）**那一段。
 *
 * 为什么又切一个文件：主表 `mutations-registry.mjs` 涨到 1036 行，撞上本仓
 * 「单文件不超过 1000 行」的硬棘轮（`m21-file-size-ratchet.spec.ts`，白名单只许变短）。
 * 主表头部早就写好了处置：表再涨到上限时**按批次切**，由主表聚合，
 * 不靠放宽闸门解决 —— 这里就是照着那条做的。
 *
 * 条目形状、锚点唯一性要求与 `--only` 自证流程见主表头部注释。
 */

/**
 * 第三批的变异清单。
 * @type {ReadonlyArray<{ id: string, why: string, file: string, from: string, to: string, spec: string }>}
 */
export const MUTATIONS_BATCH3 = [
  {
    id: "M118-cycles-scc-never-reports",
    why: "SCC 只在一半以上才认环 —— 恒不 push ⇒ 「环 0 个」永远成立，整张守卫变装饰。咬住它的必须是「临时造一个三方环」那条反例自证",
    file: "src/backend/tests/module-cycle-guard.spec.ts",
    from: "        if (comp.length > 1) out.push(comp.sort())",
    to: "        if (false) out.push(comp.sort())",
    spec: "src/backend/tests/module-cycle-guard.spec.ts",
  },
  {
    id: "M119-cycles-counts-type-only-imports",
    why: "把 `import type` 也当成依赖边：编译期会被擦掉的东西算进运行期图 ⇒ 多报一个假环（chats-thread ↔ Chats），零容忍闸门从此拦不住真事",
    file: "src/backend/tests/module-cycle-guard.spec.ts",
    from: "      if (!typeOnly && !namedTypeOnlyOnly && ts.isStringLiteral(spec)) specs.push(spec.text)",
    to: "      if (ts.isStringLiteral(spec)) specs.push(spec.text)",
    spec: "src/backend/tests/module-cycle-guard.spec.ts",
  },
  {
    id: "M120-cycles-drops-renderer-tree",
    why: "扫描根只剩后端树：渲染层的环悄悄不查（而且看起来仍然全绿）。口径靠「两个文件都不在图里 ⇒ 上面那条是空转」这条断言咬住",
    file: "src/backend/tests/module-cycle-guard.spec.ts",
    from: "  join(ROOT, 'src', 'backend', 'wechat-data', 'src'),\n  join(ROOT, 'src', 'client', 'ui-wechat', 'src'),",
    to: "  join(ROOT, 'src', 'backend', 'wechat-data', 'src'),",
    spec: "src/backend/tests/module-cycle-guard.spec.ts",
  },
  {
    id: "M121-cycles-reintroduce-search-ring",
    why: "在真实回归点上咬：把 `search-scaffold.ts` 里那条**死 import**（第三批 #21 为解环删掉的 `ensureSearchIndex`）加回来，scaffold→build→query→scaffold 就重新成环。守卫必须在真文件上变红，而不是只在合成夹具上",
    file: "src/backend/wechat-data/src/query/search-scaffold.ts",
    from: "import { withDb } from './db-open.ts'",
    to: "import { withDb } from './db-open.ts'\nimport { ensureSearchIndex } from './search-build.ts'",
    spec: "src/backend/tests/module-cycle-guard.spec.ts",
  },
  {
    id: "M122-moments-scope-drops-dateFrom-dep",
    why: "把 `criteria.dateFrom` 从 scopeMoments 那次 useMemo 的依赖里抹掉 —— 这就是改前那个缺陷的形状（函数体读日期、依赖里却没有）。纯函数表全绿，只有 jsdom 真渲染那条与 AST 契约该红",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.ts",
    from: "      criteria.dateFrom, criteria.dateTo, criteria.order],",
    to: "      criteria.dateTo, criteria.order],",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.spec.ts",
  },
  {
    id: "M123-moments-scope-date-upper-bound-exclusive",
    why: "结束日按当天 00:00 算而不是 23:59:59 ⇒ 选「到 9-03」会把 9-03 那天的动态全部丢掉（闭区间变成开区间）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.ts",
    from: "  return date ? Math.floor(new Date(date + 'T23:59:59').getTime() / 1000) : 0",
    to: "  return date ? Math.floor(new Date(date + 'T00:00:01').getTime() / 1000) : 0",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.spec.ts",
  },
  {
    id: "M124-moments-scope-contract-anchor-moves",
    why: "AST 契约里认的钩子从 `useMemo` 改成 `useCallback` ⇒ 再也找不到那次 memo，`deps` 恒 null，「逐字段对齐」退化成比空表（判据自己失明时必须有形状哨兵来报）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.spec.ts",
    from: "node.expression.text === 'useMemo'",
    to: "node.expression.text === 'useCallback'",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.spec.ts",
  },
  {
    id: "M125-moments-scope-monthly-fallback-ignores-author",
    why: "月度分布退回本地统计时不再按选中的作者收窄 ⇒ 柱子和列表说的不是同一件事（后端快照正常时看不出，快照失败那天才露馅）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.ts",
    from: "  const scope = author ? moments.filter((m) => m.author === author) : moments",
    to: "  const scope = moments",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-scope.spec.ts",
  },
  {
    id: "M126-media-drain-stops-after-one-batch",
    why: "把排空队列的 while 改成 if：一批只有 8 个，第 9 个之后的图片永远停在缩略图（滚动越深越明显）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "      while (mediaQueue.current.length > 0) {",
    to: "      if (mediaQueue.current.length > 0) {",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.spec.ts",
  },
  {
    id: "M127-media-ignores-idb-hit",
    why: "命中 IndexedDB 之后仍然去调解密 RPC：进面板本来是为了不打后端，这一改把它打回去",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "            if (cached) { updates[it.key] = cached; return }",
    to: "            if (false && cached) { updates[it.key] = cached; return }",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.spec.ts",
  },
  {
    id: "M128-media-routes-video-cover-to-image-rpc",
    why: "视频封面走错 RPC（kind 判据写死成 img）：请求参数形状不同，取回来的是图片口径的空值",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "            const r = it.kind === 'video'",
    to: "            const r = false",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.spec.ts",
  },
  {
    id: "M129-video-key-drops-md5-precedence",
    why: "视频键不再优先用 md5：卡片挂在 DOM 上的键与这张 spec 表对不上，观察器查不到 spec ⇒ 懒解密整条链静默断掉",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "  return v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')",
    to: "  return v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : (v.md5 ? 'v:' + v.md5 : '')",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.spec.ts",
  },
  {
    id: "M130-cover-retry-cap-raised",
    why: "封面兜底的重试上界从 3 抬到 4：看起来无害，实际是「永久失败的链接一直打网络」那条约定被改掉（次数与 3 都是判据）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "    if (attempt >= 3) continue",
    to: "    if (attempt >= 4) continue",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.spec.ts",
  },
]
