/**
 * 问答引用的共享纯类型契约。
 *
 * 原定义住在 `types-ask-export.ts`（胶水层）；ClawBot 查询层需要同一形状的引用，
 * 但不能反向依赖胶水层，因此把声明下沉到 query 层，原模块继续原路径转发。
 *
 * @module query/ask-citation-types
 */
import type { EvidenceLocator } from './answer-runtime/evidence.ts';
/**
 * One citation (source message) for an Ask answer.
 *
 * `username` / `local_id` / `time` 构成「引用 → 原文」的可定位性；知识库来源
 * 必须靠 `source` 与 `kb` 判别，不能只把消息字段填空混进来。
 */
export interface AskCitation {
    name: string;
    time: string;
    snippet: string;
    username: string;
    local_id: number;
    /** 在本轮引用列表里的 1 基序号（运行时链路提供）。 */
    index?: number;
    /** 稳定证据 ID（消息 `msg:<username>:<localId>` / 知识库 `kb:<kbId>:<chunkId>`）。 */
    evidenceId?: string;
    /** 可点击回原文、文件或资源的定位信息。 */
    locator?: EvidenceLocator;
    /** 群聊里这条消息的发送者显示名（单聊为空）。 */
    sender?: string;
    /** 来源域：消息（缺省）、知识库、聚合事实或资源。 */
    source?: 'msg' | 'kb' | 'agg' | 'resource';
    /** 知识库来源专有信息（`source === 'kb'` 时存在）。 */
    kb?: {
        kbId: number;
        fileId: number;
        fileName: string;
        /** 小写扩展名（不含点）。 */
        fileExt: string;
        chunkId: number;
        /** 块在文件内的序号（0 基）。 */
        ordinal: number;
        /** 页码（1 基）；非分页形态为 0。 */
        page: number;
        /** 面包屑（`H1 › H2`）；无标题时为空串。 */
        heading: string;
    };
}
