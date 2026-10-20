/**
 * 面板渲染错误的兜底边界（ErrorBoundary）。
 *
 * ## 为什么必须有
 *
 * React 18 在**没有** ErrorBoundary 时，任何渲染期抛错都会让 React **卸载整棵根树** ——
 * 用户看到的是**整片空白/黑屏**，控制台里只有一条 `console.error`，界面上没有任何线索。
 * 设置弹窗尤其危险：它把 13 节面板（配置向导 / AI / 隐私 / 授权 / 更新 / 备份 / 健康 /
 * 自检 / 高级 …）全塞进一个懒加载 chunk，任何一节在渲染期抛错都会把**整个弹窗内容区**
 * 变成空白 —— 而弹窗的标题栏由 Radix Portal 渲染，看起来就是「弹窗还在、内容全黑」。
 *
 * 有了边界之后，出错的那一节会显示一条可读的错误卡（含错误消息与重试按钮），
 * 其余部分照常可用，用户也能把错误消息报给我们。
 *
 * ## 为什么是 class 组件
 *
 * React 至今**只有** class 组件能实现 `componentDidCatch` / `getDerivedStateFromError`，
 * 没有函数式等价物。这是 React 官方文档里唯一还要求 class 的场景。
 *
 * @module ui/error-boundary
 */
import React from 'react'
import css from './error-boundary.module.css'

interface Props {
  /** 出错时显示在哪一节（用于文案，如「设置」）。 */
  label?: string
  children: React.ReactNode
}

interface State {
  error: Error | null
}

/** 渲染错误兜底卡。 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 留一条带组件栈的日志：控制台里那条 React 自己的报错不含组件栈，
    // 排查时最缺的就是「是哪一节炸的」。
    console.error('[error-boundary] 渲染失败:', error, info.componentStack)
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  override render(): React.ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    const label = this.props.label ?? '这一块'
    return (
      <div className={css.card} role="alert">
        <div className={css.title}>{label}渲染失败</div>
        <p className={css.msg}>{error.message || String(error)}</p>
        <p className={css.hint}>
          其余部分仍可使用。若反复出现，请把上面这条消息连同「设置 → 高级 → 导出诊断日志」一起反馈。
        </p>
        <button type="button" className={css.retry} onClick={this.retry}>重试</button>
      </div>
    )
  }
}
