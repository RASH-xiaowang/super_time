/**
 * 「这一节只在电脑上可用」的降级卡（M9）。
 *
 * ## 为什么要有它
 *
 * 手机浏览器连进来时，设置面板里有九节做的是**这台电脑**上的事：读微信安装目录、
 * 取内存里的数据库密钥、写 `llm.json`（里面有 API Key）、开入站监听、建本机快照、
 * 开本机 db 做完整性检查、检查并安装更新、验许可证。这些动作背后的方法**故意不在
 * 远程白名单里**（`src/backend/http-remote-policy.js` 的 B/C/D 类理由），所以手机上
 * 打开这些节看到的是：数据永远转圈、按钮点下去报一句「该操作只能在电脑上执行」。
 *
 * 那比报错更糟 —— 用户以为应用坏了。所以这里在**渲染之前**就把整节换成一张说明卡：
 * 讲清这件事为什么只能在电脑上做、去电脑上哪里做。能力口径只有 `capabilities.ts` 一份，
 * 本文件只读它注入进渲染层的那份副本（跨包界不反向 import，见 api-core 的注释）。
 *
 * 失败方向：能力表没注入 ⇒ 按浏览器处理（宁可少显示几节，也不要让界面去调不存在的桥）。
 */
import { runtimeCapabilities } from '../api.ts'
import css from './desktop-only.module.css'

/** 需要降级的节；每条都要写清「为什么手机上做不了」，不许只写「不可用」。 */
const DESKTOP_ONLY: Readonly<Record<string, { label: string, why: string, where: string }>> = Object.freeze({
  setup: {
    label: '配置向导（检测账号 · 数据库密钥 · 图片密钥 · 图片解码 · 语音转写）',
    why: '这五步读的是这台电脑上的微信安装目录，以及从它运行内存里取的数据库密钥 —— 手机浏览器既没有那个目录，也取不到密钥。',
    where: '在电脑上打开 Super Time → 设置 → 配置向导',
  },
  ai: {
    label: 'AI 大模型',
    why: '模型配置里含 API Key，写在电脑本机的 `llm.json`。远程端一律不开这类凭据的读写 —— 否则令牌泄漏就等于密钥泄漏。',
    where: '在电脑上打开 Super Time → 设置 → AI 大模型',
  },
  remote: {
    label: '局域网访问（手机）',
    why: '这一节本身就是「在这台电脑上开一个入站监听」。从监听进来的那一侧改监听，等于让被连进来的一方决定谁能连进来。',
    where: '在电脑上打开 Super Time → 设置 → 维护与自检 → 局域网访问（手机）',
  },
  license: {
    label: '软件授权',
    why: '许可证绑的是这台电脑的设备指纹，并且服务端每次调用都已经把过关了；手机侧再查一次只会查到「这台设备没有许可证」，把已经授权的会话挡在门外。',
    where: '在电脑上打开 Super Time → 设置 → 软件授权',
  },
  update: {
    label: '软件更新',
    why: '更新的是电脑上那个安装（下载、校验、替换本机文件），手机上点不动它。',
    where: '在电脑上打开 Super Time → 设置 → 软件更新',
  },
  backup: {
    label: '备份恢复',
    why: '快照落在本机磁盘、恢复要选本机目录 —— 这两个动作在浏览器里没有对应的概念。',
    where: '在电脑上打开 Super Time → 设置 → 备份恢复',
  },
  health: {
    label: '数据库健康',
    why: '完整性检查与占用统计要直接打开本机的解密库文件（路径本身就是本机信息，不该出这台电脑）。',
    where: '在电脑上打开 Super Time → 设置 → 数据库健康',
  },
  hook: {
    label: '原图链路自检',
    why: '自检会在本机跑一遍原图解码链路（含本机缓存与解码器），远程端拿不到那些文件。',
    where: '在电脑上打开 Super Time → 设置 → 原图链路自检',
  },
  privacy: {
    label: '隐私体检',
    why: '全库敏感信息扫描要逐条读本机解密库（手机侧没有这条通道），而且命中样本要能跳回会话原文 —— 那需要本机的会话数据。',
    where: '在电脑上打开 Super Time → 设置 → 隐私体检',
  },
  advanced: {
    label: '高级设置',
    why: '输出目录与启动引导状态都是这台电脑上的路径与本地状态。',
    where: '在电脑上打开 Super Time → 设置 → 高级设置',
  },
})

/** {@link DESKTOP_ONLY} 的键（导出给判据遍历，不让清单在第二个地方再抄一遍）。 */
export const DESKTOP_ONLY_KEYS: readonly string[] = Object.keys(DESKTOP_ONLY)

/**
 * 浏览器态返回降级卡，桌面端返回 null（调用方早退）。
 * @param key - {@link DESKTOP_ONLY_KEYS} 之一。
 * @returns 降级卡或 null。
 */
export function desktopOnlyGate(key: string): React.JSX.Element | null {
  const caps = runtimeCapabilities()
  // 桌面端与「打开网页」交接态：都有这台电脑的原生能力。
  if (!caps.isBrowser || caps.desktopEquivalent === true) return null
  const item = DESKTOP_ONLY[key] ?? { label: key, why: '这一节做的事都发生在这台电脑上。', where: '在电脑上打开 Super Time 的设置里完成。' }
  return (
    <div className={css.card} data-desktop-only={key} role="note">
      <div className={css.head}>
        <span className={css.badge} aria-hidden="true">🖥</span>
        <span className={css.title}>{item.label} · 仅桌面端</span>
      </div>
      <p className={css.why}>{item.why}</p>
      <p className={css.where}>{item.where}</p>
    </div>
  )
}

/**
 * 把多节合成一张清单卡（浏览器态的「设置」面板用）。
 *
 * 为什么不是九张卡：手机上打开设置要滚过九张内容几乎一样的「仅桌面端」，
 * 每一张都在说同一句话 —— 那既长又读不出重点。一张表 + 每节一行「为什么」刚好。
 *
 * 每行都带 `data-settings-section="<key>"`：深链（`#backup` / `#health`）落到设置时
 * 找的就是这个属性，留着它，将来要做滚动定位不必再改结构。
 * @param keys - {@link DESKTOP_ONLY_KEYS} 的子集（顺序即显示顺序）。
 * @returns 清单卡。
 */
export function desktopOnlyListCard(keys: readonly string[]): React.JSX.Element {
  return (
    <div className={css.card} data-desktop-only="list" role="note">
      <div className={css.head}>
        <span className={css.badge} aria-hidden="true">🖥</span>
        <span className={css.title}>以下各节只能在电脑上完成</span>
      </div>
      <ul className={css.list}>
        {keys.map((key) => {
          const item = DESKTOP_ONLY[key]
          if (!item) return null
          return (
            <li key={key} className={css.listItem} data-settings-section={key}>
              <span className={css.listLabel}>{item.label}</span>
              <span className={css.listWhy}>{item.why}</span>
            </li>
          )
        })}
      </ul>
      <p className={css.where}>入口都在电脑上的 Super Time：主界面右下角「设置」。</p>
    </div>
  )
}

/**
 * 单个**动作**的降级判据：浏览器态为 true，调用方据此禁用控件并给出 {@link DESKTOP_ACTION_WHY}。
 *
 * 与 {@link desktopOnlyGate} 的分工：整节都在本机做事 → 换成卡（不挂载，一次远程调用都不发）；
 * 一节里只有某一个按钮是动作是 → 留下按钮但禁用（隐藏会让手机用户以为功能不存在）。
 *
 * 为什么不用一个布尔常量而用函数：模块加载时求值的常量在测试里没法换环境，
 * 而这一族的判据必须能被 spec 在「桌面态 / 浏览器态」两边各跑一次。
 */
export function desktopAction(): boolean {
  const caps = runtimeCapabilities()
  return caps.isBrowser && caps.desktopEquivalent !== true
}

/** 禁用态下显示给用户的那句话（`title` 与 `aria-label` 共用）。 */
export const DESKTOP_ACTION_WHY = '这一步要在电脑上完成'

/**
 * 浏览器态下给「只有桌面端能做的动作」那类控件的禁用属性组（spread 到元素上）。
 *
 * 用法上有一个坑要注意：**必须放在显式的 `disabled={…}` 之后**。
 * 放前面的话，后面那个 `disabled={busy}` 会把这里的 `disabled: true` 覆盖掉，
 * 于是手机上按钮又变回可点 —— 而 JS 的 spread 是后写覆盖先写，报错还不响。
 * @returns 浏览器态给 `{ disabled, title }`，桌面态给空对象。
 */
export function desktopActionProps(): { disabled?: boolean, title?: string } {
  return desktopAction() ? { disabled: true, title: DESKTOP_ACTION_WHY } : {}
}

