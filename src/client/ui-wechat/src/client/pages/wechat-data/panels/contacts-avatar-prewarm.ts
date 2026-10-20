/**
 * 通讯录头像**预热**：列表落地后一次性把前 N 位的头像批量取回来。
 *
 * ## 为什么需要
 *
 * `ContactRowItem` 用 `LazyMount(rootMargin: '400px 0px')` 懒挂载头像组件，而每个
 * `ContactAvatar` 挂载后各自发一次请求 —— 攒批队列（`apiGetAvatarBatched`）能把同一 tick
 * 的合成一次，但**滚动时新进场的行是逐批挂载的**，每批都要等一次 RPC 往返。
 * 用户看到的是「滚到哪儿头像才一个个冒出来」。
 *
 * 预热把「滚到才取」变成「进面板就取」：一次 `getAvatarsLocal`（纯本地、单次 RPC）
 * 拿回前 N 位，写进 `avatarCache` ⇒ 后续 `ContactAvatar` 挂载时**同步命中缓存**，
 * 首帧就有图，不再有「先占位再替换」的闪动。
 *
 * ## 为什么用 `apiGetAvatarsLocal` 而不是 `apiGetAvatarBatched`
 *
 * 后者是「攒批 + 未命中退回单张」，预热场景下未命中的那几条会各自发一次单张 RPC
 * （300 位里若有一半未命中就是 150 次往返）。而预热**不需要**「按昵称找联系人」那一级回落 ——
 * 拿不到就等懒加载那条路补。
 *
 * ## 为什么只写非空结果
 *
 * 空串代表「本机没有、远端也没给」。写进缓存会让懒加载那条路以为「问过了」而不再重试
 * （`avatarCache.has(u)` 为 true）。留空让 `ContactAvatar` 自己走 `apiGetAvatarBatched`。
 *
 * ## 为什么单独一份
 *
 * `ContactsPanel` 在 `function-size-ratchet` 的 250 行线上，而这段的说明比代码本身长得多。
 *
 * @module contacts-avatar-prewarm
 */
import { useEffect } from 'react'
import { apiGetAvatarsLocal } from '../api.ts'
import { cacheBounded } from '../utils/misc.ts'

/**
 * 预热前 N 位联系人的头像。
 * @param contacts - 当前已加载的联系人（按列表顺序；只读 `username`）。
 * @param cache - 头像缓存（`Contacts.tsx` 的模块级 `avatarCache`）。
 * @param max - 缓存上限，同时也是预热条数上限（预热再多也留不住，白跑一次 RPC）。
 * @param enabled - 是否启用（搜索态下不预热：结果集是临时的，预热会挤掉浏览态的头像）。
 */
export function useAvatarPrewarm(
  contacts: readonly { username: string }[],
  cache: Map<string, string | null>,
  max: number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || contacts.length === 0) return
    const todo = contacts
      .slice(0, max)
      .map(c => c.username)
      .filter(u => u !== '' && !cache.has(u))
    if (todo.length === 0) return
    let alive = true
    void apiGetAvatarsLocal({ usernames: todo })
      .then((map) => {
        if (!alive) return
        for (const [u, v] of Object.entries(map)) {
          // 只写非空结果（理由见文件头）。
          if (v !== '') cacheBounded(cache, u, v, max)
        }
      })
      .catch(() => { /* 预热失败不影响功能：懒加载那条路照旧 */ })
    return () => { alive = false }
  }, [contacts, cache, max, enabled])
}
