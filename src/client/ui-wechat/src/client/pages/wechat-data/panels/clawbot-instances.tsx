/**
 * ClawBot 多实例的**缺省规则真源**（2026-10-13）。
 *
 * C3 拆解记录：原 `ClawbotInstancesCard`（列出全部实例 + 行内配置 + 增删 + 绑定入口）已退役 ——
 * 导航进 `clawbot-rail.tsx`（实例轨）、行为配置进 `clawbot-settings.tsx` 的行为卡、
 * 删除进当前实例卡的危险区、绑定入口进轨上行内。拆掉它是因为「当前实例的状态 / wxid /
 * 今日 / 累计 / 通道」在绑定卡与实例卡里**显示两遍**（P3），且行内改别的号的配置正是
 * 本卡自己注释里承认的隐患（「用户改完实例 2 的开关再切回设置，会以为改的是列表第一条」）。
 *
 * 本文件只留一件事：**缺省要操作哪个实例**的规则。它与后端 `resolveClawbotSlot`
 * （`query/clawbot/clawbot-instance.ts`）必须一致 —— 两边各写一套的结果是「面板显示 A 号、实际读写 B 号」。
 *
 * @module panels/clawbot-instances
 */
import type { ClawbotInstance } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * 缺省要操作哪个实例：**第一个已绑定实例，其次第一个实例**；一个都没有 ⇒ null。
 * @param instances - 实例列表（按 slot 升序）。
 * @returns 缺省实例编号；列表为空时 null。
 */
export function pickDefaultSlot(instances: readonly ClawbotInstance[]): number | null {
  const bound = instances.find((i) => i.status === 'bound') ?? instances[0]
  return bound === undefined ? null : bound.slot
}
