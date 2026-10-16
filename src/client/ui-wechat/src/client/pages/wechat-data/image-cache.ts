/**
 * 消息图片的**内存缓存**（按字节计的 LRU）。
 *
 * ## 为什么需要它
 * 图片消息是虚拟化列表里的一行：滚出视口 → 组件卸载 → 组件内的 `src` 状态一起消失；
 * 滚回来 → 重新挂载 → 重新走一次 RPC（后端虽然会命中 `<decoded>/` 磁盘缓存，但仍有
 * 一次进程间往返 + 读盘 + base64 编码）。用户看到的就是「每次滚回来都先闪一下加载占位」。
 * 有了这层缓存，**第二次起首帧就是图片本身**，不闪任何占位。
 *
 * ## 为什么按字节而不是按条数
 * 一条 data URL 的体量差三个数量级：缩略图几十 KB，而原图 base64 后可能好几 MB。
 * 按条数计（比如「存 200 条」）在遇到一批原图时会吃掉几百 MB 内存。
 * 所以：记**总字节**（`MAX_BYTES`）并从头淘汰；单条过大（`MAX_ENTRY_BYTES`）直接不缓存
 * —— 一张原图不该把一整屏缩略图挤出去。
 *
 * ## 只缓存成功结果
 * 失败的条目（`error` / 空 url）不进缓存：那是「这一次没取到」，下次重挂载应当再试一次。
 *
 * 纯逻辑、不 import react、不碰 remote —— 与 `image-batch.ts` 同一姿态，便于直接单测。
 */
export interface CachedImage {
  /** 可直接给 `<img src>` 用的地址（data URL）。 */
  url: string
  /** true = 这份是缩略/中图（界面据此说明「点取原图试试」）。 */
  thumb: boolean
}

/** 缓存总量上限：48 MB —— 一屏缩略图约 3–5 MB，够来回滚十几屏。 */
export const MAX_BYTES = 48 * 1024 * 1024
/**
 * W3-10.1：**条数**上陔。
 *
 * 为什么只有字节上陔不够：原图 base64 常在 1–8MB，48MB 只够 6–48 张。
 * 往回切几个会话/页签之后，一屏缩略图就会被原图挤干净，表现为“切回去全是空方块”。
 * 512 条对一屏缓存充分（一屏窗口就几十张），又不会让内存无界增长。
 */
export const MAX_ENTRIES = 512
/** 单条上限：8 MB —— 超过就不缓存（原图 base64 常在 1–8 MB，超大图不该挤掉整屏缩略图）。 */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

/** `username:localId` —— 会话与消息双重定位，换会话不会串味。 */
export function imageCacheKey(username: string, localId: number): string {
  return `${username}:${String(localId)}`
}

/**
 * 造一个图片缓存。
 * @param options.maxBytes - 总量上限（默认 {@link MAX_BYTES}）；**可注入**，单测才能用小容量验证淘汰。
 * @param options.maxEntryBytes - 单条上限（默认 {@link MAX_ENTRY_BYTES}）。
 * @returns 带 LRU 语义的缓存对象；`get` 命中会刷新其「最近使用」位置。
 */
export function createImageCache(options?: { maxBytes?: number; maxEntryBytes?: number; maxEntries?: number }): {
  get: (username: string, localId: number) => CachedImage | undefined
  set: (username: string, localId: number, value: CachedImage) => void
  /** W3-10.1：枚举当前所有键（键带 `username:` 前缀，便于按会话筛选释放）。 */
  keys: () => string[]
  /** W3-10.1：按整键摞弃一条（低于 `set` 的入口，供切页签释放用）。 */
  drop: (key: string) => void
  clear: () => void
  stats: () => { count: number; bytes: number }
} {
  const maxBytes = options?.maxBytes ?? MAX_BYTES
  const maxEntryBytes = options?.maxEntryBytes ?? MAX_ENTRY_BYTES
  const maxEntries = options?.maxEntries ?? MAX_ENTRIES
  /**
   * JS 的 Map 保持插入序：删了再插即「移到队尾」，队首就是最久未用。
   * 这样 LRU 不需要额外双向链表（本项目每次访问最多一条，够用）。
   */
  const store = new Map<string, { value: CachedImage; bytes: number }>()
  let bytes = 0

  const drop = (key: string): void => {
    const hit = store.get(key)
    if (hit === undefined) return
    store.delete(key)
    bytes -= hit.bytes
  }

  return {
    /** 枚举当前所有键（“切页签释放”要用：键带会话维度，可按前缀判断）。 */
    keys() {
      return [...store.keys()]
    },

    /** 按键摞弃一条（关联字节一并减掉）。 */
    drop(key) {
      drop(key)
    },

    get(username, localId) {
      const key = imageCacheKey(username, localId)
      const hit = store.get(key)
      if (hit === undefined) return undefined
      // 命中即「最近使用」：删了重插到队尾
      store.delete(key)
      store.set(key, hit)
      return hit.value
    },

    set(username, localId, value) {
      if (value.url === '') return
      // 以字符串长度近似字节：data URL 是 ASCII，1 字符 ≈ 1 字节（略保守，可接受）
      const size = value.url.length
      if (size > maxEntryBytes) return
      const key = imageCacheKey(username, localId)
      drop(key)
      store.set(key, { value, bytes: size })
      bytes += size
      // W3-10.1：两个上陔共用同一个 LRU 队列（Map 插入序）———
      // 超哪个都从队首开始过漏，不需要新数据结构。
      while ((bytes > maxBytes || store.size > maxEntries) && store.size > 0) {
        const oldest = store.keys().next()
        if (oldest.done === true) break
        drop(String(oldest.value))
      }
    },

    clear() {
      store.clear()
      bytes = 0
    },

    stats() {
      return { count: store.size, bytes }
    },
  }
}

/** 全应用共用一份（面板可能同时打开多个会话视图，共享缓存才不白取）。 */
export const imageCache = createImageCache()

/** 便捷读：命中返回**已缓存的那条**，未命中 `undefined`。 */
export function recallImage(username: string, localId: number): CachedImage | undefined {
  return imageCache.get(username, localId)
}

/** 便捷写：`ok` 为假的条目（失败/空 url）不会进缓存。 */
export function rememberImage(username: string, localId: number, value: CachedImage): void {
  imageCache.set(username, localId, value)
}

/**
 * 丢掉**全部**内存缓存条目（清空后所有图都会重新取一次）。
 *
 * 给「后端把磁盘缓存换成了更好的一份」的动作使用 —— 目前是设置页的「升级为原图」。
 * 不这么做的话：用户升级完切回会话，`MessageImage` 的首帧仍然从内存缓存里拿到**旧的那张缩略图**
 * （这层缓存是全应用共用的，跨面板切换不会失效），于是「升级成功」在界面上表现为「什么都没发生」。
 * 代价是之后一屏图会重新走一次取图（后端命中的是升级后的磁盘缓存），所以只在**真的换了图**时调。

/**
 * W3-10.1：切跳时只留下**目标会话**的图片槽，其余全部释放。
 *
 * 为什么需要：这层缓存全应用共用、**越面板不失效**（注释见 forgetAllImages）。
 * 对视频是好事，但 48MB 意味着：来回切几个会话后，上一个会话的槽
 * 还占着地方，新会话的第一屏反而要重新取。按会话释放就是把
 * “看不见的不占地方”落地。
 *
 * 只传 `username`：缓存键本身带会话维度（imageCacheKey），而“切跳时该留哪个”
 * 只能由知道当前选中项的那一层决定。空串 = 全部释放（切到不看图的页签）。
 * @param username - 要保留的会话 username。
 * @returns 真的释放了多少条。
 */
export function keepOnlyImages(username: string): number {
  const keep = username === '' ? null : username + ':'
  let dropped = 0
  for (const key of imageCache.keys()) {
    if (keep !== null && key.startsWith(keep)) continue
    imageCache.drop(key)
    dropped += 1
  }
  return dropped
}
export function forgetAllImages(): void {
  imageCache.clear()
}
