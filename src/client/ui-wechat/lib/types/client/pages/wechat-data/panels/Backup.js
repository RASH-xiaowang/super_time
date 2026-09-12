import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 备份管家面板 — React 版，忠实迁移 BackupManager：备份列表 + 创建/删除。
 * 走 Remote（listBackups / createBackup / deleteBackup），无 HTTP 依赖。
 */
import { useCallback, useEffect, useState } from 'react';
import { ListSkeleton } from "./hooks.js";
import { apiCreateBackup, apiCreateEncryptedBackup, apiDeleteBackup, apiListBackups, apiPreviewBackup, apiRestoreBackup, readRenderCache, writeRenderCache } from "../api.js";
import { Dialog, PanelHeader } from "../ui/kit.js";
import css from './list-panel.module.css';
function fmtBytes(n) {
    if (n < 1048576)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824)
        return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
}
/** Format a unix-second timestamp as a local date-time label. */
function fmtDate(ts) {
    if (!ts)
        return '—';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
 * Render the backup-manager panel.
 * @returns the backup element tree.
 */
export function BackupPanel() {
    const [items, setItems] = useState(() => readRenderCache('backups') ?? []);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [password, setPassword] = useState('');
    const [preview, setPreview] = useState(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const openPreview = async (name) => {
        setPreview({ name, items: [], total: 0 });
        setPreviewLoading(true);
        try {
            const env = await apiPreviewBackup({ name });
            setPreview({ name, items: env.items, total: env.total });
        }
        catch (e) {
            setError(e.message);
            setPreview(null);
        }
        finally {
            setPreviewLoading(false);
        }
    };
    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const env = await apiListBackups();
            setItems(env.items);
            writeRenderCache('backups', env.items);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);
    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await apiCreateBackup();
            if (!r.ok)
                setError(r.error ?? '创建备份失败');
            await refresh();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    const remove = async (name) => {
        if (!window.confirm(`删除备份「${name}」？`))
            return;
        setBusy(true);
        try {
            const r = await apiDeleteBackup({ name });
            if (!r.ok)
                setError(r.error ?? '删除失败');
            await refresh();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    const createEncrypted = async () => {
        if (!password.trim()) {
            setError('请输入备份密码');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const r = await apiCreateEncryptedBackup({ password: password.trim() });
            if (!r.ok)
                setError(r.error ?? '加密备份失败');
            setPassword('');
            await refresh();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    const restore = async (name) => {
        if (!password.trim()) {
            setError('请输入备份密码');
            return;
        }
        // 恢复前确认：恢复会覆盖当前解密数据；建议先创建一份当前备份。
        if (!window.confirm(`确认用「${name}」恢复吗？该操作会覆盖当前解密数据（建议先创建一份当前备份留底）。`))
            return;
        setBusy(true);
        setError(null);
        try {
            const r = await apiRestoreBackup({ name, password: password.trim() });
            if (!r.ok)
                setError(r.error ?? '恢复失败');
            else
                setError(`已恢复到：${r.path ?? ''}`);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5907\u4EFD\u7BA1\u5BB6", desc: "\u672C\u5730\u5FEB\u7167\uFF08\u76EE\u5F55\u62F7\u8D1D / AES-256 \u52A0\u5BC6 WCB\uFF09", actions: (_jsxs(_Fragment, { children: [_jsx("input", { type: "password", className: css.backupInput, placeholder: "\u5907\u4EFD\u5BC6\u7801\uFF08\u52A0\u5BC6\u5907\u4EFD/\u6062\u590D\u7528\uFF09", value: password, onChange: (e) => { setPassword(e.target.value); }, "aria-label": "\u5907\u4EFD\u5BC6\u7801" }), _jsx("button", { type: "button", className: css.catBtn, "data-active": "true", onClick: () => { void create(); }, disabled: busy, children: busy ? '处理中…' : '创建备份' }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void createEncrypted(); }, disabled: busy, children: "\u52A0\u5BC6\u5907\u4EFD" })] })) }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), _jsxs("div", { className: css.scroll, children: [loading && _jsx(ListSkeleton, { rows: 4 }), !loading && items.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u5907\u4EFD" }), !loading && items.map(b => (_jsxs("div", { className: css.fileCell, title: b.path, children: [_jsx("span", { className: css.fileName, children: b.name }), _jsxs("span", { className: css.fileMeta, children: [fmtBytes(b.size), " \u00B7 ", b.summary || (b.kind === 'enc' ? '加密' : '目录'), " \u00B7 ", fmtDate(b.modified), b.ok !== undefined ? (b.ok ? ' · ✓ 完整' : ' · ⚠️ 校验异常') : ''] }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void openPreview(b.name); }, disabled: previewLoading, children: "\u9884\u89C8" }), b.kind === 'enc' && _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void restore(b.name); }, disabled: busy || !b.ok, children: "\u6062\u590D" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void remove(b.name); }, disabled: busy, children: "\u5220\u9664" })] }, b.name)))] }), _jsx(Dialog, { open: preview !== null, onClose: () => { setPreview(null); }, title: preview ? `备份预览：${preview.name}` : '备份预览', children: preview && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { fontSize: 12, color: '#8b949e' }, children: ["\u5171 ", preview.total, " \u9879\uFF08\u6700\u591A\u5C55\u793A 500 \u9879\uFF09"] }), previewLoading && _jsx("div", { style: { color: '#8b949e' }, children: "\u52A0\u8F7D\u4E2D\u2026" }), !previewLoading && preview.items.length === 0 && _jsx("div", { style: { color: '#8b949e' }, children: "\u65E0\u53EF\u9884\u89C8\u5185\u5BB9" }), !previewLoading && preview.items.map((it, i) => (_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, color: '#e6edf3' }, children: [_jsxs("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [it.isDir ? '📁 ' : '', it.name] }), _jsx("span", { style: { color: '#8b949e', whiteSpace: 'nowrap' }, children: it.isDir ? '目录' : fmtBytes(it.size) })] }, i)))] })) })] }));
}
//# sourceMappingURL=Backup.js.map