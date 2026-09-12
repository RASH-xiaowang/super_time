interface RainWindowProps {
    className?: string | undefined;
    label?: string;
    /** 是否播放动画；false 时暂停 rAF（窗口隐藏时省电）。 */
    active?: boolean;
}
export declare function RainWindow({ className, label, active }: RainWindowProps): React.JSX.Element;
export {};
//# sourceMappingURL=rain-window.d.ts.map