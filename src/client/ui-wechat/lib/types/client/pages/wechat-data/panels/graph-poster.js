/**
 * 社交图谱高清海报渲染(移植自 st_control graphPoster.ts 设计)
 * 目标:导出「可直接发朋友圈」的高质量海报图,包含全部数据——
 * 全量节点连线图谱 / 统计卡 / 最亲近 TOP / 圈子概览 / 图例 / 生成信息。
 * - 画幅:1:1(方图)/ 3:4(竖版长图)/ 16:9(横版)
 * - 风格:浅日(light)/ 深空(dark)/ 霓虹(neon)
 */
/** 「圈子概览」栏的列数(按比例 + 圈子数量自适应,尽量少行以容纳全部圈子)。 */
function communityColumns(ratio, count) {
    if (ratio === '3:4')
        return 2;
    if (ratio === '16:9')
        return 2;
    // 1:1 方图:最多 4 列,至少随数量走
    return Math.max(1, Math.min(count, 4));
}
export function getPosterLayout(ratio, communityCount = 0) {
    let base;
    if (ratio === '3:4') {
        base = {
            width: 1080,
            height: 1440,
            graphX: 48, graphY: 248, graphW: 984, graphH: 760,
            relationsX: 48, relationsY: 1030, relationsW: 984, relationsH: 150,
            communitiesX: 48, communitiesY: 1194, communitiesW: 984, communitiesH: 170,
            legendY: 1384,
            footerY: 1418,
        };
    }
    else if (ratio === '16:9') {
        base = {
            width: 1280,
            height: 720,
            graphX: 48, graphY: 208, graphW: 1184, graphH: 360,
            relationsX: 48, relationsY: 584, relationsW: 560, relationsH: 96,
            communitiesX: 620, communitiesY: 584, communitiesW: 612, communitiesH: 96,
            legendY: 692,
            footerY: 716,
        };
    }
    else {
        base = {
            width: 1080,
            height: 1080,
            graphX: 48, graphY: 248, graphW: 984, graphH: 530,
            relationsX: 48, relationsY: 794, relationsW: 984, relationsH: 100,
            communitiesX: 48, communitiesY: 906, communitiesW: 984, communitiesH: 96,
            legendY: 1024,
            footerY: 1056,
        };
    }
    // 无圈子时保持原布局
    if (communityCount <= 0)
        return base;
    const cols = communityColumns(ratio, communityCount);
    const rows = Math.max(1, Math.ceil(communityCount / cols));
    const headerH = 30;
    const rowH = 38;
    const needH = headerH + rows * rowH;
    const delta = Math.max(0, needH - base.communitiesH);
    if (delta === 0)
        return base;
    // 圈子概览栏需要更多空间时,向下扩展画布高度(内容优先,保证全部圈子完整可读)
    // 图谱/关系区位置不变,仅把底部社区/图例/页脚整体下移,避免重叠或留白。
    const layout = { ...base };
    layout.height = base.height + delta;
    layout.communitiesH = base.communitiesH + delta;
    layout.legendY = base.legendY + delta;
    layout.footerY = base.footerY + delta;
    return layout;
}
export const POSTER_THEMES = {
    light: {
        bgTop: '#f5f7fd', bgBottom: '#e9edf8',
        dot: 'rgba(61,107,242,0.045)',
        glow: 'rgba(7,193,96,0.10)',
        tag: '#6b7594', title: '#1b2233', subtitle: '#7a84a3',
        statCardBg: 'rgba(255,255,255,0.94)', statCardBorder: 'rgba(27,34,51,0.07)',
        statLabel: '#8a94b8', statValue: '#1b2233',
        cardBorder: 'rgba(27,34,51,0.09)',
        legend: '#8a94b8', footer: '#a6aec9',
    },
    dark: {
        bgTop: '#0c1220', bgBottom: '#141b2e',
        dot: 'rgba(96,150,230,0.06)',
        glow: 'rgba(34,170,240,0.12)',
        tag: '#5c7ba6', title: '#e8eef7', subtitle: '#8aa0c0',
        statCardBg: 'rgba(19,28,47,0.92)', statCardBorder: 'rgba(140,170,220,0.12)',
        statLabel: '#7d92b3', statValue: '#eef3fa',
        cardBorder: 'rgba(140,170,220,0.14)',
        legend: '#7d92b3', footer: '#5f7396',
    },
    neon: {
        bgTop: '#0a0618', bgBottom: '#160d30',
        dot: 'rgba(190,80,255,0.07)',
        glow: 'rgba(0,240,255,0.14)',
        tag: '#8b6cc8', title: '#f3ecff', subtitle: '#9a8acb',
        statCardBg: 'rgba(24,14,48,0.94)', statCardBorder: 'rgba(190,120,255,0.18)',
        statLabel: '#8f7bc4', statValue: '#f6f0ff',
        cardBorder: 'rgba(190,120,255,0.20)',
        legend: '#8f7bc4', footer: '#6d5a9e',
    },
};
const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}
/** 文本截断(中英文按字符计数,超长省略)。 */
function ellipsis(text, maxPx, font, ctx) {
    if (maxPx <= 0)
        return '';
    ctx.save();
    ctx.font = font;
    let t = text;
    while (t.length > 1 && ctx.measureText(t).width > maxPx)
        t = t.slice(0, -1);
    ctx.restore();
    return t.length < text.length ? t.slice(0, -1) + '…' : text;
}
/** 数字格式化:≥1 万显示 x.x万。 */
function fmtCount(n) {
    if (n >= 10000) {
        const v = n / 10000;
        return `${v >= 100 ? Math.round(v) : v.toFixed(1)}万`;
    }
    return String(n);
}
/** 渲染海报(返回高分辨率 canvas,未污染,可直接 toBlob/toDataURL)。 */
export function buildPoster(input) {
    const layout = getPosterLayout(input.ratio, input.communities?.length ?? 0);
    const th = POSTER_THEMES[input.style];
    // 尽量大:默认 7 倍(1:1 → 7560px),上限 8K
    const scale = Math.max(1, Math.min(input.scale ?? 7, 8192 / Math.max(layout.width, layout.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(layout.width * scale));
    canvas.height = Math.max(1, Math.round(layout.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('无法创建海报画布');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const W = layout.width;
    const H = layout.height;
    const pad = 48;
    // ── 背景:渐变 + 点阵装饰 + 右上光斑 ──
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, th.bgTop);
    bg.addColorStop(1, th.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = th.dot;
    for (let y = 24; y < H; y += 38) {
        for (let x = 24; x < W; x += 38) {
            ctx.beginPath();
            ctx.arc(x, y, 1.4, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    const glow = ctx.createRadialGradient(W - 110, 80, 10, W - 110, 80, 300);
    glow.addColorStop(0, th.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(W - 460, 0, 460, 460);
    // ── 顶部标签 / 标题 / 副标题 ──
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = th.tag;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(input.tag, pad, 46);
    ctx.fillStyle = th.title;
    ctx.font = `700 50px ${FONT}`;
    ctx.fillText(input.title, pad, 96);
    ctx.fillStyle = th.subtitle;
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText(input.subtitle, pad, 130);
    // ── 数据统计卡 ──
    const statsY = 154;
    const statsH = 78;
    const gap = 18;
    const statsCount = Math.max(input.stats.length, 1);
    const cardW = (W - pad * 2 - gap * (statsCount - 1)) / statsCount;
    input.stats.forEach((s, i) => {
        const x = pad + i * (cardW + gap);
        roundRect(ctx, x, statsY, cardW, statsH, 22);
        ctx.fillStyle = th.statCardBg;
        ctx.fill();
        ctx.strokeStyle = th.statCardBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillStyle = th.statLabel;
        ctx.font = `500 18px ${FONT}`;
        ctx.fillText(s.label, x + cardW / 2, statsY + 28);
        ctx.fillStyle = th.statValue;
        ctx.font = `700 34px ${FONT}`;
        ctx.fillText(s.value, x + cardW / 2, statsY + 66);
    });
    // ── 图谱卡片(白/深色卡 + 内嵌图谱层) ──
    const cardX = pad;
    const cardY = layout.graphY - 12;
    const cardWide = W - pad * 2;
    const cardHigh = layout.graphH + 24;
    roundRect(ctx, cardX, cardY, cardWide, cardHigh, 30);
    ctx.fillStyle = input.style === 'light' ? '#ffffff' : 'rgba(8,12,22,0.9)';
    ctx.fill();
    ctx.save();
    roundRect(ctx, layout.graphX, layout.graphY, layout.graphW, layout.graphH, 20);
    ctx.clip();
    // 等比 contain 绘制(不拉伸):图谱保持真实比例,多余空间露出卡片底色
    const layerAspect = input.graphLayer.width / input.graphLayer.height;
    const boxAspect = layout.graphW / layout.graphH;
    let gx = layout.graphX;
    let gy = layout.graphY;
    let gw = layout.graphW;
    let gh = layout.graphH;
    if (layerAspect > boxAspect) {
        gw = layout.graphH * layerAspect;
        gx = layout.graphX + (layout.graphW - gw) / 2;
    }
    else {
        gh = layout.graphW / layerAspect;
        gy = layout.graphY + (layout.graphH - gh) / 2;
    }
    ctx.drawImage(input.graphLayer, gx, gy, gw, gh);
    ctx.restore();
    roundRect(ctx, cardX, cardY, cardWide, cardHigh, 30);
    ctx.strokeStyle = th.cardBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // ── 「最亲近 TOP」区块 ──
    const rels = input.topRelations ?? [];
    if (rels.length > 0) {
        const bx = layout.relationsX;
        const by = layout.relationsY;
        const bw = layout.relationsW;
        const bh = layout.relationsH;
        roundRect(ctx, bx, by, bw, bh, 22);
        ctx.fillStyle = th.statCardBg;
        ctx.fill();
        ctx.strokeStyle = th.statCardBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillStyle = th.statLabel;
        ctx.font = `600 18px ${FONT}`;
        ctx.fillText('最亲近 TOP', bx + 18, by + 24);
        const n = Math.min(rels.length, 6);
        const itemW = bw / n;
        const avR = Math.max(18, Math.min(28, (bh - 62) * 0.34));
        const avY = by + 28 + avR;
        rels.slice(0, n).forEach((rel, i) => {
            const cx = bx + itemW * (i + 0.5);
            ctx.save();
            if ((input.blurNodes ?? 0) > 0)
                ctx.filter = `blur(${input.blurNodes}px)`;
            if (rel.sprite) {
                ctx.drawImage(rel.sprite, cx - avR, avY - avR, avR * 2, avR * 2);
            }
            else {
                ctx.beginPath();
                ctx.arc(cx, avY, avR, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(128,138,156,0.28)';
                ctx.fill();
            }
            ctx.textAlign = 'center';
            ctx.fillStyle = th.title;
            ctx.font = `500 14px ${FONT}`;
            ctx.fillText(ellipsis(rel.name, itemW - 10, `500 14px ${FONT}`, ctx), cx, avY + avR + 14);
            ctx.fillStyle = th.statLabel;
            ctx.font = `400 12px ${FONT}`;
            ctx.fillText(fmtCount(rel.msg), cx, avY + avR + 30);
            ctx.restore();
        });
    }
    // ── 「圈子概览」区块 ──
    const comms = input.communities ?? [];
    if (comms.length > 0) {
        const bx = layout.communitiesX;
        const by = layout.communitiesY;
        const bw = layout.communitiesW;
        const bh = layout.communitiesH;
        roundRect(ctx, bx, by, bw, bh, 22);
        ctx.fillStyle = th.statCardBg;
        ctx.fill();
        ctx.strokeStyle = th.statCardBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillStyle = th.statLabel;
        ctx.font = `600 18px ${FONT}`;
        ctx.fillText('圈子概览', bx + 18, by + 24);
        const cols = communityColumns(input.ratio, comms.length);
        const rows = Math.ceil(comms.length / cols);
        const itemW = bw / cols;
        const itemH = (bh - 30) / rows;
        comms.forEach((c, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const cx = bx + col * itemW + 18;
            const cy = by + 30 + row * itemH + itemH / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, 7, 0, Math.PI * 2);
            ctx.fillStyle = c.color;
            ctx.fill();
            ctx.fillStyle = th.title;
            ctx.font = `500 14px ${FONT}`;
            const suffix = c.count > 2 ? ' 等' : '';
            ctx.fillText(ellipsis(`${c.count} 人 · ${c.names}${suffix}`, itemW - 52, `500 14px ${FONT}`, ctx), cx + 16, cy + 4);
        });
    }
    // ── 图例与生成信息 ──
    ctx.textAlign = 'center';
    ctx.fillStyle = th.legend;
    ctx.font = `400 21px ${FONT}`;
    ctx.fillText(input.legend, W / 2, layout.legendY);
    ctx.fillStyle = th.footer;
    ctx.font = `400 19px ${FONT}`;
    ctx.fillText(input.footer, W / 2, layout.footerY);
    return canvas;
}
/** 海报 canvas → data URL(部分浏览器 PNG 大图内存有限,用 toBlob 后转) */
export function posterToDataUrl(canvas, format = 'png') {
    return new Promise((res, rej) => {
        canvas.toBlob((b) => {
            if (!b) {
                rej(new Error('海报生成失败'));
                return;
            }
            const fr = new FileReader();
            fr.onload = () => { res(fr.result); };
            fr.onerror = () => { rej(fr.error ?? new Error('读取失败')); };
            fr.readAsDataURL(b);
        }, format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? 0.95 : undefined);
    });
}
//# sourceMappingURL=graph-poster.js.map