/**
 * 社交图谱高清海报渲染(移植自 st_control graphPoster.ts 设计)
 * 目标:导出「可直接发朋友圈」的高质量海报图,包含全部数据——
 * 全量节点连线图谱 / 统计卡 / 最亲近 TOP / 圈子概览 / 图例 / 生成信息。
 * - 画幅:1:1(方图)/ 3:4(竖版长图)/ 16:9(横版)
 * - 风格:浅日(light)/ 深空(dark)/ 霓虹(neon)
 */
export type PosterRatio = '1:1' | '3:4' | '16:9';
export type PosterStyle = 'light' | 'dark' | 'neon';
export interface PosterLayout {
    width: number;
    height: number;
    /** 图谱图层在画布上的位置与尺寸(逻辑像素) */
    graphX: number;
    graphY: number;
    graphW: number;
    graphH: number;
    /** 「最亲近 TOP」区块 */
    relationsX: number;
    relationsY: number;
    relationsW: number;
    relationsH: number;
    /** 「圈子概览」区块 */
    communitiesX: number;
    communitiesY: number;
    communitiesW: number;
    communitiesH: number;
    /** 图例与生成信息 */
    legendY: number;
    footerY: number;
}
export declare function getPosterLayout(ratio: PosterRatio, communityCount?: number): PosterLayout;
export interface PosterStatItem {
    label: string;
    value: string;
}
export interface PosterRelation {
    name: string;
    msg: number;
    /** 圆形头像精灵(可选,缺失时画灰底圆) */
    sprite?: HTMLCanvasElement | null;
}
export interface PosterCommunity {
    color: string;
    count: number;
    /** 前两个成员名(用于「xx 等 N 人」) */
    names: string;
}
export interface PosterTheme {
    /** 背景渐变(从上到下) */
    bgTop: string;
    bgBottom: string;
    /** 点阵装饰 */
    dot: string;
    /** 右上光斑 */
    glow: string;
    /** 标签(小字) */
    tag: string;
    /** 标题 */
    title: string;
    /** 副标题 */
    subtitle: string;
    /** 统计卡 */
    statCardBg: string;
    statCardBorder: string;
    statLabel: string;
    statValue: string;
    /** 图谱卡片 */
    cardBorder: string;
    /** 图例/页脚 */
    legend: string;
    footer: string;
}
export declare const POSTER_THEMES: Record<PosterStyle, PosterTheme>;
export interface PosterInput {
    /** 已渲染好的图谱图层(深色底,未污染画布) */
    graphLayer: HTMLCanvasElement;
    ratio: PosterRatio;
    style: PosterStyle;
    tag: string;
    title: string;
    subtitle: string;
    stats: PosterStatItem[];
    topRelations?: PosterRelation[];
    communities?: PosterCommunity[];
    /** 节点模糊强度(px,0=关闭):最亲近头像/名字一并模糊(图谱层由调用方按强度渲染) */
    blurNodes?: number;
    legend: string;
    footer: string;
    scale?: number;
}
/** 渲染海报(返回高分辨率 canvas,未污染,可直接 toBlob/toDataURL)。 */
export declare function buildPoster(input: PosterInput): HTMLCanvasElement;
/** 海报 canvas → data URL(部分浏览器 PNG 大图内存有限,用 toBlob 后转) */
export declare function posterToDataUrl(canvas: HTMLCanvasElement, format?: 'png' | 'jpeg'): Promise<string>;
//# sourceMappingURL=graph-poster.d.ts.map