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
import type { KbRemoteCtx } from './kb.ts';
/** 同一库两次自动索引之间的最小间隔（毫秒）。 */
export declare const AUTO_INDEX_MIN_GAP_MS = 30000;
/** 仅供测试：清掉节流记录。 */
export declare function resetAutoIndexThrottle(): void;
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
export declare function shouldAutoIndex(rc: KbRemoteCtx, kbId: number, now?: number): boolean;
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
export declare function afterKbFilesAdded(rc: KbRemoteCtx, kbId: number, hasQueued: boolean): void;
/**
 * 安排一次**后台**自动索引。失败只记日志，绝不冒泡到上传路径。
 *
 * @param rc - 远程上下文。
 * @param kbId - 目标库。
 * @param reason - 触发来源（只用于日志与操作记录，便于排查"谁让它跑的"）。
 * @param now - 当前时刻（测试可注入，与 {@link shouldAutoIndex} 同一时钟）。
 */
export declare function scheduleKbAutoIndex(rc: KbRemoteCtx, kbId: number, reason: string, now?: number): void;
