/**
 * 数据面板的按需加载入口。
 *
 * `WechatDataPanel` 只需要外壳与导航，具体页签不应在首屏把 127 个面板模块全部拉进来。
 * 这里把会随 `renderTab` 出现的面板统一包成 React.lazy；`WechatDataPanel` 外层已经用
 * Suspense 包住 `activePanel`，所以切页签时只加载目标页签自己的 chunk。
 */

import { lazy, Suspense, type ComponentProps } from 'react'

export const OverviewPanel = lazy(() => import('./panels/Overview.tsx').then(({ OverviewPanel }) => ({ default: OverviewPanel })))
export const PrivacyPanel = lazy(() => import('./panels/Privacy.tsx').then(({ PrivacyPanel }) => ({ default: PrivacyPanel })))
export const OperationLogPanel = lazy(() => import('./panels/OperationLogPanel.tsx').then(({ OperationLogPanel }) => ({ default: OperationLogPanel })))
export const ClawBotPanel = lazy(() => import('./panels/ClawBotPanel.tsx').then(({ ClawBotPanel }) => ({ default: ClawBotPanel })))
export const AskPanel = lazy(() => import('./panels/Ask.tsx').then(({ AskPanel }) => ({ default: AskPanel })))
export const ChatsPanel = lazy(() => import('./panels/Chats.tsx').then(({ ChatsPanel }) => ({ default: ChatsPanel })))
export const ContactsPanel = lazy(() => import('./panels/Contacts.tsx').then(({ ContactsPanel }) => ({ default: ContactsPanel })))
export const MomentsPanel = lazy(() => import('./panels/MomentsOptimized.tsx').then(({ MomentsPanel }) => ({ default: MomentsPanel })))
export const FavoritesPanel = lazy(() => import('./panels/Favorites.tsx').then(({ FavoritesPanel }) => ({ default: FavoritesPanel })))
export const EmoticonsPanel = lazy(() => import('./panels/Emoticons.tsx').then(({ EmoticonsPanel }) => ({ default: EmoticonsPanel })))
export const FilesPanel = lazy(() => import('./panels/Files.tsx').then(({ FilesPanel }) => ({ default: FilesPanel })))
export const RecordsPanel = lazy(() => import('./panels/Records.tsx').then(({ RecordsPanel }) => ({ default: RecordsPanel })))
export const LedgerPanel = lazy(() => import('./panels/Ledger.tsx').then(({ LedgerPanel }) => ({ default: LedgerPanel })))
export const TasksPanel = lazy(() => import('./panels/Tasks.tsx').then(({ TasksPanel }) => ({ default: TasksPanel })))
export const GroupInsightsPanel = lazy(() => import('./panels/GroupInsights.tsx').then(({ GroupInsightsPanel }) => ({ default: GroupInsightsPanel })))
export const MomentsInsightsPanel = lazy(() => import('./panels/MomentsInsights.tsx').then(({ MomentsInsightsPanel }) => ({ default: MomentsInsightsPanel })))
export const AssetInsightsPanel = lazy(() => import('./panels/AssetInsights.tsx').then(({ AssetInsightsPanel }) => ({ default: AssetInsightsPanel })))
export const OfficialAssetsPanel = lazy(() => import('./panels/OfficialAssets.tsx').then(({ OfficialAssetsPanel }) => ({ default: OfficialAssetsPanel })))
export const MediaAssetsPanel = lazy(() => import('./panels/MediaAssets.tsx').then(({ MediaAssetsPanel }) => ({ default: MediaAssetsPanel })))
export const StoragePanel = lazy(() => import('./panels/Storage.tsx').then(({ StoragePanel }) => ({ default: StoragePanel })))
export const CallsPanel = lazy(() => import('./panels/Calls.tsx').then(({ CallsPanel }) => ({ default: CallsPanel })))
export const RevokedPanel = lazy(() => import('./panels/Revoked.tsx').then(({ RevokedPanel }) => ({ default: RevokedPanel })))
export const MonitorPanel = lazy(() => import('./panels/Monitor.tsx').then(({ MonitorPanel }) => ({ default: MonitorPanel })))
export const AnnualPanel = lazy(() => import('./panels/Annual.tsx').then(({ AnnualPanel }) => ({ default: AnnualPanel })))
export const DailySummaryPanel = lazy(() => import('./panels/DailySummary.tsx').then(({ DailySummaryPanel }) => ({ default: DailySummaryPanel })))
export const PeriodSummaryPanel = lazy(() => import('./panels/PeriodSummary.tsx').then(({ PeriodSummaryPanel }) => ({ default: PeriodSummaryPanel })))
export const GraphPanel = lazy(() => import('./panels/Graph.tsx').then(({ GraphPanel }) => ({ default: GraphPanel })))
export const SettingsPanel = lazy(() => import('./panels/Settings.tsx').then(({ SettingsPanel }) => ({ default: SettingsPanel })))
export const KbShell = lazy(() => import('./panels/KbShell.tsx').then(({ KbShell }) => ({ default: KbShell })))

/**
 * 设置弹窗不在 `activePanel` 的 Suspense 范围里，这里给它的懒加载补一个独立边界。
 * 把边界收在 loader 模块里，主容器不需要为了懒加载多包一层 JSX。
 */
export function SettingsPanelGate(props: ComponentProps<typeof SettingsPanel>): React.JSX.Element {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>正在加载设置…</div>}>
      <SettingsPanel {...props} />
    </Suspense>
  )
}
