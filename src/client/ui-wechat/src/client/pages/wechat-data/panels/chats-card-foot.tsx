/**
 * 卡片底部的**类型条**（微信原生卡片底部那一行「微信转账 / 微信红包 / 聊天记录」）。
 *
 * 有了它，同一张卡片在不同位置（气泡内 / 合并转发弹窗内）都能被一眼认出来源；
 * 也因此**不再**把类型名塞进标题 —— 那会让标题被截断。
 *
 * ## 为什么单独一个文件
 *
 * `chats-media.tsx` 与 `chats-cards.tsx` 都要用它，而 cards 里还定义着别的组件 ——
 * 于是「media 引 cards 的 CardFoot」+「cards 引 media 的一堆消息卡」连成一个值 import 环
 * （`src/backend/tests/module-cycle-guard.spec.ts` 的 `KNOWN_RINGS` 里原来就有这一条）。
 * 这个组件谁都不依赖（只借一个 CSS 类），所以放到最下面一层，环自然就断 ——
 * 比把整组卡片组件重排的代价小两个量级。
 */
import css from './chats.module.css'

/**
 * @param props.label - 类型名。
 * @returns the footer element.
 */
export function CardFoot({ label }: { label: string }): React.JSX.Element {
  return <span className={css.msgCardFoot}>{label}</span>
}
