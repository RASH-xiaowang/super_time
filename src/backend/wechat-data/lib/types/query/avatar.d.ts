/**
 * Resolve a user avatar.
 * Priority: head_image.db by username -> contact URL (temp cache data URL first) ->
 * 远端 https URL -> contact matched by nick_name（同样顺序）-> none.
 *
 * 第 41 轮改动：本地实在没有时**返回 https 远端 URL**（此前直接返回 none，
 * 连 URL 都丢掉）。实测本地覆盖只有 17.4%（head_image.db 356 行 + temp 缓存 28 个），
 * 而 79.2% 的联系人有可用的 https 头像 URL；前端 6 处调用点**早已**写好
 * `kind === 'url'` 分支（只是后端从不返回）。
 * @param decryptedDir - decrypted data root.
 * @param username - contact or chatroom username.
 * @param wechatBaseDir - raw WeChat install root (temp/head_image cache).
 * @param nickname - optional display name for contact-by-nickname fallback.
 * @returns kind + data URL / remote URL.
 */
export declare function resolveAvatar(decryptedDir: string, username: string, wechatBaseDir?: string, nickname?: string): {
    kind: string;
    data?: string;
    url?: string;
};
/**
 * 批量读取头像:head_image.db 优先,未命中再用 contact 表的头像 URL 兜底。
 *
 * 三级取值来源(优先级从高到低):
 *   ① `head_image.db` 的 image_buffer → data URL(纯本地,不联网)
 *   ② `temp/head_image` 缓存文件(文件名 = md5(头像 URL))→ data URL(同上)
 *   ③ contact 表的 **https** URL(仅 `allowRemote` 时返回)
 *
 * 为什么必须有后两级:图谱面板一次要 250 个头像,而 `head_image.db` 只覆盖本机收过的
 * 那些 —— 真机实测「好友图」上 240 个节点只命中 131 个,另外 109 个只能画成
 * 「社区色 + 首字」,看起来就是「有些节点没有头像」。contact 表里 96% 的人有头像 URL,
 * 其中 80% 是 https（http 连后端图片代理都不取 —— `fetchRemoteImage` 明确只放行 https，所以不返回）。
 *
 * 第 ③ 级交出的只是**地址**，取回动作在渲染层的 api 层完成（M23）：`apiGetAvatarsLocal` 把
 * 非本机的那几条交给后端 `query/remote-image.ts` 代取成 data URL，界面拿到的只剩能直接画的地址。
 * 于是「自动获取原图（CDN）」与「禁止出网」真的管得到头像 —— 这一类此前由 `<img>` 直连，
 * 两个开关都拦不到它。图谱把它画进 canvas 再导出 PNG 时拿到的已是 data URL，
 * 不存在跨域污染（远程地址时代要靠 `crossOrigin='anonymous'` 才不会让 `toDataURL()` 抛 SecurityError）。
 *
 * @param decryptedDir - 解密数据根目录。
 * @param usernames - 需要头像的用户名。
 * @param opts - `wechatBaseDir`(找 temp 缓存)与 `allowRemote`(是否放行远端 URL;
 *   调用方在用户开了「出站拦截」时传 false)。
 * @returns username → data URL 或 https URL（远程那一级由渲染层再换成 data URL）；未命中的不出现在结果中。
 */
export declare function resolveAvatarsLocal(decryptedDir: string, usernames: string[], opts?: {
    wechatBaseDir?: string | undefined;
    allowRemote?: boolean;
}): Record<string, string>;
