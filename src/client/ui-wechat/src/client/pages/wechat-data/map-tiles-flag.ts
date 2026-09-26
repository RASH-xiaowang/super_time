/**
 * 「禁止地图底图出网」开关在渲染层的**本地镜像**（2026-09-26）。
 *
 * 为什么需要它：底图的唯一拉取点（`panels/world-map-data.ts#fetchFirstJson`）在动手前
 * 要先问一次后端开关，而那是一次 RPC。后端是**同步串行**的 —— 实测用户会话日志里
 * `analyzeVisibleMessages` 单次 54,103ms、`getRemoteImages` 八个各 45,000~51,000ms、
 * `getWordCloud` 2,6xx ms 反复重跑。排在这些后面的 RPC 要等几十秒，于是底图**连
 * 「开始拉」都还没轮到**，世界层就只剩一句静止的「正在解析好友地区…」，看上去像卡死。
 *
 * 镜像把这次判断从「一次排队往返」降成「一次 localStorage 读」（0ms）。
 *
 * 为什么镜像可信：开关的**唯一写入口**是 `apiSetPrivacyState`（保存成功后写镜像），
 * 而任何一次读到后端真值（`apiGetPrivacyState`）也都会刷新它 ⇒ 镜像永远是后端真值的
 * 副本，不会凭空产生。读不到镜像（首次运行 / 存储不可用）时仍走 RPC。
 *
 * 注意方向：本模块只负责**如实转述**，不做任何"猜测默认值" —— 读不到就是 `null`，
 * 由调用方决定兜底方向（那边选的是"读不到就放行"，理由见 `world-map-data.ts`）。
 * @module map-tiles-flag
 */

/** 镜像的 localStorage key（与渲染缓存 `wxdata-render-cache:` 前缀分开，互不干扰）。 */
const KEY = 'wxdata:blockMapTiles'

/**
 * 读本地镜像。
 * @returns `true` 已禁止底图出网 / `false` 未禁止 / `null` 还不知道。
 */
export function readMapTilesFlag(): boolean | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(KEY)
    return raw === '1' ? true : raw === '0' ? false : null
  } catch { return null }
}

/**
 * 记下后端给出的真值。**只在拿到真值后调用**（不要在"读不到"时凭默认值写）。
 * @param blocked - 后端返回的 `blockMapTiles`。
 */
export function writeMapTilesFlag(blocked: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, blocked ? '1' : '0')
  } catch { /* 配额满：退化成"每次问后端"，不影响功能 */ }
}
