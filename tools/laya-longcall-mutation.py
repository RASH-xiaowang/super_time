"""长任务台账守卫（`HEAVY_LEDGER` 反向覆盖）的变异自证。

跑法：`python tools/laya-longcall-mutation.py`

判定是四态（不是一个布尔）：
  · `RED-OK`     —— 变红，**且红的正是我要它红的那条用例**
  · `MISS`       —— 变异后全绿 ⇒ 守卫咬不住
  · `ILLEGAL`    —— tsc 不过 ⇒ 编译失败不是咬住（两者退出码都非零！）
  · `WRONG-RED`  —— 红了但不是目标用例 ⇒ 咬错了地方

纪律：
  1. **变异前先跑 tsc**，且用**覆盖到被测文件**的那份 tsconfig。
     `tsconfig.checks.json` 只 include `scripts/**` 与 `vitest.config.ts`，
     **没看 `src/backend/tests/**`** —— 拿它做前置检查，变异体里的类型错误会被静默放过。
  2. **先证明 tsc 闸门是活的**（故意塞类型错误必须报）。
  3. 判「红了没」**不许用 `-t` 过滤**：关键词不匹配时 vitest 以「没匹配到用例」非零退出，
     会被误判成 RED-OK（假咬）。
  4. 写回要**防文件锁**，跑完**回读校验逐字节还原**。
  5. `subprocess` 走 shell 时是 `cmd.exe`：行内 `VAR=x cmd` 语法不成立 ⇒ 用 `env=`。
  6. 不用 `text=True`。
  7. CRLF：读 → 归一 `\\n` → 替换 → 按原行尾还原 → 写盘。
"""
import os
import re
import subprocess
import sys
from pathlib import Path

#: 剥掉 ANSI 颜色/光标控制序列（vitest 的 `FAIL` 行首就带着它）。
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

ROOT = Path(r"D:\super-time-wechat")
NODE = os.environ.get("SUPERTIME_NODE", "node")
TS = "src/backend/tsconfig.tests.json"
SPEC_ARG = "src/backend/tests/backend-rpc.spec.ts"

RPC = ROOT / "src/backend/backend-rpc.js"
SPEC = ROOT / "src/backend/tests/backend-rpc.spec.ts"

ENV = dict(os.environ)
ENV["CODEBUDDY_SAFE_DELETE_ENABLED"] = "0"


def run(cmd_str):
    return subprocess.run(cmd_str, cwd=str(ROOT), shell=True, capture_output=True, env=ENV)


def tsc_ok():
    r = run('"%s" node_modules/typescript/bin/tsc -p %s --noEmit' % (NODE, TS))
    return r.returncode == 0, r.stderr.decode("utf-8", "replace")[:300]


def spec_run():
    """跑整个 spec 文件。返回 (是否全绿, 合并输出, 失败用例的 `FAIL` 行)。

    ⚠ 失败用例名**只在 stderr**：vitest 把
        `FAIL  <file> > <suite> > <用例名>`
    连同断言详情一起写到 stderr，而 stdout 上只有 `✓` 列表与耗时榜 —— 只扫 stdout
    会得到「红了但取不到名字」，从而把每一条都误判成 WRONG-RED（实测踩过）。

    ⚠ 还要先**剥 ANSI 转义**：vitest 给 `FAIL` 加了颜色码，行首是 `\\x1b[31m` 之类的
    控制序列 ⇒ `line.startswith("FAIL ")` 恒为假（终端里看不见这些码，所以看起来"明明有"）。
    判据用「包含」而不是「以…开头」，双保险。
    """
    r = run('"%s" node_modules/vitest/vitest.mjs run %s' % (NODE, SPEC_ARG))
    out = ANSI_RE.sub("", r.stdout.decode("utf-8", "replace"))
    err = ANSI_RE.sub("", r.stderr.decode("utf-8", "replace"))
    merged = out + "\n" + err
    if "No test files found" in merged or "No test suite found" in merged:
        return None, merged, []
    failed = []
    for ln in merged.split("\n"):
        s = ln.strip()
        if "FAIL " in s and ".spec." in s:
            failed.append(s)
    return r.returncode == 0, merged, failed


def read(path):
    b = path.read_bytes()
    eol = b"\r\n" if b.count(b"\r\n") > 0 else b"\n"
    return b.decode("utf-8").replace("\r\n", "\n"), b, eol


def write(path, text, eol):
    if eol == b"\r\n":
        text = text.replace("\n", "\r\n")
    path.write_bytes(text.encode("utf-8"))


KEY_EQ = "完全相等"

MUTS = [
    ("M1 LONG_CALL_METHODS 漏掉 analyzeVisibleMessages（真回归的那个）",
     RPC,
     "  'analyzeMessages', 'analyzeVisibleMessages',",
     "  'analyzeMessages',",
     KEY_EQ),

    ("M2 LONG_CALL_METHODS 混进一个不存在的名字",
     RPC,
     "  'buildSearchIndex', 'buildRagVectorIndex', 'buildKbVectorIndex', 'evaluateRetrieval',",
     "  'buildSearchIndex', 'buildRagVectorIndex', 'buildKbVectorIndex', 'evaluateRetrieval', 'totallyFakeRemote',",
     KEY_EQ),

    ("M3 台账漏记 fetchOriginalImagesBatch",
     SPEC,
     "{ why: '批量取原图：几千张 × 15s 超时 + 4 并发，远超 60s', methods: ['fetchOriginalImagesBatch'] },\n",
     "",
     KEY_EQ),

    ("M4 台账点了一个不存在的 @Remote 名字",
     SPEC,
     "{ why: '语音转写：whisper 本地推理', methods: ['transcribeVoiceBatch', 'transcribeVoiceMessage'] },",
     "{ why: '语音转写：whisper 本地推理', methods: ['transcribeVoiceBatch', 'notARealRemoteXyz'] },",
     "点名的方法都必须是真实存在"),
]


def probe(label, path, old, new, keyword):
    text, orig_bytes, eol = read(path)
    n = text.count(old)
    if n != 1:
        return "ANCHOR", "锚点命中 %d 次（要求恰好 1 次）" % n
    write(path, text.replace(old, new, 1), eol)
    try:
        cok, cerr = tsc_ok()
        if not cok:
            return "ILLEGAL", "tsc 不过 ⇒ 编译失败不是咬住：%s" % cerr.replace("\n", " ")[:150]
        green, out, failed = spec_run()
        if green is None:
            return "NO-TESTS", "vitest 没跑到目标 spec"
        if green:
            return "MISS", "变异后 spec 仍全绿 ⇒ 守卫咬不住"
        if not failed:
            # 红了却取不到用例名 ⇒ 是**判据解析**坏了，不是守卫咬住了。这条必须吵出来，
            # 否则每一条变异都会被含糊地记成「红过了」。
            return "PARSE-FAIL", "拿到非零退出码但解析不出失败用例名 ⇒ 判据失效，先修 spec_run()"
        if any(keyword in f for f in failed):
            return "RED-OK", (failed[0][:130] if failed else "")
        return "WRONG-RED", "红了但不是目标用例：%s" % (failed[0][:130] if failed else "(取不到名字)")
    finally:
        write(path, text, eol)
        if path.read_bytes() != orig_bytes:
            raise SystemExit("!!! 还原失败（逐字节比对不一致）：%s" % path)


def main():
    ok, err = tsc_ok()
    if not ok:
        print("BASELINE tsc FAILED（先修好再变异）\n", err)
        return 2
    green, out, _ = spec_run()
    if green is not True:
        print("BASELINE spec FAILED（先修好再变异）\n", out[-1500:])
        return 2
    print("baseline: tsc OK / spec OK")

    # tsc 闸门活性自检 —— 打在被测的 **TS** 文件上（backend-rpc.js 是 JS，不在类型检查范围）。
    verdict, msg = probe("tsc 闸门活性", SPEC,
                         "const HEAVY_LEDGER: ReadonlyArray<{ why: string; methods: readonly string[] }> = [",
                         "const HEAVY_LEDGER: string = [",
                         "(不需要关键词)")
    if verdict == "ILLEGAL":
        print("tsc 闸门是活的：故意的类型错误确实被报出来了\n")
    else:
        print("!!! tsc 闸门失效：故意写错类型都没报（判据 = %s / %s）" % (verdict, msg))
        return 2

    red = 0
    bad = []
    for label, path, old, new, keyword in MUTS:
        verdict, detail = probe(label, path, old, new, keyword)
        if verdict == "RED-OK":
            red += 1
            print("RED-OK   %-46s %s" % (label, detail))
        else:
            print("%-8s %-46s %s" % (verdict, label, detail))
            bad.append("%s [%s]" % (label, verdict))

    print("\n结果：RED-OK %d / 共 %d" % (red, len(MUTS)))
    if bad:
        print("有问题：", "；".join(bad))
        return 1
    print("全部咬住，且每条都逐字节还原")
    return 0


if __name__ == "__main__":
    sys.exit(main())
