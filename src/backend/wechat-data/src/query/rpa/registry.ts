/**
 * 多厂商触发的**唯一注册表**（2026-10-21）。
 *
 * 新增一个厂商 = 在 `vendors/` 加一个文件 + 在本文件数组里加一行 import；
 * 核心管道、存储、Remote、前端 UI 都不需要改（见 `docs/RPA-VENDOR-TRIGGERS.md` §4.7）。
 *
 * 顺序即 UI 展顺序：内置 `webhook` / `bazhuayu` 在前，其后是外部 RPA 厂商。
 * `RPA_REGISTRY_VERSION` 是**注册表本身**的版本（用于核对目录快照），与各厂商
 * `descriptor.version`（参数/协议版本）分开维护。
 */
import type { RpaVendorAdapter } from './types.ts'
import type { RpaVendorDescriptor } from '../../types-rpa.ts'
import { adapter as webhook } from './vendors/webhook.ts'
import { adapter as bazhuayu } from './vendors/bazhuayu.ts'
import { adapter as bazhuayuMcp } from './vendors/bazhuayu-mcp.ts'
import { adapter as yingdao } from './vendors/yingdao.ts'
import { adapter as uipath } from './vendors/uipath.ts'
import { adapter as aliyunRpa } from './vendors/aliyun-rpa.ts'
import { adapter as laiye } from './vendors/laiye.ts'
import { adapter as shizai } from './vendors/shizai.ts'

/** 内置 + 外部厂商适配器（顺序即 `listRpaVendors` / UI 顺序）。 */
export const RPA_VENDORS: RpaVendorAdapter[] = [
  webhook,
  bazhuayu,
  bazhuayuMcp,
  yingdao,
  uipath,
  aliyunRpa,
  laiye,
  shizai,
]

/** id → 适配器（重复 id 是契约错误，由 `rpa-vendors.contract.spec.ts` 守）。 */
export const RPA_VENDOR_MAP: ReadonlyMap<string, RpaVendorAdapter> = new Map(
  RPA_VENDORS.map((adapter) => [adapter.descriptor.id, adapter]),
)

/** 注册表版本（目录结构的版本，不是某家厂商的参数版本）。 */
export const RPA_REGISTRY_VERSION = '2026-10-21'

/**
 * 按 id 找厂商适配器。
 * @param id - 触发方式 id（`webhook` 或厂商 id）。
 * @returns 适配器；未注册/已停用返回 undefined（调用方 skipped 并给可读原因）。
 */
export function findVendor(id: string): RpaVendorAdapter | undefined {
  if (typeof id !== 'string' || id === '') return undefined
  return RPA_VENDOR_MAP.get(id)
}

/**
 * 可序列化的厂商目录（`listRpaVendors` 的返回值）。
 *
 * 用 JSON 深拷贝而不是直接返回 descriptor：Remote 层要保证返回值只含可序列化数据
 * （钩子函数不在 descriptor 里，但拷贝能防止调用方改到注册表）。
 * @returns 描述符副本数组（顺序与 {@link RPA_VENDORS} 一致）。
 */
export function listVendorDescriptors(): RpaVendorDescriptor[] {
  return RPA_VENDORS.map((adapter) => JSON.parse(JSON.stringify(adapter.descriptor)) as RpaVendorDescriptor)
}
