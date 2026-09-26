import type { GraphSnapshot } from '../types.ts';
/**
 * 备注里的「班级/批次」键：**非数字前缀 + 数字编号**（`宜州一中404陈泳达` → `宜州一中404`）。
 *
 * 规则为什么是这几个数（真机 280 条备注全量扫描，见 working/probe-remark-key.txt ①）：
 *   - **编号 ≥2 位**：`前缀≥2/编号≥2` 与 `前缀≥3/编号≥2` 结果**完全一致**（86 人 / 9 组 /
 *     1233 条潜在边），而放宽到 1 位只多出「一汽大众-7」这种**门店序号**的偶然同号
 *     （多 1 条边）—— 收益为 0、误连风险不为 0，所以取下界 2；
 *   - **编号 ≤6 位**：更长的数字串是手机号/单号（备注里真实存在，如
 *     `一汽大众-7鑫广达吴善钊19195897571`），当班级处理会造出假关系；
 *   - **前缀去标点后 ≥2 字**：挡掉纯符号前缀。
 * 未被命中的 194 条备注抽样全是「表弟_陈忠凯」「法院_梧州万秀_会计小郭」这类
 * 亲属/单位+姓名（无编号），确实不该成组 —— 说明规则没有漏掉成规模的班级型分组。
 * @param remark - 原始备注（含首尾空白也可）。
 * @returns 分组键；不构成「前缀+编号」形态、或编号位数不在区间内时返回空串。
 */
export declare function remarkClassKey(remark: string | undefined | null): string;
/**
 * Build a graph snapshot: contact/group nodes enriched for both display modes.
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (excluded from persons).
 * @returns nodes + summary (edges derived client-side from group_codes).
 */
/**
 * 关系图谱快照（节点 + 群/班级元数据）。
 *
 * 后端加签名缓存（P1-3 的第②半）：`cachedBySig` 的键由「会话库 + 通讯录库 + 消息分片目录」
 * 三处签名拼成，**没变就是 0ms**；实时同步写过这些文件后签名自然变化 ⇒ 不需要显式失效，
 * 也不会像「整体清空缓存」那样把没变的条目一起丢掉（M8 那场风暴）。
 * 前端 `apiGetGraph` 那层 30s 的 `cachedGet` 管的是「同一会话里切回来」，
 * 这一层管的是「换了进程 / 超了 30 秒 / 首次打开」—— 那正是原先必须完整等 866ms 的三种情形。
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - 当前账号（用于把自己从人物节点里剔除）。
 * @returns 图谱快照。
 */
export declare function queryGraph(decryptedDir: string, selfUsername?: string): Promise<GraphSnapshot>;
