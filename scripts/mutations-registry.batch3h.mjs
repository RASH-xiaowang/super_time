/**
 * 变异登记 · ClawBot **来源区分 + 当前实例标记**（2026-10-13，M484 起，M5）；
 * 2026-10-19 起追加 **群聊信息区③ 四行只读开关的删除位**（M690 一族）。
 *
 * 这一批守的是「用户在界面上能不能分清**这条消息/这个开关属于谁**」：
 *   · 自动回复的问答不带 `source` ⇒ 历史里冒出一条用户没问过的记录，
 *     且排查「为什么自动回了这么一句」失去唯一依据（缺省是 `'ask'`，静默无错）；
 *   · 来源页签/标签丢了 `auto` ⇒ 列表里显示一个裸的 `auto`，或整类记录混进「微信问答」；
 *   · 实例卡的「当前」标记不比对 slot ⇒ 要么一行都不标、要么行行都标，
 *     用户改完实例 2 的开关会以为改的是列表第一条（此后所有读写都落在另一个号上）。
 *
 * M690 一族（2026-10-19）方向相反：那四行不是"没挂上"，而是**用户已要求删掉**。
 * 免打扰 / 置顶 / 存通讯录 / 显成员昵称 全是「本机只读」的死控件 —— 给不了动作也给不了真相，
 * 四行只占抽屉半屏。要防的是"为了填满抽屉把它复活"（D1 当年的理由，今天已被用户否决），
 * 所以组件、CSS、抽屉三处各钉一格。
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
    from: "          const r = await this.askDeepRemotes().askWechat({\n            question: text, source: 'auto', dataScope: 'kb-only',",
    to: "          const r = await this.askDeepRemotes().askWechat({\n            question: text, dataScope: 'kb-only',",
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
    why: '（2026-10-13 C3：实例卡拆解，「当前」标记迁到实例轨 ⇒ 锚点从 clawbot-instances.tsx 改指 clawbot-rail.tsx 的同款形状；判据由 clawbot-layout.spec.ts 的 A4 接手。2026-10-16：当前行标记改成先算 `current`，锚点跟着改。）当前行标记不再比对 slot ⇒ 要么一行都不标（用户看不出改的是哪个号）、要么写成恒真（行行都标，等于没标）。面板其余部分只作用于当前实例，标错等于让用户以为自己在改 A 号，实际改的是 B 号。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-rail.tsx',
    from: 'const current = it.slot === slot',
    to: 'const current = true',
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
    why: '（2026-10-13 D1）只读开关丢了 aria-disabled ⇒ 看着能点、点了没反应（假可用）；下一步就有人给它挂 onChange 承诺本应用没有的写回能力。判据：wiring「只读开关是死控件纪律」+ jsdom「开关是只读的」。（2026-10-19 报废：区③ 四行已按用户要求删除，ReadOnlySwitch 与 .infoSwitch 一族随之清空 —— 死控件本身已不存在，这条守卫改由 M690 接手「不许复活」。）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-rows.tsx',
    from: 'export function SectionTitle({ children }: { children: string }): React.JSX.Element {',
    to: 'export function ReadOnlySwitch({ on, label }: { on: boolean, label: string }): React.JSX.Element {\n    return (\n      <span\n        className={cssinfo.infoSwitch}\n        data-on={on ? \'true\' : undefined}\n        role="switch"\n        aria-checked={on}\n        aria-disabled="true"\n        aria-label={`${label}（本机只读）`}\n        title="本机只读：状态取自微信本地库，本应用不写回"\n      >\n        <span className={cssinfo.infoSwitchKnob} aria-hidden="true" />\n      </span>\n    )\n  }\n\nexport function SectionTitle({ children }: { children: string }): React.JSX.Element {',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M690-chats-info-readonly-switch-resurrected',
    why: '（2026-10-19 用户要求「删除群聊信息中的这几项内容」）把 ReadOnlySwitch 复活一份、或把 .infoSwitch 一族写回 CSS ⇒ 免打扰/置顶/存通讯录/显成员昵称 四行又占回抽屉半屏。用户已明确否决这个形态（四只「本机只读」的死控件给不了动作也给不了真相），而 D1 当年的理由是「填满抽屉」——不钉住的话，下一个人很可能会以那个理由把它复活。判据：chats-group-info-view.wiring.spec.ts 的「只读开关一族已随区③ 删除」+ jsdom「区③ 四条只读开关行已删除」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-rows.tsx',
    from: 'import cssinfo from \'./chats-info.module.css\'',
    to: 'import cssinfo from \'./chats-info.module.css\'\n\nexport function ReadOnlySwitch({ on, label }: { on: boolean, label: string }): React.JSX.Element {\n    return (\n      <span className={cssinfo.infoSwitch} role="switch" aria-disabled="true">\n        <span className={cssinfo.infoSwitchKnob} aria-hidden="true" />\n      </span>\n    )\n  }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M690b-chats-info-switch-css-resurrected',
    why: '（2026-10-19 同上）把 .infoSwitch / .infoSwitchKnob 一族写回 chats-info.module.css ⇒ 组件那一侧即使没有 ReadOnlySwitch，样式又有了落脚点，下一个人复活组件时连 CSS 都是现成的。判据：chats-group-info-view.wiring.spec.ts 的「只读开关一族已随区③ 删除」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info.module.css',
    from: '.infoChevronBtn:hover { background: var(--nm-bg-hover); color: var(--nm-text-1); }',
    to: '.infoChevronBtn:hover { background: var(--nm-bg-hover); color: var(--nm-text-1); }\n.infoSwitch {\n  width: 28px;\n  height: 16px;\n}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
  {
    id: 'M690c-chats-info-switch-row-back-in-drawer',
    why: '（2026-10-19 同上）群抽屉又把某条只读开关行画回去（label="消息免打扰" 那一族）⇒ 用户已要求删除的四项又占回半屏，而抽屉自己的 jsdom 用例只数 switch 总数、单独一行照样漏得过去。判据：chats-group-info-view.wiring.spec.ts 的「只读开关一族已随区③ 删除」+ jsdom「区③ 四条只读开关行已删除」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.tsx',
    from: '              <InfoRow label="群成员数" value={String(memberTotal)} />',
    to: '              <InfoRow label="群成员数" value={String(memberTotal)} />\n              <InfoRow label="消息免打扰" switchOn={groupInfo.settings.muted} />',
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
