import type { PendingDispatchResult } from '../query/task-center.ts';
import type { RetryFetch } from '../net/fetch-retry.ts';
import type { TaskCallbackDispatchResult, TaskInfoInput, TaskInfoMutationResult, TaskInfoSnapshot, TaskInfoStatus, TaskTriggerQuery, TaskTriggerScanResult, TaskTriggerSnapshot } from '../types.ts';
import type { OperationCategory, OperationStatus } from '../types.ts';
/** 网关侧注入的图片解码上下文（每次调用现取：用户可能在运行中换账号/换密钥）。 */
export interface TaskCenterImageContext {
    /** 微信账号根目录（解密原始图片用）；空 = 只读已解码缓存。 */
    wechatBaseDir?: string;
    aesKey?: string;
    xorKey: number;
}
export interface createTaskCenterRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    /** 登录账号 wxid（扫描的单聊「对方」判定 + 水位初始化）。 */
    selfUsername: () => string;
    /** 隐私闸：脱敏 + 审计（回调文本发出去前必须过）。 */
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    /** 图片解码所需的本机上下文（网关侧用 `rawWechatBase` + `resolveImageKeyPair` 组装）。 */
    imageContext: () => TaskCenterImageContext;
    /** 测试注入的 fetch；生产省略 = 全局 fetch。 */
    fetchImpl?: RetryFetch;
}
export declare function createTaskCenterRemotes(rc: createTaskCenterRemotesInputs): {
    listTaskInfos(): TaskInfoSnapshot;
    saveTaskInfo(options: TaskInfoInput): TaskInfoMutationResult;
    deleteTaskInfo(options: {
        id: number;
    }): TaskInfoMutationResult;
    setTaskInfoStatus(options: {
        id: number;
        status: TaskInfoStatus;
    }): TaskInfoMutationResult;
    listTaskTriggers(options?: TaskTriggerQuery): TaskTriggerSnapshot;
    /** 面板「立即检查」与后台定时器共用：扫描 + 顺手投递待发回调。 */
    scanTaskTriggers(): Promise<TaskTriggerScanResult>;
    scanAndDispatch: () => Promise<TaskTriggerScanResult>;
    scanOnce: () => TaskTriggerScanResult;
    dispatchPending: () => Promise<PendingDispatchResult>;
    dispatchTaskCallback(options: {
        triggerId: number;
    }): Promise<TaskCallbackDispatchResult>;
};
