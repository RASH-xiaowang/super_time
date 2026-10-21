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
 *     `src/client/ui-app/privacy/consent.spec.ts`（含「ui-entry 真的渲染本组件」那条接线判据）与
 *     `src/backend/tests/privacy-statement.spec.ts` 守着不许漂。
 *
 * 微信化改版（2026-10-19）：**单列单滚动**（内容列 max-width 760）。
 *   · 顶部「一句话结论」= 3 条 TL;DR（数据只在本机 / AI 只发给你自己配的模型 / 无遥测）；
 *   · 正文改成可展开小节（原生 `<details>`，无 JS）：出网点与入站两条默认展开 ——
 *     它们是这份声明的核心决策清单；三节说明默认收起；
 *   · 底部同意条在**文档流末尾**（不是 sticky / fixed：桌面端 flex 列把它钉在内容区底部，
 *     嵌入启动页时也只占最后一格，不遮挡正文 —— `consent.spec.ts` 钉着这条）；
 *   · 去渐变、去发光、去彩色底：白卡 + 1px 边框 + 微信绿主按钮。
 *
 * 两条渲染路径（2026-10-19 布局重做后保持）：
 *  ① **内嵌启动页**（`embedded`）：页头由 `StageHead` 给（标题 + 导语），本组件只负责
 *     「单列滚动 + 同意条」。父级 `.consentPage` 有确定高度（height:100%）。
 *  ② **独立整屏**（默认）：声明升版后的「重新同意」直接挂在 `#root` 下，没有启动页外壳，
 *     这一路径自己给页头并填满 `#root` 的确定高度。
 */

import React, { useState } from 'react'

import { PRIVACY_VERSION } from './consent.ts'
// 同意屏同样要能看到「有新版本可装」：更新是主进程的事，与走到哪一屏无关。
// 这一屏没有设置弹窗，故不传 onOpenLicense。
import { NoticeBanner } from '@deepseek-ai/dsh-client-ui-wechat/notice'
// 与启动引导同一套观感：令牌在本屏被独占渲染时也必须存在（主面板此刻还没挂载）。
import css from './PrivacyConsentGate.module.css'

/** 网络面的开关性质：决定它拿到哪种标记、以及是否被琥珀色框圈起来。
 *  · `none`   —— 没有开关（琥珀色圈出，全页唯一的警示色）
 *  · `manual` —— 只在你点击时才发生
 *  · `off`    —— **默认关闭、且有真开关**（2026-10-14 随入站监听首次出现；
 *                出网侧自 2026-09-30 起已无此档） */
type SwitchKind = 'none' | 'manual' | 'off'

interface SurfaceEntry {
  /** 左栏标签。 */
  label: string
  /** 中栏说明（一句话讲清「什么时候发、发什么」）。 */
  text: string
  /** 目的地主机（看得出是技术事实而不是形容词）。 */
  host?: string
  kind: SwitchKind
  /** 需要额外提醒时的一行 —— 目前只有「头像图片」与「地图底图」与入站那条用得上。 */
  note?: string
}

const KIND_CHIP: Readonly<Record<SwitchKind, string>> = {
  none: '无开关',
  manual: '仅点击时下载',
  off: '默认关闭 · 可关',
}

/**
 * 标记的配色：`none` 用琥珀（全页唯一的警示色，「关不掉」），其余用中性/绿色。
 */
const KIND_CHIP_CLASS: Readonly<Record<SwitchKind, string>> = {
  none: `${css.chip} ${css.chipNone}`,
  manual: `${css.chip} ${css.chipManual}`,
  off: `${css.chip} ${css.chipToggle}`,
}

/**
 * 出网点清单（与 `docs/PRIVACY.md` 第四节 A–G 逐条对应）。
 *
 * 口径提醒（2026-09-30）：应用内的出网开关**已全部移除**，所以这里不再有 `可关闭` 这一档 ——
 * 每条都是「无开关」或「仅在你点击时才发生」。要断网只能靠系统防火墙或断网。
 */
const OUTBOUND: ReadonlyArray<SurfaceEntry> = [
  {
    label: 'AI 问答与总结',
    text: '把检索到的聊天片段发给你自己配置的模型接口；「测试连接 / 测试向量 / 测试精排」只发一条固定测试串，「余额查询」（左下角每 5 分钟一次）只带 Key —— 都不发你的内容',
    host: '默认 api.openai.com（以你配置的 apiUrl 为准）',
    kind: 'none',
  },
  {
    label: 'AI embedding',
    text: '同上，用于向量检索（与 AI 问答共用同一道接缝）',
    host: '同上',
    kind: 'none',
  },
  {
    label: '任务触发（Webhook / 多家 RPA 厂商）',
    text: '任务命中关键词后投递触发记录：Webhook 发整条记录 JSON；RPA 厂商只发会话名/触发文本/触发对象（都不发图片）。八爪鱼参数在附加参数中逐条配置（默认不发业务参数；值来自触发记录 / 固定值 / 自定义模板；不含凭据或图片）。默认不配置不发送；阿里云 / 来也 / 实在为实验性接入',
    host: '你配置的 Webhook 地址；api-rpa.bazhuayu.com、api.yingdao.com、console-rpa.aliyun.com、z-commander-api.ai-indeed.com；UiPath（默认 cloud.uipath.com，云区域名 uipath.com / uipath.us）/ 来也（laiye.com）/ 私有化部署用你配置的实例地址',
    kind: 'none',
  },
  {
    label: '头像图片',
    text: '本机未缓存时由后端按微信记录的头像地址代为取回（界面不直接请求）',
    host: 'wx.qlogo.cn、mmhead.c2c.wechat.com 等腾讯图片 CDN',
    kind: 'none',
    note: '不发聊天内容，但会暴露你关注了谁（实测约 82% 的联系人本机无缓存）。本机没有的就退成首字母。',
  },
  {
    label: '远程图片 / 视频 / 公众号封面',
    text: '本机没有缓存时从微信 CDN 取回',
    host: 'mp.weixin.qq.com 等微信 CDN',
    kind: 'none',
  },
  {
    label: '地图底图',
    text: '拉取行政区划 GeoJSON',
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

/**
 * 入站监听面（与 `docs/PRIVACY.md` 第四节 H 对应）。
 *
 * 刻意**与出网点分开列、不并进上面的计数**：方向相反（本机监听、别的设备连进来），
 * 混在一起会让「共 N 个出网点」这句话变成假话。它是本屏唯一带 `off` 标记的一条。
 */
const INBOUND: ReadonlyArray<SurfaceEntry> = [
  {
    label: '「打开网页」交接（临时入站监听）',
    text: '只有点击标题栏「打开网页」时，本机才在局域网临时监听一个端口（默认 5032），让默认浏览器打开同一套界面。浏览器会话与桌面端同权限（可能读到模型 API Key 等配置）；点右下角卡片返回即停服、作废会话。普通「远程访问（手机）」开关已移除',
    host: '本机局域网 IPv4:5032（仅交接期间临时监听）',
    kind: 'off',
    note: '⚠ 这条链路是明文 HTTP、没有 TLS：在公共 Wi-Fi 或被入侵的路由器下，同网段的人能嗅探到交接码与你查阅的数据。交接期间请把浏览器窗口当作桌面端本人；用完点卡片返回即停。应用没有管理员权限、不能替你加防火墙入站规则 —— 首次监听时请在 Windows 弹窗里选「允许」，否则浏览器连不上。',
  },
]

/** 「你的控制」逐条：入口 / 能改什么。 */
const CONTROLS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: '数据边界与出网',
    text: '数据配置 → 数据边界与出网：敏感字段打码、查看与导出出站审计。',
  },
  {
    label: '模型配置',
    text: '数据配置 → AI 大模型：换模型 / 换服务商，或把 apiUrl 指向你自己的内网或本机模型。',
  },
  {
    label: '打开网页',
    text: '标题栏「打开网页」：用默认浏览器打开同一套界面，桌面缩为右下角卡片；浏览器与桌面端同权限，点卡片「返回桌面应用」即停服并作废会话。',
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
    text: '断网，或在系统防火墙里禁止 Super Time 出站；再把自己的模型端点换成内网 / 本机服务，内容就完全不出你的网络。',
  },
]

/** 一条网络面的行：出网与入站共用同一套「标签 / 说明 / 标记」排版。 */
function SurfaceRow({ e }: { e: SurfaceEntry }): React.JSX.Element {
  return (
    <div className={e.kind === 'none' ? `${css.row} ${css.rowNone}` : css.row} data-switch={e.kind}>
      <span className={css.rowLabel}>{e.label}</span>
      <span className={css.rowText}>
        {e.text}
        {e.host && <span className={css.rowHost}>{e.host}</span>}
        {e.note && <span className={css.rowNote}>{e.note}</span>}
      </span>
      <span className={KIND_CHIP_CLASS[e.kind]}>{KIND_CHIP[e.kind]}</span>
    </div>
  )
}

/**
 * 渲染同意闸门。
 * @param props.onAccepted - 用户同意后的回调（由调用方放行主界面）。
 * @param props.onExit - 用户选择退出（可选；不传则只显示提示）。
 * @param props.embedded - 作为启动页的一个 stage 渲染（页头由外层 `StageHead` 提供）；
 *   缺省 = 独立整屏（声明升版后的重新同意，自己渲染页头并填满 `#root`）。
 */
export function PrivacyConsentGate({
  onAccepted,
  onExit,
  embedded = false,
}: {
  onAccepted: () => void
  onExit?: () => void
  embedded?: boolean
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const blocked = OUTBOUND.filter((e) => e.kind === 'none')

  return (
    <div
      className={css.shell}
      data-standalone={embedded ? undefined : ''}
      data-embedded={embedded ? '' : undefined}
    >
      {/* 提醒卡改走**文档流**：这一屏底部就是「同意并继续」主按钮，
          右下角悬浮卡会直接盖住它。没有提醒时组件返回 null，不占高度。 */}
      <NoticeBanner placement="inline" />

      {/* 独立整屏才画页头：内嵌启动页时 StageHead 已经给了同一套标题与导语，
          这里再画一遍就是两条标题（`consent.spec.ts` 的 ③ 也钉着这一点）。 */}
      {!embedded && (
        <header className={css.pageHead}>
          <div className={css.pageHeadCopy}>
            <span className={css.pageEyebrow}>需要你确认 · 一屏读完</span>
            <h1 className={css.pageTitle}>隐私与数据边界</h1>
            <p className={css.pageLead}>
              在读取本机微信数据之前，请确认你了解它会读什么、会往哪里发。
              <span className={css.pageVersion}>声明版本 v{PRIVACY_VERSION}</span>
              完整声明见 <code className={css.pageCode}>docs/PRIVACY.md</code>。
            </p>
          </div>
        </header>
      )}

      {/* 单列单滚动：整页只有这一处滚动条。 */}
      <div className={css.scroll}>
        {/* 一句话结论 = 顶部 3 条 TL;DR（不涉及细节，细节都在下面的小节里）。 */}
        <section className={css.verdict} aria-label="一句话结论">
          <span className={css.verdictTag}>一句话结论</span>
          <ul className={css.verdictList}>
            <li>数据不出本机：解析、检索、统计、导出全部在你自己的电脑上完成。</li>
            <li>
              唯一会把你<b>内容</b>发出去的是 AI 问答与总结 —— 发给你<b>自己配置</b>的模型接口。
            </li>
            <li>
              其余出网点都不涉及聊天内容，已在下面逐条列明；应用内已<b>没有任何出网开关</b>，
              要完全断网请配合系统防火墙或断网。
            </li>
          </ul>
        </section>

        {/* 核心决策清单默认展开：合规资产不能藏在折叠里。 */}
        <details className={css.sec} open>
          <summary className={css.secTitle}>会出网的地方（逐条）</summary>
          <div className={css.secBody}>
            <div className={css.stat}>
              <span className={css.statChip}>共 {OUTBOUND.length} 个出网点</span>
              <span className={css.statChipWarn}>{blocked.length} 条无开关</span>
              <span className={css.statChip}>{OUTBOUND.length - blocked.length} 条只在你要用时发生</span>
            </div>

            <div className={css.rows}>
              {OUTBOUND.map((e) => <SurfaceRow key={e.label} e={e} />)}
            </div>

            <p className={css.caveat}>
              <b>诚实说明</b>：上面 {blocked.length} 条出网点（{blocked.map((e) => e.label).join('、')}）
              <b>不受任何应用内设置控制</b> —— 应用里已经没有任何出网开关。图片、头像与视频这一类
              全部由后端代取，界面自己不向任何远程主机要图。要断掉这些请求，只能靠系统防火墙或断网。
            </p>
          </div>
        </details>

        <details className={css.sec} open>
          <summary className={css.secTitle}>会被连进来的地方（入站）</summary>
          <div className={css.secBody}>
            <div className={css.stat}>
              <span className={css.statChip}>共 {INBOUND.length} 个监听面</span>
              <span className={css.statChip}>{INBOUND.length} 条默认关闭</span>
            </div>
            <div className={css.rows}>
              {INBOUND.map((e) => <SurfaceRow key={e.label} e={e} />)}
            </div>
            <p className={css.keyBox}>
              与出网点不同，这一条<b>只在你点「打开网页」时临时开启</b>：
              没有常驻开关，也不在启动时监听；点卡片返回即停服，本应用恢复「一个端口都不监听」。
            </p>
          </div>
        </details>

        <details className={css.sec}>
          <summary className={css.secTitle}>数据在本机处理</summary>
          <div className={css.secBody}>
            <p className={css.p}>
              微信数据库在本机解密、存储与分析；检索、统计、导出、图谱、账本、备份全部为纯本地操作。
            </p>
            <p className={css.keyBox}>我们没有任何服务器，不会上传你的聊天记录、图片或导出物。</p>
          </div>
        </details>

        <details className={css.sec}>
          <summary className={css.secTitle}>只读扫描微信进程内存（取解密密钥）</summary>
          <div className={css.secBody}>
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
            <p className={css.p}>
              唯一例外：<b>设置 → 图片解码 → 微信原图自动下载</b>（<b>默认关闭</b>）——
              你显式打开后，应用会向微信进程注入上游 MIT 组件，让微信自己下载新图片的原图；
              关闭或退出时请求还原，崩溃后微信可能保持被修改状态直到重启（界面会提示）。
              详见声明 §一.5。
            </p>
          </div>
        </details>

        <details className={css.sec}>
          <summary className={css.secTitle}>你的控制</summary>
          <div className={css.secBody}>
            <div className={css.rows}>
              {CONTROLS.map((c) => (
                <div key={c.label} className={`${css.row} ${css.rowSimple}`}>
                  <span className={css.rowLabel}>{c.label}</span>
                  <span className={css.rowText}>{c.text}</span>
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>

      {/* 同意区（勾选 + 两个按钮）在滚动区**外面**：单列滚动时它钉在容器底部，
          不随正文滚走；用 flex 布局而不是 `position: sticky/fixed`（那会压在正文上，
          `consent.spec.ts` 钉着 `.consentBar` 不许变成浮层）。 */}
      <div className={css.consentBar}>
        <label className={css.consent} data-on={checked || undefined}>
          <input
            type="checkbox"
            className={css.consentBox}
            checked={checked}
            onChange={(e) => { setChecked(e.target.checked) }}
          />
          <span className={css.consentText}>
            <b>我已阅读并理解上述数据处理方式</b>，同意本应用读取本机微信数据、只读扫描微信进程内存以获取解密密钥，
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
