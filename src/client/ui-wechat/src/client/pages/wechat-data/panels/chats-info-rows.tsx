/**
 * 聊天信息的「官方行语法」三件套（D0，2026-10-13）：InfoRow / SectionTitle / ReadOnlySwitch。
 *
 * 微信「聊天信息」的列表行是固定语法：**标签左 12px / 值右 14px / 行高 44–56 / 1px 分隔**；
 * 可导航行值后跟右箭头 ›，开关行右侧是 switch。本模块把这套语法做成单一事实源，
 * 单聊与群聊两个抽屉共用 —— 两处各写一套必然漂移（审计 P1-8 的行结构就是这么乱的）。
 *
 * 两条语义纪律（docs/CHATS-INFO-WECHAT-ALIGN.html §5.2 / §5.1）：
 * - **箭头只给真能导航的行**（本仓里只有群公告的「展开内联全文」）；只读值带箭头是假可用控件；
 * - **开关是只读的**：本应用只读本机聊天库，改免打扰/置顶要写回微信协议或对方数据库，都不该做。
 *   故 ReadOnlySwitch 刻意不可交互（L13 死控件纪律）：span + role="switch" + aria-disabled +
 *   title 说明，不是 input、不挂 onChange、无 hover 反馈。
 *
 * @module panels/chats-info-rows
 */
import cssinfo from './chats-info.module.css'

/**
 * 「标签左 / 值右」资料行。
 * @param props.label - 左标签（12px 弱化）。
 * @param props.value - 右值（14px 正文色）；长值自行换行。
 * @param props.first - 本行是区块首行（不画上分隔线）。
 * @param props.chevron - 右箭头：**只许**在真能导航/展开时传（见文件头纪律）。
 * @param props.onChevron - 箭头/整行的展开动作（仅 chevron 为真时有意义）。
 * @param props.switchOn - 传了就在右端画只读开关（与 value 互斥）。
 * @returns 行元素。
 */
export function InfoRow({ label, value, first = false, chevron = false, onChevron, switchOn }: {
  label: string
  value?: string
  first?: boolean
  chevron?: boolean
  onChevron?: () => void
  switchOn?: boolean
}): React.JSX.Element {
  const interactive = chevron && onChevron !== undefined
  return (
    <div className={first ? `${cssinfo.infoRow} ${cssinfo.infoRowFirst}` : cssinfo.infoRow}>
      <span className={cssinfo.infoLabel}>{label}</span>
      {switchOn !== undefined
        ? <ReadOnlySwitch on={switchOn} label={label} />
        : (
          <span className={cssinfo.infoValueWrap}>
            {value !== undefined && <span className={cssinfo.infoValue}>{value}</span>}
            {chevron && (
              interactive
                ? (
                  <button type="button" className={cssinfo.infoChevronBtn} onClick={onChevron} aria-label={`展开${label}`}>
                    <span className={cssinfo.infoChevron} aria-hidden="true">›</span>
                  </button>
                  )
                : <span className={cssinfo.infoChevron} aria-hidden="true">›</span>
            )}
          </span>
          )}
    </div>
  )
}

/**
 * 分组小标题（「本机统计」这类工作台自有数据的区头）：12px 弱化，与官方行语法区分语义。
 * @param props.children - 标题文案。
 * @returns 标题元素。
 */
export function SectionTitle({ children }: { children: string }): React.JSX.Element {
  return <div className={cssinfo.infoSection}>{children}</div>
}

/**
 * 只读开关（L13 死控件纪律）：视觉是官方 switch，交互刻意关闭。
 * @param props.on - 状态（来自微信本地库的镜像）。
 * @param props.label - 所属行标签（拼进 aria-label 与 title）。
 * @returns 开关元素（span，非 input）。
 */
export function ReadOnlySwitch({ on, label }: { on: boolean, label: string }): React.JSX.Element {
  return (
    <span
      className={cssinfo.infoSwitch}
      data-on={on ? 'true' : undefined}
      role="switch"
      aria-checked={on}
      aria-disabled="true"
      aria-label={`${label}（本机只读）`}
      title="本机只读：状态取自微信本地库，本应用不写回"
    >
      <span className={cssinfo.infoSwitchKnob} aria-hidden="true" />
    </span>
  )
}
