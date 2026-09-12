import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 微信数据面板 — 主容器，分组导航（概览 / 会话与消息 / 联系人 / 内容资产 /
 * 财务与存储 / 洞察与行动 / 隐私与安全 / 维护与设置，共 32 页签），配置见
 * navigation 模块。数据经 DSH 后端 Remote（node:sqlite 读自有解密库），
 * 顶部显示连接状态与数据库状态弹窗。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiGetDbStatus, apiGetSessions, apiSearchUnified, checkApiHealth, getApiStatus, subscribeApiStatus } from "./api.js";
// 面板统一静态导入；客户端插件加载器按单文件 factory 加载，不能分包。
import { OverviewPanel } from "./panels/Overview.js";
import { AskPanel } from "./panels/Ask.js";
import { ChatsPanel } from "./panels/Chats.js";
import { ContactsPanel } from "./panels/Contacts.js";
import { MomentsPanel } from "./panels/MomentsOptimized.js";
import { FavoritesPanel } from "./panels/Favorites.js";
import { EmoticonsPanel } from "./panels/Emoticons.js";
import { FilesPanel } from "./panels/Files.js";
import { RecordsPanel } from "./panels/Records.js";
import { LedgerPanel } from "./panels/Ledger.js";
import { TasksPanel } from "./panels/Tasks.js";
import { GroupInsightsPanel } from "./panels/GroupInsights.js";
import { HealthPanel } from "./panels/Health.js";
import { MomentsInsightsPanel } from "./panels/MomentsInsights.js";
import { AssetInsightsPanel } from "./panels/AssetInsights.js";
import { OfficialAssetsPanel } from "./panels/OfficialAssets.js";
import { MediaAssetsPanel } from "./panels/MediaAssets.js";
import { StoragePanel } from "./panels/Storage.js";
import { RevokedPanel } from "./panels/Revoked.js";
import { PrivacyPanel } from "./panels/Privacy.js";
import { PrivacyTrustPanel } from "./panels/PrivacyTrust.js";
import { BackupPanel } from "./panels/Backup.js";
import { MonitorPanel } from "./panels/Monitor.js";
import { AnnualPanel } from "./panels/Annual.js";
import { DailySummaryPanel } from "./panels/DailySummary.js";
import { PeriodSummaryPanel } from "./panels/PeriodSummary.js";
import { HookPanel } from "./panels/Hook.js";
import { GraphPanel } from "./panels/Graph.js";
import { SettingsPanel } from "./panels/Settings.js";
import { OperationLogPanel } from "./panels/OperationLogPanel.js";
import css from './wechat-data.module.css';
import './scifi-theme.css';
import { NAV_GROUPS, TAB_LABELS } from "./nav-config.js";
import { closeWechat } from "../../wechat-state.js";
import { Drawer, Tooltip } from "./ui/kit.js";
/** Render the active tab; unimplemented tabs show a placeholder. */
function renderTab(tab, onNavigate, onOpenChat, chatTarget, onOpenMoments, momentAuthor, clearMomentAuthor) {
    const chatViews = {
        chats: 'chats', bizchats: 'bizchats', servicechats: 'servicechats', kefu: 'kefu',
    };
    switch (tab) {
        case 'overview': return _jsx(OverviewPanel, { onNavigate: (tab) => { onNavigate(tab); }, onOpenChat: onOpenChat, onOpenMoments: onOpenMoments });
        case 'ask': return _jsx(AskPanel, { onOpenChat: onOpenChat });
        case 'chats':
        case 'bizchats':
        case 'servicechats':
        case 'kefu': return _jsx(ChatsPanel, { initialView: chatViews[tab] ?? 'chats', initialTarget: chatTarget });
        case 'contacts': return _jsx(ContactsPanel, { onNavigate: (tab) => { onNavigate(tab); }, onOpenChat: onOpenChat, onOpenMoments: onOpenMoments });
        case 'moments': return _jsx(MomentsPanel, { author: momentAuthor, onClearAuthor: clearMomentAuthor });
        case 'favorites': return _jsx(FavoritesPanel, {});
        case 'emoticons': return _jsx(EmoticonsPanel, {});
        case 'files': return _jsx(FilesPanel, {});
        case 'records': return _jsx(RecordsPanel, { onOpenChat: onOpenChat });
        case 'ledger': return _jsx(LedgerPanel, { onOpenChat: onOpenChat });
        case 'tasks': return _jsx(TasksPanel, { onOpenChat: onOpenChat });
        case 'groupinsights': return _jsx(GroupInsightsPanel, { onOpenChat: onOpenChat, onNavigate: (tab) => { onNavigate(tab); } });
        case 'momentsinsights': return _jsx(MomentsInsightsPanel, {});
        case 'assetinsights': return _jsx(AssetInsightsPanel, {});
        case 'officialassets': return _jsx(OfficialAssetsPanel, { onOpenChat: onOpenChat });
        case 'mediaassets': return _jsx(MediaAssetsPanel, { onNavigate: (tab) => { onNavigate(tab); } });
        case 'storage': return _jsx(StoragePanel, { onOpenChat: onOpenChat });
        case 'revoked': return _jsx(RevokedPanel, {});
        case 'privacy': return _jsx(PrivacyPanel, { onOpenChat: onOpenChat });
        case 'privacytrust': return _jsx(PrivacyTrustPanel, {});
        case 'backup': return _jsx(BackupPanel, {});
        case 'monitor': return _jsx(MonitorPanel, { onOpenChat: onOpenChat });
        case 'annual': return _jsx(AnnualPanel, {});
        case 'dailysummary': return _jsx(DailySummaryPanel, {});
        case 'period': return _jsx(PeriodSummaryPanel, {});
        case 'hook': return _jsx(HookPanel, { onNavigate: (tab) => { onNavigate(tab); } });
        case 'graph': return _jsx(GraphPanel, { onOpenChat: onOpenChat });
        case 'settings': return _jsx(SettingsPanel, {});
        case 'oplog': return _jsx(OperationLogPanel, {});
        case 'health': return _jsx(HealthPanel, { onNavigate: (tab) => { onNavigate(tab); } });
        default:
            return (_jsxs("div", { className: css.placeholder, children: [_jsxs("p", { children: ["\uD83D\uDEA7 \u300C", TAB_LABELS[tab], "\u300D\u9762\u677F\u6B63\u5728\u91CD\u6784\u4E2D"] }), _jsx("p", { children: "\u8BE5\u9875\u7B7E\u7684 React \u7248\u672C\u5C06\u5728\u540E\u7EED\u8FED\u4EE3\u4E2D\u63A5\u5165\u3002" })] }));
    }
}
/**
 * Render the WeChat data panel shell.
 * @returns the data panel element tree.
 */
export function WechatDataPanel() {
    const [active, setActiveState] = useState(() => {
        const h = (typeof location !== 'undefined' ? location.hash : '').replace('#', '');
        return (h in TAB_LABELS ? h : 'overview');
    });
    const setActive = useCallback((t) => {
        setActiveState(t);
        try {
            if (typeof location !== 'undefined')
                location.hash = t;
        }
        catch { /* hash 写入失败可忽略 */ }
    }, []);
    const apiStatus = useSyncExternalStore(subscribeApiStatus, getApiStatus);
    const [dbStatusOpen, setDbStatusOpen] = useState(false);
    const [dbStatusLoading, setDbStatusLoading] = useState(false);
    const [dbStatusLines, setDbStatusLines] = useState([]);
    const [chatTarget, setChatTarget] = useState(null);
    const [momentAuthor, setMomentAuthor] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchLoading, setSearchLoading] = useState(false);
    const searchInputRef = useRef(null);
    const searchSeqRef = useRef(0);
    const [searchResults, setSearchResults] = useState({ sessions: [], hits: [], contacts: [], moments: [], favorites: [], files: [], records: [] });
    /** Cross-panel navigation: jump to the chats tab and open/locate a session. */
    const openChat = useCallback((username, localId) => {
        const target = { username, nonce: Date.now() };
        if (localId !== undefined)
            target.localId = localId;
        setChatTarget(target);
        setActive('chats');
    }, []);
    /** Cross-panel navigation: jump to the moments tab filtered by one author. */
    const openMoments = useCallback((username) => {
        setMomentAuthor(username || null);
        setActive('moments');
    }, []);
    const refreshDbStatus = useCallback(async () => {
        setDbStatusLoading(true);
        try {
            const r = await apiGetDbStatus();
            setDbStatusLines(r.lines);
        }
        catch {
            setDbStatusLines(['⚠️ 读取数据库状态失败']);
        }
        finally {
            setDbStatusLoading(false);
        }
    }, []);
    useEffect(() => {
        void checkApiHealth();
    }, []);
    // Global search (sessions + messages + contacts/moments/favorites/files/records) with a 300ms debounce.
    useEffect(() => {
        const q = searchQuery.trim();
        if (!q) {
            searchSeqRef.current += 1;
            setSearchResults({ sessions: [], hits: [], contacts: [], moments: [], favorites: [], files: [], records: [] });
            setSearchLoading(false);
            return;
        }
        setSearchLoading(true);
        const seq = ++searchSeqRef.current;
        const t = window.setTimeout(() => {
            void Promise.all([
                apiGetSessions({ keyword: q, limit: 8 }).catch(() => ({ sessions: [], total: 0 })),
                apiSearchUnified({ query: q, limit: 8 }).catch(() => ({
                    query: q, messages: [], contacts: [], moments: [], favorites: [], files: [], records: [],
                })),
            ]).then(([sessionRes, un]) => {
                if (seq !== searchSeqRef.current)
                    return;
                setSearchResults({
                    sessions: sessionRes.sessions,
                    hits: un.messages,
                    contacts: un.contacts,
                    moments: un.moments,
                    favorites: un.favorites,
                    files: un.files,
                    records: un.records,
                });
                setSearchLoading(false);
            });
        }, 300);
        return () => { window.clearTimeout(t); };
    }, [searchQuery]);
    // Ctrl/Cmd+K focuses the global search; Esc closes the dropdown.
    useEffect(() => {
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                searchInputRef.current?.focus();
                setSearchOpen(true);
            }
            else if (e.key === 'Escape') {
                setSearchOpen(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, []);
    // 只渲染活动标签；用 useMemo 避免搜索/数据库状态等无关状态变化时重建面板元素。
    const activePanel = useMemo(() => renderTab(active, setActive, openChat, chatTarget, openMoments, momentAuthor, () => { setMomentAuthor(null); }), [active, setActive, openChat, chatTarget, openMoments, momentAuthor]);
    const noSearchResults = !searchLoading
        && searchResults.sessions.length === 0
        && searchResults.hits.length === 0
        && searchResults.contacts.length === 0
        && searchResults.moments.length === 0
        && searchResults.favorites.length === 0
        && searchResults.files.length === 0
        && searchResults.records.length === 0;
    return (_jsxs("div", { className: css.panel, children: [_jsxs("div", { className: css.topbar, children: [_jsxs("div", { className: css.topbarLeft, children: [_jsx("span", { className: css.badge, children: "\u79C1\u4EBA\u5FAE\u4FE1" }), _jsx("h2", { className: css.topbarTitle, children: "\u672C\u5730\u5FAE\u4FE1\u6570\u636E\u7BA1\u7406" }), _jsx("span", { className: css.topbarSub, children: "\u672C\u673A\u89E3\u5BC6\u5E93 \u00B7 \u7EDF\u8BA1\u5206\u6790 \u00B7 \u53EF\u9009 AI \u95EE\u7B54" })] }), _jsxs("div", { className: css.topbarRight, children: [_jsxs("div", { className: css.topbarSearch, children: [_jsx("span", { className: css.searchIcon, children: "\uD83D\uDD0D" }), _jsx("input", { ref: searchInputRef, className: css.searchInput, placeholder: "\u5168\u5C40\u641C\u7D22\uFF1A\u4F1A\u8BDD / \u6D88\u606F / \u8054\u7CFB\u4EBA / \u670B\u53CB\u5708 / \u6536\u85CF / \u6587\u4EF6 / \u8BB0\u5F55\uFF08Ctrl+K\uFF09", value: searchQuery, onChange: (e) => { setSearchQuery(e.target.value); setSearchOpen(true); }, onFocus: () => { setSearchOpen(true); }, "aria-label": "\u5168\u5C40\u641C\u7D22\u5FAE\u4FE1\u6570\u636E" }), searchOpen && searchQuery.trim() !== '' && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchOverlay, onClick: () => { setSearchOpen(false); } }), _jsxs("div", { className: css.searchDropdown, children: [searchLoading && _jsx("div", { className: css.searchEmpty, children: "\u641C\u7D22\u4E2D\u2026" }), noSearchResults && (_jsx("div", { className: css.searchEmpty, children: "\u672A\u627E\u5230\u76F8\u5173\u7ED3\u679C" })), searchResults.sessions.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u4F1A\u8BDD" }), searchResults.sessions.map(sec => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); openChat(sec.username); }, children: [_jsx("span", { className: css.searchName, children: sec.displayName || sec.username }), _jsx("span", { className: css.searchMeta, children: sec.summary })] }, sec.username)))] })), searchResults.hits.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u6D88\u606F" }), searchResults.hits.map((h, i) => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); openChat(h.username, h.local_id); }, children: [_jsx("span", { className: css.searchName, children: h.name }), _jsx("span", { className: css.searchMeta, children: h.snippet })] }, `${h.username}:${h.local_id}:${i}`)))] })), searchResults.contacts.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u8054\u7CFB\u4EBA" }), searchResults.contacts.map((c, i) => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); if (c.category === 'contact' || c.category === 'group')
                                                                    openChat(c.username);
                                                                else
                                                                    setActive('contacts'); }, children: [_jsx("span", { className: css.searchName, children: c.name }), _jsx("span", { className: css.searchMeta, children: c.category === 'group' ? '群聊' : c.category === 'official' ? '公众号' : '联系人' })] }, `c:${c.username}:${i}`)))] })), searchResults.moments.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u670B\u53CB\u5708" }), searchResults.moments.map((m, i) => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); openMoments(m.username); }, children: [_jsx("span", { className: css.searchName, children: m.name }), _jsx("span", { className: css.searchMeta, children: m.snippet })] }, `m:${m.username}:${i}`)))] })), searchResults.favorites.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u6536\u85CF" }), searchResults.favorites.map((f, i) => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); setActive('favorites'); }, children: [_jsxs("span", { className: css.searchName, children: ["\u6536\u85CF #", f.id] }), _jsx("span", { className: css.searchMeta, children: f.snippet })] }, `f:${f.id}:${i}`)))] })), searchResults.files.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u6587\u4EF6" }), searchResults.files.map((f, i) => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); setActive('files'); }, children: [_jsx("span", { className: css.searchName, children: f.fileName }), _jsx("span", { className: css.searchMeta, children: f.size > 0 ? `${(f.size / 1024).toFixed(1)} KB` : f.md5 })] }, `file:${f.fileName}:${i}`)))] })), searchResults.records.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.searchGroup, children: "\u8BB0\u5F55" }), searchResults.records.map((r, i) => (_jsxs("button", { type: "button", className: css.searchRow, onClick: () => { setSearchOpen(false); setActive('records'); }, children: [_jsx("span", { className: css.searchName, children: r.name }), _jsx("span", { className: css.searchMeta, children: r.kind === 'transfers' ? '转账' : '红包' })] }, `r:${r.kind}:${r.session}:${i}`)))] }))] })] }))] }), _jsx(Tooltip, { content: "\u7528\u672C\u673A\u804A\u5929\u8BB0\u5F55\u63D0\u95EE", children: _jsx("button", { type: "button", className: css.topbarQuick, onClick: () => { setChatTarget(null); setMomentAuthor(null); setActive('ask'); }, children: "\u2728 AI \u95EE\u7B54" }) }), _jsx(Tooltip, { content: "\u67E5\u770B\u6570\u636E\u5065\u5EB7\u4E0E\u7D22\u5F15\u72B6\u6001", children: _jsx("button", { type: "button", className: css.topbarQuick, onClick: () => { setChatTarget(null); setMomentAuthor(null); setActive('health'); }, children: "\uD83E\uDE7A \u6570\u636E\u5065\u5EB7" }) }), _jsx(Tooltip, { content: "\u89E3\u5BC6\u6570\u636E\u5E93\u72B6\u6001", children: _jsx("button", { type: "button", className: css.dbStatusBtn, onClick: () => { if (!dbStatusOpen && dbStatusLines.length === 0)
                                        void refreshDbStatus(); setDbStatusOpen(v => !v); }, children: dbStatusLoading ? '检查中…' : 'DB 状态' }) }), _jsx("span", { className: css.apiTag, "data-status": apiStatus, children: apiStatus === 'online' ? '● 本地数据就绪' : apiStatus === 'offline' ? '○ 本地数据不可用' : '◌ 检测中...' }), _jsx(Tooltip, { content: "\u5173\u95ED\u79C1\u4EBA\u5FAE\u4FE1\uFF0C\u8FD4\u56DE\u666E\u901A\u4F1A\u8BDD", children: _jsx("button", { type: "button", className: css.topbarClose, "aria-label": "\u5173\u95ED\u79C1\u4EBA\u5FAE\u4FE1", onClick: () => { closeWechat(); }, children: "\u2715" }) })] })] }), _jsxs("div", { className: css.body, children: [_jsx("aside", { className: css.sidebar, children: _jsx("nav", { className: css.nav, children: NAV_GROUPS.map(g => (_jsxs("div", { className: css.navGroup, children: [_jsx("div", { className: css.navGroupLabel, children: g.label }), g.items.filter(it => !it.hidden).map(it => (_jsxs("button", { type: "button", className: css.navItem, "data-active": active === it.tab || undefined, onClick: () => { setChatTarget(null); setMomentAuthor(null); setActive(it.tab); }, title: it.label, children: [_jsx("svg", { className: css.navIcon, viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("g", { dangerouslySetInnerHTML: { __html: it.icon } }) }), _jsx("span", { className: css.navLabel, children: it.label })] }, it.tab)))] }, g.label))) }) }), _jsx("main", { className: css.content, children: _jsx(Suspense, { fallback: _jsx("div", { style: { padding: 40, textAlign: 'center', color: 'var(--wc-muted)' }, children: "\u6B63\u5728\u52A0\u8F7D\u9762\u677F\u2026" }), children: activePanel }) })] }), _jsx(Drawer, { open: dbStatusOpen, onClose: () => { setDbStatusOpen(false); }, title: "\u89E3\u5BC6\u6570\u636E\u5E93\u72B6\u6001", footer: (_jsx("button", { type: "button", className: css.dbStatusRefresh, onClick: () => { void refreshDbStatus(); }, children: "\u5237\u65B0" })), children: dbStatusLoading && dbStatusLines.length === 0 ? (_jsx("div", { className: css.dbStatusEmpty, children: "\u6B63\u5728\u68C0\u67E5\u2026" })) : dbStatusLines.length === 0 ? (_jsx("div", { className: css.dbStatusEmpty, children: "\u6682\u65E0\u72B6\u6001\u6570\u636E" })) : (dbStatusLines.map(line => _jsx("p", { className: css.dbStatusLine, children: line }, line))) })] }));
}
//# sourceMappingURL=WechatDataPanel.js.map