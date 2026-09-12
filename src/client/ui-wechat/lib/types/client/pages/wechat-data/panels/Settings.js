import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 微信设置面板 — 按 ST_Wechat_V2「本地检测 → 数据库解密 → 图片密钥 →
 * 图片解密 → 表情/语音」流程重新设计为步骤导航。数据源 / 解密密钥 /
 * 图片密钥 / 图片解码 / 语音转写 五步卡片 + 高级设置（HTTP API 遗留能力）。
 * 自动获取密钥（V4 内存扫描 + Weixin.dll 内部键 + V2 图片验证）已支持；
 * SQLCipher 全库解密仍为说明态（本地解密能力独立立项）；语音转写已本地化（whisper.cpp）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, Input, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { IconGlobeOutline14, IconPersonalizationOutline16, IconSettingsOutline14, IconSparkle16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { apiAutoGetDbKey, apiAutoGetImageKey, apiDecryptAllDatabases, apiDecryptAllImages, apiDetectWechatAccounts, apiDownloadWhisperModel, apiGenerateKeysFile, apiGetAvatar, apiOpenPath, apiGetDecryptStatus, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWhisperStatus, apiInstallWhisperEngine, apiSaveWechatConfig, apiSetCdnImageEnabled, apiSetCdnImageLocalDecrypt, apiTranscribeVoiceBatch, apiVerifyDatabaseKey, apiVerifyImageKey, pickDirectory, readRenderCache, writeRenderCache } from "../api.js";
import { PanelHeader } from "../ui/kit.js";
import css from './settings.module.css';
/** localStorage 渲染缓存键：上次成功加载的完整微信配置，用于首帧即时渲染。 */
const SETTINGS_CONFIG_CACHE_KEY = 'settings-config';
/** 模型目录探测器尚未就绪时的本地目录兜底(安装状态以 getWhisperStatus 为准)。 */
const WHISPER_MODEL_FALLBACK = [
    { id: 'tiny', name: 'Tiny', sizeLabel: '约 75 MB · 最快', installed: false },
    { id: 'base', name: 'Base', sizeLabel: '约 145 MB · 很快', installed: false },
    { id: 'small', name: 'Small', sizeLabel: '约 466 MB · 较快', installed: false },
    { id: 'medium', name: 'Medium', sizeLabel: '约 1.5 GB · 中等', installed: false },
    { id: 'large-v3', name: 'Large v3', sizeLabel: '约 3.1 GB · 较慢', installed: false },
    { id: 'turbo', name: 'Turbo', sizeLabel: '约 1.6 GB · 快', installed: false },
];
/** Module-level avatar cache (wxid -> data/remote URL, null when none). */
const accountAvatarCache = new Map();
/** Account avatar: lazy-loads the real WeChat avatar via Remote, falls back to a letter tile. */
function AccountAvatar({ wxid }) {
    const [src, setSrc] = useState(null);
    useEffect(() => {
        let cancelled = false;
        const cached = accountAvatarCache.get(wxid);
        if (cached !== undefined) {
            setSrc(cached);
            return;
        }
        apiGetAvatar({ username: wxid })
            .then((r) => {
            const value = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null;
            accountAvatarCache.set(wxid, value);
            if (!cancelled)
                setSrc(value);
        })
            .catch(() => { accountAvatarCache.set(wxid, null); if (!cancelled)
            setSrc(null); });
        return () => { cancelled = true; };
    }, [wxid]);
    const letter = (wxid.replace(/^wxid_/, '') || '?').slice(0, 1).toUpperCase();
    const hue = wxid.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return src
        ? _jsx("img", { src: src, alt: letter, className: css.acctAvatarImg, width: 34, height: 34, referrerPolicy: "no-referrer", loading: "lazy" })
        : _jsx("div", { className: css.acctAvatar, style: { background: `hsl(${hue} 45% 55%)` }, children: letter });
}
/** 相对时间标签（最近活动）。 */
function fmtActive(ts) {
    if (!ts)
        return '—';
    const diff = Date.now() / 1000 - ts;
    if (diff < 3600)
        return `${Math.max(1, Math.floor(diff / 60))} 分钟前`;
    if (diff < 86400)
        return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30)
        return `${Math.floor(diff / 86400)} 天前`;
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 字节数格式化。 */
function fmtBytes(n) {
    if (n >= 1024 * 1024 * 1024)
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024)
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    return `${Math.round(n / 1024)} KB`;
}
/** 步骤定义（与 ST_Wechat_V2 向导一致的流程）。 */
const STEPS = [
    { key: 'detect', n: 1, label: '检测账号' },
    { key: 'dbkey', n: 2, label: '数据库密钥' },
    { key: 'imgkey', n: 3, label: '图片密钥' },
    { key: 'img', n: 4, label: '图片解码' },
    { key: 'voice', n: 5, label: '语音转文字' },
];
/**
 * Render one fixed-height message slot (idle placeholder / ok / err).
 * Always reserves its line so action feedback never shifts layout.
 * @param props - placeholder text + result message.
 * @returns the slot element.
 */
function MsgSlot({ placeholder, msg }) {
    return (_jsx("div", { className: css.slot, children: msg
            ? _jsx("span", { className: msg.kind === 'ok' ? css.slotOk : css.slotErr, children: msg.text })
            : _jsx("span", { className: css.slotIdle, children: placeholder }) }));
}
/**
 * Render one fixed-height status slot (idle placeholder / live progress /
 * last result). Always reserves its line so later operations never shift
 * the surrounding layout.
 * @param props - placeholder + live progress data.
 * @returns the slot element.
 */
function StatusSlot({ placeholder, active, pct, text, item, doneText, doneKind }) {
    return (_jsx("div", { className: css.slot, children: active ? (_jsxs(_Fragment, { children: [_jsx("div", { className: css.progressTrack, children: _jsx("div", { className: css.progressFill, style: { width: `${Math.max(2, Math.min(100, pct))}%` } }) }), _jsx("span", { className: css.progressText, children: text }), _jsx("span", { className: css.progressItem, title: item, children: item || '准备中…' })] })) : (_jsx("span", { className: doneText ? doneKind === 'ok' ? css.slotOk : doneKind === 'err' ? css.slotErr : css.slotDone : css.slotIdle, children: doneText || placeholder })) }));
}
/**
 * Render the wechat-settings panel.
 * @returns the settings element tree.
 */
export function SettingsPanel() {
    const cachedCfg = readRenderCache(SETTINGS_CONFIG_CACHE_KEY);
    const [cfg, setCfg] = useState(cachedCfg);
    const [cfgLoading, setCfgLoading] = useState(false);
    const [keysInfo, setKeysInfo] = useState({ keyCount: 0, loaded: false });
    const [accounts, setAccounts] = useState([]);
    const [detectInfo, setDetectInfo] = useState({});
    const [detecting, setDetecting] = useState(false);
    const [detectMsg, setDetectMsg] = useState(null);
    const [dbDir, setDbDir] = useState(cachedCfg?.db_dir ?? '');
    const [dbKey, setDbKey] = useState(cachedCfg?.db_enc_key ?? '');
    const [imgAes, setImgAes] = useState(cachedCfg?.image_aes_key ?? '');
    const [imgXor, setImgXor] = useState(cachedCfg ? String(cachedCfg.image_xor_key) : '136');
    const [apiEnabled, setApiEnabled] = useState(cachedCfg?.api_enabled ?? true);
    const [apiToken, setApiToken] = useState(cachedCfg?.api_token ?? '');
    const [apiPort, setApiPort] = useState(cachedCfg?.api_port ?? 5032);
    const [cdnEnabled, setCdnEnabled] = useState(cachedCfg?.cdn_enabled ?? true);
    const [cdnLocal, setCdnLocal] = useState(cachedCfg?.cdn_local_decrypt ?? true);
    const [message, setMessage] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState(null);
    const [autoGetting, setAutoGetting] = useState(false);
    const [dbOpMsg, setDbOpMsg] = useState(null);
    const [imgOpMsg, setImgOpMsg] = useState(null);
    const [decrypting, setDecrypting] = useState(false);
    const [dbProgress, setDbProgress] = useState({ active: false, done: 0, total: 0, failed: 0, message: '' });
    const [imgDecrypting, setImgDecrypting] = useState(false);
    const [imgProgress, setImgProgress] = useState({ active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '' });
    const [imgConcurrency, setImgConcurrency] = useState(8);
    const [cdnMsg, setCdnMsg] = useState(null);
    const [dbDirMsg, setDbDirMsg] = useState(null);
    const [voiceOpMsg, setVoiceOpMsg] = useState(null);
    const [whisperDirMsg, setWhisperDirMsg] = useState(null);
    const [whisperDevice, setWhisperDevice] = useState(cachedCfg?.whisper_device ?? 'cpu');
    const [whisperModel, setWhisperModel] = useState(cachedCfg?.whisper_model ?? 'medium');
    const [whisperThreads, setWhisperThreads] = useState(cachedCfg?.whisper_threads ?? 0);
    const [whisperModelsDir, setWhisperModelsDir] = useState(cachedCfg?.whisper_models_dir ?? '');
    const [whisperStatus, setWhisperStatus] = useState(null);
    const [whisperStatusLoading, setWhisperStatusLoading] = useState(false);
    const [whisperDownloading, setWhisperDownloading] = useState(null);
    const [whisperTranscribing, setWhisperTranscribing] = useState({ active: false, done: 0, total: 0, failed: 0, skipped: 0, current: '' });
    const stepRefs = useRef(new Map());
    const notify = (kind, text, details) => {
        setMessage({ kind, text, ...(details && details.length > 0 ? { details } : {}) });
        setTimeout(() => { setMessage(null); }, details && details.length > 0 ? 12000 : 5000);
    };
    const load = useCallback(async () => {
        setCfgLoading(true);
        try {
            const c = await apiGetWechatConfigFull();
            setCfg(c);
            writeRenderCache(SETTINGS_CONFIG_CACHE_KEY, c);
            setDbDir(c.db_dir);
            setDbKey(c.db_enc_key);
            setImgAes(c.image_aes_key);
            setImgXor(String(c.image_xor_key));
            setApiEnabled(c.api_enabled);
            setApiToken(c.api_token);
            setApiPort(c.api_port);
            setCdnEnabled(c.cdn_enabled);
            setCdnLocal(c.cdn_local_decrypt);
            setWhisperDevice(c.whisper_device);
            setWhisperModel(c.whisper_model);
            setWhisperThreads(c.whisper_threads);
            setWhisperModelsDir(c.whisper_models_dir);
            const k = await apiGetWechatKeysInfo();
            setKeysInfo(k);
        }
        catch (e) {
            notify('err', e.message);
        }
        finally {
            setCfgLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    const refreshWhisper = async () => {
        setWhisperStatusLoading(true);
        try {
            const s = await apiGetWhisperStatus();
            setWhisperStatus(s);
        }
        catch (e) {
            notify('err', e.message);
        }
        finally {
            setWhisperStatusLoading(false);
        }
    };
    useEffect(() => { void refreshWhisper(); }, []);
    const detect = async () => {
        setDetecting(true);
        try {
            const r = await apiDetectWechatAccounts();
            setAccounts(r.accounts);
            const info = {};
            if (r.version)
                info.version = r.version;
            if (r.install_dir)
                info.install_dir = r.install_dir;
            setDetectInfo(info);
            setDetectMsg({ kind: 'ok', text: `✓ 检测完成，发现 ${r.total} 个微信账号` });
        }
        catch (e) {
            setDetectMsg({ kind: 'err', text: '✗ ' + e.message });
        }
        finally {
            setDetecting(false);
        }
    };
    // 账号检测可能需要扫描安装目录/内存，较重：不再打开页签时自动执行，
    // 由用户在步骤 1「检测账号」按钮上手动触发。
    const useAccount = (a) => {
        setDbDir(a.db_dir);
        setDbDirMsg({ kind: 'ok', text: `✓ 已填入账号 ${a.wxid} 的数据库目录，请继续校验密钥` });
        setDbOpMsg(null);
    };
    const pickDbDir = async () => {
        try {
            const dir = await pickDirectory();
            if (dir) {
                setDbDir(dir);
                setDbDirMsg({ kind: 'ok', text: '✓ 已选择数据库目录，请继续校验密钥' });
            }
        }
        catch (e) {
            setDbDirMsg({ kind: 'err', text: '✗ ' + e.message });
        }
    };
    const pickWhisperDir = async () => {
        try {
            const dir = await pickDirectory();
            if (dir) {
                setWhisperModelsDir(dir);
                setWhisperDirMsg({ kind: 'ok', text: '✓ 已选择模型目录，保存后生效（刷新状态识别模型）' });
            }
        }
        catch (e) {
            setWhisperDirMsg({ kind: 'err', text: '✗ ' + e.message });
        }
    };
    const whisperDownload = async (m) => {
        if (whisperDownloading) {
            setWhisperDirMsg({ kind: 'err', text: '✗ 已有模型下载任务进行中' });
            return;
        }
        setWhisperDirMsg(null);
        setWhisperDownloading({ model: m.id, file: '', received: 0, total: 0 });
        const timer = setInterval(() => {
            void apiGetWhisperStatus()
                .then((s) => {
                if (s.downloading) {
                    setWhisperDownloading({
                        model: s.downloading.model,
                        file: s.downloading.file,
                        received: s.downloading.received,
                        total: s.downloading.total,
                    });
                }
            })
                .catch(() => { });
        }, 500);
        try {
            const r = await apiDownloadWhisperModel({ model: m.id });
            if (r.ok) {
                setWhisperDirMsg({ kind: 'ok', text: `✓ 模型 ${m.name} 下载完成${r.bytes ? `（${fmtBytes(r.bytes)}）` : ''}，已就绪` });
                await refreshWhisper();
            }
            else {
                setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (r.error ?? '未知错误') });
            }
        }
        catch (e) {
            setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + e.message });
        }
        finally {
            clearInterval(timer);
            setWhisperDownloading(null);
        }
    };
    const batchTranscribe = async () => {
        if (whisperTranscribing.active) {
            setVoiceOpMsg({ kind: 'err', text: '✗ 已有转写任务进行中' });
            return;
        }
        setVoiceOpMsg(null);
        setWhisperTranscribing({ active: true, done: 0, total: 0, failed: 0, skipped: 0, current: '' });
        const stop = pollTranscribe();
        try {
            const r = await apiTranscribeVoiceBatch({});
            const errs = r.errors.slice(0, 20).map(e => `[${e.svrId}] ${e.error}`);
            if (r.error) {
                setVoiceOpMsg({ kind: 'err', text: '✗ ' + r.error });
            }
            else if (!r.ok && r.failed > 0) {
                setVoiceOpMsg({ kind: 'err', text: `✗ 转写完成，${r.failed} 条失败（详见列表）` });
                notify('err', `批量转写完成：成功 ${r.done}，失败 ${r.failed}`, errs);
            }
            else {
                setVoiceOpMsg({ kind: 'ok', text: `✓ 批量转写完成：成功 ${r.done}/${r.total}（跳过 ${r.skipped}，失败 ${r.failed}）` });
                if (errs.length > 0)
                    notify('err', `批量转写完成，${r.failed} 条失败`, errs);
            }
            setWhisperTranscribing({ active: false, done: r.done, total: r.total, failed: r.failed, skipped: r.skipped, current: '' });
        }
        catch (e) {
            setVoiceOpMsg({ kind: 'err', text: '✗ ' + e.message });
        }
        finally {
            stop();
            setWhisperTranscribing(prev => ({ ...prev, active: false }));
        }
    };
    const pollTranscribe = () => {
        const timer = setInterval(() => {
            void apiGetWhisperStatus()
                .then((s) => {
                if (s.transcribing.active || s.transcribing.done > 0) {
                    setWhisperTranscribing({
                        active: s.transcribing.active,
                        done: s.transcribing.done,
                        total: s.transcribing.total,
                        failed: s.transcribing.failed,
                        skipped: s.transcribing.skipped,
                        current: s.transcribing.current,
                    });
                }
            })
                .catch(() => { });
        }, 500);
        return () => { clearInterval(timer); };
    };
    const nativeTranscribe = () => {
        setVoiceOpMsg({ kind: 'ok', text: '✓ 微信原生转写文本会在浏览聊天消息时自动复用数据库文字，无需额外批量任务' });
    };
    const skipTranscribe = () => {
        setVoiceOpMsg({ kind: 'ok', text: '✓ 已跳过批量转写；聊天页可继续为单条语音转写' });
    };
    const installEngine = async () => {
        if (whisperDownloading) {
            setWhisperDirMsg({ kind: 'err', text: '✗ 已有下载任务进行中' });
            return;
        }
        if (whisperStatus?.engine)
            return;
        setWhisperDirMsg(null);
        setWhisperDownloading({ model: 'engine', file: '', received: 0, total: 0 });
        const timer = setInterval(() => {
            void apiGetWhisperStatus()
                .then((s) => {
                if (s.downloading) {
                    setWhisperDownloading({
                        model: s.downloading.model,
                        file: s.downloading.file,
                        received: s.downloading.received,
                        total: s.downloading.total,
                    });
                }
            })
                .catch(() => { });
        }, 500);
        try {
            const r = await apiInstallWhisperEngine();
            if (r.ok) {
                await refreshWhisper();
                setWhisperDirMsg({ kind: 'ok', text: '✓ whisper.cpp 引擎已就绪，可开始批量转写' });
            }
            else {
                setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (r.error ?? '未知错误') });
            }
        }
        catch (e) {
            setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + e.message });
        }
        finally {
            clearInterval(timer);
            setWhisperDownloading(null);
        }
    };
    const save = async () => {
        setSaving(true);
        try {
            const port = Number.isFinite(apiPort) && apiPort >= 1024 && apiPort <= 65535 ? apiPort : 5032;
            const r = await apiSaveWechatConfig({
                patch: {
                    db_dir: dbDir,
                    db_enc_key: dbKey,
                    image_aes_key: imgAes,
                    image_xor_key: Number(imgXor) || 136,
                    api_enabled: apiEnabled,
                    api_token: apiToken,
                    api_port: port,
                    cdn_enabled: cdnEnabled,
                    cdn_local_decrypt: cdnLocal,
                    whisper_device: whisperDevice,
                    whisper_model: whisperModel,
                    whisper_threads: Math.max(0, Math.min(whisperThreads, 64)),
                    whisper_models_dir: whisperModelsDir,
                },
            });
            if (r.ok) {
                setSaveMsg({ kind: 'ok', text: '✓ 配置已保存' });
                await load();
                await refreshWhisper();
            }
            else
                setSaveMsg({ kind: 'err', text: '✗ ' + (r.error ?? '保存失败') });
        }
        catch (e) {
            setSaveMsg({ kind: 'err', text: '✗ ' + e.message });
        }
        finally {
            setSaving(false);
        }
    };
    const autoGetDb = async () => {
        setAutoGetting(true);
        setDbOpMsg(null);
        try {
            const opts = {};
            if (dbDir)
                opts.dbPath = dbDir.replace(/\\+$/, '') + '/session/session.db';
            if (detectInfo.install_dir)
                opts.wechatInstallDir = detectInfo.install_dir;
            const r = await apiAutoGetDbKey(opts);
            if (r.ok && r.key) {
                setDbKey(r.key);
                setDbOpMsg({ kind: 'ok', text: '✓ 已自动获取数据库密钥（' + (r.source ?? 'key_v4_memory') + '），请保存配置' });
                const keysFile = (cfg?.resolved?.keys_file) ?? '';
                if (keysFile && dbDir) {
                    const g = await apiGenerateKeysFile({ dbDir, keysFile, encKeyHex: r.key, keyFormat: 'wx_key_v4.1' });
                    setDbOpMsg({ kind: 'ok', text: `✓ 已获取数据库密钥 · 已生成密钥映射 ${g.verified}/${g.total} 个数据库` });
                    const k = await apiGetWechatKeysInfo();
                    setKeysInfo(k);
                }
            }
            else {
                setDbOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '自动获取失败') });
            }
        }
        catch (e) {
            setDbOpMsg({ kind: 'err', text: '✗ ' + e.message });
        }
        finally {
            setAutoGetting(false);
        }
    };
    const autoGetImg = async () => {
        setAutoGetting(true);
        setImgOpMsg(null);
        try {
            const imgOpts = {};
            if (dbDir) {
                // db_dir 指向 db_storage,而 V2 模板缓存位于账号根目录的 msg/attach 下。
                const dir = dbDir.replace(/[\\/]+$/, '');
                imgOpts.accountDir = (dir.split(/[\\/]/).pop() ?? '').toLowerCase() === 'db_storage' ? dir.replace(/[\\/][^\\/]+$/, '') : dir;
            }
            const r = await apiAutoGetImageKey(imgOpts);
            if (r.ok && r.aesKey !== undefined && r.xorKey !== undefined) {
                setImgAes(r.aesKey);
                setImgXor(String(r.xorKey));
                setImgOpMsg({ kind: 'ok', text: '✓ 已自动获取图片密钥（V2 验证）' });
            }
            else {
                setImgOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '自动获取图片密钥失败') });
            }
        }
        catch (e) {
            setImgOpMsg({ kind: 'err', text: '✗ ' + e.message });
        }
        finally {
            setAutoGetting(false);
        }
    };
    const verifyDb = async () => {
        if (!dbDir) {
            setDbOpMsg({ kind: 'err', text: '✗ 请先选择数据库目录' });
            return;
        }
        if (!dbKey.trim()) {
            setDbOpMsg({ kind: 'err', text: '✗ 请输入 PBKDF2 口令' });
            return;
        }
        try {
            const dbPath = dbDir.replace(/\\+$/, '') + '/session/session.db';
            const v = await apiVerifyDatabaseKey({ dbPath, encKeyHex: dbKey.trim() });
            if (v.valid) {
                const keysFile = (cfg?.resolved?.keys_file) ?? '';
                if (keysFile) {
                    const g = await apiGenerateKeysFile({ dbDir, keysFile, encKeyHex: dbKey.trim(), keyFormat: 'wx_key_v4.1' });
                    setDbOpMsg({ kind: 'ok', text: `✓ 校验通过 (wx_key_v4.1) · 已生成密钥映射 ${g.verified}/${g.total} 个数据库` });
                    const k = await apiGetWechatKeysInfo();
                    setKeysInfo(k);
                }
                else {
                    setDbOpMsg({ kind: 'ok', text: '✓ 校验通过 (wx_key_v4.1)' });
                }
            }
            else {
                setDbOpMsg({ kind: 'err', text: '✗ 密钥不正确' });
            }
        }
        catch (e) {
            setDbOpMsg({ kind: 'err', text: '✗ ' + e.message });
        }
    };
    const verifyImg = async () => {
        if (!imgAes.trim()) {
            setImgOpMsg({ kind: 'err', text: '✗ 请先填写图片 AES 密钥' });
            return;
        }
        try {
            const r = await apiVerifyImageKey();
            if (r.verified) {
                setImgOpMsg({ kind: 'ok', text: `✓ 图片密钥验证通过（XOR 0x${(r.xorKey ?? 0).toString(16).toUpperCase()}）` });
            }
            else {
                setImgOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '图片密钥不正确') });
            }
        }
        catch (e) {
            setImgOpMsg({ kind: 'err', text: '✗ ' + e.message });
        }
    };
    /** 轮询解密进度(op 匹配或仍在进行中才应用),返回停止函数。 */
    const pollDecrypt = (apply) => {
        const timer = setInterval(() => {
            void apiGetDecryptStatus()
                .then((s) => {
                if (s.active || s.done > 0)
                    apply(s);
            })
                .catch(() => { });
        }, 400);
        return () => { clearInterval(timer); };
    };
    const decryptAll = async () => {
        setDecrypting(true);
        setDbProgress({ active: true, done: 0, total: 0, failed: 0, message: '准备中…' });
        const stop = pollDecrypt((s) => {
            setDbProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, message: s.message });
        });
        try {
            const r = await apiDecryptAllDatabases();
            const failedItems = r.failed.map(f => `${f.db} — ${f.error}`);
            if (r.ok) {
                notify('ok', `解密完成：成功 ${r.okCount}/${r.total} 个数据库`, failedItems);
            }
            else if (r.error) {
                notify('err', r.error, failedItems);
            }
            else {
                notify('err', `解密完成，但 ${r.failed.length} 个数据库失败`, failedItems);
            }
            setDbProgress({ active: false, done: r.okCount + r.failed.length, total: r.total, failed: r.failed.length, message: '' });
        }
        catch (e) {
            notify('err', e.message);
        }
        finally {
            stop();
            setDecrypting(false);
        }
    };
    const decryptImgs = async () => {
        setImgDecrypting(true);
        setImgProgress({ active: true, done: 0, total: 0, failed: 0, skipped: 0, message: '准备中…' });
        const stop = pollDecrypt((s) => {
            setImgProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, skipped: s.skipped, message: s.message });
        });
        try {
            const concurrency = Number.isFinite(imgConcurrency) && imgConcurrency >= 1 && imgConcurrency <= 32 ? imgConcurrency : 8;
            const r = await apiDecryptAllImages({ concurrency });
            const failedItems = r.errors.map(f => `${f.file} — ${f.error}`);
            if (r.ok) {
                notify('ok', `图片解密完成：成功 ${r.okCount}/${r.total}（跳过 ${r.skipped}，失败 ${r.failed}）`, failedItems);
            }
            else {
                notify('err', r.error ?? '图片解密失败', failedItems);
            }
            setImgProgress({ active: false, done: r.okCount + r.failed + r.skipped, total: r.total, failed: r.failed, skipped: r.skipped, message: '' });
        }
        catch (e) {
            notify('err', e.message);
        }
        finally {
            stop();
            setImgDecrypting(false);
        }
    };
    const toggleCdn = async (enabled) => {
        try {
            await apiSetCdnImageEnabled({ enabled });
            setCdnEnabled(enabled);
            setCdnMsg({ kind: 'ok', text: `✓ 已${enabled ? '开启' : '关闭'}自动获取原图` });
        }
        catch (e) {
            setCdnMsg({ kind: 'err', text: '✗ ' + e.message });
        }
    };
    const toggleCdnLocal = async (local) => {
        try {
            await apiSetCdnImageLocalDecrypt({ localDecrypt: local });
            setCdnLocal(local);
            setCdnMsg({ kind: 'ok', text: local ? '✓ 原图解密方式：本地解密' : '✓ 原图解密方式：服务端解密' });
        }
        catch (e) {
            setCdnMsg({ kind: 'err', text: '✗ ' + e.message });
        }
    };
    const keyOk = keysInfo.loaded && keysInfo.keyCount > 0;
    const dbFiles = accounts.reduce((sum, a) => sum + (a.db_files ?? 0), 0);
    const current = (a) => dbDir !== '' && dbDir.toLowerCase() === a.db_dir.toLowerCase();
    const stepStates = {
        detect: accounts.length > 0 || dbDir.trim() !== '' ? 'done' : 'todo',
        dbkey: keyOk || dbKey.trim() !== '' ? 'done' : 'todo',
        imgkey: imgAes.trim() !== '' ? 'done' : 'todo',
        img: cdnEnabled ? 'done' : 'todo',
        voice: 'note',
    };
    const scrollToStep = (key) => {
        stepRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const stepLabel = (state) => state === 'done' ? '已完成' : state === 'note' ? '说明' : '待配置';
    return (_jsxs("div", { className: css.root, children: [_jsx(PanelHeader, { title: (_jsxs(_Fragment, { children: [_jsx(IconSettingsOutline14, { size: 16 }), "\u5FAE\u4FE1\u6570\u636E\u914D\u7F6E"] })), desc: "\u672C\u5730\u68C0\u6D4B \u00B7 \u6570\u636E\u5E93\u5BC6\u94A5 \u00B7 \u56FE\u7247\u5BC6\u94A5 \u00B7 \u56FE\u7247\u89E3\u7801 \u00B7 \u8BED\u97F3\u8F6C\u5199" }), _jsx("nav", { className: css.stepper, "aria-label": "\u5FAE\u4FE1\u914D\u7F6E\u6B65\u9AA4", children: STEPS.map((s, i) => {
                    const next = i < STEPS.length - 1 ? STEPS[i + 1] : undefined;
                    return (_jsxs("div", { className: css.stepWrap, children: [_jsxs("button", { type: "button", className: css.step, onClick: () => { scrollToStep(s.key); }, title: stepLabel(stepStates[s.key]), children: [_jsx("span", { className: clsx(css.stepDot, stepStates[s.key] === 'done' && css.stepDotDone, stepStates[s.key] === 'note' && css.stepDotNote), children: stepStates[s.key] === 'done' ? '✓' : s.n }), _jsx("span", { className: css.stepLabel, children: s.label })] }), next && (_jsx("span", { className: clsx(css.stepLine, stepStates[next.key] === 'done' && css.stepLineDone), "aria-hidden": "true" }))] }, s.key));
                }) }), message && (_jsxs("div", { className: clsx(css.notice, message.kind === 'ok' ? css.toastOk : css.toastErr), children: [_jsxs("div", { className: css.noticeHead, children: [_jsx("span", { className: css.noticeText, children: message.text }), _jsx("button", { type: "button", className: css.noticeClose, onClick: () => { setMessage(null); }, "aria-label": "\u5173\u95ED\u63D0\u793A", children: "\u2715" })] }), message.details && message.details.length > 0 && (_jsxs("div", { className: css.noticeDetails, children: [message.details.slice(0, 20).map((d, i) => _jsx("div", { className: css.noticeDetailItem, children: d }, i)), message.details.length > 20 && _jsx("div", { className: css.noticeDetailMore, children: "\u2026\u4EC5\u663E\u793A\u524D 20 \u6761" })] }))] })), _jsxs("div", { className: css.scroll, children: [_jsxs("section", { className: css.card, ref: (el) => { if (el)
                            stepRefs.current.set('detect', el); }, children: [_jsxs("header", { className: css.cardHd, children: [_jsx(IconGlobeOutline14, { size: 14 }), _jsx("span", { className: css.cardTitle, children: "\u68C0\u6D4B\u8D26\u53F7" }), _jsxs("span", { className: css.cardBadge, children: [_jsx(StateDot, { state: accounts.length > 0 ? 'done' : 'warning' }), accounts.length > 0 ? `${accounts.length} 个账号` : '未检测到微信'] })] }), _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.stats, children: [_jsxs("div", { className: css.statChip, children: [_jsx("span", { className: css.statNum, children: detectInfo.version ?? '—' }), _jsx("span", { className: css.statLabel, children: "\u5FAE\u4FE1\u7248\u672C" })] }), _jsxs("div", { className: css.statChip, children: [_jsx("span", { className: css.statNum, children: String(accounts.length) }), _jsx("span", { className: css.statLabel, children: "\u68C0\u6D4B\u8D26\u53F7" })] }), _jsxs("div", { className: css.statChip, children: [_jsx("span", { className: css.statNum, children: String(dbFiles) }), _jsx("span", { className: css.statLabel, children: "\u6570\u636E\u5E93\u6587\u4EF6" })] })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u5FAE\u4FE1\u8D26\u53F7\u68C0\u6D4B" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), icon: detecting ? _jsx("span", { className: css.spin }) : undefined, onClick: () => { void detect(); }, disabled: detecting, children: detecting ? '检测中…' : '检测本机微信账号' })] }), _jsx(MsgSlot, { placeholder: "\u70B9\u51FB\u300C\u68C0\u6D4B\u672C\u673A\u5FAE\u4FE1\u8D26\u53F7\u300D\u540E\uFF0C\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", msg: detectMsg }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u5FAE\u4FE1\u5B89\u88C5\u76EE\u5F55" }), _jsx("span", { className: css.rowMeta, title: detectInfo.install_dir ?? '', children: detectInfo.install_dir ?? '检测中…' })] }), _jsx("div", { className: css.accounts, children: accounts.length > 0 ? accounts.map(a => (_jsxs("div", { className: clsx(css.acct, current(a) && css.acctCurrent), children: [_jsx(AccountAvatar, { wxid: a.wxid }), _jsxs("div", { className: css.acctMain, children: [_jsxs("div", { className: css.acctTop, children: [_jsx("span", { className: css.acctName, children: a.wxid }), current(a) && _jsx("span", { className: css.acctBadge, children: "\u5F53\u524D\u4F7F\u7528" })] }), _jsxs("span", { className: css.acctMeta, children: [a.db_files !== undefined ? `${a.db_files} 个库文件` : '库文件未知', " \u00B7 \u6700\u8FD1\u6D3B\u52A8 ", fmtActive(a.last_active), " \u00B7 \u8DEF\u5F84\u5DF2\u786E\u8BA4"] }), _jsx("span", { className: css.acctPath, title: a.db_dir, children: a.db_dir })] }), _jsx(Button, { size: "sm", variant: current(a) ? 'ghost' : 'primary', className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { useAccount(a); }, disabled: current(a), children: current(a) ? '当前使用' : '使用此账号' })] }, a.db_dir))) : (_jsx("div", { className: css.accountsEmpty, children: "\u70B9\u51FB\u300C\u68C0\u6D4B\u672C\u673A\u5FAE\u4FE1\u8D26\u53F7\u300D\u540E\uFF0C\u53EF\u64CD\u4F5C\u7684\u8D26\u53F7\u5C06\u663E\u793A\u5728\u8FD9\u91CC" })) }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u6570\u636E\u5E93\u76EE\u5F55" }), _jsx(Input, { className: css.input, value: dbDir, onChange: (e) => { setDbDir(e.target.value); }, placeholder: "\u7559\u7A7A\u81EA\u52A8\u68C0\u6D4B\u672C\u673A\u5FAE\u4FE1\u8D26\u53F7" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void pickDbDir(); }, children: "\u9009\u62E9\u2026" })] }), _jsx(MsgSlot, { placeholder: "\u70B9\u51FB\u300C\u9009\u62E9\u2026\u300D\u6216\u8D26\u53F7\u5361\u300C\u4F7F\u7528\u6B64\u8D26\u53F7\u300D\u540E\uFF0C\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", msg: dbDirMsg })] })] }), _jsxs("section", { className: css.card, ref: (el) => { if (el)
                            stepRefs.current.set('dbkey', el); }, children: [_jsxs("header", { className: css.cardHd, children: [_jsx(IconPersonalizationOutline16, { size: 14 }), _jsx("span", { className: css.cardTitle, children: "\u6570\u636E\u5E93\u5BC6\u94A5" }), _jsxs("span", { className: css.cardBadge, children: [_jsx(StateDot, { state: keyOk ? 'done' : 'warning' }), keyOk ? `${keysInfo.keyCount} 个密钥` : '尚未加载密钥文件'] })] }), _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u6570\u636E\u5E93\u5BC6\u94A5" }), _jsx(Input, { className: css.input, value: dbKey, onChange: (e) => { setDbKey(e.target.value); }, placeholder: "64 \u4F4D hex \u4E3B\u5BC6\u94A5 / \u53E3\u4EE4" }), _jsx(Button, { size: "sm", variant: "primary", className: clsx(css.btnFx, css.btnFixed), icon: autoGetting ? _jsx("span", { className: css.spin }) : undefined, onClick: () => { void autoGetDb(); }, disabled: autoGetting, children: autoGetting ? '获取中…' : '一键获取数据库密钥' }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void verifyDb(); }, disabled: autoGetting, children: "\u6821\u9A8C" })] }), _jsx(MsgSlot, { placeholder: "\u70B9\u51FB\u300C\u4E00\u952E\u83B7\u53D6\u6570\u636E\u5E93\u5BC6\u94A5\u300D\u6216\u300C\u6821\u9A8C\u300D\u540E\uFF0C\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", msg: dbOpMsg }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u5BC6\u94A5\u6587\u4EF6\u6982\u89C8" }), _jsx("span", { className: css.rowMeta, children: keyOk ? `${keysInfo.keyFormat ?? ''} · ${keysInfo.keyCount} 个密钥` : '尚未加载密钥文件' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u7ACB\u5373\u89E3\u5BC6" }), _jsx("span", { className: css.rowMeta, children: "\u5C06 db_storage \u4E0B\u5168\u90E8 .db \u89E3\u5BC6\u5199\u5165\u89E3\u5BC6\u5E93\u76EE\u5F55" }), _jsx(Button, { size: "sm", variant: "primary", className: clsx(css.btnFx, css.btnFixed), icon: decrypting ? _jsx("span", { className: css.spin }) : undefined, onClick: () => { void decryptAll(); }, disabled: decrypting, children: decrypting ? '解密中…' : '立即解密' })] }), _jsx(StatusSlot, { placeholder: "\u70B9\u51FB\u300C\u7ACB\u5373\u89E3\u5BC6\u300D\u5F00\u59CB\uFF0C\u8FDB\u5EA6\u4E0E\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", active: dbProgress.active, pct: dbProgress.total > 0 ? Math.round((dbProgress.done / dbProgress.total) * 100) : 0, text: `解密 ${dbProgress.done}/${dbProgress.total} · 成功 ${dbProgress.done - dbProgress.failed} · 失败 ${dbProgress.failed}`, item: dbProgress.message, doneText: dbProgress.done > 0 ? `上次解密：成功 ${dbProgress.done - dbProgress.failed}/${dbProgress.total} · 失败 ${dbProgress.failed}` : '', doneKind: "" }), _jsx("div", { className: css.row, children: _jsx("span", { className: css.rowNote, children: "\u2705 \u81EA\u52A8\u83B7\u53D6\u5BC6\u94A5\u5DF2\u652F\u6301\uFF08V4 \u5185\u5B58\u626B\u63CF + Weixin.dll \u5185\u90E8\u952E\u89E3\u63A9\u7801\uFF0C\u9700\u5FAE\u4FE1\u8FDB\u7A0B\u8FD0\u884C\u4E2D\uFF09\uFF1BSQLCipher \u5168\u5E93\u89E3\u5BC6\u901A\u8FC7\u300C\u7ACB\u5373\u89E3\u5BC6\u300D\u5B8C\u6210\u3002" }) })] })] }), _jsxs("section", { className: css.card, ref: (el) => { if (el)
                            stepRefs.current.set('imgkey', el); }, children: [_jsxs("header", { className: css.cardHd, children: [_jsx(IconSparkle16, { size: 14 }), _jsx("span", { className: css.cardTitle, children: "\u56FE\u7247\u5BC6\u94A5" }), _jsxs("span", { className: css.cardBadge, children: [_jsx(StateDot, { state: imgAes.trim() !== '' ? 'done' : 'warning' }), imgAes.trim() !== '' ? '已就绪' : '未配置'] })] }), _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u56FE\u7247 AES \u5BC6\u94A5" }), _jsx(Input, { className: css.input, value: imgAes, onChange: (e) => { setImgAes(e.target.value); }, placeholder: "32 \u4F4D hex\uFF08\u7559\u7A7A\u81EA\u52A8\uFF09" }), _jsx(Button, { size: "sm", variant: "primary", className: clsx(css.btnFx, css.btnFixed), icon: autoGetting ? _jsx("span", { className: css.spin }) : undefined, onClick: () => { void autoGetImg(); }, disabled: autoGetting, children: autoGetting ? '获取中…' : '扫描微信内存' }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void verifyImg(); }, disabled: autoGetting, children: "\u6821\u9A8C" })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "XOR key" }), _jsx(Input, { className: css.inputNarrow, value: imgXor, onChange: (e) => { setImgXor(e.target.value); } })] }), _jsx(MsgSlot, { placeholder: "\u70B9\u51FB\u300C\u626B\u63CF\u5FAE\u4FE1\u5185\u5B58\u300D\u6216\u300C\u6821\u9A8C\u300D\u540E\uFF0C\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", msg: imgOpMsg }), _jsx("div", { className: css.row, children: _jsx("span", { className: css.rowNote, children: "\u2705 \u81EA\u52A8\u83B7\u53D6\u5DF2\u652F\u6301\uFF08V2 \u6A21\u677F\u9A8C\u8BC1\u5185\u5B58\u626B\u63CF\uFF0C\u9700\u5FAE\u4FE1\u8FDB\u7A0B\u8FD0\u884C\u4E2D\uFF09\uFF1B\u586B\u5199\u540E\u70B9\u51FB\u4FDD\u5B58\u5373\u53EF\u7528\u4E8E\u56FE\u7247\u79BB\u7EBF\u89E3\u7801\u3002" }) })] })] }), _jsxs("section", { className: css.card, ref: (el) => { if (el)
                            stepRefs.current.set('img', el); }, children: [_jsxs("header", { className: css.cardHd, children: [_jsx(IconGlobeOutline14, { size: 14 }), _jsx("span", { className: css.cardTitle, children: "\u56FE\u7247\u89E3\u7801" }), _jsxs("span", { className: css.cardBadge, children: [_jsx(StateDot, { state: cdnEnabled ? 'done' : 'warning' }), cdnEnabled ? '已启用' : '未启用'] })] }), _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u81EA\u52A8\u83B7\u53D6\u539F\u56FE\uFF08CDN\uFF09" }), _jsx(Pill, { active: cdnEnabled, children: cdnEnabled ? '已开启' : '已关闭' }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void toggleCdn(!cdnEnabled); }, children: cdnEnabled ? '关闭' : '开启' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u539F\u56FE\u89E3\u5BC6\u65B9\u5F0F" }), _jsx(Pill, { active: cdnLocal, children: cdnLocal ? '本地解密' : '服务端解密' }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void toggleCdnLocal(!cdnLocal); }, children: cdnLocal ? '切换服务端' : '切换本地' })] }), _jsx(MsgSlot, { placeholder: "\u70B9\u51FB\u300C\u5F00\u542F/\u5173\u95ED\u300D\u300C\u5207\u6362\u670D\u52A1\u7AEF/\u672C\u5730\u300D\u540E\uFF0C\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", msg: cdnMsg }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u6279\u91CF\u89E3\u5BC6\u56FE\u7247" }), _jsx("span", { className: css.rowMeta, title: "\u89E3\u5BC6 msg/attach \u4E0B\u6240\u6709 .dat \u56FE\u7247\u5230\u89E3\u7801\u7F13\u5B58\uFF0C\u804A\u5929/\u670B\u53CB\u5708\u56FE\u7247\u5373\u65F6\u663E\u793A", children: "\u89E3\u5BC6 msg/attach \u5168\u90E8 .dat \u5230\u89E3\u7801\u7F13\u5B58" }), _jsx(Input, { className: css.inputNarrow, value: String(imgConcurrency), onChange: (e) => { setImgConcurrency(Number(e.target.value) || 8); }, title: "\u5E76\u884C\u7EBF\u7A0B\u6570" }), _jsx(Button, { size: "sm", variant: "primary", className: clsx(css.btnFx, css.btnFixed), icon: imgDecrypting ? _jsx("span", { className: css.spin }) : undefined, onClick: () => { void decryptImgs(); }, disabled: imgDecrypting, children: imgDecrypting ? '解密中…' : '立即解密' })] }), _jsx(StatusSlot, { placeholder: "\u70B9\u51FB\u300C\u7ACB\u5373\u89E3\u5BC6\u300D\u5F00\u59CB\uFF0C\u8FDB\u5EA6\u4E0E\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", active: imgProgress.active, pct: imgProgress.total > 0 ? Math.round((imgProgress.done / imgProgress.total) * 100) : 0, text: `解密 ${imgProgress.done}/${imgProgress.total} · 成功 ${imgProgress.done - imgProgress.failed - imgProgress.skipped} · 跳过 ${imgProgress.skipped} · 失败 ${imgProgress.failed}`, item: imgProgress.message, doneText: imgProgress.done > 0 ? `上次解密：成功 ${imgProgress.done - imgProgress.failed - imgProgress.skipped}/${imgProgress.total} · 跳过 ${imgProgress.skipped} · 失败 ${imgProgress.failed}` : '', doneKind: "" }), _jsx("div", { className: css.row, children: _jsx("span", { className: css.rowNote, children: "\u2705 \u670B\u53CB\u5708/\u804A\u5929\u56FE\u7247\u79BB\u7EBF\u89E3\u7801\u5DF2\u652F\u6301\uFF08\u672C\u5730\u7F13\u5B58 .dat \u89E3\u5BC6\uFF09\uFF1B\u9AD8\u6E05\u539F\u56FE\u4E0E\u8868\u60C5\u6279\u91CF\u8F6C\u7801\u4E3A\u540E\u7EED\u672C\u5730\u80FD\u529B\u3002HEVC/\u89C6\u9891\u683C\u5F0F\u81EA\u52A8\u8DF3\u8FC7\u3002" }) })] })] }), _jsxs("section", { className: css.card, ref: (el) => { if (el)
                            stepRefs.current.set('voice', el); }, children: [_jsxs("header", { className: css.cardHd, children: [_jsx(IconSparkle16, { size: 14 }), _jsxs("div", { className: css.cardTitleBox, children: [_jsx("span", { className: css.cardTitle, children: "\u8BED\u97F3\u8F6C\u5199\uFF08\u53EF\u9009\uFF09" }), _jsx("span", { className: css.cardSub, children: "\u63D0\u524D\u5904\u7406\u5168\u90E8\u8BED\u97F3\uFF0C\u8FDB\u5165\u804A\u5929\u540E\u4F1A\u76F4\u63A5\u663E\u793A\u5728\u8BED\u97F3\u4E0B\u65B9" })] }), _jsxs("span", { className: css.cardBadge, children: [_jsx(StateDot, { state: whisperStatus?.engine ? 'done' : 'warning' }), whisperStatus?.engine ? '引擎已就绪' : '待配置引擎'] })] }), _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.whisperBanner, children: [_jsxs("div", { className: css.whisperBannerText, children: [_jsx("span", { className: css.whisperBannerTitle, children: "\u672C\u5730\u5904\u7406\uFF0C\u4E0D\u4E0A\u4F20\u8BED\u97F3" }), _jsx("span", { className: css.whisperBannerDesc, children: "\u5DF2\u7531\u5FAE\u4FE1\u8F6C\u5199\u7684\u8BED\u97F3\u4F1A\u76F4\u63A5\u590D\u7528\u6570\u636E\u5E93\u6587\u5B57\uFF1B\u5176\u4F59\u8BED\u97F3\u624D\u4F1A\u4EA4\u7ED9\u672C\u5730 Whisper\uFF0C\u9700 whisper.cpp \u5F15\u64CE\u3002" })] }), _jsx("button", { type: "button", className: css.whisperRefresh, onClick: () => { void refreshWhisper(); }, disabled: whisperStatusLoading, children: whisperStatusLoading ? '检测中…' : '刷新状态' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u8F6C\u5199\u5F15\u64CE" }), _jsx("span", { className: css.rowMeta, title: whisperStatus?.enginePath ?? '', children: whisperStatusLoading ? '检测中…' : whisperStatus?.engine
                                                    ? `已就绪（${whisperStatus.enginePath ?? whisperStatus.engine}）`
                                                    : '未检测到 whisper.cpp 引擎，可一键下载' }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixed), icon: whisperDownloading?.model === 'engine' ? _jsx("span", { className: css.spin }) : undefined, disabled: whisperDownloading !== null || Boolean(whisperStatus?.engine), onClick: () => { void installEngine(); }, children: whisperDownloading?.model === 'engine' ? '下载中…' : whisperStatus?.engine ? '已安装' : '下载引擎' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u63A8\u7406\u8BBE\u5907" }), _jsx("span", { className: css.rowMeta, children: "CPU \u517C\u5BB9\u6240\u6709\u8BBE\u5907\uFF1BNVIDIA GPU \u4F7F\u7528 CUDA \u52A0\u901F\uFF0C\u5931\u8D25\u4F1A\u81EA\u52A8\u56DE\u9000 CPU\u3002" })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u5F53\u524D\u8BBE\u5907" }), _jsxs("div", { className: css.deviceSeg, children: [_jsx("button", { type: "button", className: clsx(css.deviceSegBtn, whisperDevice === 'cpu' && css.deviceSegOn), onClick: () => { setWhisperDevice('cpu'); }, children: "CPU" }), _jsx("button", { type: "button", className: clsx(css.deviceSegBtn, whisperDevice === 'gpu' && css.deviceSegOn), disabled: !whisperStatus?.hasCuda, title: whisperStatus?.hasCuda ? 'NVIDIA GPU（CUDA 加速）' : '未检测到可用的 NVIDIA CUDA 设备或驱动', onClick: () => { setWhisperDevice('gpu'); }, children: "NVIDIA GPU" })] }), _jsx("span", { className: clsx(css.rowMeta, !whisperStatus?.hasCuda && css.rowMetaWarn), children: whisperStatus?.hasCuda ? 'CUDA 可用' : '未检测到可用的 NVIDIA CUDA 设备或驱动。' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u6A21\u578B\u76EE\u5F55" }), _jsx(Input, { className: css.input, value: whisperModelsDir, onChange: (e) => { setWhisperModelsDir(e.target.value); }, placeholder: "\u7559\u7A7A\u4F7F\u7528\u9ED8\u8BA4\u76EE\u5F55\uFF08~/.dsh/wechat-data/whisper\uFF09" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void pickWhisperDir(); }, children: "\u9009\u62E9\u2026" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { const d = whisperModelsDir.trim(); if (d)
                                                    void apiOpenPath(d); }, children: "\u6253\u5F00" })] }), _jsx(MsgSlot, { placeholder: "\u70B9\u51FB\u300C\u9009\u62E9\u2026/\u4E0B\u8F7D\u300D\u540E\uFF0C\u7ED3\u679C\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", msg: whisperDirMsg }), _jsxs("div", { className: css.gridHd, children: [_jsx("span", { className: css.gridHdTitle, children: "\u9009\u62E9\u6A21\u578B" }), _jsxs("span", { className: css.gridHdAside, children: ["\u5F53\u524D\u8BBE\u5907\uFF1A", whisperDevice === 'gpu' ? 'NVIDIA GPU' : 'CPU'] })] }), _jsx("div", { className: css.modelGrid, children: (whisperStatus?.models ?? WHISPER_MODEL_FALLBACK).map((m) => {
                                            const selected = whisperModel === m.id;
                                            const downloading = whisperDownloading?.model === m.id;
                                            const pct = downloading && whisperDownloading.total > 0
                                                ? Math.round((whisperDownloading.received / whisperDownloading.total) * 100)
                                                : 0;
                                            return (_jsxs("button", { type: "button", className: clsx(css.modelCard, selected && css.modelSelected, downloading && css.modelDownloadingCard), onClick: () => { setWhisperModel(m.id); }, children: [_jsxs("span", { className: css.modelName, children: [m.name, selected && _jsx("span", { className: css.modelTag, children: "\u5DF2\u9009\u62E9" })] }), _jsx("span", { className: css.modelBadge, children: downloading
                                                            ? _jsx("span", { className: css.modelStateDownloading, children: "\u4E0B\u8F7D\u4E2D" })
                                                            : m.installed
                                                                ? _jsx("span", { className: css.modelStateInstalled, children: "\u2713 \u5DF2\u5B89\u88C5" })
                                                                : _jsx("span", { className: css.modelState, children: "\u9700\u4E0B\u8F7D" }) }), _jsx("span", { className: css.modelSize, children: m.sizeLabel }), downloading ? (_jsxs("span", { className: css.modelProgress, children: [_jsx("span", { className: css.modelProgressTrack, children: _jsx("span", { className: css.modelProgressFill, style: { width: `${Math.max(2, pct)}%` } }) }), _jsxs("span", { className: css.modelProgressPct, children: [pct, "%"] })] })) : (_jsx("span", { className: clsx(css.modelDownload, m.installed && css.modelDownloadDone), onClick: (ev) => {
                                                            ev.stopPropagation();
                                                            if (!m.installed)
                                                                void whisperDownload(m);
                                                        }, children: m.installed ? '已就绪' : '下载' }))] }, m.id));
                                        }) }), _jsx("div", { className: css.row, children: _jsx("span", { className: css.rowNote, children: whisperStatus?.models.some(m => m.installed)
                                                ? `已安装 ${whisperStatus.models.filter(m => m.installed).length} 个模型到本机缓存，点击「下载」可继续获取其他模型。`
                                                : '模型从官方仓库下载（huggingface.co，失败自动切换 hf-mirror；可用环境变量 DSH_WECHAT_WHISPER_MIRROR 指定镜像）。' }) }), _jsxs("div", { className: css.whisperThreads, children: [_jsx("span", { className: css.whisperThreadsLabel, children: "\u5E76\u53D1\u7EBF\u7A0B\u6570" }), _jsx(Input, { className: css.inputNarrow, value: String(whisperThreads), onChange: (e) => { setWhisperThreads(Math.max(0, Number(e.target.value) || 0)); }, placeholder: "0" }), _jsx("span", { className: css.rowMeta, children: "0 \u81EA\u52A8\uFF0C\u8F93\u5165\u6B63\u6574\u6570" })] }), _jsx("div", { className: css.row, children: _jsx("span", { className: css.rowNote, children: '🔒 模型仅本地推理，不上传语音；语音由内置 SILK 解码器本地转 WAV，转写由 whisper-cli 执行（需 ' +
                                                'DSH_WECHAT_WHISPER_BIN 指向引擎且模型已安装）。' }) }), _jsxs("div", { className: css.whisperFooter, children: [_jsx("button", { type: "button", className: css.whisperSkip, onClick: () => { skipTranscribe(); }, children: "\u8DF3\u8FC7\uFF0C\u67E5\u770B\u804A\u5929\u8BB0\u5F55" }), _jsx(Button, { variant: "primary", className: clsx(css.btnFx, css.btnFixed), icon: whisperTranscribing.active ? _jsx("span", { className: css.spin }) : undefined, disabled: whisperTranscribing.active, onClick: () => { void batchTranscribe(); }, children: whisperTranscribing.active ? '转写中…' : '本地批量转文字' }), _jsx(Button, { variant: "outline", className: clsx(css.btnFx, css.btnFixed), onClick: () => { nativeTranscribe(); }, children: "\u5FAE\u4FE1\u539F\u751F\u6279\u91CF\u8F6C\u6587\u5B57" })] }), _jsx(StatusSlot, { placeholder: "\u70B9\u51FB\u300C\u672C\u5730\u6279\u91CF\u8F6C\u6587\u5B57\u300D\u540E\uFF0C\u8F6C\u5199\u8FDB\u5EA6\u5B9E\u65F6\u663E\u793A\u5728\u8FD9\u91CC", active: whisperTranscribing.active, pct: whisperTranscribing.total > 0 ? Math.round((whisperTranscribing.done / whisperTranscribing.total) * 100) : 0, text: `转写 ${whisperTranscribing.done}/${whisperTranscribing.total} · 成功 ${whisperTranscribing.done} · 跳过 ${whisperTranscribing.skipped} · 失败 ${whisperTranscribing.failed}`, item: whisperTranscribing.current, doneText: voiceOpMsg?.text ?? (whisperTranscribing.done > 0 ? `上次转写：成功 ${whisperTranscribing.done}/${whisperTranscribing.total} · 跳过 ${whisperTranscribing.skipped} · 失败 ${whisperTranscribing.failed}` : ''), doneKind: voiceOpMsg?.kind ?? '' })] })] }), _jsxs("details", { className: css.advanced, children: [_jsx("summary", { className: css.advancedSummary, children: "\u9AD8\u7EA7\u8BBE\u7F6E \u00B7 HTTP API \u670D\u52A1 & \u8F93\u51FA\u76EE\u5F55" }), _jsxs("div", { className: css.advancedBody, children: [_jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u542F\u7528" }), _jsx("input", { type: "checkbox", checked: apiEnabled, onChange: (e) => { setApiEnabled(e.target.checked); } }), _jsx(Pill, { active: apiEnabled, children: apiEnabled ? '已启用' : '未启用' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u8BBF\u95EE\u4EE4\u724C" }), _jsx(Input, { className: css.input, value: apiToken, onChange: (e) => { setApiToken(e.target.value); }, placeholder: "\u7559\u7A7A = \u514D\u9274\u6743" })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u76D1\u542C\u7AEF\u53E3" }), _jsx(Input, { className: css.inputNarrow, value: String(apiPort), onChange: (e) => { setApiPort(Number(e.target.value) || 5032); } }), _jsxs("span", { className: css.rowMeta, children: ["http://127.0.0.1:", apiPort] })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u89E3\u5BC6\u8F93\u51FA" }), _jsx("span", { className: css.rowMeta, children: cfg?.resolved?.decrypted_dir ?? '—' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u56FE\u7247\u8F93\u51FA" }), _jsx("span", { className: css.rowMeta, children: cfg?.resolved?.decoded_image_dir ?? '—' })] }), _jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: "\u5BC6\u94A5\u6587\u4EF6" }), _jsx("span", { className: css.rowMeta, children: cfg?.resolved?.keys_file ?? '—' })] }), _jsx("div", { className: css.row, children: _jsx("span", { className: css.rowNote, children: "\u672C\u9762\u677F\u5DF2\u901A\u8FC7 Remote \u76F4\u8BFB\uFF0C\u65E0\u5916\u90E8 HTTP \u4F9D\u8D56\u3002" }) })] })] })] }), _jsxs("div", { className: css.saveBar, children: [_jsx("span", { className: css.saveMeta, title: "\u914D\u7F6E\u6587\u4EF6", children: cfg ? '配置: wechat/config.json' : cfgLoading ? '读取配置…' : '' }), _jsx("span", { className: saveMsg ? (saveMsg.kind === 'ok' ? css.saveMsgOk : css.saveMsgErr) : css.saveMsgIdle, children: saveMsg ? saveMsg.text : '修改后点击「保存配置」生效' }), _jsx(Button, { variant: "primary", className: clsx(css.btnFx, css.btnFixed), icon: saving ? _jsx("span", { className: css.spin }) : undefined, onClick: () => { void save(); }, disabled: saving, children: saving ? '保存中…' : '保存配置' })] })] }));
}
//# sourceMappingURL=Settings.js.map