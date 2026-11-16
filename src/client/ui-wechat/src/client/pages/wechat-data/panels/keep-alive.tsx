/**
 * 面板 keep-alive 试点（Alpha PageFrame 的 hidden 挂起，缩到两个高频面板）。
 *
 * 现状：`WechatDataPanel` 只渲染 activePanel，切走后组件卸载 —— 聊天会话的搜索词、
 * 滚动位置、任务信息面板的展开态全部丢失，再切回来要从头取数。
 *
 * 这里只对 `chats` / `taskinfo` 两个面板做试点：
 * - 首访把元素放进 cache；
 * - 始终渲染同一个 wrapper（`display: contents` 表示 active 时不额外生成盒子，
 *   `display: none` 表示 hidden），**wrapper 类型/key 不变**，React 才不会把子树卸载重挂；
 * - 非试点 tab 继续走原来的单元素渲染，不扩大内存/副作用范围。
 *
 * 为什么抽成模块而不是塞进 WechatDataPanel：面板函数已贴着长函数棘轮（473 行），
 * 且 keep-alive 的缓存语义可以脱离 React 用纯函数测。
 */
import React, { createContext, useContext, useRef, useSyncExternalStore } from 'react'
import { getDataIdentitySnapshot, subscribeDataIdentity } from '../cache.ts'
import { tabLabelOf } from '../nav-config.ts'
import { ErrorBoundary } from '../ui/error-boundary.tsx'

/** 试点面板；刻意只放两个，验证收益后再扩。 */
const KEEP_ALIVE_TABS = new Set(['chats', 'taskinfo'])
const PanelActiveContext = createContext(true)

/** 当前面板是否正在显示；独立渲染的面板默认 true。 */
export function useKeepAliveActive(): boolean {
  return useContext(PanelActiveContext)
}

/** 测试与嵌套面板用：显式声明子树当前是否处于显示状态。 */
export function KeepAliveActiveProvider(props: {
  active: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <PanelActiveContext.Provider value={props.active}>
      {props.children}
    </PanelActiveContext.Provider>
  )
}

/** 是否为 keep-alive 试点面板（导出给判据）。 */
export function isKeepAliveTab(tab: string): boolean {
  return KEEP_ALIVE_TABS.has(tab)
}

/** 一次渲染要用的缓存视图。 */
export interface KeepAliveView {
  /** 已挂载过的试点面板，按首次挂载顺序。 */
  panes: Array<[string, React.ReactNode]>
  /** 当前 tab 不是试点时，仍按原逻辑单独渲染它。 */
  standalone: React.ReactNode
}

/**
 * 把当前 activePanel 写进缓存，并返回“已缓存面板 + 当前独立面板”的视图。
 * @param cache - 跨渲染持有的 Map。
 * @param active - 当前 tab。
 * @param activePanel - 当前 tab 的 React 元素。
 * @returns panes / standalone。
 */
export function keepAliveView(
  cache: Map<string, React.ReactNode>,
  active: string,
  activePanel: React.ReactNode,
): KeepAliveView {
  if (isKeepAliveTab(active)) {
    // 每次渲染替换元素没关系：wrapper 的 key/位置不变，React 会复用子树 state。
    cache.set(active, activePanel)
    return { panes: [...cache.entries()], standalone: null }
  }
  return { panes: [...cache.entries()], standalone: activePanel }
}

/** React 侧的缓存钩子；每个 WechatDataPanel 实例一份。 */
export function useKeepAlivePanel(active: string, activePanel: React.ReactNode): React.ReactNode {
  /**
   * 数据目录身份（账号 / db_dir / 密钥）变化 ⇒ 旧的 hidden 面板属于上一个数据源，
   * 必须丢缓存并按新身份重挂。身份稳定时 key 不变，keep-alive 语义原样保留。
   */
  const identity = useSyncExternalStore(subscribeDataIdentity, getDataIdentitySnapshot, getDataIdentitySnapshot)
  const cacheRef = useRef<{ identity: string; cache: Map<string, React.ReactNode> }>({
    identity,
    cache: new Map(),
  })
  if (cacheRef.current.identity !== identity) {
    cacheRef.current = { identity, cache: new Map() }
  }
  const view = keepAliveView(cacheRef.current.cache, active, activePanel)
  return (
    <>
      <KeepAlivePanes panes={view.panes} active={active} identity={identity} />
      {view.standalone === null ? null : (
        <ErrorBoundary key={`standalone:${active}:${identity}`} label={tabLabelOf(active)} resetKey={active}>
          {view.standalone}
        </ErrorBoundary>
      )}
    </>
  )
}

/**
 * 渲染缓存面板：active 用 `display: contents` 让出布局，其余用 `display: none` 挂起。
 * 不用 `hidden` 属性 + inline display 的组合：inline style 的优先级会压过 UA 的
 * `[hidden] { display:none }`，反而让 hidden 失效。
 *
 * 每个 pane 自带 ErrorBoundary：某个面板渲染期抛错只毁它自己，切到别的页签不会黑屏。
 * 边界 key 带数据身份（换账号时重挂 + 清错误态），`resetKey` 是「本 pane 是否正显示」，
 * 从隐藏切回来时自动清掉上一次的错误卡；wrapper 的 `key={tab}` 保持稳定，保活不受影响。
 * @param props.panes - 已缓存面板。
 * @param props.active - 当前 tab。
 * @param props.identity - 数据目录身份（变化时重挂子树）。
 * @returns 面板节点。
 */
export function KeepAlivePanes({ panes, active, identity }: { panes: KeepAliveView['panes'], active: string, identity: string }): React.JSX.Element {
  return (
    <>
      {panes.map(([tab, node]) => (
        <div
          key={tab}
          data-keep-alive={tab}
          aria-hidden={tab === active ? undefined : true}
          style={{ display: tab === active ? 'contents' : 'none' }}
        >
          <KeepAliveActiveProvider active={tab === active}>
            <ErrorBoundary key={`${tab}:${identity}`} label={tabLabelOf(tab)} resetKey={tab === active}>
              {node}
            </ErrorBoundary>
          </KeepAliveActiveProvider>
        </div>
      ))}
    </>
  )
}
