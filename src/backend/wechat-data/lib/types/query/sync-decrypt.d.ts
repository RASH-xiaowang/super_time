/**
 * Stream-decrypt a whole SQLCipher database to a plain SQLite file.
 * Chunked（64 页/步）以在单线程 worker 上让出事件循环；一次 200MB+ 的分片不会卡死面板查询。
 * @param dbPath - encrypted source database path.
 * @param outPath - plain SQLite output path.
 * @param encKey - derived 32-byte AES-256 key.
 * @returns the number of pages decrypted.
 */
export declare function fullDecryptFile(dbPath: string, outPath: string, encKey: Buffer): Promise<number>;
