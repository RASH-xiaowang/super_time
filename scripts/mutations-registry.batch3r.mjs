/**
 * 变异登记 · **入站监听面（局域网远程访问）的隐私口径**（2026-10-14，M524 起，v13）。
 *
 * 这一批与前面所有批次的方向相反：前面守的都是「功能别静默失效」，这里守的是
 * **一个新增的网络暴露面别静默打开**。`docs/PRIVACY.md` 第四节 H 承诺了三件事 ——
 * 默认关闭、同意屏单独列明、读回配置的缺省口径也是关 —— 任何一件被改掉，
 * 用户看到的声明就变成假话，而**功能一切正常、没有任何测试会红**（这正是最危险的形状：
 * 隐私口径的失效不表现为崩溃，只表现为「文档与代码各说各话」）。
 *
 * 三条各咬一处，且都是**单行锚点**：
 *   · M524 配置默认值翻回 true ⇒ 装上就监听（`privacy-statement.spec.ts` +
 *     `settings-switch-wiring.spec.ts` 双向都咬）；
 *   · M525 读回配置的缺省值翻回 true ⇒ 旧配置文件里没写这个键时按「开」处理
 *     （`wechat/config.json` 里确实存在历史遗留的 `"api_enabled": true`，
 *     所以这一条不是理论风险）；
 *   · M526 同意屏不再渲染入站面 ⇒ 重新同意时用户根本看不到这一条（升版失去意义）。
 *
 * @module mutations-registry/batch3r
 */
export const MUTATIONS_BATCH3R = [
  {
    id: 'M524-remote-access-default-on',
    why: 'api_enabled 的默认值被翻回 true ⇒ 入站监听面变成「装上就开」，而隐私声明第四节 H 写的是「默认关闭」。判据：privacy-statement.spec.ts 的「文档说默认关闭，代码里的默认值就必须是关」+ settings-switch-wiring.spec.ts 的同名默认值判据。',
    file: 'src/backend/wechat-data/src/config/wechat-config.ts',
    from: 'api_enabled: false, api_port: 5032',
    to: 'api_enabled: true, api_port: 5032',
    spec: 'src/backend/tests/privacy-statement.spec.ts',
  },
  {
    id: 'M525-remote-access-fallback-on',
    why: '读回配置时的缺省值被翻回 true ⇒ 配置文件里没写这个键（或旧安装迁移过来缺字段）时按「开」处理，与 defaultConfig 的关不一致。判据：privacy-statement.spec.ts 的「读回配置的口径也要一致」。',
    file: 'src/backend/wechat-data/src/remotes/config.ts',
    from: "api_enabled: Boolean(cfg['api_enabled'] ?? false),",
    to: "api_enabled: Boolean(cfg['api_enabled'] ?? true),",
    spec: 'src/backend/tests/privacy-statement.spec.ts',
  },
  {
    id: 'M526-consent-gate-hides-inbound',
    why: '同意屏定义了入站面清单却不渲染 ⇒ 用户重新同意时看不到「本机可以监听端口」这一条，v13 的升版就失去意义（声明升版的全部价值在于让用户真的看见变更）。判据：privacy-statement.spec.ts 的「同意屏把入站面单独列出来」。',
    file: 'src/client/ui-app/privacy/PrivacyConsentGate.tsx',
    from: '{INBOUND.map((e) => <SurfaceRow key={e.label} e={e} />)}',
    to: '{[]}',
    spec: 'src/backend/tests/privacy-statement.spec.ts',
  },
]
