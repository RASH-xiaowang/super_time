/**
 * WechatDataGateway 方法面 · **数据库健康**（完整性体检 + 损坏修复）的转发（W3-11.7）。
 *
 * 为什么单独成环：数据/运维方法面已经按域切成 media / export / voice / config / laya
 * 多层壳，往其中一层加方法的代价不是这一处好看，是下一次任何改动都要先和结构边界
 * 打交道。而「体检 + 修复」本来就是自成一家的一族：两条方法、一个
 * 协作者槽（{@link GatewayDbHealth}）、消费方只有「数据健康中心」一个面板。
 * 本文件插在 `GatewayTaskCenter`（2026-10-19 新增的任务信息域）与 `GatewayClawbot` 之间，
 * 对外方法面逐名不变（`gateway-remote-surface.spec.ts` 守）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；处理器体在
 * `remotes/config.ts`（体检，纯读）与 `remotes/keysdec.ts`（修复，解密族）。
 */

import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { DbIntegrityResult, DbRepairResult } from './types.ts'
import { GatewayTaskCenter } from './gateway-taskcenter.ts'

/** 方法面的一层：继承链上的一环，不单独实例化。 */
export abstract class GatewayDbHealth extends GatewayTaskCenter {
  /**
   * 逐库完整性体检（`PRAGMA integrity_check`）—— 「库文件已损坏」那条处方
   * （`wechat-host.js` 的 READABLE_ERRORS）指向的检查。与 `getDbHealth` 的
   * 大小统计分开：后者被「原图链路自检」等面板启动时顺带读取，挂全库扫描
   * 会让每次挂载多几秒阻塞（并发纪律见 `query-yield-discipline.spec.ts`）。
   * @returns DbIntegrityResult: checked / corrupted（可重解密修复）/ unreadable（占用等）。
   */
  @Remote('checkDbIntegrity')
  async checkDbIntegrity(): Promise<DbIntegrityResult> {
    return this.configRemotes().checkDbIntegrity()
  }

  /**
   * 修复损坏的库：体检 → 只重解密损坏的那几个 → 复检（`query/db-repair.ts`）。
   * 与「立即解密」（`decryptAllDatabases`）的区别是**范围**：那个 22 个库一律
   * 重解（分钟级），这个只动坏的 —— 这正是那条处方里「必要时对该库重新解密」
   * 此前缺失的动作。实时进度走 `getDecryptStatus`（`op` = `databases`）。
   * @returns DbRepairResult: found / repaired / stillCorrupted + 修不了的与原因。
   */
  @Remote('repairCorruptDbs')
  async repairCorruptDbs(): Promise<DbRepairResult> {
    return this.keysDecryptRemotes().repairCorruptDbs()
  }
}
