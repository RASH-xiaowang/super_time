# UI 组件指南（kit）

> **这份文档管什么**：`ui/kit.tsx` 导出的每个组件的**选型、契约与用法**。
> 与另两份 UI 真源的分工：
> - `docs/UI-GEOMETRY-SPEC.md` —— 圆角/间距**数值**规范（用哪个令牌）
> - `docs/UI-PANELS-PLAN.md` —— 页签**审计**（哪些面板存在）
> - **本文** —— 组件**选型**（该用哪个组件、参数怎么传、什么时候不用）
>
> 令牌真源仍是 `src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css`。
> 本文不重复令牌值，只讲组件。

## 0. 现状基线（2026-09-28 实测）

| 项 | 数字 |
|---|---|
| kit 实现文件 | 6 个 tsx（`kit.tsx` 为转发壳，28 行）+ 4 个 CSS |
| 对外导出 | **34** 个（31 个组件/hook + `escStack` + 2 个类型别名） |
| 实际被引用 | **31 / 34**（零引用 3 个，见 §5） |
| `ui/kit.tsx` 引用文件数 | **66**（`wechat-data/` 下共 349 个 ts/tsx） |
| CSS 规模 | `kit.module.css` 858 行 / 97 类；`kit-overlay` 216/19；`kit-table` 98/11；`confirm` 175/14 |
| 全仓裸 `<button` | **335** 处（剥注释后的真实数）vs `Button` 引用 94 处 ⇒ **按钮仍是最大的收敛缺口**，但**处方见 §5 的「R6 结论」——不是换标签**。焦点环**不缺**（全局已覆盖） |

**唯一 import 面**：面板只认 `import { … } from '../ui/kit.tsx'`。
`Button` 的真实实现在 `ui-primitives-shim/Button.tsx`，从 `kit.tsx` 转出——**不要在面板里直接引 shim**。

```tsx
import { Card, PanelHeader, EmptyState, ErrorState, LoadingState } from '../ui/kit.tsx'
```

引入新组件时遵守 `kit-css-split.wiring.spec.ts`：**kit 的 CSS 只能被 `ui/` 下的文件引用**。
需要在组件里加样式，加到 `kit.module.css` 的同类规则邻近处，**不新建 CSS 文件**。

---

## 1. 决策表：该用哪个

按「用户看到什么」选，不按「哪个组件看起来更像」。

| 场景 | 用这个 | **不要**用 |
|---|---|---|
| 请求失败，有错误信息 | `ErrorState` | `EmptyState` / `.emptyInline` / 裸 `<div>{err}</div>` |
| 请求失败，但能重试 | `ErrorState onRetry={…}` | 让用户手动切页刷新 |
| 确定没有数据 | `EmptyState` | `EmptyMaybeSyncing` |
| 可能正在后台同步（如冷启） | `EmptyMaybeSyncing` | `EmptyState`（会说不该说的"没有"） |
| 正在加载，列表/网格类 | `LoadingState variant="skeleton"` | `EmptyState`（"加载=没数据"） |
| 正在加载，窄区（图表/弹窗） | `LoadingState variant="compact"` | 一行裸字 `<div>加载中…</div>` |
| 慢查询（>1s，后端同步 SQLite） | `LoadingState variant="timed"` 或 `ProgressBar` | 无反馈 |
| 长任务，总量已知 | `ProgressBar value={n}` | 转圈 |
| 长任务，总量未知 | `ProgressBar indeterminate` | 钉在 0% 的空条（像卡死） |
| 数值单元格 | `Mono` | 裸文本 |
| 主文本单元格 | `CellPrimary` | 裸文本 |
| 单值 + 趋势指标 | `StatCard` inside `StatGrid` | `Card` |
| 一般容器 | `Card` | `StatCard` |
| 表格（列定义 + 排序 + 骨架） | `DataTable` | 手写 `<table>` |
| 危险操作确认 | `useConfirm({ tone: 'danger' })` | `window.confirm` |
| 不可逆批量操作 | `useConfirm({ requireText: '…' })` | 只靠 `tone: 'danger'` |
| 非 `<button>` 但可点击的元素 | `clickableKey(onActivate)` | 只加 `role="button"` 不给键盘通路 |

**核心不变量（R4 立的，有守卫）**：
1. 错误态**必须**带红框 + `role="alert"`——`ErrorState` 把这两件事绑死了，用别的写法就会被 `state-components.wiring.spec.ts` 抓住。
2. 加载态**不得**复用空态视觉（`.empty` / `.emptyInline`）——否则又回到「加载 = 没数据」。
3. 读失败**不得**渲染成"没有数据"（`read-error-visibility.spec.ts`）。

---

## 2. 状态组件（R4 新增，最常用）

### `ErrorState`

```tsx
<ErrorState
  message="后台刷新失败（正在展示缓存数据）"   // 必填：一句话说清"什么"失败了
  detail={err.stack}                        // 可选：折叠展示，长堆栈不撑破版面
  onRetry={() => void reload()}             // 可选：传了就渲染「重试」按钮
/>
```

- 渲染 `role="alert" data-st-error="1"`，红框红底由 `kit.module.css` 的 `.error` 提供。
- `message` 要写**实际情况**。反例：`"加载失败"` —— 没说清是什么失败了；正例：`"后台刷新失败（正在展示缓存数据）"`。
- 该组件内部**不会**把 error 转成空态。这是它在 R4 里存在的全部理由。

### `LoadingState`

三档，按容器宽度和时长挑：

```tsx
// ① 列表/网格：微光骨架，形状贴近真实行（默认档）
<LoadingState variant="skeleton" rows={8} grid />

// ② 窄区（图表面板、弹窗）：一行紧凑
<LoadingState variant="compact" label="统计中…" />

// ③ 慢查询：带"已等待 Ns"（配 useElapsedSeconds）
<LoadingState variant="timed" label="正在扫描…" since={elapsed} hint="首次同步约 1–2 分钟" />
```

- `variant="skeleton"` 用的是 kit 自己的 `css.skelGrid/skelRow/…`，**与 `ListSkeleton` 形状一致但不 import 它** —— `ui/ → panels/ → ui/` 会成环。
- `variant="compact"` 渲染 `data-st-loading="compact"`；有 spec 钉这个选择器（`chats-calendar-dialog.spec.ts` / `chats-group-info-view.spec.ts`）。
- `since` 由调用方传 `useElapsedSeconds(loading)`（在 `panels/hooks.tsx`），组件不自己计时。

---

## 3. 按功能分组的完整清单

### 外壳 / 布局（`kit-shell.tsx`）

| 导出 | 签名要点 |
|---|---|
| `PanelHeader` | `{ title, desc?, actions? }` —— 面板标题区，右侧放操作按钮组 |
| `Toolbar` | `{ left?, right? }` —— 左筛选右操作 |
| `SearchInput` | `{ value, onChange, placeholder?, ariaLabel?, onEnter?, className? }` |
| `Card` | `{ title?, extra?, footer?, children, flush?, className? }` |
| `StatCard` | `{ icon, value, label, hint?, tone?, onClick?, title? }` |
| `StatGrid` | `{ children }` —— `StatCard` 的栅格容器 |
| `clickableKey` | `(onActivate, { stopPropagation?, role?, label? })` → 展开到元素上的 role/tabIndex/onClick/onKeyDown |
| `Tone`（类型） | `'default' \| 'cyan' \| 'green' \| 'red' \| 'amber' \| 'purple' \| 'blue'` |

**两个反直觉点**：

- **`SearchInput` 的宽度**：kit 默认 `flex: 0 1 320px; min-width: 220px`，在宽工具栏里合适；塞进窄左栏（如 302px 的会话栏）会**把同行按钮顶出列外**（实测「批量」按钮越出 46px）。传 `className="…"` 接管宽度策略，例如 `style={{ flex: 1, minWidth: 0 }}`。
- **`clickableKey` 的 `stopPropagation`**：元素嵌在**另一个可点击容器**里时必须开。例：朋友圈卡片的昵称——点昵称只应"按作者筛选"，不该连带打开详情。
- **`StatCard` 的 DOM 随 `onClick` 变**：传了 `onClick` 渲染成 `<button>`（键盘可达），没传是 `<div>`。**别在 `<button>` 里再嵌 `<button>`**。

### 表单字段（`kit-fields.tsx`）

| 导出 | 签名要点 |
|---|---|
| `Select` | `{ value, onChange, options, placeholder?, ariaLabel?, onOpen? }` |
| `DateField` | `{ value, onChange, ariaLabel?, id?, min?, max?, className?, placeholderHint? }` |
| `MonthField` | `{ value, onChange, ariaLabel?, id?, className? }` |
| `TimeField` | `{ value, onChange, ariaLabel?, id?, className? }` |
| `DateRangeField` | `{ from, to, onFrom, onTo, onClear?, presets?, ariaLabel?, idFrom?, idTo?, className? }` |
| `Tooltip` | `{ content, children }` —— Radix Tooltip，`delayDuration=300` |
| `Badge` | `{ tone?, children, title? }` |

- 日期族用**原生** `input[type=date/month/time]`（`color-scheme: dark` 已让 Chromium 日历跟随深色）。**不要自绘日历**——键盘/无障碍/本地化都得自己重做。
- `DateRangeField` **不加**起止互限的 `min`/`max`：改成两边自由选，颠倒时**组件内自动对调**（`normalizeRange`）。语义上"这段时间之内"本就没有颠倒，静默对调比让筛选结果变空更符合预期。
- `DateRangeField` 的 `presets` 来自 `utils/date-range.ts` 的 `RANGE_PRESETS`，面板只接自己的 state。

### 浮层（`kit-overlay.tsx`）

| 导出 | 签名要点 | 用途 |
|---|---|---|
| `Dialog` | `{ open, onClose, title?, children, footer?, className? }` | 居中弹窗（表单/确认） |
| `Drawer` | `{ open, onClose, title, children, footer?, width? }` | 右侧抽屉（详情/筛选） |
| `Tabs` | `{ tabs, value, onChange, children? }` | 胶囊标签页 |
| `Segmented` | `{ options, value, onChange, ariaLabel? }` | 分段选择器（单选） |
| `useEscapeToClose` | `(open, onClose)` | **手写**覆盖层的 Esc 关闭 |
| `useDialogFocus` | `(open, selector)` | **手写**弹窗的焦点管理 |
| `escStack` | `Array<() => void>` | Esc 关闭栈（内部用） |

**手写覆盖层必须补这两个 hook**。Radix 的 `Dialog`/`Drawer` 白送 Esc 与焦点循环，但仓库里还有一批手写的 `role="dialog"`（导出弹窗、聊天记录查看器、日历、已编辑消息、文件灯箱、任务表单）：

- 只用 `useEscapeToClose` + 点遮罩关闭 ⇒ 键盘用户**被困在弹窗里**。
- 只用 `useDialogFocus` 不给 Esc ⇒ 同上。
- 焦点管理不用 ref 而用**选择器**：给容器加 `data-st-dialog="<名字>"` 即可（手写弹窗散在 4 个面板 8 处，逐个建 ref 只会让 diff 变长）。
- `escStack` 用**栈**是因为聊天记录查看器支持嵌套打开——每个覆盖层各自监听 Esc 的话，一次按键会把整摞弹窗全关掉。

**R7 结论：接线漏接已清零（2026-09-28）**

全仓 12 个手写覆盖层逐一点名核验（守卫 `dialog-a11y.wiring.spec.ts`）。三条容易搞错的事实：

1. **跨文件接线是常态，不是缺陷。** 12 个里 5 个是「属性在一处、hook 在父级」：
   `chats-cal` / `chats-chatlog` / `chats-edited` / `chats-export` 的 hook 都在 `chats-msg-search.tsx`；
   `moments-export` / `moments-viewer` / `moments-detail` 三个都在 `moments-panel.tsx`。
   按「同文件搜 hook」判缺口会得出**全错的结论**（首版审计脚本就是这么误判了 9 个文件）。
2. **自带 `keydown` 监听不算过关。** `chats-media.tsx` 的查看器原有一段
   `if (e.key === 'Escape') onClose()`——能关，但**不进 `escStack`**，之上再叠一层弹窗时一次 Esc 关两层。
   R7 已把它收编到 `useEscapeToClose`，方向键翻页保留。
3. **`chats-contact-info-view.tsx` 是唯一真缺口**，已补。它刻意保持自包含
   （`chats-view.tsx` 已近 M21 上限，接线面最小），所以两条 hook 放在**组件内部**用已有的 `open` 驱动。

新增覆盖层时，**三步都要做**：给容器加 `data-st-dialog="<唯一名字>"`、调 `useEscapeToClose(open, onClose)`、调 `useDialogFocus(open, '[data-st-dialog="<同一个名字>"]')`。名字打错不会报错，只会静默失去焦点管理——所以守卫是**点名的**，不是数数的。

### 表格（`kit-table.tsx`）

```tsx
const columns: DataColumn<Row>[] = [
  { id: 'name', header: '名称', cell: r => <CellPrimary>{r.name}</CellPrimary>,
    sortValue: r => r.name },
  { id: 'size', header: '大小', cell: r => <Mono>{fmt(r.size)}</Mono>,
    sortValue: r => r.size, align: 'right' },
]

<DataTable
  columns={columns}
  rows={page}                        // 当前页，分页由 usePagedList 管
  getRowId={(r, i) => r.id}
  loading={loading}
  emptyTitle="暂无数据"
  onRowClick={openDetail}
  skeletonRows={8}
/>
```

- **排序只作用于已加载页**（`getSortedRowModel`），数据本身仍按后端顺序/分页返回。跨页排序是后端的活。
- 排序中文用 `localeCompare(…, 'zh-Hans-CN', { numeric: true })`——"第 10 条"排在"第 9 条"后面。
- 排序控件是**真 `<button>`**（原来是 `<th onClick>`，鼠标专属）；`<th>` 带 `aria-sort`。
- 整行可点时给 `<tr>` 加 `tabIndex` + Enter/Space，**不加 `role="button"`**（会破坏表格语义）。
- `loading && rows.length === 0` 时渲染骨架行；`rows.length === 0` 时渲染 `EmptyState`（**不是** `ErrorState`——读失败要在调用方就分流）。

### 单元格 / 折叠（`kit-foldable.tsx`）

| 导出 | 说明 |
|---|---|
| `Mono` | 单调字体单元格（md5 / 路径 / 时间戳） |
| `CellPrimary` | 主文本单元格 |
| `useDebouncedValue` | `(value, delayMs = 300)` —— 搜索框配套，**返回防抖值** |
| `FoldableBar` | 向上折叠条（命令式句柄 `expand`/`collapse`/`isOpen`） |

`FoldableBar` 三个非显然实现点（改它之前先读）：
① 高度动画用 `grid-template-rows: 0fr ↔ 1fr` 而不是 `max-height`（后者必须写死上限，前半段空跑）；
② 收起时给内容加 `inert`（否则折叠后输入框仍能被 Tab 聚焦，键盘用户"掉进"看不见的区域）；
③ 展开后要**解除裁剪**（容器为做高度动画必须 `overflow: hidden`，而顶栏搜索下拉是 `position: absolute` 溢出到容器外，继续裁剪会切掉它）。

### 确认框（`confirm.tsx`）

```tsx
const confirm = useConfirm()
const onClick = async () => {
  // 必须在用户事件处理器里 await —— 渲染期/effect 里调会在每次渲染都弹窗
  if (!(await confirm({ title: '删除该记录？', tone: 'danger' }))) return
  await doDelete()
}

// 不可逆批量操作：要求逐字输入
await confirm({ title: '删除并删文件？', tone: 'danger', requireText: '删除' })
```

- **替代 `window.confirm`**：原生弹窗不跟主题、系统标题栏写进程名、阻塞渲染进程、跨平台按钮语义相反、无法标危险级别。
- 没有 `ConfirmProvider` 祖先时**降级**到 `window.confirm`，**不抛错**（组件独立渲染/冒烟测试不会崩）。
- 同一时刻只允许一个确认框：上一次还挂着时先按取消收尾，**否则它的 promise 永不落定、调用方的 `await` 永久悬停**。
- `ConfirmProvider` 挂在主面板最外层，全应用共用一个实例。

---

## 4. 新面板的标准骨架

照这个顺序写，状态层不会漏：

```tsx
import { Card, PanelHeader, Toolbar, SearchInput, DataTable, CellPrimary, Mono,
         EmptyState, EmptyMaybeSyncing, ErrorState, LoadingState } from '../ui/kit.tsx'

export function MyPanel(): React.JSX.Element {
  const { data, loading, error, reload } = useMyData()
  return (
    <>
      <PanelHeader title="我的面板" desc="一句话说清这个面板看什么" />

      {/* ① 错误优先：读失败绝不渲染成"没有数据" */}
      {error && <ErrorState message="加载失败（数据可能不完整）" detail={error} onRetry={reload} />}

      {/* ② 加载态：空格子与空数据必须长得不一样 */}
      {!error && loading && <LoadingState variant="skeleton" rows={6} />}

      {/* ③ 空态：区分"确定没有"与"可能还在同步" */}
      {!error && !loading && data.length === 0 && <EmptyMaybeSyncing text="暂无数据" />}

      {/* ④ 有数据 */}
      {!error && !loading && data.length > 0 && (
        <Card flush>
          <DataTable columns={cols} rows={data} getRowId={(r) => r.id}
                     onRowClick={open} />
        </Card>
      )}
    </>
  )
}
```

**顺序纪律**：`error` 排第一。把加载/空态写在前面的常见后果是"失败时先闪一屏骨架，再变成空列表"。

---

## 5. 已知缺口

| 缺口 | 实测 | 说明 |
|---|---|---|
| **裸 `<button>` 未收敛** | **335** 处（剥注释后；带注释的粗算是 356）vs `Button` 引用 94 处 | 带 **60 个自定义类**，且**几乎全部是「重」类**——它们承担完整视觉（background / border / radius / color / font-size / padding / flex 布局），不是装饰。⚠️ **因此「把 `<button>` 换成 `<Button>`」是错的方向**：类还在，样式没收敛，禁用态也没统一。详见下方「R6 结论」 |
| ~~补 `:focus-visible`~~ | ❌ **R5 的误判，已更正** | `scifi-theme.css` §5 的**元素级全局规则** `button:focus-visible { outline: 2px solid var(--nm-cyan); outline-offset: 2px }` **已覆盖全部 `<button>`**（第 219 行注释写明为此审计过「267 个裸 button」）。逐个类检查会**假阴性**——类规则集里没有，但全局规则生效。**不要重复加** |
| `Tabs` 零引用 | 0 处 | 胶囊标签页——目前面板都用 `Segmented` 或自绘。**不是死代码**（是备用件），但新面板优先用 `Segmented`，除非确实要"标签页 + 内容区"语义 |
| `FoldableBar` 零引用 | 0 处 | 顶栏折叠条，唯一使用方在 `wechat-data` 之外的入口层 |
| `escStack` 直接引用 | 0 处 | 设计如此——外部只用 `useEscapeToClose` |
| 手写弹窗 / 手写表格 | 未统计 | 手写 `role="dialog"` 仍有若干处；`DataTable` 只 3 处引用 |

### R6 结论：按钮收敛该怎么做（2026-09-28）

R5 曾把「裸 `<button>` 356 处」列为下一个收敛重点。R6 核验后**修正了处方**——原方向对，但做法错：

- **方向对**：同一视觉确实分散在 60 个类里（`.catBtn` 45 处 / `.btn` 22 处 / `.chip` 14 处…）。
- **做法错**：把标签换成 `<Button>` 只是套了层皮。真正的收敛是把**类的样式删掉、交给 `Button` 的 variant**——但那会改变视觉（`padding: 4px 12px` → `7px 14px`，按钮高度从 ~22px 涨到 ~30px，在密集列表里是排版变化），属于**设计变更**，需要单独授权。

**R6 实际完成的（零视觉变更）**：4 处禁用态野值统一为 `.5`。

| 文件 | 类 | 前 | 后 |
|---|---|---|---|
| `ai-model.module.css` | `.modelPrimary` | `0.45` | `.5` |
| `ask-history.module.css` | `.dangerBtn` | `0.45` | `.5` |
| `retrieval.module.css` | `.fbBtn` | `0.45` | `.5` |
| `export-history.module.css` | `.opBtn` | `0.32` | `.5` |

**唯一豁免**：`ai-model.module.css` 的 `.profileDel` 用 `.3` —— 它的**基准态本身就是 `.5`**（正常态半透明，hover 提 1），禁用降 `.3` 构成「`.5 → 1 → .3`」的三级关系；改 `.5` 会让禁用态与正常态**撞值**，是倒退。守卫 `button-disabled-tone.wiring.spec.ts` 里有登记与理由。

### R8 结论：按钮「收敛」该按族做，不是全局换组件（2026-09-28）

R6 留的尾巴是「把 60 个自定义按钮类的样式删掉、交给 `Button` variant」。**勘测后判定这个方向不成立**，完整数据见 [`BUTTON-CONVERGENCE-FEASIBILITY.md`](./BUTTON-CONVERGENCE-FEASIBILITY.md)。

实测：`panels/` 下 `<button>` 用到 **81 个 (css,class) 组合**（48 份 css），其中 heavy≥3 的「真按钮」**69 个**。
把它们按几何签名归族后发现——**这不是 60 个同样的按钮，是 6 个语义不同的族**：

| 族 | 形态 | 典型类 | 几何 |
|---|---|---|---|
| A | 胶囊筛选 chip | `.catBtn` `.chip` | `padding:4px 12px` `fs:12px` pill |
| B | 紧凑图标按钮 | `.miniBtn` `.viewerBtn` | `padding:4px 8px` `fs:11px` |
| C | 文字链 | `.linkBtn` `.link` | `padding:0` `border:none` |
| D | **列表行（不是按钮）** | `.rank` `.searchHit` `.msgRow` | 整行高、`width:100%` |
| E | 真·表单按钮 | `.optApply` `.optDismiss` `.loadMore` | `padding:6px 14px` |
| F | 特殊几何（不可统一） | `.send`(44px 圆) `.indexLetter`(15px) | `height` 15→44px |

而 `Button` 只有 6 variant × 2 size。**族 D 换 `Button` 是语义错误**（丢 `width:100%`/`text-align:left`）；
**族 C 换 `ghost` 会凭空多出 28px 高**；**族 F 任何 variant 都表达不了**。只有**族 E 的 8 个**是 `Button` 的真正目标。

**正确形态**：统一的是「同族之间的一致性」，不是「跨族之间的一致性」——
链接不该长得像主按钮，筛选 chip 不该长得像发送键。建议 P1（族 E 换组件，8 个，零位移）
+ P2（族 A 只统一令牌，零高度变化）+ P3（族 C 收成一个 `LinkButton` 薄封装）+ P4（族 F 写明为何不收敛），合计约 2.2d。
**不要**动 69 个全局换组件（族 D 语义错、族 C/F 布局崩）。

**不要做的事**：给那 104 个没有 `:disabled` 的类硬加禁用态。它们绝大多数是列表项/格子（`searchHit` / `calDay` / `indexLetter`），压根不会被禁用；`ask.send` 只设 `cursor: default` 是靠 `[data-busy]` 渐变表达"正在发送"，是设计不是遗漏。**强行统一是假收敛。**

**收敛时注意**：`ui-primitives-shim/` 与 `ui-app/` 的 CSS **不保证宿主加载了 `--nm-*` 令牌**，这两处引令牌**必须带兜底**（`var(--nm-r-pill, 999px)`），口径见 `UI-GEOMETRY-SPEC.md` §2。

### P1 结论：族 E 实测后改「共享几何对齐」，不换组件（2026-09-28）

P1 开工前先逐项核对了「族 E 换 `Button`」的可行性，**结论与 R8 报告的估算相反**——`Button` 不是族 E 的归宿：

| 现有类 | 现状几何 | 换 `Button` 最优解 | 实际位移 |
|---|---|---|---|
| `.optApply` | `6px 14px` / 27px / `1px --nm-cyan` 边 | `pill` | 高 **+2px** |
| `.optDismiss` | `6px 14px` / 27px | `pill` | 高 **+2px** |
| `.optBtn` | `0 12px` / **28px 固定** / pill | `outline sm` | 左右 **-2px**、边框 **1px→0.5px** |
| `chats-cards .loadMore` | `6px 16px` / 27px / pill | `pill` | 高 **+2px**、左右 **-2px** |
| `records .loadMore` | `6px 16px` / 27px / pill | `pill` | 高 **+2px**、左右 **-2px** |

两条硬理由：
1. **颜色语义会丢**：`.optApply` 是**青色次要主操作**（`--nm-cyan-10` 底 + `--nm-cyan-text` 字 + `1px --nm-cyan` 边），`Button` 的 6 个 variant 里**没有一个表达它**（`primary` 是 dsw 品牌色、`outline` 是无底透明）。
2. **没有一种变体能零位移对接**（见上表，逐一算过）。

**P1 实际做法 = 族 E「共享几何对齐」**：五个类统一到
`padding: 6px 14px` / `border-width: 1px` / `border-radius: var(--nm-r-pill)` / `font-size: 12px`，
**颜色语义各自保留**。落实的是「同族内一致」——

| 类 | 改了什么 | 像素变化 |
|---|---|---|
| `ask.module.css .optApply` | `border-radius` `--nm-dense-r`(8px) → `--nm-r-pill` | 圆角 8px → pill |
| `ask.module.css .optDismiss` | 同上 | 圆角 8px → pill |
| `chats-cards.module.css .loadMore` | `padding: 6px 16px` → `6px 14px` | 左右 **-2px** |
| `records.module.css .loadMore` | 同上 | 左右 **-2px** |

**`.optBtn` 是登记在案的豁免项**：它用 `height: 28px` 固定高，且 `@media (max-width: 680px)` 里抬到 `36px`
—— 那是 **WCAG 2.2 SC 2.5.8 的触屏手指标**（相邻目标 ≥24px），**无障碍设计意图**，不是随手写的值。
另注：`.optBtn` 所在的 `.composerFooter` 与 `.optApply`/`.optDismiss` 所在的 `.optActions`
**不是同一个容器**，它们本来就不需要对高。

守卫：`panels/button-family-e-align.wiring.spec.ts`（3 例）—— 点名五个成员 + 四项几何一致 +
豁免项反例自证（`.optBtn` 必须**仍然**是固定高、窄屏 36px 覆盖规则必须在）。

### P2 结论：族 A 真 chip 只做「裸值→令牌」，不动 padding（2026-09-28）

P2 原计划是「族 A（~18 个 chip）统一令牌」。勘测后发现**族 A 本身要先重新定义**：

按 `border-radius: pill` 粗筛得到 **29 个**类，但其中 **14 个不是 chip**（是 P1 的族 E 独立按钮、
列表项、清除按钮等）。**真正的硬判据是「有没有选中态」**（`[data-active]` / `[data-on]` /
`[data-dim]` / `[data-set]` / `[data-custom]`）—— 这是「可选中筛选标签」与「普通按钮」的分界。

**真 chip = 15 个**：`ctxChip` `exportChip` `catBtn`(contacts) `tabBtn` `chip`(graph)
`detailChip` `segBtn`(graph) `modelChip` `chip`(kbfiles) `tagChip` `catBtn`(list-panel)
`authorChip` `segChip` `chip`(monitor) `fbBtn`

实测它们的几何离散度**远超预期**：

| 维度 | 实测 | 处置 |
|---|---|---|
| `border-radius` | **15/15 全是 `var(--nm-r-pill)`** | **已统一**（R2 完成），本轮只加守卫 |
| `font-size` | 4 种（`12px`×9 / `--nm-dense-fs-sm`×3 / `11px`×2 / `--nm-dense-fs-xs`×1） | ✅ **本轮收敛**（见下） |
| `padding` | **9 种签名**（`4px 12px`×6 / `2px 8px`×2 / `0 12px` / `3px 8px` / `4px 6px` / `6px var(--nm-dense-g3)` / `4px 13px` / `4px 14px` / `0 8px`） | ❌ **不动**（见下） |

**本轮只收敛 11 处裸字号**（逐字节等价）：

| 改动 | 处数 | 依据 |
|---|---|---|
| `font-size: 12px` → `var(--nm-fs-sm)` | 9 | `--nm-fs-sm` 的值**就是 12px** |
| `font-size: 11px` → `var(--nm-dense-fs-sm)` | 2 | `--nm-dense-fs-sm` 的值**就是 11px** |

postcss 逐条核过：声明改为令牌后**计算值仍是 12px / 11px**，`EQUIV-OK` ⇒ **零像素变化**。

**为什么 padding 不动**：那 9 种签名**不是随手写的**——是按内容与容器调的
（`2px 8px` 给标签小片、`4px 12px` 给筛选条、`6px var(--nm-dense-g3)` 给模型条）。
跨面板拉齐会**改 6 处高度**，属**设计变更**，需单独授权。同理 `font-size` 的
**跨档拉齐**（10/11px → 12px）也是视觉变更，不在本轮。

**为什么这种「等价但不一致」的漂移必须用守卫钉**：裸 `12px` 与 `var(--nm-fs-sm)`
渲染**一模一样**，**没有任何视觉回归能发现有人把令牌换回裸值**。

守卫：`panels/button-family-a-chip-token.wiring.spec.ts`（3 例）—— 15 个真 chip 点名存在 +
圆角必须仍是 pill + `font-size` 必须是 `var(--nm-…)`（**且不许带裸值 fallback 兜底**）+
令牌等价性前提（`--nm-fs-sm` 必须仍是 12px、`--nm-dense-fs-sm` 必须仍是 11px，否则
「零视觉变化」的前提被破坏，必须重新评估）。

**P4 已完成** → 见下节「[P4 结论](#p4-结论族-f-分三支两支有正当理由不收敛一支只差一个-token2026-09-28)」（纯文档，零代码改动）。

---

### P3 结论：族 C 收成 `LinkButton` 薄封装，六份 CSS 合并到 kit（2026-09-28）

**族 C 的定义**：长得像链接的原生 `<button>`——无内边距、无边框、无背景、青色字、hover 下划线。
判据是「`padding: 0` + `border: none` + 无背景 + `cursor: pointer` + 字色 `--nm-cyan`」五项齐全。
按 pill 圆角或「padding 以 0 打头」粗筛会把族 A/E/D/F 全卷进来（实测 34 条候选），必须五项一起判。

**实测规模 = 6 个类 / 8 处调用点**（R8 估「~6 个类」，吻合）：

| 模块 CSS | 类 | 调用点 |
|---|---|---|
| `chats-cards.module.css` | `.exportLinkBtn` | `chats-export-dialog.tsx` ×2 |
| `contacts.module.css` | `.linkBtn` | `Contacts.tsx` ×1 |
| `knowledge-base.module.css` | `.linkBtn` | `KnowledgeBase.tsx` ×1 |
| `records.module.css` | `.link` | `Ledger.tsx` ×1 + `Records.tsx` ×1 |
| `storage.module.css` | `.linkBtn` | `Storage.tsx` ×1 |
| `tasks.module.css` | `.linkBtn` | `Tasks.tsx` ×1 |

> 勘测更正：开工前按类数成 8 处（写初版守卫时误记为 9），**哨兵断言实测得 8** 才拦住。
> 逐处复核：2+1+1+1+1+1+1 = 8。**这是「点名表必须配下限」的又一次实战价值**。

**为什么 `LinkButton` 不能复用 `Button`**：`Button`（外部包 `dsh-client-ui-primitives`）只有
6 variant，**全都带内边距与固定高**（`ghost` 36px / `sm` 28px）。族 C 用在表格单元格
（`Records` / `Ledger` / `Storage`）与「说明 + 操作」行（`KnowledgeBase` / `Tasks`）里，
多出来的高度会撑开行、顶掉滚动位置。`padding: 0` 是**语义**（随文字流），不是忘了设。
所以 `LinkButton` 与 `Button` **平行**，只共享 kit 的导出面。

**收敛形态**：
- **唯一定义点** = `ui/kit.module.css` 的 `.link`（`padding:0` / `border:none` /
  `background:none` / `color:var(--nm-cyan)` / `font-size:var(--nm-fs-sm)` / `cursor:pointer`）。
- **组件** = `ui/kit-fields.tsx` 的 `LinkButton`（经 `kit.tsx` 的 `export *` 转发）。
  内置 `type="button"`——八个调用点原来都没显式写，裸 `<button>` 在 `<form>` 内默认
  `type="submit"`，收敛顺带堵掉这个隐患；其余原生属性（`title` / `disabled` / `aria-*`）一律透传。
- **六份模块 CSS 的族 C 类全部删除**。

**顺带做的视觉统一**（用户 2026-09-28 裁决「统一为纯下划线」）：hover 原来有三套花活
（`contacts` 变紫 + 青色 `text-shadow`、`records` 加 `text-shadow`、其余只下划线），
现统一为**纯下划线**——符合 `PRECISION MATRIX`「去掉装饰性发光，视觉预算投给层级」。
另 `font-size` 现状 11/12px 混用，统一到 `var(--nm-fs-sm)`（12px）。

`build:ui` CSS **460.06 → 458.92 kB（-1.14 kB）** —— 删 6 份重复样式、只留一份的净效果。

**为什么这必须用守卫钉**：若哪天有人在某个面板手写回 `<button className={css.linkBtn}>`，
视觉上几乎看不出（都是青色小字），但族 C 就重新分叉了——**没有视觉回归能守**。

守卫：`panels/button-family-c-link.wiring.spec.ts`（**17 例**）—— 组件体三项（渲染 `<button>` +
挂 `css.link` + 内置 `type="button"`）/ `.link` 六项几何 + hover 纯下划线（**不得含
`text-shadow`**）/ 6 个类必须已退役 / 8 处调用点按**次数**点名 / 全仓不得再有
`css.exportLinkBtn` `css.linkBtn` 属性访问。**变异 9/9 RED-OK，全部逐字节还原。**

---

### P4 结论：族 F 分三支，**两支有正当理由不收敛，一支只差一个 token**（2026-09-28）

> R8 的族表把族 F（特殊几何）记为「~19 个，**不可统一**」。
> 实测后这个措辞**太粗** —— 它也**没点名**，读者无从判断"哪些是真不能动、哪些只是还没动"。
> 逐条核验后是**三支**，各有不同的结论。

**先说勘测剔除的 3 条**（R8 的几何判据会误收）：

| 被误收的 | 真实性质 | 为什么不是族 F |
|---|---|---|
| `kbfiles.switchBox`、`export-history.pick` | `<input type="checkbox">` | **根本不是 `<button>`**，是表单控件（`pick` 还带 `appearance: none` 自绘） |
| `moments.monthFill` | 柱状图的**柱子**（`min-height: 2px` + 渐变填充） | 数据可视化元素，`cursor: pointer` 只是"可点选中"，不是操作按钮 |
| `retrieval.markToggle` | 有 `[data-on="useful"]` / `[data-on="useless"]` 选中态 | **属族 A chip**，已被 P2 覆盖 |

#### 支 F1「内嵌 icon 按钮」—— 尺寸由**宿主**决定，本来就不该统一

13 处共享 `--nm-r-sm` 圆角与「边长=高度=宽度」的正方形形态，但**边长跨 7 档**：

| 类 | 边长 | 由谁决定 |
|---|---|---|
| `global-search.clear` | 16px | 搜索框内右侧清除（框高 28） |
| `ai-model.profileDel` | 18px | 塞进 `.profileChip` 的**右上角**（`position: absolute; top: 4px; right: 4px`） |
| `graph.noteEdit` / `.noteDel` | 20px | 笔记行内操作（行高约 24） |
| `notice.close` | 20px | 顶部通知条（条约 40px 高） |
| `kb-rail.addBtn` / `.rowBtn` | 22px | 知识库侧栏的**窄栏**（栏宽 44） |
| `ai-model.keyEye` / `session-ask.iconBtn` / `moments.videoActBtn` | 26px | 输入框内眼睛 / 输入区图标 / 视频浮层按钮 |
| `list-panel.lightboxClose` | 30px | 全屏灯箱关闭 |
| `chats-contact-info.close` | 32px | 抽屉级关闭（抽屉宽 480） |

**为什么不收敛**：这些按钮的边长**不是自由值，是宿主的约束**。`profileDel` 做到 22px 会盖住
`profileChip` 的文字；`rowBtn` 做到 26px 会撑破 44px 宽的侧栏；`keyEye` 做到 30px 会顶坏
`padding-right: 34px` 那条为它留的位。**统一尺寸 = 逐个改宿主布局**，属设计变更且收益为负。
（这正是 R8 §3 说的「离散度 `height` 从 15px 到 44px，近 3 倍」的真正来源 —— 不是随手写的。）

**已经统一的部分**：`border-radius` 13 处里 11 处是 `--nm-r-sm`（另 2 处：`.clear` 用 `50%`
是因为它是**圆形**清除键、两个 `.close` 用 `--nm-dense-r` 是因为它们**带边框**，圆角档位跟着边框走）。

#### 支 F2「独立圆形按钮」—— 三档尺寸，**刻意不同**

| 类 | 尺寸 | 为什么是这个数 |
|---|---|---|
| `session-ask.send` | 32px | 输入区内的发送键，与 `.iconBtn`（26）同排，略大以突出主操作 |
| `ask.send` | 44px | 会话问答的**主发送键**，44px 是触屏拇指热区的常用下限 |
| `moments.backTop` | 46px | 浮动回顶键（`position: fixed`），要在内容之上被一眼看到 |

三处 `border-radius` 都是 `50%`（**已是同一语义**）。尺寸差异是**主次层级**的表达 —— 统一成 44 会让
输入区那枚撑破行，统一成 32 会让主发送键失去分量。**不收敛。**

#### 支 F3「覆盖层关闭键」—— **唯一真正可收的一支，但只差一个 token**

| 类 | 尺寸 | 圆角 | 语境 |
|---|---|---|---|
| `list-panel.lightboxClose` | 30px | `--nm-dense-r`（8px） | 全屏灯箱 |
| `chats-contact-info.close` | 32px | `--nm-dense-r`（8px） | 抽屉（480px 宽） |

**这两个 30 / 32 之间没有功能理由**，只是两处各写了一遍。**但它们已经共用同一个圆角 token**，
差别只有 2px 边长 —— 而边长在本仓**没有对应 token**（设计系统只定了圆角与间距，没定控件尺寸档）。

**结论：不动。** 理由有二：
1. **2px 边长差在两种完全不同的容器里，用户不可能并列看到** —— 没有一致性收益。
2. 硬要收，就得先**新增一组控件尺寸 token**（本仓目前没有这个层）。那是更大的设计决策，
   不该由一个"按钮收敛"任务顺手引入。**若要收，单独立项。**

#### 一句话版（给以后翻这份指南的人）

> 族 F 不是"乱"，是**三种不同的约束**挤在一个族名里：
> F1 尺寸由宿主定（**改了会坏布局**）、F2 尺寸表达主次层级（**改了会丢语义**）、
> F3 只差 2px 且**没有 token 可用**（**改了要有新设计决策**）。
> 三支都不该在"按钮收敛"里动 —— 但**圆角已经统一**，那是它们真正共享的东西。

## 6. 守卫清单（改 kit 前先看这个）

| 守卫 | 钉什么 |
|---|---|
| `ui/state-components.wiring.spec.ts` | 错误态的 红框 + `role="alert"` 绑定；加载态三档不复用空态视觉；全仓不得各自造错误样式；长任务必须有真进度；列表空态必须有占位 |
| `panels/button-disabled-tone.wiring.spec.ts` | **R6 新增**：已声明 `:disabled` 的按钮类，透明度和必须是 `.5`（例外须在表里登记理由）；豁免表不得腐化；全局 `button:focus-visible` 规则必须存在 |
| `panels/dialog-a11y.wiring.spec.ts` | **R7 新增**：每个手写 `role="dialog"` 覆盖层，`data-st-dialog` 属性 + `useEscapeToClose` + `useDialogFocus` **三者齐全**（跨文件按名字配对）。判据钉在**调用点**上（`/[^A-Za-z0-9_$.]useEscapeToClose\s*\(/`），只在 `import` 里出现不算 |
| `panels/button-family-e-align.wiring.spec.ts` | **P1 新增**：族 E 五个成员点名存在 + 参与对齐的四个类 `padding`/`border-width`/`border-radius`/`font-size` 四项一致 + 豁免项 `.optBtn` 的固定高与窄屏 36px 覆盖规则**必须在**（防被顺手改掉） |
| `panels/button-family-a-chip-token.wiring.spec.ts` | **P2 新增**：15 个真 chip 点名存在 + 圆角必须仍是 `var(--nm-r-pill)` + `font-size` 必须是 `var(--nm-…)` **且不许带裸值 fallback** + 令牌等价性前提（`--nm-fs-sm`=12px / `--nm-dense-fs-sm`=11px 不得被改） |
| `panels/button-family-c-link.wiring.spec.ts` | **P3 新增**：`LinkButton` 组件体（渲染 `<button>` + 挂 `css.link` + 内置 `type="button"`）+ `.link` 五项「无」与青色字、字号走令牌 + hover 必须纯下划线（**不得含 `text-shadow`**）+ 6 个已退役类必须不在模块 CSS 里 + 8 处调用点按**次数**点名 + 全仓不得再有 `css.exportLinkBtn`/`css.linkBtn` 属性访问 |
| `panels/world-map-data.gate.spec.ts` | **P2 时修**：地图底图出网闸的三层口径（新鲜镜像直接采信 / 过期回问后端 / 拿不到真值按旧副本兜底）。该文件原来用**真墙钟**量新鲜期，全量跑（CPU 打满、`await` 间隔超 15s）时会假红 ⇒ 已改 `vi.useFakeTimers({ toFake: ['Date'] })` 冻结时钟。**纪律：凡"时间边界"用例一律冻结时钟，不要赌 `seed` 与判定之间的墙钟间隔** |
| `ui/kit-css-split.wiring.spec.ts` | kit 的 CSS 只能被 `ui/` 下文件引用（**别新建 CSS 文件**） |
| `ui/confirm.pointer.spec.ts` | 确认框的指针/键盘通路 |
| `ui/fold-idle.spec.ts` | `FoldableBar` 的空闲状态机 |
| `panels/u14-empty-state.wiring.spec.ts` | 空态组件的使用点（抓到过"删样式导致悬空类名"的真 bug） |
| `panels/read-error-visibility.spec.ts` | 读失败不得渲染成"没有数据" |
| `tests/function-size-ratchet.spec.ts` | 文件行数棘轮（kit 各文件也在内） |
| `tests/mutation-registry-anchors.spec.ts` | 全部变异锚点恰好命中 1 次 |

**改 kit 的纪律**：守卫先行 → 变异自证（锚点唯一 / 必须变红 / **逐字节还原**）→ 收口跑 `typecheck`(5 份) + `vitest` + **`build:ui`（强制）** + `build:backend` + `build:types`。
两个已踩过的坑：① 钉"必须调用某函数"要用**调用点**正则 `/<Name\b/`，`toContain('Name')` 会被 import 行命中而恒真；② 守卫扫描前必须 `stripComments`，否则注释里的类名会造成假阳性。
