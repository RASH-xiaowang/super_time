/** One image media entry parsed from the XML (CDN URLs stay unresolved). */
export interface MomentMedia {
    thumb: string;
    url: string;
    key: string;
    md5: string;
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
    /** Comment-attached image (imagelist first image). */
    image?: {
        thumb?: string;
        url?: string;
        md5?: string;
        mediaId?: string;
    };
}
/** One moments entry (mirror Rust MomentEntry, without CDN-dependent fields). */
export interface MomentEntry {
    tid: string;
    username: string;
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
 * Read moments page (XML parsed; likes/comments resolved from SnsMessage_tmp3).
 * @param decryptedDir - decrypted data root.
 * @param offset - page offset.
 * @param limit - page size.
 * @param authorUsername - optional author filter.
 * @returns the moments snapshot.
 */
export declare function queryMoments(decryptedDir: string, offset?: number, limit?: number, authorUsername?: string, selfUsername?: string): {
    moments: MomentEntry[];
    total: number;
};
/**
 * Author-activity counts across the FULL moments table (SQL GROUP BY, no XML
 * parse), mapped to display names, ranked by count descending.
 * @param decryptedDir - decrypted data root.
 * @returns author name + moment count, highest first.
 */
export declare function queryMomentsAuthors(decryptedDir: string): Array<{
    name: string;
    count: number;
}>;
//# sourceMappingURL=moments.d.ts.map