/**
 * koffi-backed Win32 memory API for WeChat key recovery, following the repo's
 * win32.ts containment pattern (koffi loads lazily, so non-Windows processes
 * never open Win32 libraries). Surface: OpenProcess / VirtualQueryEx /
 * ReadProcessMemory / CloseHandle — the three APIs the V4 DB-key scanner and
 * the image-key memory scanner need (migrated from WeChatDataAnalysis'
 * ctypes wrappers).
 */

/** PROCESS_VM_READ access right. */
const PROCESS_VM_READ = 0x0010
/** PROCESS_QUERY_INFORMATION access right. */
const PROCESS_QUERY_INFORMATION = 0x0400
/** MEM_COMMIT region state. */
export const MEM_COMMIT = 0x1000
/** PAGE_NOACCESS. */
const PAGE_NOACCESS = 0x01
/** PAGE_READWRITE. */
const PAGE_READWRITE = 0x04
/** PAGE_WRITECOPY. */
const PAGE_WRITECOPY = 0x08
/** PAGE_EXECUTE_READWRITE. */
const PAGE_EXECUTE_READWRITE = 0x40
/** PAGE_EXECUTE_WRITECOPY. */
const PAGE_EXECUTE_WRITECOPY = 0x80
/** PAGE_GUARD. */
const PAGE_GUARD = 0x100
/** Max user-space address (x64). */
const MAX_USER_ADDRESS = 0x7FFF_FFFF_FFFF

/** One queried memory region. */
export interface MemoryRegion {
  baseAddress: number
  size: number
  state: number
  protect: number
}

/** The small Win32 surface the scanners need. */
export interface Win32MemoryApi {
  openProcess(pid: number): unknown
  queryRegion(handle: unknown, address: number): MemoryRegion | null
  readMemory(handle: unknown, address: number, size: number): Buffer
  closeHandle(handle: unknown): void
}

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary { func(convention: string, name: string, result: string, args: string[]): KoffiFunction }
interface KoffiModule { load(path: string): KoffiLibrary }

/**
 * x64 MEMORY_BASIC_INFORMATION size: BaseAddress (ptr 8) + AllocationBase
 * (ptr 8) + AllocationProtect (u32 4) + 4-byte padding + RegionSize (size_t 8)
 * + State (u32 4) + Protect (u32 4) + Type (u32 4) = 48 bytes. The kernel
 * rejects a shorter buffer (returns 0), so this must be the full struct size.
 * WeChat 4.x is x64-only; the x86 layout (28 bytes) is not supported.
 */
const MBI_SIZE = 48

let apiPromise: Promise<Win32MemoryApi> | undefined

/**
 * 取（或建立）koffi/kernel32 的绑定。
 *
 * 失败时**清掉缓存再抛**：一次失败（koffi 原生二进制还在解包、被临时占用、首次加载
 * 撞上杀软扫描）如果被永久缓存，之后每次密钥扫描都会复现同一条错误、且永远没有重试
 * 机会。成功时保留缓存（避免每次扫描都重新 dlopen）。
 * 错误信息本地化 + 给排查方向，因为它是直传界面的。
 * @returns 绑定好的 Win32 内存 API。
 */
async function win32Api(): Promise<Win32MemoryApi> {
  if (apiPromise !== undefined) return apiPromise
  const created = (async () => {
    try {
      return await buildApi()
    } catch (e) {
      throw new Error(
        '内存扫描组件 koffi 初始化失败：' + ((e as Error).message || String(e))
        + '。常见原因：安装包缺少 win32 原生二进制、杀毒软件拦截了 DLL 解包、或系统不是 x64。'
        + '可先用「手动填写密钥」流程继续。',
        { cause: e },
      )
    }
  })()
  apiPromise = created
  created.catch(() => { if (apiPromise === created) apiPromise = undefined })
  return created
}

/** 真正建立绑定（失败由 win32Api 统一包成可操作的中文错误）。 */
async function buildApi(): Promise<Win32MemoryApi> {
  const koffi = (await import('koffi')).default as unknown as KoffiModule
  const kernel32 = koffi.load('kernel32.dll')
  const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int32', 'uint32'])
  const virtualQueryEx = kernel32.func('__stdcall', 'VirtualQueryEx', 'size_t', ['void *', 'void *', 'void *', 'size_t'])
  const readProcessMemory = kernel32.func('__stdcall', 'ReadProcessMemory', 'int32', ['void *', 'void *', 'void *', 'size_t', 'size_t *'])
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int32', ['void *'])

  return {
    openProcess(pid) {
      return openProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid)
    },
    queryRegion(handle, address) {
      const info = Buffer.alloc(MBI_SIZE)
      const result = virtualQueryEx(handle, address, info, MBI_SIZE)
      if (Number(result) === 0) return null
      // x64 layout: BaseAddress ptr, AllocationBase ptr, AllocationProtect u32,
      // RegionSize size_t, State u32, Protect u32, Type u32.
      return {
        baseAddress: Number(info.readBigUInt64LE(0)),
        size: Number(info.readBigUInt64LE(24)),
        state: info.readUInt32LE(32),
        protect: info.readUInt32LE(36),
      }
    },
    readMemory(handle, address, size) {
      if (size <= 0) return Buffer.alloc(0)
      const buffer = Buffer.alloc(size)
      const bytesRead = Buffer.alloc(8)
      const success = readProcessMemory(handle, address, buffer, size, bytesRead)
      if (Number(success) === 0) return Buffer.alloc(0)
      const read = Number(bytesRead.readBigUInt64LE(0))
      return read > 0 ? buffer.subarray(0, Math.min(read, size)) : Buffer.alloc(0)
    },
    closeHandle(handle) {
      try { closeHandle(handle) } catch { /* best effort */ }
    },
  }
}

/**
 * True on a committed, writable, non-guarded region (image-key scan filter).
 * @param region - queried memory region.
 * @returns whether the scanner should read it.
 */
export function isScannableRegion(region: MemoryRegion): boolean {
  if (region.state !== MEM_COMMIT || region.size <= 0 || region.size > 50 * 1024 * 1024) return false
  if ((region.protect & (PAGE_GUARD | PAGE_NOACCESS)) !== 0) return false
  const prot = region.protect & 0xFF
  return prot === PAGE_READWRITE || prot === PAGE_WRITECOPY || prot === PAGE_EXECUTE_READWRITE || prot === PAGE_EXECUTE_WRITECOPY
}

/**
 * Enumerate committed writable regions of a process.
 * @param pid - target process id.
 * @returns the API handle plus regions, or null when the process is inaccessible.
 */
export async function enumerateScannableRegions(
  pid: number,
): Promise<{ api: Win32MemoryApi; handle: unknown; regions: MemoryRegion[] } | null> {
  const api = await win32Api()
  const handle = api.openProcess(pid)
  if (!handle) return null
  const regions: MemoryRegion[] = []
  let address = 0
  while (address < MAX_USER_ADDRESS) {
    const region = api.queryRegion(handle, address)
    if (region === null) break
    const next = region.baseAddress + region.size
    if (next <= address) break
    if (isScannableRegion(region)) regions.push(region)
    address = next
  }
  return { api, handle, regions }
}

/**
 * Read bytes at a process address (opens its own handle).
 * @param pid - target process id.
 * @param address - virtual address to read.
 * @param size - number of bytes to read.
 * @returns the read bytes (empty when the read fails).
 */
export async function readProcessMemory(pid: number, address: number, size: number): Promise<Buffer> {
  const api = await win32Api()
  const handle = api.openProcess(pid)
  if (!handle) return Buffer.alloc(0)
  try {
    return api.readMemory(handle, address, size)
  } finally {
    api.closeHandle(handle)
  }
}

export {
  PROCESS_VM_READ, PROCESS_QUERY_INFORMATION, PAGE_READWRITE, PAGE_WRITECOPY,
  PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PAGE_NOACCESS,
}
