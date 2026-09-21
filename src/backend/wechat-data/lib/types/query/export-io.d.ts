/**
 * `query/export.ts` 的「落盘与上下文：原子写、zip 原子落地、data URL、导出上下文」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-io
 */
import { ZipFileWriter } from './zip.ts';
/** Decode a base64 data URL to bytes (returns null when not a base64 data URL). */
/**
 * moments 打包的媒体条目上限。
 *
 * 与改造前保持一致：旧代码是「push 之后判断 `entries.length > 5000` 才 break」，
 * 而 entries 里第一个是 moments.json，所以媒体最多 5000 条。
 * 初版流式改造写成 `>= 4999`，饱和时会少导一条（评审复刻两循环实测出来的 off-by-one）。
 */
export declare const MAX_MOMENT_MEDIA = 5000;
/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 直接 writeFileSync 到目标路径时，中途失败（磁盘满、进程被杀、超时被掐）会留下一个
 * **看起来正常、实际截断**的导出文件 —— 比没有产出更糟，因为用户会以为导出成功了。
 * 同目录 rename 在 Windows 上同样是原子的（同一卷内不发生拷贝）。
 */
export declare function writeFileAtomicSync(filePath: string, data: string | Uint8Array): void;
/**
 * 流式产出一个 ZIP 并原子落地。
 *
 * 与单文件版同理，但内容由 `produce` 现场逐条写入 —— 峰值内存只与**单个条目**相关，
 * 而不是所有条目之和（整账号归档最多 1000 个会话，原先会把全部文本堆在内存里）。
 * 每条写入都会 await 背压，因此也把事件循环让给同进程里的其它查询。
 *
 * @param filePath - 最终目标路径。
 * @param produce - 往写入器里添加条目的回调。
 */
export declare function writeZipAtomic(filePath: string, produce: (zip: ZipFileWriter) => Promise<void>): Promise<void>;
export declare function dataUrlToBuffer(url: string): Buffer | null;
/** Media-resolution context (raw base dir + image AES/xor keys) from config. */
export declare function exportMediaCtx(decrypted: string): {
    base: string | undefined;
    aesKey: string | undefined;
    xorKey: number;
};
