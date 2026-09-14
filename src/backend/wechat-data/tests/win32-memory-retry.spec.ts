/**
 * M5：koffi 初始化失败**不能被永久缓存**，且错误信息要是可操作的中文。
 *
 * 旧实现把初始化 promise 直接缓存：一次失败（原生二进制还在解包、被临时占用、
 * 首次加载撞上杀软扫描）之后，每次密钥扫描都复现同一条英文错误，且永远没有重试机会。
 * 这里用假的 koffi 强制「头两次 load 失败」，断言每次调用都**真的重新尝试**加载。
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ loadCalls: 0, failTimes: 2 }))

vi.mock('koffi', () => ({
  default: {
    load: () => {
      state.loadCalls += 1
      if (state.loadCalls <= state.failTimes) throw new Error('模拟 kernel32.dll 加载失败')
      // 后续成功：func() 返回一个总是失败（返回 0）的桩函数，于是 openProcess 拿不到句柄
      return { func: () => () => 0 }
    },
  },
}))

// mock 之后再动态 import，确保被测模块拿到的是桩
const { readProcessMemory } = await import('../src/keys/win32-memory.ts')

describe('koffi 初始化失败的处理', () => {
  it('失败信息本地化且给出可操作指引', async () => {
    await expect(readProcessMemory(1, 0, 16)).rejects.toThrow(/内存扫描组件 koffi 初始化失败/)
    await expect(readProcessMemory(1, 0, 16)).rejects.toThrow(/手动填写密钥/)
    // 两次调用 → 两次真实尝试（若沿用旧实现，第二次会直接复用缓存的拒绝、不再 load）
    expect(state.loadCalls).toBe(2)
  })

  it('失败不再是永久的：第三次调用会成功', async () => {
    const buf = await readProcessMemory(1, 0, 16)
    expect(buf).toEqual(Buffer.alloc(0)) // 桩的 openProcess 返回 0 → 空缓冲
    expect(state.loadCalls).toBe(3)
  })

  it('成功之后走缓存（不再重复 dlopen）', async () => {
    await readProcessMemory(1, 0, 16)
    await readProcessMemory(1, 0, 16)
    expect(state.loadCalls).toBe(3)
  })
})
