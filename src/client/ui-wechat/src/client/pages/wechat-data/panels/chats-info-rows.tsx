/**
 * 聊天信息的「官方行语法」两件套（D0，2026-10-13；2026-10-19 去掉 ReadOnlySwitch）：
 * InfoRow / SectionTitle。
 *
 * 微信「聊天信息」的列表行是固定语法：**标签左 12px / 值右 14px / 行高 44–56 / 1px 分隔**；
 * 可导航行值后跟右箭头 ›。本模块把这套语法做成单一事实源，
 * 单聊与群聊两个抽屉共用 —— 两处各写一套必然漂移（审计 P1-8 的行结构就是这么乱的）。
 *
 * 一条语义纪律（docs/CHATS-INFO-WECHAT-ALIGN.html §5.2 / §5.1）：
 * - **箭头只给真能导航的行**（本仓里只有群公告的「展开内联全文」）；只读值带箭头是假可用控件。
 *
 * 原第三件 `ReadOnlySwitch`（只读开关）随区③ 四行一起删除：群聊抽屉里的免打扰 / 置顶 /
 * 存通讯录 / 显成员昵称 2026-10-19 按用户要求移除，而单聊抽屉本来就没有开关行。
 * 「本机只读的死控件」这条纪律本身没错，错的是**在没有消费者的地方还留着一套**：
 * 留着它，下一个人为了「填满抽屉」会把它复活，而那正是用户否决掉的形态。
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
 * @returns 行元素。
 */
export function InfoRow({ label, value, first = false, chevron = false, onChevron }: {
  label: string
  value?: string
  first?: boolean
  chevron?: boolean
  onChevron?: () => void
}): React.JSX.Element {
  const interactive = chevron && onChevron !== undefined
  return (
    <div className={first ? `${cssinfo.infoRow} ${cssinfo.infoRowFirst}` : cssinfo.infoRow}>
      <span className={cssinfo.infoLabel}>{label}</span>
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
