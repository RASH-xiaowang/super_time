/**
 * 变异登记 · 群聊信息抽屉（2026-10-13 起）。
 *
 * M690 一族（2026-10-19）守的是**用户已要求删掉**的只读开关。
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
