/**
 * 启动时对快照根目录做一轮 WAL 对账：有效的合回主文件，无效的改名隔离，绝不盲删。
 *
 * 幂等：合回去/隔离掉的文件下一轮不再出现；单文件失败只记日志，不抛穿整轮。
 * @param root - 解密快照根目录（不存在或不可读时返回全 0，不抛错）。
 * @returns `checked` = 带非空 WAL、真正进入判断的库数；`checkpointed` = 成功合回主文件的库数；
 *   `quarantined` = WAL 被改名隔离的库数（`.superseded-wal` 的隔离不计入）。
 */
export declare function reconcileSnapshotWal(root: string): Promise<{
    checked: number;
    checkpointed: number;
    quarantined: number;
}>;
