#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Super Time 架构图每日刷新。

做三件事：
  1. 重画三张架构图（调 gen-arch.py），并用 Chrome headless 重新导出 PNG；
  2. 重新采集关键指标，与 baseline.json 对比，报告「代码变了、图可能过期」的漂移；
  3. 扫描过时文件，输出**候选清单**（只列不删）。

明确不做：删除任何源码 / 文档 / 历史产物。
唯一会删的是本脚本自己产出的历史报告（超过 30 份时删最旧的）。

用法：
  python docs/architecture/refresh.py            # 正常刷新
  python docs/architecture/refresh.py --no-png   # 跳过 PNG 导出（无 Chrome 时）

输出：<仓库>/.workbuddy/reports/arch-refresh-YYYY-MM-DD.md
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARCH = ROOT / "docs" / "architecture"
REPORTS = ROOT / ".workbuddy" / "reports"
BASELINE = ARCH / "baseline.json"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

FIGURES = [
    ("system-architecture", 1680, 2254),
    ("request-data-flow", 1680, 1406),
    ("build-pipeline", 1680, 694),
]


# ── 工具 ────────────────────────────────────────────────────────────────────
def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def count_lines(p: Path) -> int:
    try:
        with p.open("r", encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def py() -> str:
    """当前解释器（子进程复用它，避免 PATH 里没有 python）。"""
    return sys.executable


# ── 1. 重画 ─────────────────────────────────────────────────────────────────
def regenerate(do_png: bool):
    log = []
    gen = ARCH / "gen-arch.py"
    t0 = time.time()
    r = subprocess.run([py(), str(gen)], cwd=str(ARCH),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    log.append(f"- `gen-arch.py` 退出码 **{r.returncode}**，耗时 {time.time() - t0:.1f}s")
    if r.returncode != 0:
        log.append("```\n" + (r.stderr or r.stdout or "")[-1500:] + "\n```")
        return log, False

    # 校验 SVG 尺寸（防止生成器写坏了却当成成功）
    for name, _w, _h in FIGURES:
        svg = ARCH / f"{name}.svg"
        m = re.search(r'viewBox="0 0 (\d+) (\d+)"', read(svg)[:400])
        size = f"{m.group(1)}×{m.group(2)}" if m else "缺失"
        log.append(f"  - `{name}.svg` → {size}，{svg.stat().st_size // 1024} KB")

    if not do_png:
        log.append("- PNG 导出：已跳过（--no-png）")
        return log, True

    chrome = next((c for c in CHROME_CANDIDATES if Path(c).exists()), None)
    if chrome is None:
        log.append("- PNG 导出：**跳过**，本机未找到 Chrome/Edge")
        return log, True

    for name, w, h in FIGURES:
        png = ARCH / f"{name}.png"
        cmd = [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
               f"--window-size={w},{h}", "--force-device-scale-factor=1.4",
               f"--screenshot={png}",
               f"file:///{(ARCH / (name + '.svg')).as_posix()}"]
        rr = subprocess.run(cmd, capture_output=True, text=True)
        ok = png.exists() and png.stat().st_size > 20_000
        log.append(f"  - `{name}.png` → {'OK' if ok else '失败'}，"
                   f"{png.stat().st_size // 1024 if png.exists() else 0} KB")
        if not ok:
            log.append("```\n" + (rr.stderr or "")[-500:] + "\n```")
    return log, True


# ── 2. 指标采集 ─────────────────────────────────────────────────────────────
def collect_metrics() -> dict:
    m = {}

    # Remote 方法：以自动生成的 docs/API.md 为准（它由源码重建，CI 会校验一致性）
    txt = read(ROOT / "docs" / "API.md")
    hit = re.search(r"当前共\s*\*\*(\d+)\*\*\s*个\s*Remote\s*方法", txt)
    m["remote_methods"] = int(hit.group(1)) if hit else None

    # IPC 唯一通道
    pat = re.compile(r"(?:reg\.)?(?:handleIpc|onIpc)\(\s*'([^']+)'|ipcMain\.(?:handle|on)\(\s*'([^']+)'")
    chans = set()
    for f in ("ipc-misc", "ipc-wechat", "ipc-update", "ipc-remote-access", "browser-handoff"):
        for mm in pat.finditer(read(ROOT / "src" / "backend" / f"{f}.js")):
            chans.add(mm.group(1) or mm.group(2))
    m["ipc_channels"] = len(chans)

    # 宿主层
    host = sorted((ROOT / "src" / "backend").glob("*.js"))
    m["host_modules"] = len(host)
    m["host_lines"] = sum(count_lines(p) for p in host)

    # 后端包
    qd = ROOT / "src" / "backend" / "wechat-data" / "src" / "query"
    qfiles = sorted(qd.glob("*.ts"))
    m["query_files"] = len(qfiles)
    m["query_lines"] = sum(count_lines(p) for p in qfiles)
    m["retrieval_files"] = len(list((qd / "retrieval").glob("*.ts")))
    m["remotes_files"] = len(list((ROOT / "src/backend/wechat-data/src/remotes").glob("*.ts")))
    m["gateway_files"] = len(list((ROOT / "src/backend/wechat-data/src").glob("gateway*.ts")))

    # 前端
    ui = ROOT / "src" / "client" / "ui-wechat" / "src"
    files = [p for p in ui.rglob("*") if p.suffix in (".ts", ".tsx")]
    m["ui_files"] = len(files)
    m["ui_lines"] = sum(count_lines(p) for p in files)
    m["panel_tsx"] = len(list((ui / "client" / "pages" / "wechat-data" / "panels").glob("*.tsx")))

    nav = read(ui / "client" / "pages" / "wechat-data" / "nav-config.ts")
    m["nav_tabs"] = len(re.findall(r"tab:\s*'[a-z]+'", nav))
    m["nav_hidden"] = len(re.findall(r"hidden:\s*true", nav))

    # 出网点台账（数量以 spec 里的登记键为准）
    spec = read(ROOT / "src" / "backend" / "tests" / "outbound-site-coverage.spec.ts")
    m["outbound_sites"] = len(re.findall(r"\bsite:\s*'[^']+'", spec))

    # 产物
    bundle = ROOT / "src" / "backend" / "wechat-data" / "lib" / "index.js"
    m["bundle_kb"] = round(bundle.stat().st_size / 1024) if bundle.exists() else None
    return m


LABELS = {
    "remote_methods": "Remote 方法数",
    "ipc_channels": "IPC 唯一通道",
    "host_modules": "宿主层模块数",
    "host_lines": "宿主层行数",
    "query_files": "query 文件数",
    "query_lines": "query 行数",
    "retrieval_files": "retrieval 文件数",
    "remotes_files": "remotes 文件数",
    "gateway_files": "gateway 文件数",
    "ui_files": "前端 ts/tsx 文件数",
    "ui_lines": "前端行数",
    "panel_tsx": "面板视图数",
    "nav_tabs": "可路由 tab",
    "nav_hidden": "hidden tab",
    "outbound_sites": "出网点台账条目",
    "bundle_kb": "后端 bundle (KB)",
}


def compare(cur: dict):
    if not BASELINE.exists():
        BASELINE.write_text(json.dumps(
            {"createdAt": datetime.now().strftime("%Y-%m-%d %H:%M"), "metrics": cur},
            ensure_ascii=False, indent=2), encoding="utf-8")
        return None, []
    try:
        old = json.loads(BASELINE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, []
    base = old.get("metrics", {})
    drift = [(k, base.get(k), cur.get(k)) for k in cur if base.get(k) != cur.get(k)]
    return base, drift


# ── 3. 过时文件扫描（只列不删） ─────────────────────────────────────────────
def dir_stats(d: Path):
    n = 0
    size = 0
    oldest = None
    for p in d.rglob("*"):
        try:
            if not p.is_file():
                continue
            st = p.stat()
        except OSError:
            continue
        n += 1
        size += st.st_size
        if oldest is None or st.st_mtime < oldest:
            oldest = st.st_mtime
    return n, size, oldest


def scan_stale(days_scratch=30, days_doc=90):
    items = []

    # ① working/ 下长期未动的目录（临时脚本、截图、asar 解包）
    wd = ROOT / "working"
    if wd.exists():
        for sub in sorted([p for p in wd.iterdir() if p.is_dir()]):
            n, size, oldest = dir_stats(sub)
            if n == 0:
                continue
            age = (time.time() - oldest) / 86400 if oldest else 0
            if size > 50 * 1024 * 1024 or age > days_scratch:
                items.append({
                    "path": f"working/{sub.name}/",
                    "size": size, "files": n,
                    "reason": f"临时产物，最大文件已 {age:.0f} 天未修改" if size > 50 * 1024 * 1024
                              else f"临时产物，整体 {age:.0f} 天未修改",
                    "risk": "低（可重生成）" if sub.name not in ("team",) else "中（含历史调研笔记）",
                })

        # ①-b working/ 根目录的散落文件（校验截图、临时 HTML 之类）
        loose = [p for p in wd.iterdir() if p.is_file()]
        if loose:
            groups = {}
            for p in loose:
                groups.setdefault(p.suffix.lower() or "(无扩展名)", []).append(p)
            for suf, ps in sorted(groups.items(), key=lambda kv: -sum(x.stat().st_size for x in kv[1])):
                size = sum(x.stat().st_size for x in ps)
                newest = max(x.stat().st_mtime for x in ps)
                age = (time.time() - newest) / 86400
                if age < 7 and size < 5 * 1024 * 1024:
                    continue
                items.append({
                    "path": f"working/*{suf}（根目录散落 {len(ps)} 个）",
                    "size": size, "files": len(ps),
                    "reason": f"临时校验产物，最近一次修改在 {age:.0f} 天前" if age >= 7
                              else "临时校验产物，体积较大",
                    "risk": "低（截图/中间件，可重生成）",
                    "sample": [(x.name, x.stat().st_size) for x in
                               sorted(ps, key=lambda x: -x.stat().st_size)[:8]],
                })

    # ② 仓库里的备份/残留后缀
    junk_suffix = (".bak", ".orig", ".tmp", ".rej", "~")
    junk = []
    for p in list(ROOT.rglob("*")):
        if any(seg in ("node_modules", ".git", "dist") for seg in p.parts):
            continue
        if not p.is_file():
            continue
        if p.suffix in junk_suffix or ".corrupt-" in p.name:
            try:
                junk.append((p.relative_to(ROOT).as_posix(), p.stat().st_size))
            except OSError:
                pass
    if junk:
        items.append({
            "path": f"（{len(junk)} 个备份/残留文件）",
            "size": sum(s for _, s in junk), "files": len(junk),
            "reason": "扩展名是 .bak/.orig/.tmp/.corrupt-*，多为原子写或编辑留下的副本",
            "risk": "中（需逐个确认不是唯一副本）",
            "sample": junk[:8],
        })

    # ③ docs/ 里长期未改、且没被 README 索引引用的文档
    readme = read(ROOT / "README.md")
    for p in sorted((ROOT / "docs").glob("*.md")):
        age = (time.time() - p.stat().st_mtime) / 86400
        if age < days_doc:
            continue
        if p.name in readme:
            continue
        items.append({
            "path": f"docs/{p.name}",
            "size": p.stat().st_size, "files": 1,
            "reason": f"{age:.0f} 天未修改，且 README 文档索引未引用",
            "risk": "高（可能是有效文档，只是没进索引）",
        })

    # ④ 架构图自身的陈旧产物
    for name, _w, _h in FIGURES:
        svg, png = ARCH / f"{name}.svg", ARCH / f"{name}.png"
        if svg.exists() and png.exists() and png.stat().st_mtime < svg.stat().st_mtime - 5:
            items.append({
                "path": f"docs/architecture/{name}.png",
                "size": png.stat().st_size, "files": 1,
                "reason": "PNG 比对应 SVG 旧 → 本次刷新已自动重导出",
                "risk": "无（自动处理）",
            })
    return items


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} GB"


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main():
    no_png = "--no-png" in sys.argv
    REPORTS.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")

    reg_log, ok = regenerate(do_png=not no_png)
    metrics = collect_metrics()
    base, drift = compare(metrics)
    stale = scan_stale()

    total_size = sum(i["size"] for i in stale)
    total_files = sum(i["files"] for i in stale)

    L = []
    L.append(f"# 架构图每日刷新 · {today}")
    L.append("")
    L.append(f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}　·　"
             f"结果：{'成功' if ok else '**失败**'}")
    L.append("")
    L.append("## 1. 重画结果")
    L.append("")
    L += reg_log
    L.append("")

    L.append("## 2. 指标对比")
    L.append("")
    if base is None:
        L.append("首次运行，已把当前指标写入 `baseline.json` 作为基线。")
    elif not drift:
        L.append("与基线**完全一致**，架构图没有过期。")
    else:
        L.append(f"检测到 **{len(drift)} 项漂移** —— 图里的数字可能需要更新：")
        L.append("")
        L.append("| 指标 | 基线 | 当前 | 变化 |")
        L.append("|---|---|---|---|")
        for k, old, new in drift:
            arrow = "↑" if (isinstance(old, int) and isinstance(new, int) and new > old) else "↓"
            L.append(f"| {LABELS.get(k, k)} | {old} | {new} | {arrow} |")
        L.append("")
        L.append("> 处理方式：数字变了就改 `gen-arch.py` 里对应文案与 `README.md` 的事实核对表，重跑一次。")
    L.append("")

    L.append("## 3. 过时文件候选（**只列不删**）")
    L.append("")
    if not stale:
        L.append("没有发现符合条件的过时文件。")
    else:
        L.append(f"共 **{len(stale)}** 组、**{total_files}** 个文件、约 **{human(total_size)}**。")
        L.append("")
        L.append("| 路径 | 文件数 | 体积 | 为什么算过时 | 风险 |")
        L.append("|---|---|---|---|---|")
        for i in stale:
            L.append(f"| `{i['path']}` | {i['files']} | {human(i['size'])} | {i['reason']} | {i['risk']} |")
        L.append("")
        for i in stale:
            if i.get("sample"):
                L.append(f"`{i['path']}` 抽样：")
                L.append("")
                for name, size in i["sample"]:
                    L.append(f"- `{name}` — {human(size)}")
                L.append("")
        L.append("**要删哪些，请回复文件清单确认；本任务不会自动删除。**")
    L.append("")

    L.append("---")
    L.append("")
    L.append("刷新命令：`python docs/architecture/refresh.py`　·　"
             "生成器：`docs/architecture/gen-arch.py`")

    out = REPORTS / f"arch-refresh-{today}.md"
    out.write_text("\n".join(L), encoding="utf-8")

    # 只清理自己产出的旧报告，保留最近 30 份
    reports = sorted(REPORTS.glob("arch-refresh-*.md"))
    for old in reports[:-30]:
        try:
            old.unlink()
        except OSError:
            pass

    print(f"报告：{out.relative_to(ROOT)}")
    print(f"图：{'OK' if ok else 'FAILED'}")
    print(f"指标漂移：{len(drift)} 项" if base is not None else "指标基线已建立")
    print(f"过时候选：{len(stale)} 组 / {total_files} 个文件 / {human(total_size)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
