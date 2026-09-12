/**
 * 社交图谱数据模型(移植自 st_control wechat/graph/graphModel.ts 设计)
 * GraphSnapshot → 节点/边。特性:饱和度指数半径、加权标签传播社区检测、
 * 亲密度拉力(dist/strength 随消息量指数衰减)、以「我」为枢纽。
 */
export interface GNode {
    id: string;
    label: string;
    kind: 'person' | 'group' | 'self';
    /** 公众号(gh_ 前缀)标记:详情/悬停显示「公众号」,「仅显示好友」时排除 */
    isOfficial?: boolean;
    /** 消息量(亲密度代理);好友至少 100、非好友 80,叠加消息量 */
    weight: number;
    radius: number;
    /** 社区分组(-1=未分组中性灰;>=0 用 COMMUNITY_COLORS 取色) */
    community: number;
    /** 亲密度拉力:消息量越高离「我」越近(people 模式) */
    intimacy?: number;
    /** 好友/群友区分(悬停详情) */
    isFriend?: boolean;
    /** 群成员数/共同成员数(群节点详情) */
    sharedCount?: number;
    /** 共同群 code 列表(详情展示共同群名) */
    groupCodes?: string[];
    /** 知识库 stub:无对应文档的 [[目标]] 节点(虚线/未解析) */
    stub?: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx: number | null;
    fy: number | null;
}
export interface GEdge {
    source: string;
    target: string;
    weight: number;
    dist: number;
    /** 可选边强度(「我」的枢纽边随亲密度变化;普通边默认 1/min(度)) */
    strength?: number;
    /** intimacy=我↔好友(消息量);common=好友↔好友(共同群数)。 */
    kind: 'intimacy' | 'common';
}
export interface BuiltGraph {
    nodes: GNode[];
    edges: GEdge[];
    /** 社区数量(0=未分组全部) */
    communityCount: number;
}
export interface GraphSettings {
    mode: 'people' | 'groups';
    nodeLimit: number;
    minCommon: number;
    friendsOnly: boolean;
    nodeScale: number;
    /** 外观 */
    labelOpacity: number;
    edgeWidth: number;
    showArrows: boolean;
    showLabels: boolean;
    showGrid: boolean;
    /** 节点模糊强度(px,0=关闭):对全部节点(头像/名字/圆点)做高斯模糊,连线保持清晰 */
    blurNodes: number;
    /** 深度过滤:0=全部;>0=围绕选中节点的 hop 局部图 */
    depth: number;
    /** 力度 */
    forceCentripetal: number;
    forceRepulsion: number;
    forceAttraction: number;
    forceEdgeLength: number;
    /** 节点间距倍率:碰撞/硬分离/弹簧下限的公共间距系数(1=默认舒适间距) */
    nodeGap: number;
    /** 圈子分离度:不同社区节点对之间的额外排斥(圈与圈之间有留白) */
    communitySeparation: number;
    /** 锁定布局:拖动节点不带动邻居,参数变化不自动重排 */
    lockLayout: boolean;
}
export declare const DEFAULT_GRAPH_SETTINGS: GraphSettings;
/** 「我」节点 id(与 host 一致) */
export declare const SELF_ID = "self";
/** 社区色盘(10 色,参考 st_control COMMUNITY_COLORS) */
export declare const COMMUNITY_COLORS: string[];
/** 社区色:未分组(-1)→ 中性灰 */
export declare function communityColor(community: number): string;
/**
 * 加权 Louvain 社区检测(确定性贪心):节点反复评估迁入邻居社区的
 * 模块度增益,只接受正增益移动。相比标签传播,「我」的枢纽边不再把
 * 所有人吸进同一个社区——共同群结构能拆出真正的社交圈子。
 * 孤立节点与成员数 <3 的社区标 -1(中性灰,与晕影成员数阈值一致)。
 */
export declare function detectCommunities(nodes: GNode[], edges: GEdge[]): number;
/** GraphSnapshot → 筛选后的图(people/groups 两模式;社区检测;亲密度拉力)。 */
export declare function buildGraph(env: {
    nodes: Array<{
        id: string;
        label: string;
        kind: string;
        is_friend?: boolean;
        msg_count?: number;
        group_count?: number;
        member_count?: number;
        shared_count?: number;
        group_codes?: string[];
        shared_members?: Array<{
            username: string;
            name: string;
            is_friend: boolean;
            msg_count: number;
        }>;
    }>;
    edges: Array<{
        source: string;
        target: string;
        weight: number;
    }>;
} | null, s: GraphSettings): BuiltGraph;
/** 节点邻居集合(悬停高亮用)。 */
export declare function neighboursOf(graph: BuiltGraph, id: string): Set<string>;
/** 局部子图:围绕 focusId 的 depth 跳邻域(深度过滤)。 */
export declare function localGraph(graph: BuiltGraph, focusId: string, depth: number): BuiltGraph;
/** 圈子概览:按成员数降序分组(self 不参与、community < 0 排除)。 */
export declare function groupCommunities(graph: BuiltGraph): Array<{
    id: number;
    members: GNode[];
}>;
/** 与指定节点相连的边(按权重降序,含对端节点解析;默认取前 12)。 */
export declare function connectedEdgesOf(graph: BuiltGraph, nodeId: string, limit?: number): Array<{
    edge: GEdge;
    other: GNode | undefined;
}>;
/** 共同群名(详情展示,群名缺失时回退 code)。 */
export declare function sharedGroupNames(n: GNode, groupNames: Record<string, string> | undefined, limit?: number): string[];
/** 按权重降序的节点排名(等级细节标签预算用):高权重节点优先显示标签。 */
export declare function rankNodes(graph: BuiltGraph): Map<string, number>;
/** 节点 id → 社区(社区聚焦/淡出时快速查表)。 */
export declare function communityOf(graph: BuiltGraph): Map<string, number>;
//# sourceMappingURL=graph-model.d.ts.map