/**
 * Navigation configuration for the WeChat data panel shell: group order,
 * per-item label/icon, and the closed tab union. Keeping this in its own
 * module lets the panel import the config and lets tests assert the IA
 * without rendering the full shell.
 *
 * Hidden items stay routable (deep links / cross-panel navigation) but are not
 * shown in the sidebar; the visible parent item exposes them via in-panel
 * filters (e.g. 聊天会话 → 公众号/服务号/客服).
 *
 * ── 图标口径 ──────────────────────────────────────────────────────────────
 * 侧栏**可见**条目的图标按微信官方客户端的字形重画，逐条对照官方截图，而不是按
 * 「统一重量」自行发明。绝大多数是**填充式**字形、圆角形体、24×24 视框、留 2px 内边距：
 *   聊天气泡（横向胶囊 + 左下尾巴）、朋友圈光圈（中心圆 + 八段带缺口花瓣）、
 *   通讯录（人像 + 右侧条目行）、钱包、文件夹、电话听筒、齿轮、盾牌。
 * **收藏是官方本身就是线稿**（等距立方轮廓），因此它是唯一一条不吃 filled() 包裹、
 * 直接用外层 svg 描边的条目 —— 拿填充实心块去「统一」它就等于不一致。
 *
 * 实现要点：填充条目自带 `<g fill="currentColor" stroke="none">`，覆盖外层 svg 继承来的
 * `fill:none / stroke:currentColor`（见 WechatDataPanel）。带孔的形状用
 * `fill-rule="evenodd"`：外轮廓与内轮廓写在同一条 path 里即可挖空（气泡内火花、
 * 盾牌+对勾、圆环+指针、钱包按钮、书脊与正文行都靠这个）。
 * 朋友圈光圈的八段花瓣由几何生成（内半径 5.0 / 外半径 9.7 / 每段 32° / 缺口 13°），
 * 手改半径会让 16 组弧端点错位。
 *
 * 标记为 hidden 的条目**不会被渲染**（它们只保留路由 id，图标目前没有绘制点），
 * 因此仍留在旧的描边字形上，未一并重画。
 */
export type WechatTab =
  | 'overview' | 'ask' | 'chats' | 'graph' | 'knowledge' | 'monitor' | 'contacts' | 'moments'
  | 'favorites' | 'emoticons' | 'files' | 'records' | 'ledger' | 'storage' | 'bizchats'
  | 'servicechats' | 'kefu' | 'annual' | 'period' | 'dailysummary' | 'hook' | 'privacy'
  | 'revoked' | 'backup' | 'settings' | 'oplog' | 'tasks' | 'groupinsights' | 'health' | 'momentsinsights' | 'privacytrust' | 'assetinsights' | 'officialassets' | 'mediaassets' | 'calls'

export interface NavItem {
  tab: WechatTab
  label: string
  icon: string
  /** Routable but not rendered in the sidebar; exposed by a parent item. */
  hidden?: boolean
}

/** 给填充字形统一套一层：覆盖外层 svg 的 fill:none / stroke:currentColor。 */
const filled = (inner: string): string => `<g fill="currentColor" stroke="none">${inner}</g>`

export const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
  {
    label: '概览与问答',
    items: [
      // 数据总览：三根递增的圆角柱 —— 填充重量与微信官方字形一致
      { tab: 'overview', label: '数据总览', icon: filled('<path d="M5.2 13.2h3.4a1.4 1.4 0 0 1 1.4 1.4v5.2a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4v-5.2a1.4 1.4 0 0 1 1.4-1.4zM10.3 8.4h3.4a1.4 1.4 0 0 1 1.4 1.4v10a1.4 1.4 0 0 1-1.4 1.4h-3.4a1.4 1.4 0 0 1-1.4-1.4v-10a1.4 1.4 0 0 1 1.4-1.4zM15.4 3.6h3.4a1.4 1.4 0 0 1 1.4 1.4v14.8a1.4 1.4 0 0 1-1.4 1.4h-3.4a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4z"/>') },
      // 微信问答：微信官方聊天气泡 + 气泡内挖空的四角火花。
      // 火花用四条向心凹的二次曲线收腰：三次曲线版本在 17px 下会读成「气泡+加号」，
      // 而那在微信里是「发起/添加」的语义。尖端 (12,6.4)/(15.8,10.2)/(12,14)/(8.2,10.2)。
      { tab: 'ask', label: '微信问答', icon: filled('<path fill-rule="evenodd" d="M8.9 4.4h6.2a6.4 6.4 0 0 1 6.4 6.4 6.4 6.4 0 0 1-6.4 6.4H8.9a6.4 6.4 0 0 1 0-12.8zM12 6.4Q13 9.2 15.8 10.2Q13 11.2 12 14Q11 11.2 8.2 10.2Q11 9.2 12 6.4z"/><path d="M7.4 15.4c-.3 2.6-1.9 4.5-4.6 5.6 2.7-.4 4.4-1.6 5.4-3.6.3-.7.5-1.4.5-2z"/>') },
    ],
  },
  {
    label: '报告与总结',
    items: [
      { tab: 'annual', label: '年度报告', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>', hidden: true },
      // 总结：一页带三行正文的笔记（挖空的行即「文本」）
      { tab: 'dailysummary', label: '总结', icon: filled('<path fill-rule="evenodd" d="M6.6 3.2A2.2 2.2 0 0 1 8.8 1h6.4a2.2 2.2 0 0 1 2.2 2.2v17.6a2.2 2.2 0 0 1-2.2 2.2H8.8a2.2 2.2 0 0 1-2.2-2.2zM9.2 7.2h5.6v2H9.2zM9.2 11.4h5.6v2H9.2zM9.2 15.6h3.6v2H9.2z"/>') },
      // 周期总结与每日总结是同一条链路的两种视图（README/实现均复用），合并为「总结」的第二个分段
      { tab: 'period', label: '周期报告', icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/><path d="M7 14h4M13 14h4M7 17h4"/>', hidden: true },
    ],
  },
  {
    label: '会话与消息',
    items: [
      // 聊天会话：微信官方聊天气泡 —— 横向胶囊体（短边半圆）+ 左下一小截尾巴。
      // 官方气泡比我首版画的圆角矩形「胖」得多：rx 取到短边的一半才是那个形。
      { tab: 'chats', label: '聊天会话', icon: filled('<path d="M8.9 4.4h6.2a6.4 6.4 0 0 1 6.4 6.4 6.4 6.4 0 0 1-6.4 6.4H8.9a6.4 6.4 0 0 1 0-12.8z"/><path d="M7.4 15.4c-.3 2.6-1.9 4.5-4.6 5.6 2.7-.4 4.4-1.6 5.4-3.6.3-.7.5-1.4.5-2z"/>') },
      { tab: 'bizchats', label: '会话·公众号', icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', hidden: true },
      { tab: 'servicechats', label: '会话·服务号', icon: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>', hidden: true },
      { tab: 'kefu', label: '会话·客服', icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>', hidden: true },
      // 群聊分析：微信官方「多人」字形 —— 前面完整人像 + 右后方探出的第二个人
      { tab: 'groupinsights', label: '群聊分析', icon: filled('<path d="M8.8 11.4a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4zM8.8 13.3c-3.9 0-7.1 2.4-7.1 5.4V20h14.2v-1.3c0-3-3.2-5.4-7.1-5.4zM17.4 10.6a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8zM16.6 13.2c2.9 0 5.4 1.9 5.9 4.4.1.4.1.8.1 1.2v1.2h-3.6c.3-.7.5-1.4.5-2.2 0-1.9-1.1-3.6-2.9-4.6z"/>') },
      // 活跃监控与离线洞察都是「按群看消息量/成员」的视图，合并进「群聊分析」
      { tab: 'monitor', label: '群聊监控', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', hidden: true },
      // 通话记录：微信官方电话听筒（填充、倾斜）
      { tab: 'calls', label: '通话记录', icon: filled('<path d="M7.2 2.6c.6-.6 1.5-.6 2.1 0l2.5 2.5c.6.6.7 1.5.2 2.2l-1.3 1.9c-.3.5-.3 1.1 0 1.6.9 1.4 2.1 2.7 3.5 3.5.5.3 1.1.3 1.6 0l1.9-1.3c.7-.5 1.6-.4 2.2.2l2.5 2.5c.6.6.6 1.5 0 2.1l-1.5 1.5c-1 1-2.4 1.5-3.7 1.1-3.2-1-6.2-2.8-8.7-5.3S4.5 9.8 3.5 6.6c-.4-1.3.1-2.7 1.1-3.7z"/>') },
      { tab: 'revoked', label: '撤回消息', icon: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/><path d="M21 3v6h-6"/>', hidden: true },
    ],
  },
  {
    label: '联系人与社交',
    items: [
      // 通讯录：微信官方字形是「人像 + 右侧通讯录条目行」，不是单独一个人像 ——
      // 只画人像会和「联系人」类的其它图标撞脸，右侧三行才是通讯录的语义。
      { tab: 'contacts', label: '通讯录', icon: filled('<path d="M7.2 10.8a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8zM7.2 12.4c-3.3 0-6 2-6 4.6v1.6h12v-1.6c0-2.6-2.7-4.6-6-4.6z"/><path d="M15 5.4h6.4a1.1 1.1 0 0 1 0 2.2H15a1.1 1.1 0 0 1 0-2.2zM15 9.6h4.8a1.1 1.1 0 0 1 0 2.2H15a1.1 1.1 0 0 1 0-2.2zM15 13.8h6.4a1.1 1.1 0 0 1 0 2.2H15a1.1 1.1 0 0 1 0-2.2z"/>') },
      // 朋友圈：微信官方光圈字形 —— 中心实心圆 + 外圈八段带缺口的花瓣（光圈/快门）。
      // 我首版画的是「外环 + 偏左上的内圆」，那是眼形不是光圈；官方形是**中心圆 + 分段外环**。
      // 花瓣必须够细：首版每段 32°/缺口 13° 时几乎连成实心环，和官方「缺口清晰」的观感不符，
      // 现为每段 23°/缺口 22°（内半径 5.4 / 外半径 9.8）。八段弧端点由几何生成，手改半径会错位。
      { tab: 'moments', label: '朋友圈', icon: filled('<path d="M21.62 13.87A9.8 9.8 0 0 1 20.12 17.48L16.48 15.02A5.4 5.4 0 0 0 17.30 13.03ZM17.48 20.12A9.8 9.8 0 0 1 13.87 21.62L13.03 17.30A5.4 5.4 0 0 0 15.02 16.48ZM10.13 21.62A9.8 9.8 0 0 1 6.52 20.12L8.98 16.48A5.4 5.4 0 0 0 10.97 17.30ZM3.88 17.48A9.8 9.8 0 0 1 2.38 13.87L6.70 13.03A5.4 5.4 0 0 0 7.52 15.02ZM2.38 10.13A9.8 9.8 0 0 1 3.88 6.52L7.52 8.98A5.4 5.4 0 0 0 6.70 10.97ZM6.52 3.88A9.8 9.8 0 0 1 10.13 2.38L10.97 6.70A5.4 5.4 0 0 0 8.98 7.52ZM13.87 2.38A9.8 9.8 0 0 1 17.48 3.88L15.02 7.52A5.4 5.4 0 0 0 13.03 6.70ZM20.12 6.52A9.8 9.8 0 0 1 21.62 10.13L17.30 10.97A5.4 5.4 0 0 0 16.48 8.98Z"/><path d="M9.7 12a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0z"/>') },
      // 社交图谱与知识图谱是两个并列入口，不共用一个面板的模式切换：
      // 前者是「我的人脉」（好友/群组），后者是「我的笔记」（知识网络/融合视图）。
      // 两者的数据源、指标口径（消息量 vs 连接度）与默认筛选都不同，合成一个面板
      // 会让默认视图变得含糊 —— 打开图谱的人多数是想看好友。
      // 社交图谱：人像 + 三个散点（人脉网络）。
      // 人像与散点之间必须留出可见空隙：17px 下两者的最近点若只隔不到 2 个单位，
      // 缩到 12px 就会糊成一团（首版实测就是这样），看起来像「人身上长了疙瘩」。
      { tab: 'graph', label: '社交图谱', icon: filled('<path d="M7.6 10.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM7.6 12c-3.3 0-5.9 1.9-5.9 4.4v1.5h11.8v-1.5c0-2.5-2.6-4.4-5.9-4.4zM17.2 4.4a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM21 10a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM17.4 14.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z"/>') },
      // 知识图谱：带书脊与两行正文的书（知识/笔记）
      { tab: 'knowledge', label: '知识图谱', icon: filled('<path fill-rule="evenodd" d="M4.6 3.4A2.2 2.2 0 0 1 6.8 1.2h12.6a.9.9 0 0 1 .9.9v19.8a.9.9 0 0 1-.9.9H6.8a2.2 2.2 0 0 1-2.2-2.2zM8.2 5.6h1.8v12.8H8.2zM12 7.2h5.4v1.9H12zM12 11.2h5.4v1.9H12z"/>') },
    ],
  },
  {
    label: '内容资产',
    items: [
      // 收藏与表情：微信官方「收藏」是**立方体轮廓**（等距立方 + 内部三条棱），
      // 不是五角星。这是整排里唯一一条线稿 —— 官方本身是描边形，所以这里刻意不用
      // filled() 包裹；只写 fill="none"，描边颜色/粗细/端点全部吃外层 svg 的继承
      // （描边粗细只在 WechatDataPanel 的 svg 上定义一处，图标里不再重复）。
      // 顶点 (12,2.8)(20.6,8.2)(20.6,15.8)(12,21.2)(3.4,15.8)(3.4,8.2)，中心 (12,12)，
      // 三条内棱连到左上/右上/正下 —— 即官方那个「上开口的 Y」。
      { tab: 'favorites', label: '收藏与表情', icon: '<path fill="none" d="M12 2.8L20.6 8.2V15.8L12 21.2L3.4 15.8V8.2ZM12 12L3.4 8.2M12 12L20.6 8.2M12 12L12 21.2"/>' },
      // 表情包与「收藏/表情统计」都是同一批数据的视图（统计面板本身就统计收藏+表情）
      { tab: 'emoticons', label: '表情包', icon: '<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1"/><circle cx="16" cy="10" r="1"/><path d="M8 15a4 4 0 0 0 8 0"/>', hidden: true },
      { tab: 'assetinsights', label: '收藏表情统计', icon: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>', hidden: true },
      // 文件与存储：微信官方文件夹字形
      { tab: 'files', label: '文件与存储', icon: filled('<path d="M2.8 5.6A2.6 2.6 0 0 1 5.4 3h3.5c.7 0 1.36.28 1.85.77l1.06 1.06c.17.17.4.27.64.27h7.55A2.6 2.6 0 0 1 22.6 7.7v9.7a2.6 2.6 0 0 1-2.6 2.6H5.4a2.6 2.6 0 0 1-2.6-2.6z"/>') },
      // 媒体资产与存储分析都在盘点同一批附件体积（存储分析取 apiGetStorageStats，媒体资产取 apiGetMediaAssets，文件资产两者都用）
      { tab: 'mediaassets', label: '媒体资产', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', hidden: true },
      { tab: 'storage', label: '存储分析', icon: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>', hidden: true },
      { tab: 'officialassets', label: '公众号文章', icon: '<path d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>', hidden: true },
    ],
  },
  {
    label: '资金',
    items: [
      // 资金往来：微信官方钱包字形（圆角包体 + 右侧卡槽按钮挖空）
      { tab: 'ledger', label: '资金往来', icon: filled('<path fill-rule="evenodd" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v1.2h.5a1.5 1.5 0 0 1 1.5 1.5v4.6a1.5 1.5 0 0 1-1.5 1.5H20v1.2a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM18.2 10.1a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/>') },
      // 资金账本是「按月汇总」、转账红包是「逐条明细」，同一批转账/红包消息的两种视图
      { tab: 'records', label: '转账红包', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/>', hidden: true },
    ],
  },
  {
    label: '洞察与行动',
    items: [
      // 朋友圈洞察：同一枚官方光圈，中心圆换成三根递增柱（同一主题的分析视图）。
      // 柱子必须短到能完全落在内圈半径 5.4 的圆里 —— 画长了会插进花瓣之间的缺口，缩到 17px 时糊成一团。
      { tab: 'momentsinsights', label: '朋友圈洞察', icon: filled('<path d="M21.62 13.87A9.8 9.8 0 0 1 20.12 17.48L16.48 15.02A5.4 5.4 0 0 0 17.30 13.03ZM17.48 20.12A9.8 9.8 0 0 1 13.87 21.62L13.03 17.30A5.4 5.4 0 0 0 15.02 16.48ZM10.13 21.62A9.8 9.8 0 0 1 6.52 20.12L8.98 16.48A5.4 5.4 0 0 0 10.97 17.30ZM3.88 17.48A9.8 9.8 0 0 1 2.38 13.87L6.70 13.03A5.4 5.4 0 0 0 7.52 15.02ZM2.38 10.13A9.8 9.8 0 0 1 3.88 6.52L7.52 8.98A5.4 5.4 0 0 0 6.70 10.97ZM6.52 3.88A9.8 9.8 0 0 1 10.13 2.38L10.97 6.70A5.4 5.4 0 0 0 8.98 7.52ZM13.87 2.38A9.8 9.8 0 0 1 17.48 3.88L15.02 7.52A5.4 5.4 0 0 0 13.03 6.70ZM20.12 6.52A9.8 9.8 0 0 1 21.62 10.13L17.30 10.97A5.4 5.4 0 0 0 16.48 8.98Z"/><path d="M9.3 12.4h1.8a.9.9 0 0 1 .9.9v1.5a.9.9 0 0 1-.9.9H9.3a.9.9 0 0 1-.9-.9v-1.5a.9.9 0 0 1 .9-.9zM11.5 11h1.8a.9.9 0 0 1 .9.9v2.9a.9.9 0 0 1-.9.9h-1.8a.9.9 0 0 1-.9-.9v-2.9a.9.9 0 0 1 .9-.9zM13.7 9.8h1.8a.9.9 0 0 1 .9.9v4.1a.9.9 0 0 1-.9.9h-1.8a.9.9 0 0 1-.9-.9v-4.1a.9.9 0 0 1 .9-.9z"/>') },
      // 待办日程：圆角方块挖空对勾（完成态）
      { tab: 'tasks', label: '待办日程', icon: filled('<path fill-rule="evenodd" d="M4.8 3.4h14.4A2.4 2.4 0 0 1 21.6 5.8v12.4a2.4 2.4 0 0 1-2.4 2.4H4.8a2.4 2.4 0 0 1-2.4-2.4V5.8a2.4 2.4 0 0 1 2.4-2.4zM9.6 16.8l-4.4-4.4-1.5 1.5 5.9 5.9L21 8.4l-1.5-1.5z"/>') },
    ],
  },
  {
    label: '隐私与安全',
    items: [
      // 「数据边界与出网 / 备份恢复」2026-09 迁进「设置」弹窗（它们是配置与维护动作，
      // 见 Settings.tsx 的分组）。保留 tab id（深链 #privacytrust / #backup 与其它面板的
      // 跳转仍走它），但不占侧栏条目：命中这些 tab 时由 WechatDataPanel 的 DIALOG_SECTION_OF
      // 改道去开弹窗并落到对应节。
      { tab: 'privacytrust', label: '数据边界与出网', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>', hidden: true },
      // 隐私体检 2026-09 一度也进过弹窗，现按「只读数据视图回主界面」迁回来：
      // 它是分类扫描结果 + 风险联系人/群 TOP10，命中样本还要能跳回会话 —— 那属于看数据。
      // 盾牌 + 挖空对勾（微信安全语义）
      { tab: 'privacy', label: '隐私体检', icon: filled('<path fill-rule="evenodd" d="M12 2.2l8.2 3v6c0 5.4-3.4 9.8-8.2 11.4C7.2 21 3.8 16.6 3.8 11.2v-6zM10.6 14.9l-3.3-3.3 1.5-1.5 1.8 1.8 5-5 1.5 1.5z"/>') },
      { tab: 'backup', label: '备份恢复', icon: '<path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/>', hidden: true },
    ],
  },
  {
    label: '维护与设置',
    items: [
      // settings 固定在侧栏底部（这是它的图标来源）；health/hook 是「设置」弹窗里的两节（自检与维护动作）。
      // 操作日志 2026-09 一度也进过弹窗，现按「只读数据视图回主界面」迁回来：它是审计长表，
      // 弹窗右区只有 660px 宽、浏览与翻查都别扭。
      // 设置：微信官方齿轮 —— 填充环 + 八枚圆角齿（用 transform 轮转，避免手算 8 组坐标）
      {
        tab: 'settings', label: '设置',
        icon: filled(
          '<path fill-rule="evenodd" d="M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8zm0 5.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z"/>' +
          [0, 45, 90, 135, 180, 225, 270, 315]
            .map(a => `<rect x="10.7" y="1.6" width="2.6" height="4.6" rx="1.3" transform="rotate(${a} 12 12)"/>`)
            .join(''),
        ),
      },
      // 操作日志：填充圆环 + 两根指针（挖空区里再挖出指针，走 evenodd 的三重交叉）
      { tab: 'oplog', label: '操作日志', icon: filled('<path fill-rule="evenodd" d="M12 2.2a9.8 9.8 0 1 0 0 19.6 9.8 9.8 0 0 0 0-19.6zm0 2.4a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8zM11.2 7.2h1.6v5.6h-1.6zM12 11.2h4.4v1.6H12z"/>') },
      { tab: 'health', label: '数据库健康', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', hidden: true },
      { tab: 'hook', label: '原图链路自检', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h3M12 17H8M16 13h1M17 17h1"/>', hidden: true },
    ],
  },
]

export const TAB_LABELS: Record<WechatTab, string> = (() => {
  const map = {} as Record<WechatTab, string>
  for (const g of NAV_GROUPS) for (const it of g.items) map[it.tab] = it.label
  return map
})()
