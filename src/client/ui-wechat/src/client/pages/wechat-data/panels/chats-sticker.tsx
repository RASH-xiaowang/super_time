/**
 * 自定义表情（sticker）的定尺寸占位 + 真图。
 *
 * 为什么表情也需要骨架：消息行跑在虚拟列表里，行高是**内容撑出来的**，虚拟器先按
 * 估算值把行摆到位，再由 `measureElement` 回填真实高度。`<img>` 在解码完成前没有
 * 固有尺寸（高度 0），解码完成后最多 130px —— 这一跳会让「挂载首帧测到的行高」比
 * 真实值矮近 100px，紧跟着的那一行就被画到它身上（用户看到的「消息叠在一起」
 * 「分布不对」），要等 ResizeObserver 回填才归位。图片消息早就用
 * `.msgImageSkeleton` 定尺寸占位，表情此前是裸 `<img>`。
 *
 * 占位取 130×130（与 `.msgSticker` 的 `max-height` 相等）：加载期间容器先占住这块高度，
 * 真图就绪后交还给图片自身的固有尺寸 —— 因为真图不可能超过 130px，行高只会持平或
 * **变矮**（≤16px 的空白由 `measureElement` 回填），不会再出现「先矮后涨压住下一行」。
 *
 * 取图纪律仍走 `useRemoteImage`：本地地址（`data:`/`blob:`/`file:`）直画，远程地址
 * 交后端代理，不把「渲染层可请求任意 https」写进产品。CDN 取不到时回落
 * `fallbackSrc`（本机解码结果），两条都失败才退回「表情」占位芯片。
 *
 * @module chats-sticker
 */
import { useState } from 'react'
import { useRemoteImage } from './remote-img.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'

/** 加载期间的占位边长（px）。**必须等于** `.msgSticker` 的 `max-height`（130px）：
 * 占位只要比最大真图矮，加载完成就一定会「长高」并压住下一行；取等号后真图只能
 * 比占位矮（≤16px 的空白由测量回填），不可能更高。 */
export const STICKER_PLACEHOLDER_PX = 130

/**
 * 取图/解码期间的定尺寸占位。
 *
 * 自定义表情先要向后端要 data URL（冷启动要扫表情缓存，几百毫秒），拿到之后 `<img>`
 * 还要解码 —— 这段时间如果画成「表情」芯片，行高只有几十像素，等图到了再涨到 130px，
 * 虚拟列表就会把下一行画到它身上。取图阶段与解码阶段用同一块占位，行高只跳一次。
 * @returns 与 `StickerImage` 同尺寸的骨架方块。
 */
export function StickerPlaceholder(): React.JSX.Element {
  return (
    <div className={cssrows.msgSticker} style={{ width: STICKER_PLACEHOLDER_PX, height: STICKER_PLACEHOLDER_PX }}>
      <div className={css.msgImageSkeleton} style={{ width: '100%', height: '100%' }} aria-hidden="true" />
    </div>
  )
}

export interface StickerImageProps {
  /** 主地址：本机 `data:`/`blob:`，或可经后端代理的腾讯系 CDN 地址。 */
  src: string
  /** 无障碍/悬停文案（表情名或「表情」）。 */
  label?: string
  /** 主地址取不到时的备选（通常是本机解码出的 data URL）。 */
  fallbackSrc?: string
}

/**
 * 画一张表情：加载中占位，就绪后按固有尺寸显示，失败退回占位芯片。
 * @param props - 表情地址与说明。
 * @returns 表情行内容（不含气泡外壳）。
 */
export function StickerImage({ src, label, fallbackSrc = '' }: StickerImageProps): React.JSX.Element {
  const state = useRemoteImage(src, fallbackSrc)
  /* 记住「哪一张图已经就绪」而不是布尔值：虚拟列表会复用行组件，换一条消息换一张
     表情时，旧的 true 会让新图直接跳过占位、行高先塌后涨。 */
  const [loadedSrc, setLoadedSrc] = useState('')
  const [failedSrc, setFailedSrc] = useState('')
  const failed = failedSrc !== '' && failedSrc === state.src
  const loaded = state.status === 'ready' && loadedSrc === state.src
  const safeLabel = label && label.trim() !== '' ? label : '表情'
  if (failed || state.status === 'empty' || state.status === 'failed') {
    return (
      <div className={css.msgBubble}>
        <span className={cssrows.msgEmojiChip} title="表情">表情</span>
      </div>
    )
  }
  /* 真图就绪前用固定方块占住行高；`opacity: 0` 的 <img> 仍在正常加载（display:none
     不会触发加载），只是不参与布局，避免「骨架 + 图片」叠出双倍高度。 */
  const reserve = !loaded
  return (
    <div
      className={cssrows.msgSticker}
      title={safeLabel}
      style={{ position: 'relative', ...(reserve ? { width: STICKER_PLACEHOLDER_PX, height: STICKER_PLACEHOLDER_PX } : {}) }}
    >
      {reserve ? <div className={css.msgImageSkeleton} style={{ width: '100%', height: '100%' }} aria-hidden="true" /> : null}
      {state.status === 'ready'
        ? (
            <img
              className={cssrows.msgStickerImg}
              src={state.src}
              alt={safeLabel}
              loading="lazy"
              decoding="async"
              data-loaded={loaded ? '1' : undefined}
              style={reserve ? { position: 'absolute', left: 0, top: 0, opacity: 0 } : undefined}
              onLoad={() => { setLoadedSrc(state.src) }}
              onError={() => { setFailedSrc(state.src) }}
            />
          )
        : null}
    </div>
  )
}
