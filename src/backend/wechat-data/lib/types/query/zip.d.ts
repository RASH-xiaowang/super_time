/**
 * 整块 CRC32（导出/测试用来校验归档里的条目）。
 * @param buf - 待计算的数据。
 * @returns CRC32 值。
 */
export declare function crc32(buf: Buffer): number;
/**
 * 进度事件（导出/备份这类长耗时环节共用）。
 *
 * `total = 0` 表示总量未知 —— 只有流式环节才会这样（压缩/写盘过程中算不出总字节数），
 * 调用方据此显示「不定量进度」而不是把它当成 0%。
 */
export interface StreamProgress {
    /** 阶段标识：collect | sessions | format | compress | write | media | files。 */
    phase: string;
    /** 已完成量（条/行/字节，按 phase 而定）。 */
    done: number;
    /** 总量；0 = 未知。 */
    total: number;
}
/** 导出/备份入口的可选控制参数：进度上报 + 取消。 */
export interface StreamControl {
    onProgress?: (p: StreamProgress) => void;
    /** 取消令牌；aborted 后各入口会尽快中止并清理半成品。 */
    signal?: AbortSignal;
}
/**
 * 取消（与普通失败区分：调用方据此决定「用户取消」不该弹错误框）。
 * `name` 用 'AbortError' 与平台惯例一致。
 */
export declare class CancelledError extends Error {
    constructor(message?: string);
}
/**
 * 已取消就抛错（在各耗时循环的边界调用）。
 * @param signal - 取消令牌。
 */
export declare function throwIfCancelled(signal?: AbortSignal): void;
/**
 * 上报一次进度。
 *
 * 回调由调用方（RPC 层/前端）提供，**它自己抛错不该让导出失败** —— 否则前端一个
 * 进度条 bug 就能把用户的导出搞挂；事件尽力而为（与 gateway 的 delta 推送同策略）。
 * @param ctrl - 控制参数（可缺省）。
 * @param phase - 阶段标识。
 * @param done - 已完成量。
 * @param total - 总量（0 = 未知）。
 */
export declare function reportProgress(ctrl: StreamControl | undefined, phase: string, done: number, total: number): void;
export declare function partialPath(filePath: string): string;
/** Build a ZIP archive from named entries (string or bytes payloads). */
export declare function zipFiles(entries: Array<{
    name: string;
    data: string | Uint8Array;
}>): Buffer;
/**
 * 带背压与错误传播的文件沉降层。
 *
 * 为什么单独抽一层：ZIP 条目与加密备份（.wcb）都要「大块流式写文件 + 失败即中断 +
 * 不留半成品」，而这套写法被评审实测踩出两个坑（`drain` 掩盖 `error` 导致永久挂起、
 * `once()` 监听器累积）。复制第二份等于把坑复制第二份，所以两处共用这一份实现。
 */
export declare class StreamWriter {
    private readonly out;
    private readonly filePath;
    private offsetValue;
    private closedFlag;
    private abortedFlag;
    /** 写流报出的错误（见 write() 里「drain 掩盖 error」的说明）。 */
    private streamError;
    private constructor();
    /** 打开目标文件准备写入（覆盖已有文件）。 */
    static create(filePath: string): Promise<StreamWriter>;
    /** 已写入的字节数。 */
    get offset(): number;
    /** 是否已正常收尾（end 之后 abort 是空操作）。 */
    get closed(): boolean;
    /** 是否已中止。 */
    get aborted(): boolean;
    /** 写流报出的错误（尚未抛出时调用方用它提前失败，而不是等一次写入再失败）。 */
    get failed(): Error | null;
    /** 写流上的监听器总数（诊断用：背压等待不应累积监听器）。 */
    get listenerCount(): number;
    /**
     * 底层写入：更新偏移量并等待背压。
     *
     * 这里有个坑（评审实测出来的）：写流出错时（例如 ENOSPC）Node 会先 emit `drain`
     * 再 emit `error`。若只写 `if (!write()) await once('drain')`，那次 drain 会把
     * 挂起的等待**当成成功**放行，而流其实已经毁了 —— 之后每次 write() 都返回 false
     * 且再也不会有 drain，于是**永久挂起**：用户看不到报错、RPC 一直等到超时、
     * 临时文件也不会被清理。所以要同时等 drain 与 close/error，并在事后复查标志位。
     */
    write(buf: Buffer): Promise<void>;
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
     * 收尾并关闭文件。
     *
     * 用 `finished()` 而不是 `once('close')`：后者对流**已经关闭**的情况会永远等下去。
     */
    end(): Promise<void>;
    /**
     * 中止：关流并删除半成品文件（失败路径必须调用，否则留下截断的文件）。
     *
     * 幂等；对已收尾的写入是**空操作** —— 否则出错后的 catch 会把一个已经成功
     * 落盘的文件删掉（评审实测复现过：close 之后再 abort，成品被 DELETED）。
     */
    abort(): Promise<void>;
}
/**
 * 逐条目写盘的 ZIP 写入器。
 *
 * 生命周期：`create()` → 若干 `addFile()`/`addStream()` → `close()`；任一步出错就
 * `abort()`（它会关流并删掉半成品文件，避免留下一个看起来完整、实际截断的归档）。
 */
export declare class ZipFileWriter {
    private readonly sink;
    private readonly filePath;
    private readonly centrals;
    private readonly names;
    private readonly entryTemps;
    private entrySeq;
    private closed;
    private constructor();
    /** 打开目标文件准备写入（覆盖已有文件）。 */
    static create(filePath: string): Promise<ZipFileWriter>;
    /** 当前写入偏移（中央目录里要记每个条目的起始位置）。 */
    private get offset();
    /** 诊断：写流上的监听器总数。背压等待不应累积监听器（曾经的泄漏点）。 */
    get listenerCount(): number;
    private write;
    /**
     * 追加一个条目。
     * @param name - 归档内路径（反斜杠会转成正斜杠）。
     * @param data - 字符串（UTF-8）或字节。
     * @returns 是否真的写入（同名条目会被跳过，与 zipFiles 行为一致）。
     */
    addFile(name: string, data: string | Uint8Array): Promise<boolean>;
    /**
     * 追加一个「内容现场产出」的条目：分块做流式 deflate。
     *
     * 为什么需要它：`addFile` 要求整条内容的字节都在内存里（`deflateRawSync` 也要整块输入），
     * 所以 10 万行的 xlsx（sheet XML ≈ 10MB 以上、还要再叠上所有行数组）峰值仍与行数线性。
     * 这里把产出方给的分块**先流式压到临时文件**，拿到真实的 CRC/长度后再补本地头、
     * 分块拷进归档 —— 峰值只与「一块」相关，与条目总大小无关。
     *
     * 为什么不直接用 data descriptor 边压边写：那会改动归档格式（本地头里长度写 0 +
     * 置 bit 3），而 `zipFiles`/`addFile` 产出的格式不能被悄悄换掉。多一次磁盘往返
     * 只发生在流式条目上，换的是「格式不变」。
     *
     * @param name - 归档内路径（反斜杠会转成正斜杠）。
     * @param source - 分块源（字符串按 UTF-8，或字节）；可为同步/异步迭代器。
     * @param ctrl - 可选的进度/取消（每块都会检查取消）。
     * @returns 是否真的写入（同名条目会被跳过，与 zipFiles 行为一致）。
     */
    addStream(name: string, source: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>, ctrl?: StreamControl): Promise<boolean>;
    /**
     * 写中央目录与 EOCD 并关闭文件。
     *
     * 非 ZIP64：偏移或长度超过 4GiB 时明确报错，而不是产出一个损坏的归档。
     */
    close(): Promise<void>;
    /**
     * 中止：关流并删除半成品文件（失败路径必须调用，否则留下截断的归档）。
     *
     * 幂等；对已 close 的归档是**空操作** —— 否则出错后的 catch 会把一个已经成功
     * 落盘的归档删掉（评审实测复现过：close 之后再 abort，文件被 DELETED）。
     */
    abort(): Promise<void>;
}
