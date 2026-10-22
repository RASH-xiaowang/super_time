/** 当前账号展示信息。`username` 可能为空（还没配置/未解密），`name` 可能为空（回退品牌名）。 */
export interface SelfProfile {
    username: string;
    /** 备注 > 昵称 > 别名；都取不到时为空串。 */
    name: string;
    /** 微信号（alias），有就带上，供界面 tooltip 区分同名。 */
    alias?: string;
    /** 当前账号在微信资料里设置的地区（中国显示省+市）；没填时为空串并省略。 */
    region?: string;
}
/**
 * 读当前账号的昵称（备注 > 昵称 > 别名）与地区。
 * @param decryptedDir - 已解密数据根。
 * @returns `{username, name, alias?, region?}`；任何一步取不到都给空串而不是抛错。
 */
export declare function querySelfProfile(decryptedDir: string): SelfProfile;
