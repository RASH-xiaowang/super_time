/**
 * 知识库「作用域键」的纯定义层（叶子模块：**不 import 任何本项目模块**）。
 *
 * 为什么要从 `panels/kb-scope.ts` 里拆出这几个函数/常量：
 * 作用域键有两个使用者 —— 面板侧的 `kb-scope.ts`（订阅当前库）与
 * `api.ts`（快照缓存键 `kb:graph:<id>`）。若键的定义留在 `kb-scope.ts`，
 * `api.ts` 就得 import 一个面板模块，而 `kb-scope.ts` 又要 import `api.ts`
 * 拿 `apiGetKbs` —— 两个模块互引成环，且方向是「核心 → 面板」。
 * 拆出这层叶子后依赖是单向的：`api.ts` → 本文件，`kb-scope.ts` → 本文件 + `api.ts`。
 *
 * 于是「一个库 = 一批笔记 + 一个链接解析域 + 一张图 + 一份布局」这件事里，
 * **键的拼法只有这一处**，别处不许自己拼（`'kb:' + id` / `kb${id}` / `'kb-' + id`
 * 各自为政，就会出现「模型里有节点、图上没有」那种只在切库后才现形的偏差）。
 *
 * 这些字面量由 `knowledge-base.wiring.spec.ts` 的源码级 gate 钉住：
 * 名字以 `kb-scope` 开头的模块是唯一允许出现它们的地方。
 */

/**
 * 默认知识库 id。**与后端 `query/notes.ts` 的 `DEFAULT_KB_ID` 必须同值。**
 *
 * 前端也要一份的原因：刷新页面时库列表还没回来，首个渲染帧必须已经知道该去读哪个库
 * （否则渲染缓存会先按「没有作用域」渲染一次，用户会看到上一个库的列表）。
 * 两处同值的约束由 `knowledge-base.wiring.spec.ts` 用文本比对钉住。
 */
export const DEFAULT_KB_ID = 1

/** 社交图谱的作用域名。它**不是**知识库，但共用同一份坐标存储。 */
export const SOCIAL_SCOPE = 'social'

/** 知识库作用域前缀。 */
export const KB_SCOPE_PREFIX = 'kb:'

/**
 * 坐标存储里最多保留几个作用域。
 *
 * 为什么要有上限：`localStorage` 里存的是 `Record<scope, Record<nodeId, {x,y}>>`，
 * 每个库一份坐标。库可以有几十个，而用户真正在布局的通常只有最近几个 ——
 * 不设上限的话，一个长年累积的账号会把布局对象撑到几百 KB，
 * 而它**每次拖拽都要整体序列化写回**。淘汰按「最近一次写入」。
 */
export const POSITION_SCOPES_MAX = 8

/** 知识库作用域名（`kb:1`）。布局与缓存都用它当 key，**不要自己拼**。 */
export function kbScope(kbId: number): string {
  return KB_SCOPE_PREFIX + String(kbId)
}

/** 作用域名 → 库 id（不是知识库作用域时返回 null）。 */
export function kbIdOfScope(scope: string): number | null {
  if (!scope.startsWith(KB_SCOPE_PREFIX)) return null
  const n = Math.trunc(Number(scope.slice(KB_SCOPE_PREFIX.length)))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 渲染缓存 / 快照缓存的 key。**一律带库 id。**
 *
 * 不带会出现「切库后先渲染上一个库的列表」：首帧是同步读缓存渲染的，
 * 而数据要等一次 RPC 才到 —— 那一段空窗里，用户看到的是**别的库**的笔记。
 * @param base - key 前缀（如 `kb-list`、`kb:graph`）。
 * @param kbId - 知识库 id。
 * @returns 带库 id 的缓存键。
 */
export function kbCacheKey(base: string, kbId: number): string {
  return base + ':' + String(kbId)
}

/**
 * 库登记表自己的缓存键。**唯一一处定义**：`api.ts` 的快照层（`apiGetKbs`）与
 * `kb-scope.ts` 的渲染层（冷启动首帧）都读这个名字 —— 同一个数据在两层的同一个键。
 *
 * 刻意**不叫 `kb-list`**：`kb-` 那一族是「某个库的**内容**」（笔记列表 / 图谱），
 * 库登记表是另一类东西 —— 笔记内容变了不该动它，库表变了才动它。
 * 两条失效路径因此不会互相误伤（见 `api.ts` 的 `invalidateKbCaches`）。
 * `kbCacheKey` 不适用于它：它不属于任何库，没有 id 后缀。
 */
export const KB_LIST_CACHE_KEY = 'kbs-list'
