/**
 * 本库向量索引的**构建整块**（W3-11.5 从 createKbRemotes 里搬出）。
 *
 * 搬家的原因与 `remotes/ask-cancel.ts` 同族：`createKbRemotes` 受函数体棘轮管着
 * （`function-size-ratchet.spec.ts` 只许变小），而进度/取消这套件加进来之后它会长回 34 行。
 * 抽成模块级函数之后两头都短，且「进度怎么发、取消怎么停」可以单独读。
 *
 * 两条口径写在这里而不是散在调用点：
 *   · **进度有两条通道** —— 轮询用的 job 槽（别处触发的构建也看得见，原语义）
 *     与 `kb-index/progress` 事件（本面板发起的那次有即时读数，80ms 节流）；
 *   · **取消记 skip 不记 fail** —— 两阶段构建的阶段二在全部批次之后，取消 ⇒ 一行未写，
 *     旧索引原样。「已停止」不是失败。
 */
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { buildKbVectorIndex } from '../query/kb-vectors.ts'
import { KbVectorBuildWireResult } from '../types-kb-wire.ts'
import type { KbRemoteCtx } from './kb.ts'

export async function kbBuildIndexIn(
  rc: KbRemoteCtx,
  options: { kbId: number; force?: boolean; jobId?: string },
): Promise<KbVectorBuildWireResult> {
  const dir = rc.dirs().decrypted
  const kbId = Number(options?.kbId)
  if (!Number.isFinite(kbId) || kbId <= 0) {
    return { ok: false, error: '没有指定知识库', status: 'bad-kb', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0 }
  }
  const cfg = loadRetrievalConfig(dir)
  // 按库解析：这个按钮建的**就是这个库**的索引，模型名也要跟着这个库的覆盖走。
  const model = rc.kbModel(kbId, 'embed').model
  const embed = model === '' ? undefined : rc.makeEmbedFn(model, 'kb_embed')
  if (!embed) {
    const msg = '未配置向量模型（在「数据配置 → AI 大模型」里填写向量模型名与端点）'
    rc.op('task', 'kb_embed', 'fail', `kb=${kbId}`, msg)
    return { ok: false, error: msg, status: 'no-embedder', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0 }
  }
  const job = { done: 0, total: 0, startedAt: Date.now(), error: '' }
  rc.kbIndexJobs.set(kbId, job)
  // 取消槽由 gateway 持有（与消息域的构建各占一格，互相不会打断）。
  const ctl = rc.kbIndexSignal(options?.jobId)
  // kb.ts 的 ctx 是**完整** Cordis Context（这里还用它做别的事），所以不能像
  // laya/graphsearch 那样把字段收窄成 `{ emit }`；这里就地收窄这一次调用。
  const emit = rc.ctx.emit as (name: string, ...args: unknown[]) => void
  let lastAt = 0
  const onProgress = (done: number, total: number): void => {
    job.done = done
    job.total = total
    if (ctl === undefined) return
    const now = Date.now()
    if (done < total && now - lastAt < 80) return
    lastAt = now
    try { emit('kb-index/progress', { jobId: options.jobId, done, total }) } catch { /* 事件 best-effort，绝不影响构建 */ }
  }
  try {
    const built = await buildKbVectorIndex(dir, kbId, embed, {
      model,
      batchSize: cfg.embedding.batchSize,
      concurrency: cfg.embedding.concurrency,
      maxCharsPerDoc: cfg.embedding.maxCharsPerDoc,
      maxDocsPerBuild: cfg.embedding.maxDocsPerBuild,
      force: Boolean(options?.force),
      onProgress,
      ...(ctl ? { signal: ctl.signal } : {}),
    })
    rc.op('task', 'kb_embed', built.status === 'ok' ? 'ok' : 'skip', `kb=${kbId}`,
      built.status === 'cancelled'
        ? '已停止构建（旧索引未动）'
        : `${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms · ${model}`)
    return { ...built, ok: built.status !== 'cancelled' }
  } catch (e) {
    job.error = (e as Error).message
    rc.op('task', 'kb_embed', 'fail', `kb=${kbId}`, job.error)
    return { ok: false, error: job.error, status: 'failed', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: Date.now() - job.startedAt }
  } finally {
    ctl?.done()
    // 进度槽留一小会儿再清：界面轮询间隔内还要能看见「刚跑完」的结果，直接删会让按钮闪回常态。
    const t = setTimeout(() => { if (rc.kbIndexJobs.get(kbId) === job) rc.kbIndexJobs.delete(kbId) }, 3000)
    if (typeof t.unref === 'function') t.unref()
  }
}
