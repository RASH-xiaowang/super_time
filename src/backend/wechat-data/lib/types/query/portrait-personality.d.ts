/**
 * 从一位好友的图片、聊天和朋友圈里抽出可引用的现象。
 *
 * 这里只整理材料，不调用模型。三类都太少时调用方应直接说明看不出来。
 */
import type { MomentItem, WechatMessage } from '../types.ts';
/** 性格速写必须写完的板块。缺任何一块都视为没写全。 */
export declare const PORTRAIT_SECTIONS: readonly ["这个人", "说话方式", "在意什么", "和人相处", "生活画面", "言行是否一致", "性格观察", "还不能确定"];
/** 性格观察里必须点名的五个方向。只写标题、不写这五项，也算没写完。 */
export declare const PORTRAIT_TRAITS: readonly ["开放", "做事", "外向", "待人", "情绪"];
export interface PersonalityMomentImageRef {
    md5: string;
    timelineId?: string;
    mediaId?: string;
}
export interface PersonalityMaterial {
    peer: string[];
    self: string[];
    moments: string[];
    /** 这次扫过的样本里，对方发出的图片条数。 */
    images: number;
    /** 准备解码并送给模型的对方聊天图片。 */
    imageLocalIds: number[];
    /** 准备解码并送给模型的朋友圈图片。 */
    momentImageRefs: PersonalityMomentImageRef[];
    /** 全量与本次读入量。提示词用它说明覆盖范围，避免把一小段样本说成全部。 */
    coverage?: {
        messageTotal: number;
        momentTotal: number;
        imageTotal: number;
        scannedMessages: number;
        scannedMoments: number;
    };
}
/** 从已经取出的消息和朋友圈里挑出适合送去推测的句子和图片现象。 */
export declare function personalityMaterial(messages: readonly WechatMessage[], moments: readonly MomentItem[]): PersonalityMaterial;
/** 四段标题后是否各有正文。只出现标题不算写完。五项观察缺名字也算性格观察没写完。 */
export declare function missingPortraitSections(text: string): string[];
/** 从对方原话里数出可核对的语言现象，供模型引用，不在这里打分。 */
export declare function personalityLanguageCues(lines: readonly string[]): {
    lines: number;
    avgChars: number;
    questions: number;
    exclaims: number;
    together: number;
    strain: number;
};
export declare function portraitNeedsContinuation(text: string, finish: string): boolean;
/** 把补写接在已有正文后面。补写为空，或正文里已经有这段，就保持原稿。 */
export declare function mergePortraitText(draft: string, extra: string): string;
/** 读取这个人的一对一聊天和朋友圈。从最近往前翻几页，并记下全量，避免只看最后几句。 */
export declare function loadPersonalityMaterial(decryptedDir: string, username: string, selfUsername: string): PersonalityMaterial;
/** 图片、聊天、朋友圈三类里要有足够现象，才值得推测性格。 */
export declare function personalityMaterialEnough(material: PersonalityMaterial): boolean;
