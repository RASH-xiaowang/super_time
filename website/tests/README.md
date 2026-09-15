# 官网冒烟测试 + 响应式契约验证

对 `website/index.html`（单文件官网）做两件事：

1. **DOM 冒烟** —— 真实 DOM + 桩（canvas / IntersectionObserver / matchMedia），把 JS 代码路径真跑一遍。
2. **响应式契约** —— 解析真实 CSS 级联（含媒体查询求值），对 22 个分辨率做盒模型算术校验。

## 运行

```bash
cd "C:/Users/Administrator/.workbuddy/binaries/node/workspace"
NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
"D:/super-time-wechat/website/tests/smoke.js"
echo "EXIT=$?"
```

- **退出码 0 = 全绿**；明细见 `tests/smoke.log`（UTF-8，直接 Read 查看）。
- 依赖 jsdom 30.x，已装在托管 node 工作区，无需重装。

## 基线

| 项 | 值 |
|---|---|
| 断言数 | 203 |
| 结果 | ALL GREEN（0 失败） |
| 执行遍数 | 4（A 降级 / B 完整@1280 / C 完整@375 / D 触摸@768） |
| 覆盖分辨率 | 22（320 起至 2560） |
| 最近执行 | 2026-09-15 |

## 为什么不用真实浏览器量像素

本机**没有任何浏览器内核**（`Program Files` 下无 Chrome/Edge，`ms-playwright` 缓存不存在，
项目 `node_modules` 无 playwright），jsdom 又**不含布局引擎**。所以布局验证改为两条可复现路径：

- **A/B/C/D 四遍 DOM 执行**：用桩把 canvas、`IntersectionObserver`、`matchMedia` 补上，
  让粒子渲染循环、滚动揭示、hover 分支的真实代码都跑起来。这一条抓到过硬伤 ——
  详见"捕获过的缺陷"。
- **CSS 级联解析 + 盒模型算术**：自己实现 `@media` 求值与 `clamp()/min()/max()` 求值，
  对每个分辨率算出容器内宽、列宽、文本所需宽度，断言不溢出。汉字按 1em、等宽数字按 0.62em 计。

## 覆盖的能力

| 段 | 内容 |
|---|---|
| A | 骨架 / viewport 元信息 / 导航与抽屉 / 粒子 / 数字滚动 / 分页 / FAQ / 表单校验 / 运行时错误 |
| B C D | 完整分支（画布 + IO + 精确指针 / 窄屏 / 触摸），断言粒子循环执行、揭示全生效 |
| E | 12 个断点与关键规则存在性；防溢出写法；`>320px` 硬宽只允许装饰层；前缀成对；括号配平；**汉堡按钮几何契约**；**方案 B 身份契约**；**对比度无障碍（WCAG 3:1）**；**导航高度与抽屉偏移一致性** |
| F | 22 个分辨率的排版算术；容器宽度单调性；H1 字号在断点处无 >4px 突变 |

## 捕获过的缺陷（回归护栏，勿删对应断言）

| 缺陷 | 症状 | 对应断言 |
|---|---|---|
| `narrow` 在 `build()` 内 `var` 声明、`draw()` 读取 | **真实浏览器首帧 ReferenceError，粒子循环直接死掉** | B/C/D：`粒子渲染循环真实执行（clearRect × N）` |
| `getContext('2d')` 无兜底 | IIFE 中断，其后注册的回到顶部/表单监听全部静默失效 | A3：`拿不到 2D context 时隐藏画布` |
| `new IntersectionObserver` 无特性检测 | 同上，脚本中断 | A5：进度条仍被填充 |
| `@media` 断点在 900–1080px 之间导航溢出 | 7 链接 + 2 按钮 ≈ 977px，该区间横向溢出 | E：`max-width:1024px` 含 `.nav-links{display:none}` |
| `<br class="hide-sm">` 有类无样式 | 手机上被强制换行 | E：`max-width:980px` 含 `.hide-sm{display:none}` |
| `clamp()` 下限超出 320px 容器 | hero 标题在超小屏溢出 | F：`Hero 标题最长行 ≤ 文本列宽` |
| 只写 `-webkit-backdrop-filter`（或只写标准） | iOS 15–17 Safari 毛玻璃失效 / 其它内核失效 | E3：`标准与 -webkit- 版本成对` |
| **`.burger` 用 `display:grid` 且未写 `grid-template-rows`** | **`align-content:normal`(=stretch) 把三行 auto 行拉伸成 42÷3 = 14px，杠距被撑到 14px，我写的 `margin-top:4.5px` 被完全吞掉；三条杠从"紧凑三横"变成飘散的虚线** | E4：`杠长/盒宽 ∈ [45%,55%]`、`杠距/杠厚 ∈ [2,3]`、`三杠总高/盒高 ∈ [35%,45%]`、`无被行拉伸吞掉的无效 margin-top` |
| **展开态位移按错误杠距写死** | **`.on` 用 `translateY(6px)`（按 6px 杠距算），实际杠距 14px → 点开后三杠合不拢，组不成 X** | E4：`展开态位移与布局同源引用变量`、`两杠位移方向相反`、`位移不再写死数字` |
| **抽屉 `top:66px` 与实算导航高度 73px 不符** | **导航实高 = 按钮 42 + 内边距 14×2 + 边框 1 + 进度条 2 = 73px，硬编码 66px 导致抽屉顶部被导航盖住 7px** | E5：`--navh 与实算导航高度一致`、`抽屉 top 引用 --navh`、`无遗留的 66px 硬编码` |
| 汉堡按钮配色换方案时漏改触摸分支 | 触摸设备下悬停会粘滞，若不还原会把渐变覆盖成纯白 | E4b：`三杠用品牌渐变而非纯白`、`#bff3ff 仅剩 hero 打字机在用` |

## 已知提示（非缺陷）

- 日志里的 `NOTE ... getContext()` 是 jsdom 未实现 canvas 所致，页面侧已兜底。
- jsdom 里 `getBoundingClientRect()` 全返回 0；B/C/D 遍已把它桩成指定视口尺寸，
  但**桩不等于渲染**，像素级版式仍以人眼/真机为准。

## 改动官网后的自检

1. 抽出 `<script>` 跑语法检查：
   ```bash
   cd "D:/super-time-wechat/website"
   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" -e \
     "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');fs.writeFileSync('tests/_extracted.js',h.match(/<script>([\s\S]*?)<\/script>/)[1]);"
   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" --check tests/_extracted.js
   ```
2. 重跑本测试，确认退出码 0。
3. 删除 `tests/_extracted.js`。

> **改同一文件多处时**：同一条消息里对同一文件发多个 Edit 会互相覆盖（都报 success，只有一个落盘）。
> 本目录改造时用的是「带断言的 Python 批量替换脚本」——每处 old 必须恰好命中 1 次，任一不命中整体不写盘，
> 写完立刻回读校验。脚本已删除，需要时按此模式重写。
