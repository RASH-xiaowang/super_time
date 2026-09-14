/** Storage category aggregate (label + count + size). */
export interface StorageCategory {
    label: string;
    count: number;
    size: number;
}
/** Storage rank entry (chat or sender: username + display name + count + size). */
export interface StorageRank {
    username: string;
    name: string;
    count: number;
    size: number;
}
/** One large file entry (name + owning session + size). */
export interface LargeFile {
    name: string;
    username: string;
    sessionName: string;
    create_time: number;
    size: number;
}
/**
 * Aggregate storage stats (source collect_stats).
 * @param decryptedDir - decrypted data root.
 * @param wechatBaseDir - raw WeChat install root (msg/file 原文件名还原).
 * @returns the storage snapshot.
 */
export declare function queryStorageStats(decryptedDir: string, wechatBaseDir?: string): {
    total_size: number;
    total_count: number;
    categories: StorageCategory[];
    chats: StorageRank[];
    senders: StorageRank[];
    large_files: LargeFile[];
};
