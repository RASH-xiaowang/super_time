/**
 * 知识库**自动语义索引**（2026-11-20）。
 *
 * ## 解决什么疼点
 *
 * 改前：用户导入文件 → 解析完成 → 检索能用了，但**语义索引必须手动点**
 * 「文档工具 → 语义索引」。不点的话向量库是空的，`searchKbDense` 拿不到任何候选，
 * 于是「换个说法就搜不到」—— 而这正是用户眼里"这知识库不好用"的主因。
 *
 * 而这个动作**本来就不该由用户决定**：正文已经在库内、模型已经配置好，
 * 缺的只是一次出网调用。把它变成导入后的自动动作，是本次评估里
 * 「价值最高、风险最低」的一项。
 *
 * ## 三条硬约束
 *
 * 1. **不阻塞回执**：上传要立刻返回，索引在后台跑（`void` + 不 await）。
 * 2. **没配模型就静默跳过**：那种情况下用户仍能用关键词检索，弹一个"索引失败"
 *    只会制造焦虑。只有**真的开始构建**才写操作日志。
 * 3. **不重复触发**：同一库 30s 内只安排一次（翻页/多次上传会连着触发）；
 *    即便漏了这层，`buildKbVectorIndex` 内部也有同库在飞的合并。
 *
 * ## 为什么单独成模块
 *
 * `kb.ts` 的 `createKbRemotes` 受函数体棘轮管着（只许变小）。这里有两段判据
 * （模型是否可用、要不要跳过）与一段节流状态，塞进调用点会让 diff 难以复核。
 *
 * @module remotes/kb-auto-index
 */
import type { KbRemoteCtx } from './kb.ts'
import { kbBuildIndexIn } from './kb.kbindex.ts'
import { kbVectorIndexStatus } from '../query/kb-vectors.ts'
import { drainKbQueue } from '../query/kb-queue.ts'

/** 同一库两次自动索引之间的最小间隔（毫秒）。 */
export const AUTO_INDEX_MIN_GAP_MS = 30_000

/** 每个库上次自动索引的时刻（模块级：进程内共享，不落盘 —— 重启后再跑一次无害）。 */
const lastAutoIndexAt = new Map<number, number>()

/** 仅供测试：清掉节流记录。 */
export function resetAutoIndexThrottle(): void {
  lastAutoIndexAt.clear()
}

/**
 * 判断这个库现在**该不该**自动建语义索引。
 *
 * 三个条件缺一不可，且都必须是「静默跳过」而不是报错：
 * · 向量模型可用（没配就只能用关键词检索，这是既有且可接受的能力边界）；
 * · 索引尚未就绪，或存在未覆盖的块（`staleReason === 'incomplete'`；
 *   KB 域已有覆盖度判定，见 `kbVectorIndexStatus`）；
 * · 不在节流窗口内。
 * @param rc - 远程上下文。
 * @param kbId - 目标库。
 * @param now - 当前时刻（测试可注入）。
 * @returns `true` = 应当安排一次构建。
 */
export function shouldAutoIndex(rc: KbRemoteCtx, kbId: number, now = Date.now()): boolean {
  if (!Number.isFinite(kbId) || kbId <= 0) return false
  const last = lastAutoIndexAt.get(kbId) ?? 0
  if (now - last < AUTO_INDEX_MIN_GAP_MS) return false
  // 模型不可用 ⇒ 静默跳过（用户仍有关键词检索，不该被"索引失败"打扰）。
  const model = rc.kbModel(kbId, 'embed').model
  if (model === '') return false
  if (rc.makeEmbedFn(model, 'kb_embed') === undefined) return false
  try {
    const st = kbVectorIndexStatus(rc.dirs().decrypted, kbId, model)
    // 已就绪且覆盖完整 ⇒ 没有活要干。
    if (st.ready && st.staleReason !== 'incomplete') return false
    /*
     * `truncation-changed` 也要建：那批向量的正文被截断过（旧策略嵌前 200 字），
     * 不重算就一直是"内容不完整但看起来正常"的召回 —— 比没有索引更难发现。
     * 它自然满足上面的条件（staleReason 非空 ⇒ ready 为假），这一行只是把意图写明。
     */
    return true
  } catch {
    // 状态读不出来（库刚建/表缺失）⇒ 交给构建自己去判断，别在这里拦。
    return true
  }
}

/**
 * 导入完成后的**编排**：有排队解析的（PDF/Word/Excel）先等队列跑完再建索引；
 * 纯文本是同步解析的，直接建。
 *
 * 抽成函数而不是写在 `kb.ts` 里，是因为 `createKbRemotes` 受函数行数棘轮约束（只许变小），
 * 而这段是「等谁跑完再启动谁」的时序逻辑，单独读比夹在三十个 Remote 之间清楚。
 * @param rc - 远程上下文。
 * @param kbId - 目标库。
 * @param hasQueued - 本次是否有文件进了解析队列。
 */
export function afterKbFilesAdded(rc: KbRemoteCtx, kbId: number, hasQueued: boolean): void {
  /*
   * 延后到下一拍再启动构建（2026-11-20）。
   *
   * 两个理由：
   * ① 上传路径此刻可能还在写文件库（`addKbFiles` 返回给调用方的同一 tick），
   *    同一 tick 里再开一次写事务会增加 `database is locked` 的机会；
   * ② 让 `addKbFiles` 的返回值严格不受索引影响 —— 读路径/写路径都不该为派生数据让路。
   */
  const start = (): void => { scheduleKbAutoIndex(rc, kbId, '导入后') }
  if (!hasQueued) {
    setTimeout(start, 0)
    return
  }
  void drainKbQueue(rc.dirs().decrypted).then(
    (r) => { if (r.ready > 0) start() },
    (e: unknown) => { console.warn('[kb-queue] 解析队列启动异常：' + (e instanceof Error ? e.message : String(e))) },
  )
}

/**
 * 安排一次**后台**自动索引。失败只记日志，绝不冒泡到上传路径。
 *
 * @param rc - 远程上下文。
 * @param kbId - 目标库。
 * @param reason - 触发来源（只用于日志与操作记录，便于排查"谁让它跑的"）。
 * @param now - 当前时刻（测试可注入，与 {@link shouldAutoIndex} 同一时钟）。
 */
export function scheduleKbAutoIndex(rc: KbRemoteCtx, kbId: number, reason: string, now = Date.now()): void {
  if (!shouldAutoIndex(rc, kbId, now)) return
  lastAutoIndexAt.set(kbId, now)
  void kbBuildIndexIn(rc, { kbId }).then(
    (r) => {
      // 只有真的跑了才记一行：`no-embedder` 之类在 shouldAutoIndex 阶段已挡住。
      rc.op('task', 'kb_embed_auto', r.ok ? 'ok' : 'skip', `kb=${kbId}`,
        `${reason} · ${r.status} · ${r.rows} 条（本次 ${r.embedded}）`)
    },
    (e: unknown) => {
      console.warn('[kb-auto-index] 自动索引失败：' + (e instanceof Error ? e.message : String(e)))
    },
  )
}
