/**
 * 变异登记 · **浏览器态降级（M9）**（2026-10-14，M564 起）。
 *
 * 这一批全部对着「降级写了但不生效」那一类静默失效：
 *
 *   M564 未注入能力表时的缺省方向从「按浏览器」翻成「按桌面」—— 翻过来就不是降级了，
 *        而是让界面去调一个不存在的桥（直接抛）。判据：②b 把失败方向钉死。
 *   M565 手机端的「设置」不再分派到降级视图 ⇒ 桌面那份状态钩子挂载，开局连打 19 个
 *        会被远程拒掉的接口，手机上看到的就是转圈 + 一屏红字。判据：④。
 *   M566 `desktopActionProps()` 恒返回空对象 ⇒ 所有靠它禁用的按钮（ClawBot 写侧、
 *        各处导出、隐私审计清理）在手机上重新变成可点，点了才报错。判据：desktop-only.spec 的动作级那条。
 *   M567 「原图链路自检」从仅桌面端表里漏登记 ⇒ 手机上一节照常渲染、每个接口都吃闭门羹，
 *        而界面上一句说明都没有。判据：③b（设置里的每一节必须要么能用、要么登记）。
 *   M568 spread 写在了 `disabled` 前面 ⇒ 后者把降级属性覆盖掉，「加了门禁但门禁不生效」，
 *        不报错、不红，只是手机上又能点了。判据：⑥（位置纪律）。
 *   M569 配置向导的指路卡不再摘 ⇒ 手机上出现一张「点你去设置配密钥」的卡，而那一节不存在。判据：④。
 *   M570 通讯录里的导出记录弹窗不再受手机态控制 ⇒ 八个接口全被拒的弹窗能被打开。
 *        判据：export-history.wiring.spec 的那条 `open={historyOpen && !desktopAction()}`。
 *
 * @module mutations-registry/batch3z
 */
export const MUTATIONS_BATCH3Z = [
  {
    id: 'M564-runtime-caps-default-to-desktop',
    why: '能力表没注入时的缺省方向翻成「按桌面端」：判据要求失败方向必须是「按浏览器」——反过来会让界面去调一个不存在的桥，那是直接抛而不是降级。判据：capabilities.wiring.spec.ts 的 ②b。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/api-core.ts',
    from: '  return _caps ?? { isDesktop: false, isBrowser: true, dirPicker: false, capturePanel: false, shellOpen: false, license: false, diag: false, update: false }',
    to: '  return _caps ?? { isDesktop: true, isBrowser: false, dirPicker: true, capturePanel: true, shellOpen: true, license: true, diag: true, update: true }',
    spec: 'src/client/ui-wechat/src/client/capabilities.wiring.spec.ts',
  },
  {
    id: 'M565-settings-panel-never-delegates',
    why: '把「设置」的浏览器分派条件写死成 false ⇒ 手机端挂载桌面那份状态钩子，开局连打 19 个会被远程拒绝的接口（用户看到的是转圈加一屏红字）。判据：capabilities.wiring.spec.ts 的 ④。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Settings.tsx',
    from: '  if (runtimeCapabilities().isBrowser) return <SettingsBrowserPanel {...p} />',
    to: '  if (false) return <SettingsBrowserPanel {...p} />',
    spec: 'src/client/ui-wechat/src/client/capabilities.wiring.spec.ts',
  },
  {
    id: 'M566-desktop-action-props-always-empty',
    why: '动作级降级恒返回空对象 ⇒ ClawBot 写侧按钮、各处「导出」、隐私审计清理在手机上全部重新可点，点了才吃一句远程拒绝（本该是禁用 + 说明）。判据：ui/desktop-only.spec.ts 的「动作级降级」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/desktop-only.tsx',
    from: '  return desktopAction() ? { disabled: true, title: DESKTOP_ACTION_WHY } : {}',
    to: '  return {}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/desktop-only.spec.ts',
  },
  {
    id: 'M567-hook-section-unregistered',
    why: '「原图链路自检」从仅桌面端表里漏登记（改名成一个不匹配的字面键）⇒ 手机上那一节照常渲染、九个接口全被拒，而界面上没有任何说明。判据：capabilities.wiring.spec.ts 的 ③b（每一节要么能用，要么登记）。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/desktop-only.tsx',
    from: '  hook: {',
    to: '  hookX: {',
    spec: 'src/client/ui-wechat/src/client/capabilities.wiring.spec.ts',
  },
  {
    id: 'M568-spread-before-disabled-silently-lost',
    why: '把 `{...desktopActionProps()}` 挪到元素 `disabled` 之前 ⇒ 后写的 `disabled={busy === it.slot}` 覆盖掉降级那一份，手机上按钮又能点了：不报错、不红，是「加了门禁但门禁不生效」的静默失效。判据：capabilities.wiring.spec.ts 的 ⑥。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-rail.tsx',
    from: '                      disabled={busy === it.slot} {...desktopActionProps()}',
    to: '                      {...desktopActionProps()} disabled={busy === it.slot}',
    spec: 'src/client/ui-wechat/src/client/capabilities.wiring.spec.ts',
  },
  {
    id: 'M569-setup-guide-still-shown-on-phone',
    why: '配置向导的指路卡不再按环境摘掉 ⇒ 手机上出现一张「点你去设置配密钥」的浮卡，而设置里那一整块在手机上不存在（它自己挂载还打四个会被拒的接口）。判据：capabilities.wiring.spec.ts 的 ④。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/SetupGuide.tsx',
    from: '  if (runtimeCapabilities().isBrowser) return null',
    to: '  if (false) return null',
    spec: 'src/client/ui-wechat/src/client/capabilities.wiring.spec.ts',
  },
  {
    id: 'M570-export-history-dialog-ungated',
    why: '通讯录里的「导出记录」弹窗去掉手机态条件 ⇒ 一个八个接口全不在远程白名单里的弹窗能被打开（读历史、重新导出、删除、清理全吃闭门羹）。判据：panels/export-history.wiring.spec.ts。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Contacts.tsx',
    from: '{!desktopAction() && <ExportHistoryDialog open={historyOpen}',
    to: '{true && <ExportHistoryDialog open={historyOpen}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/export-history.wiring.spec.ts',
  },
]
