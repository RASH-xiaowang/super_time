
/**
 * 词云（wordcloud） 的 @Remote 处理器（2026-09-25，界面优化阶段 4）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { queryWordCloud, WordCloudOptions, WordCloudResult } from '../query/wordcloud.ts'

export interface createWordcloudRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
}

export function createWordcloudRemotes(rc: createWordcloudRemotesInputs) {
  return {
    // `queryWordCloud` 改成 async 是为了在分片/行级让出事件循环（见该函数头注）：
    // 它一次冷算仍要 ~2 秒，同步返回会把整个后端 RPC 队列堵住。
    getWordCloud(options?: WordCloudOptions): Promise<WordCloudResult> {
      return queryWordCloud(rc.dirs().decrypted, options)
    },
  }
}
