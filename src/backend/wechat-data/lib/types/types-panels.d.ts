/**
 * `types.ts` 的 panels 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-panels
 */
import type { OverviewMomentsAuthor, OverviewStorageCategory } from './types-insights.ts';
/** Annual snapshot. */
export interface AnnualSnapshot {
    years: number[];
    total_messages?: number;
}
/** Config snapshot. */
export interface ConfigSnapshot {
    db_dir?: string;
    wechat_process?: string;
    key_format?: string;
    api_enabled?: boolean;
    api_port?: number;
}
/** One privacy risk sample. */
export interface PrivacySample {
    username: string;
    name: string;
    local_id: number;
    ts: number;
    time: string;
    snippet: string;
}
/** Privacy scan snapshot: per-category counts/samples + rankings. */
export interface PrivacySnapshot {
    categories: Array<{
        key: string;
        label: string;
        count: number;
        icon: string;
        samples: PrivacySample[];
    }>;
    total_hits: number;
    involved_sessions: number;
    top_contacts: Array<{
        username: string;
        name: string;
        count: number;
    }>;
    top_groups: Array<{
        username: string;
        name: string;
        count: number;
    }>;
}
/** Graph snapshot (edges are derived client-side from group_codes). */
export interface GraphSnapshot {
    /** Current account username (self node is the literal 'self'). */
    self?: string;
    /** chatroom username -> display name (common-group tooltips). */
    group_names?: Record<string, string>;
    /**
     * 备注「班级/批次」名册（键 → 全库成员，**不受 nodeLimit / 仅显示好友影响**）。
     * 画布据此把同班级的人连成一片，并在详情里说明「全库 N 人 / 本视图 M 人」——
     * 那正是「同前缀却没有连线」最常见的原因：人被上限或好友过滤挡在图外。
     */
    remark_groups?: Array<{
        key: string;
        total: number;
        members: Array<{
            username: string;
            name: string;
            is_friend: boolean;
            msg_count: number;
        }>;
    }>;
    nodes: Array<{
        id: string;
        label: string;
        kind: string;
        is_friend?: boolean;
        msg_count?: number;
        group_count?: number;
        member_count?: number;
        shared_count?: number;
        group_codes?: string[];
        avatar_url?: string;
        /** 备注里的「班级/批次」键（`宜州一中404陈泳达` → `宜州一中404`），用户自建的组织维度。 */
        remark_group?: string;
        shared_members?: Array<{
            username: string;
            name: string;
            is_friend: boolean;
            msg_count: number;
        }>;
    }>;
    edges: Array<{
        source: string;
        target: string;
        weight: number;
    }>;
    summary?: {
        total_contacts?: number;
        total_groups?: number;
        total_messages?: number;
        contact_book_total?: number;
        contact_book_friends?: number;
        contact_book_members?: number;
        selected_contacts?: number;
        selected_groups?: number;
        top_relations?: Array<{
            username: string;
            name: string;
            msg_count: number;
        }>;
    };
}
/** The one-screen data overview snapshot. */
export interface OverviewSnapshot {
    sessions: number;
    groups: number;
    contacts: number;
    official: number;
    moments: number;
    favorites: number;
    emoticons: number;
    revoked: number;
    storage: {
        total_size: number;
        total_count: number;
        categories: OverviewStorageCategory[];
    };
    moments_authors: OverviewMomentsAuthor[];
}
/** 微信数据总览「战术分析」洞察快照（交互画像/作息/关系/内容资产/健康）。 */
export interface OverviewInsights {
    messages: {
        total: number;
        sent: number;
        received: number;
        text: number;
        image: number;
        voice: number;
        video: number;
        rich: number;
        system: number;
        revoked: number;
    };
    time: {
        activeDays: number;
        spanDays: number;
        busyHour: number;
        busyCount: number;
        hourDist: number[];
        deepNightPct: number;
        weekendPct: number;
        lastActive: string;
    };
    relations: {
        total: number;
        active: number;
        silent: number;
        groupsWithMsg: number;
        top: Array<{
            username: string;
            name: string;
            count: number;
        }>;
    };
    moments: {
        total: number;
        images: number;
        videos: number;
        likes: number;
        comments: number;
    };
    assets: {
        favorites: number;
        emoticons: number;
        files: number;
        fileBytes: number;
        mediaItems: number;
        mediaBytes: number;
    };
    health: {
        dbFiles: number;
        dbBytes: number;
        ok: boolean;
    };
    /** 近端趋势 / 90 天热度 / 新鲜度。 */
    extras?: OverviewExtras;
}
/** 微信数据总览「趋势/热度/新鲜度」扩展洞察快照。 */
export interface OverviewExtras {
    /** 近端窗口的新增与环比。 */
    trends: {
        messages7: number;
        messages30: number;
        messages60: number;
        messages7Delta: number;
        messages30Delta: number;
        activeContacts7: number;
        activeContacts30: number;
        activeGroups7: number;
        activeGroups30: number;
        storageBytes30: number;
    };
    /** 最近 90 天每日消息量（升序）。 */
    heatmap: Array<{
        d: string;
        count: number;
    }>;
    freshness: {
        dbFiles: number;
        dbBytes: number;
        walPending: boolean;
        ok: boolean;
        lastSync: string;
    };
}
/** One full-text search hit. */
export interface SearchHit {
    text: string;
    username: string;
    create_time: number;
    local_id: number;
    name: string;
    time: string;
    snippet: string;
    /** 群聊里这条消息的发送者显示名（单聊为空）。 */
    sender?: string;
    /** BM25 相关度（越大越相关；仅自建索引路径提供）。 */
    score?: number;
}
/** Search index status. */
export interface SearchIndexStatus {
    exists: boolean;
    rows: number;
    built_at: string | null;
    /** 索引结构是否为当前版本（false 时提问会自动重建）。 */
    ready: boolean;
}
/** Search snapshot (hits + index flag). */
export interface SearchSnapshot {
    hits: SearchHit[];
    total: number;
    indexed: boolean;
    /** N9：本次搜索被取消（返回的是取消前已找到的部分结果）。 */
    cancelled?: boolean;
}
/** Search index build result. */
export interface SearchBuildResult {
    status: string;
    rows?: number;
    built_at?: string;
    elapsed_ms?: number;
    message?: string;
}
/** Daily message counts for one month (day -> count). */
export interface CalendarSnapshot {
    counts: Record<string, number>;
    year: number;
    month: number;
}
/** Image decode result (base64 data URL) for one message image. */
export interface ImageDataUrlResult {
    url?: string;
    format?: string;
    /** true = 这次给的是缩略/中图那一份（本机还没有更大的）。界面据此说明「点取原图试试」。 */
    thumb?: boolean;
    error?: string;
}
/** Decrypted DB status summary lines. */
export interface DbStatusSnapshot {
    lines: string[];
    path: string;
}
/** Voice message lookup result (silk decode degrades in Node). */
export interface VoiceInfoResult {
    available: boolean;
    /** svr_id as text: the value may exceed Number.MAX_SAFE_INTEGER. */
    svrId?: string;
    length?: number;
    decodable: boolean;
    error?: string;
}
/** Video message lookup result (cover thumbnail + on-disk path + degradation). */
export interface VideoInfoResult {
    available: boolean;
    md5?: string;
    coverUrl?: string;
    /**
     * 视频实体在本机的绝对路径（`<微信数据根>/msg/video/<YYYY-MM>/<md5>.mp4`）。
     * 只有本机播放/下载过才有；有它时界面可以把文件交给系统播放器打开。
     */
    videoPath?: string;
    error?: string;
}
