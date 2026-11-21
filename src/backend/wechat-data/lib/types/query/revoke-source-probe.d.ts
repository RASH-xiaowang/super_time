/** 源库某行的**当前状态**——判定「归档里那行到底是不是撤回原文」的唯一依据。 */
export type SourceRowState = 
/** 源库已没有这一行（被删除）⇒ 我们存下的就是它。 */
'deleted'
/** 源库这一行已变成撤回提示（微信**就地改写**）⇒ 我们存下的就是原文。 */
 | 'rewritten'
/** 源库这一行还是原样 ⇒ 它不是被撤回的那条，只是"提示前一条"。 */
 | 'intact'
/** 分片/表读不到（离线、权限）⇒ 无法判定。 */
 | 'unknown';
/** `talker\u0000rowKey` → 状态。用分隔符避免 `Msg_a` 与 `Msg_a1` 撞键。 */
export declare function stateKey(talker: string, k: number): string;
/** 一条源库撤回提示：提示正文 + 时间。 */
export interface SourceTip {
    text: string;
    /** 提示行的 `create_time`（秒）。 */
    ct: number;
}
/** talker → rowKey → 提示。 */
export type SourceTipMap = Map<string, Map<number, SourceTip>>;
/**
 * 扫出**当前**所有撤回提示行：`talker → rowKey → {text, ct}`。
 *
 * 只读分片、不写；每个分片按 `withDb` 开一次连接（遵守连接纪律）。
 * 结果按目录签名缓存 —— 分页翻页时命中缓存，只有微信真的写入新消息才重扫。
 *
 * @param decryptedDir - 解密数据根。
 * @returns 提示行集合；目录不存在或全部读不动时为空 Map。
 */
export declare function scanSourceTips(decryptedDir: string): SourceTipMap;
/**
 * 查一批行的**当前状态**（点查，通常几百行）。
 *
 * 按分片分组，每个文件只开一次连接。
 * @param decryptedDir - 解密数据根。
 * @param wanted - talker → 需要校验的 row_key。
 * @returns `stateKey → 状态`；读不到的分片保持 `unknown`（调用方据此降级为"推定"）。
 */
export declare function probeRowStates(decryptedDir: string, wanted: ReadonlyMap<string, ReadonlySet<number>>): Map<string, SourceRowState>;
/** 仅供测试：清掉模块级缓存（不同用例用不同临时目录时必须调）。 */
export declare function resetSourceProbeCache(): void;
