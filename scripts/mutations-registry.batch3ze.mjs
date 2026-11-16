/**
 * 变异登记 · **消息行的「高度估算 + 停稳补量」**（2026-11-15，用户报「聊天窗口里的消息分布不对」）。
 *
 * 这一批守的是同一件事的三个入口：虚拟消息行是**绝对定位**的，行高由内容撑开。
 * 估算值比真实值矮的行在挂载首帧会压到下一行上（表情/图片最严重：`<img>` 解码前
 * 高度 0、之后最多 130px），快速上滚时测量又会被 TanStack 的滚动闸跳过，于是
 * 「消息/日期分隔叠在一起」。三个入口分别是：
 *
 *   M848 把自定义表情的估算退回普通文本行（72px） ⇒ 表情行首帧压住下一行；
 *   M849 表情去掉定尺寸占位（`reserve = false`） ⇒ 行高先塌后涨，重叠回到修前；
 *   M850 滚动停稳后不再调用 `measureElement` ⇒ 跳过的测量永远补不回来。
 *
 * 判据分别是 `chats-virtual-key.spec.ts`（估算口径）、`chats-sticker.spec.ts`
 * （占位行为）与 `chats-virtual-measure.spec.ts`（补量接线）。
 *
 * @module mutations-registry/batch3ze
 */
export const MUTATIONS_BATCH3ZE = [
  {
    id: 'M848-sticker-height-estimated-as-text',
    why: '把自定义表情（renderType=sticker）的初始高度估算退回普通文本行的 72px ⇒ 130px 的贴图行在挂载首帧高出自己的槽位近 100px，直接压到下一行上（用户看到的「消息叠在一起」）。判据：chats-virtual-key.spec.ts 的「表情行估矮 100px」用例。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-support.tsx',
    from: "    case 'sticker':\n      return 176",
    to: "    case 'sticker':\n      return 72",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-virtual-key.spec.ts',
  },
  {
    id: 'M851-emoticon-fetch-chip-instead-of-placeholder',
    why: '后端解码表情期间退回「表情」芯片（不占行高）⇒ 取图几百毫秒里行高只有几十像素，图到了再涨 100px，虚拟列表把下一行画到它身上。判据：chats-sticker.spec.ts 的「取图期间也先占位」用例。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-media.tsx',
    from: '  if (!err) return <StickerPlaceholder />',
    to: '  if (!err) return <></>',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-sticker.spec.ts',
  },
  {
    id: 'M849-sticker-placeholder-dropped',
    why: '表情不再用定尺寸占位（`reserve = false`）⇒ `<img>` 解码前高度 0、解码后最多 130px，行高先塌后涨，虚拟列表把后续行画到它身上。判据：chats-sticker.spec.ts 的「先占 STICKER_PLACEHOLDER_PX 方块」用例。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-sticker.tsx',
    from: '  const reserve = !loaded',
    to: '  const reserve = false',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-sticker.spec.ts',
  },
  {
    id: 'M850-settle-measure-not-called',
    why: '滚动停稳后遍历了行却不再调用 `measureElement` ⇒ 滚动期间被跳过的测量永远补不回来，快速上滚时相邻行重叠会停留到下一次滚动。判据：chats-virtual-measure.spec.ts 的「遍历了却没有回填高度」用例。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-message-virtualizer.ts',
    from: '          msgVirtualizer.measureElement(el)',
    to: '          void el',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-virtual-measure.spec.ts',
  },
]
