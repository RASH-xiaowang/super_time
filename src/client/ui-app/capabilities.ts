/**
 * 运行环境能力表：**桌面端（Electron）还是手机浏览器**。
 *
 * ## 为什么要有这一份，而不是各处自己判
 *
 * 渲染层原本直接调 `window.electronAPI` 拿原生能力：选目录、窗口控制、面板截图、
 * 在资源管理器中显示、许可证面板、诊断、检查更新。手机浏览器里这些**一个都没有**
 * （preload 不存在）。如果让每个面板自己写 `if (window.electronAPI)`，必然会漏 ——
 * 漏掉的表现为「手机上点了没反应」，而这比报错更难排查。
 *
 * 所以能力口径收成这一个对象，界面只读它。`capabilities.wiring.spec.ts` 用 AST 断言
 * **渲染层没有别处自己判环境**（除本文件与 remote 安装点），漏网的会被点名。
 *
 * ## 判定口径：失败方向必须是「当成浏览器」
 *
 * 只有 `window.electronAPI.wechat.call` **确实是个函数**时才算桌面端。
 * 形状不对（老 preload、字段改名、被裁剪）一律按浏览器处理 —— 那样最多是少几个原生按钮，
 * 反过来（把浏览器当桌面端）会让界面去调一个不存在的桥，直接抛。
 *
 * @module ui-app/capabilities
 */

import type { ElectronApi } from '@deepseek-ai/dsh-client-ui-wechat/host'

/** 读一次桥（模块加载时就定型：环境不会在运行中从 Electron 变成浏览器）。 */
function bridge(): ElectronApi | null {
  if (typeof window === 'undefined') return null
  const b = window.electronAPI
  return b && typeof b === 'object' ? b : null
}

/** 是不是桌面端（Electron 渲染进程，preload 桥齐全）。 */
const b = bridge()
export const isDesktop: boolean = typeof b?.wechat?.call === 'function'

/** 是不是手机/浏览器会话（走 HTTP + SSE，而不是 IPC）。 */
export const isBrowser: boolean = !isDesktop

/**
 * 逐项能力。
 *
 * 值是「本环境有没有这个能力」，界面据此**隐藏或禁用**对应控件 ——
 * 不是「点了之后再报错」：手机上出现一个「选择目录」按钮，点下去什么也不发生，
 * 用户只会以为应用坏了。
 */
export const capabilities = Object.freeze({
  /** 桌面端（Electron）。 */
  isDesktop,
  /** 浏览器 / 手机端。 */
  isBrowser,
  /** 自绘标题栏（拖拽 + 最小化 / 全屏 / 关闭）。浏览器有自己的标签页与地址栏。 */
  titlebar: isDesktop,
  /** 窗口控制（最小化 / 全屏切换 / 关闭）。 */
  windowControls: isDesktop,
  /** 原生目录选择对话框。手机上没有「本机目录」这个概念（数据在电脑上）。 */
  dirPicker: isDesktop && typeof b?.pickDirectory === 'function',
  /** 面板截图（`window:capture-panel`）。 */
  capturePanel: isDesktop && typeof b?.capturePanel === 'function',
  /** 在资源管理器中显示（`shell:show-item`）。 */
  shellOpen: isDesktop && typeof b?.showInFolder === 'function',
  /**
   * 许可证界面。
   *
   * 浏览器态为 false：授权是**绑机器**的，由服务端在每次调用时把关
   * （`call-gates.js` 的 `authorizeCall`），手机侧再查一次既查不到也没意义 ——
   * 查到的是「手机这台设备没有许可证」，那会把一个已经授权过的会话挡在门外。
   */
  license: isDesktop && typeof b?.license?.status === 'function',
  /** 诊断面板（`diag:*`）：导出的是本机日志与配置，远程端不该拿。 */
  diag: isDesktop && typeof b?.diag?.logInfo === 'function',
  /** 检查更新（`update:*`）：更新的是电脑上那个安装，手机点了没用。 */
  update: isDesktop && typeof b?.update?.state === 'function',
})

/**
 * 浏览器态下**跳过本地三道闸门**（启动引导 / 隐私同意 / 授权）。
 *
 * 为什么可以跳：
 *   · 手机浏览器里 `localStorage` 是空的，三道闸门会依次要求「看 4 页引导 → 同意隐私声明
 *     → 导入许可证」，而这台设备上**一件都做不成**（引导讲的是本机数据根与密钥、
 *     许可证绑的是电脑的设备指纹）；
 *   · 真正的授权已经发生过了 —— 桌面端主人生成了配对码并把它交给手机（令牌门），
 *     而每次调用还要过服务端那道 `authorizeCall`；
 *   · 隐私声明的重新同意是**桌面端**的义务（`PRIVACY_VERSION` 存在桌面端的 localStorage 里），
 *     手机端看到的那份声明由桌面端已经同意过。
 *
 * 桌面端恒为 false，所以这一条不会削弱原有的闸门。
 */
export const bypassLocalGates: boolean = isBrowser
