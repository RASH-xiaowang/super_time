/** 任务中心/消息列表共用的库文件名。 */
export declare const TASK_DB_FILE = "wechat_task_center.db";
/** 库路径（`decryptedDir` 的父目录下，与待办/摘要等同族）。 */
export declare function taskDbPath(decryptedDir: string): string;
/** 库是否存在（区分「确实还没有数据」与「库打不开」）。 */
export declare function taskStoreExists(decryptedDir: string): boolean;
/** 兼容旧调用点的短名字（任务中心与消息列表都在用）。 */
export declare const storeExists: typeof taskStoreExists;
