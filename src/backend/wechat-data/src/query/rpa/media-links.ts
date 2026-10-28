/**
 * 触发图片 → **短时签名直链**（2026-10-23）。
 *
 * ## 为什么需要这一层
 *
 * Webhook 能把图片字节直接带在请求里（data URL / multipart），RPA 厂商不行：它们的触发
 * 接口只有字符串参数（八爪鱼 `params`、影刀 `params[].value`、UiPath `InputArguments`、
 * 来也 `parameters`、实在 `inputParam`），参数上限 8KB–40KB —— base64 一张手机照片就是
 * 几 MB，塞进去必然被截断或直接报错。所以这一侧改发**链接**：后端给每张图片签一个
 * 短时令牌（算法见 `net/rpa-media.ts`，与宿主层共用同一份实现），参数里只出现
 * `http://<可达地址>:<端口>/api/rpa-media/<token>`。
 *
 * ## 时序与失败方向
 *
 * 参数解析（`template.ts#resolveParamSourceValue`）是**同步**的，而解码图片是异步的，
 * 所以链接在投递前由 `task-center-callback.ts` 一次性算好，放进 `ctx.imageLinks`。
 * 单张失败（解不出来 / 没启用局域网访问 / 路径越界）只给那一张写 `error`，
 * **不让整条投递失败** —— 用户至少还能拿到会话名与触发文本，并在记录里看出哪张没带上。
 *
 * @module query/rpa/media-links
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeRpaMediaRel } from '../../net/rpa-media.ts'
import type { RpaBuildDeps, RpaImageLink, RpaRecordContext } from './types.ts'
import type { RpaParamSource, RpaTriggerConfig, RpaVendorDescriptor } from '../../types-rpa.ts'

/** 单条失败原因的落库/上报上限（与 Webhook 适配器同口径）。 */
const ERROR_TEXT_MAX = 500

/** 没有注入图片链接工厂时的说明（测试与「局域网访问没开」之外的调用路径）。 */
const NO_FACTORY_ERROR = '未生成图片链接：本机未打开局域网访问（设置 → 维护与自检 → 局域网访问）'

/**
 * 生成一个签名直链。
 *
 * 由装配层（`remotes/task-center.ts`）按当前配置构造：读 `api_token` 派生密钥、挑一个
 * 可达基址、拼出 URL。**不抛异常**：拿不到地址时返回 `{ error }`，由调用方写进那一张图片。
 * @param rel - decoded 根内的相对路径（调用方已过 `isSafeRpaMediaRel`）。
 * @returns 成功时 `{ url }`；不可用时 `{ error }`。
 */
export type RpaMediaLinkFactory = (rel: string) => { url: string } | { error: string }

/** 真正需要生成直链的参数值来源（`imageCount` 只数引用，不需要解码）。 */
const IMAGE_LINK_PARAM_SOURCES: ReadonlySet<string> = new Set<RpaParamSource>([
  'imagesJson', 'firstImageUrl',
])

/**
 * 这次投递的参数里有没有需要签名直链的来源（`imagesJson` / `firstImageUrl`）。
 *
 * 投递前用它决定要不要解码图片并签直链：没用到图片的任务（绝大多数）不该为此付
 * 解码 + 落盘的代价，也不该在没打开局域网访问时平白多出一条错误。`imageCount`
 * 刻意**不在这里**：它只取 `record.images.length`，既不需要解码，也不需要监听面。
 * 判定按**原始配置**走（`extrasField` 的缺省值是空列表，不需要先合并默认值）。
 * @param descriptor - 厂商描述符。
 * @param config - 任务配置（`triggerConfig`）。
 * @returns 用到需要直链的来源时为 true。
 */
export function usesImageParamSources(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig): boolean {
  const extrasField = descriptor.mapping.extrasField
  if (extrasField === undefined) return false
  const raw = config[extrasField]
  if (!Array.isArray(raw)) return false
  return raw.some((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const source = (entry as unknown as Record<string, unknown>)['source']
    return typeof source === 'string' && IMAGE_LINK_PARAM_SOURCES.has(source)
  })
}

/** 统一把异常转成可读文本（未知值走 String），并截到落库上限。 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, ERROR_TEXT_MAX)
}

/**
 * 逐张生成投递形态的图片条目（与 `record.images` 顺序一一对应）。
 *
 * 用 `fileOnly` 解码：链接只能指向**磁盘上真实存在的文件**，所以拿不到文件路径就如实写
 * `error`，不回退成 data URL（那等于又回到 base64，与这一层的目的相反）。
 * @param record - 触发记录快照（含图片引用清单）。
 * @param deps - 解码依赖（解码缓存根 + 解码函数）。
 * @param media - 链接工厂；缺省时每张都写「未打开局域网访问」。
 * @returns 与 `record.images` 等长的条目数组。
 */
export async function buildRpaImageLinks(
  record: RpaRecordContext,
  deps: RpaBuildDeps,
  media?: RpaMediaLinkFactory,
): Promise<RpaImageLink[]> {
  const out: RpaImageLink[] = []
  for (const image of record.images) {
    const item: RpaImageLink = {
      localId: image.localId,
      createTime: image.createTime,
      sender: image.sender,
    }
    if (image.md5 !== undefined) item.md5 = image.md5
    try {
      const decoded = await deps.decodeImage(record.username, image.localId, { fileOnly: true })
      const file = typeof decoded.file === 'string' ? decoded.file : ''
      if (file === '') {
        item.error = '图片解码失败'
      } else if (!isSafeRpaMediaRel(file)) {
        item.error = '图片路径超出解码目录，已省略'
      } else {
        const link = media === undefined ? { error: NO_FACTORY_ERROR } : media(file)
        if ('url' in link) item.url = link.url
        else item.error = link.error.slice(0, ERROR_TEXT_MAX)
        if (item.error === undefined && !(await fileExists(join(deps.decodedDir, file)))) {
          // 链接指向的文件此刻不在（解码落盘失败/被清理）：如实写下来，别发一个取不到的地址。
          delete item.url
          item.error = '图片文件不在解码目录，已省略'
        }
      }
    } catch (error) {
      item.error = errorText(error)
    }
    out.push(item)
  }
  return out
}

/** 文件是否存在且是普通文件（读不到一律 false）。 */
async function fileExists(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile()
  } catch {
    return false
  }
}

/**
 * `imagesJson` 值来源的取值：整份图片清单的 JSON。
 *
 * 形状固定为 `[{localId, createTime, sender, md5?, url?, error?}]` —— 机器人侧按数组解析；
 * 没带上的那张在同一个数组里用 `error` 说明原因（不静默少一张，否则对端无从察觉）。
 * @param links - `buildRpaImageLinks` 的结果。
 * @returns JSON 字符串（空清单为 `[]`）。
 */
export function imagesJsonOf(links: readonly RpaImageLink[]): string {
  return JSON.stringify(links)
}

/**
 * `firstImageUrl` 值来源的取值：第一张**成功生成链接**的地址。
 *
 * 为什么不是「第一张的地址」：第一张可能解码失败，这时发空串比发一个取不到的地址更诚实
 * （单图工作流最常用这个来源）。一张都没成功时返回空串。
 * @param links - `buildRpaImageLinks` 的结果。
 * @returns 绝对 URL 或空串。
 */
export function firstImageUrlOf(links: readonly RpaImageLink[]): string {
  for (const link of links) {
    if (typeof link.url === 'string' && link.url !== '') return link.url
  }
  return ''
}
