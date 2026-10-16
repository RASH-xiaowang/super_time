/**
 * 变异登记 · **表格手机档 + hover 可达性**（2026-10-14，M561 起，M8）。
 *
 * 这一批的两条主线各配一条反证，外加一条把「出口」判据本身的空转钉住：
 *
 *   M561 表格首列 sticky 的底色退回透明 —— td/th 原本全透明、斑马纹与表头都是半透明叠色，
 *        粘住的列会让内容从底下穿出来（读到的是叠字），实测只在手机上出现；
 *   M562 消息时间戳的触摸出口失效（`:active` 那档不再把它显出来）⇒ 手机上每条消息的
 *        精确时间永远看不到（基础态是 `opacity: 0`，桌面靠 `:hover`）；
 *   M563 朋友圈洞察月份标注的 `@media (hover: none)` 出口写成 `opacity: 0` ——
 *        「出口那一档提到类名」不等于「出口真的把它显出来」，这条专治那种假出口。
 *
 * @module mutations-registry/batch3y
 */
export const MUTATIONS_BATCH3Y = [
  {
    id: 'M561-sticky-first-column-background-transparent',
    why: '表格首列 sticky 的底色改成透明：td/th 本来就全透明（斑马纹与表头都是半透明叠色），粘住的列会让右边滚过来的内容从它底下穿出来 —— 手机上读到的是叠字，桌面端不横滚所以看不见。判据：m8-tables-hover.wiring.spec.ts 的「首列 sticky 到左边，底色用卡片令牌」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-table.module.css',
    from: '    background-color: var(--nm-bg-card, #0f172a);',
    to: '    background-color: transparent;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m8-tables-hover.wiring.spec.ts',
  },
  {
    id: 'M562-msg-time-chip-touch-escape-dead',
    why: '消息行时间戳的触摸出口被写坏（:active 时不再显出来）⇒ 手机上每条消息的精确时间永远看不到：基础态是 `opacity: 0`，桌面靠 `.msgRow:hover` 显出，而触摸没有 hover。判据：m8-tables-hover.wiring.spec.ts 的全仓不变量（hover-only reveal 必须有出口）。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats.module.css',
    from: '  .msgRow:active .msgTimeChip { opacity: 1; }',
    to: '  .msgRow:active .msgTimeChip { opacity: 0.5; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m8-tables-hover.wiring.spec.ts',
  },
  {
    id: 'M563-month-label-escape-reveals-nothing',
    why: '朋友圈洞察月份标注的 `@media (hover: none)` 出口把 opacity 写成 0 —— 那一档**提到了类名**却没有把它显出来，等于没有出口：手机上 12 根柱子永远没有月份标签。这条专治「假出口」（判据要求那一档真的显出 opacity:1 / visible / display）。判据：m8-tables-hover.wiring.spec.ts 的全仓不变量。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments.module.css',
    from: '  .monthLabel { opacity: 1; font-size: 9.5px; overflow: hidden; }',
    to: '  .monthLabel { opacity: 0; font-size: 9.5px; overflow: hidden; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m8-tables-hover.wiring.spec.ts',
  },
]
