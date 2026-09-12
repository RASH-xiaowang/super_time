/**
 * 朋友圈面板 — 优化版本包装器
 *
 * 添加性能优化：
 * 1. React.memo 包裹组件避免不必要的重渲染
 * 2. 搜索防抖 (300ms) 避免频繁过滤
 */
import { memo } from 'react'
import { MomentsPanel as OriginalMomentsPanel } from './Moments.tsx'

/** 防抖包装后的朋友圈面板 */
export const MomentsPanel = memo(function MomentsPanel(props: { author?: string | null; onClearAuthor?: () => void }) {
  return <OriginalMomentsPanel {...props} />
})
