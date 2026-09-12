import { type BuiltGraph, type GNode, type GraphSettings } from './graph-model.ts';
import { type PosterRatio, type PosterStyle } from './graph-poster.ts';
export interface GraphCanvasHandle {
    fitView: () => void;
    centerOn: (id: string) => void;
    /** 重新点燃力导向动画(播放动画按钮)。 */
    runAnimation: () => void;
    /** 清空布局位置,随机起点重新摆放(重新布局按钮)。 */
    relayout: () => void;
    /** 导出整图为 SVG 字符串。 */
    exportSvg: () => string;
    /** 导出当前视图为 PNG data URL。 */
    exportPng: (ratio: PosterRatio, style: PosterStyle) => Promise<string>;
    /** 导出朋友圈海报(头像图谱 + 排版),返回 data URL。 */
    renderPoster: (ratio: PosterRatio, style: PosterStyle, format?: 'png' | 'jpeg') => Promise<string>;
}
interface GraphCanvasProps {
    graph: BuiltGraph;
    dark?: boolean;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    settings: GraphSettings;
    /** 当前账号 wxid(「我」的本地头像查询用)。 */
    selfUsername?: string | undefined;
    /** 头像加载模式:默认 avatar(微信好友头像);none 跳过所有头像 RPC,节点渲染为纯色圆点+字母。 */
    avatarMode?: 'avatar' | 'none';
    /** 节点种类文案(悬停详情):默认按微信联系/群/公众号映射;知识库可传文档/分类。 */
    kindLabelOf?: (node: GNode) => string;
    /** 已固定节点(力导向与拖拽联动均不移动;重新布局保留位置)。 */
    pinnedIds?: ReadonlySet<string>;
    /** 切换节点固定状态(右键菜单/面板按钮)。 */
    onTogglePin?: (id: string) => void;
    /** 聚焦一个圈子:仅该社区高亮,其余淡出。null=关闭。 */
    focusCommunity?: number | null;
    /** 悬停圈子(面板悬停即时高亮)。 */
    hoverCommunity?: number | null;
    /** 打开与该用户的聊天记录(查看聊天)。 */
    onOpenChat?: ((username: string) => void) | undefined;
    /** 聚焦选中节点周围 1 跳(聚焦一圈)。 */
    onFocusNode?: ((id: string) => void) | undefined;
}
/**
 * Render the social graph canvas (screen-space, robust).
 * @param props - graph / theme / selection callbacks.
 */
export declare const GraphCanvas: import("react").ForwardRefExoticComponent<GraphCanvasProps & import("react").RefAttributes<GraphCanvasHandle>>;
export {};
//# sourceMappingURL=graph-canvas.d.ts.map