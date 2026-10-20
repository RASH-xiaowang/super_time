/** One image media entry parsed from the XML (CDN URLs stay unresolved). */
export interface MomentMedia {
    thumb: string;
    url: string;
    key: string;
    md5: string;
    /**
     * 媒体标签上的 `token`（`<url token="…">`）。
     *
     * 为什么必须带着：2026-10-08 真机实测，CDN 地址只有 `?token=…` 仍是 400，
     * **必须 `?token=…&idx=1`** 且尺寸段为 `/0`、协议为 https 才返回 200（见 `sns-cdn-url.ts`）。
     */
    token?: string;
    /** Media <id> (cache-key input, together with timelineId). */
    id?: string;
    /** Timeline <id> (SnsDataItem/TimelineObject id). */
    timelineId?: string;
}
/** One video media entry parsed from the XML. */
export interface MomentVideo {
    url: string;
    thumb: string;
    key: string;
    md5: string;
    duration: number;
    /** Media <id> (cache-key input, together with timelineId). */
    id?: string;
    /** Timeline <id> (SnsDataItem/TimelineObject id). */
    timelineId?: string;
}
/** One like entry. */
export interface MomentLike {
    username: string;
    nickname: string;
}
/** One comment entry. */
export interface MomentComment {
    username: string;
    nickname: string;
    to_username: string;
    to_nickname: string;
    content: string;
    ts: number;
    /**
     * Comment-attached image (`<imageinfo>` 里的第一张)。
     *
     * ⚠️ `token` 与 `seed` 是**取到图的前提**，不是可选装饰（2026-10-09 修）：
     * 实测评论图的裸 `<url>`（不带 `token`/`idx=1`）**5/5 全部 HTTP 400、0 字节**，
     * 而经 `snsCdnUrl` 补上 `?token=…&idx=1` 后 **5/5 HTTP 200**（`x-enc=1`，密文）。
     * 之前这里只解析 `url`/`thumb`/`md5`/`media_id`，渲染层拿裸地址去要图必然落空。
     */
    image?: {
        thumb?: string;
        url?: string;
        md5?: string;
        mediaId?: string;
        /** `<token>`：CDN 校验标签。实测缺它就是 400。 */
        token?: string;
        /** `<key>`：WxIsaac64 解密种子。缺它拿到的是密文。 */
        seed?: string;
    };
}
/** One moments entry (mirror Rust MomentEntry, without CDN-dependent fields). */
export interface MomentEntry {
    tid: string;
    username: string;
    /** **显示名**（备注 → 昵称 → ID 逐级回退），不是发帖人的微信 ID —— 别拿它去 join 会话（P3-6 实测澄清）。 */
    author: string;
    text: string;
    ts: number;
    time: string;
    media_count: number;
    media_desc: string;
    images: MomentMedia[];
    videos: MomentVideo[];
    location: string;
    link_title: string;
    link_url: string;
    /** ContentObject <type>: 3=公众号文章链接, 28=视频号, 1=普通动态. */
    contentType?: number;
    /** 公众号/来源显示名 (<sourceNickName>). */
    sourceNickName?: string;
    /** 公众号 username (<publicUserName>, gh_xxx). */
    publicUserName?: string;
    /** 地理信息（朋友圈 XML 的 location 属主；属性与常见顺序相反，已在解析处修正）。 */
    city?: string;
    country?: string;
    lat?: number;
    lng?: number;
    is_self: boolean;
    likes: MomentLike[];
    comments: MomentComment[];
}
/** Parse one moments content XML (mirror parse_sns_xml). */
export declare function parseSnsXml(xml: string): {
    text: string;
    createTime: number;
    mediaCount: number;
    mediaDesc: string;
    images: MomentMedia[];
    videos: MomentVideo[];
    location: string;
    /** 位置的城市名（`<location city="南宁市">`），本机 490 条有值。 */
    city: string;
    /** 国家名（`<location country="中国">`）。 */
    country: string;
    /**
     * 真实纬度/经度（已**修正**）。
     *
     * ⚠️ 微信在朋友圈 XML 里把这两个属性**写反了**：`<location latitude="108.249237"
     * longitude="22.8694096">` 对应的是南宁（真实为 22.87°N / 108.25°E）。
     * 本机 490 条里 **485 条 latitude > 90**（真实纬度不可能超过 90），
     * 而 longitude 侧的值都落在合理范围 —— 所以这里按「纬度=longitude 属性、经度=latitude 属性」输出，
     * 下游拿到的一定是能直接画在地图上的值。
     */
    lat: number;
    lng: number;
    linkTitle: string;
    linkUrl: string;
    contentType: number;
    sourceNickName: string;
    publicUserName: string;
    nickname: string;
};
/**
 * Parse likes + comments embedded in the moments XML LocalExtraInfo.
 * <comment_user_list><user_comment>…</user_comment>…; type 1 = like, type 2 = comment.
 * Reply comments reference ref_comment_id, resolved to the target comment author.
 */
export declare function parseSnsLikesComments(xml: string): {
    likes: MomentLike[];
    comments: MomentComment[];
};
/**
 * 把线上表同步进归档库（只解析 `content_hash` 变了的行）。
 *
 * 节流 1.5s：分页 `load` / 增量刷新会在同一秒连调多次，全表 `SELECT` 没必要重复；
 * 但**新动态**仍在下一次 `getMoments`（≤1.5s 后）进来，不会像定时器那样等 30s。
 * @param decryptedDir - 解密数据根。
 * @param force - 跳过 1.5s 节流（测试/需要立即合并时）。
 * @returns 本次解析并写入的条数（0 = 没有变化/无线上表）。
 */
export declare function ensureMomentsArchiveFresh(decryptedDir: string, force?: boolean): number;
/**
 * 读一页朋友圈（归档优先；归档不可用时回退线上表）。
 * @param decryptedDir - decrypted data root.
 * @param offset - page offset.
 * @param limit - page size.
 * @param authorUsername - optional author filter.
 * @returns the moments snapshot.
 */
export declare function queryMoments(decryptedDir: string, offset?: number, limit?: number, 
/** 按发帖人过滤，传的是会话微信 ID —— 正名见 `WechatSession.username`（P3-6）。 */
authorUsername?: string, selfUsername?: string): {
    moments: MomentEntry[];
    total: number;
};
/**
 * Author-activity counts across the FULL moments archive (deleted posts included),
 * mapped to display names, ranked by count descending.
 * @param decryptedDir - decrypted data root.
 * @returns author name + moment count, highest first.
 */
export declare function queryMomentsAuthors(decryptedDir: string): Array<{
    name: string;
    count: number;
}>;
