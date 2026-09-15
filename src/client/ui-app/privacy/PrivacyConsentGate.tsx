/**
 * 首次启动的隐私同意闸门（H14）。
 *
 * 为什么必须有它：本软件读取本机微信数据库，并**只读扫描 `Weixin.exe` 进程内存**取密钥。
 * 这类行为必须在用户进入主界面之前被明确告知并取得同意，而不是写在某个二级面板里等人来翻。
 *
 * 三条设计约束：
 *   · **必须显式同意**才放行（勾选框 + 按钮），没有「跳过」；
 *   · 不做成模态弹窗：它是独立一屏，与启动引导同一套观感，用户读完再进来；
 *   · 文案与 `docs/PRIVACY.md` 逐条对应（出网点清单），并被
 *     `src/backend/tests/privacy-consent-ssr.tsx` 的 SSR 冒烟与
 *     `src/backend/tests/privacy-statement.spec.ts` 守着不许漂。
 *
 * 排版取向（2026-09 改版）：把它当**数据流合约**排，而不是一屏宣传语 ——
 *   · 长句拆成「标签 / 说明 / 标记」三栏，出网点逐条可扫；
 *   · 每节的关键句用 keyBox 圈起来，顶部的「一句话结论」单独成块；
 *   · **关不掉的出网点**单独用琥珀色实心框圈出（全页唯一的警示色），
 *     因为「关掉 AI 开关就等于完全离线」是这份声明里最容易被误读的一点。
 *
 * 版面是**左右两栏**：左栏（一句话结论 / 数据在本机处理 / 只读扫描内存 / 你的控制）讲
 * 「我们怎么处理、你能改什么」，右栏（会出网的地方）是全页最长的清单，独占一栏保持逐条可扫。
 * 两栏各自满高、互不拉伸，页面总高由较高的左栏决定 —— 所以结论块放在左栏还能吃掉左栏的空档。
 * **小节的编号已去掉**：两栏布局下「01→02→03→04」的视觉顺序本来就无法与编号一致，留着只会误导。
 * 样式见 `PrivacyConsentGate.module.css`；窄卡片下出网点会自动折成上下两行（容器查询）。
 */
import React, { useState } from 'react'

import { PRIVACY_VERSION } from './consent.ts'
// 与启动引导同一套观感：令牌在本屏被独占渲染时也必须存在（主面板此刻还没挂载）。
import '../../ui-wechat/src/client/pages/wechat-data/scifi-theme.css'
import '../../ui-wechat/src/client/pages/wechat-data/light-theme.css'
import css from './PrivacyConsentGate.module.css'

/** 出网点的开关性质：决定它拿到哪种标记、以及是否被琥珀色框圈起来。 */
type SwitchKind = 'toggle' | 'none' | 'manual'

interface OutboundEntry {
  /** 左栏标签。 */
  label: string
  /** 中栏说明（一句话讲清「什么时候发、发什么」）。 */
  text: string
  /** 目的地主机（等宽字体，看得出是技术事实而不是形容词）。 */
  host?: string
  kind: SwitchKind
  /** 需要额外提醒时的一行 —— 目前只有「无开关」的两条用得上。 */
  note?: string
}

const KIND_CHIP: Readonly<Record<SwitchKind, string>> = {
  toggle: '可关闭',
  none: '无开关',
  manual: '默认不下载',
}

/**
 * 出网点清单（与 `docs/PRIVACY.md` 第四节逐条对应）。
 *
 * 口径提醒：`toggle` 只表示**应用内有开关**。渲染层按消息里的地址直连加载的图片与头像
 * 不受「自动获取原图（CDN）」控制（那个开关管的是后端主动取回），所以下面另有一段 caveat 说明，
 * 不能让人把「关掉开关」读成「完全离线」。
 */
const OUTBOUND: ReadonlyArray<OutboundEntry> = [
  {
    label: 'AI 问答与总结',
    text: '把检索到的聊天片段发给你自己配置的模型接口',
    host: '默认 api.openai.com（以你配置的 apiUrl 为准）',
    kind: 'toggle',
  },
  {
    label: 'AI embedding',
    text: '同上，用于向量检索（与 AI 问答共用同一道闸门）',
    host: '同上',
    kind: 'toggle',
  },
  {
    label: '头像图片',
    text: '本地未缓存时，按微信记录的头像地址加载',
    host: 'wx.qlogo.cn、mmhead.c2c.wechat.com 等腾讯图片 CDN',
    kind: 'none',
    note: '不发聊天内容，但会暴露你关注了谁（实测约 82% 的联系人本机无缓存）。',
  },
  {
    label: '远程图片 / 视频 / 公众号封面',
    text: '本机没有缓存时从微信 CDN 取回',
    host: 'mp.weixin.qq.com 等微信 CDN',
    kind: 'toggle',
  },
  {
    label: '地图底图',
    text: '拉取行政区划 GeoJSON（离线时回退到内置的简化边界）',
    host: 'cdn.jsdelivr.net、unpkg.com、geo.datav.aliyun.com',
    kind: 'none',
    note: '不含你的数据。',
  },
  {
    label: '语音模型下载',
    text: '只在你点击「下载 whisper 引擎 / 模型」时访问',
    host: 'huggingface.co、hf-mirror.com、github.com releases',
    kind: 'manual',
  },
]

/** 「你的控制」逐条：入口 / 能改什么。 */
const CONTROLS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: '数据边界与出网',
    text: '数据配置 → 数据边界与出网：禁止 AI 出网、敏感字段打码、查看与导出出站审计。',
  },
  {
    label: '图片解码',
    text: '数据配置 → 设置 → 图片解码：关闭「自动获取原图（CDN）」，或切换原图解密方式。',
  },
  {
    label: '重新审阅本声明',
    text: `数据配置 → 高级设置 → 重新查看启动页，可随时重看并重新同意（当前版本 v${PRIVACY_VERSION}）。`,
  },
  {
    label: '删除全部数据',
    text: '删除 %APPDATA%\\Super Time 下的 wechat 与 wechat-data 目录；安装目录只读，卸载不会带走配置。',
  },
  {
    label: '完全离线',
    text: '不配置模型 + 关闭 CDN 取图 + 断网（或在防火墙里禁止 Super Time 出站）。',
  },
]

/**
 * 渲染同意闸门。
 * @param props.onAccepted - 用户同意后的回调（由调用方放行主界面）。
 * @param props.onExit - 用户选择退出（可选；不传则只显示提示）。
 */
export function PrivacyConsentGate({
  onAccepted,
  onExit,
}: {
  onAccepted: () => void
  onExit?: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const blocked = OUTBOUND.filter((e) => e.kind === 'none')

  return (
    <div className={css.shell}>
      <div className={css.doc}>
        <header className={css.head}>
          <span className={css.kicker}>首次启动 · 需要你确认</span>
          <h1 className={css.title}>隐私与数据边界</h1>
          <p className={css.sub}>
            在开始之前，请确认你了解本应用会读取什么、会往哪里发东西。
            完整声明见仓库里的 <code className={css.code}>docs/PRIVACY.md</code>（声明版本 v{PRIVACY_VERSION}）。
          </p>
        </header>

        <div className={css.grid}>
          <div className={css.col}>
            {/* 一句话结论 —— 全页最上面被「圈起来」的一段 */}
            <section className={css.verdict} aria-label="一句话结论">
              <span className={css.verdictTag}>一句话结论</span>
              <ul className={css.verdictList}>
                <li>数据不出本机：解析、分析、检索、导出全部在你自己的电脑上完成。</li>
                <li>
                  唯一会把你<b>内容</b>发出去的是 AI 问答与总结 —— 它发给你<b>自己配置</b>的模型接口，可以整体关掉。
                </li>
                <li>
                  除此之外还有几处不涉及聊天内容的出网点，出网清单里逐条列明；其中 <b>2 条没有内置开关</b>。
                </li>
              </ul>
            </section>

            <section className={css.sec}>
              <div className={css.secHd}>
                <h2 className={css.secTitle}>数据在本机处理</h2>
              </div>
              <p className={css.p}>
                微信数据库在本机解密、存储与分析；检索、统计、导出、图谱、账本、备份全部为纯本地操作。
              </p>
              <p className={css.keyBox}>我们没有任何服务器，不会上传你的聊天记录、图片或导出物。</p>
            </section>

            <section className={css.sec}>
              <div className={css.secHd}>
                <h2 className={css.secTitle}>只读扫描微信进程内存（取解密密钥）</h2>
              </div>
              <p className={css.p}>
                微信 4.x 的数据库密钥不以明文存在磁盘上，只存在于运行中的微信进程内存里。
                「自动获取密钥」会以只读方式扫描 Weixin.exe 的内存区域，并用一个数据库文件校验命中结果。
              </p>
              <div className={css.pills}>
                {['不写入', '不修改', '不注入', '不挂钩', '不保存或外发内存内容'].map((t) => (
                  <span key={t} className={css.pill}>{t}</span>
                ))}
              </div>
              <p className={css.keyBox}>
                命中后密钥写入本机 secrets.json（权限收紧到当前用户）。微信没在运行时该能力不可用，可改为手动填写密钥。
              </p>
            </section>

            <section className={css.sec}>
              <div className={css.secHd}>
                <h2 className={css.secTitle}>你的控制</h2>
              </div>
              <div className={css.rows}>
                {CONTROLS.map((c) => (
                  <div key={c.label} className={css.row}>
                    <span className={css.rowLabel}>{c.label}</span>
                    <span className={css.rowText}>{c.text}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className={css.col}>
            <section className={css.sec}>
              <div className={css.secHd}>
                <h2 className={css.secTitle}>会出网的地方（逐条）</h2>
              </div>
              <div className={css.stat}>
                <span className={css.statChip}>共 6 个出网点</span>
                <span className={css.statChip}>3 类可关闭</span>
                <span className={css.statChipWarn}>2 条无内置开关</span>
                <span className={css.statChip}>1 条只在你要用时发生</span>
              </div>

              <div className={css.rows}>
                {OUTBOUND.map((e) => (
                  <div key={e.label} className={e.kind === 'none' ? `${css.row} ${css.rowNone}` : css.row} data-switch={e.kind}>
                    <span className={css.rowLabel}>{e.label}</span>
                    <span className={css.rowText}>
                      {e.text}
                      {e.host && <span className={css.rowHost}>{e.host}</span>}
                      {e.note && <span className={css.rowNote}>{e.note}</span>}
                    </span>
                    <span className={e.kind === 'none' ? `${css.chip} ${css.chipNone}` : e.kind === 'toggle' ? `${css.chip} ${css.chipToggle}` : `${css.chip} ${css.chipManual}`}>
                      {KIND_CHIP[e.kind]}
                    </span>
                  </div>
                ))}
              </div>

              <p className={css.caveat}>
                <b>诚实说明</b>：上面 {blocked.length} 条无开关的出网点（{blocked.map((e) => e.label).join('、')}）
                不受任何应用内设置控制；「自动获取原图（CDN）」管的也只是<b>后端主动取回</b>，
                渲染层按消息里的地址直连加载的图片与头像不在它的管辖内。要完全离线，请配合系统防火墙或断网。
              </p>
            </section>
          </div>
        </div>

        <label className={css.consent} data-on={checked || undefined}>
          <input
            type="checkbox"
            className={css.consentBox}
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span className={css.consentText}>
            我已阅读并理解上述数据处理方式，同意本应用读取本机微信数据、只读扫描微信进程内存以获取解密密钥，
            并按上述方式使用网络。
          </span>
        </label>

        <div className={css.actions}>
          {onExit && (
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={onExit}>
              不同意并退出
            </button>
          )}
          <button
            type="button"
            className={`${css.btn} ${css.btnPrimary}`}
            disabled={!checked}
            onClick={onAccepted}
          >
            同意并继续
          </button>
        </div>
      </div>
    </div>
  )
}
