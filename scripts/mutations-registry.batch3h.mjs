/**
 * 变异登记 · ClawBot **来源区分 + 当前实例标记**（2026-10-13，M484 起，M5）。
 *
 * 这一批守的是「用户在界面上能不能分清**这条消息/这个开关属于谁**」：
 *   · 自动回复的问答不带 `source` ⇒ 历史里冒出一条用户没问过的记录，
 *     且排查「为什么自动回了这么一句」失去唯一依据（缺省是 `'ask'`，静默无错）；
 *   · 来源页签/标签丢了 `auto` ⇒ 列表里显示一个裸的 `auto`，或整类记录混进「微信问答」；
 *   · 实例卡的「当前」标记不比对 slot ⇒ 要么一行都不标、要么行行都标，
 *     用户改完实例 2 的开关会以为改的是列表第一条（此后所有读写都落在另一个号上）。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3h
 */
export const MUTATIONS_BATCH3H = [
  {
    id: 'M484-clawbot-ask-history-source-lost',
    why: '自动回复的 ask 不带 source ⇒ 落进问答历史时是缺省的 `ask`（= 用户手动问）。后果不是报错，而是历史里多出一条用户根本没问过的记录，且「为什么它自动回了这么一句」再也查不到依据 —— 这是本仓第一处「用户没点击、模型也答了」的问答，来源是它唯一的判别位。判据：ask-history-wiring.spec.ts 的「自动回复落 source=auto」。',
    file: 'src/backend/wechat-data/src/gateway-clawbot.ts',
    from: "          const r = await this.askDeepRemotes().askWechat({ question: text, source: 'auto', ...(kbId === null ? {} : { kbId }) })",
    to: "          const r = await this.askDeepRemotes().askWechat({ question: text, ...(kbId === null ? {} : { kbId }) })",
    spec: 'src/backend/tests/ask-history-wiring.spec.ts',
  },
  {
    id: 'M485-clawbot-history-auto-label-lost',
    why: '来源标签表丢掉 `auto` ⇒ 自动回复的记录在列表里只显示一个裸的 `auto`（用户不知道那是什么），页签上也筛不出这一类。判据：ask-history.wiring.spec.ts 的「来源页签与中文标签都有 auto」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/AskHistoryDialog.tsx',
    from: "const SRC_LABEL: Record<string, string> = { ask: '微信问答', session: '会话内问答', auto: '自动回复' }",
    to: "const SRC_LABEL: Record<string, string> = { ask: '微信问答', session: '会话内问答' }",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/ask-history.wiring.spec.ts',
  },
  {
    id: 'M486-clawbot-instance-current-mark-lost',
    why: '（2026-10-13 C3：实例卡拆解，「当前」标记迁到实例轨 ⇒ 锚点从 clawbot-instances.tsx 改指 clawbot-rail.tsx 的同款形状；判据由 clawbot-layout.spec.ts 的 A4 接手。）当前行标记不再比对 slot ⇒ 要么一行都不标（用户看不出改的是哪个号）、要么写成恒真（行行都标，等于没标）。面板其余部分只作用于当前实例，标错等于让用户以为自己在改 A 号，实际改的是 B 号。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-rail.tsx',
    from: "data-current={it.slot === slot ? '' : undefined}",
    to: 'data-current={undefined}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-layout.spec.ts',
  },

  {
    id: 'M487-chats-info-member-name-wraps-again',
    why: '（2026-10-13 D3）成员名折行复发 ⇒ 与官方单行省略形态不一致、格子里名字读不全。判据：chats-group-info-view.wiring.spec.ts 的「成员网格：名单行省略 + 头像 48」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-rows.module.css',
    from: '  text-overflow: ellipsis;\n  white-space: nowrap;\n  line-height: 1.3;',
    to: '  text-overflow: ellipsis;\n  line-height: 1.3;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M488-chats-info-row-height-collapsed',
    why: '（2026-10-13 D2）行高 min-height 48 被删 ⇒ 行跌破官方 44–56 区间，命中区与观感都散。判据：同 wiring 的「行语法」用例。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info.module.css',
    from: '  min-height: 48px;\n  padding: 6px 0;',
    to: '  padding: 6px 0;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M489-chats-info-readonly-switch-becomes-live',
    why: '（2026-10-13 D1）只读开关丢了 aria-disabled ⇒ 看着能点、点了没反应（假可用）；下一步就有人给它挂 onChange 承诺本应用没有的写回能力。判据：wiring「只读开关是死控件纪律」+ jsdom「开关是只读的」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-rows.tsx',
    from: '      aria-disabled="true"\n',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M490-chats-info-export-slot-unpinned',
    why: '（2026-10-13 D7）底部动作位 margin-top:auto 被删 ⇒ 导出按钮又悬在抽屉中段，官方底部按钮槽消失。判据：wiring「底部动作位贴底」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css',
    from: '.groupExport {\n  margin-top: auto;',
    to: '.groupExport {',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M491-chats-right-pane-default-open-again',
    why: '（2026-10-13 用户要求「进入聊天框后推荐回复面板和分析面板默认不显示」）推荐回复初值改回 true ⇒ 进会话右栏又默认摊开，消息列被挤。判据：chat-analysis-panel.wiring.spec.ts 的 ②。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Chats.tsx',
    from: 'const [suggestOpen, setSuggestOpen] = useState(false)',
    to: 'const [suggestOpen, setSuggestOpen] = useState(true)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-analysis-panel.wiring.spec.ts',
  },
]
