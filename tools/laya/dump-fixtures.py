# -*- coding: utf-8 -*-
"""生成 JS 侧对齐用的 fixture（token 序列 + 模型答案）。

**为什么需要它**：`src/backend/wechat-data/src/laya/build-sequence.ts` 是 Python
`laya/common.py` 里 `render_options` / `build_sequence` / `collate_items` 的手工复刻。
打包版没有 Python，所以这段复刻只能靠 fixture 守住——差一个 token，模型概率就完全不同。

脚本用**真实模型**跑一遍，把结果固化成 JSON：
  · `items[].ids` / `markers`  —— Python 构造的 token 序列（JS 侧必须逐 token 相同）
  · `logits`                   —— torch 的原始输出（JS 后处理必须还原出 `answers`）
  · `answers`                  —— `laya.predict()` 的最终答案

fixture 里的 `questions` 必须与 `presets.ts` 的 `defaultChatQuestions()` 一致，
`tests/laya-sequence.spec.ts` 会断言这一点（防两边漂移）。

运行（默认读 D:\\laya 的试跑环境，可覆盖）：

    D:\\laya\\.venv\\Scripts\\python.exe tools/laya/dump-fixtures.py \\
        --model-dir D:\\laya\\models\\laya-multilingual \\
        --out src/backend/wechat-data/tests/fixtures/laya-sequence.json
"""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 命题组：必须与 src/backend/wechat-data/src/laya/presets.ts 的 defaultChatQuestions() 一致。
QUESTIONS = {
    "literal_question": {
        "type": "noul",
        "instructions": "`dialogue` 里最后一句话，是在字面意义上真的在提问或提出要求吗？",
    },
    "is_testing": {
        "type": "noul",
        "instructions": "`dialogue` 里最后一句话，是在测试对方记性，而不是真的想获取信息吗？",
    },
    "is_upset": {
        "type": "noul",
        "instructions": "`dialogue` 里最后一句话，说话人此刻不高兴吗？",
    },
    "real_intent": {
        "type": "choice",
        "instructions": "`dialogue` 里最后一句话，说话人真正的意图是什么？",
        "criteria": {
            "care_check": "想确认对方在不在乎自己",
            "memory_test": "单纯考验对方的记忆力",
            "want_fight": "生气，想吵架",
            "keep_talking": "只是想把话聊下去，没有别的目的",
        },
    },
    "tension": {
        "type": "score",
        "instructions": "`dialogue` 最后一句话之后，此刻局势的紧张程度是多少？",
        "criteria": [
            "完全平静，纯粹闲聊",
            "非常轻松，毫无张力",
            "轻松，只有一点点撒娇意味",
            "偏向轻松，但对方在等回应",
            "中性，看不出情绪",
            "略有不悦，需要认真回应",
            "明显不悦，敷衍会出错",
            "不高兴，需要先安抚再回答",
            "比较生气，处理不当会升级",
            "很生气，回答错会吵架",
            "极度紧张，已经到临界点",
        ],
    },
    "best_action": {
        "type": "choice",
        "instructions": "面对 `dialogue` 里的最后一句，此刻最该做的动作是哪一个？",
        "criteria": {
            "search_history": "先搜索历史聊天记录，确认对方之前说过什么",
            "answer_directly": "立刻直接回答具体内容",
            "admit_and_apologize": "先承认自己忘了并道歉，再往下说",
            "ask_back": "反问回去，让对方先提示",
            "change_topic": "转移话题",
            "play_dumb": "先不回，等对方再说",
        },
    },
}

# 用例：覆盖 build_sequence 的不同分支（短历史 / 中等 / 长历史触发 room 截断）
TURNS = [
    ("对方", "你今天是不是又忘了我跟你说过什么？"),
    ("我", "记得，你先别提示我，让我自己说。"),
    ("对方", "那你说。"),
    ("我", "等一下，我想说完整一点。"),
    ("对方", "你最好是。"),
    ("我", "我想起来了。你昨天跟我说周末想出去吃饭，而且你不想每次都是你来安排。"),
    ("对方", "所以呢？"),
]

CASES = [
    ("short_1", TURNS[:1]),
    ("mid_3", TURNS[:3]),
    ("long_7", TURNS[:7]),
]


def dialogue_of(turns):
    return "\n".join(f"{who}：{text}" for who, text in turns)


class RecordingTokenizer:
    """代理真实 tokenizer，并把每次编码的「原文 → ids」记进 `table`。

    只做代理不做改写：属性访问与调用都原样转发，所以 `build_sequence` 的行为一字不变
    （它用到的 `mask_token` / `cls_token_id` / `pad_token_id` 等走 `__getattr__`）。
    """

    def __init__(self, tok, table):
        self._tok = tok
        self._table = table

    def __call__(self, text, **kwargs):
        out = self._tok(text, **kwargs)
        self._table[str(text)] = out["input_ids"]
        return out

    def __getattr__(self, name):
        return getattr(self._tok, name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=r"D:\laya\models\laya-multilingual")
    ap.add_argument("--out", default="src/backend/wechat-data/tests/fixtures/laya-sequence.json")
    ap.add_argument("--skip-model", action="store_true",
                    help="只 dump token 序列（不跑模型，logits/answers 留空）")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent.parent  # 仓库根
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = root / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)

    import laya
    from laya.common import QTYPES, build_sequence, collate_items

    agent = laya.load(str(Path(args.model_dir)), device="cpu")
    cfg = agent.cfg
    max_len = cfg.get("max_len", 1024)
    head_max_len = cfg.get("head_max_len", 256)

    cases = []
    # 记录 Python 侧所有「文本 → token ids」的编码结果。
    # JS 侧测试用这张表当 tokenizer（查不到就抛），因此**任何与 Python 不同的调用文本
    # 都会立刻失败**——这比「看起来序列长度对得上」强得多。
    token_table = {}
    for name, turns in CASES:
        state = {"dialogue": dialogue_of(turns)}
        items = []
        rec = RecordingTokenizer(agent.tok, token_table)
        for qid, qdef in QUESTIONS.items():
            q = agent._to_internal(qdef)
            seq, markers = build_sequence(rec, state, q, max_len, head_max_len)
            items.append({"qid": qid, "ids": seq, "markers": markers, "qtype": QTYPES[q["t"]]})

        batch = collate_items([items], agent.tok.pad_token_id)
        entry = {
            "name": name,
            "state": state,
            "items": items,
            "batch": {
                "inputIds": batch["input_ids"].tolist(),
                "attentionMask": batch["attention_mask"].tolist(),
                "markerPos": batch["marker_pos"].tolist(),
                "markerMask": batch["marker_mask"].tolist(),
                "qtype": batch["qtype"].tolist(),
            },
        }

        if not args.skip_model:
            import torch
            with torch.no_grad():
                logits, act = agent.model(
                    batch["input_ids"], batch["attention_mask"],
                    batch["marker_pos"], batch["marker_mask"], batch["qtype"])
            entry["logits"] = logits.numpy().tolist()
            entry["answers"] = agent.predict(state, QUESTIONS)["answers"]

        cases.append(entry)
        print(f"  {name}: {len(items)} 命题, 序列最长 {max(len(i['ids']) for i in items)} tokens")

    payload = {
        "generator": "tools/laya/dump-fixtures.py",
        "note": "Python 侧构造的 token 序列与模型输出；JS 复刻必须逐 token 对齐。",
        "layaVersion": laya.__version__,
        "cfg": {
            "maxLen": max_len,
            "headMaxLen": head_max_len,
            "temperature": agent.temperature,
            "temperatureByOptions": agent.temperature_by_options,
        },
        "specialIds": {
            "cls": agent.tok.cls_token_id,
            "sep": agent.tok.sep_token_id,
            "mask": agent.tok.mask_token_id,
            "pad": agent.tok.pad_token_id,
        },
        "questions": QUESTIONS,
        "tokenTable": {k: v for k, v in sorted(token_table.items())},
        "cases": cases,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"fixture -> {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
