/**
 * 可取消任务的「取号 / 取消」原语（#20 第六个协作者）。
 *
 * 五类任务（搜索、问答、逐条分析、搜索索引、知识库向量构建）与模型下载都只有两件事：
 * 给一个 jobId 发一把新的 AbortController，以及用 jobId 找到并打断那一把控制器。
 * 原先这两件事在 `GatewayCore` 里重复了六遍。重复不是坏在行数，而是每遍都必须再次写对
 * 「只删自己那把令牌」这条规则：先取消、再复用同一个 jobId 时，旧控制器的 `done()` 若把
 * 新控制器从槽表里删掉，取消就会永久失手。
 *
 * 槽表仍由网关持有：各任务之间必须互相隔离（搜索与索引构建会同时在跑），
 * 本模块只操作调用方传来的那张表，不另起一份状态。
 */
import { normalizeJobId } from './gateway-support.ts'

/** 一张可取消任务的令牌槽表。 */
export type AbortJobSlots = Map<string, AbortController>

/** 一个可取消任务的信号与归还把手。 */
export interface AbortJobSignal {
  signal: AbortSignal
  done: () => void
}

/**
 * 为一个 jobId 取（新建）一把取消信号。
 *
 * @param jobs - 网关持有的槽表。
 * @param jobId - 渲染层生成的任务标识；缺省/空白时返回 undefined（旧调用方不可取消）。
 * @returns 新的信号与归还函数；归还只在槽表里仍是自己那把控制器时才删除，
 *   避免先取消、再复用同一 jobId 的新令牌被旧任务收尾时误删。
 */
export function jobSignalFor(jobs: AbortJobSlots, jobId?: string): AbortJobSignal | undefined {
  const id = normalizeJobId(jobId)
  if (id === '') return undefined
  const ctrl = new AbortController()
  jobs.set(id, ctrl)
  return {
    signal: ctrl.signal,
    done: () => { if (jobs.get(id) === ctrl) jobs.delete(id) },
  }
}

/**
 * 打断一个还在槽表里的任务。
 *
 * @param jobs - 网关持有的槽表。
 * @param jobId - 要取消的任务标识；缺省/空白时返回 false。
 * @returns 是否真的找到了并打断了那一把控制器。找不到时返回 false，
 *   让调用方给用户一个可读的「已结束或标识不认识」，而不是静默成功。
 */
export function cancelJobIn(jobs: AbortJobSlots, jobId?: string): boolean {
  const id = normalizeJobId(jobId)
  if (id === '') return false
  const ctrl = jobs.get(id)
  if (!ctrl) return false
  ctrl.abort()
  return true
}
