# laya 决策引擎接入可行性调研（2026-09-25）

> 需求出处：界面优化计划阶段 5——「调研在微信聊天界面接入 jev 或 laya 的可行方案，对比优劣后确定技术方案」。
> （jev 经确认为笔误，本文只评估 laya。）
> 结论先行：**本计划不集成，交付本报告 + 接口预留设计**（方案 D）；量产唯一可行路线是
> ONNX + onnxruntime-node（方案 B），但转换可行性未验证、失败即全损，必须独立 PoC 后再立项。

## 1. laya 是什么（D:\laya 本机试跑实测）

GitHub `NandhaKishorM/laya`（HF `convaiinnovations/laya`）：**开源决策引擎，非 LLM、非生成式**。
一个 RL 训练的小模型 agent（laya 0.3.5，encoder=jhu-clsp/mmBERT-base + 2 层 head，
647MB multilingual checkpoint），提供三种**决策原语**：

| 原语 | 语义 | 返回 |
|---|---|---|
| `choice` | 多选一（带声明式 criteria） | 选中项 + 置信度分布 |
| `score` | 按 criteria 给输入分级打分 | 分值 + 概率 |
| `noul` | 0-1 概率判断 | 概率 + 置信度 |

本机实测（`demo_zh_triage_output.txt`）：中文工单分诊效果良好——意图分类置信度 0.74-0.99、
退款要求 0.93、流失风险 0.98、情绪打分 2.2（愤怒）。CPU 推理（本机 28 线程）**单条 600-800ms**，
模型加载 26.6s。

**对 Super Time 的定位**：laya 做不了「生成回复句子」（那是 LLM 的事，走现有 suggestReplies 的
DSH LLM 通道），但它擅长**确定性判断**——该不该回、紧急度、情绪、意图路由——适合作为
reply-suggest 的**前置分诊层**：零 API 成本、完全本地、隐私友好（不过出网闸门）。

挂点：`src/backend/wechat-data/src/remotes/summaryrec.ts:179` 的 `suggestReplies()`——
数据收集层（query/reply-suggest.ts）与前端（ReplySuggest.tsx）都不用动。

## 2. 四方案对比

| 方案 | 打包版可行性 | 延迟 | 分发负担 | 工程量 | 结论 |
|---|---|---|---|---|---|
| **A. Python 子进程 spawn** | ✗ 硬伤：打包版用户无 Python；捆绑 runtime 约 +100MB | 600-800ms/条 + 进程管理开销 | 安装包 ~200MB→~1GB | 高：进程生命周期/崩溃恢复/并发锁全套 | **排除** |
| **B. ONNX 转换 + onnxruntime-node** | ✓ 有先例：koffi 作为原生模块经 asarUnpack 打包分发 | 预计 <100ms（待实测：mmBERT-base 是标准 transformer，onnxruntime CPU 优化成熟） | 模型 647MB 走「可选组件首启下载」（whisper 模型已有同款机制：`downloadWhisperModel`），不进安装包 | 高：torch→onnx 导出脚本 + tokenizer 移植（JS 侧跑 tokenizers 库或预编译词表）+ 精度回归 | **中期候选，需 PoC** |
| **C. 独立本地 HTTP 服务** | △ 仅开发机/高级用户自装（`pip install laya` + 起服务） | 网络 IPC + 600-800ms 推理 | 零（用户自理） | 低：健康检查 + 端口约定 + 超时降级 | **短期验证产品价值用** |
| **D. 不集成：报告 + 接口预留** | ✓ | — | 零 | 最低：一个纯函数 triage 层 + JS 规则兜底实现 | **本计划推荐** |

## 3. 推荐与演进路线

**D →（价值证实）→ C 验证 → B 立项 PoC → 量产**：

1. **现在（D）**：把 triage 的**接口契约**钉死（§4），JS 规则兜底实现先行——判断逻辑用
   简单启发式（消息长度/问句标记/关键词），零模型依赖。产品可以先验证「分诊层」这一层
   的交互价值（ReplySuggest 前是否多一步「这条值得回吗」的提示）。
2. **价值证实后（C）**：愿意折腾的用户自装 laya 起本地服务，Super Time 检测到服务在线时
   把 triage provider 切到 laya（choice 原语做「该不该建议回复」，score 做「紧急度/情绪」）。
   一个 HTTP 探测 + 一个 provider 接口，工程量约 1-2 天。
3. **量产（B）**：独立 PoC 过三关（§5）再立项。whisper 的「首启下载可选组件」机制
   （`downloadWhisperModel`，流式 + 原子发布）可整套复用给 647MB 模型。

**不推荐 A 的硬理由**：分发约束不是偏好而是现实——本项目打包版是纯 Node + Electron
（`build.files` 白名单严格、asar 上界 64MB + unpack 外挂），为一个可选功能捆绑
Python runtime 是产品级错误。

## 4. 接口契约（本报告钉死，实现时照此）

```ts
// summaryrec.ts 的 suggestReplies() 前置纯函数层（第 1/3 层不动）：
/** triage provider 插槽：JS 规则兜底实现先行；laya（HTTP 或未来 ONNX）作为可选 provider。 */
export interface ReplyTriageProvider {
  /** 对一次回复上下文给出分诊结论。实现必须纯本地、可失败降级（fail-open 到 suggest=true）。 */
  triage(input: {
    latestPeerMessage: string        // 对方最近一条
    recentCount: number              // 上下文行数
    hour: number                     // 本地时刻（夜间加权用）
  }): Promise<{
    suggest: boolean                 // 该不该弹建议（false = 不打扰）
    urgency: 'low' | 'mid' | 'high'
    reason?: string                  // 给 UI 的一句解释（如「对方在问问题」）
  }>
}

// ReplySuggestResult 增加可选字段（前端按可选字段消费，旧渲染不受影响）：
// triage?: { urgency: 'low'|'mid'|'high'; suggest: boolean; reason?: string }
```

前端消费：`ReplySuggest.tsx` 在建议列表顶部按 `triage.urgency` 给一行轻量标记
（复用 kit 的 Pill/Badge，不新造组件）；`suggest=false` 时不自动弹出（用户主动点击仍可用）。

## 5. 方案 B 的 PoC 验收标准（三关，全部要过才立项）

1. **转换关**：`laya-multilingual` 的 encoder+head 导出 ONNX，在 onnxruntime-node 1.x
   （Electron 44 内置 Node 22 兼容版本）里加载成功；tokenizer 在 JS 侧产出与 Python
   `predict` **逐 token 一致**的输入 id 序列。
2. **精度关**：用 `demo_zh_triage.py` 的同一批中文样例，ONNX 与 Python 的 choice 分布
   **Top-1 一致率 ≥ 95%**、最大概率偏差 ≤ 0.03。
3. **打包关**：onnxruntime-node 原生模块进 asarUnpack 后，在打包产物（`npm run pack`）
   里真实加载模型并推理通过；asar 总体积仍在 `package-content-rules.js` 的上界内
   （模型本身走首启下载，不进 asar）。

## 6. 已知环境坑（D:\laya 试跑记录，PoC 时直接复用）

- 本机 HF snapshot 缓存损坏（blobs 完整但 snapshots 全 0 字节）——模型已用
  `fetch_laya_model.py` 直下绕开（`D:\laya\models\laya-multilingual`），PoC 沿用本地路径。
- huggingface.co 不通（502），hf-mirror.com 通（约 35MB/s）——下载脚本必须走镜像。
- `uv pip install` 可能报 `os error 5 拒绝访问`（杀软锁文件）——清 `.tmp*` 后加
  `--link-mode copy` 补装。
