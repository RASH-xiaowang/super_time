# -*- coding: utf-8 -*-
"""clawbot-layout.spec.ts 的变异自证（B0 样式地基 + B1 会话三区化 + B2 设置双列与状态 pill）。

判据（guard-mutation-self-verification）：
  RED-OK      变红，且红的正是目标用例            ← 唯一成功判定
  MISS        变异后仍全绿 ⇒ 守卫咬不住
  ILLEGAL     tsc 不过 ⇒ 编译失败，不是断言失败
  WRONG-RED   红了但红的不是目标用例
  PARSE-FAIL  取不到用例名 ⇒ 判据本身坏
  ANCHOR      锚点未恰好命中 1 次

流水线：基线 tsc + spec 双绿 → tsc 闸门活性自检（往 spec 塞类型错误必须被判 ILLEGAL）
→ 逐条变异（tsc → spec → 核对 FAIL 行）→ 逐字节还原 → 复跑基线。

CSS 文件不进 tsc 编译图（本仓没有 CSS-in-TS），对 .css 的变异不可能产生编译错误，
故这几条不跑 tsc 闸门（脚本内注明理由）；对 .tsx/.ts 的变异与闸门探针照跑。

跑法：python tools/clawbot-layout-mutation.py
"""
import os
import re
import subprocess
import sys
from pathlib import Path

# 断言文案里有 ⇒ 等非 GBK 字符；Windows 中文控制台 stdout 默认 gbk，管道下会 UnicodeEncodeError
# （2026-10-13 C2 跑变异时实测崩在 log()）。统一按 UTF-8 出，替代表示而非崩掉整轮自证。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("SUPERTIME_NODE", "node")
TS = "src/client/ui-wechat/tsconfig.json"
SPEC_ARG = "src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-layout.spec.ts"
REPORT = ROOT / "working" / "clawbot-mutation.txt"

PANELS = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/panels"
UI = ROOT / "src/client/ui-wechat/src/client/pages/wechat-data/ui"
F_CSS = PANELS / "clawbot.module.css"
F_CHAT = PANELS / "clawbot-chat.tsx"
F_KIT = UI / "kit-table.tsx"
F_PANEL = PANELS / "ClawBotPanel.tsx"
F_RAIL = PANELS / "clawbot-rail.tsx"
F_SETTINGS = PANELS / "clawbot-settings.tsx"
F_THREAD = PANELS / "clawbot-thread.tsx"
F_SPEC = PANELS / "clawbot-layout.spec.ts"

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
ENV = {**os.environ, "CODEBUDDY_SAFE_DELETE_ENABLED": "0"}

MSGLIST = ".msgList { flex: 1 1 auto; min-height: 0; overflow: auto; }"
COLGROUP_MAIN = (
    "    <div className={wrapClass}>\n"
    "      <table className={tableCss.table} style={tableStyle}>\n"
    "        {hasWidths && (\n"
    "          <colgroup>\n"
    "            {columns.map((col) => <col key={col.id} style={col.width !== undefined ? { width: `${col.width}px` } : undefined} />)}\n"
    "          </colgroup>\n"
    "        )}\n"
    "        <thead>"
)
COLGROUP_MAIN_CUT = (
    "    <div className={wrapClass}>\n"
    "      <table className={tableCss.table} style={tableStyle}>\n"
    "        <thead>"
)

# (标签, 文件, 原锚点, 变异文本, 期望变红用例名关键词, 是否需要 tsc 闸门)
MUTS = [
    # ── B0：样式地基 ──────────────────────────────────────────
    ("msgList 不吃剩余高度（发送坞被顶出视口）", F_CSS, MSGLIST,
     ".msgList { flex: 0 0 auto; min-height: 0; overflow: auto; }", "消息列表是唯一滚动容器", False),
    ("100vh 猜高回归（P2 复活）", F_CSS, MSGLIST,
     MSGLIST[:-2] + " max-height: calc(100vh - 300px); }", "反向棘轮", False),
    ("container-type 被删（后续断点全部失效）", F_CSS, "  container-type: inline-size;\n",
     "", "inline-size", False),
    ("不滚的块被允许收缩（flex-shrink 0→1）", F_CSS,
     ".root > *:not(.shell) { flex-shrink: 0; }",
     ".root > *:not(.shell) { flex-shrink: 1; }", "不滚的块不参与压缩", False),
    ("kit scroll 默认值被顺手改（静默降级）", F_KIT, "scroll = true", "scroll = false", "默认值不变", True),
    ("clawbot 忘传 scroll={false}（嵌套滚动复发）", F_CHAT, "            scroll={false}\n", "", "显式退静态", True),
    ("旧类名残留（改名只改一半）", F_CSS, ".msgList {", ".tableScroll {", "旧类名", False),
    # ── B1：会话三区化 ────────────────────────────────────────
    ("页脚回归：.foot 混进筛选条样式", F_CSS, ".filterRight {", ".foot {", "页脚卡已取消", False),
    ("统计右端成组被拆（margin-left:auto 丢失）", F_CSS,
     ".filterRight { display: flex; align-items: center; gap: var(--nm-dense-g3, 6px); flex-wrap: wrap; margin-left: auto; }",
     ".filterRight { display: flex; align-items: center; gap: var(--nm-dense-g3, 6px); flex-wrap: wrap; }",
     "筛选条合并了统计与导出", False),
    ("发送器漂回表格上方（P5 复发）", F_CHAT,
     "      <Card className={css.tableCard} flush>",
     "      <div className={css.composerInput} />\n\n      <Card className={css.tableCard} flush>",
     "发送坞沉底", True),
    ("列隐藏机制回归：.colType display:none 塞回（P0 复活）", F_CSS,
     ".tdChars { white-space: nowrap; text-align: right; }",
     ".tdChars { white-space: nowrap; text-align: right; }\n@container (max-width: 800px) { .colType { display: none; } }",
     "列隐藏机制已退役", False),
    ("msgList 横滚被改裁切（窄表被 hidden 裁掉，G8 失效）", F_CSS, MSGLIST,
     ".msgList { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }",
     "明细表格窄了横滚", False),
    ("时间列宽被删（退回五列均分）", F_CHAT, "      width: 120,\n", "", "列宽显式", True),
    ("正文列被设宽（长文与缩略图又被压）", F_CHAT,
     "      id: 'content',\n      header: '正文',\n",
     "      id: 'content',\n      header: '正文',\n      width: 400,\n", "列宽显式", True),
    ("colgroup 主分支被删（width 不兑现）", F_KIT, COLGROUP_MAIN, COLGROUP_MAIN_CUT, "列宽显式", True),
    ("colgroup 门槛被写死 false（JSX 还在、永不渲染）", F_KIT,
     "const hasWidths = columns.some((c) => c.width !== undefined)", "const hasWidths = false", "列宽显式", True),
    ("Card body 透传被删（P10 复活：消息被裁且无滚动条）", F_CSS,
     ".tableCard > div { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }",
     ".tableCard > div { display: block; }", "Card body 透传", False),
    # ── C2：实例轨 ────────────────────────────────────────────
    ("N 档实例轨横条规则被删（750px 被左栏切走宽度）", F_CSS,
     "  .rail { flex-direction: row; align-items: stretch; overflow-y: visible; overflow-x: auto; }",
     "  .rail { flex-direction: column; }", "A4 实例轨三形态", False),
    ("shell W 档栅格断点被推远（1072 面板落不进左栏形态）", F_CSS,
     "@container (min-width: 801px) { .shell { grid-template-columns: 168px minmax(0, 1fr); } }",
     "@container (min-width: 4001px) { .shell { grid-template-columns: 168px minmax(0, 1fr); } }", "A4 实例轨三形态", False),
    # ── C1：对话流 ────────────────────────────────────────────
    ("对话流回到倒序（删反转表达式）", F_THREAD, "rows.slice().reverse()", "rows.slice()", "正序渲染", True),
    ("气泡下限宽被删（P0 的对话流复发口）", F_CSS, "  min-width: 120px;\n", "", "气泡比例护栏", False),
    # ── C3：设置重排 ──────────────────────────────────────────
    ("设置视图又回双列（3fr/2fr 回归）", F_CSS,
     ".settingsCol { display: flex; flex-direction: column; gap: var(--nm-dense-g3, 6px); }",
     ".settingsCol { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }", "R3 反转", False),
    ("发送坞实例标签被换掉（P9 复发）", F_CHAT,
     "<span className={css.dockSlot} title=", "<span className={css.muted} title=", "A5 发送坞带当前实例标签", True),
    ("自动回复 switch 退回裸 checkbox（P4 复发）", F_SETTINGS,
     'role="switch"\n          checked={cfg?.autoReply ?? false}',
     'checked={cfg?.autoReply ?? false}', "A6 行为卡", True),
    ("N 档键值两行式被删（P5 复发）", F_CSS,
     "@container (max-width: 800px) {\n  .kvItem { flex-direction: column; gap: 2px; }\n}", "",
     "A7 kvGrid 去掉无信息项", False),
    # ── B2：指挥条状态 pill（设置双列两条变异随 R3 退役：settingsGrid/faqCard 已不存在，
    #    双列回归由 C3 的「设置视图又回双列」把守）────────────────
    ("kvGrid N 档单列规则被删", F_CSS,
     "  .kvGrid { grid-template-columns: minmax(0, 1fr); }\n", "", "kvGrid 分档", False),
    ("pill 类名被换掉（状态 pill 样式丢失）", F_RAIL,
     "<span className={css.statusPill} title=", "<span className={css.hdIcon} title=", "R2 反转", True),
    ("轨自抄第二份四态映射（两处漂移的起点）", F_RAIL,
     "import { CLAWBOT_STATUS_LABEL, statusClass, statusDot } from './clawbot-status.ts'",
     "import { CLAWBOT_STATUS_LABEL } from './clawbot-status.ts'\n"
     "const statusDot = (_s: ClawbotBindingSnapshot['binding']['status']): 'done' => 'done'\n"
     "const statusClass = (_s: ClawbotBindingSnapshot['binding']['status']): string | undefined => css.stBound",
     "R2 反转", True),
    ("「状态未知」被写成「未绑定」（读失败冒充四态）", F_RAIL,
     "'状态未知'", "'未绑定'", "R2 反转", True),
]

LINES = []


def log(s):
    print(s)
    LINES.append(s)


def run(cmd):
    return subprocess.run(cmd, cwd=str(ROOT), shell=True, capture_output=True, env=ENV)


def tsc_ok():
    r = run('"%s" node_modules/typescript/bin/tsc -p %s --noEmit' % (NODE, TS))
    return r.returncode == 0, (r.stdout + r.stderr).decode("utf-8", "replace")[:400]


def spec_run():
    r = run('"%s" node_modules/vitest/vitest.mjs run %s' % (NODE, SPEC_ARG))
    merged = ANSI.sub("", r.stdout.decode("utf-8", "replace") + "\n" + r.stderr.decode("utf-8", "replace"))
    if "No test files found" in merged or "No test suite found" in merged:
        return None, merged, []
    failed = [l.strip() for l in merged.split("\n") if "FAIL " in l and ".spec." in l]
    return r.returncode == 0, merged, failed


def read(p: Path):
    b = p.read_bytes()
    eol = b"\r\n" if b.count(b"\r\n") else b"\n"
    return b.decode("utf-8").replace("\r\n", "\n"), b, eol


def write(p: Path, text: str, eol: bytes):
    p.write_bytes(text.replace("\n", eol.decode()).encode("utf-8"))


def probe(label, path, old, new, keyword, need_tsc):
    text, orig, eol = read(path)
    if text.count(old) != 1:
        return "ANCHOR", "锚点命中 %d 次（要求恰好 1）" % text.count(old)
    write(path, text.replace(old, new, 1), eol)
    try:
        if need_tsc:
            ok, err = tsc_ok()
            if not ok:
                return "ILLEGAL", "tsc 不过 ⇒ 编译失败不是咬住：%s" % err.replace("\n", " ")[:160]
        green, out, failed = spec_run()
        if green is None:
            return "NO-TESTS", "没跑到目标 spec"
        if green:
            return "MISS", "仍全绿 ⇒ 守卫咬不住"
        if not failed:
            return "PARSE-FAIL", "取不到用例名 ⇒ 判据坏了"
        if any(keyword in f for f in failed):
            return "RED-OK", failed[0][:120]
        return "WRONG-RED", "红的不是目标用例：%s" % failed[0][:120]
    finally:
        write(path, text, eol)
        assert path.read_bytes() == orig, "!!! 还原失败：%s" % path


def main():
    ok, err = tsc_ok()
    if not ok:
        log("BASELINE tsc FAILED\n" + err)
        return 2
    green, out, _ = spec_run()
    if green is not True:
        log("BASELINE spec FAILED\n" + out[-1500:])
        return 2
    log("baseline: tsc OK / spec OK")

    # 第 2 步：tsc 闸门活性自检 —— 往 spec 塞类型错误，必须被判 ILLEGAL
    v, d = probe("tsc 闸门活性", F_SPEC,
                 "const CSS = readText(join(HERE, 'clawbot.module.css'))",
                 "const CSS: number = readText(join(HERE, 'clawbot.module.css'))", "(不需要)", True)
    if v != "ILLEGAL":
        log("!!! tsc 闸门失效：故意写错类型都没被拦（%s / %s）" % (v, d))
        return 2
    log("tsc 闸门是活的（塞类型错误 → ILLEGAL）\n")

    red, bad = 0, []
    for label, path, old, new, kw, need_tsc in MUTS:
        v, d = probe(label, path, old, new, kw, need_tsc)
        log("%-9s %-42s %s" % (v, label, d))
        if v == "RED-OK":
            red += 1
        else:
            bad.append("%s [%s]" % (label, v))

    # 收口：全部还原后复跑基线（顺带证明没有残留变异体）
    ok2, err2 = tsc_ok()
    green2, _, _ = spec_run()
    log("\n复跑基线：tsc %s / spec %s" % ("OK" if ok2 else "FAILED", "OK" if green2 else "FAILED"))
    if not ok2:
        log(err2)

    log("\nRED-OK %d / 共 %d" % (red, len(MUTS)))
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(LINES) + "\n", encoding="utf-8")
    print("report -> %s" % REPORT)
    if bad or not ok2 or not green2:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
