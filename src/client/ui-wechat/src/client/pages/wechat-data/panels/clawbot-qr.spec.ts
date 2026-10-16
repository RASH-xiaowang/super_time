/**
 * ClawBot 二维码编码器守卫（`clawbot-qr.ts`）。
 *
 * 核心是**逐位**比对独立实现（npm `qrcode`）的黄金向量（含它自选的掩码号）——
 * 画错的二维码不会有任何报错，只会「扫出来不是绑定位」，所以这里必须位级相等；
 * 另配容量边界（装不下要抛、不许静默截断）与 UTF-8 用例。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { encodeQr, qrSvgPath, versionFor } from './clawbot-qr.ts'
import { QR_GOLDEN } from './clawbot-qr.fixtures.ts'

/** 矩阵 → '1'/'0' 行串（与夹具同构）。 */
function rowsOf(modules: boolean[][]): string[] {
  return modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}

describe('clawbot-qr：与独立实现逐位一致', () => {
  for (const v of QR_GOLDEN) {
    it(`${v.name}：版本 / 掩码 / 每一位都相同`, () => {
      const qr = encodeQr(v.text)
      expect({ version: qr.version, size: qr.size, mask: qr.mask }).toEqual({ version: v.version, size: v.size, mask: v.mask })
      expect(rowsOf(qr.modules)).toEqual([...v.rows])
    })
  }
})

describe('clawbot-qr：容量边界与 UTF-8', () => {
  it('按字节数选最小版本；边界处不静默截断而是抛错', () => {
    expect(versionFor(17)).toBe(1)
    expect(versionFor(18)).toBe(2)
    expect(versionFor(230)).toBe(9)
    expect(() => versionFor(231)).toThrow('230')
    // 中文按 UTF-8 字节计（不是字符数）：19 字节 ⇒ 版本 2。
    expect(versionFor(new TextEncoder().encode('你好，Super Time').length)).toBe(2)
  })

  it('超长文本 encodeQr 同样抛错（不是画一个扫不出来的码）', () => {
    expect(() => encodeQr('a'.repeat(231))).toThrow()
  })

  it('静区与 viewBox：四周留 4 模块，深色方块数与矩阵一致', () => {
    const qr = encodeQr('Hello')
    const { viewBox, d } = qrSvgPath(qr)
    expect(viewBox).toBe(`0 0 ${String(qr.size + 8)} ${String(qr.size + 8)}`)
    const dark = qr.modules.flat().filter(Boolean).length
    expect(d.match(/h1v1h-1z/g)?.length).toBe(dark)
  })
})
