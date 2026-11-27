/**
 * 把人物性格要用的图片解码成模型能看的 data URL。
 *
 * 只解对方聊天图和朋友圈图的抽样，不把本机路径交给模型。单张失败就跳过，
 * 不能因为一张图解不开就让整次性格分析停掉。
 */
import { decodeChatAiReplyImages } from './ai-reply/context.ts'
import type { PersonalityMomentImageRef } from './portrait-personality.ts'
import { resolveSnsImageDataUrl } from './sns-image.ts'

const TOTAL_BYTES = 6 * 1024 * 1024

export interface PortraitVisionImage {
  dataUrl: string
  mediaType: string
  source: 'chat' | 'moment'
}

export async function loadPortraitVisionImages(input: {
  decryptedDir: string
  decodedDir: string
  talker: string
  localIds: readonly number[]
  momentImages: readonly PersonalityMomentImageRef[]
  wechatBaseDir?: string
  aesKey?: string
  xorKey: number
}): Promise<PortraitVisionImage[]> {
  const out: PortraitVisionImage[] = []
  let used = 0
  if (input.localIds.length > 0) {
    try {
      const decoded = await decodeChatAiReplyImages(
        input.decryptedDir,
        input.decodedDir,
        input.talker,
        input.localIds.map((localId) => ({ localId, kind: 'image' as const })),
        {
          ...(input.wechatBaseDir === undefined ? {} : { wechatBaseDir: input.wechatBaseDir }),
          ...(input.aesKey === undefined ? {} : { aesKey: input.aesKey }),
          xorKey: input.xorKey,
          maxImages: input.localIds.length,
          maxBytes: TOTAL_BYTES,
        },
      )
      for (const image of decoded) {
        if (used + image.bytes > TOTAL_BYTES) break
        used += image.bytes
        out.push({ dataUrl: image.dataUrl, mediaType: image.mediaType, source: 'chat' })
      }
    } catch {
      // 聊天图解不开时仍继续试朋友圈图。
    }
  }
  if (input.wechatBaseDir === undefined || input.momentImages.length === 0) return out
  for (const ref of input.momentImages) {
    if (used >= TOTAL_BYTES) break
    try {
      const decoded = await resolveSnsImageDataUrl(
        input.wechatBaseDir,
        input.aesKey,
        input.xorKey,
        ref.md5,
        ref.timelineId,
        ref.mediaId,
        true,
      )
      const url = decoded.url ?? ''
      const mediaType = mediaTypeOf(url)
      const bytes = dataUrlBytes(url)
      if (url === '' || !mediaType.startsWith('image/') || bytes <= 0 || used + bytes > TOTAL_BYTES) continue
      used += bytes
      out.push({ dataUrl: url, mediaType, source: 'moment' })
    } catch {
      // 单张朋友圈图失败不影响其余材料。
    }
  }
  return out
}

function mediaTypeOf(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1] ?? ''
}

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  return Math.floor((dataUrl.length - comma - 1) * 3 / 4)
}
