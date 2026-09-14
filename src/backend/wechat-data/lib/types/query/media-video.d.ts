/**
 * Resolve one video message: MD5 from packed_info_data, then the cover +
 * the video body from wherever they actually live.
 *
 * 封面与实体都在**真实微信目录**里，不在解密快照中：
 *   <base>/msg/video/<YYYY-MM>/<md5>_thumb.jpg  ← 封面（明文 JPG，直接可读）
 *   <base>/msg/video/<YYYY-MM>/<md5>.mp4        ← 实体（只有本机播放/下载过才有）
 * 只查 decoded_images/<username>/<md5> 是找不到的 —— 实测本机 6771 个封面里
 * 绝大多数都不在解码缓存里，于是每个视频消息都退化成「不在本地快照」的纯文本。
 *
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded image cache root.
 * @param username - conversation username.
 * @param localId - message local id.
 * @param wechatBaseDir - raw WeChat data root (…/xwechat_files/<wxid>_<hash>)，用来定位 msg/video。
 * @returns cover data URL (jpg) when available, plus the on-disk video path.
 */
export declare function resolveVideoInfo(decryptedDir: string, decodedDir: string, username: string, localId: number, wechatBaseDir?: string): {
    available: boolean;
    md5?: string;
    coverUrl?: string;
    videoPath?: string;
    error?: string;
};
