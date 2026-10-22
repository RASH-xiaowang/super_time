/**
 * 生成器缺口的**源码侧参数 schema 覆盖层**。
 *
 * `lib/typert.host.js` 由仓库外的 `@deepseek-ai/dsh-typert-generator` 生成，
 * 新 `@Remote` 方法偶尔会先落源码、后补生成物。直接手改 `lib/**` 会让生成物
 * 失去可重建性，因此这里只登记这些方法的**调用参数**形状，由宿主在加载生成表后
 * 合并。结果形状不进这里：当前入参守卫只执行 `parameters[*].codec.schema`。
 *
 * 登记条件：
 * - 方法已存在真实 `@Remote` 声明；
 * - 生成表里没有该方法；
 * - 参数 schema 与 `gateway-*.ts` 的签名逐字段一致。
 *
 * 生成器补上同名方法后，宿主最后一次合并生成表，同名条目以生成物为准；
 * 届时可删除这里的对应条目。
 */
import { z } from 'zod'

/** 与 Typert 调用表同形的最小参数部分（只保留守卫真正读取的字段）。 */
export interface RemoteArgSchemaOverlayEntry {
  method: string
  parameters: Array<{
    codec: {
      mode: 'strict'
      schema: unknown
    }
  }>
}

/**
 * 生成表缺口（2026-10-22）。
 *
 * 四个方法都已有真实 `@Remote` 声明，但不在 `typert.host.js` 的 invocation 表中：
 * - `getSelfProfile` / `listRpaVendors`：零参数；
 * - `getFileImageDataUrls`：批量文件图片，`keys` 必填、`thumbFirst` 可选；
 * - `revealTaskTriggerSecret`：任务 id 必填。
 */
export const REMOTE_ARG_SCHEMA_OVERLAY: readonly RemoteArgSchemaOverlayEntry[] = [
  {
    method: 'getSelfProfile',
    parameters: [],
  },
  {
    method: 'listRpaVendors',
    parameters: [],
  },
  {
    method: 'getFileImageDataUrls',
    parameters: [{
      codec: {
        mode: 'strict',
        schema: z.object({
          keys: z.array(z.string()),
          thumbFirst: z.boolean().optional(),
        }),
      },
    }],
  },
  {
    method: 'revealTaskTriggerSecret',
    parameters: [{
      codec: {
        mode: 'strict',
        schema: z.object({
          id: z.number(),
        }),
      },
    }],
  },
]
