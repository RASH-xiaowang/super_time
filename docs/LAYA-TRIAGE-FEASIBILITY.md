# laya 决策引擎接入可行性调研与 PoC 验证（v2）

> 需求出处：界面优化计划阶段 5——「调研在微信聊天界面接入 jev 或 laya 的可行方案，对比优劣后确定技术方案」。
>
> **目标形态**（用户提供截图）：微信聊天界面里，每轮对话的对方消息下方跟随一张决策分析卡，四块内容——
> 命题真假概率（「她真的在问『你记不记得』吗？ 是 7% / 不是 93%」）、真实意图分布（「想确认你在不在乎她 72% /
> 单纯考验记忆力 8% / 生气想吵架 20%」）、危险等级评分（9/10）、最佳动作分布（「搜索聊天记录 91% / 硬猜 4% /
> 转移话题 1% / 装死 4%」）。
>
> **结论（v2，已实测）**：三者全部通过——ONNX 导出、onnxruntime 数值一致性、Node/Electron 侧完整复现均已验证，
> 与 Python 侧**逐 token、逐概率一致**。打包版「无 Python」的硬伤已解除。**建议立项实施**。
>
> **v1 结论作废**。v1 推荐「不集成，只交付报告 + 接口预留」，理由是「ONNX 转换可行性未验证、失败即全损」。
> 实测推翻了该假设：导出一次成功（4.7 s），精度一次性对齐（端到端偏差 0.00e+0）。v1 的保守判断在缺少实测
> 证据时是合理的，但现在是错的。

## 1. 目标形态与 laya 原语的对应

截图那张卡不是四个独立功能，而是**一次 `predict()` 调用的结果**——laya 的三种决策原语正好覆盖四块内容：

| 截图里的块 | laya 原语 | 返回结构 |
|---|---|---|
| 「她真的在问…吗？ 是 7% / 不是 93%」 | `noul`（0-1 概率判断） | `{ noul: 0.93, confidence }` |
| 「当前真实意图 / 想确认你在不在乎她 72%…」 | `choice`（带 criteria 的多选一） | `{ choice, probabilities: {选项→概率}, confidence }` |
| 「危险等级 9 / 10」 | `score`（分级打分） | `{ score, legend, probabilities }` |
| 「最佳动作 / 搜索聊天记录 91%…」 | `choice`（同上，第二个问题） | 同 choice |

即：**一张卡 = 一组 questions（若干 noul + 若干 choice/score）→ 一次并行 forward → 一组概率**。
没有生成式成分，没有 LLM 调用，没有逐 token 解码。

## 2. 三重 PoC 与实测数据

### 2.1 PoC-A：questions 设计与真实输出（`D:\laya\demo_zh_chat.py`）

用截图里的原始对话逐轮推进（每轮 state 只含到该轮为止的真实历史），5 个中文命题一次调用：

```
【第 2 轮】最新一句：那你说。
  ① 她真的在字面提问吗？    不是 56%  /  是 44%
  ② 当前真实意图
       keep_talking      59.8%
       memory_test       27.2%
       care_check         6.5%
       want_fight         3.4%
  ③ 紧张/危险程度：3.0 / 10
  ④ 最佳动作
       answer_directly   75.9%   admit_and_apologize 10.8%   ask_back 7.5%
  ⑤ 应该立刻回复吗？     是 81%  /  否 19%
```

**结构与截图同构**，说明「一张卡 = 一次调用」的形态成立。延迟 412–563 ms（冷启动首帧）。

### 2.2 关键发现：问法决定锐利度（`D:\laya\demo_zh_chat_v2.py`）

PoC-A 的分布比截图温和得多（截图是 93:7、91:4 这种锐利分布）。同一段对话跑三组问法对照：

| 问法组 | 结果 | 锐利度 |
|---|---|---|
| G1 宽泛 choice（5 选项含 other） | Top1 `keep_talking` **59.8%**，熵 1.06 | 分散 |
| G2 聚焦 noul 二值命题 ×4 | `is_testing` 0.885 / `is_upset` **0.030** / `is_care_about` 0.846 / `has_data` 0.056 | **0.69–0.94（与截图同量级）** |
| G3 混合（noul + 收紧 choice 去 other） | `is_upset` 0.030 / choice Top1 59.4% / score 2.73 | 中等 |

**结论：截图那种锐利分布来自「聚焦的二元命题」，不是模型天然输出。** 产品设计的第一原则由此确定：
questions 要写成一串**聚焦命题**（「这句话是在测试对方吗？」），而不是一个**宽泛分类题**（「说话人真正想干什么？」
5 选 1）。这是一条纯设计约束，不需要改模型。

同时实测：**预热后单次 74–228 ms**（首帧 450 ms 是冷启动），即冷启动只影响进程启动后的第一次调用。

### 2.3 PoC-B：ONNX 导出与数值精度（`D:\laya\poc_onnx_export.py`）

`DecisionModel.forward` 是 5 张量进、2 张量出的**纯标准算子**图（HF encoder + TransformerEncoderLayer 头 +
Embedding/LayerNorm/Linear/gather/masked_fill/softmax/topk），temperature 缩放与 argmax 全在 Python 侧后处理
（`agent.py:325-362`），不在计算图里——这正是它能干净导出的原因。

| 项 | 实测 |
|---|---|
| torch.onnx.export | **成功**，4.7 s，opset 17 |
| 产出 | `laya-decision.onnx` **1228.6 MB**（fp32） |
| torch vs onnxruntime logits | 最大绝对偏差 **3.10e-06** |
| 端到端答案（choice Top1 / score / noul） | **偏差 0.00e+00，Top1 一致** |
| onnxruntime CPU 推理 | 208 ms（torch 180 ms，同量级） |

> 踩坑记录：首版脚本报「模型输出偏差 3e-6 但答案差 0.46」，看起来像 ONNX 精度问题。真因是脚本自己构造
> 输入张量时 state 传了裸字符串，而比对基准用 dict——`serialize_state()` 对 str 原样返回、对 dict 走
> `json.dumps`，两者 token 序列根本不同。**这类「两次输入不是同一个」的假警报在跨语言移植时最耗时间**，
> PoC-C 因此把「逐 token 比对 Python 的序列」设成第一道断言。

### 2.4 PoC-C：Node/Electron 侧完整复现（`D:\laya\poc_c_node.mjs`）

打包版是纯 Node + Electron，所以真正的门槛在 JS 侧。三个环节全部复现：

| 环节 | 结果 |
|---|---|
| tokenizer（`@huggingface/transformers` 加载同一份 `tokenizer.json`） | 特殊 id 与 Python 一致（cls 2 / sep 1 / mask 4 / pad 0 / unk 3） |
| `build_sequence` + `collate` 的 JS 复刻 | **逐 token 相同**：79 / 105 / 137 tokens 三例全等，marker 位置全等 |
| onnxruntime-node 模型加载 | 1.5 s |
| onnxruntime-node 推理 | 228 ms |
| 与 torch 输出偏差 | logits 3.10e-06 |
| **JS 后处理 vs `laya.predict`** | **完全一致**：noul 0.0305、choice Top1 + 四选项概率、score 3.5634 全部 0 偏差 |

**这意味着 Electron 里可以直接跑完整链路**：JS tokenizer → ONNX 推理 → JS 后处理（纯 softmax，因为该
checkpoint 的 `temperature` 全为 1.0，无需实现温度缩放）。

### 2.5 体积代价（实测）

| 项 | 体积 | 处理 |
|---|---|---|
| `onnxruntime-node` 包 | 287.3 MB（**含全平台** linux/darwin/win32 × x64/arm64） | 必须按平台裁剪，`build.files` 白名单只放当前平台 |
| — win32/x64 推理必需 | **27.7 MB**（`onnxruntime.dll` 27.4 + binding 0.3） | 进 asarUnpack（与 koffi 同款机制） |
| — win32/x64 可裁 | 36.4 MB（`DirectML.dll` 17.7 + `dxcompiler.dll` 17.2 + `dxil.dll` 1.5，均为 GPU 用） | 排除 |
| `@huggingface/transformers` | 9.4 MB（含 wasm 等） | 可只保留 tokenizer 路径；或改用更轻的 tokenizer 方案（见 §6） |
| 模型 | 1228.6 MB（fp32 ONNX） | 走首启下载，不进安装包；可量化到 fp16（约 614 MB） |

对比 v1 里被否掉的「捆绑 Python runtime（+100 MB）」：ONNX 路线的打包代价是 **约 28 MB 外挂**（+ 模型首启下载），
且复用 whisper 已有的「可选组件首启下载」机制（`downloadWhisperModel`，流式 + 原子发布）。

## 3. 接入 Super Time 的设计

### 3.1 运行时分层

```
前端（分析卡）
   ↕ Remote
后端 gateway（@Remote analyzeMessages）
   ↕
本地推理 provider（纯本地，不过出网闸门）
   ├── LayaOnnxProvider（默认，模型已下载时）—— onnxruntime-node + JS tokenizer
   └── RuleProvider（兜底，模型未下载/加载失败）—— 零依赖启发式
```

与 `reply-suggest` 的分工不变：laya 做**判断**，LLM（现有 suggestReplies 通道）做**生成**。两者互补，
不互相替代——laya 得出的「最佳动作 = 先搜索聊天记录 91%」甚至可以反过来触发 Super Time 自己的搜索能力。

### 3.2 questions 预设（中文，按 §2.2 的「聚焦命题」原则设计）

```ts
// 每条命题都是聚焦判断，避免宽泛分类（实测：宽泛 5 选 1 的 Top1 只有 ~60%）
{
  literal_question:  noul   「最后一句话是在字面意义上真的提问或要求吗？」
  is_testing:        noul   「最后一句话是在测试对方记性，而不是真想获取信息吗？」
  is_upset:          noul   「最后一句话，说话人此刻不高兴吗？」
  real_intent:       choice 「真正的意图是什么？」{care_check, memory_test, want_fight, keep_talking}
                             // 不给 other：实测 other 会白吃掉概率质量
  tension:           score  「此刻局势的紧张程度」0–10（11 档，中文 legend）
  best_action:       choice 「最该做的动作」{search_history, answer_directly, admit_and_apologize, ask_back}
}
```

### 3.3 前端分析卡

- 位置：会话内消息流，对方消息下方（可折叠），或「聊天信息」抽屉里按需触发
- **默认不自动全量跑**：228 ms/次 × 每条消息 = 不可接受。方案是按需（点某条消息的「分析」按钮）或对最新 N 条
- 视觉：沿用 `docs/compose/spec/wechat-message-visual-system.md` 的既有消息区体系 + UI-GEOMETRY-SPEC 的令牌
  （不新造圆角/间距字面量，几何守卫零容忍）
- 概率条：`choice` 的 probabilities 以横条 + 百分比呈现；`noul` 以二元对照；`score` 以 0–10 刻度

### 3.4 隐私

laya 推理**完全本地**，不经过 `privacyGate` 的出网闸门（那是 LLM 通道的咽喉）。模型加载与推理不产生网络
请求；模型下载走用户显式确认的可选组件流程。这一点比「接 LLM 做判断」有实质优势：零 API 成本、零出网、
分析结果不离开本机。

## 4. 实施计划（分期，每期可独立验收）

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 资产入仓** | `tools/laya/`：导出脚本（Python，一次性运行）、`questions.zh.ts` 预设、JS `buildSequence` 复刻 + 单测（**逐 token 对齐 Python 的 fixture**） | 单测绿；fixture 由 Python 侧 dump 生成并入仓 |
| **P1 后端运行时** | `onnxruntime-node` 依赖（`build.files` 加白名单，仅当前平台）、模型首启下载（复用 `downloadWhisperModel` 机制）、`LayaOnnxProvider` + `RuleProvider` 兜底、`@Remote analyzeMessages`、`build:backend` + `build:types` + `docs:api` | 新增 spec：模型缺失时 fail-open 到规则兜底；Remote 计数同步（163→164，三处） |
| **P2 前端分析卡** | 消息旁卡片组件 + 几何全令牌 CSS + wiring spec + 与 `notes-events`/`search-events` 同款的触发通道 | typecheck / build:ui / check:wx-tokens（消息区零误伤）/ ui:smoke |
| **P3 打包关** | onnxruntime 平台裁剪、asarUnpack、`package-content-rules.js` 上界复核、打包冒烟（真实加载模型推理） | 打包产物里真跑一次推理；asar 仍在上界内 |

**建议先做 P0 + P1**：P0 无风险（纯新增工具与单测），P1 让能力真正可用（命令行即可验证）；P2/P3 再决定。

## 5. 风险与边界

1. **模型 1.23 GB**：首启下载时长与磁盘占用是产品决策点。可选缓解：fp16 量化（约 614 MB）、动态 int8
   （约 307 MB，但需重新过精度关）。**量化后必须重跑 §2.3 的端到端一致性检查**。
2. **onnxruntime-node 原生模块**：Electron 主进程/utilityProcess 里加载需确认 ABI 与 asarUnpack（koffi 有先例）。
   未验证的边界：打包产物的真实加载（P3）。
3. **推理耗时与内存**：228 ms/次、模型常驻内存约 1.2 GB（fp32 权重 + 激活）。对 Electron 应用是可接受的，
   但**必须按需加载并支持卸载**（长时间不用时释放）。
4. **不含生成能力**：laya 只给判断与分布，卡片里的文字说明（「建议动作」以外的解释）需要模板拼装，
   不能期待它写句子。
5. **内容敏感性**：该能力的定位是「消息意图与情绪分析」，输入是用户自己的本机数据、结果不出本机。
   卡片措辞宜中性（「紧张度」而非「危险等级」这类戏剧化标签），并在设置里可关闭。
6. **v1 报告里被否的 Python 子进程方案**：在「用户自装环境」场景下仍然可用（开发机验证），
   但不再是量产路线。

## 6. 备选与后续优化

- **tokenizer 轻量化**：`@huggingface/transformers` 9.4 MB 里有大量模型代码用不上。可评估仅用
  `tokenizer.json` + 一个轻量 JS 分词实现（mmBERT 是 Gemma 系 tokenizer，词表 34 MB，规则不复杂），
  但**优先级低**——9.4 MB 不是瓶颈，模型才是。
- **fp16 量化**：`onnxruntime` 的 `quantize_dynamic`，模型降到约 614 MB，需重跑精度关。
- **与现有能力的化合**：`best_action = search_history` 可直接触发 Super Time 自己的 FTS 搜索（R11 的
  `search-events` 通道已经在用同一套 window 事件总线）；`is_upset` 可作为知识库问答的语气上下文。

## 7. 附录：脚本与环境（PoC 资产清单）

| 文件 | 作用 |
|---|---|
| `D:\laya\demo_zh_chat.py` / `_output.txt` | PoC-A：5 命题组 × 4 轮真实对话 |
| `D:\laya\demo_zh_chat_v2.py` / `_output.txt` | 问法锐利度对照（宽泛 choice vs 聚焦 noul） |
| `D:\laya\poc_onnx_export.py` / `_output.txt` | PoC-B：ONNX 导出 + torch/ort 精度比对 |
| `D:\laya\dump_reference.py` / `poc_c_reference.json` | Python 侧参考数据 dump（Node 比对基线） |
| `D:\laya\poc_c_node.mjs` / `_output.txt` | PoC-C：Node 侧 tokenizer 移植 + onnxruntime-node 复现 |
| `D:\laya\models\laya-decision.onnx` | 导出的 ONNX 模型（1228.6 MB） |

环境（本机实测）：
- Python 侧：`D:\laya\.venv\Scripts\python.exe`，torch 2.14.0+cpu，laya 0.3.5，onnxruntime 1.30.0
- Node 侧：onnxruntime-node 1.30.0 + `@huggingface/transformers` 4.3.0（PoC 期间临时装入项目
  `node_modules`，已还原 `package.json` / `package-lock.json`，未污染依赖）
- HF snapshot 缓存损坏 → 模型走本地目录加载（`D:\laya\models\laya-multilingual`），详见记忆中的绕行方案

## 8. 实施记录（2026-09-25 落地）

三期都已实现并通过验证：

| 期 | 交付 | 关键文件 |
|---|---|---|
| P0 | 导出脚本 / 中文命题预设 / `build_sequence` 的 JS 复刻 / fixture + 逐 token 守卫 | `tools/laya/*`、`src/backend/wechat-data/src/laya/{presets,build-sequence}.ts`、`tests/laya-sequence.spec.ts` |
| P1 | 模型分发（复用 whisper 的流式下载器）/ 本地推理运行时 / 5 个 `@Remote` | `laya/{model-file,runtime}.ts`、`remotes/laya.ts`、`query/laya-analysis.ts`、`types-laya.ts` |
| P2 | 会话工具区按钮 + 消息旁分析卡 | `panels/MessageAnalysisCard.tsx` + `message-analysis-card.module.css`（全令牌） |

### 8.1 导出环节的三个新坑（PoC 阶段没暴露）

1. **必须用 `dynamo=True` 导出。** 旧的 TorchScript 导出器（`dynamo=False`）会把**序列维固化成常量**：
   导出的图里出现 `Reshape{100,36,64}`（100 = 导出时 dummy 的长度），只有喂进那个长度才跑得通，
   其它长度一律 `input_shape_size == requested_shape_size was false`。切 eager attention 也救不了
   ——问题在导出器的常量传播，不在注意力实现。改用 `dynamo=True`（需 `onnxscript`、opset ≥ 18）后，
   实测两个不同长度（65 / 145）都通过、偏差 1e-06 级。
2. **自检必须用多个不同长度。** PoC 只用同一形状自检，所以第 1 条整整藏了一轮 ——
   直到端到端跑真实会话才暴露。`tools/laya/export-onnx.py` 现在把「两个长度都要过」写成硬自检，
   不过就不许分发。
3. **产物的权重是外置的**：`laya-decision.onnx`（图，2.2 MB）+ `laya-decision.onnx.data`（1228 MB），
   两者必须一起分发（onnxruntime 会在同目录找 `.data`）——`LAYA_ASSETS` 已把它列为必需项。

### 8.2 端到端实测（项目生产代码 + 真实模型）

`working/e2e-laya.mjs`（把 `laya/runtime.ts` 打包成 ESM 后直接调用）在 3 段真实对话 × 6 命题上：

- **18/18 项与 Python `laya.predict()` 一致**（choice 概率最大偏差 `0.0e+0`、score 精确相同）；
- 首次调用含模型加载 1.69 s（加载 1.23 s + 推理 0.46 s），之后单次 **0.46–0.63 s**（574–1012 tokens）；
- `layaUnload()` 后运行时状态确实回落（`loaded=false`），常驻内存可释放。

### 8.4 本机怎么接上模型（零拷贝，与 whisper 同款）

模型不进安装包，所以**刚装好时卡片显示「模型未就绪」是正常状态**，不是故障：它会如实列出缺哪几个文件、
期望放在哪个目录。接上它只需要一个配置键（`config.json` 的 `laya_models_dir`，与既有的
`whisper_models_dir` 完全同款——那个也指向仓库外的 D 盘目录）：

1. 把导出产物摆成一个完整布局：`<dir>/laya-decision.onnx` + `<dir>/laya-decision.onnx.data`
   + `<dir>/tokenizer/{tokenizer.json, tokenizer_config.json}`（本机是 `D:\laya\models`）；
2. 在 `<数据根>/config.json` 里写 `"laya_models_dir": "D:\\laya\\models"`；
3. `getConfig()` **每次读盘、无缓存**，所以**重开卡片即可生效，不必重启应用**。

另外两条与 whisper 一致：`DSH_WECHAT_LAYA_DIR` 环境变量优先级高于配置（开发/测试用），
下载缺失文件走 `downloadLayaModel`（源由 `DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 指定）。

> 顺手修掉两个本地看到的小瑕疵：`layaModelStatus().bytes` 原先只算计算图（2.25 MB）→ 卡片会显示
> 「模型 0.0 GB」，改为**累加全部必需文件**（本机实测 1 324 369 278 B ≈ 1.23 GB）；
> 未就绪时的错误文案原先自己拼了一遍缺失清单，与卡片渲染的清单重复 → 收敛成一句概括。

### 8.5 仍需注意的边界（未验证）

- **打包关（P3）未做**：onnxruntime-node 的 asarUnpack、`package-content-rules.js` 的上界、
  真实打包产物里加载模型，都还没验（`build.files` 白名单与平台裁剪已按单平台 27.7 MB 配好）。
- 模型下载源由宿主方托管（`DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 可覆盖默认仓库）。
- 「点某条消息分析」未做：当前分析的是**最新一条对方消息**（按需触发，不做全量），
  逐条内嵌需要改消息渲染循环与虚拟化列表，留给后续。
- 模型 fp32（1.23 GB）。若要压到 fp16/int8，**必须重跑 `export-onnx.py` 的多长度自检**。
