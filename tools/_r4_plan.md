# R4 结构闭环 · 执行方案

> 承接 R0 基线 / R1 令牌层 / R2 前置门 / R3 dsw 收编（全部收口全绿）。
> 目标：把「加载态 / 空态 / 错误态 / 骨架屏 / 长任务进度」五类**结构性状态**从
> 「各面板各写一份」收口为「统一组件 + 统一守卫」。

## 0. 现场实测（2026-09-28，动手前逐条核验）

### 0.1 病 1：错误态伪装成空态 + 样式各写一份（R4 头号问题）

`ui/kit.module.css` 的 `.error` 注释**自己就诊断了**这件事（写在更早的轮次），
但只完成了「kit 提供共享 `.error`」这半步，**调用侧没收口**：

- `kitCss.error` 调用点 **48 处**，横跨 **31 个面板**；
- `role="alert"` **51 处**（多数已合规，说明前几轮推过一轮，但没推完）；
- **7 个面板仍各自定义 `.error` / `.errBanner`**：
  `daily-summary`(errBanner) / `note-editor` / `overview` / `privacy-trust` /
  `session-ask` / `world-map` / `monitor`(note) — 加上 kit 共 **8 份同语义样式**；
- **6 处渲染错误时缺 `role="alert"`**（读屏不播报）：
  `AskHistoryDialog:239` / `DailySummary:339` / `KnowledgeNoteEditor:303` /
  `Monitor:167` / `PrivacyTrust:214` / `WorldMap:263`；
- **前缀不统一**：有的 `⚠️ {error}`、有的裸 `{error}`；
- **语义最坏的一类**：`PrivacyTrust:214` 的 `css.error` 只有
  `padding + color + font-size` —— **没有红色边框/底色**，出错与"没数据"视觉几乎无差。

### 0.2 病 2：加载态三种形态并存

| 形态 | 实例 | 说明 |
|---|---|---|
| 有骨架 | `Graph.tsx:72` 脉动节点 + 两行文案 | 最好的一档 |
| 一行字 | `CityMap.tsx:61` `正在加载城市地图…` | 无骨架、无耗时 |
| 一行字（复用空态样式） | `PrivacyTrust.tsx:162/187` `kitCss.emptyInline` | **加载态与空态同视觉** |

`PrivacyTrust` 的分支尤其典型：
```
{loading && !scan && <div className={kitCss.emptyInline}>扫描结果加载中…</div>}
{!loading && !scan && !error && <div className={kitCss.emptyInline}>最新扫描结果请前往…</div>}
```
**两个语义完全不同的分支共用同一个 class** ⇒ 用户分不清"在跑"和"没有"。

已有一半基建：`useElapsedSeconds`（6 处）、`EmptyMaybeSyncing`（3 处）、
`ListSkeleton`（21 文件）。缺的是**统一入口 + 强制接入**。

### 0.3 病 3：长任务进度覆盖极不均

`ProgressBar` **仅 3 处**：`Backup.tsx`（加密备份）、`chats-export-dialog.tsx`（导出）、
`settings-sections.tsx:363`（软件更新）。而**同样是长任务的**：
- 隐私体检扫描（`queryPrivacyScan` 实测 **1020ms**，冷启更久）—— **无进度**；
- 知识库建索引 / 实体抽取 —— 轮询计数文本；
- 世界地图首屏（地形/GeoJSON 拉取）—— 一行字。

### 0.4 既有守卫（R4 必须不破，且要加固）

- `panels/panel-clip.wiring.spec.ts` —— 钉 `.nm-skel` 不许再声明 `display`（裁切）；
- `panels/files-loading.wiring.spec.ts` / `ledger-loading.dom.spec.ts` /
  `u2-slow-query.wiring.spec.ts` / `u14-empty-state.wiring.spec.ts` /
  `m3-export-progress.wiring.spec.ts` / `read-error-visibility.spec.ts`；
- `ui/kit-css-split.wiring.spec.ts` —— 钉 kit 三份 CSS 的类不许跨份引用。

## 1. 定案（按用户裁决：**全量统一** + **守卫先行/变异自证/全量收口**）

### 1.1 新增统一组件（放 `ui/kit-fields.tsx`，经 `kit.tsx` 的 `export *` 自动转发）

```
ErrorState    —— 统一错误态：红框 + role="alert" + 可选 retry
LoadingState  —— 统一加载态：骨架档 / 紧凑档 / 带耗时档 三形态
```

**不新建 CSS 文件**（避免踩 `kit-css-split.wiring.spec.ts` 的跨份引用坑）；
样式加在 `kit.module.css` 的 `.error` 邻近处，复用既有 `--nm-*` 令牌。

#### `ErrorState` 契约
```ts
ErrorState({ message, detail?, onRetry?, tone? })
```
- 渲染必须带 `role="alert"`（**核心不变量**）；
- 复用 `css.error`（不新造类）；
- `detail` 折叠展开（长错误信息不撑版面）。

#### `LoadingState` 契约
```ts
LoadingState({ label = '加载中…', variant = 'skeleton' | 'compact' | 'timed',
               rows?, grid?, since?, hint? })
```
- `variant='skeleton'` → 内部复用 `ListSkeleton`（列表类默认）；
- `variant='compact'` → 一行紧凑（替代所有「一行字」）；
- `variant='timed'` → compact + `useElapsedSeconds` 秒数（替代手写计时）；
- **与空态视觉必须不同**（当前 `emptyInline` 复用是 bug）。

### 1.2 收编范围（全量）

| 批次 | 内容 | 预期文件数 |
|---|---|---|
| **R4a** | 新增 `ErrorState` / `LoadingState` + 守卫 spec + 变异自证 | 2 改 + 1 新 |
| **R4b** | 48 处错误态收编到 `ErrorState`；删 7 份自定义 `.error` | ~31 |
| **R4c** | 「一行字加载态」收编到 `LoadingState`（含 `PrivacyTrust` 分支拆分） | ~15 |
| **R4d** | `ProgressBar` 推广到 >2s 任务（隐私体检 / 知识库建索引） | ~3 |
| **R4e** | 空态无占位补齐（7 面板列表塌成 0 高度） | ~7 |
| **R4f** | 收口：守卫 + 变异 + 五份 typecheck + build 三连 + 全量 vitest | — |

### 1.3 守卫设计（先写，后实现）

新增 `src/.../ui/state-components.wiring.spec.ts`：

1. `ErrorState 必须渲染 role="alert"` —— 源码切片到函数体，钉 `role="alert"`；
2. `ErrorState 必须复用 kit 的 .error 类` —— 钉 `css.error`，禁新造；
3. `LoadingState 的三个 variant 都不得复用空态视觉` —— 钉**不含** `emptyInline`；
4. `所有 `{error &&` 渲染点必须带 role="alert"` —— 全仓扫描 + 白名单（声明用途）；
5. `各面板不得再自定义 .error / .errBanner` —— 扫描 `panels/*.module.css`；
6. `LoadingState 的 timed 档必须接 useElapsedSeconds` —— 钉调用点正则
   `/[^A-Za-z0-9_$.]useElapsedSeconds\(/`（**别用 toContain('useElapsedSeconds')**，
   import 行会假命中 —— R3 已被变异测试抓过这个坑）。

变异自证：每条守卫配 1 个变异，**必须变红**，退出码判定，逐字节还原。

### 1.4 收口链（照 R3 节奏）

```
目标 spec 红→绿
  → tsc 5 份（typecheck）
  → build:ui（强制，CSS 错只在这暴露）
  → build:backend + build:types
  → 全量 vitest（接受 17 条环境类失败基线，逐条核验无我方新增）
  → 变异全 RED-OK
  → memory + docs 更新 + 清理临时产物
```

## 2. 风险与约束

| 风险 | 缓解 |
|---|---|
| 48 处改动面大，易漏 | 用**带断言的批量脚本**（每处断言原文恰好 1 次），任一不命中整体不写盘 |
| 同文件多 Edit 互相覆盖 | 一律批量脚本，禁同消息多 Edit |
| 删自定义 `.error` 后引用悬空 | 先删调用点、再删定义；构建期 CSS Modules 会报未定义类（`build:ui` 暴露） |
| 同文件多 Edit 互相覆盖 | 一律批量脚本，禁同消息多 Edit |
| 骨架复用 `ListSkeleton` 引 CSS 跨份 | `ListSkeleton` 在 `hooks.tsx`，样式在 `kit.module.css` —— 同 kit 域，安全 |
| `panel-clip.wiring.spec.ts` 不许 `.nm-skel` 声明 display | `LoadingState` 复用 `ListSkeleton`，**不新增** `.nm-skel` 规则 |

## 3. 文件级落点速查

- 组件：`ui/kit-fields.tsx`（新增两个 export）
- 样式：`ui/kit.module.css`（`.error` 邻近，新增 `.errorDetail` / `.loadingState*`）
- 守卫：`ui/state-components.wiring.spec.ts`（新建）
- 收编：`panels/*.tsx`（48 错误态 + 15 加载态 + 3 进度 + 7 空态）
- 面板 CSS：删 7 份 `.error` / `.errBanner`
