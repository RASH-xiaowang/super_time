/**
 * koffi-backed Win32 memory API for WeChat key recovery, following the repo's
 * win32.ts containment pattern (koffi loads lazily, so non-Windows processes
 * never open Win32 libraries). Surface: OpenProcess / VirtualQueryEx /
 * ReadProcessMemory / CloseHandle — the three APIs the V4 DB-key scanner and
 * the image-key memory scanner need (migrated from WeChatDataAnalysis'
 * ctypes wrappers).
 */
/** PROCESS_VM_READ access right. */
declare const PROCESS_VM_READ = 16;
/** PROCESS_QUERY_INFORMATION access right. */
declare const PROCESS_QUERY_INFORMATION = 1024;
/** MEM_COMMIT region state. */
export declare const MEM_COMMIT = 4096;
/** PAGE_NOACCESS. */
declare const PAGE_NOACCESS = 1;
/** PAGE_READWRITE. */
declare const PAGE_READWRITE = 4;
/** PAGE_WRITECOPY. */
declare const PAGE_WRITECOPY = 8;
/** PAGE_EXECUTE_READWRITE. */
declare const PAGE_EXECUTE_READWRITE = 64;
/** PAGE_EXECUTE_WRITECOPY. */
declare const PAGE_EXECUTE_WRITECOPY = 128;
/** PAGE_GUARD. */
declare const PAGE_GUARD = 256;
/** One queried memory region. */
export interface MemoryRegion {
    baseAddress: number;
    size: number;
    state: number;
    protect: number;
}
/** The small Win32 surface the scanners need. */
export interface Win32MemoryApi {
    openProcess(pid: number): unknown;
    queryRegion(handle: unknown, address: number): MemoryRegion | null;
    readMemory(handle: unknown, address: number, size: number): Buffer;
    closeHandle(handle: unknown): void;
}
/**
 * True on a committed, writable, non-guarded region (image-key scan filter).
 * @param region - queried memory region.
 * @returns whether the scanner should read it.
 */
export declare function isScannableRegion(region: MemoryRegion): boolean;
/**
 * Enumerate committed writable regions of a process.
 * @param pid - target process id.
 * @returns the API handle plus regions, or null when the process is inaccessible.
 */
export declare function enumerateScannableRegions(pid: number): Promise<{
    api: Win32MemoryApi;
    handle: unknown;
    regions: MemoryRegion[];
} | null>;
/**
 * Read bytes at a process address (opens its own handle).
 * @param pid - target process id.
 * @param address - virtual address to read.
 * @param size - number of bytes to read.
 * @returns the read bytes (empty when the read fails).
 */
export declare function readProcessMemory(pid: number, address: number, size: number): Promise<Buffer>;
export { PROCESS_VM_READ, PROCESS_QUERY_INFORMATION, PAGE_READWRITE, PAGE_WRITECOPY, PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PAGE_NOACCESS, };
