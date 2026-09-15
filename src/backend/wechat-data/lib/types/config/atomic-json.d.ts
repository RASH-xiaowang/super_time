/**
 * JSON 落盘的原子写 + 「解析不了的原文件先留痕」。
 *
 * 为什么把它单独放成一层（M24）：这份能力被配置层（`config.json` / `secrets.json`）与
 * 上层共用；`keys/**` 也需要待在它上面而不能反向依赖 `query/**`，所以它必须在依赖图的
 * 最底下 —— 本文件不 import 包内任何模块。
 */
/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 writeFileSync 到目标路径时，写一半被杀进程/磁盘满会留下**截断的 JSON**；
 * 而 config.json 里有数据根路径与密钥字段，读到截断内容会静默回落默认值
 * （用户看到的是「配置莫名丢了」），且下一次保存就把残缺内容覆盖掉。
 * 宿主层 `src/backend/wechat-paths.js` 有一份等价实现（那边是 CJS，无法共享）。
 * @param target - 目标文件绝对路径。
 * @param text - 要写入的文本。
 */
export declare function writeFileAtomic(target: string, text: string): void;
/**
 * 覆盖前先保住「解析不了的原文件」（改名成 `.corrupt-<时间戳>`）并告警。
 * 否则损坏文件会被默认值+补丁无声覆盖，事后无从追查。
 * @param target - 目标文件绝对路径。
 */
export declare function preserveIfUnparseable(target: string): void;
