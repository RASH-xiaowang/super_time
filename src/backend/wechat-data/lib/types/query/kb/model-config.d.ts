/** 三个可分别配置的角色。 */
export type KbModelRole = 'chat' | 'embed' | 'rerank';
/** 一个角色的引用串能出现的三种形状。 */
export type ModelRef = string;
/** 某个库的模型设置（三个引用 + 最后一次实体抽取时间）。 */
export interface KbModelSettings {
    kbId: number;
    chatRef: ModelRef;
    embedRef: ModelRef;
    rerankRef: ModelRef;
    /** 本库最后一次「模型抽实体」的时间（毫秒）；0 = 从未。 */
    entitiesAt: number;
    updatedAt: number;
}
/** 解析结果：最终模型名 + 它是从哪儿来的。 */
export interface ResolvedModel {
    /** 实际要用的模型名；空串 = 这个角色没配（调用方据此静默关闭能力）。 */
    model: string;
    /** 名字来自库级覆盖还是全局。 */
    source: 'inherit' | 'inline';
    /** 原始引用串（界面要把它回填到下拉框里）。 */
    ref: ModelRef;
}
/** 表名（守卫用例按名字断言，所以不写字面量在两处）。 */
export declare const KB_MODELS_TABLE = "kb_models";
/**
 * 校验一个引用串。
 *
 * 不合法的输入**不静默纠正成 `''`** —— 那会把用户刚打错的一个模型名变成「继承全局」，
 * 而界面上看起来保存成功了。这里返回 null 让写路径明确拒绝。
 * @param ref - 原始串。
 * @returns 规范化后的引用串；不合法时为 null。
 */
export declare function normalizeModelRef(ref: unknown): ModelRef | null;
/**
 * 读某个库的模型设置。
 *
 * 读失败（文件损坏 / 被占用）时返回**全继承**而不是抛错：这三个字段的默认语义就是「跟随全局」，
 * 退到默认不会让任何一次调用变得比原来更出网 —— 与隐私侧「读不到设置就按未开启处理」同一取向。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @returns 设置行（不存在时是全继承的默认值）。
 */
export declare function readKbModelSettings(decryptedDir: string, kbId: number): KbModelSettings;
/**
 * 写某个库的模型设置（部分更新：只改传进来的那几项）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param patch - 要改的字段（引用串）。非法的引用串会让整次写入被拒。
 * @returns `{ ok: true, settings }` 或 `{ ok: false, error }`。
 */
export declare function writeKbModelSettings(decryptedDir: string, kbId: number, patch: {
    chatRef?: unknown;
    embedRef?: unknown;
    rerankRef?: unknown;
}): {
    ok: true;
    settings: KbModelSettings;
} | {
    ok: false;
    error: string;
};
/**
 * 记一笔「本库最后一次模型抽实体」的时间。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param at - 时间（毫秒）。
 * @returns 是否写入成功（库还没建过设置行时也会建行）。
 */
export declare function touchKbEntitiesAt(decryptedDir: string, kbId: number, at: number): boolean;
/**
 * 把一个引用串解析成实际要用的模型名。
 *
 * `globalModel` 由调用方从宿主桥取（那里才是「实际会发出去什么」的真源）——
 * 本模块**不去读 llm.json**：设置层与凭据层各管一段，避免出现第二个「我以为的模型名」。
 * @param ref - 库级引用串。
 * @param globalModel - 全局解析出来的模型名（可为空 = 这个角色没配）。
 * @returns 解析结果。
 */
export declare function resolveModelRef(ref: ModelRef, globalModel: string): ResolvedModel;
/**
 * 所有库的「是否有任何自定义」标记，给库列表合流用。
 *
 * 只回布尔而不是整行：rail 的芯片只需要知道「继承 / N 项自定义」，
 * 而把三个引用串都塞进 `getKbs` 会让每次刷新多带一份没人用的数据。
 * @param decryptedDir - 解密数据根。
 * @returns kbId → 自定义了几个角色（0 = 全继承）。
 */
export declare function kbModelOverrideCounts(decryptedDir: string): Map<number, number>;
/**
 * 删库时清掉这一行（由 gateway 的删库级联调用）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 被删的库。
 * @returns 是否删掉了一行。
 */
export declare function kbModelsOnKbDelete(decryptedDir: string, kbId: number): boolean;
