import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 聊天面板 — React 版，忠实迁移 WeChatPanel 的 chats 页签核心：左侧会话
 * 列表（搜索/统计/置顶/批量导出），右侧消息流（分页加载 + 多类型消息渲染）。
 * 数据通过 DSH 后端 Remote（sessions + messages）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from "./hooks.js";
import { SearchInput, Segmented } from "../ui/kit.js";
import { apiBuildSearchIndex, apiClearAllSessionDrafts, apiClearSessionDraft, apiEditChatMessage, apiExportSessionMessages, apiGetAvatar, apiGetAvatarsLocal, apiGetDailyCounts, apiGetGroupInfo, apiGetImageDataUrl, apiGetMessageFile, apiGetMessages, apiGetNewMessages, apiGetPaymentStatus, apiGetSearchIndexStatus, apiGetSessions, apiGetVideoInfo, apiGetVoiceInfo, apiGetVoiceTranscript, apiListEditedMessages, apiResetEditedMessage, apiResolveChatHistory, apiSearchMessages, apiTranscribeVoiceMessage, pickDirectory, readRenderCache, writeRenderCache } from "../api.js";
import { IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16, IconCopyOutline16, IconDataOutline16, IconDownloadOutline16, IconEditOutline16, IconFullscreenOutline16, IconLinkOutline14, IconListPenOutline16, IconPlayOutline16, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { RainWindow } from "./rain-window.js";
import css from './chats.module.css';
/** 16px calendar glyph (kept local; the primitives set has no calendar). */
function IconCalendar() {
    return (_jsxs("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [_jsx("rect", { x: "1.5", y: "2.5", width: "13", height: "12", rx: "2", stroke: "currentColor", strokeWidth: "1.4" }), _jsx("path", { d: "M1.5 6h13M5 1v3M11 1v3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })] }));
}
/** 14px pin glyph for pinned sessions. */
function IconPin() {
    return (_jsx("svg", { width: "13", height: "13", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true", children: _jsx("path", { d: "M9.2 1.6 14.4 6.8c.4.4.2 1-.3 1.1l-2.4.5-3.1 3.1c-.4.4-1 .4-1.4 0l-.3-.3L4 14.6c-.3.3-.8.3-1.1 0l-.5-.5c-.3-.3-.3-.8 0-1.1l3.4-3.1-.3-.3c-.4-.4-.4-1 0-1.4l3.1-3.1.5-2.4c.1-.5.7-.7 1.1-.3Z" }) }));
}
/** 15px image glyph for media placeholders. */
function IconImage() {
    return (_jsxs("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [_jsx("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2", stroke: "currentColor", strokeWidth: "1.4" }), _jsx("circle", { cx: "5.5", cy: "6", r: "1.4", fill: "currentColor" }), _jsx("path", { d: "m2.5 12.5 3.5-3.5 2.5 2.5 2.5-2.5 2.5 2.5", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round" })] }));
}
/** 14px minus glyph for the lightbox zoom control. */
function IconMinus() {
    return (_jsx("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "M3 8h10", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }) }));
}
/** Open an external http(s) URL in a new tab (protocol-checked). */
function openLink(url) {
    if (/^https?:\/\//i.test(url)) {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}
/** Split text into segments, turning http(s) URLs into clickable links. */
function renderTextWithLinks(text) {
    const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
    return parts.map((part, idx) => {
        if (/^https?:\/\//i.test(part)) {
            const clean = part.replace(/[。，；、！？）)】》>]+$/, '');
            return (_jsx("a", { className: css.msgTextLink, href: clean, target: "_blank", rel: "noopener noreferrer", title: clean, onClick: (e) => { e.preventDefault(); openLink(clean); }, children: clean }, idx));
        }
        return _jsx("span", { children: part }, idx);
    });
}
/** Wechat transfer state label (mirrors st_control transfer_status_label). */
function transferStatusLabel(self, paySub) {
    switch (paySub) {
        case '3':
        case '8': return self ? '已被接收' : '已收款';
        case '4':
        case '9': return '已退还';
        case '5':
        case '10': return '已过期退回';
        case '7': return '待领取';
        case '1': return self ? '等待对方领取' : '待收款';
        default: return '';
    }
}
/** Transfer visual state bucket: pending (arrow) / accepted (check) / refunded (muted). */
function transferStateKey(paySub) {
    switch (paySub) {
        case '1':
        case '7': return 'pending';
        case '4':
        case '5':
        case '9':
        case '10': return 'refunded';
        default: return 'accepted';
    }
}
/** White check glyph: transfer received/accepted state. */
function TransferCheckGlyph() {
    return (_jsx("svg", { width: "17", height: "17", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "m4 8.4 2.6 2.6L12 5.6", stroke: "#fff", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }) }));
}
/** White transfer arrow glyph inside the wechat transfer card. */
function TransferArrowGlyph() {
    return (_jsxs("svg", { width: "17", height: "17", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [_jsx("path", { d: "M3.2 5.2h9.4M9.8 2.6 12.6 5.2 9.8 7.8", stroke: "#fff", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }), _jsx("path", { d: "M12.8 10.8H3.4M6.2 8.2 3.4 10.8l2.8 2.6", stroke: "#fff", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" })] }));
}
/** Format a unix-seconds timestamp as HH:MM or date. */
function fmtTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay)
        return hhmm;
    const yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString())
        return '昨天';
    return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtMsgTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Module-level avatar cache (username -> data URL / remote URL / null). */
const avatarCache = new Map();
/** Avatar: lazy-loads the real WeChat avatar via Remote, falls back to a letter tile. */
function Avatar({ name, username, size }) {
    const key = username || name || '';
    const cached = key ? avatarCache.get(key) : undefined;
    const [, force] = useState(0);
    useEffect(() => {
        let cancelled = false;
        if (!key || cached !== undefined)
            return;
        apiGetAvatar({ username: key })
            .then((r) => {
            const value = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null;
            avatarCache.set(key, value);
            if (!cancelled)
                force(v => v + 1);
        })
            .catch(() => { avatarCache.set(key, null); if (!cancelled)
            force(v => v + 1); });
        return () => { cancelled = true; };
    }, [key, cached]);
    const letter = (name || username || '?').slice(0, 1).toUpperCase();
    const hue = (username || name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    const src = cached ?? null;
    if (src) {
        return (_jsx("div", { className: css.avatar, style: { width: size ?? 36, height: size ?? 36, overflow: 'hidden' }, children: _jsx("img", { src: src, alt: letter, className: css.avatarImg, width: size ?? 36, height: size ?? 36 }) }));
    }
    return (_jsx("div", { className: css.avatar, style: { width: size ?? 36, height: size ?? 36, background: `hsl(${hue} 45% 55%)` }, children: letter }));
}
/** Voice message bubble: duration from VoiceInfo; transcript from local Whisper cache. */
function MessageVoice({ m, selfName }) {
    const [dur, setDur] = useState(null);
    const [transcript, setTranscript] = useState(null);
    const [transcribing, setTranscribing] = useState(false);
    const [tErr, setTErr] = useState(null);
    useEffect(() => {
        let cancelled = false;
        apiGetVoiceInfo({ username: selfName, localId: m.localId })
            .then((r) => {
            if (cancelled)
                return;
            if (r.available)
                setDur(r.length ? Math.max(1, Math.round((r.length ?? 0) / 2000)) : null);
        })
            .catch(() => { });
        apiGetVoiceTranscript({ username: selfName, localId: m.localId })
            .then((r) => { if (!cancelled && r.text)
            setTranscript(r.text); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [selfName, m.localId]);
    const doTranscribe = async () => {
        setTranscribing(true);
        setTErr(null);
        try {
            const r = await apiTranscribeVoiceMessage({ username: selfName, localId: m.localId });
            if (r.ok && r.text)
                setTranscript(r.text);
            else
                setTErr(r.error ?? '转写失败');
        }
        catch (e) {
            setTErr(e.message);
        }
        finally {
            setTranscribing(false);
        }
    };
    return (_jsxs("div", { className: css.msgVoice, children: [_jsx("span", { className: css.msgVoiceIcon, children: _jsx(IconPlayOutline16, { size: 13 }) }), _jsxs("span", { className: css.msgVoiceWave, "aria-hidden": "true", children: [_jsx("i", {}), _jsx("i", {}), _jsx("i", {}), _jsx("i", {}), _jsx("i", {})] }), dur !== null && _jsxs("span", { className: css.msgVoiceDur, children: [dur, "\""] }), !transcript && !transcribing && !tErr && (_jsx("button", { type: "button", className: css.msgVoiceBtn, onClick: () => { void doTranscribe(); }, children: "\u8BED\u97F3\u8F6C\u6587\u5B57" })), transcribing && _jsx("span", { className: css.msgVoiceBusy, children: "\u8F6C\u5199\u4E2D\u2026" }), tErr && !transcript && (_jsx("span", { className: css.msgVoiceErr, title: tErr, children: tErr.length > 28 ? tErr.slice(0, 28) + '…' : tErr })), transcript && _jsxs("span", { className: css.msgVoiceText, children: ["\u3010", transcript, "\u3011"] })] }));
}
/** Video message bubble: cover thumbnail when decodable, else degrade hint. */
function MessageVideo({ m, selfName }) {
    const [cover, setCover] = useState(null);
    const [vErr, setVErr] = useState(null);
    useEffect(() => {
        let cancelled = false;
        apiGetVideoInfo({ username: selfName, localId: m.localId })
            .then((r) => {
            if (cancelled)
                return;
            if (r.coverUrl)
                setCover(r.coverUrl);
            else
                setVErr(r.error === 'hevc-unsupported' ? 'wxgf/HEVC 封面（需系统解码）' : (r.error ?? '视频不可用'));
        })
            .catch((e) => { if (!cancelled)
            setVErr(e.message); });
        return () => { cancelled = true; };
    }, [selfName, m.localId]);
    if (vErr) {
        return (_jsxs("div", { className: css.msgBubble, children: [_jsxs("span", { className: css.msgVoicelike, children: [_jsx(IconPlayOutline16, { size: 13 }), " \u89C6\u9891"] }), _jsxs("span", { className: css.msgMuted, children: ["\uFF08", vErr, "\uFF09"] })] }));
    }
    if (!cover) {
        return (_jsxs("div", { className: css.msgBubble, children: [_jsxs("span", { className: css.msgVoicelike, children: [_jsx(IconPlayOutline16, { size: 13 }), " \u89C6\u9891"] }), _jsx("span", { className: css.msgMuted, children: "\u52A0\u8F7D\u4E2D\u2026" })] }));
    }
    return (_jsx("div", { className: css.msgBubble, style: { padding: 4 }, children: _jsxs("span", { className: css.msgVideoWrap, children: [_jsx("img", { src: cover, alt: "\u89C6\u9891\u5C01\u9762", className: css.msgImage, loading: "lazy" }), _jsx("span", { className: css.msgVideoPlay, children: _jsx(IconPlayOutline16, { size: 16 }) })] }) }));
}
/** Lazy message image: resolve + decode via Remote, render as data URL. */
function MessageImage({ m, selfName, onOpen }) {
    const [src, setSrc] = useState(null);
    const [imgErr, setImgErr] = useState(null);
    useEffect(() => {
        let cancelled = false;
        setSrc(null);
        setImgErr(null);
        apiGetImageDataUrl({ username: selfName, localId: m.localId })
            .then((r) => {
            if (cancelled)
                return;
            if (r.url)
                setSrc(r.url);
            else
                setImgErr(r.error ?? '图片不可用');
        })
            .catch((e) => { if (!cancelled)
            setImgErr(e.message); });
        return () => { cancelled = true; };
    }, [selfName, m.localId]);
    if (imgErr) {
        const isHevc = imgErr === 'hevc-unsupported';
        const isNoDat = imgErr.startsWith('找不到 .dat');
        const short = isHevc ? 'wxgf 原图' : isNoDat ? '图片（未解码）' : imgErr;
        return (_jsx("div", { className: css.msgBubble, title: imgErr, children: _jsxs("span", { className: css.msgMuted, children: [_jsx(IconImage, {}), " ", short] }) }));
    }
    if (!src) {
        return _jsx("div", { className: css.msgBubble, style: { padding: 4 }, children: _jsxs("span", { className: css.msgMuted, children: [_jsx(IconImage, {}), " \u56FE\u7247\u52A0\u8F7D\u4E2D\u2026"] }) });
    }
    return (_jsx("div", { className: css.msgBubble, style: { padding: 4, cursor: 'zoom-in' }, onClick: () => { if (onOpen)
            onOpen(m); }, children: _jsx("img", { src: src, alt: "\u56FE\u7247", className: css.msgImage, loading: "lazy" }) }));
}
/**
 * Lightbox image viewer: zoom (wheel/buttons), drag pan, prev/next, ESC/backdrop close.
 * Resolves each image to a data URL through the Remote on demand.
 */
function ImageViewer({ images, index, onClose, onIndexChange }) {
    const item = images[index];
    const [src, setSrc] = useState(null);
    const [vErr, setVErr] = useState(null);
    const [loading, setLoading] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [off, setOff] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const dragStart = useRef(null);
    useEffect(() => {
        if (!item)
            return;
        let cancelled = false;
        setSrc(null);
        setVErr(null);
        setZoom(1);
        setOff({ x: 0, y: 0 });
        setLoading(true);
        apiGetImageDataUrl({ username: item.username, localId: item.localId })
            .then((r) => {
            if (cancelled)
                return;
            if (r.url)
                setSrc(r.url);
            else
                setVErr(r.error ?? '图片不可用');
        })
            .catch((e) => { if (!cancelled)
            setVErr(e.message); })
            .finally(() => { if (!cancelled)
            setLoading(false); });
        return () => { cancelled = true; };
    }, [item?.username, item?.localId]);
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape')
                onClose();
            else if (e.key === 'ArrowLeft')
                onIndexChange((index - 1 + images.length) % images.length);
            else if (e.key === 'ArrowRight')
                onIndexChange((index + 1) % images.length);
        };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, [onClose, onIndexChange, index, images.length]);
    const zoomBy = (f) => { setZoom(z => Math.min(Math.max(z * f, 0.25), 8)); };
    const reset = () => { setZoom(1); setOff({ x: 0, y: 0 }); };
    return createPortal(_jsxs("div", { className: css.viewerOverlay, role: "dialog", onWheel: (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); }, onMouseMove: (e) => {
            if (dragging && dragStart.current) {
                setOff({
                    x: dragStart.current.ox + (e.clientX - dragStart.current.x),
                    y: dragStart.current.oy + (e.clientY - dragStart.current.y),
                });
            }
        }, onMouseUp: () => { setDragging(false); dragStart.current = null; }, onMouseLeave: () => { setDragging(false); dragStart.current = null; }, children: [_jsxs("div", { className: css.viewerBar, children: [_jsxs("span", { className: css.viewerCount, children: [index + 1, " / ", images.length] }), _jsx("button", { type: "button", className: css.viewerBtn, title: "\u653E\u5927", "aria-label": "\u653E\u5927", onClick: () => { zoomBy(1.3); }, children: _jsx(IconPlusOutline16, { size: 15 }) }), _jsx("button", { type: "button", className: css.viewerBtn, title: "\u7F29\u5C0F", "aria-label": "\u7F29\u5C0F", onClick: () => { zoomBy(1 / 1.3); }, children: _jsx(IconMinus, {}) }), _jsx("button", { type: "button", className: css.viewerBtn, title: "1:1", "aria-label": "1:1", onClick: reset, children: _jsx(IconFullscreenOutline16, { size: 15 }) }), _jsx("button", { type: "button", className: css.viewerBtn, title: "\u4E0A\u4E00\u5F20", "aria-label": "\u4E0A\u4E00\u5F20", onClick: () => { onIndexChange((index - 1 + images.length) % images.length); }, children: _jsx(IconChevronLeftOutline14, {}) }), _jsx("button", { type: "button", className: css.viewerBtn, title: "\u4E0B\u4E00\u5F20", "aria-label": "\u4E0B\u4E00\u5F20", onClick: () => { onIndexChange((index + 1) % images.length); }, children: _jsx(IconChevronRightOutline14, {}) }), _jsx("button", { type: "button", className: clsx(css.viewerBtn, css.viewerBtnClose), title: "\u5173\u95ED", "aria-label": "\u5173\u95ED", onClick: (e) => { e.stopPropagation(); onClose(); }, children: _jsx(IconCloseOutline16, { size: 16 }) })] }), _jsxs("div", { className: css.viewerStage, children: [loading && !src && !vErr && _jsx("div", { className: css.viewerMsg, children: "\u52A0\u8F7D\u4E2D\u2026" }), vErr && _jsx("div", { className: css.viewerMsg, children: vErr === 'hevc-unsupported' ? '🖼️ wxgf 原图（需系统 HEVC 解码）' : vErr }), src && (_jsx("img", { src: src, alt: "\u56FE\u7247", className: css.viewerImg, style: { transform: `translate(${off.x}px, ${off.y}px) scale(${zoom})` }, draggable: false, onMouseDown: (e) => {
                            e.preventDefault();
                            setDragging(true);
                            dragStart.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
                        } }))] })] }), document.body);
}
/** Authoritative transfer/redpacket status line from general.db. */
function PayStatusLine({ serverId }) {
    const [pay, setPay] = useState(null);
    useEffect(() => {
        let cancelled = false;
        apiGetPaymentStatus(serverId)
            .then((r) => { if (!cancelled && r.found)
            setPay(r); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [serverId]);
    if (!pay || pay.kind === 'transfer' || !pay.redpacket)
        return null;
    const rp = pay.redpacket;
    const state = rp.hbStatus === 4 || rp.receiveStatus === 4 ? '已退还'
        : rp.receiveStatus === 3 ? '已被领取'
            : rp.receiveStatus === 2 ? '已领取'
                : '待领取';
    return (_jsxs("div", { className: css.msgPayStatus, "data-kind": pay.kind, children: [rp.sender ? '来自 ' + rp.sender + ' · ' : '', state, rp.hbType === 1 ? ' · 群红包' : ''] }));
}
/** 文件大小格式化（B/KB/MB/GB）。 */
function fmtFileSize(n) {
    if (!n || n < 0)
        return '';
    if (n < 1024)
        return `${n} B`;
    if (n < 1048576)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824)
        return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
}
/** 不同扩展名 → 图标风格（kind + emoji），便于按类型区分样式。 */
const FILE_STYLE = {
    pdf: { kind: 'pdf', emoji: '📄' },
    doc: { kind: 'word', emoji: '📝' }, docx: { kind: 'word', emoji: '📝' },
    xls: { kind: 'excel', emoji: '📊' }, xlsx: { kind: 'excel', emoji: '📊' }, csv: { kind: 'excel', emoji: '📊' },
    ppt: { kind: 'ppt', emoji: '📽️' }, pptx: { kind: 'ppt', emoji: '📽️' },
    png: { kind: 'image', emoji: '🖼️' }, jpg: { kind: 'image', emoji: '🖼️' }, jpeg: { kind: 'image', emoji: '🖼️' }, gif: { kind: 'image', emoji: '🖼️' }, webp: { kind: 'image', emoji: '🖼️' }, bmp: { kind: 'image', emoji: '🖼️' },
    mp4: { kind: 'video', emoji: '🎬' }, mov: { kind: 'video', emoji: '🎬' }, avi: { kind: 'video', emoji: '🎬' },
    mp3: { kind: 'audio', emoji: '🎵' }, wav: { kind: 'audio', emoji: '🎵' }, m4a: { kind: 'audio', emoji: '🎵' },
    zip: { kind: 'archive', emoji: '🗜️' }, rar: { kind: 'archive', emoji: '🗜️' }, '7z': { kind: 'archive', emoji: '🗜️' }, tar: { kind: 'archive', emoji: '🗜️' }, gz: { kind: 'archive', emoji: '🗜️' },
    js: { kind: 'code', emoji: '💻' }, ts: { kind: 'code', emoji: '💻' }, py: { kind: 'code', emoji: '💻' }, sql: { kind: 'code', emoji: '💻' }, html: { kind: 'code', emoji: '💻' }, css: { kind: 'code', emoji: '💻' }, json: { kind: 'code', emoji: '💻' }, yaml: { kind: 'code', emoji: '💻' }, yml: { kind: 'code', emoji: '💻' }, ini: { kind: 'code', emoji: '💻' }, xml: { kind: 'code', emoji: '💻' }, bat: { kind: 'code', emoji: '💻' }, ps1: { kind: 'code', emoji: '💻' }, sh: { kind: 'code', emoji: '💻' }, java: { kind: 'code', emoji: '💻' },
    txt: { kind: 'text', emoji: '📃' }, md: { kind: 'text', emoji: '📃' }, log: { kind: 'text', emoji: '📃' }, rtf: { kind: 'text', emoji: '📃' },
};
function fileStyle(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    return FILE_STYLE[ext] || { kind: 'file', emoji: '📁' };
}
/** 点击打开/下载收到的文件（从 msg/file 本地缓存读取）。 */
function OpenFileCard({ title, size }) {
    const [status, setStatus] = useState('idle');
    const [message, setMessage] = useState('');
    const openFile = async () => {
        setStatus('loading');
        setMessage('');
        try {
            const r = await apiGetMessageFile({ fileName: title });
            if (!r.url) {
                setStatus('error');
                setMessage(r.error ?? '文件不可用');
                return;
            }
            const a = document.createElement('a');
            a.href = r.url;
            a.download = title;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setStatus('idle');
        }
        catch (e) {
            setStatus('error');
            setMessage(e.message);
        }
    };
    const ext = (title.split('.').pop() || '').toLowerCase();
    const style = fileStyle(title);
    const sized = size ? fmtFileSize(Number(size)) : '';
    const foot = status === 'loading' ? '打开中…' : status === 'error' ? message : '点击打开 / 下载';
    return (_jsxs("div", { className: css.msgFileCard, role: "button", tabIndex: 0, title: status === 'error' ? message : '点击打开/下载文件', onClick: () => { void openFile(); }, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void openFile();
        } }, children: [_jsx("span", { className: css.msgFileIcon, "data-kind": style.kind, children: style.emoji }), _jsxs("span", { className: css.msgFileBody, children: [_jsx("span", { className: css.msgFileTitle, children: title }), _jsx("span", { className: css.msgFileMeta, children: [ext ? ext.toUpperCase() : '文件', sized, foot].filter(Boolean).join(' · ') })] }), _jsx("span", { className: css.msgFileExt, children: ext ? ext.toUpperCase() : '文件' })] }));
}
/** Render a rich media card (file/link/quote/miniapp/...) inside a bubble. */
function RichCard({ rich, fallback, self = false, onOpenChatlog, serverId }) {
    const title = rich.title || fallback || '';
    const desc = rich.desc || '';
    const url = rich.url || '';
    switch (rich.type) {
        case 'transfer': {
            const amount = (rich.title || '').replace(/^\s*[Y￥]/, '¥');
            const state = transferStatusLabel(self, rich.paysubtype);
            const key = transferStateKey(rich.paysubtype);
            return (_jsxs("div", { className: css.msgTransferCard, "data-state": key, children: [_jsx("span", { className: css.msgTransferArrow, "aria-hidden": "true", children: key === 'pending' ? _jsx(TransferArrowGlyph, {}) : _jsx(TransferCheckGlyph, {}) }), _jsxs("span", { className: css.msgTransferMain, children: [_jsx("span", { className: css.msgTransferAmount, children: amount || '¥0.00' }), _jsx("span", { className: css.msgTransferStatus, children: state || (key === 'pending' ? (self ? '等待对方领取' : '待收款') : '已收款') })] }), _jsx("span", { className: css.msgTransferTitle, children: "\u5FAE\u4FE1\u8F6C\u8D26" })] }));
        }
        case 'redpacket': {
            const amount = typeof rich.amount === 'string' ? rich.amount.replace(/^\s*[Y￥]/, '¥') : '';
            const greet = rich.desc || '恭喜发财，大吉大利';
            return (_jsxs("div", { className: css.msgRedpacketCard, children: [_jsx("div", { className: css.msgRedpacketIcon, children: "\uD83E\uDDE7" }), _jsxs("div", { className: css.msgRedpacketBody, children: [_jsx("div", { className: css.msgRedpacketTitle, children: greet }), amount && _jsx("div", { className: css.msgRedpacketAmount, children: amount }), _jsx("div", { className: css.msgRedpacketSub, children: "\u5FAE\u4FE1\u7EA2\u5305" }), serverId && _jsx(PayStatusLine, { serverId: serverId })] })] }));
        }
        case 'quote': {
            return (_jsxs("div", { className: css.msgQuoteCard, children: [_jsx("div", { className: css.msgQuoteBar }), _jsx("div", { className: css.msgQuoteBody, children: title })] }));
        }
        case 'file':
            return _jsx(OpenFileCard, { title: title, size: rich.fileSize ?? '' });
        case 'chatlog': {
            const count = Array.isArray(rich.records) ? rich.records.length : 0;
            return (_jsxs("button", { type: "button", className: css.msgChatlogCard, onClick: onOpenChatlog ? () => { onOpenChatlog(rich); } : undefined, title: onOpenChatlog ? '点击查看聊天记录' : undefined, children: [_jsx("span", { className: css.msgChatlogIcon, children: _jsx(IconDataOutline16, { size: 15 }) }), _jsxs("span", { className: css.msgChatlogBody, children: [_jsx("span", { className: css.msgChatlogTitle, children: title || '群聊的聊天记录' }), desc && _jsx("span", { className: css.msgChatlogDesc, children: desc }), _jsx("span", { className: css.msgChatlogFoot, children: count > 0 ? `共 ${count} 条消息 · 点击查看` : '点击查看' })] })] }));
        }
        case 'miniapp': {
            return (_jsxs("div", { className: css.msgMiniappCard, children: [_jsxs("div", { className: css.msgMiniappHead, children: [_jsx(IconDataOutline16, { size: 12 }), " \u5C0F\u7A0B\u5E8F"] }), _jsx("div", { className: css.msgMiniappTitle, children: title }), desc && _jsx("div", { className: css.msgMiniappDesc, children: desc })] }));
        }
        case 'channels': {
            return (_jsxs("div", { className: css.msgFileCard, children: [_jsx("span", { className: css.msgFileIcon, children: _jsx(IconPlayOutline16, { size: 18 }) }), _jsxs("span", { className: css.msgFileBody, children: [_jsx("span", { className: css.msgFileTitle, children: title }), _jsx("span", { className: css.msgFileMeta, children: "\u89C6\u9891\u53F7\u52A8\u6001" })] })] }));
        }
        default: {
            // Jump target: the parsed url, or an url embedded in the title/text.
            const cardUrl = url
                || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】》>]+$/, '')
                || '';
            const clickable = /^https?:\/\//i.test(cardUrl);
            const thumb = rich.thumb || '';
            const source = rich.source || '';
            const textColumn = (_jsxs(_Fragment, { children: [source && _jsx("div", { className: css.msgLinkSource, children: source }), _jsx("div", { className: css.msgLinkTitle, children: title }), desc && _jsx("div", { className: css.msgLinkDesc, children: desc }), !thumb && cardUrl && _jsx("div", { className: css.msgLinkUrl, title: cardUrl, children: cardUrl })] }));
            return (_jsxs("div", { className: clickable ? `${css.msgLinkCard} ${css.msgLinkCardOpen}` : css.msgLinkCard, role: clickable ? 'link' : undefined, title: clickable ? '点击打开链接' : undefined, onClick: clickable ? () => { openLink(cardUrl); } : undefined, children: [clickable && _jsx("span", { className: css.msgLinkOpen, children: _jsx(IconLinkOutline14, { size: 12 }) }), thumb ? (_jsxs("div", { className: css.msgLinkThumbWrap, children: [_jsx("div", { className: css.msgLinkText, children: textColumn }), _jsx("img", { className: css.msgLinkThumb, src: thumb, alt: "", loading: "lazy", onError: (e) => { e.target.style.display = 'none'; } })] })) : textColumn] }));
        }
    }
}
/** Render one message body by type, with rich card rendering. */
function MessageBody({ m, selfName, onOpenImage, onOpenChatlog }) {
    const type = m.type;
    const text = m.displayText || m.strContent || m.msgContent || '';
    const rich = m.rich;
    // system message (10000/10002)
    if (type === 10000 || type === 10002) {
        return _jsx("div", { className: css.msgSystem, children: text || '[系统消息]' });
    }
    // text (1)
    if (type === 1) {
        return _jsx("div", { className: css.msgBubble, children: renderTextWithLinks(text || ' ') });
    }
    // 拍一拍 (pat-pat)
    if (type === 859832288 || type === 922746960) {
        return _jsx("div", { className: css.msgSystem, children: text || '[拍一拍]' });
    }
    // 小程序 (masked 244135593199)
    if (type === 244135593199) {
        return _jsx("div", { className: css.msgBubble, children: _jsx("span", { children: text || '[小程序]' }) });
    }
    // image (3)
    if (type === 3) {
        return _jsx(MessageImage, { m: m, selfName: selfName, ...(onOpenImage ? { onOpen: onOpenImage } : {}) });
    }
    // rich appmsg cards (file/link/quote/miniapp/channels/chatlog/transfer/redpacket/newsfeed)
    if (rich && ['appmsg', 'file', 'link', 'quote', 'miniapp', 'channels', 'chatlog', 'transfer', 'redpacket', 'newsfeed'].includes(rich.type)) {
        return (_jsx(RichCard, { rich: rich, fallback: text, self: m.isSender === 1, ...(onOpenChatlog ? { onOpenChatlog } : {}), ...(m.serverId ? { serverId: m.serverId } : {}) }));
    }
    // appmsg link without parsed rich payload: render a clickable link card
    if (type === 49) {
        const urlMatch = text.match(/https?:\/\/[^\s<>"']+/);
        const url = urlMatch ? urlMatch[0].replace(/[。，；、！？）)】》>]+$/, '') : '';
        return (_jsxs("div", { className: url ? `${css.msgLinkCard} ${css.msgLinkCardOpen}` : css.msgLinkCard, role: url ? 'link' : undefined, title: url ? '点击打开链接' : undefined, onClick: url ? () => { openLink(url); } : undefined, children: [url && _jsx("span", { className: css.msgLinkOpen, children: _jsx(IconLinkOutline14, { size: 12 }) }), _jsx("div", { className: css.msgLinkTitle, children: text || '[链接]' }), url && _jsx("div", { className: css.msgLinkUrl, title: url, children: url })] }));
    }
    // voice (34)
    if (type === 34) {
        return _jsx(MessageVoice, { m: m, selfName: selfName });
    }
    // video (43)
    if (type === 43) {
        return _jsx(MessageVideo, { m: m, selfName: selfName });
    }
    // contact card (42)
    if (type === 42) {
        const nick = rich?.nickname || rich?.title || '';
        const uname = rich?.username || '';
        return (_jsxs("div", { className: css.msgContactCard, children: [_jsx("span", { className: css.msgContactAvatar, children: _jsx(IconUserOutline16, { size: 18 }) }), _jsxs("span", { className: css.msgContactBody, children: [_jsx("span", { className: css.msgContactNick, children: nick || '联系人' }), uname && _jsx("span", { className: css.msgContactUname, children: uname })] }), _jsx("span", { className: css.msgContactTag, children: "\u4E2A\u4EBA\u540D\u7247" })] }));
    }
    // location (48)
    if (type === 48) {
        const locTitle = rich?.title || '';
        return (_jsxs("div", { className: css.msgLocationCard, children: [_jsx("span", { className: css.msgLocationIcon, children: _jsx(IconDataOutline16, { size: 20 }) }), _jsxs("span", { className: css.msgLocationBody, children: [_jsx("span", { className: css.msgLocationTitle, children: locTitle || text || '位置' }), text && text !== locTitle && _jsx("span", { className: css.msgLocationDesc, children: text })] })] }));
    }
    // emoji (47)
    if (type === 47) {
        return _jsx("div", { className: css.msgBubble, children: _jsx("span", { className: css.msgEmoji, children: text || '😊' }) });
    }
    // fallback
    return _jsx("div", { className: css.msgBubble, children: _jsx("span", { className: css.msgMuted, children: text || `[类型 ${type}]` }) });
}
/** Enterprise-WeChat conversation detection (@openim / @weclaw / kefu). */
export function isEnterpriseChat(u) {
    const s = (u || '').toLowerCase();
    return s.endsWith('@openim') || s.endsWith('@weclaw')
        || s.includes('@kefu') || s.includes('openim') && (s.includes('chatroom') || s.includes('@'));
}
/** Kefu session detection：真实企业微信/品牌客服会话（不含占位 holder 与 @openim 企业微信用户）。 */
function isKefuSession(u) {
    const s = (u || '').toLowerCase();
    return s.includes('@weclaw') || s.includes('@kefu.openim') || s.includes('opencustomerservicemsg');
}
const POLL_VISIBLE_MS = 1000;
const POLL_HIDDEN_MS = 5000;
/**
 * Render the chats panel.
 * @param props - optional view filter for subscription tabs and an external
 *   navigation target (records/privacy/ask jump into a session + message).
 * @returns the chats element tree.
 */
export function ChatsPanel({ initialView = 'chats', initialTarget }) {
    const [view, setView] = useState(() => initialView);
    useEffect(() => { setView(initialView); }, [initialView]);
    const [sessions, setSessions] = useState([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [curSession, setCurSession] = useState(null);
    const [messages, setMessages] = useState([]);
    const [msgLoading, setMsgLoading] = useState(false);
    const [msgError, setMsgError] = useState(null);
    const [hasMore, setHasMore] = useState(false);
    const [cursor, setCursor] = useState(0);
    /** Real-time polling toggle (persisted). */
    const [realtime, setRealtime] = useState(() => {
        try {
            return localStorage.getItem('wc_realtime') !== '0';
        }
        catch {
            return true;
        }
    });
    /** Highest sort_seq already loaded; the incremental-poll watermark. */
    const watermarkRef = useRef(0);
    const inFlightRef = useRef(false);
    const sessionsReloadTimerRef = useRef(null);
    const [pollStatus, setPollStatus] = useState('');
    /** Logged-in account wxid (from the messages snapshot) for own avatars. */
    const [selfWxid, setSelfWxid] = useState('');
    const [typeStats, setTypeStats] = useState([]);
    const msgEndRef = useRef(null);
    const [viewer, setViewer] = useState(null);
    const [pinnedCollapsed, setPinnedCollapsed] = useState(() => {
        try {
            return localStorage.getItem('wc_pinned_collapsed') === '1';
        }
        catch {
            return false;
        }
    });
    const [batchMode, setBatchMode] = useState(false);
    const [selected, setSelected] = useState(new Set());
    const [batchExporting, setBatchExporting] = useState(false);
    const [batchMsg, setBatchMsg] = useState(null);
    const [, setAvatarVersion] = useState(0);
    const setWatermarkFrom = (list) => {
        let w = watermarkRef.current;
        for (const m of list)
            if (m.sortSeq && m.sortSeq > w)
                w = m.sortSeq;
        watermarkRef.current = w;
    };
    const toggleSelect = (username) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(username))
                next.delete(username);
            else
                next.add(username);
            return next;
        });
    };
    const exportBatch = useCallback(async () => {
        const list = [...selected];
        if (list.length === 0)
            return;
        setBatchExporting(true);
        setBatchMsg(null);
        let done = 0;
        const errors = [];
        try {
            for (const username of list) {
                try {
                    await apiExportSessionMessages({ username, format: 'txt', count: 0 });
                    done += 1;
                }
                catch (e) {
                    errors.push(username + ': ' + e.message);
                }
            }
            setBatchMsg(`已导出 ${done}/${list.length} 个会话${errors.length ? `，失败 ${errors.length} 个` : ''}`);
        }
        finally {
            setBatchExporting(false);
        }
    }, [selected]);
    const togglePinned = () => {
        setPinnedCollapsed((v) => {
            const nv = !v;
            try {
                localStorage.setItem('wc_pinned_collapsed', nv ? '1' : '0');
            }
            catch { /* ignore */ }
            return nv;
        });
    };
    /** Open the lightbox at a message image (strip = all type-3 messages loaded). */
    const openViewer = useCallback((m) => {
        const imgs = messages
            .filter(x => x.type === 3)
            .map(x => ({ username: curSession?.username ?? '', localId: x.localId }));
        if (imgs.length === 0)
            return;
        const idx = imgs.findIndex(x => x.localId === m.localId);
        setViewer({ images: imgs, index: idx >= 0 ? idx : 0 });
    }, [messages, curSession]);
    const [exporting, setExporting] = useState(false);
    const [exportMsg, setExportMsg] = useState(null);
    // export dialog state
    const [exportOpen, setExportOpen] = useState(false);
    const [expFormat, setExpFormat] = useState('txt');
    const [expCount, setExpCount] = useState(0);
    const [expDir, setExpDir] = useState('');
    const [expTypes, setExpTypes] = useState([]);
    const [expFrom, setExpFrom] = useState('');
    const [expTo, setExpTo] = useState('');
    const [expFilename, setExpFilename] = useState('');
    const [expZip, setExpZip] = useState(false);
    const [pickingDir, setPickingDir] = useState(false);
    const EXPO_FORMATS = [
        { value: 'txt', label: 'TXT' }, { value: 'html', label: 'HTML' }, { value: 'md', label: 'Markdown' },
        { value: 'excel', label: 'Excel' }, { value: 'sql', label: 'SQL' }, { value: 'json', label: 'JSON' },
    ];
    const EXPO_TYPES = [
        { key: 'text', label: '文本', types: [1] },
        { key: 'image', label: '图片', types: [3] },
        { key: 'emoji', label: '表情', types: [47] },
        { key: 'video', label: '视频', types: [43] },
        { key: 'voice', label: '语音', types: [34] },
        { key: 'chatlog', label: '聊天记录', rich: ['chatlog'] },
        { key: 'transfer', label: '转账', rich: ['transfer'] },
        { key: 'redpacket', label: '红包', rich: ['redpacket'] },
        { key: 'file', label: '文件', rich: ['file'] },
        { key: 'link', label: '链接', rich: ['link'] },
        { key: 'quote', label: '引用', rich: ['quote'] },
        { key: 'system', label: '系统', types: [10000, 10002] },
        { key: 'call', label: '通话', types: [50] },
    ];
    const exportSession = useCallback(async () => {
        if (!curSession || exporting)
            return;
        setExporting(true);
        setExportMsg(null);
        try {
            const chosen = EXPO_TYPES.filter(c => expTypes.includes(c.key));
            const types = chosen.flatMap(c => [...(c.types ?? [])]);
            const richTypes = chosen.flatMap(c => [...(c.rich ?? [])]);
            const fromSec = expFrom ? Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000) : 0;
            const toSec = expTo ? Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000) : 0;
            const opts = {
                username: curSession.username,
                format: expFormat,
                count: expCount,
            };
            if (expDir.trim())
                opts.dir = expDir.trim();
            if (types.length > 0)
                opts.types = types;
            if (richTypes.length > 0)
                opts.richTypes = richTypes;
            if (fromSec > 0)
                opts.from = fromSec;
            if (toSec > 0)
                opts.to = toSec;
            if (expFilename.trim())
                opts.filename = expFilename.trim();
            if (expZip)
                opts.zip = true;
            const r = await apiExportSessionMessages(opts);
            setExportMsg(`已导出 ${r.count} 条 → ${r.path}`);
            setExportOpen(false);
        }
        catch (e) {
            setExportMsg('导出失败: ' + e.message);
        }
        finally {
            setExporting(false);
        }
    }, [curSession, exporting, expFormat, expCount, expDir, expTypes, expFrom, expTo, expFilename, expZip]);
    const chooseExportDir = async () => {
        if (pickingDir)
            return;
        setPickingDir(true);
        try {
            const dir = await pickDirectory();
            if (dir)
                setExpDir(dir);
        }
        finally {
            setPickingDir(false);
        }
    };
    const openNestedChatlog = async (rec) => {
        if (rec.nested && rec.nested.length > 0) {
            setChatlogStack(prev => [...prev, { title: rec.datatitle || rec.text || '聊天记录', records: rec.nested ?? [] }]);
            return;
        }
        if (rec.fromnewmsgid && !chatlogResolving) {
            setChatlogResolving(true);
            try {
                const r = await apiResolveChatHistory(rec.fromnewmsgid);
                const rich = r.found ? r.message?.rich : null;
                if (r.found && rich && Array.isArray(rich.records) && rich.records.length > 0) {
                    setChatlogStack(prev => [...prev, { title: rich.title || '聊天记录', records: rich.records ?? [] }]);
                }
                else {
                    window.alert('未找到该聊天记录（可能需要微信端完整同步）');
                }
            }
            catch (e) {
                window.alert('解析聊天记录失败: ' + e.message);
            }
            finally {
                setChatlogResolving(false);
            }
        }
    };
    // ── message edit (C5) ──
    const [editedOpen, setEditedOpen] = useState(false);
    const [edits, setEdits] = useState([]);
    const [editedIds, setEditedIds] = useState(new Set());
    const [editing, setEditing] = useState(false);
    const loadEdits = useCallback(async () => {
        try {
            const r = await apiListEditedMessages(curSession ? { sessionId: curSession.username } : undefined);
            setEdits(r.items);
            setEditedIds(new Set(r.items.map(it => it.localId)));
        }
        catch {
            setEdits([]);
            setEditedIds(new Set());
        }
    }, [curSession]);
    const openEdits = useCallback(async () => {
        setEditedOpen(v => !v);
        if (!editedOpen)
            await loadEdits();
    }, [editedOpen, loadEdits]);
    const reloadCurrent = useCallback(async () => {
        if (!curSession)
            return;
        try {
            const cached = readRenderCache('chat-msgs:' + curSession.username);
            if (cached && cached.length > 0) {
                setMessages(cached);
                setHasMore(true);
            }
            const env = await apiGetMessages({ talker: curSession.username, limit: 100 });
            setMessages(env.messages);
            setWatermarkFrom(env.messages);
            setSelfWxid(env.selfWxid ?? '');
            setHasMore(env.hasMore ?? false);
            setCursor(env.cursor ?? 0);
            setTypeStats(env.typeStats ?? []);
            writeRenderCache('chat-msgs:' + curSession.username, env.messages);
        }
        catch { /* keep current view */ }
    }, [curSession]);
    const doEdit = useCallback(async (m) => {
        const next = window.prompt('编辑消息内容（写入本地解密副本）', m.displayText || m.strContent || '');
        if (next === null || !curSession)
            return;
        setEditing(true);
        try {
            const r = await apiEditChatMessage({ username: curSession.username, localId: m.localId, content: next });
            if (!r.ok)
                window.alert('编辑失败: ' + (r.error ?? ''));
            else {
                await reloadCurrent();
                await loadEdits();
            }
        }
        catch (e) {
            window.alert('编辑失败: ' + e.message);
        }
        finally {
            setEditing(false);
        }
    }, [curSession, reloadCurrent, loadEdits]);
    const sessionListRef = useRef(null);
    const sessionsPager = usePagedList({
        pageSize: 120,
        fetchPage: async (offset, limit) => {
            const env = await apiGetSessions({ limit, offset });
            return { items: env.sessions, total: env.total };
        },
    });
    const reloadSessionsList = useCallback(() => {
        sessionsPager.reset();
    }, [sessionsPager.reset]);
    /** Coalesce host-push session refreshes; user actions still refresh inline. */
    const queueReloadSessions = useCallback(() => {
        if (sessionsReloadTimerRef.current !== null)
            clearTimeout(sessionsReloadTimerRef.current);
        sessionsReloadTimerRef.current = setTimeout(() => { reloadSessionsList(); }, 500);
    }, [reloadSessionsList]);
    /** Clear the current session's draft (only the local decrypted copy). */
    const clearDraft = useCallback(async () => {
        if (!curSession || !curSession.draft)
            return;
        if (!window.confirm('清空「' + (curSession.displayName || curSession.username) + '」的草稿？'))
            return;
        try {
            const r = await apiClearSessionDraft({ username: curSession.username });
            if (r.ok)
                reloadSessionsList();
        }
        catch { /* keep view */ }
    }, [curSession, reloadSessionsList]);
    const clearAllDrafts = useCallback(async () => {
        if (!window.confirm('清空所有会话草稿（仅本地解密副本）？'))
            return;
        try {
            const r = await apiClearAllSessionDrafts();
            window.alert(`已清空 ${r.count} 条草稿`);
            reloadSessionsList();
        }
        catch (e) {
            window.alert('清空失败: ' + e.message);
        }
    }, [reloadSessionsList]);
    const copyMsgJson = useCallback((m) => {
        try {
            const json = JSON.stringify({
                localId: m.localId,
                type: m.type,
                isSender: m.isSender,
                createTime: m.createTime,
                displayText: m.displayText,
                typeLabel: m.typeLabel,
                sender: m.sender ?? undefined,
                rich: m.rich ?? undefined,
            }, null, 2);
            void navigator.clipboard.writeText(json).then(() => { window.alert('消息 JSON 已复制'); }).catch(() => { window.alert('复制失败'); });
        }
        catch {
            window.alert('复制失败');
        }
    }, []);
    const doReset = useCallback(async (rec) => {
        if (!curSession)
            return;
        if (!window.confirm('恢复该消息为原始内容？'))
            return;
        setEditing(true);
        try {
            const r = await apiResetEditedMessage({ username: rec.sessionId, localId: rec.localId });
            if (!r.ok)
                window.alert('恢复失败: ' + (r.error ?? ''));
            else {
                await reloadCurrent();
                await loadEdits();
            }
        }
        catch (e) {
            window.alert('恢复失败: ' + e.message);
        }
        finally {
            setEditing(false);
        }
    }, [curSession, reloadCurrent, loadEdits]);
    // ── message search (A7) ──
    const [searchMode, setSearchMode] = useState('session');
    const [msgHits, setMsgHits] = useState([]);
    const [msgSearchLoading, setMsgSearchLoading] = useState(false);
    const [msgSearchError, setMsgSearchError] = useState(null);
    const [msgSearched, setMsgSearched] = useState(false);
    const [msgIndexed, setMsgIndexed] = useState(true);
    const [indexBuilding, setIndexBuilding] = useState(false);
    const msgSearchTimer = useRef(null);
    const msgSearchSeqRef = useRef(0);
    // ── group chat info panel (群聊信息) ──
    const [groupInfoOpen, setGroupInfoOpen] = useState(false);
    const [groupInfo, setGroupInfo] = useState(null);
    const [groupInfoLoading, setGroupInfoLoading] = useState(false);
    const [groupInfoErr, setGroupInfoErr] = useState(null);
    const [memberSearch, setMemberSearch] = useState('');
    const [memberExpanded, setMemberExpanded] = useState(false);
    const [profileMember, setProfileMember] = useState(null);
    const [profilePos, setProfilePos] = useState(null);
    const [chatlogStack, setChatlogStack] = useState([]);
    const [chatlogResolving, setChatlogResolving] = useState(false);
    const chatlogOpen = chatlogStack.length > 0 ? chatlogStack[chatlogStack.length - 1] : null;
    const profileHideTimer = useRef(null);
    const showMemberProfile = (m, el) => {
        if (profileHideTimer.current)
            clearTimeout(profileHideTimer.current);
        setProfileMember(m);
        const rect = el.getBoundingClientRect();
        const width = 232;
        const left = rect.left - width - 10 >= 8 ? rect.left - width - 10 : rect.right + 10;
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - 170));
        setProfilePos({ left, top });
    };
    const hideMemberProfile = () => {
        if (profileHideTimer.current)
            clearTimeout(profileHideTimer.current);
        profileHideTimer.current = setTimeout(() => {
            setProfileMember(null);
            setProfilePos(null);
        }, 150);
    };
    const buildIndex = useCallback(async (silent = false) => {
        setIndexBuilding(true);
        try {
            const r = await apiBuildSearchIndex({ force: false });
            setMsgIndexed(true);
            if (!silent)
                setMsgSearchError(`搜索索引已就绪（${r.rows ?? 0} 条）`);
        }
        catch (e) {
            if (!silent)
                setMsgSearchError('索引构建失败: ' + e.message);
        }
        finally {
            setIndexBuilding(false);
        }
    }, []);
    const checkIndexStatus = useCallback(async () => {
        try {
            const st = await apiGetSearchIndexStatus();
            setMsgIndexed(st.exists && st.rows > 0);
        }
        catch { /* keep default */ }
    }, []);
    const onSearchInput = useCallback((q) => {
        if (msgSearchTimer.current)
            clearTimeout(msgSearchTimer.current);
        const term = q.trim();
        if (term.length < 1) {
            msgSearchSeqRef.current += 1;
            setMsgHits([]);
            setMsgSearched(false);
            setMsgSearchError(null);
            return;
        }
        const seq = ++msgSearchSeqRef.current;
        if (!msgIndexed && !indexBuilding)
            void buildIndex(true);
        msgSearchTimer.current = setTimeout(async () => {
            setMsgSearchLoading(true);
            setMsgSearchError(null);
            try {
                const r = await apiSearchMessages({ query: term, limit: 200 });
                if (seq !== msgSearchSeqRef.current)
                    return;
                setMsgHits(r.hits);
                setMsgIndexed(r.indexed);
                setMsgSearched(true);
            }
            catch (e) {
                if (seq !== msgSearchSeqRef.current)
                    return;
                setMsgSearchError(e.message);
                setMsgHits([]);
            }
            finally {
                if (seq === msgSearchSeqRef.current)
                    setMsgSearchLoading(false);
            }
        }, 350);
    }, [msgIndexed, indexBuilding, buildIndex]);
    // ── message calendar (A8) ──
    const [calOpen, setCalOpen] = useState(false);
    const [calYear, setCalYear] = useState(new Date().getFullYear());
    const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1);
    const [calCounts, setCalCounts] = useState({});
    const [calLoading, setCalLoading] = useState(false);
    const calTotal = useMemo(() => Object.values(calCounts).reduce((a, b) => a + b, 0), [calCounts]);
    const calActiveDays = useMemo(() => Object.values(calCounts).filter(n => n > 0).length, [calCounts]);
    const calAvg = useMemo(() => (calActiveDays > 0 ? Math.round(calTotal / calActiveDays) : 0), [calTotal, calActiveDays]);
    const calTop = useMemo(() => {
        let best = 0;
        let bestDay = 0;
        for (const [k, v] of Object.entries(calCounts)) {
            const d = Number(k);
            if (Number.isFinite(d) && v > best) {
                best = v;
                bestDay = d;
            }
        }
        return best > 0 ? { day: bestDay, count: best } : null;
    }, [calCounts]);
    const calFirstDow = useMemo(() => {
        const dow = new Date(calYear, calMonth - 1, 1).getDay();
        return dow === 0 ? 6 : dow - 1;
    }, [calYear, calMonth]);
    const calDays = useMemo(() => new Date(calYear, calMonth, 0).getDate(), [calYear, calMonth]);
    const calHeat = (cnt) => {
        if (cnt <= 0)
            return 'transparent';
        const alpha = Math.min(0.15 + cnt / 200, 0.85);
        return 'rgba(34, 211, 238, ' + alpha.toFixed(3) + ')';
    };
    const openCalendar = useCallback(async () => {
        if (!curSession)
            return;
        setCalOpen(true);
        setCalLoading(true);
        setCalCounts({});
        try {
            const r = await apiGetDailyCounts({ username: curSession.username, year: calYear, month: calMonth });
            setCalCounts(r.counts);
        }
        catch (e) {
            setMsgError(e.message);
        }
        finally {
            setCalLoading(false);
        }
    }, [curSession, calYear, calMonth]);
    const switchCalMonth = useCallback(async (delta) => {
        let m = calMonth + delta;
        let y = calYear;
        if (m < 1) {
            m = 12;
            y -= 1;
        }
        if (m > 12) {
            m = 1;
            y += 1;
        }
        setCalMonth(m);
        setCalYear(y);
        if (!curSession)
            return;
        setCalLoading(true);
        setCalCounts({});
        try {
            const r = await apiGetDailyCounts({ username: curSession.username, year: y, month: m });
            setCalCounts(r.counts);
        }
        catch (e) {
            setMsgError(e.message);
        }
        finally {
            setCalLoading(false);
        }
    }, [curSession, calMonth, calYear]);
    const jumpToDay = useCallback((day) => {
        const startTs = Math.floor(new Date(calYear, calMonth - 1, day, 0, 0, 0, 0).getTime() / 1000);
        setCalOpen(false);
        if (curSession)
            void openSessionAndLocate(curSession.username, undefined, startTs);
    }, [calYear, calMonth, curSession, calOpen]);
    const sessionSearch = searchMode === 'session' ? search : '';
    const sessionSearching = sessionSearch.trim() !== '';
    // 普通会话列表：分页逐页加载；会话搜索时一次性拉取 500 条（用户主动操作），保证搜索结果完整。
    useEffect(() => {
        setError(null);
        if (sessionSearching) {
            let cancelled = false;
            setLoading(true);
            void apiGetSessions({ keyword: sessionSearch.trim(), limit: 500 })
                .then((env) => {
                if (cancelled)
                    return;
                setSessions(env.sessions);
            })
                .catch((e) => { if (!cancelled)
                setError(e.message); })
                .finally(() => { if (!cancelled)
                setLoading(false); });
            return () => { cancelled = true; };
        }
        sessionsPager.reset();
        return undefined;
    }, [sessionSearching, sessionSearch, sessionsPager.reset]);
    useEffect(() => {
        if (sessionSearching)
            return;
        setSessions(sessionsPager.items);
        setLoading(sessionsPager.loading);
        setError(sessionsPager.error);
    }, [sessionSearching, sessionsPager.items, sessionsPager.loading, sessionsPager.error]);
    const sessionsLoadMoreRef = useLazySentinel(() => { if (sessionsPager.hasMore && !sessionsPager.loadingMore)
        sessionsPager.loadMore(); }, '600px 0px', () => sessionListRef.current);
    // 搜索索引状态只在用户切到「消息搜索」时检查，进入页签不再触发。
    useEffect(() => { if (searchMode === 'message')
        void checkIndexStatus(); }, [searchMode, checkIndexStatus]);
    // 已编辑消息列表仅在打开某个会话时按需加载，避免进入页签就拉全量已编辑记录；
    // 会话内「已编辑」徽标仍会在进入会话后正常出现。
    useEffect(() => { if (curSession)
        void loadEdits(); }, [curSession, loadEdits]);
    // Batch-prefetch avatars for the visible session list + message senders so
    // Avatar components hit the module cache instead of one Remote per row.
    useEffect(() => {
        const keys = [
            ...sessions.map(s => s.username),
            ...messages.map(m => m.sender ?? ''),
            ...(curSession ? [curSession.username] : []),
        ];
        const uniq = [...new Set(keys.filter(Boolean))].filter(u => avatarCache.get(u) === undefined);
        if (uniq.length === 0)
            return;
        const batch = uniq.slice(0, 60);
        void apiGetAvatarsLocal({ usernames: batch })
            .then((map) => {
            let changed = false;
            for (const u of batch) {
                if (!avatarCache.has(u)) {
                    avatarCache.set(u, map[u] ?? null);
                    changed = true;
                }
            }
            if (changed)
                setAvatarVersion(v => v + 1);
        })
            .catch(() => { });
    }, [sessions, messages, curSession]);
    const filtered = useMemo(() => {
        // subscription views filter by session kind first
        let base = sessions;
        if (view === 'bizchats') {
            base = sessions.filter(s => s.username.startsWith('gh_') && s.accountKind !== 'service' && !isKefuSession(s.username));
        }
        else if (view === 'servicechats') {
            base = sessions.filter(s => s.username.startsWith('gh_') && s.accountKind === 'service' && !isKefuSession(s.username));
        }
        else if (view === 'kefu') {
            base = sessions.filter(s => isKefuSession(s.username));
        }
        const q = search.trim().toLowerCase();
        if (!q)
            return base;
        return base.filter(s => (s.displayName || s.username).toLowerCase().includes(q)
            || (s.summary || '').toLowerCase().includes(q));
    }, [sessions, search, view]);
    const { pinnedList, normalList } = useMemo(() => {
        const pinned = [];
        const normal = [];
        for (const s2 of filtered) {
            if (s2.pinned)
                pinned.push(s2);
            else
                normal.push(s2);
        }
        return { pinnedList: pinned, normalList: normal };
    }, [filtered]);
    const stats = useMemo(() => ({
        friends: sessions.filter(s => s.type === 'private').length,
        groups: sessions.filter(s => s.type === 'group').length,
        unread: sessions.reduce((a, s) => a + (s.unreadCount || 0), 0),
    }), [sessions]);
    const { count: sessCount, sentinelRef: sessSentinel } = useProgressiveList(normalList.length, 120);
    // 消息流渐进渲染：窗口从底部截取（最新消息永远可见），向上滚动越过哨兵
    // 时逐步展开更早的消息，长会话不再一次性渲染上千条 DOM。
    const { count: msgWinCount, sentinelRef: msgWinSentinel, reveal: revealMsgWindow } = useProgressiveList(messages.length, 120);
    /** Incremental poll: fetch messages newer than the watermark and append. */
    const pollNew = useCallback(async () => {
        if (!curSession || inFlightRef.current)
            return;
        const after = watermarkRef.current;
        if (!after)
            return;
        inFlightRef.current = true;
        try {
            const env = await apiGetNewMessages({ talker: curSession.username, after, limit: 200 });
            const fresh = env.messages;
            setPollStatus(`✓ ${new Date().toLocaleTimeString()} · ${fresh.length} 条新消息`);
            if (fresh.length === 0)
                return;
            setMessages((prev) => {
                const key = (m) => `${m.localId}:${m.sortSeq ?? 0}`;
                const seen = new Set(prev.map(m => key(m)));
                const add = fresh.filter(m => !seen.has(key(m)));
                if (add.length === 0)
                    return prev;
                setWatermarkFrom(add);
                // Keep the render cache current so a session reopen paints the same
                // newest messages before the authoritative fetch returns.
                const merged = [...prev, ...add];
                writeRenderCache('chat-msgs:' + curSession.username, merged);
                return merged;
            });
            // follow to the bottom only when the user is already near it
            requestAnimationFrame(() => {
                const el = msgEndRef.current;
                if (!el)
                    return;
                const rect = el.getBoundingClientRect();
                const vh = window.innerHeight || document.documentElement.clientHeight;
                if (rect.top < vh && rect.bottom >= 0)
                    el.scrollIntoView({ block: 'end' });
            });
        }
        catch (e) {
            setPollStatus('✗ ' + (e.message || '轮询失败').slice(0, 60));
        }
        finally {
            inFlightRef.current = false;
        }
    }, [curSession]);
    /** 与快照最近窗口对账：撤回(10002)/删除等就地修改保留原 sort_seq，
     *  增量轮询按 sort_seq 水位看不到它们；宿主推送后拉一次最近 50 条，
     *  按 localId 用新行替换发生变化的行，界面与库保持一致（有界查询）。 */
    const reconcileRef = useRef(false);
    const reconcileRecent = useCallback(async () => {
        if (!curSession || reconcileRef.current)
            return;
        reconcileRef.current = true;
        try {
            const env = await apiGetMessages({ talker: curSession.username, limit: 50 });
            const byId = new Map();
            for (const m of env.messages)
                byId.set(m.localId, m);
            if (byId.size === 0)
                return;
            setMessages((prev) => {
                const next = prev.map((m) => {
                    const cur = byId.get(m.localId);
                    if (cur && (cur.type !== m.type || (cur.sortSeq ?? 0) !== (m.sortSeq ?? 0)))
                        return cur;
                    return m;
                });
                const changed = next.some((m, i) => m !== prev[i]);
                if (!changed)
                    return prev;
                writeRenderCache('chat-msgs:' + curSession.username, next);
                return next;
            });
        }
        catch { /* 保持当前视图，等待下一次推送对账 */ }
        finally {
            reconcileRef.current = false;
        }
    }, [curSession]);
    useEffect(() => {
        if (!curSession || !realtime)
            return;
        let timer = null;
        const start = () => {
            if (timer !== null)
                clearInterval(timer);
            const ms = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
            timer = setInterval(() => { void pollNew(); }, ms);
        };
        start();
        const onVis = () => { void pollNew(); start(); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            document.removeEventListener('visibilitychange', onVis);
            if (timer !== null)
                clearInterval(timer);
        };
    }, [curSession, realtime, pollNew]);
    // Close the group-info drawer and drop the in-chat search scope on session switch.
    useEffect(() => {
        setGroupInfoOpen(false);
        setGroupInfo(null);
        setGroupInfoErr(null);
        setMemberSearch('');
        setMemberExpanded(false);
        setProfileMember(null);
    }, [curSession?.username]);
    // Host push: a WAL increment was decrypted into the snapshot — refresh the
    // open chat immediately, reconcile in-place edits (revoke/delete), and
    // coalesce the session-list refresh.
    useEffect(() => {
        const onUpdated = () => {
            void pollNew();
            void reconcileRecent();
            queueReloadSessions();
        };
        window.addEventListener('dsh-wechat-data-updated', onUpdated);
        return () => { window.removeEventListener('dsh-wechat-data-updated', onUpdated); };
    }, [pollNew, reconcileRecent, queueReloadSessions]);
    useEffect(() => () => {
        if (sessionsReloadTimerRef.current !== null)
            clearTimeout(sessionsReloadTimerRef.current);
    }, []);
    const toggleRealtime = () => {
        setRealtime((v) => {
            const nv = !v;
            try {
                localStorage.setItem('wc_realtime', nv ? '1' : '0');
            }
            catch { /* ignore */ }
            return nv;
        });
    };
    const openGroupInfo = () => {
        if (!curSession)
            return;
        setGroupInfoOpen(true);
        setGroupInfoLoading(true);
        setGroupInfoErr(null);
        setMemberSearch('');
        setMemberExpanded(false);
        apiGetGroupInfo(curSession.username)
            .then((r) => {
            const g = r.group;
            setGroupInfo(g);
        })
            .catch((e) => { setGroupInfoErr(e.message); })
            .finally(() => { setGroupInfoLoading(false); });
    };
    const openSession = useCallback(async (s) => {
        setCurSession(s);
        watermarkRef.current = 0;
        setCursor(0);
        setTypeStats([]);
        setMsgLoading(true);
        setMsgError(null);
        try {
            // 先用上次渲染的消息缓存秒开,后台再同步最新 100 条
            const cached = readRenderCache('chat-msgs:' + s.username);
            setMessages(cached ?? []);
            if (cached && cached.length > 0) {
                setHasMore(true);
                setMsgLoading(false);
            }
            const env = await apiGetMessages({ talker: s.username, limit: 100 });
            const list = env.messages;
            setMessages(list);
            setWatermarkFrom(list);
            setSelfWxid(env.selfWxid ?? '');
            setHasMore(env.hasMore ?? false);
            setCursor(env.cursor ?? 0);
            setTypeStats(env.typeStats ?? []);
            writeRenderCache('chat-msgs:' + s.username, list);
            setTimeout(() => { msgEndRef.current?.scrollIntoView({ block: 'end' }); }, 50);
        }
        catch (e) {
            setMsgError(e.message);
        }
        finally {
            setMsgLoading(false);
        }
    }, []);
    const loadMore = useCallback(async () => {
        if (!curSession || !hasMore || msgLoading)
            return;
        setMsgLoading(true);
        try {
            const env = await apiGetMessages({ talker: curSession.username, limit: 100, cursor });
            const list = env.messages;
            setMessages(prev => [...list, ...prev]);
            setWatermarkFrom(list);
            setHasMore(env.hasMore ?? false);
            setCursor(env.cursor ?? cursor);
        }
        catch (e) {
            setMsgError(e.message);
        }
        finally {
            setMsgLoading(false);
        }
    }, [curSession, hasMore, msgLoading, cursor]);
    /** Open a session and scroll to a message (by localId or day start). */
    const openSessionAndLocate = useCallback(async (username, localId, dayStart) => {
        const found = sessions.find(x => x.username === username);
        const s = found ?? {
            username,
            displayName: username,
            type: username.endsWith('@chatroom') ? 'group' : 'private',
            lastTimestamp: 0, summary: '', unreadCount: 0, draft: '', pinned: false, hidden: false,
        };
        setCurSession(s);
        setMessages([]);
        watermarkRef.current = 0;
        setCursor(0);
        setTypeStats([]);
        setMsgLoading(true);
        setMsgError(null);
        try {
            let env = await apiGetMessages({ talker: username, limit: 100 });
            let list = env.messages;
            let pages = 0;
            let hit = -1;
            const findHit = () => {
                if (localId !== undefined)
                    return list.findIndex(m => m.localId === localId);
                if (dayStart !== undefined)
                    return list.findIndex(m => m.createTime >= dayStart);
                return -1;
            };
            hit = findHit();
            while (hit < 0 && (env.hasMore ?? false) && pages < 10) {
                const moreOpts = { talker: username, limit: 100 };
                if (env.cursor !== undefined)
                    moreOpts.cursor = env.cursor;
                env = await apiGetMessages(moreOpts);
                list = [...env.messages, ...list];
                pages += 1;
                hit = findHit();
            }
            setMessages(list);
            setWatermarkFrom(list);
            setSelfWxid(env.selfWxid ?? '');
            setHasMore(env.hasMore ?? false);
            setCursor(env.cursor ?? 0);
            setTypeStats(env.typeStats ?? []);
            // 渐进渲染窗口从底部截取：先展开到目标消息所在位置，保证定位元素已渲染。
            if (hit >= 0)
                revealMsgWindow(list.length - hit);
            setTimeout(() => {
                if (hit >= 0) {
                    const m = list[hit];
                    if (m) {
                        const el = document.getElementById('msg-' + String(m.localId));
                        el?.scrollIntoView({ block: 'center' });
                    }
                }
                else {
                    msgEndRef.current?.scrollIntoView({ block: 'end' });
                }
            }, 80);
        }
        catch (e) {
            setMsgError(e.message);
        }
        finally {
            setMsgLoading(false);
        }
    }, [sessions, revealMsgWindow]);
    // External navigation (records/privacy/ask/contacts): open the target
    // session and locate the message (or just open when no localId).
    useEffect(() => {
        if (!initialTarget)
            return;
        void openSessionAndLocate(initialTarget.username, initialTarget.localId);
    }, [initialTarget, openSessionAndLocate]);
    const onEditFn = doEdit;
    const lastTypeIcon = (t) => {
        switch (t) {
            case 3: return '🖼️';
            case 34: return '🎤';
            case 43: return '🎬';
            case 47: return '😀';
            case 49: return '🔗';
            case 50: return '📞';
            case 10000: return '📢';
            case 10002: return '↩️';
            default: return '';
        }
    };
    const renderSession = (s) => (_jsxs("button", { type: "button", className: css.sessionItem, "data-active": !batchMode && curSession?.username === s.username || undefined, onClick: () => { if (batchMode)
            toggleSelect(s.username);
        else
            void openSession(s); }, children: [batchMode && (_jsx("span", { className: css.batchCheck, "data-checked": selected.has(s.username) || undefined, children: selected.has(s.username) ? '✓' : '' })), _jsx(LazyMount, { placeholder: _jsx("span", { style: { width: 36, height: 36, display: 'inline-block' } }), rootMargin: "400px 0px", children: _jsx(Avatar, { name: s.displayName, username: s.username }) }), _jsxs("div", { className: css.sessionInfo, children: [_jsxs("div", { className: css.sessionTop, children: [_jsxs("span", { className: css.sessionNameWrap, children: [_jsx("span", { className: css.sessionName, children: s.displayName || s.username }), s.hidden && _jsx("span", { className: css.hiddenBadge, title: "\u8BE5\u4F1A\u8BDD\u5728\u5FAE\u4FE1\u4E2D\u88AB\u9690\u85CF", children: "\u5DF2\u9690\u85CF" }), isEnterpriseChat(s.username) && _jsx("span", { className: css.entBadge, title: "\u4F01\u4E1A\u5FAE\u4FE1", children: "\u4F01\u5FAE" })] }), _jsxs("span", { className: css.sessionTimeGroup, children: [_jsx("span", { className: css.sessionTime, children: fmtTime(s.lastTimestamp) }), s.pinned && _jsx("span", { className: css.pinMark, title: "\u7F6E\u9876\u4F1A\u8BDD", children: _jsx(IconPin, {}) })] })] }), _jsxs("div", { className: css.sessionBottom, children: [lastTypeIcon(s.lastMsgType) && (_jsx("span", { className: css.sessionTypeBadge, title: "\u6700\u540E\u6D88\u606F\u7C7B\u578B\u56FE\u6807", children: lastTypeIcon(s.lastMsgType) })), _jsx("span", { className: css.sessionSummary, children: s.summary || (s.draft ? `[草稿] ${s.draft}` : '') }), s.unreadCount > 0 && _jsx("span", { className: css.unread, children: s.unreadCount })] })] })] }, s.username));
    return (_jsxs("div", { className: css.panel, children: [_jsxs("div", { className: css.sidebar, children: [_jsxs("div", { className: css.search, children: [_jsx(SearchInput, { value: search, onChange: (v) => {
                                    setSearch(v);
                                    if (searchMode === 'message')
                                        onSearchInput(v);
                                }, placeholder: searchMode === 'message' ? '搜索全部消息' : '搜索会话', ariaLabel: searchMode === 'message' ? '搜索全部消息' : '搜索会话' }), _jsx("button", { type: "button", className: css.searchActionBtn, "data-active": searchMode === 'message' || undefined, title: "\u5168\u5C40\u6D88\u606F\u641C\u7D22", onClick: () => {
                                    const next = searchMode === 'message' ? 'session' : 'message';
                                    setSearchMode(next);
                                    if (next === 'message' && search.trim())
                                        onSearchInput(search);
                                }, children: "\u641C\u6D88\u606F" }), _jsx("button", { type: "button", className: css.searchActionBtn, "data-active": batchMode || undefined, title: "\u6279\u91CF\u5BFC\u51FA\u4F1A\u8BDD", onClick: () => { setBatchMode(v => !v); setSelected(new Set()); }, children: batchMode ? '退出批量' : '批量' })] }), searchMode === 'session' ? (_jsxs(_Fragment, { children: [_jsx("div", { className: css.typeFilter, children: _jsx(Segmented, { options: [
                                        { value: 'chats', label: '全部' },
                                        { value: 'bizchats', label: '公众号' },
                                        { value: 'servicechats', label: '服务号' },
                                        { value: 'kefu', label: '客服' },
                                    ], value: view, onChange: (v) => { setView(v); }, ariaLabel: "\u4F1A\u8BDD\u5206\u7C7B" }) }), _jsx("div", { className: css.stats, children: batchMode ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.batchBtn, onClick: () => { setSelected(new Set(filtered.map(x => x.username))); }, children: "\u5168\u9009" }), _jsx("button", { type: "button", className: css.batchBtn, onClick: () => { setSelected(new Set()); }, children: "\u6E05\u7A7A" }), _jsxs("span", { className: css.statUnread, children: ["\u5DF2\u9009 ", selected.size] }), _jsx("button", { type: "button", className: css.batchBtn, onClick: () => { void exportBatch(); }, disabled: batchExporting || selected.size === 0, children: batchExporting ? '导出中…' : '导出所选' }), batchMsg && _jsx("span", { className: css.batchMsg, children: batchMsg })] })) : (_jsxs(_Fragment, { children: [_jsxs("span", { children: ["\u597D\u53CB ", stats.friends] }), _jsxs("span", { children: ["\u7FA4\u804A ", stats.groups] }), stats.unread > 0 && _jsxs("span", { className: css.statUnread, children: ["\u672A\u8BFB ", stats.unread] })] })) }), _jsxs("div", { ref: sessionListRef, className: css.list, children: [loading && _jsx(ListSkeleton, { rows: 10 }), error && _jsx("div", { className: css.empty, children: error }), !loading && !error && filtered.length === 0 && _jsx("div", { className: css.empty, children: view === 'chats' ? '暂无会话' : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话') }), !loading && !error && pinnedList.length > 0 && (_jsxs("div", { className: css.pinSection, children: [!pinnedCollapsed && pinnedList.map(s => renderSession(s)), _jsxs("button", { type: "button", className: css.pinToggle, onClick: togglePinned, children: [_jsxs("span", { className: css.pinMark, children: [_jsx(IconPin, {}), " \u7F6E\u9876\uFF08", pinnedList.length, "\uFF09"] }), _jsx("span", { className: css.pinArrow, children: pinnedCollapsed ? '▸' : '▾' })] })] })), !loading && !error && normalList.slice(0, sessCount).map(s => renderSession(s)), !loading && !error && normalList.length > sessCount && _jsx(ListSentinel, { refFn: sessSentinel }), !loading && !error && !sessionSearching && sessionsPager.hasMore && _jsx(ListSentinel, { refFn: sessionsLoadMoreRef })] })] })) : (_jsxs("div", { className: css.list, children: [!msgIndexed && (_jsxs("div", { className: css.searchIndexHint, children: [_jsx("span", { children: "\u6D88\u606F\u641C\u7D22\u7D22\u5F15\u5C1A\u672A\u6784\u5EFA\uFF08\u5F53\u524D\u4E3A\u5168\u8868\u626B\u63CF\uFF09" }), _jsx("button", { type: "button", className: css.loadMore, onClick: () => { void buildIndex(); }, disabled: indexBuilding, children: indexBuilding ? '构建中…' : '构建索引' })] })), msgSearchLoading && _jsx("div", { className: css.empty, children: "\u641C\u7D22\u4E2D\u2026" }), msgSearchError && _jsx("div", { className: css.empty, children: msgSearchError }), !msgSearchLoading && msgSearched && msgHits.length === 0 && !msgSearchError && _jsx("div", { className: css.empty, children: "\u672A\u627E\u5230\u76F8\u5173\u6D88\u606F" }), !msgSearchLoading && msgHits.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.searchHitCount, children: ["\u547D\u4E2D ", msgHits.length, " \u6761 \u00B7 \u70B9\u51FB\u5B9A\u4F4D\u5230\u539F\u6D88\u606F"] }), msgHits.map(hit => (_jsxs("button", { type: "button", className: css.searchHit, onClick: () => { void openSessionAndLocate(hit.username, hit.local_id); }, children: [_jsxs("div", { className: css.searchHitTop, children: [_jsx("span", { className: css.searchHitName, children: hit.name || hit.username }), _jsx("span", { className: css.searchHitTime, children: hit.time })] }), _jsx("div", { className: css.searchHitSnippet, children: hit.snippet })] }, `${hit.username}:${hit.local_id}`)))] })), !msgSearchLoading && !msgSearched && !msgSearchError && _jsx("div", { className: css.empty, children: "\u8F93\u5165\u5173\u952E\u8BCD\u641C\u7D22\u5168\u90E8\u6D88\u606F" })] }))] }), _jsxs("div", { className: css.messages, children: [_jsx("div", { className: css.starWrap, "data-hidden": curSession !== null || undefined, children: _jsx(RainWindow, { className: css.starfield, label: "", active: curSession === null }) }), curSession === null && (_jsxs("div", { className: css.msgEmptyState, children: [_jsx("div", { className: css.msgEmptyIcon, children: "\uD83D\uDCAC" }), _jsx("div", { className: css.msgEmptyTitle, children: "\u4ECE\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A\u4F1A\u8BDD" }), _jsx("div", { className: css.msgEmptyText, children: "\u70B9\u51FB\u4F1A\u8BDD\u5373\u53EF\u67E5\u770B\u804A\u5929\u8BB0\u5F55\u4E0E\u6587\u4EF6\uFF0C\u6570\u636E\u4EC5\u5728\u672C\u673A\u53EA\u8BFB\u9884\u89C8\u3002" }), filtered.length > 0 && (_jsx("button", { type: "button", className: css.msgEmptyAction, onClick: () => { const first = filtered[0]; if (first !== undefined)
                                    void openSession(first); }, children: "\u67E5\u770B\u6700\u8FD1\u4F1A\u8BDD" }))] })), curSession !== null && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.msgHeader, children: [_jsxs("div", { className: css.msgHeaderInfo, children: [_jsxs("div", { className: css.msgHeaderName, children: [curSession.displayName || curSession.username, isEnterpriseChat(curSession.username) && _jsx("span", { className: css.entBadge, title: "\u4F01\u4E1A\u5FAE\u4FE1", children: "\u4F01\u4E1A\u5FAE\u4FE1" })] }), _jsxs("div", { className: css.msgHeaderUser, children: [curSession.username, messages.length > 0 ? ` · 共 ${messages.length} 条` : ''] }), exportMsg && _jsx("div", { className: css.msgHeaderExport, title: exportMsg, children: exportMsg })] }), _jsxs("div", { className: css.msgHeaderActions, children: [_jsxs("button", { type: "button", className: css.calBtn, title: realtime ? '实时推送已开启（微信新消息自动出现）' : '实时推送已关闭', "data-active": realtime || undefined, onClick: toggleRealtime, children: [_jsx("span", { className: css.realtimeDot }), " \u5B9E\u65F6"] }), _jsxs("button", { type: "button", className: css.calBtn, title: "\u6D88\u606F\u65E5\u5386\uFF08\u6BCF\u65E5\u6D88\u606F\u6570\u70ED\u529B\u56FE\uFF09", onClick: () => { void openCalendar(); }, children: [_jsx(IconCalendar, {}), " \u65E5\u5386"] }), curSession.type === 'group' && (_jsxs("button", { type: "button", className: css.calBtn, "data-active": groupInfoOpen || undefined, title: "\u7FA4\u804A\u4FE1\u606F", onClick: openGroupInfo, children: [_jsx(IconUserOutline16, { size: 14 }), "\u7FA4\u4FE1\u606F"] })), _jsxs("button", { type: "button", className: css.calBtn, title: "\u5BFC\u51FA\u672C\u4F1A\u8BDD\u6D88\u606F\uFF08\u8DEF\u5F84/\u6761\u6570/\u683C\u5F0F/\u7C7B\u578B\uFF09", onClick: () => { setExportOpen(true); }, disabled: exporting, children: [_jsx(IconDownloadOutline16, { size: 14 }), "\u5BFC\u51FA"] }), _jsxs("button", { type: "button", className: css.calBtn, title: "\u672C\u4F1A\u8BDD\u5DF2\u7F16\u8F91\u6D88\u606F", onClick: () => { void openEdits(); }, disabled: editing, children: [_jsx(IconListPenOutline16, { size: 14 }), "\u5DF2\u7F16\u8F91", edits.length > 0 ? ' (' + String(edits.length) + ')' : ''] }), _jsxs("button", { type: "button", className: css.calBtn, title: "\u6E05\u7A7A\u6240\u6709\u4F1A\u8BDD\u8349\u7A3F\uFF08\u672C\u5730\u89E3\u5BC6\u526F\u672C\uFF09", onClick: () => { void clearAllDrafts(); }, children: [_jsx(IconTrashOutline16, { size: 14 }), "\u6E05\u7A7A\u8349\u7A3F"] }), curSession.draft && (_jsxs("button", { type: "button", className: css.calBtn, title: "\u6E05\u7A7A\u672C\u4F1A\u8BDD\u8349\u7A3F\uFF08\u672C\u5730\u89E3\u5BC6\u526F\u672C\uFF09", onClick: () => { void clearDraft(); }, children: [_jsx(IconTrashOutline16, { size: 14 }), "\u6E05\u7A7A\u672C\u4F1A\u8BDD\u8349\u7A3F"] }))] }), pollStatus && _jsx("span", { className: css.msgHeaderExport, title: pollStatus, children: pollStatus }), typeStats.length > 0 && (_jsxs("div", { className: css.msgTypeChips, children: [typeStats.slice(0, 5).map(t => (_jsxs("span", { className: css.msgTypeChip, title: `${t.label}共 ${t.count} 条`, children: [t.label, " ", t.count] }, t.type))), typeStats.length > 5 && (_jsxs("span", { className: css.msgTypeChip, children: ["\u5176\u4ED6 +", typeStats.slice(5).reduce((a, s) => a + s.count, 0)] }))] }))] }), _jsxs("div", { className: css.msgBody, children: [hasMore && (_jsx("button", { type: "button", className: css.loadMore, onClick: () => { void loadMore(); }, children: msgLoading ? '加载中…' : '加载更多' })), msgError && _jsx("div", { className: css.msgErr, children: msgError }), messages.length > msgWinCount && _jsx(ListSentinel, { refFn: msgWinSentinel }), (() => {
                                        const out = [];
                                        let prevDay = '';
                                        // 渐进窗口：只渲染靠近底部的 msgWinCount 条，向上滚动越过哨兵
                                        // 时逐步展开更早消息（窗口起点随 count 增长向历史方向移动）。
                                        const start = Math.max(0, messages.length - msgWinCount);
                                        for (let i = start; i < messages.length; i += 1) {
                                            const m = messages[i];
                                            if (!m)
                                                continue;
                                            const type = m.type;
                                            const day = m.createTime ? fmtMsgTime(m.createTime).slice(0, 5) : '';
                                            if (day !== prevDay && day) {
                                                prevDay = day;
                                                out.push(_jsx("div", { className: css.msgDayDivider, children: _jsx("span", { children: day }) }, `day-${i}`));
                                            }
                                            if (type === 10000 || type === 10002) {
                                                out.push(_jsx("div", { id: `msg-${m.localId}`, className: css.msgRowSystem, children: _jsx(MessageBody, { m: m, selfName: curSession.username, onOpenImage: openViewer }) }, m.localId));
                                                continue;
                                            }
                                            const isSelf = m.isSender === 1;
                                            const isGroup = curSession.type === 'group';
                                            // group messages: use the member's own avatar; without a resolved
                                            // sender show a neutral letter tile instead of the group avatar.
                                            // Own messages: the logged-in account's avatar ('我' letter fallback).
                                            const avUsername = isSelf
                                                ? (selfWxid || curSession.username)
                                                : (isGroup ? (m.sender ?? '') : curSession.username);
                                            const avName = isSelf ? '我' : (isGroup ? (m.senderName || m.sender || '') : curSession.displayName);
                                            const isEdited = editedIds.has(m.localId);
                                            out.push(_jsxs("div", { id: `msg-${m.localId}`, className: `${css.msgRow} ${isSelf ? css.msgRowSelf : ''}`, children: [_jsx(Avatar, { name: avName, username: avUsername, size: 30 }), _jsxs("div", { className: css.msgCol, children: [isGroup && !isSelf && m.sender && _jsx("div", { className: css.msgSender, children: avName }), _jsx(MessageBody, { m: m, selfName: curSession.username, onOpenImage: openViewer, onOpenChatlog: (rich) => { setChatlogStack([{ title: rich.title || '群聊的聊天记录', records: Array.isArray(rich.records) ? rich.records : [] }]); } }), _jsxs("div", { className: css.msgTime, children: [fmtMsgTime(m.createTime), isEdited && _jsx("span", { className: css.msgEditedTag, title: "\u8BE5\u6D88\u606F\u5DF2\u7F16\u8F91", children: "\u5DF2\u7F16\u8F91" }), _jsx("button", { type: "button", className: css.msgEditBtn, title: "\u7F16\u8F91\u6D88\u606F\uFF08\u5199\u5165\u672C\u5730\u89E3\u5BC6\u526F\u672C\uFF09", "aria-label": "\u7F16\u8F91\u6D88\u606F", onClick: () => { void onEditFn(m); }, children: _jsx(IconEditOutline16, { size: 13 }) }), _jsx("button", { type: "button", className: css.msgEditBtn, title: "\u590D\u5236\u6D88\u606F JSON", "aria-label": "\u590D\u5236\u6D88\u606F JSON", onClick: () => { copyMsgJson(m); }, children: _jsx(IconCopyOutline16, { size: 13 }) })] })] })] }, m.localId));
                                        }
                                        return out;
                                    })(), msgLoading && messages.length === 0 && _jsx(ListSkeleton, { rows: 8 }), _jsx("div", { ref: msgEndRef })] })] }))] }), groupInfoOpen && curSession?.type === 'group' && (_jsxs("div", { className: css.groupInfo, children: [_jsxs("div", { className: css.groupInfoHeader, children: [_jsx("span", { className: css.groupInfoTitle, children: "\u7FA4\u804A\u4FE1\u606F" }), _jsx("button", { type: "button", className: css.groupInfoClose, title: "\u5173\u95ED", "aria-label": "\u5173\u95ED", onClick: () => { setGroupInfoOpen(false); setProfileMember(null); }, children: _jsx(IconCloseOutline16, { size: 15 }) })] }), _jsxs("div", { className: css.groupInfoBody, children: [groupInfoLoading && _jsx("div", { className: css.empty, children: "\u52A0\u8F7D\u4E2D\u2026" }), groupInfoErr && _jsx("div", { className: css.empty, children: groupInfoErr }), !groupInfoLoading && groupInfo && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.memberSearchBox, children: [_jsx("div", { className: css.searchIcon, children: _jsx(IconSearchOutline16, { size: 13 }) }), _jsx("input", { type: "text", placeholder: "\u641C\u7D22\u7FA4\u6210\u5458", value: memberSearch, onChange: (e) => { setMemberSearch(e.target.value); } })] }), _jsxs("div", { className: css.memberGrid, children: [groupInfo.members
                                                .filter((m) => {
                                                const q = memberSearch.trim().toLowerCase();
                                                if (!q)
                                                    return true;
                                                return m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q);
                                            })
                                                .slice(0, memberExpanded ? 200 : 24)
                                                .map(m => (_jsxs("button", { type: "button", className: css.memberTile, title: m.name, onMouseEnter: (e) => { showMemberProfile(m, e.currentTarget); }, onMouseLeave: hideMemberProfile, children: [_jsx(Avatar, { name: m.name, username: m.username, size: 40 }), _jsx("span", { className: css.memberName, children: m.name })] }, m.username))), !memberSearch && (_jsxs("div", { className: css.memberTile, title: "\u6682\u4E0D\u652F\u6301\u9080\u8BF7", children: [_jsx("div", { className: css.memberAdd, children: _jsx("span", { children: "\uFF0B" }) }), _jsx("span", { className: css.memberName, children: "\u6DFB\u52A0" })] }))] }), groupInfo.members.length > 24 && (_jsx("button", { type: "button", className: css.memberMore, onClick: () => { setMemberExpanded(v => !v); }, children: memberExpanded ? '收起' : `查看更多（${groupInfo.members.length} 人）` })), _jsxs("div", { className: css.groupInfoSection, children: [_jsx("div", { className: css.groupInfoLabel, children: "\u7FA4\u804A\u540D\u79F0" }), _jsx("div", { className: css.groupInfoValue, children: groupInfo.name })] }), groupInfo.announcement && (_jsxs("div", { className: css.groupInfoSection, children: [_jsx("div", { className: css.groupInfoLabel, children: "\u7FA4\u516C\u544A" }), _jsx("div", { className: css.groupInfoValue, children: groupInfo.announcement })] }))] }))] })] })), exportOpen && (_jsx("div", { className: css.calOverlay, onClick: (e) => { if (e.target === e.currentTarget)
                    setExportOpen(false); }, role: "dialog", children: _jsxs("div", { className: css.exportDialog, children: [_jsxs("div", { className: css.calHeader, children: [_jsx("span", { className: css.calTitle, children: "\u5BFC\u51FA\u6D88\u606F" }), _jsx("button", { type: "button", className: css.calClose, onClick: () => { setExportOpen(false); }, children: _jsx(IconCloseOutline16, { size: 15 }) })] }), _jsxs("div", { className: css.exportBody, children: [_jsxs("div", { className: css.exportSection, children: [_jsxs("div", { className: css.exportSectionHead, children: [_jsx("span", { className: css.exportSectionTitle, children: "\u683C\u5F0F\u4E0E\u5185\u5BB9" }), _jsx("span", { className: css.exportCountBadge, children: expTypes.length === 0 ? '全部消息' : `${expTypes.length} 类消息` })] }), _jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u6587\u4EF6\u683C\u5F0F" }), _jsx("div", { className: css.exportFormatGrid, children: EXPO_FORMATS.map(f => (_jsxs("button", { type: "button", className: css.exportFormatCard, "data-active": expFormat === f.value || undefined, onClick: () => { setExpFormat(f.value); }, children: [_jsx("span", { children: f.label }), _jsx("i", { className: css.exportRadio, "data-active": expFormat === f.value || undefined })] }, f.value))) })] }), _jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u5BFC\u51FA\u6761\u6570" }), _jsx("div", { className: css.exportChips, children: [10, 50, 100, 0].map(n => (_jsx("button", { type: "button", className: css.exportChip, "data-active": (expCount === n) || undefined, onClick: () => { setExpCount(n); }, children: n === 0 ? '全部' : String(n) + ' 条' }, String(n)))) })] }), _jsxs("div", { className: css.exportField, children: [_jsxs("div", { className: css.exportLabelRow, children: [_jsx("span", { className: css.exportLabel, children: "\u6D88\u606F\u7C7B\u578B" }), _jsx("button", { type: "button", className: css.exportLinkBtn, onClick: () => { setExpTypes(prev => prev.length > 0 ? [] : EXPO_TYPES.map(c => c.key)); }, children: expTypes.length > 0 ? '取消全选' : '全选' })] }), _jsx("div", { className: css.exportChips, children: EXPO_TYPES.map(c => (_jsxs("button", { type: "button", className: css.exportChipCheck, "data-active": expTypes.includes(c.key) || undefined, onClick: () => { setExpTypes(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key]); }, children: [_jsx("i", { className: css.exportCheck, "data-active": expTypes.includes(c.key) || undefined, children: expTypes.includes(c.key) ? '✓' : '' }), c.label] }, c.key))) })] })] }), _jsxs("div", { className: css.exportSection, children: [_jsxs("div", { className: css.exportSectionHead, children: [_jsx("span", { className: css.exportSectionTitle, children: "\u65F6\u95F4\u8303\u56F4" }), _jsx("button", { type: "button", className: css.exportLinkBtn, onClick: () => { setExpFrom(''); setExpTo(''); }, children: "\u5168\u90E8\u65F6\u95F4" })] }), _jsxs("div", { className: css.exportRangeRow, children: [_jsx("input", { type: "date", className: css.exportDate, value: expFrom, onChange: (e) => { setExpFrom(e.target.value); } }), _jsx("span", { className: css.exportRangeSep, children: "\u81F3" }), _jsx("input", { type: "date", className: css.exportDate, value: expTo, onChange: (e) => { setExpTo(e.target.value); } })] })] }), _jsxs("div", { className: css.exportSection, children: [_jsxs("div", { className: css.exportSectionHead, children: [_jsx("span", { className: css.exportSectionTitle, children: "\u5BFC\u51FA\u6587\u4EF6\u540D" }), _jsx("span", { className: css.exportHint, children: "\u53EF\u9009\uFF0C\u7559\u7A7A\u65F6\u81EA\u52A8\u751F\u6210" })] }), _jsx("input", { type: "text", className: css.exportInput, placeholder: "\u4F8B\u5982\uFF1A\u5FAE\u4FE1\u804A\u5929\u8BB0\u5F55_2026-07-11", value: expFilename, onChange: (e) => { setExpFilename(e.target.value); } }), _jsxs("label", { className: css.exportCheckbox, children: [_jsx("input", { type: "checkbox", checked: expZip, onChange: (e) => { setExpZip(e.target.checked); } }), "\u6253\u5305\u4E3A ZIP\uFF08\u542B\u5BFC\u51FA\u6587\u4EF6\u4E0E record_media.json\uFF09"] })] }), _jsxs("div", { className: css.exportSection, children: [_jsx("div", { className: css.exportSectionHead, children: _jsx("span", { className: css.exportSectionTitle, children: "\u4FDD\u5B58\u76EE\u5F55" }) }), _jsxs("div", { className: css.exportDirBox, "data-chosen": (!!expDir.trim()) || undefined, children: [_jsx("span", { className: css.exportDirIcon, children: "\uD83D\uDCC1" }), _jsxs("div", { className: css.exportDirInfo, children: [_jsx("span", { className: css.exportDirTitle, children: expDir.trim() ? '已选择保存目录' : '尚未选择保存目录' }), _jsx("span", { className: css.exportDirHint, children: expDir.trim() ? expDir.trim() : '留空时导出到默认目录 ~/.dsh/wechat-data/exports' })] }), _jsx("button", { type: "button", className: css.exportBtn, onClick: () => { void chooseExportDir(); }, disabled: pickingDir, children: '＋ ' + (pickingDir ? '选择中…' : '选择目录') })] })] }), _jsxs("div", { className: css.exportActions, children: [_jsx("button", { type: "button", className: css.exportBtnGhost, onClick: () => { setExportOpen(false); }, children: "\u53D6\u6D88" }), _jsx("button", { type: "button", className: css.exportBtnPrimary, onClick: () => { void exportSession(); }, disabled: exporting, children: exporting ? '导出中…' : '导出' })] })] })] }) })), chatlogOpen && (_jsx("div", { className: css.calOverlay, onClick: (e) => { if (e.target === e.currentTarget)
                    setChatlogStack([]); }, role: "dialog", children: _jsxs("div", { className: css.chatlogDialog, children: [_jsxs("div", { className: css.calHeader, children: [_jsx("span", { className: css.calTitle, children: chatlogOpen.title }), _jsxs("span", { className: css.calHeaderActions, children: [chatlogStack.length > 1 && (_jsx("button", { type: "button", className: css.calClose, title: "\u8FD4\u56DE\u4E0A\u4E00\u7EA7", onClick: () => { setChatlogStack(prev => prev.slice(0, -1)); }, "aria-label": "\u8FD4\u56DE\u4E0A\u4E00\u7EA7", children: "\u2039" })), _jsx("button", { type: "button", className: css.calClose, title: "\u5173\u95ED", "aria-label": "\u5173\u95ED", onClick: () => { setChatlogStack([]); }, children: _jsx(IconCloseOutline16, { size: 15 }) })] })] }), _jsxs("div", { className: css.chatlogBody, children: [chatlogResolving && _jsx("div", { className: css.empty, children: "\u89E3\u6790\u804A\u5929\u8BB0\u5F55\u2026" }), chatlogOpen.records.length === 0 && !chatlogResolving && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u5185\u5C42\u6D88\u606F" }), chatlogOpen.records.map((r, idx) => {
                                    const rt = r.renderType || (r.isImage ? 'image' : 'text');
                                    const nested = rt === 'chatHistory';
                                    const link = r.link || r.url || '';
                                    const nestedCount = (r.nested ?? []).length;
                                    return (_jsxs("div", { className: css.chatlogRow, children: [_jsx("div", { className: css.chatlogAvatar, children: r.head ? (_jsx("img", { src: r.head, alt: "", referrerPolicy: "no-referrer", loading: "lazy", onError: (e) => { e.target.style.display = 'none'; } })) : (_jsx("span", { children: (r.name || '?').slice(0, 1) })) }), _jsxs("div", { className: css.chatlogMain, children: [_jsxs("div", { className: css.chatlogTop, children: [_jsx("span", { className: css.chatlogName, children: r.name }), _jsx("span", { className: css.chatlogTime, children: r.time })] }), nested && (_jsx("button", { type: "button", className: css.chatlogNested, onClick: () => { void openNestedChatlog(r); }, children: _jsxs("span", { children: ["\uD83D\uDCCB ", r.text || '聊天记录', "\uFF08", nestedCount > 0 ? String(nestedCount) + ' 条' : '点击查看', "\uFF09"] }) })), rt === 'link' && link ? (_jsx("div", { className: css.chatlogText, children: _jsx("a", { href: link, target: "_blank", rel: "noopener noreferrer", onClick: (e) => { e.preventDefault(); openLink(link); }, className: css.msgTextLink, children: r.text || link }) })) : rt === 'voice' ? (_jsxs("div", { className: css.chatlogText, children: ["\uD83C\uDFA4 ", r.text || '[语音]', r.duration ? String(Math.round(Number(r.duration) / 20)) + '"' : ''] })) : rt === 'video' ? (_jsxs("div", { className: css.chatlogText, children: ["\uD83C\uDFAC ", r.text || '[视频]', r.duration ? String(Math.round(Number(r.duration) / 1000)) + 's' : ''] })) : rt === 'emoji' ? (_jsxs("div", { className: css.chatlogText, children: ["\uD83D\uDE00 ", r.text || '[表情]'] })) : rt === 'image' ? (_jsxs("div", { className: css.chatlogText, children: ["\uD83D\uDDBC\uFE0F [\u56FE\u7247]", r.datasize ? ' (' + r.datasize + ' 字节)' : ''] })) : (_jsx("div", { className: css.chatlogText, children: r.text || '' }))] })] }, idx));
                                })] })] }) })), profileMember && profilePos && (_jsx("div", { className: css.memberProfilePop, style: { left: profilePos.left, top: profilePos.top }, children: _jsxs("div", { className: css.memberProfileBody, children: [_jsx(Avatar, { name: profileMember.name, username: profileMember.username, size: 56 }), _jsx("div", { className: css.memberProfileName, children: profileMember.name }), _jsxs("div", { className: css.memberProfileItem, children: [_jsx("span", { children: "\u5FAE\u4FE1\u53F7" }), _jsx("span", { className: css.memberProfileMono, children: profileMember.username })] }), profileMember.region && (_jsxs("div", { className: css.memberProfileItem, children: [_jsx("span", { children: "\u5730\u533A" }), _jsx("span", { className: css.memberProfileMono, children: profileMember.region })] })), profileMember.signature && (_jsxs("div", { className: css.memberProfileItem, children: [_jsx("span", { children: "\u7B7E\u540D" }), _jsx("span", { className: css.memberProfileMono, children: profileMember.signature })] }))] }) })), calOpen && (_jsx("div", { className: css.calOverlay, onClick: (e) => { if (e.target === e.currentTarget)
                    setCalOpen(false); }, role: "dialog", children: _jsxs("div", { className: css.calDialog, children: [_jsxs("div", { className: css.calHeader, children: [_jsx("span", { className: css.calTitle, children: "\u6D88\u606F\u65E5\u5386" }), _jsx("button", { type: "button", className: css.calClose, onClick: () => { setCalOpen(false); }, children: _jsx(IconCloseOutline16, { size: 15 }) })] }), _jsxs("div", { className: css.calBody, children: [_jsxs("div", { className: css.calNav, children: [_jsx("button", { type: "button", className: css.loadMore, onClick: () => { void switchCalMonth(-1); }, "aria-label": "\u4E0A\u4E00\u6708", children: "\u2039" }), _jsxs("span", { className: css.calMonthTitle, children: [calYear, " \u5E74 ", calMonth, " \u6708"] }), _jsx("button", { type: "button", className: css.loadMore, onClick: () => { void switchCalMonth(1); }, "aria-label": "\u4E0B\u4E00\u6708", children: "\u203A" })] }), calLoading ? (_jsx("div", { className: css.empty, children: "\u52A0\u8F7D\u4E2D\u2026" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.calStats, children: [_jsxs("span", { className: css.calStat, children: ["\u672C\u6708\u5171 ", _jsx("b", { children: calTotal }), " \u6761\u6D88\u606F"] }), _jsxs("span", { className: css.calStat, children: ["\u6D3B\u8DC3 ", _jsx("b", { children: calActiveDays }), " \u5929"] }), _jsxs("span", { className: css.calStat, children: ["\u65E5\u5747 ", _jsx("b", { children: calAvg }), " \u6761"] }), calTop && _jsxs("span", { className: css.calStat, children: ["\u6700\u6D3B\u8DC3\uFF1A", calMonth, "\u6708", calTop.day, "\u65E5\uFF08", calTop.count, " \u6761\uFF09"] })] }), _jsxs("div", { className: css.calGrid, children: [['一', '二', '三', '四', '五', '六', '日'].map(wd => (_jsx("div", { className: css.calWd, children: wd }, wd))), Array.from({ length: calFirstDow }).map((_, i) => _jsx("div", { className: css.calEmpty }, `e${i}`)), Array.from({ length: calDays }).map((_, i) => {
                                                    const day = i + 1;
                                                    const cnt = calCounts[String(day)] ?? 0;
                                                    return (_jsxs("button", { type: "button", className: css.calDay, style: { background: calHeat(cnt) }, title: cnt ? `${calMonth}月${day}日：${cnt} 条消息` : `${calMonth}月${day}日：无消息`, onClick: () => { jumpToDay(day); }, children: [_jsx("span", { className: css.calDayNum, children: day }), cnt > 0 && _jsx("span", { className: css.calDayCnt, children: cnt })] }, day));
                                                })] }), _jsx("p", { className: css.calHint, children: "\u70B9\u51FB\u65E5\u671F\u8DF3\u8F6C\u5230\u5F53\u5929\u6D88\u606F\uFF08\u8272\u5757\u6DF1\u6D45\u8868\u793A\u6D88\u606F\u91CF\uFF09" })] }))] })] }) })), editedOpen && (_jsx("div", { className: css.calOverlay, onClick: () => { setEditedOpen(false); }, role: "dialog", children: _jsxs("div", { className: css.calDialog, children: [_jsxs("div", { className: css.calHeader, children: [_jsx("span", { className: css.calTitle, children: "\u672C\u4F1A\u8BDD\u5DF2\u7F16\u8F91\u6D88\u606F" }), _jsx("button", { type: "button", className: css.calClose, onClick: () => { setEditedOpen(false); }, "aria-label": "\u5173\u95ED", children: "\u00D7" })] }), _jsx("div", { className: css.calBody, children: edits.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u7F16\u8F91\u8BB0\u5F55\uFF08\u4FEE\u6539\u4EC5\u5199\u5165\u672C\u5730\u89E3\u5BC6\u526F\u672C\uFF09" })) : (edits.map(rec => (_jsxs("div", { className: css.editRow, children: [_jsxs("span", { className: css.editRowInfo, children: ["#", rec.localId, " \u00B7 \u7F16\u8F91 ", rec.editCount, " \u6B21 \u00B7 ", new Date(rec.lastEditedAt).toLocaleString()] }), _jsx("button", { type: "button", className: css.loadMore, onClick: () => { void doReset(rec); }, disabled: editing, children: "\u6062\u590D\u539F\u6587" })] }, `${rec.sessionId}:${rec.localId}`)))) })] }) })), viewer && (_jsx(ImageViewer, { images: viewer.images, index: viewer.index, onClose: () => { setViewer(null); }, onIndexChange: (i) => { setViewer(v => (v ? { ...v, index: i } : v)); } }))] }));
}
//# sourceMappingURL=Chats.js.map