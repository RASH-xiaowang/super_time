# -*- coding: utf-8 -*-
"""把 laya 决策模型导出为 ONNX（一次性离线步骤，产物不进仓）。

**为什么需要这一步**：Super Time 打包版是纯 Node + Electron，没有 Python。
laya 官方只提供 PyTorch checkpoint，所以要在**开发机**上把它导成 ONNX，
打包版才能用 onnxruntime-node 直接推理。参见 docs/LAYA-TRIAGE-FEASIBILITY.md §2。

导出范围是 `DecisionModel.forward`（5 张量进 → 2 张量出）：
    input_ids, attention_mask, marker_pos, marker_mask, qtype  →  logits, act_logits
temperature 缩放、softmax、argmax **不在计算图里**（在 `laya/agent.py:325-362` 的后处理里），
所以 JS 侧只需实现纯 softmax —— 本 checkpoint 的 `temperature` 全为 1.0，连缩放都不用。

## 三个必须知道的坑（都实测踩过）

1. **必须用 `dynamo=True`。** 旧的 TorchScript 导出器（dynamo=False）会把序列维**固化成常量**
   （实测图里出现 `Reshape{100,36,64}`），于是只有喂进导出时那个长度才跑得通，别的长度直接
   `input_shape_size == requested_shape_size was false`。切 eager attention 也救不了——
   问题在导出器的常量传播，不在注意力实现。`dynamo=True` 走符号追踪，动态维才是真的动态。
2. **需要额外装 `onnxscript`**（dynamo 导出器的依赖）：`uv pip install onnxscript`。
3. **自检必须用多个不同长度。** 只用一个长度自检，第 1 条根本查不出来
   （PoC 第一版就是这样骗过自己的，直到端到端跑真实会话才暴露）。

## 产物形态
dynamo 默认把权重写成**外置数据**：`laya-decision.onnx`（图，几 MB）+ `laya-decision.onnx.data`
（权重，约 1.2 GB）。**两个文件必须一起分发**（onnxruntime 会在同目录找 `.data`）。

运行：

    D:\\laya\\.venv\\Scripts\\python.exe tools/laya/export-onnx.py \\
        --model-dir D:\\laya\\models\\laya-multilingual \\
        --out D:\\laya\\models\\laya-decision.onnx

模型权重来源见记忆里的 HF 绕行方案（本机 HF snapshot 缓存损坏，需直下到普通目录）。
"""
import argparse
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 自检用的对话：两段长度差异明显的输入（第二个明显更长，能暴露长度固化）
CHECK_DIALOGUES = [
    {"dialogue": "对方：那你说。"},
    {"dialogue": "\n".join([
        "对方：你今天是不是又忘了我跟你说过什么？",
        "我：记得，你先别提示我，让我自己说。",
        "对方：那你说。",
        "我：等一下，我想说完整一点。",
        "对方：你最好是。",
        "我：我想起来了。你昨天跟我说周末想出去吃饭，而且你不想每次都是你来安排。",
        "对方：所以呢？",
    ])},
]

QUESTIONS = {
    "is_upset": {"type": "noul", "instructions": "`dialogue` 里最后一句话，说话人此刻不高兴吗？"},
    "tension": {
        "type": "score",
        "instructions": "`dialogue` 最后一句话之后，此刻局势的紧张程度是多少？",
        "criteria": ["平静", "轻松", "等回应", "略有不悦", "明显不悦", "不高兴", "比较生气", "很生气", "极度紧张"],
    },
    "best_action": {
        "type": "choice",
        "instructions": "面对 `dialogue` 里的最后一句，此刻最该做的动作是哪一个？",
        "criteria": {"answer_directly": "立刻直接回答", "ask_back": "反问回去", "admit_and_apologize": "先认错"},
    },
}


def build_batch(agent, state, max_len, head_max_len):
    from laya.common import QTYPES, build_sequence, collate_items
    items = []
    for _qid, qdef in QUESTIONS.items():
        q = agent._to_internal(qdef)
        seq, markers = build_sequence(agent.tok, state, q, max_len, head_max_len)
        items.append({"ids": seq, "markers": markers, "qtype": QTYPES[q["t"]]})
    b = collate_items([items], agent.tok.pad_token_id)
    return (b["input_ids"], b["attention_mask"], b["marker_pos"], b["marker_mask"], b["qtype"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=r"D:\laya\models\laya-multilingual",
                    help="laya checkpoint 目录（含 rl_agent_config.json / model.safetensors / tokenizer / encoder）")
    ap.add_argument("--out", default=r"D:\laya\models\laya-decision.onnx")
    ap.add_argument("--opset", type=int, default=20, help="dynamo 导出建议 18+（17 会生成 ort 不认的 Split 属性）")
    args = ap.parse_args()

    import torch
    torch.set_num_threads(max(1, os.cpu_count() or 4))
    import laya

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[1] 加载 checkpoint：{args.model_dir}")
    t0 = time.time()
    agent = laya.load(str(Path(args.model_dir)), device="cpu")
    print(f"    完成 {time.time() - t0:.1f}s  encoder={agent.cfg.get('encoder')}")

    max_len = agent.cfg.get("max_len", 1024)
    head_max_len = agent.cfg.get("head_max_len", 256)
    dummy = build_batch(agent, CHECK_DIALOGUES[0], max_len, head_max_len)
    print(f"[2] dummy 输入：input_ids {tuple(dummy[0].shape)}")

    with torch.no_grad():
        ref_logits, ref_act = agent.model(*dummy)

    from torch.export import Dim
    print(f"[3] 导出 ONNX（opset {args.opset}，dynamo=True）")
    t0 = time.time()
    try:
        torch.onnx.export(
            agent.model, dummy, str(out_path),
            input_names=["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
            output_names=["logits", "act_logits"],
            dynamic_shapes={
                "input_ids": {0: Dim("batch"), 1: Dim("seq")},
                "attention_mask": {0: Dim("batch"), 1: Dim("seq")},
                "marker_pos": {0: Dim("batch"), 1: Dim("nopts")},
                "marker_mask": {0: Dim("batch"), 1: Dim("nopts")},
                "qtype": {0: Dim("batch")},
            },
            opset_version=args.opset,
            dynamo=True,
        )
    except ModuleNotFoundError as e:
        print(f"    ❌ 缺依赖：{e}（dynamo 导出器需要 onnxscript：uv pip install onnxscript）", file=sys.stderr)
        return 1

    data_file = Path(str(out_path) + ".data")
    print(f"    完成 {time.time() - t0:.1f}s")
    print(f"    图：{out_path.name}  {out_path.stat().st_size / 1024 / 1024:.1f} MB")
    if data_file.exists():
        print(f"    权重：{data_file.name}  {data_file.stat().st_size / 1024 / 1024:.1f} MB  ← 必须与图一起分发")

    # ---- 自检：**多个不同长度**都要过（只测一个长度会漏掉长度固化）----
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError:
        print("[4] 跳过自检（未安装 onnxruntime / numpy）—— 强烈建议装上再分发")
        return 0

    try:
        sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    except Exception as e:
        print(f"[4] ❌ onnxruntime 加载失败：{str(e)[:300]}", file=sys.stderr)
        return 1

    names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
    failed = False
    for idx, state in enumerate(CHECK_DIALOGUES):
        args_in = build_batch(agent, state, max_len, head_max_len)
        with torch.no_grad():
            tl, ta = agent.model(*args_in)
        feeds = {n: a.numpy() for n, a in zip(names, args_in)}
        try:
            out = sess.run(None, feeds)
        except Exception as e:
            print(f"[4.{idx}] seq={tuple(args_in[0].shape)} ❌ onnxruntime 报错：{str(e)[:200]}")
            failed = True
            continue
        dl = float(np.abs(out[0] - tl.numpy()).max())
        da = float(np.abs(out[1] - ta.numpy()).max())
        if dl >= 1e-4:
            failed = True
        print(f"[4.{idx}] seq={tuple(args_in[0].shape)} {'✅' if dl < 1e-4 else '❌'} "
              f"logits 偏差 {dl:.2e}  act 偏差 {da:.2e}")

    if failed:
        print("\n❌ 自检未通过 —— 这样长度固定/不准的图分发给打包版会在真实会话上直接报错，请勿分发。",
              file=sys.stderr)
        return 1

    print("\n下一步：把「图 + .data + tokenizer 目录」拷到 <数据根>/laya/（或用 adoptLayaModel 接管），")
    print("       也可设 DSH_WECHAT_LAYA_DIR 指向该目录。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
