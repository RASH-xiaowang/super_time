/** Build a ZIP archive from named entries (string or bytes payloads). */
export declare function zipFiles(entries: Array<{
    name: string;
    data: string | Uint8Array;
}>): Buffer;
/**
 * 逐条目写盘的 ZIP 写入器。
 *
 * 生命周期：`create()` → 若干 `addFile()` → `close()`；任一步出错就 `abort()`
 * （它会关流并删掉半成品文件，避免留下一个看起来完整、实际截断的归档）。
 */
export declare class ZipFileWriter {
    private readonly out;
    private readonly filePath;
    private offset;
    private readonly centrals;
    private readonly names;
    private closed;
    private aborted;
    /** 写流报出的错误（见 write() 里「drain 掩盖 error」的说明）。 */
    private streamError;
    private constructor();
    /** 打开目标文件准备写入（覆盖已有文件）。 */
    static create(filePath: string): Promise<ZipFileWriter>;
    /**
     * 底层写入：更新偏移量并等待背压。
     *
     * 这里有个坑（评审实测出来的）：写流出错时（例如 ENOSPC）Node 会先 emit `drain`
     * 再 emit `error`。若只写 `if (!write()) await once('drain')`，那次 drain 会把
     * 挂起的等待**当成成功**放行，而流其实已经毁了 —— 之后每次 write() 都返回 false
     * 且再也不会有 drain，于是**永久挂起**：用户看不到报错、RPC 一直等到超时、
     * 临时文件也不会被清理。所以要同时等 drain 与 close/error，并在事后复查标志位。
     */
    private write;
    /**
     * 等背压解除，或被 close/error 打断。
     *
     * 手写监听而不是 `Promise.race([once(...)])`：once() 不暴露它的监听器，
     * race 里没赢的那两个会永远挂着 —— 每次背压写入就多留 2 个监听器，
     * 长生命周期流上会累积到触发 `MaxListenersExceededWarning`
     * （评审实测 24 会话×3000 条就到 close 25 / error 50，1000 会话会到千级）。
     */
    private waitDrainOrDeath;
    /**
     * 追加一个条目。
     * @param name - 归档内路径（反斜杠会转成正斜杠）。
     * @param data - 字符串（UTF-8）或字节。
     * @returns 是否真的写入（同名条目会被跳过，与 zipFiles 行为一致）。
     */
    addFile(name: string, data: string | Uint8Array): Promise<boolean>;
    /**
     * 写中央目录与 EOCD 并关闭文件。
     *
     * 非 ZIP64：偏移或长度超过 4GiB 时明确报错，而不是产出一个损坏的归档。
     */
    /** 诊断：写流上的监听器总数。背压等待不应累积监听器（曾经的泄漏点）。 */
    get listenerCount(): number;
    close(): Promise<void>;
    /**
     * 中止：关流并删除半成品文件（失败路径必须调用，否则留下截断的归档）。
     *
     * 幂等；对已 close 的归档是**空操作** —— 否则出错后的 catch 会把一个已经成功
     * 落盘的归档删掉（评审实测复现过：close 之后再 abort，文件被 DELETED）。
     */
    abort(): Promise<void>;
}
