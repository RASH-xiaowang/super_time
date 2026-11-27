/**
 * 人物性格：把一位好友的图片、聊天和朋友圈送到当前配置的模型，写一份四段都在的速写。
 *
 * 推理模型会先消耗输出额度写思考。额度太小（曾经是 700）时正文是空的，界面就只剩
 * 「模型没有返回文字」。这里把额度留到 8192，思考有内容但正文为空时再整理一次，
 * 四段缺任意一段或在上限处截断时再补写一次。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PortraitPersonalityResult } from '../types.ts';
export interface PortraitPersonalityDeps {
    decryptedDir: string;
    decodedDir: string;
    selfUsername: string;
    ctx: Context;
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    op: (category: 'task', action: string, status: 'ok' | 'fail', target: string, detail: string) => void;
}
/** 生成一位好友的性格速写。未要求重跑时，先返回本机存档。材料不足或没配模型时不调用模型。 */
export declare function analyzePortraitPersonality(deps: PortraitPersonalityDeps, username: string, refresh?: boolean, cacheOnly?: boolean): Promise<PortraitPersonalityResult>;
