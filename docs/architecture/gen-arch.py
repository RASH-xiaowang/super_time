#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Super Time 系统架构图生成器。

产出（同目录）：
  system-architecture.svg   分层系统架构（组件 + 边界 + 调用方向）
  request-data-flow.svg     端到端调用链与数据流（泳道 + 编号步骤）
  build-pipeline.svg        构建与交付流水线（源 → 产物 → 门禁 → 发布）
  *.html                    可缩放/点击的交互查看器（内嵌上述 SVG）

用法：
  python gen-arch.py

设计约定：
  · 纯手绘坐标（不依赖 graphviz / mermaid CLI），因此无外部依赖、可离线重建；
  · 所有事实（方法数、文件数、超时值、并发上限）均取自当前工作树，见 README 的核对表；
  · 暗色主题，与 IDE 主题一致。
"""

import html
import os
import unicodedata
from pathlib import Path

OUT = Path(__file__).resolve().parent


def _cw(ch: str) -> float:
    """粗估字符宽度（单位 em）：全角 1.0、半角约 0.56、窄标点更小。"""
    if ch == " ":
        return 0.30
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 1.0
    if ch in "iljI.,:;'|!()[]":
        return 0.34
    if ch in "mwMW@%":
        return 0.86
    return 0.56


def text_w(s: str, size: float) -> float:
    """估算一段文字在给定字号下的像素宽度（偏保守，宁可多缩一点）。"""
    return sum(_cw(c) for c in s) * size * 1.04


def fit_size(s: str, size: float, max_w: float, min_size: float = 9.0) -> float:
    """把字号压到能放进 max_w 为止（下限 min_size，避免小到不可读）。"""
    w = text_w(s, size)
    if w <= max_w:
        return size
    return max(min_size, size * max_w / w)


def wrap(s: str, size: float, max_w: float) -> list:
    """按估算宽度把一行拆成多行（优先在 · / 空格处断），用于长命令与长路径。"""
    if text_w(s, size) <= max_w:
        return [s]
    out, cur = [], ""
    for ch in s:
        if text_w(cur + ch, size) > max_w and cur:
            # 尝试回退到最近的分隔符
            for sep in (" · ", " ", "/", "（", "-"):
                idx = cur.rfind(sep)
                if idx > len(cur) * 0.45:
                    out.append(cur[:idx + len(sep)].rstrip())
                    cur = cur[idx + len(sep):] + ch
                    break
            else:
                out.append(cur)
                cur = ch
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


# ── 主题（暗色） ────────────────────────────────────────────────────────────
BG = "#0b0f14"
BAND = "#11161d"
BAND_STROKE = "#222a34"
BOX = "#161d26"
BOX_STROKE = "#2b3542"
TEXT = "#e6edf3"
MUTED = "#8b98a8"
DIM = "#64748b"

ACCENT = {
    "entry": "#94a3b8",
    "ui": "#a78bfa",
    "main": "#60a5fa",
    "worker": "#2dd4bf",
    "data": "#fbbf24",
    "ext": "#f472b6",
}

FONT = '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
MONO = '"Cascadia Code", "Consolas", monospace'


def esc(s: str) -> str:
    return html.escape(str(s), quote=False)


def text(x, y, s, size=13, fill=TEXT, weight="400", anchor="start", family=FONT,
         opacity=1.0, spacing=0.0):
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family={chr(39)}{family}{chr(39)} '
            f'font-size="{size}" fill="{fill}" font-weight="{weight}" '
            f'text-anchor="{anchor}" opacity="{opacity}"{ls}>{esc(s)}</text>')


def rect(x, y, w, h, fill, stroke=None, rx=10, sw=1.0, dash=None, opacity=1.0):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'rx="{rx}" fill="{fill}"{st}{d} opacity="{opacity}"/>')


def arrow_defs():
    out = []
    for name, color in [("a-dim", "#3d4855"), ("a-blue", ACCENT["main"]),
                        ("a-teal", ACCENT["worker"]), ("a-amber", ACCENT["data"]),
                        ("a-pink", ACCENT["ext"]), ("a-violet", ACCENT["ui"])]:
        out.append(
            f'<marker id="{name}" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{color}"/></marker>'
        )
    return "<defs>" + "".join(out) + """
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
  <feGaussianBlur stdDeviation="6" result="b"/>
  <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
  <path d="M32 0 L0 0 0 32" fill="none" stroke="#151b23" stroke-width="1"/>
</pattern>
</defs>"""


# ── 图一：分层系统架构 ──────────────────────────────────────────────────────
class Band:
    """一层：标题条 + 若干行等宽框。自动累计高度。"""

    def __init__(self, key, name, meta, y, x=56, w=1568, cols=4,
                 box_h=104, gap_x=14, gap_y=12, header=46, pad_b=18):
        self.key, self.name, self.meta, self.y = key, name, meta, y
        self.x, self.w, self.cols = x, w, cols
        self.box_h, self.gap_x, self.gap_y = box_h, gap_x, gap_y
        self.header, self.pad_b = header, pad_b
        self.rows = []

    def row(self, boxes):
        self.rows.append(boxes)
        return self

    def height(self):
        return self.header + len(self.rows) * self.box_h + (len(self.rows) - 1) * self.gap_y + self.pad_b

    def bx_w(self):
        return (self.w - 40 - (self.cols - 1) * self.gap_x) / self.cols

    def render(self):
        acc = ACCENT[self.key]
        h = self.height()
        out = [rect(self.x, self.y, self.w, h, BAND, BAND_STROKE, rx=14)]
        # 左侧色条
        out.append(f'<path d="M{self.x} {self.y + 14} a14 14 0 0 1 14 -14 h0 v{h} h0 '
                   f'a14 14 0 0 1 -14 -14 z" fill="{acc}" opacity="0.9"/>')
        out.append(rect(self.x, self.y, 5, h, acc, rx=2.5, opacity=0.95))
        out.append(text(self.x + 22, self.y + 29, self.name, 15, acc, "700", spacing=0.3))
        out.append(text(self.x + self.w - 22, self.y + 29,
                        self.meta, fit_size(self.meta, 11.5, self.w * 0.52), MUTED, "400", "end"))

        bw = self.bx_w()
        for ri, boxes in enumerate(self.rows):
            by = self.y + self.header + ri * (self.box_h + self.gap_y)
            for ci, (title, lines) in enumerate(boxes):
                bx = self.x + 20 + ci * (bw + self.gap_x)
                out.append(rect(bx, by, bw, self.box_h, BOX, BOX_STROKE, rx=9))
                out.append(rect(bx, by, 3, self.box_h, acc, rx=1.5, opacity=0.55))
                out.append(text(bx + 14, by + 24, title,
                                fit_size(title, 13.5, bw - 30), TEXT, "600"))
                for li, ln in enumerate(lines):
                    out.append(text(bx + 14, by + 45 + li * 16, ln,
                                    fit_size(ln, 11.2, bw - 28), MUTED))
        return "".join(out), h


def fig_architecture():
    W, H_start = 1680, 132
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="2110" '
             f'viewBox="0 0 {W} 2110" font-family=\'{FONT}\'>',
             arrow_defs(),
             rect(0, 0, W, 2110, BG),
             f'<rect width="{W}" height="2110" fill="url(#grid)" opacity="0.55"/>']

    # 标题
    parts.append(text(56, 52, "Super Time  系统架构", 30, TEXT, "700", spacing=0.5))
    parts.append(text(56, 82, "Electron + React 桌面工作台 ·  本地微信数据解析与检索  ·  仅 Windows x64  ·  "
                              "三进程模型（主进程 / utilityProcess worker / 渲染进程）", 12.5, MUTED))
    parts.append(text(W - 56, 52, "v1.1.0", 13, DIM, "500", "end"))
    parts.append(text(W - 56, 74, "facts verified against working tree", 10.5, DIM, "400", "end"))
    parts.append(f'<line x1="56" y1="102" x2="{W-56}" y2="102" stroke="#1e2732" stroke-width="1"/>')

    y = H_start
    bands = []
    gap_between = 20  # 层间间距（留给连接箭头与说明文字）

    # ── 入口层 ──
    b0 = Band("entry", "入口层", "3 类调用来源 · 全部收敛到同一条闸门", y, cols=3, box_h=92)
    b0.row([
        ("桌面窗口（Electron BrowserWindow）",
         ["sandbox: true · contextIsolation: true", "nodeIntegration: false · 独立 preload 桥", "唯一特权 IPC 来源（ipc-trust 校验 frame）"]),
        ("手机浏览器（局域网）",
         ["HTTP + SSE · 默认不监听（需 api_enabled 且令牌非空）", "POST /api/wechat/call · GET /api/wechat/events", "与桌面共用同一把并发闸"]),
        ("RPA / Webhook 回调",
         ["8 个厂商适配器：八爪鱼（API+MCP）/ 影刀 / 实在", "来也 / UiPath / 阿里云 / 通用 Webhook", "任务中心触发 → 回写任务状态"]),
    ])

    # ── 渲染进程 ──
    b1 = Band("ui", "渲染进程  Renderer", "React 18 · Vite 5 · 588 个 ts/tsx / 约 12.0 万行",
              y, cols=3, box_h=132)
    b1.row([
        ("ui-app  打包入口壳",
         ["ui-entry.tsx → 引导四页 → 隐私同意 → 许可证 → 主界面", "三道闸顺序由 e2e:h14-consent 在真机钉住", "capabilities / browser-gate / http-remote 分流"]),
        ("ui-wechat  数据面板",
         ["WechatDataPanel：39 个可路由 tab（15 可见 + 23 hidden + 设置）", "侧栏 5 组 · keep-alive 切页签不卸载", "nav-config.ts 是导航唯一注册表"]),
        ("panels/**  167 个视图分片",
         ["chats 63 · graph 33 · kb 28 · moments 26", "task 19 · clawbot 17 · overview 15 · ask 15", "37 个 React.lazy 边界 → 62 个 js chunk"]),
    ])
    b1.row([
        ("前端数据层  api-*.ts",
         ["api-core：WechatRemote 手写镜像 219 方法 + unwrap", "api.ts 仅 export * 转发 10 个分域文件", "cache.ts（SWR 快照 + 订阅）· image/media-cache"]),
        ("UI 原语与设计令牌",
         ["ui-primitives-shim（Radix 封装，构建期 alias 直读源码）", "scifi-theme.css：140 个 --nm-* 令牌", "圆角 6 档 / 间距 7 档 · --wx-* 为面板局部变量"]),
        ("实时刷新链",
         ["wechat-data/updated → EVENT_MAP → DOM CustomEvent", "useWechatDataUpdated（debounce 300ms）→ 缓存失效", "桌面 IPC 与手机 SSE 共用同一份 payload"]),
    ])

    # ── 主进程 ──
    b2 = Band("main", "Electron 主进程  宿主层（CommonJS）", "42 个直属模块 / 10,787 行 · main.js 581 行（组合根 + 体积棘轮）",
              y, cols=4, box_h=104)
    b2.row([
        ("main.js  组合根",
         ["单实例锁 · userData 隔离（安装版 %APPDATA%\\Super Time）", "装配 42 个宿主模块 · 三道启动闸", "打包态剥离 --inspect / --remote-debugging-port"]),
        ("窗口与安全边界",
         ["main-window.js · navigation-policy.js", "ipc-trust.js（sender + frame URL 双校验）", "media-protocol.js（wechat-media:// 流式读图）"]),
        ("IPC 注册面（39 通道）",
         ["ipc-misc 21 · ipc-wechat 9", "ipc-remote-access 4 · ipc-update 5", "全部经 ipcTrust.wrap 收口"]),
        ("调用闸门  call-gates.js",
         ["① 等后端就绪 20s（不报假错）", "② 调试豁免（打包态恒 false）", "③ 许可证 authorizeCall（抛错即拒）"]),
    ])
    b2.row([
        ("并发闸  http-queue.js",
         ["并发 2 / 排队上限 32", "重活单独 1 跑 + 4 排队（HEAVY_QUEUE_MAX）", "等待上限 240s → QUEUE_WAIT_TIMEOUT"]),
        ("RPC  backend-rpc.js",
         ["seq 配平 · 普通 60s / 长任务 600s", "dispose 握手 5s · 幽灵账 256 条", "超时即发 cancel，迟到回包计入 orphan"]),
        ("监管  backend-supervisor.js",
         ["starting → ready / down / restarting / failed", "退避 500 → 1500 → 4500ms，最多 3 次", "重启后回灌设置 + 密钥迁移 + ACL 收紧"]),
        ("LLM 传输  llm-http.js",
         ["唯一出网实现：/chat/completions · /embeddings", "/rerank · /models · 余额查询", "地址卫生 + fetchWithRetry + JSON 头"]),
    ])
    b2.row([
        ("配置与密钥",
         ["wechat-paths.js · llm-config-store.js", "atomic-json.js（tmp + rename + 损坏备份）", "secrets 镜像回灌 · icacls 收紧到当前用户"]),
        ("内置 HTTP 服务  http-server.js",
         ["866 行 · 手机端静态资源与 API", "/api/auth · status · capabilities · native", "/api/media/decoded 流式读图"]),
        ("更新与诊断",
         ["update.js（electron-updater + GitHub Releases）", "diag-log.js 轮转日志 · 渲染层 console 捕获", "console-safe.js 兜住 EPIPE"]),
        ("许可证  src/license",
         ["fingerprint（设备指纹）· crypto（签名校验）", "METHOD_FEATURE 方法级授权面", "私钥不入仓库，vendor-keys 仅公钥"]),
    ])

    # ── 后端 worker ──
    b3 = Band("worker", "后端 worker  utilityProcess", "ESM 单文件 bundle 2.3MB · 219 个 @Remote 方法 · query 层 157 文件 / 46,359 行",
              y, cols=4, box_h=108)
    b3.row([
        ("wechat-worker.js  进程入口",
         ["212 行 · 协议 init / call / cancel / dispose", "activeCalls 认领取消 · 内存哨兵 60s", "fatal → 上报父进程 → exit(1) 交给监管器"]),
        ("wechat-host.js  适配层",
         ["737 行 · 方法名枚举 · 参数守卫两档", "结果缓存 300 条 / 64MB（含负缓存）", "cancelPlan 映射 jobId · 慢调用落审计"]),
        ("Gateway 继承链（11 层）",
         ["Core→Read→AskOps→MediaOps→ExportOps→VoiceOps", "→ConfigOps→LayaOps→TaskCenter→DbHealth→Clawbot", "装饰器落在最派生原型，方法面唯一出处"]),
        ("remotes/**  28 个域处理器",
         ["ask · kb · media · export · backup · summary", "task-center · graphsearch · voicellm", "annual-narr · clawbot · wordcloud …"]),
    ])
    b3.row([
        ("query/**  业务主干",
         ["messages · sessions · contacts · moments · sns-*", "export-* · backup · search-* · files · favorites", "overview · annual · ledger · payments · calls"]),
        ("keys/**  密钥获取",
         ["db-key-v4：进程内存 YARA 扫描 + PBKDF2 校验", "image-key：V2 模板验证 AES / XOR 推断", "isaac64 · key-store（按 wxid 分槽）"]),
        ("retrieval/** + kb/**",
         ["稀疏 BM25 + 稠密向量 + fusion + rerank", "kb：pdf / docx / xlsx / plain 解析与分块", "15 + 12 文件 · 向量库 wechat_kb_vectors.db"]),
        ("answer-runtime/** + tools/**",
         ["intent → tool-loop → evidence 接地 → 引用", "15 + 10 文件 · 参数修复与失败重试", "fallback-query / tool-replay 兜底"]),
    ])
    b3.row([
        ("实时同步管线",
         ["sync-watch（WAL 监听）→ sync-trigger 合并器", "sync-page-diff 页级补丁 · sync-tail-patch 尾部追加", "SYNC_INTERVAL_MS / 兜底快速轮询"]),
        ("连接生命周期",
         ["withDb（只读）/ withWritableDb / withDbAsync", "sqlite-connection.ts 唯一构造器", "句柄必须关净：整棵树可删才判通过"]),
        ("laya/**  本地决策模型",
         ["onnxruntime-node + JS 分词（无网络）", "逐条消息分析与批量分析", "模型 1.26GB，可下载 / 采纳"]),
        ("原生桥接",
         ["koffi（win32 进程内存读写）· wx_silk.exe", "whisper 引擎 + ggml 模型 · VoipEngine.dll", "img_helper.dll（实验：原图自动下载）"]),
    ])

    # ── 数据层 ──
    b4 = Band("data", "数据与持久化层", "SQLCipher 4 → SQLite 解密快照 + 可重建派生索引 + 本机媒体缓存",
              y, cols=3, box_h=124)
    b4.row([
        ("decrypted/**  解密快照",
         ["PBKDF2-HMAC-SHA512 × 256000 → AES-256-CBC 分页解密", "页面布局：16B salt + 4000B 密文 + 16B IV + 64B HMAC", "原子 rename 发布 · schema 同构自检（不加自建表/索引）"]),
        ("派生索引库（可随时重算）",
         ["wechat_search.db · message_fts.db · contact_fts.db", "wechat_kb_vectors.db · wechat_embed_cache.db", "wechat_tasks.db · wechat_privacy.db · daily_summary.db …"]),
        ("媒体与状态缓存",
         ["decoded_images/（全局槽 + 按账号槽，缩略 .t.）", "sync-state.json（同步签名账，只记成功子集）", "exports/ · backups/（目录快照 / AES-256 .wcb）"]),
    ])
    b4.row([
        ("配置与密钥落点",
         ["<userData>/wechat：config.json · llm.json · logs/", "数据根：secrets.json（密钥）· keys.json · all_keys.json", "config.json 恒不保留密钥字段（保存即改写）"]),
        ("随包原生资产",
         ["wechat/whisper：84MB（ggml-tiny.bin 77.7MB）", "resources/win32/x64/wx_silk.exe（必须解包，不能从 asar 执行）", "native/weflow-isaac64（朋友圈视频解密 WASM）"]),
        ("微信原始数据源（只读）",
         ["xwechat_files/<wxid>/db_storage：加密分片", "cache/<月>/Sns/{Img,Video} · msg/attach", "只扫描内存取密钥，不改微信任何数据"]),
    ])

    # ── 外部 ──
    b5 = Band("ext", "外部系统与网络接口", "共 16 个出网点（docs/PRIVACY.md）· 渲染层 CSP connect-src 仅本机 · 媒体一律后端代取",
              y, cols=3, box_h=112)
    b5.row([
        ("LLM Provider（OpenAI 兼容）",
         ["/chat/completions · /embeddings · /rerank · /models", "api.deepseek.com（含 /user/balance 余额查询）", "api.siliconflow.cn 等；baseUrl / Key 由用户填"]),
        ("微信 CDN 与文章页",
         ["*.qq.com · *.wechat.com · *.wechatcdn.cn", "*.qpic.cn · *.qlogo.cn（头像，1594/1994 联系人）", "mp.weixin.qq.com（文章页，白名单单独收窄）"]),
        ("地图与公开数据",
         ["cdn.jsdelivr.net / unpkg.com（固定 4 条路径）", "geo.datav.aliyun.com（六位 adcode _full）", "世界底图优先读包内 resources/geo/world.zh.json"]),
    ])
    b5.row([
        ("模型与引擎下载",
         ["huggingface.co / hf-mirror.com（env 可换镜像）", "ggml tiny/base/small/medium/large-v3/turbo", "whisper 引擎压缩包（tag 可 pin）"]),
        ("应用更新",
         ["electron-updater → GitHub Releases", "RASH-xiaowang/super_time（build.publish）", "启动后延迟 30s 自动检查；离线退化为不可用"]),
        ("RPA 厂商（8 个适配器）",
         ["八爪鱼开放 API + MCP（mcp-rpa.bazhuayu.com）", "影刀 · 实在 · 来也 · UiPath · 阿里云 RPA", "描述符注册表；auth / dispatch / registry 三段"]),
    ])

    bands = [b0, b1, b2, b3, b4, b5]
    yy = H_start
    for b in bands:
        b.y = yy
        s, h = b.render()
        parts.append(s)
        yy += h + gap_between

    # 层间箭头（标出走的是哪条通道）
    def between(y_from, label, color, marker):
        return (f'<line x1="140" y1="{y_from}" x2="140" y2="{y_from+gap_between-4}" stroke="{color}" '
                f'stroke-width="2" marker-end="url(#{marker})"/>'
                f'<text x="158" y="{y_from+gap_between/2+4}" font-family=\'{FONT}\' font-size="10.8" '
                f'fill="{MUTED}">{esc(label)}</text>')

    specs = [
        (b0, "contextBridge（deepFreeze 冻结桥面）→ ipcRenderer.invoke", ACCENT["ui"], "a-violet"),
        (b1, "ipcMain.handle（39 通道，全部经 ipcTrust 收口）", ACCENT["main"], "a-blue"),
        (b2, "utilityProcess.postMessage（RPC seq 配平 + 分级超时）", ACCENT["worker"], "a-teal"),
        (b3, "node:sqlite（同步 API · WAL · 只读/写连接分档）", ACCENT["data"], "a-amber"),
        (b4, "HTTPS（仅后端发出；渲染层 CSP 不放行外站）", ACCENT["ext"], "a-pink"),
    ]
    for b, label, color, marker in specs:
        parts.append(between(b.y + b.height(), label, color, marker))

    y = yy

    # 底部图例
    ly = y + 26
    parts.append(f'<line x1="56" y1="{ly-14}" x2="{W-56}" y2="{ly-14}" stroke="#1e2732" stroke-width="1"/>')
    lx = 56
    for name, color in [("入口", ACCENT["entry"]), ("渲染进程", ACCENT["ui"]), ("主进程", ACCENT["main"]),
                        ("后端 worker", ACCENT["worker"]), ("数据层", ACCENT["data"]), ("外部接口", ACCENT["ext"])]:
        parts.append(rect(lx, ly, 12, 12, color, rx=3))
        parts.append(text(lx + 18, ly + 10, name, 11.5, MUTED))
        lx += 100
    parts.append(text(W - 56, ly + 10,
                      "生成器：docs/architecture/gen-arch.py　·　源文件：system-architecture.svg",
                      11, DIM, "400", "end"))

    total_h = ly + 44
    parts[0] = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total_h}" '
                f'viewBox="0 0 {W} {total_h}" font-family=\'{FONT}\'>')
    parts[2] = rect(0, 0, W, total_h, BG)
    parts[3] = f'<rect width="{W}" height="{total_h}" fill="url(#grid)" opacity="0.55"/>'
    parts.append("</svg>")
    return "".join(parts), total_h


# ── 图二：端到端调用链与数据流 ──────────────────────────────────────────────
def fig_flow():
    W = 1680
    lanes = ["渲染进程", "preload 桥", "主进程", "后端 worker", "数据 / 外部"]

    steps = [
        # (lane_index, kind, title, detail, color, side)
        (0, "start", "① 面板事件", "点击 / 滚动 / 切页签 → hook 组装参数", ACCENT["ui"]),
        (0, "step", "② api-*.ts", "WechatRemote 方法 → wechat.call(method, args)", ACCENT["ui"]),
        (1, "step", "③ contextBridge", "deepFreeze 冻结桥面 → ipcRenderer.invoke('wechat:call')", ACCENT["ui"]),
        (2, "step", "④ ipc-wechat + ipcTrust", "校验 sender 与 frame URL，只认主窗口主 frame", ACCENT["main"]),
        (2, "step", "⑤ call-gates 三道闸", "等就绪 20s → 调试豁免 → 许可证 authorizeCall（抛错即拒）", ACCENT["main"]),
        (2, "step", "⑥ http-queue 并发闸", "并发 2 / 排队 32；重活 1 跑 + 4 排；等待上限 240s", ACCENT["main"]),
        (2, "step", "⑦ backend-rpc", "seq++ 配平；普通 60s / 长任务 600s；超时发 cancel", ACCENT["main"]),
        (3, "step", "⑧ worker 分派", "activeCalls 认领 → backend.call → Gateway @Remote", ACCENT["worker"]),
        (3, "step", "⑨ query/** 读库", "157 个模块；行数/字符/时间三档 yieldToLoop 让出", ACCENT["worker"]),
        (4, "db", "⑩ SQLite", "node:sqlite 只读连接 · WAL · 页缓存策略唯一实现", ACCENT["data"]),
        (4, "ext", "⑪ 必要时出网", "LLM / CDN / 地图 / 模型下载：仅后端发出，带白名单", ACCENT["ext"]),
        (3, "step", "⑫ 回包", "{ ok: true, value } 或 { ok: false, error: { message, code } }", ACCENT["worker"]),
        (2, "step", "⑬ 原路返回", "RPC resolve → IPC 信封 → 渲染层 unwrap", ACCENT["main"]),
        (0, "end", "⑭ 渲染", "setState → 虚拟列表只挂视口附近的行", ACCENT["ui"]),
    ]

    # 实时刷新（反向）链
    rt = [
        (3, "WAL 监听", "sync-watch 捕获原始库变更"),
        (3, "合并器", "sync-trigger：tick 中记 pending，跑完补一拍"),
        (3, "增量重解密", "页级补丁 / 尾部追加 / 必要时整库重解"),
        (3, "发布修订", "sync-status → getDataRevision（内存读）"),
        (2, "广播", "wechat:event → 桌面 IPC + 手机 SSE 同一份 payload"),
        (0, "重取", "只在该分片 messageChanged 时拉增量"),
    ]

    row_h = 70
    top = 196
    box_w = 288
    box_h = 54

    # 5 条泳道等距排布（间距 = 剩余宽度均分），保证标题条与盒子都不重叠
    left, right = 96, W - 96
    span = right - left
    lane_x = [left + i * (span - box_w) / (len(lanes) - 1) for i in range(len(lanes))]

    total_rows = len(steps)
    steps_bottom = top + total_rows * row_h
    H = steps_bottom + 330

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
             f'font-family=\'{FONT}\'>', arrow_defs(), rect(0, 0, W, H, BG),
             f'<rect width="{W}" height="{H}" fill="url(#grid)" opacity="0.5"/>']

    parts.append(text(56, 52, "一次界面调用的完整链路", 30, TEXT, "700", spacing=0.5))
    parts.append(text(56, 82, "从面板点击到 SQLite 回包：14 步 · 每步都有唯一的实现点，闸门逻辑不重复", 12.5, MUTED))
    parts.append(f'<line x1="56" y1="104" x2="{W-56}" y2="104" stroke="#1e2732"/>')

    # 泳道背景
    lane_colors = [ACCENT["ui"], ACCENT["ui"], ACCENT["main"], ACCENT["worker"], ACCENT["data"]]
    for i, name in enumerate(lanes):
        ly = top - 48
        parts.append(f'<line x1="{lane_x[i]+box_w/2}" y1="{ly+36}" x2="{lane_x[i]+box_w/2}" '
                     f'y2="{steps_bottom + 4}" stroke="{lane_colors[i]}" '
                     f'stroke-width="1" stroke-dasharray="4 6" opacity="0.20"/>')
        parts.append(rect(lane_x[i], ly, box_w, 30, "#141b24", lane_colors[i] + "55", rx=8))
        parts.append(text(lane_x[i] + box_w / 2, ly + 20, name, 12.5, lane_colors[i], "600", "middle"))

    # 步骤
    centers = []
    for i, (lane, kind, title, detail, color) in enumerate(steps):
        by = top + i * row_h
        bx = lane_x[lane]
        fill = "#161d26" if kind != "start" and kind != "end" else "#1b2430"
        stroke = color + "88" if kind in ("start", "end") else BOX_STROKE
        parts.append(rect(bx, by, box_w, box_h, fill, stroke, rx=9))
        parts.append(rect(bx, by, 3, box_h, color, rx=1.5, opacity=0.7))
        parts.append(text(bx + 14, by + 23, title, fit_size(title, 13, box_w - 28), TEXT, "600"))
        parts.append(text(bx + 14, by + 41, detail, fit_size(detail, 10.6, box_w - 24), MUTED))
        centers.append((bx + box_w / 2, by, by + box_h, bx, bx + box_w))

    # 连接线
    for i in range(len(steps) - 1):
        cx, y0, y1, xl, xr = centers[i]
        nx, ny0, ny1, nxl, nxr = centers[i + 1]
        color = steps[i][4]
        if abs(cx - nx) < 1:
            parts.append(f'<line x1="{cx}" y1="{y1}" x2="{nx}" y2="{ny0}" stroke="{color}" '
                         f'stroke-width="2" marker-end="url(#a-teal)" opacity="0.8"/>')
        else:
            mid = (y1 + ny0) / 2
            x0 = xr if nx > cx else xl
            x1 = nxl if nx > cx else nxr
            parts.append(f'<path d="M{cx} {y1} C {cx} {mid}, {nx} {mid}, {nx} {ny0}" fill="none" '
                         f'stroke="{color}" stroke-width="2" marker-end="url(#a-teal)" opacity="0.8"/>')

    # 实时刷新链（下半区）
    ry = steps_bottom + 40
    parts.append(f'<line x1="56" y1="{ry-24}" x2="{W-56}" y2="{ry-24}" stroke="#1e2732"/>')
    parts.append(text(56, ry + 8, "反向：数据变更如何回到界面（事件为主、轮询兜底）", 17, ACCENT["worker"], "700"))
    parts.append(text(56, ry + 32, "同步链只在「源签名变了」时重解密；渲染层每秒只读一次内存修订号，避免每秒一次消息 SQL", 12, MUTED))

    rt_y = ry + 54
    rt_w = 246
    gap_rt = 22
    rt_x = [56 + i * (rt_w + gap_rt) for i in range(len(rt))]
    for i, (lane, title, detail) in enumerate(rt):
        bx = rt_x[i]
        by = rt_y
        parts.append(rect(bx, by, rt_w, 64, "#161d26", BOX_STROKE, rx=9))
        parts.append(rect(bx, by, rt_w, 3, ACCENT["worker"], rx=1.5, opacity=0.6))
        parts.append(text(bx + 12, by + 24, title, 12.5, TEXT, "600"))
        parts.append(text(bx + 12, by + 43, detail[:21], fit_size(detail[:21], 10.4, rt_w - 22), MUTED))
        if len(detail) > 21:
            parts.append(text(bx + 12, by + 56, detail[21:42], fit_size(detail[21:42], 10.4, rt_w - 22), MUTED))
        if i < len(rt) - 1:
            parts.append(f'<line x1="{bx+rt_w}" y1="{by+32}" x2="{bx+rt_w+gap_rt}" y2="{by+32}" '
                         f'stroke="{ACCENT["worker"]}" stroke-width="2" marker-end="url(#a-teal)" opacity="0.75"/>')

    # 落点注释
    ny = rt_y + 100
    parts.append(text(56, ny, "写路径", 13, ACCENT["data"], "700"))
    parts.append(text(112, ny, "导出 / 备份 / 编辑消息 / 改配置 → 同一个 @Remote 面 → 原子写（tmp + rename）；"
                               "写连接用 withWritableDb，跨 await 用 withDbAsync", 11.5, MUTED))

    total = ny + 36
    parts[0] = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total}" viewBox="0 0 {W} {total}" font-family=\'{FONT}\'>'
    parts[2] = rect(0, 0, W, total, BG)
    parts[3] = f'<rect width="{W}" height="{total}" fill="url(#grid)" opacity="0.5"/>'
    parts.append("</svg>")
    return "".join(parts), total


# ── 图三：构建与交付流水线 ──────────────────────────────────────────────────
def fig_build():
    W = 1680
    cols = [
        ("源码", [
            ("src/backend/wechat-data/src/**", "gateway*.ts · query/** · keys/** · remotes/**", ACCENT["worker"]),
            ("src/backend/*.js", "宿主层 42 个 CommonJS 模块", ACCENT["main"]),
            ("src/client/ui-wechat + ui-app", "588 个 ts/tsx", ACCENT["ui"]),
            ("src/license/** · preload.js · main.js", "授权与桥面", ACCENT["main"]),
        ]),
        ("构建命令", [
            ("npm run build:backend", "esbuild → ESM · platform=node · packages=external", ACCENT["worker"]),
            ("npm run build:types", "tsc 声明 → lib/types/**.d.ts", ACCENT["worker"]),
            ("npm run build:ui", "vite build → src/client/ui-dist/", ACCENT["ui"]),
            ("npm run docs:api", "扫 @Remote → docs/API.md", ACCENT["worker"]),
        ]),
        ("产物（入仓 / 不入仓）", [
            ("wechat-data/lib/index.js", "2.3MB 单文件 · 运行时只加载它", ACCENT["worker"]),
            ("wechat-data/lib/types/**", "前端只从这里取后端类型", ACCENT["worker"]),
            ("src/client/ui-dist/**", "不入仓（.gitignore）", ACCENT["ui"]),
            ("docs/API.md", "219 个方法 · 自动生成", ACCENT["worker"]),
        ]),
        ("一致性闸门", [
            ("check:backend / check:types", "临时目录重建后与工作树逐字节比对", ACCENT["data"]),
            ("docs:api:check", "文档与方法面数量/内容不一致即红", ACCENT["data"]),
            ("typecheck（5 套 tsconfig）", "server · client · ui-app · checks · tests", ACCENT["data"]),
            ("check:deps-provenance · check:shim", "file: 依赖来源表 · 原语 shim 一致性", ACCENT["data"]),
        ]),
        ("打包与发布", [
            ("electron-builder --dir / --win nsis", "asar + asarUnpack（koffi / onnxruntime / native / whisper）", ACCENT["ext"]),
            ("electronFuses", "runAsNode=false · onlyLoadAppFromAsar · asar 完整性校验", ACCENT["ext"]),
            ("CI 三档", "PR 门禁 · nightly 03:17 · v* tag 发版", ACCENT["ext"]),
            ("GitHub Releases", "electron-updater 更新源（同一份 build.publish）", ACCENT["ext"]),
        ]),
    ]

    top = 172
    col_w = 300
    gap = 20
    box_h = 78
    H = top + 4 * (box_h + 14) + 150

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
             f'font-family=\'{FONT}\'>', arrow_defs(), rect(0, 0, W, H, BG),
             f'<rect width="{W}" height="{H}" fill="url(#grid)" opacity="0.5"/>']

    parts.append(text(56, 52, "构建与交付流水线", 30, TEXT, "700", spacing=0.5))
    parts.append(text(56, 82, "四道产物一致性闸门 + 三档 CI：改了后端源码却忘记提交 lib/ 会直接红", 12.5, MUTED))
    parts.append(f'<line x1="56" y1="104" x2="{W-56}" y2="104" stroke="#1e2732"/>')

    xs = [56 + i * (col_w + gap) for i in range(5)]
    for ci, (head, items) in enumerate(cols):
        x = xs[ci]
        color = items[0][2]
        parts.append(rect(x, top - 44, col_w, 32, "#141b24", color + "55", rx=8))
        parts.append(text(x + col_w / 2, top - 23, head, 13, color, "600", "middle"))
        for ri, (title, detail, c) in enumerate(items):
            by = top + ri * (box_h + 14)
            parts.append(rect(x, by, col_w, box_h, BOX, BOX_STROKE, rx=9))
            parts.append(rect(x, by, 3, box_h, c, rx=1.5, opacity=0.6))
            # 命令/路径类标题用等宽字体，超宽自动折行（最多两行）
            tlines = wrap(title, 12.0, col_w - 26)
            for ti, tl in enumerate(tlines[:2]):
                parts.append(text(x + 12, by + 24 + ti * 15,
                                  tl, fit_size(tl, 12.0, col_w - 26), TEXT, "600", family=MONO))
            dy0 = 24 + 15 * min(len(tlines), 2) + 8
            dlines = wrap(detail, 10.4, col_w - 26)
            for di, dl in enumerate(dlines[:2]):
                parts.append(text(x + 12, by + dy0 + di * 14,
                                  dl, fit_size(dl, 10.4, col_w - 26), MUTED))
        if ci < 4:
            mx = x + col_w + gap / 2
            parts.append(f'<line x1="{mx-6}" y1="{top+62}" x2="{mx+6}" y2="{top+62}" stroke="#3d4855" '
                         f'stroke-width="2" marker-end="url(#a-dim)"/>')

    ny = top + 4 * (box_h + 14) + 18
    # 底部说明：按行逐个量宽，超宽就缩字号，绝不溢出卡片
    notes = [
        "运行时只有 lib/index.js —— 改了 src 不重建，跑起来的仍是旧代码；",
        "前端类型只能来自 lib/types，手写镜像（219 方法）由 remote-contract.spec 锁死；",
        "产物与源码逐字节一致才允许合并；CI 在 windows-latest 上真的起 Electron 跑 e2e，不是只跑单测。",
    ]
    parts.append(rect(56, ny, W - 112, 108, "#121a16", "#1f3a2e", rx=12))
    parts.append(text(76, ny + 28, "这条流水线保证的事", 13, ACCENT["worker"], "700"))
    for i, n in enumerate(notes):
        parts.append(text(76, ny + 52 + i * 20, ("①②③"[i] + " " + n) if False else n,
                          fit_size(n, 11.5, W - 160), MUTED))

    total = ny + 136
    parts[0] = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total}" viewBox="0 0 {W} {total}" font-family=\'{FONT}\'>'
    parts[2] = rect(0, 0, W, total, BG)
    parts[3] = f'<rect width="{W}" height="{total}" fill="url(#grid)" opacity="0.5"/>'
    parts.append("</svg>")
    return "".join(parts), total


# ── 交互查看器 ──────────────────────────────────────────────────────────────
def viewer(title, svg_text, w, h, note):
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>{esc(title)} · Super Time 架构</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; height: 100%; background: #0b0f14; color: #e6edf3;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; overflow: hidden; }}
  #bar {{ position: fixed; inset: 0 0 auto 0; height: 52px; display: flex; align-items: center;
    gap: 14px; padding: 0 18px; background: rgba(11,15,20,.92); border-bottom: 1px solid #1e2732;
    backdrop-filter: blur(8px); z-index: 10; }}
  #bar h1 {{ font-size: 13px; font-weight: 600; margin: 0; letter-spacing: .3px; }}
  #bar .sub {{ font-size: 11.5px; color: #8b98a8; }}
  #bar .spacer {{ flex: 1; }}
  button {{ background: #161d26; color: #cbd5e1; border: 1px solid #2b3542; border-radius: 7px;
    padding: 5px 11px; font-size: 12px; cursor: pointer; font-family: inherit; }}
  button:hover {{ border-color: #4b5a6d; color: #fff; }}
  #stage {{ position: absolute; inset: 52px 0 0 0; overflow: hidden; cursor: grab; }}
  #stage.drag {{ cursor: grabbing; }}
  #wrap {{ transform-origin: 0 0; width: {w}px; height: {h}px; }}
  #wrap svg {{ display: block; }}
  #hint {{ position: fixed; right: 16px; bottom: 14px; font-size: 11px; color: #5c6b7d;
    background: rgba(11,15,20,.85); padding: 6px 10px; border-radius: 6px; border: 1px solid #1e2732; }}
</style>
</head>
<body>
<div id="bar">
  <h1>{esc(title)}</h1>
  <span class="sub">{esc(note)}</span>
  <span class="spacer"></span>
  <button data-z="in">放大 +</button>
  <button data-z="out">缩小 −</button>
  <button data-z="fit">适应窗口</button>
  <button data-z="reset">1:1</button>
</div>
<div id="stage"><div id="wrap">{svg_text}</div></div>
<div id="hint">滚轮缩放 · 拖拽平移 · 双击复位</div>
<script>
(function () {{
  const stage = document.getElementById('stage');
  const wrap = document.getElementById('wrap');
  const W = {w}, H = {h};
  let s = 1, tx = 0, ty = 0;

  function apply() {{
    wrap.style.transform = `translate(${{tx}}px,${{ty}}px) scale(${{s}})`;
  }}
  function fit() {{
    const r = stage.getBoundingClientRect();
    s = Math.min((r.width - 32) / W, (r.height - 32) / H);
    tx = (r.width - W * s) / 2;
    ty = (r.height - H * s) / 2;
    apply();
  }}
  function zoom(f, cx, cy) {{
    const r = stage.getBoundingClientRect();
    cx = cx === undefined ? r.width / 2 : cx;
    cy = cy === undefined ? r.height / 2 : cy;
    const ns = Math.min(4, Math.max(0.12, s * f));
    tx = cx - (cx - tx) * (ns / s);
    ty = cy - (cy - ty) * (ns / s);
    s = ns; apply();
  }}
  stage.addEventListener('wheel', e => {{
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }}, {{ passive: false }});

  let down = false, sx = 0, sy = 0;
  stage.addEventListener('pointerdown', e => {{
    down = true; sx = e.clientX - tx; sy = e.clientY - ty;
    stage.classList.add('drag'); stage.setPointerCapture(e.pointerId);
  }});
  stage.addEventListener('pointermove', e => {{
    if (!down) return; tx = e.clientX - sx; ty = e.clientY - sy; apply();
  }});
  stage.addEventListener('pointerup', e => {{
    down = false; stage.classList.remove('drag');
  }});
  stage.addEventListener('dblclick', fit);

  document.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => {{
    const z = b.dataset.z;
    if (z === 'in') zoom(1.25);
    else if (z === 'out') zoom(1 / 1.25);
    else if (z === 'fit') fit();
    else {{ s = 1; tx = 20; ty = 20; apply(); }}
  }});

  addEventListener('resize', fit);
  fit();
}})();
</script>
</body>
</html>
"""


def mermaid_source():
    return """%% Super Time 系统架构（Mermaid 源文件 · 可移植版本）
%% 与 system-architecture.svg 同源：改这里请同步改 gen-arch.py
flowchart TB
  subgraph ENTRY["入口层"]
    W1["桌面窗口<br/>BrowserWindow · sandbox"]
    W2["手机浏览器<br/>HTTP + SSE"]
    W3["RPA / Webhook<br/>8 个厂商适配器"]
  end

  subgraph RENDERER["渲染进程"]
    R1["ui-app 入口壳<br/>引导 → 同意 → 许可证"]
    R2["ui-wechat 数据面板<br/>39 tab / 侧栏 5 组"]
    R3["panels 167 个视图"]
    R4["api-*.ts + cache.ts"]
  end

  subgraph MAIN["Electron 主进程（宿主层）"]
    M1["main.js 组合根"]
    M2["ipc-trust / navigation-policy / media-protocol"]
    M3["call-gates 三道闸"]
    M4["http-queue 并发闸"]
    M5["backend-rpc"]
    M6["backend-supervisor"]
    M7["llm-http / update / diag-log"]
    M8["http-server（手机端）"]
  end

  subgraph WORKER["后端 worker（utilityProcess）"]
    K1["wechat-worker.js"]
    K2["wechat-host.js 适配层"]
    K3["Gateway 继承链<br/>219 @Remote"]
    K4["query/** 157 文件"]
    K5["keys/** 11 文件"]
    K6["retrieval/** + kb/**"]
    K7["answer-runtime/** + tools/**"]
    K8["laya/** 本地模型"]
  end

  subgraph DATA["数据与持久化"]
    D1[("decrypted/**<br/>SQLCipher → SQLite")]
    D2[("派生索引<br/>search / vectors / tasks")]
    D3[("媒体缓存<br/>decoded_images")]
    D4[("配置与密钥<br/>config / secrets / keys")]
  end

  subgraph EXTERNAL["外部系统"]
    E1["LLM Provider<br/>OpenAI 兼容"]
    E2["微信 CDN / 文章页"]
    E3["地图 GeoJSON"]
    E4["HuggingFace / 镜像"]
    E5["GitHub Releases"]
    E6["RPA 厂商"]
  end

  W1 --> R1
  W2 --> M8
  W3 --> K4
  R1 --> R2 --> R3 --> R4
  R4 -->|"contextBridge"| M1
  M1 --> M3 --> M4 --> M5
  M5 -->|"postMessage"| K1
  K1 --> K2 --> K3
  K3 --> K4
  K3 --> K5
  K3 --> K6
  K3 --> K7
  K3 --> K8
  K4 --> D1
  K4 --> D2
  K4 --> D3
  K5 --> D4
  K6 --> D2
  M1 --> M6
  M7 --> E1
  M7 --> E5
  K4 --> E2
  K4 --> E3
  K4 --> E4
  K4 --> E6
"""


def main():
    svg1, h1 = fig_architecture()
    svg2, h2 = fig_flow()
    svg3, h3 = fig_build()

    (OUT / "system-architecture.svg").write_text(svg1, encoding="utf-8")
    (OUT / "request-data-flow.svg").write_text(svg2, encoding="utf-8")
    (OUT / "build-pipeline.svg").write_text(svg3, encoding="utf-8")

    (OUT / "system-architecture.html").write_text(
        viewer("系统分层架构", svg1, 1680, h1,
               "6 层 / 调用下行 · 数据上行"), encoding="utf-8")
    (OUT / "request-data-flow.html").write_text(
        viewer("端到端调用与数据流", svg2, 1680, h2,
               "14 步调用链 + 反向实时刷新链"), encoding="utf-8")
    (OUT / "build-pipeline.html").write_text(
        viewer("构建与交付流水线", svg3, 1680, h3,
               "源 → 产物 → 一致性闸门 → 发布"), encoding="utf-8")

    (OUT / "architecture.mmd").write_text(mermaid_source(), encoding="utf-8")

    for f in sorted(OUT.iterdir()):
        if f.is_file():
            print(f"{f.name}\t{f.stat().st_size} bytes")


if __name__ == "__main__":
    main()
