# R2 前置门 · 执行方案（2026-09-28）

> 目标：四个「第一印象」表面采纳率 → ≥95%。**但先纠正 R0 的统计口径。**

## 0. 重大修正：R0 的裸色统计高估了

R0 的行级 grep 把 **`var(--token, #hex)` 里的 fallback** 也算成了裸色。
精确审计（剔除注释 + 剥离 `var()` 后统计）结果：

| 文件 | R0 统计 | **真裸硬编码** | fallback 兜底 | 修正后采纳率 |
|---|---|---|---|---|
| `PrivacyConsentGate.module.css` | 56 | **0** | 32 | **100%** ✅ |
| `license-gate.module.css` | 45 | **21** | 19 | ~55% |
| `onboarding-stages.module.css` | — | **21** | 1 | ~55% |
| `onboarding.module.css` | 165 | **71** | 2 | ~50% |
| `titlebar.css` | 9 | **5** | 3 | ~55% |
| **合计** | **275** | **118** | **57** | — |

### 第二个修正：不存在「浅色值混进深色文件」的 bug

R0 记录称 `onboarding.module.css` 把浅色色值硬编码进深色文件、深色下发白 —— **这是误判**。
逐行作用域核实（`tools/r2-scope.py`）：

- 25 处浅色值中 **24 处在 `:global(.theme-light)` 作用域内** —— 是**刻意维护的浅色主题覆盖层**（`onboarding.module.css` 第 168–255 行整段）。
- 唯一 dark-scope 的 1 处是 `L848` 的 `rgba(255,255,255,.35)`，属**高光扫过**效果，深色下用白高光正确。
- `license-gate.module.css` 第 145–215 行同理，5 处全部 `:global(.theme-light)`。

**结论：不是 bug，是「浅色覆盖没走令牌」的采纳率问题。** R2 的措辞必须相应改写。

---

## 1. R2 的真实问题清单

### P1 — 深色基座硬编码（4 个文件，最高优先）

这些是**深色主题下就在用的**值，未走令牌；一旦改令牌它们**不跟随**，是换肤的漏网点。

| 文件 | 行 | 现值 | 应改为 |
|---|---|---|---|
| `titlebar.css` | L49 | `rgba(0,240,255,.08)` | `var(--nm-cyan-8)` |
| `titlebar.css` | L50 | `rgba(0,240,255,.25)` | `var(--nm-cyan-25)` **（需新增）** |
| `titlebar.css` | L83 | `rgba(127,127,127,.16)` | `var(--nm-hover-neutral)` **（需新增）** |
| `license-gate` | L22 | `rgba(0,240,255,.16)` | `var(--nm-cyan-16)` **（需新增）** |
| `license-gate` | L23 | `rgba(13,21,40,.72)` | `var(--nm-panel)` **（需新增）** |
| `license-gate` | L67 | `rgba(0,240,255,.12)` | `var(--nm-cyan-12)` **（需新增）** |
| `license-gate` | L120/198 | `.2` / `.18` | `--nm-cyan-20` / `--nm-cyan-18` |
| `license-gate` | L127/208 | `.4` / `.45` | `--nm-cyan-42`/`--nm-cyan-45` |
| `license-gate` | L128 | `rgba(0,240,255,.06)` | `var(--nm-cyan-6)` ✅已有 |
| `license-gate` | L199 | `rgba(5,10,24,.55)` | `var(--nm-veil-55)` **（需新增）** |
| `onboarding` | 多处 | `rgba(0,240,255,α)` / `rgba(168,85,247,α)` | `--nm-cyan-*` / `--nm-purple-*` |

### P2 — 浅色覆盖层硬编码（`theme-light` 段）

`#0e7490` / `rgba(8,145,178,α)` / `rgba(124,58,237,α)` / `rgba(15,23,42,α)` / `#f7f9fc` 等。
**注意**：这些值**已经**在 `light-theme.css` 里有对应令牌（`--nm-cyan-4/6/8/14/35` 覆盖为 `rgba(8,145,178,α)`）。
所以浅色段应当**直接改用 `--nm-cyan-*`**，由 `light-theme.css` 自动给出浅色值 —— **不用在这里写 `theme-light` 覆盖**。这是最大的简化机会。

### P3 — `--dsw-alias-*` 兜底差异（`titlebar.css`）

`titlebar.css` 用 `var(--dsw-alias-bg-layer-1, #0b1220)` 等，但 `--dsw-alias-*` 定义在 `scifi-theme.css`。
`titlebar.css` **不 import 主题** ⇒ 打包顺序若变，标题栏会退化成裸兜底色。虽当前 Vite 会 hoist 主题到顶部，但**这是隐式依赖**，应显式化。

---

## 2. 新增令牌清单（R2 需要 R1 式的三处同步）

| 令牌 | 深色值 | 浅色值 | 用途 |
|---|---|---|---|
| `--nm-cyan-12` | `rgba(0,240,255,.12)` | `rgba(8,145,178,.12)` | license 分隔线 |
| `--nm-cyan-16` | `rgba(0,240,255,.16)` | `rgba(8,145,178,.16)` | license 卡片边框 |
| `--nm-cyan-18` | `rgba(0,240,255,.18)` | `rgba(8,145,178,.18)` | license 输入框 |
| `--nm-cyan-25` | `rgba(0,240,255,.25)` | `rgba(8,145,178,.25)` | titlebar logo 边框 |
| `--nm-cyan-42` | `rgba(0,240,255,.42)` | `rgba(8,145,178,.42)` | hover 边框 |
| `--nm-cyan-45` | `rgba(0,240,255,.45)` | `rgba(8,145,178,.45)` | focus 边框 |
| `--nm-purple-8` | `rgba(168,85,247,.08)` | `rgba(124,58,237,.08)` | onboarding 光晕 |
| `--nm-purple-10` | `rgba(168,85,247,.10)` | `rgba(124,58,237,.10)` | onboarding 光晕 |
| `--nm-purple-14` | `rgba(168,85,247,.14)` | `rgba(124,58,237,.14)` | onboarding 边框 |
| `--nm-purple-18` | `rgba(168,85,247,.18)` | `rgba(124,58,237,.18)` | onboarding 边框 |
| `--nm-purple-50` | `rgba(168,85,247,.50)` | `rgba(124,58,237,.50)` | onboarding 光带 |
| `--nm-panel-solid` | `rgba(13,21,40,.72)` | `rgba(255,255,255,.85)` | 玻璃卡片面 |
| `--nm-veil-55` | `rgba(5,10,24,.55)` | `rgba(255,255,255,.8)` | 输入框底 |
| `--nm-hover-neutral` | `rgba(127,127,127,.16)` | `rgba(15,23,42,.06)` | 通用 hover |

**共 14 个新令牌。** 加上 R1 的 7 个 = 21 个。

---

## 3. 执行顺序

1. **R2a** — 新增 14 令牌（`scifi-theme.css` 三处同步 + `light-theme.css` 覆盖）
2. **R2b** — 补守卫：扩展 `theme-alpha-ladder.spec.ts` 覆盖新档 + 新增 `first-impressions-tokens.spec.ts`（断言四个文件**零真裸硬编码**）
3. **R2c** — 替换四个文件的硬编码（`titlebar.css` → `license-gate` → `onboarding-stages` → `onboarding`）
4. **R2d** — 断点收敛：44 个值 → 4 档（≤1100 / ≤900 / ≤720 / 默认）
5. **R2e** — 收口：typecheck → build:ui → build:backend/types → vitest 全量

---

## 4. 明确不做

- **不删浅色覆盖层**：它们是刻意的，只是改走令牌。
- **不动 `--wx-*`**：聊天域边界是 R3 的事。
- **不改 IA / 组件 API / 色相**：只改「值的来源」。
- **不追求 100% 零字面量**：`mask-image` 的 `#000`、纯黑阴影 `rgba(0,0,0,.35)`、`#e81123`（Windows 关闭键红）属**非主题语义**，保留字面量但在守卫里**登记豁免**。
