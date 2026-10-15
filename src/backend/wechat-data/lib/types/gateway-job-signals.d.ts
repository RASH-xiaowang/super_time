/** 一张可取消任务的令牌槽表。 */
export type AbortJobSlots = Map<string, AbortController>;
/** 一个可取消任务的信号与归还把手。 */
export interface AbortJobSignal {
    signal: AbortSignal;
    done: () => void;
}
/**
 * 为一个 jobId 取（新建）一把取消信号。
 *
 * @param jobs - 网关持有的槽表。
 * @param jobId - 渲染层生成的任务标识；缺省/空白时返回 undefined（旧调用方不可取消）。
 * @returns 新的信号与归还函数；归还只在槽表里仍是自己那把控制器时才删除，
 *   避免先取消、再复用同一 jobId 的新令牌被旧任务收尾时误删。
 */
export declare function jobSignalFor(jobs: AbortJobSlots, jobId?: string): AbortJobSignal | undefined;
/**
 * 打断一个还在槽表里的任务。
 *
 * @param jobs - 网关持有的槽表。
 * @param jobId - 要取消的任务标识；缺省/空白时返回 false。
 * @returns 是否真的找到了并打断了那一把控制器。找不到时返回 false，
 *   让调用方给用户一个可读的「已结束或标识不认识」，而不是静默成功。
 */
export declare function cancelJobIn(jobs: AbortJobSlots, jobId?: string): boolean;
