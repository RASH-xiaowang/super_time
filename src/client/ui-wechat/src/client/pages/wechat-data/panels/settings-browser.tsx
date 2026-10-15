/**
 * 「设置」在手机上的那一版（M9）。
 *
 * ## 为什么整面板换掉，而不是逐节套降级卡
 *
 * 设置里的 13 节只有「数据边界与出网」在手机上能用：其余各节要做的都是**这台电脑**上的事
 * （读微信安装目录、从运行内存取密钥、写含 API Key 的 `llm.json`、开入站监听、建本机快照、
 * 打开本机 db 做完整性检查、下载并替换本机安装、验绑机许可证）。逐节套卡会得到一屏
 * 内容几乎相同的「仅桌面端」，而桌面端那份的**状态钩子**（`useSettingsState`）仍会在挂载时
 * 打 19 个远程直接被拒的接口 —— 手机上看到的就是转圈加一串红字。
 *
 * 所以这里只渲染两件东西：能用的那一节原样保留，剩下的收成一张清单卡（每节一行「为什么」）。
 * 不挂载 `useSettingsState` ⇒ 被屏蔽方法的调用次数是**零**，这是手机侧可观测性的硬口径。
 *
 * @module panels/settings-browser
 */
import { PanelHeader } from '../ui/kit.tsx'
import { IconSettingsOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { PrivacyTrustPanel } from './PrivacyTrust.tsx'
import { DESKTOP_ONLY_KEYS, desktopOnlyListCard } from '../ui/desktop-only.tsx'
import { css } from './settings-css.ts'

/** 与桌面版同一套 props（弹窗是否自带标题栏、落到哪一节、跳出弹窗的回调）；手机端只有第一件有意义。 */
interface SettingsBrowserPanelProps {
  inDialog?: boolean
  initialSection?: string
  onNavigateOut?: (tab: string) => void
}

/**
 * 渲染手机端的设置视图。
 * @param p - 见 {@link SettingsBrowserPanelProps}。
 * @returns JSX。
 */
export function SettingsBrowserPanel({ inDialog = false }: SettingsBrowserPanelProps = {}): React.JSX.Element {
  return (
    <div className={css.root} data-in-dialog={inDialog || undefined} data-settings-scope="browser">
      {!inDialog && (
        <PanelHeader
          title={(
            <>
              <IconSettingsOutline14 size={16} />
              设置
            </>
          )}
          desc="手机这一侧能看的只有数据边界；其余各节要在电脑上完成"
        />
      )}
      {/* 数据边界与出网是**只读**的出网清单 + 审计，走的是白名单里的接口，手机上照常能看。 */}
      <div className={css.embedPane} data-settings-section="boundary"><PrivacyTrustPanel embedded /></div>
      {desktopOnlyListCard(DESKTOP_ONLY_KEYS)}
    </div>
  )
}
