# -*- coding: utf-8 -*-
"""A4 封面「本地优先」接线守卫的变异自证（`article-cover-local-first.spec.ts`）。

守护的三件事：
  ① `getArticleCover` / `getArticleCovers` **两个**入口都必须把探测传下去（少一个就少一半收益）；
  ② 探测必须有**成本闸门**（用户没进过朋友圈时不建探测函数）；
  ③ 探测**不许回到 `GatewayRead.prototype`** —— `gateway-read-shell.spec.ts` 要求 prototype 上
     每个方法都带 `@Remote`（防漏装饰器），私有辅助方法挂 prototype 会稳定违反它。

用法：`CODEBUDDY_SAFE_DELETE_ENABLED=0 <python> tools/a4-wiring-mutation.py`
判据：每条必须 `RED-OK`（守卫咬住）或 `ILLEGAL-MUTANT`（变异体编译不过 —— **不算咬住**）。
跑完必须逐字节还原，脚本自己会回读校验。
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("SUPERTIME_NODE", "node")
GW = ROOT / "src/backend/wechat-data/src/gateway-read.ts"
SPEC = "src/backend/wechat-data/tests/article-cover-local-first.spec.ts"

# ⚠ subprocess 走 shell 时是 cmd.exe：`VAR=x cmd` 的行内环境变量语法**不成立**（那是 POSIX sh）。
#   必须用 env= 显式传。另：不用 text=True —— 非 UTF-8 输出会抛 UnicodeDecodeError。
ENV = dict(os.environ, CODEBUDDY_SAFE_DELETE_ENABLED="0")

MUTS = [
    ("M1 批量入口不传探测",
     "options.urls, this._dirs.decoded, this.cdnSwitches(), buildCoverLocalProbe(this._dirs),",
     "options.urls, this._dirs.decoded, this.cdnSwitches(),"),
    ("M2 单张入口不传探测",
     "options.contentUrl, this._dirs.decoded, this.cdnSwitches(), buildCoverLocalProbe(this._dirs),",
     "options.contentUrl, this._dirs.decoded, this.cdnSwitches(),"),
    ("M3 拆掉成本闸门",
     "if (!hasSnsMediaIndexEntries()) return undefined",
     "if (false) { /* gate removed */ }"),
]


def run(cmd):
    return subprocess.run(cmd, cwd=str(ROOT), shell=True, capture_output=True, env=ENV)


def tsc_ok():
    r = run('"%s" node_modules/typescript/bin/tsc -p src/backend/wechat-data/tsconfig.json --noEmit' % NODE)
    return r.returncode == 0


def main():
    orig = GW.read_bytes().decode("utf-8")
    if not tsc_ok():
        print("BASELINE ILLEGAL：原始文件就编译不过，先修干净再变异")
        return 1

    problems = 0
    for name, old, new in MUTS:
        n = orig.count(old)
        if n != 1:
            print("%-24s SKIP 锚点命中 %d 次（应为 1）" % (name, n))
            problems += 1
            continue
        GW.write_bytes(orig.replace(old, new, 1).encode("utf-8"))
        try:
            if not tsc_ok():
                print("%-24s ILLEGAL-MUTANT(编译不过) —— 不算咬住" % name)
                problems += 1
                continue
            r = run('"%s" node_modules/vitest/vitest.mjs run %s' % (NODE, SPEC))
            ok = r.returncode != 0
            print("%-24s %s" % (name, "RED-OK" if ok else "GREEN!! 守卫没咬住"))
            if not ok:
                problems += 1
        finally:
            GW.write_bytes(orig.encode("utf-8"))
            back = GW.read_bytes().decode("utf-8")
            if back != orig:
                print("!!! 还原失败，文件仍是变异态：%s" % GW)
                return 2

    print("还原校验 OK（逐字节一致）；问题 %d 条" % problems)
    return 0


if __name__ == "__main__":
    sys.exit(main())
