/**
 * 消息列表投递依赖装配。
 *
 * 远程处理器只负责编排，图片解码、隐私闸与 fetch 注入在这里统一组装。
 *
 * @module remotes/message-list-dispatch-deps
 */
import { decodeImageDataUrlAsync } from '../query/media-image-async.ts'
import type { MessageListDispatchDeps } from '../query/message-list-dispatch.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'

export interface MessageListDispatchDirs {
  decrypted: string
  decoded: string
}

export interface MessageListImageContext {
  wechatBaseDir?: string
  aesKey?: string
  xorKey: number
}

export interface MessageListDispatchDepsInput {
  dirs: () => MessageListDispatchDirs
  imageContext: () => MessageListImageContext
  privacyGate: (
    feature: string,
    stats: { sessions: number; messages: number },
    texts: string[],
  ) => string[]
  fetchImpl?: RetryFetch
}

export function createMessageListDispatchDeps(
  input: MessageListDispatchDepsInput,
): MessageListDispatchDeps {
  const { decrypted, decoded } = input.dirs()
  const image = input.imageContext()
  const deps: MessageListDispatchDeps = {
    decodeImage: (username, localId) => decodeImageDataUrlAsync(
      decrypted,
      decoded,
      username,
      localId,
      image.wechatBaseDir,
      image.aesKey,
      image.xorKey,
    ),
    gate: (feature, stats, texts) => input.privacyGate(feature, stats, texts),
  }
  if (input.fetchImpl !== undefined) deps.fetchImpl = input.fetchImpl
  return deps
}
