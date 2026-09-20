/**
 * 知识库「当前作用域」在前端的运行时真源：一个跨面板可订阅的小 store。
 *
 * 为什么不是某个组件的 state：库切换器挂在合并外壳（`MergedSections`）的标题栏上，
 * 而面板在它下面 —— 两者不是父子关系，props 传不过去（见
 * `WechatDataPanel` 的 `knowledge | kb` 分支）。
 *
 * 键的**拼法**不在这里，在叶子模块 `../kb-scope-keys.ts`（这里只是转发，见下方
 * import/export 双写的原因）。本文件负责的是「当前是哪个库」这件事本身，以及库列表的取数。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetKbs, readRenderCache, writeRenderCache } from '../api.ts'
import { DEFAULT_KB_ID, KB_LIST_CACHE_KEY } from '../kb-scope-keys.ts'
import { KBS_UPDATED_EVENT } from '../notes-events.ts'
import type { KbListSnapshot, KbMeta } from '../types.ts'

// 键定义在叶子模块，但调用方（面板、图谱布局）**只认这个模块** —— 所以这里既 import
// （本文件内部要用其中两个）又 export from（对外暴露全部键）。与 `api.ts` 转发
// `cache.ts` 是同一个写法；`export * from` 同样可行，但显式列出更利于搜索「谁定义了 kbScope」。
export {
  DEFAULT_KB_ID,
  KB_LIST_CACHE_KEY,
  KB_SCOPE_PREFIX,
  POSITION_SCOPES_MAX,
  SOCIAL_SCOPE,
  kbCacheKey,
  kbIdOfScope,
  kbScope,
} from '../kb-scope-keys.ts'

/**
 * 记住「上次选中的库」的 localStorage 键。
 *
 * 带 `-v1`：这个键将来若要改形状（比如从裸数字改成 JSON），必须有办法区分旧值，
 * 而不是把旧值当新值读出一个荒唐的库 id。
 */
export const ACTIVE_KB_STORAGE_KEY = 'dsh-kb-scope-v1'

/** 读取上次选中的库（非法 / 读不到时退回默认库）。 */
export function readActiveKbId(): number {
  if (typeof window === 'undefined') return DEFAULT_KB_ID
  try {
    const n = Math.trunc(Number(window.localStorage.getItem(ACTIVE_KB_STORAGE_KEY)))
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_KB_ID
  } catch {
    // 隐私模式 / 存储被禁：退回默认库即可，功能不受影响（只是记不住选择）
    return DEFAULT_KB_ID
  }
}

/** 冷启动首帧用的库列表（上次成功取到的那份；没有就是空数组）。 */
function readCachedKbs(): KbMeta[] {
  return readRenderCache<KbListSnapshot>(KB_LIST_CACHE_KEY)?.items ?? []
}

let activeKbId = readActiveKbId()
const listeners = new Set<() => void>()

/** 当前库 id（同步可读：首帧渲染缓存要用）。 */
export function getActiveKbId(): number {
  return activeKbId
}

/**
 * 切换当前库。
 *
 * `kbId` 不合法或与当前相同都直接返回 —— 后者尤其重要：相等也广播的话，
 * 面板会在「切到同一个库」时白跑一次取数，而图谱重建是几百毫秒级的。
 * @param kbId - 目标知识库 id。
 */
export function setActiveKb(kbId: number): void {
  const id = Math.trunc(Number(kbId))
  if (!Number.isFinite(id) || id <= 0 || id === activeKbId) return
  activeKbId = id
  try {
    window.localStorage.setItem(ACTIVE_KB_STORAGE_KEY, String(id))
  } catch {
    /* 写不进去就只在内存里生效：本次会话仍然正确，只是重启后回到默认库 */
  }
  for (const fn of [...listeners]) fn()
}

/**
 * 订阅「当前库已变」。返回退订函数。
 *
 * 用模块内的订阅者集合而不是 `window` 上的 DOM 事件：切换器与面板**必然在同一个模块实例里**
 * （同一份 bundle），所以不需要那道全局命名；少一个事件名，也少一处要防「载荷被塞进去」的地方。
 * 库**表**的变化（新建 / 改名 / 删除）是另一件事，走 `KBS_UPDATED_EVENT`（见下）。
 * @param fn - 变更回调。
 * @returns 退订函数。
 */
export function subscribeActiveKb(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** `useKbScope()` 的返回值。 */
export interface KbScopeState {
  /** 当前库 id。 */
  kbId: number
  /** 库列表（读失败时保留上一次的结果，见 `readError`）。 */
  kbs: KbMeta[]
  /** 库列表读失败的原因；确无问题时为 null。 */
  readError: string | null
  /** 首次列表是否仍在路上。 */
  loading: boolean
  /** 切换当前库。 */
  setKb: (kbId: number) => void
  /** 强制重新拉取库列表（界面上「重试」用）。 */
  reloadKbs: () => void
}

/**
 * 订阅当前知识库与库列表。
 *
 * 读失败时**保留**上一次的列表而不是清空：空列表会被界面读成「一个库都没有」，
 * 于是提示用户去新建 —— 而真正的问题是库打不开（N1 同一条纪律）。
 * 首次就失败时列表为空，由 `readError` 单独表达，界面据此给出「重试」而不是「新建」。
 *
 * 当前库已不在列表里（被删了）时**退回一个存在的库**：不做这一步的话，后续每次取数
 * 都带一个不存在的 kbId，界面会停在「知识库不存在」而用户不知道要点哪里。
 * @returns 当前作用域状态与操作函数。
 */
export function useKbScope(): KbScopeState {
  const [kbId, setKbId] = useState(getActiveKbId)
  // 首帧先拿上次成功渲染过的列表：否则切换器要先空一拍再显示库名。
  // 读失败时**不写**这份缓存（下一段），所以它里面不会存下「读不到」这个状态。
  const [kbs, setKbs] = useState<KbMeta[]>(readCachedKbs)
  const [readError, setReadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // 切库是跨面板的（切换器在合并外壳里，面板在它下面），所以靠订阅而不是 props。
  useEffect(() => subscribeActiveKb(() => setKbId(getActiveKbId())), [])

  // 建 / 改名 / 删库之后库表变了：重拉列表（失效与广播由 api.ts 统一做）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKbsUpdated = (): void => setNonce(n => n + 1)
    window.addEventListener(KBS_UPDATED_EVENT, onKbsUpdated)
    return () => window.removeEventListener(KBS_UPDATED_EVENT, onKbsUpdated)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      const r = await apiGetKbs()
      if (!alive) return
      setLoading(false)
      if (r.readError) {
        // 保留旧列表，只把「读失败」这件事说出来
        setReadError(r.readError)
        return
      }
      setReadError(null)
      setKbs(r.items)
      writeRenderCache(KB_LIST_CACHE_KEY, { items: r.items, total: r.total })
      if (r.items.length > 0 && !r.items.some(k => k.id === getActiveKbId())) {
        setActiveKb(r.items.some(k => k.id === DEFAULT_KB_ID) ? DEFAULT_KB_ID : (r.items[0] as KbMeta).id)
      }
    })()
    return () => { alive = false }
  }, [nonce])

  const reloadKbs = useCallback(() => setNonce(n => n + 1), [])

  return { kbId, kbs, readError, loading, setKb: setActiveKb, reloadKbs }
}
