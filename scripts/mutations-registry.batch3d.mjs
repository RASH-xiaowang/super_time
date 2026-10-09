/**
 * 变异登记 · 第四批（2026-10-09，阶段 1：评论图 + 视频封面 + CDN 密文当 src）
 *
 * 这一批全部来自同一次**先测量后动手**的修复，测量依据是两个现场探针（`SNS_LIVE=1` 跑）：
 *   · `sns-comment-image-probe.manual.spec.ts`：评论图裸 `<url>` 5/5 HTTP 400、0 字节；
 *     补 `?token=…&idx=1` 后 5/5 HTTP 200；解密后 EOI 距末尾 24 字节（与朋友圈图片同形）。
 *   · `sns-video-cover-probe.manual.spec.ts`：12 个封面**全部 < 128 KB**，只解头即完整
 *     ⇒「只解头」对封面当下是对的（不能一律改整份解），缺的是**结尾校验**与 **offline**。
 *
 * 为什么这批特别值得登记：评论图要通需要**四处同时**成立（解析 token/key、客户端类型允许、
 * 渲染层登记、批处理放行），而单点改动任何一处都**不会**让任何单测变红 —— 只有把锚点
 * 钉在这四处上逐个打掉，才能证明守卫真的在守，而不是「反正测试是绿的」。
 *
 * @module mutations-registry/batch3d
 */
export const MUTATIONS_BATCH3D = [
  // ── 评论图：解析出 token / key（缺了就必然 400）────────────────────────────────
  {
    id: "M417-comment-token-not-parsed",
    why: "解析器不取 <token> ⇒ 渲染层只能拿裸 <url>，实测 5/5 返 HTTP 400、0 字节，评论图恒显示 [图]。而本机又没有评论图文件（实测 md5 0 命中），所以这条一断就没有任何兜底。",
    file: "src/backend/wechat-data/src/query/moments.ts",
    from: "      const itok = unescapeXml(xmlTagText(ib, 'token') ?? '')",
    to: "      const itok = ''",
    spec: "src/backend/wechat-data/tests/sns-comment-image.spec.ts",
  },
  {
    id: "M418-comment-seed-not-parsed",
    why: "解析器不取 <key> ⇒ 没有解密种子，CDN 就算返 200 拿到的也是密文（实测 x-enc=1，头 5c 94 2a d8），交给 <img> 一样画不出来。",
    file: "src/backend/wechat-data/src/query/moments.ts",
    from: "      const ikey = unescapeXml(xmlTagText(ib, 'key') ?? '')",
    to: "      const ikey = ''",
    spec: "src/backend/wechat-data/tests/sns-comment-image.spec.ts",
  },
  {
    id: "M419-comment-type-drops-token-seed",
    why: "只改后端类型、客户端类型没跟上 ⇒ 渲染层连 img.token 都读不到，四处接线少一处，评论图静默退回 [图] 而没有任何编译错误之外的信号。",
    file: "src/backend/wechat-data/src/types-moments.ts",
    from: "  image?: { thumb?: string; url?: string; md5?: string; mediaId?: string; token?: string; seed?: string }",
    to: "  image?: { thumb?: string; url?: string; md5?: string; mediaId?: string }",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },

  // ── 评论图：批处理放行 CDN 三件套（最容易回归的一处）────────────────────────────
  {
    id: "M420-comment-cdn-triple-gated-to-img",
    why: "把判据从「不是视频」写回「是 img」⇒ 评论图（kind='comment'）又被关在门外。这正是修复前的原样，且**不会**让任何单测变红：所有断言都不走真实批处理。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "...(it.kind !== 'video' && it.token ? { token: it.token } : {}),",
    to: "...(it.kind === 'img' && it.token ? { token: it.token } : {}),",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
  {
    id: "M421-comment-spec-token-dropped-in-card",
    why: "卡片登记评论图时不填 token ⇒ 后端拿不到地址，只能按 md5 找本机，而本机没有评论图文件 ⇒ 卡片里的评论图恒显示 [图]。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-card.tsx",
    from: "...(img.token ? { token: img.token } : {}),",
    to: "// token 没填",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
  {
    id: "M422-comment-spec-token-dropped-in-detail",
    why: "详情浮层漏填 token ⇒ 同一个动态在卡片里能出图、点进详情就只剩 [图]。两处各自登记 spec，少一处只坏一个面。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-portals.tsx",
    from: "...(img.token ? { token: img.token } : {}),",
    to: "// token 没填",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },

  // ── 评论图：浮层里的格子也要被观察得到（否则登记了也没人去取）──────────────────
  {
    id: "M423-observe-query-narrowed-to-scroll-root",
    why: "补观察只在滚动容器 root 里查 [data-sns-key] ⇒ 详情浮层与灯箱都 portal 到 document.body，里面的格子永远扫不到，评论图登记了 spec 也没人触发取图。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "Array.from(document.querySelectorAll<HTMLElement>('[data-sns-key]'))",
    to: "Array.from(root.querySelectorAll<HTMLElement>('[data-sns-key]'))",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
  {
    id: "M424-detail-key-dropped-from-observe-deps",
    why: "依赖数组里去掉 detailKey ⇒ 打开浮层不重扫，而列表本身没变、moments 依赖也不会触发 ⇒ 浮层里新渲染的格子仍然没人观察。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts",
    from: "  }, [moments, detailKey])",
    to: "  }, [moments])",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },

  // ── 不许把 CDN 密文地址当 <img src> ────────────────────────────────────────────
  {
    id: "M425-comment-src-falls-back-to-cdn-url",
    why: "把 proxyableSrc(img.thumb, img.url) 兜底加回来 ⇒ 那是**加密**地址，交给 <img src> 原理上渲染不出来；实测库里 3219 条地址只有 9 条 https，所以它几乎恒为空串，等于「没有来源也假装有来源」。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-card.tsx",
    from: "src={cdata}",
    to: "src={cdata || proxyableSrc(img.thumb, img.url)}",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
  {
    id: "M426-video-cover-falls-back-to-cdn-url",
    why: "视频封面加回 proxyableSrc(v.thumb) 兜底 ⇒ 封面地址是加密的（实测密文头 4f 44 5a d8），当 src 必失败；唯一能画的是后端解密出来的 data URL。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-portals.tsx",
    from: "const vCover = vk ? snsImgs[vk] : undefined",
    to: "const vCover = (vk ? snsImgs[vk] : undefined) || proxyableSrc(v.thumb)",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
  {
    id: "M427-view-original-toggle-resurrected",
    why: "把 viewOriginal 状态接回面板 ⇒ 那个开关的 disabled 条件是 !proxyableSrc(curImg.url)，而实测 3219 条地址只有 9 条 https ⇒ 几乎恒禁用；一旦启用就是密文。它是纯死控件。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-panel.tsx",
    from: "  const { viewer, setViewer, viewZoom, setViewZoom, viewPan, setViewPan, viewRotate, setViewRotate,",
    to: "  const { viewer, setViewer, viewZoom, setViewZoom, viewPan, setViewPan, viewRotate, setViewRotate, viewOriginal, setViewOriginal,",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },

  // ── 视频封面：按大小分流 + 结尾校验 ─────────────────────────────────────────────
  {
    id: "M428-cover-always-head-only",
    why: "去掉按大小分流、一律只解头 ⇒ 超过 128 KB 的封面尾部仍是密文，结尾标记根本不在末尾，于是交付一张画不出来的图（这正是修复前那个缺陷）。",
    file: "src/backend/wechat-data/src/query/sns-video.ts",
    from: "    bytes = overHeadLine ? (await decryptSnsAll(raw, seed)).bytes : (await decryptSnsHead(raw, seed)).bytes",
    to: "    bytes = (await decryptSnsHead(raw, seed)).bytes",
    spec: "src/backend/wechat-data/tests/sns-video-cover-integrity.spec.ts",
  },
  {
    id: "M429-cover-completeness-check-disabled",
    why: "把结尾校验短路掉 ⇒ 「头合法就放行」的老毛病回来：任何尾部残缺的封面都会被当成好图交给渲染层，而界面上只显示一句「加载失败」，看不出是这个原因。",
    file: "src/backend/wechat-data/src/query/sns-video.ts",
    from: "  if (!coverEndsComplete(bytes, mime)) {",
    to: "  if (false) {",
    spec: "src/backend/wechat-data/tests/sns-video-cover-integrity.spec.ts",
  },
  {
    id: "M430-cover-plaintext-completeness-check-dropped",
    why: "未加密分支不走结尾校验 ⇒ CDN 直接给明文图时不做任何完整性判断，那条路重新变成「头合法就交付」。",
    file: "src/backend/wechat-data/src/query/sns-video.ts",
    from: "    if (!coverEndsComplete(raw, plainMime)) return { error: '微信 CDN 返回的图片结尾不完整，已拒绝交付（否则渲染层会拿到一张画不出来的图）' }",
    to: "    void plainMime",
    spec: "src/backend/wechat-data/tests/sns-video-cover-integrity.spec.ts",
  },

  // ── 视频封面：先网后本（offline）──────────────────────────────────────────────
  {
    id: "M431-cover-offline-param-dropped",
    why: "封面 RPC 不收 offline ⇒ 无网时仍然去 CDN，白等一个超时窗口后才回落本机，与图片那路 2026-10-08 定的「先网后本」不一致。",
    file: "src/backend/wechat-data/src/remotes/media.ts",
    from: "thumb?: string; key?: string; offline?: boolean }): Promise<ImageDataUrlResult> {",
    to: "thumb?: string; key?: string }): Promise<ImageDataUrlResult> {",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
  {
    id: "M432-cover-cdn-branch-ignores-offline",
    why: "远端分支不判 offline ⇒ 无网时照样发请求；这条判据是「先网后本」在封面这路的唯一落点，去掉它整套口径就只剩图片那半边。",
    file: "src/backend/wechat-data/src/remotes/media.ts",
    from: "  if (!offline && remote !== '' && /^https?:\\/\\//i.test(remote)) {",
    to: "  if (remote !== '' && /^https?:\\/\\//i.test(remote)) {",
    spec: "src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts",
  },
]
