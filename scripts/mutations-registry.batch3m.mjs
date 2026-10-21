/**
 * 变异登记 · 微信数据面 **WAL 实时刷新全覆盖**（2026-10-13，M508 起）。
 *
 * 用户要求「所有使用到微信数据库的地方全部使用 WAL 增量实时推送更新，尽量达到瞬时更新、
 * 无感刷新」。前端消费面的全覆盖由 `wechat-live-refresh.wiring.spec.ts` 钉住（每个数据
 * 面板都必须有一条「推送 → 静默重取」通路）；这一批再钉三处**最容易静默回退**的形状：
 *   · 面板的直订被摘掉 ⇒ 那一个面板退回「打开时取一次」的旧缺陷（其余面板照常，最难发现）；
 *   · 静默重查的失败保护被拿掉 ⇒ 一次抖动就把用户正看着的数据换成缓存兜底 + 错误标注（有感）；
 *   · opts 稳定性修复被退回 ⇒ `useFreshData` 的无限重查循环复活（实测 8 次 flush 后
 *     fetcher 被调 3,166,897 次），Tasks 面板被静默打爆。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3m
 */
export const MUTATIONS_BATCH3M = [
  {
    id: 'M508-annual-live-subscription-dropped',
    why: '年度报告的直订被摘掉 ⇒ 新消息落地后年报停在打开那一刻（它是本轮逐面板排查出的缺口之一，其余面板照常刷新时它静默掉队）。判据：wechat-live-refresh.wiring.spec.ts 的「每个数据面都有通路」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Annual.tsx',
    from: 'useWechatDataUpdated(() => {',
    to: 'useEffect(() => {',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wechat-live-refresh.wiring.spec.ts',
  },
  {
    id: 'M509-fresh-data-silent-failure-guard-dropped',
    why: '静默重查的失败保护被拿掉 ⇒ 一次网络抖动就把用户正看着的最新数据换成缓存兜底 + 「可能不是最新」的错误标注（无感刷新变成有感惊吓）。判据：use-fresh-data.spec.ts 的「liveRefresh 开但静默重查失败 ⇒ 保留旧值、不端出错误」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/use-fresh-data.ts',
    from: 'if ((silent || keepContent) && dataRef.current !== null) return',
    to: 'if (false) return',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/use-fresh-data.spec.ts',
  },
  {
    id: 'M510-fresh-data-opts-instability-returns',
    why: 'opts 稳定性修复被退回（内联 opts 重新进 run 的依赖）⇒ 无限重查循环复活：jsdom 探针实测 8 次 flush 后 fetcher 被调 3,166,897 次，Tasks 面板被静默打爆。判据：use-fresh-data.spec.ts 的「内联 opts 对象不引发重查循环」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/use-fresh-data.ts',
    from: '  }, [key, fetcher])',
    to: '  }, [key, fetcher, optsRef.current])',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/use-fresh-data.spec.ts',
  },
]
