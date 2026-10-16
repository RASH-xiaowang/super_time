/**
 * 最小 QR 编码器（字节模式·纠错等级 L·版本 1–9）—— ClawBot 绑定二维码在渲染层**自己画**。
 *
 * ## 为什么自己写而不是引依赖
 *
 * 本仓的运行时依赖是**逐个登记进打包白名单**的（`package.json` 的 `build.files`），
 * 为一个二维码多带一个 npm 包不划算；而需求只有一个：把 iLink 下发的绑定 URL
 * （实测约 85 字节，最长也远小于 230 字节）画成可扫的码。于是按 ISO/IEC 18004 实现
 * 字节模式的最小可用子集：
 *
 * - **纠错等级 L、版本 1–9**（容量 17–230 字节）；超出抛错，不静默降级；
 * - 自动选版本（装得下就取最小）与 8 个掩码里罚分最小的那个；
 * - 输出布尔矩阵（`true` = 深色），渲染层自己决定画 SVG 还是格栅 —— 这里不碰 DOM。
 *
 * ## 正确性怎么保证
 *
 * `clawbot-qr.spec.ts` 用**独立实现**（npm `qrcode` 包，生成夹具时的临时依赖）的
 * 黄金向量逐位比对（含 qrcode 自选的掩码号），另加容量边界与 UTF-8 用例。
 * 实现结构参照公开算法（数据 → RS 纠错 → 交织 → 功能图形 → 8 掩码罚分），
 * 每个表都只覆盖 1–9 这九个版本，避免把用不到的 10–40 也搬进来。
 *
 * @module panels/clawbot-qr
 */

/** 纠错等级 L 的每块纠错码字数与**数据码字块划分**（版本 1–9）。 */
const EC_L: ReadonlyArray<{ ecPerBlock: number, dataBlocks: readonly number[] }> = [
  { ecPerBlock: 7, dataBlocks: [19] }, // v1
  { ecPerBlock: 10, dataBlocks: [34] }, // v2
  { ecPerBlock: 15, dataBlocks: [55] }, // v3
  { ecPerBlock: 20, dataBlocks: [80] }, // v4
  { ecPerBlock: 26, dataBlocks: [108] }, // v5
  { ecPerBlock: 18, dataBlocks: [68, 68] }, // v6
  { ecPerBlock: 20, dataBlocks: [78, 78] }, // v7
  { ecPerBlock: 24, dataBlocks: [97, 97] }, // v8
  { ecPerBlock: 30, dataBlocks: [116, 116] }, // v9
]

/** 对齐图形中心坐标（版本 1 无；版本 2–9 的表）。 */
const ALIGN_CENTERS: ReadonlyArray<readonly number[]> = [
  [], // v1
  [6, 18], [6, 22], [6, 26], [6, 30], // v2–v5
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], // v6–v9
]

/** 版本 → 尺寸（17 + 4×版本）。 */
function sizeOf(version: number): number {
  return 17 + 4 * version
}

/** 一个字节序列能装下的最小版本（1–9），装不下抛错。 */
export function versionFor(byteLength: number): number {
  for (let v = 1; v <= 9; v++) {
    const row = EC_L[v - 1]
    /* v8 ignore next -- 循环上界与表长都是常量 9。 */
    if (row === undefined) break
    const capacity = row.dataBlocks.reduce((a, n) => a + n, 0)
    // 模式 4 位 + 计数 8 位（v1–9 固定 8 位）+ 数据位，向上取整到字节。
    const codewords = Math.ceil((4 + 8 + byteLength * 8) / 8)
    if (codewords <= capacity) return v
  }
  throw new Error('二维码内容超过 230 字节（版本 9 · 纠错 L 的上限），无法编码')
}

// ── 伽罗华域 GF(256) 与 Reed–Solomon 纠错 ──────────────────────────────────

/** GF(256) 的对数/反对数表（本原多项式 0x11D）。 */
const GF_EXP: number[] = new Array(256).fill(0)
const GF_LOG: number[] = new Array(256).fill(0)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if ((x & 0x100) !== 0) x ^= 0x11D
  }
}

/** GF(256) 乘法。 */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  const la = GF_LOG[a] ?? 0
  const lb = GF_LOG[b] ?? 0
  return GF_EXP[(la + lb) % 255] ?? 0
}

/** 生成多项式 ∏(x - α^i)，i = 0..degree-1（系数从高次到低次，首项恒为 1）。 */
function rsGenerator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j] ?? 0
      next[j] = (next[j] ?? 0) ^ c // × x
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(c, GF_EXP[i] ?? 1) // × α^i
    }
    poly = next
  }
  return poly
}

/**
 * 计算 data 的 RS 纠错码字（余数）。
 *
 * 移位寄存器形式（与生成器同族实现的标准写法）：余数左移一格，按当前字节异或
 * 生成多项式去掉首项后的每一项。
 * @param data - 数据码字。
 * @param ecCount - 纠错码字数。
 * @returns 长度恰为 ecCount 的余数。
 */
function rsEncode(data: readonly number[], ecCount: number): number[] {
  const gen = rsGenerator(ecCount)
  const rem = new Array<number>(ecCount).fill(0)
  for (const byte of data) {
    const factor = (byte ^ (rem[0] ?? 0)) & 0xFF
    rem.shift()
    rem.push(0)
    for (let i = 0; i < ecCount; i++) {
      rem[i] = (rem[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor)
    }
  }
  return rem
}

// ── 数据编码（字节模式）────────────────────────────────────────────────────

/** UTF-8 编码（渲染层有 TextEncoder）。 */
function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

/** 版本 1–9：模式（4b 0100）+ 计数（8b）+ 数据 + 结束符 + 补齐字节。 */
function encodeDataCodewords(bytes: readonly number[], version: number): number[] {
  const row = EC_L[version - 1]
  /* v8 ignore next -- versionFor 只会给出表内版本。 */
  if (row === undefined) throw new Error('内部错误：版本超出编码器范围')
  const capacity = row.dataBlocks.reduce((a, n) => a + n, 0)
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  // 结束符：最多 4 个 0；不足则补到字节边界。
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ?? 0)
    codewords.push(b)
  }
  // 补齐字节 0xEC / 0x11 交替（ISO/IEC 18004 规定）。
  let padIndex = 0
  while (codewords.length < capacity) {
    codewords.push(padIndex % 2 === 0 ? 0xEC : 0x11)
    padIndex += 1
  }
  return codewords
}

/** 数据码字按块划分 → 各自 RS → 交织（数据在前、纠错在后）。 */
function interleave(codewords: readonly number[], version: number): number[] {
  const row = EC_L[version - 1]
  /* v8 ignore next -- 同 encodeDataCodewords。 */
  if (row === undefined) throw new Error('内部错误：版本超出编码器范围')
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (const size of row.dataBlocks) {
    const chunk = codewords.slice(offset, offset + size)
    offset += size
    dataBlocks.push(chunk)
    ecBlocks.push(rsEncode(chunk, row.ecPerBlock))
  }
  const out: number[] = []
  const maxData = Math.max(...row.dataBlocks)
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      const b = block[i]
      if (b !== undefined) out.push(b)
    }
  }
  for (let i = 0; i < row.ecPerBlock; i++) {
    for (const block of ecBlocks) {
      const b = block[i]
      if (b !== undefined) out.push(b)
    }
  }
  return out
}

// ── 矩阵构建 ───────────────────────────────────────────────────────────────

/** 功能图形占位表（true = 该格是功能图形，数据不放这里；掩码也不作用）。 */
type Grid = { size: number, modules: boolean[][], reserved: boolean[][] }

function makeGrid(size: number): Grid {
  const modules: boolean[][] = []
  const reserved: boolean[][] = []
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false))
    reserved.push(new Array<boolean>(size).fill(false))
  }
  return { size, modules, reserved }
}

/** 画定位图形（三个角：7×7 外框 + 3×3 实心 + 分隔带）。 */
function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      g.modules[y]![x] = dist !== 2 && dist !== 4
      g.reserved[y]![x] = true
    }
  }
}

/** 画对齐图形（5×5：外框 + 中心点）。 */
function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx
      const y = cy + dy
      g.modules[y]![x] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      g.reserved[y]![x] = true
    }
  }
}

/** 时序图形（第 6 行 / 第 6 列，从 8 开始交替）。 */
function drawTiming(g: Grid): void {
  for (let i = 8; i < g.size - 8; i++) {
    g.modules[6]![i] = i % 2 === 0
    g.reserved[6]![i] = true
    g.modules[i]![6] = i % 2 === 0
    g.reserved[i]![6] = true
  }
}

/** 15 位格式信息（BCH(15,5) + 固定掩码 0x5412）。 */
function formatBits(mask: number): number {
  // 纠错等级 L 的指示位是 01。
  const data = (0b01 << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0b10100110111 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0b101010000010010
}

/** 18 位版本信息（BCH(18,6)，版本 ≥7 才画）。 */
function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0b1111100100101)
  }
  return (version << 12) | (rem & 0xFFF)
}

/** 画格式信息（两份，围绕定位图形）与固定的深色模块；**只占这 31 格**。 */
function drawFormat(g: Grid, mask: number): void {
  const bits = formatBits(mask)
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0
  const set = (x: number, y: number, v: boolean): void => {
    g.modules[y]![x] = v
    g.reserved[y]![x] = true
  }
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) set(g.size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, g.size - 15 + i, bit(i))
  // 固定深色模块（规格里唯一恒为深的方位点）。
  set(8, g.size - 8, true)
  // ⚠️ 这里**不能**把第 8 行/列整条保留：格式信息只占 15+15+1 格，
  // col8 的 9–12 行与 row8 的 9–12 列都是**数据格** —— 整条保留会让数据
  // 放置跳过它们、整段位流错位（实测：与参考实现逐位比对时 49 格不同）。
}

/** 画版本信息（版本 ≥7：两个 3×6 区块）。 */
function drawVersion(g: Grid, version: number): void {
  if (version < 7) return
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    g.modules[b]![a] = bit
    g.modules[a]![b] = bit
    g.reserved[b]![a] = true
    g.reserved[a]![b] = true
  }
}

/** 数据码字按之字形放置（跳过功能图形；先右后左、上下交替）。 */
function drawCodewords(g: Grid, codewords: readonly number[]): void {
  let i = 0
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? g.size - 1 - vert : vert
        if (!(g.reserved[y]?.[x] ?? true) && i < codewords.length * 8) {
          const cw = codewords[i >>> 3] ?? 0
          g.modules[y]![x] = ((cw >>> (7 - (i & 7))) & 1) !== 0
          i += 1
        }
      }
    }
  }
}

/** 8 个掩码函数。 */
const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** 掩码只作用在非功能图形上。 */
function applyMask(g: Grid, mask: number): void {
  const fn = MASKS[mask]
  /* v8 ignore next -- 掩码号来自 0..7 循环。 */
  if (fn === undefined) return
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!(g.reserved[y]?.[x] ?? true) && fn(x, y)) {
        g.modules[y]![x] = !g.modules[y]![x]
      }
    }
  }
}

/** 罚分（ISO/IEC 18004 四条规则的常量化实现）。 */
function penalty(g: Grid): number {
  const size = g.size
  let score = 0
  const runScore = (len: number): number => (len >= 5 ? 3 + (len - 5) : 0)

  // 规则 1：行/列上同色连续 ≥5。
  for (let y = 0; y < size; y++) {
    let run = 1
    for (let x = 1; x < size; x++) {
      if (g.modules[y]![x] === g.modules[y]![x - 1]) run += 1
      else { score += runScore(run); run = 1 }
    }
    score += runScore(run)
  }
  for (let x = 0; x < size; x++) {
    let run = 1
    for (let y = 1; y < size; y++) {
      if (g.modules[y]![x] === g.modules[y - 1]![x]) run += 1
      else { score += runScore(run); run = 1 }
    }
    score += runScore(run)
  }

  // 规则 2：2×2 同色块。
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = g.modules[y]![x]
      if (c === g.modules[y]![x + 1] && c === g.modules[y + 1]![x] && c === g.modules[y + 1]![x + 1]) score += 3
    }
  }

  // 规则 3：类定位图形 1011101 + 一侧 4 个浅色。
  const pat = [true, false, true, true, true, false, true]
  const check = (cells: boolean[]): boolean => {
    for (let i = 0; i + 7 <= cells.length; i++) {
      let match = true
      for (let j = 0; j < 7; j++) {
        if (cells[i + j] !== pat[j]) { match = false; break }
      }
      if (!match) continue
      const before = cells.slice(Math.max(0, i - 4), i)
      const after = cells.slice(i + 7, i + 11)
      const lightAll = (arr: boolean[]): boolean => arr.every((v) => v === false)
      if ((before.length === 4 && lightAll(before)) || (after.length === 4 && lightAll(after))) return true
    }
    return false
  }
  for (let y = 0; y < size; y++) {
    const row: boolean[] = []
    for (let x = 0; x < size; x++) row.push(g.modules[y]![x] ?? false)
    if (check(row)) score += 40
  }
  for (let x = 0; x < size; x++) {
    const col: boolean[] = []
    for (let y = 0; y < size; y++) col.push(g.modules[y]![x] ?? false)
    if (check(col)) score += 40
  }

  // 规则 4：深色占比偏离 50% 的步数。
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (g.modules[y]![x]) dark += 1
  }
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

/** 编码结果：矩阵 + 实际选用的版本与掩码（测试与排障要看）。 */
export interface QrMatrix {
  /** 版本 1–9。 */
  version: number
  /** 掩码号 0–7。 */
  mask: number
  /** 边长（= 17 + 4×版本）。 */
  size: number
  /** `modules[y][x]`，true = 深色。 */
  modules: boolean[][]
}

/**
 * 把一段文本编码成 QR 矩阵（字节模式·纠错 L）。
 * @param text - 待编码文本（UTF-8；超过 230 字节抛错）。
 * @returns 矩阵与版本/掩码信息。
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8(text)
  const version = versionFor(bytes.length)
  const size = sizeOf(version)
  const codewords = encodeDataCodewords(bytes, version)
  const finalCodewords = interleave(codewords, version)

  // 基座：功能图形（不含格式/版本信息与数据），逐掩码复制后各自完整化、比罚分。
  const base = makeGrid(size)
  drawFinder(base, 3, 3)
  drawFinder(base, size - 4, 3)
  drawFinder(base, 3, size - 4)
  drawTiming(base)
  const centers = ALIGN_CENTERS[version - 1] ?? []
  for (const cy of centers) {
    for (const cx of centers) {
      // 跳过与三个定位图形重叠的三个角（其余组合都画）。
      const nearFinder = (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)
      if (!nearFinder) drawAlignment(base, cx, cy)
    }
  }

  let best: Grid | null = null
  let bestMask = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const g: Grid = {
      size,
      modules: base.modules.map((row) => row.slice()),
      reserved: base.reserved.map((row) => row.slice()),
    }
    drawFormat(g, mask)
    drawVersion(g, version)
    drawCodewords(g, finalCodewords)
    applyMask(g, mask)
    const score = penalty(g)
    if (score < bestScore) {
      bestScore = score
      best = g
      bestMask = mask
    }
  }
  /* v8 ignore next -- 8 个掩码至少有一个成为 best。 */
  if (best === null) throw new Error('内部错误：没有可用的掩码')
  return { version, mask: bestMask, size, modules: best.modules }
}

/**
 * 把矩阵画成一条 SVG `path` 的 d 属性（每个深色模块一个方孔），留 4 模块静区。
 * @param qr - {@link encodeQr} 的结果。
 * @returns `{ viewBox, d }`，直接给 `<svg viewBox={viewBox}><path d={d} fill="#050a18"/></svg>`。
 */
export function qrSvgPath(qr: QrMatrix): { viewBox: string, d: string } {
  const z = 4
  const parts: string[] = []
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]?.[x] === true) parts.push(`M${String(x + z)} ${String(y + z)}h1v1h-1z`)
    }
  }
  return { viewBox: `0 0 ${String(qr.size + 2 * z)} ${String(qr.size + 2 * z)}`, d: parts.join('') }
}
