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
// 同意屏同样要能看到「有新版本可装」：更新是主进程的事，与走到哪一屏无关。
// 这一屏没有设置弹窗，故不传 onOpenLicense。
import { NoticeBanner } from '@deepseek-ai/dsh-client-ui-wechat/notice'
// 与启动引导同一套观感：令牌在本屏被独占渲染时也必须存在（主面板此刻还没挂载）。
import css from './PrivacyConsentGate.module.css'

/** 网络面的开关性质：决定它拿到哪种标记、以及是否被琥珀色框圈起来。
 *  · `none`   —— 没有开关（琥珀色圈出，全页唯一的警示色）
 *  · `manual` —— 只在你点击时才发生
 *  · `off`    —— **默认关闭、且有真开关**（2026-10-14 随入站监听首次出现；
 *                出网侧自 2026-09-30 起已无此档，故它是本屏唯一的青色标记） */
type SwitchKind = 'none' | 'manual' | 'off'

interface SurfaceEntry {
  /** 左栏标签。 */
  label: string
  /** 中栏说明（一句话讲清「什么时候发、发什么」）。 */
  text: string
  /** 目的地主机（等宽字体，看得出是技术事实而不是形容词）。 */
  host?: string
  kind: SwitchKind
  /** 需要额外提醒时的一行 —— 目前只有「头像图片」与「地图底图」这两条用得上。 */
  note?: string
}

const KIND_CHIP: Readonly<Record<SwitchKind, string>> = {
  none: '无开关',
  manual: '仅点击时下载',
  off: '默认关闭 · 可关',
}

/**
 * 标记的配色：`none` 用琥珀（全页唯一的警示色，「关不掉」），其余用中性/青色。
 * `off` 复用既有但一直没被引用的 `.chipToggle`（青色 = 「这一条有真开关」）——
 * 它正是 2026-09-30 拆掉出网开关后空下来的那一档，语义与配色都对得上。
 */
const KIND_CHIP_CLASS: Readonly<Record<SwitchKind, string>> = {
  none: `${css.chip} ${css.chipNone}`,
  manual: `${css.chip} ${css.chipManual}`,
  off: `${css.chip} ${css.chipToggle}`,
}

/**
 * 出网点清单（与 `docs/PRIVACY.md` 第四节 A–G 逐条对应）。
 *
 * 口径提醒（2026-09-30）：应用内的出网开关**已全部移除**（原来的「禁止 AI 出网」
 * 「禁止地图底图出网」与「自动获取原图（CDN）」），所以这里不再有 `可关闭` 这一档 ——
 * 每条都是「无开关」或「仅在你点击时才发生」。要断网只能靠系统防火墙或断网。
 * 图片/头像/视频这一类自 M23 起全部由后端代取，界面自己不再向任何远程主机要图
 * （CSP 的 `img-src` 只放行本机来源）。
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
 * 混在一起会让「共 N 个出网点」这句话变成假话。它是本屏唯一带 `off` 标记的一条 ——
 * 出网侧自 2026-09-30 起已无任何开关，而入站这一条**默认就是关的、且有真开关**。
 */
const INBOUND: ReadonlyArray<SurfaceEntry> = [
  {
    label: '局域网远程访问（手机端）',
    text: '打开「设置 → 远程访问（手机）」后，本机在局域网里监听一个端口（默认 5032），你自己的手机可用浏览器访问同一套界面。访问用一次性配对码换取会话，且只开放一份方法白名单 —— 模型 API Key、许可证、诊断、更新、备份还原、配置写入与全部原生能力（选目录、窗口控制、截图）都不开放',
    host: '本机局域网 IPv4:5032（可在设置里改端口 / 关开关）',
    kind: 'off',
    note: '⚠ 这条链路是明文 HTTP、没有 TLS：在公共 Wi-Fi 或被入侵的路由器下，同网段的人能嗅探到配对码与你查阅的数据（长期令牌不出本机）。只在你信任的局域网里打开，用完就关。应用没有管理员权限、不能替你加防火墙入站规则 —— 首次监听时请在 Windows 弹窗里选「允许」，否则手机连不上。',
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
    label: '远程访问（手机）',
    text: '设置 → 远程访问（手机）：开关（默认关闭）、二维码与局域网地址、轮换令牌。关掉开关即停止监听，轮换令牌会让已连上的手机与未用配对码一起失效。',
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

/** 一条网络面的行：出网与入站共用同一套「标签 / 说明 / 标记」三栏排版。 */
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
      {/* 主动提醒（右下角悬浮）：同意屏上也能看到「有新版本可装」 */}
      <NoticeBanner />
      <div className={css.doc}>
        <header className={css.head}>
          <span className={css.kicker}>首次启动 · 需要你确认</span>
          <h1 className={css.title}>隐私与数据边界</h1>
          <p className={css.sub}>
            开始之前，请确认你了解它会读什么、会往哪里发。
            完整声明见 <code className={css.code}>docs/PRIVACY.md</code>（声明版本 v{PRIVACY_VERSION}）。
          </p>
        </header>

        <div className={css.grid}>
          <div className={css.col}>
            {/* 一句话结论 —— 全页最上面被「圈起来」的一段 */}
            <section className={css.verdict} aria-label="一句话结论">
              <span className={css.verdictTag}>一句话结论</span>
              <ul className={css.verdictList}>
                <li>数据不出本机：解析、检索、统计、导出全部在你自己的电脑上完成。</li>
                <li>
                  唯一会把你<b>内容</b>发出去的是 AI 问答与总结 —— 发给你<b>自己配置</b>的模型接口。
                </li>
                <li>
                  其余出网点都不涉及聊天内容，已在右边逐条列明；应用内已<b>没有任何出网开关</b>，
                  要完全断网请配合系统防火墙或断网。
                </li>
              </ul>
            </section>

            {/* 三节说明**全部常显**（2026-09-29 用户要求移除折叠）：
                折叠会让"知情"变成"需要点开才知情"，直接展开更稳妥。 */}
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
            </section>

            {/* 入站方向单独成节：与出网方向相反（本机监听、别的设备连进来），
                并进上面那节会让「共 N 个出网点」变成假话。 */}
            <section className={css.sec}>
              <div className={css.secHd}>
                <h2 className={css.secTitle}>会被连进来的地方（入站）</h2>
              </div>
              <div className={css.stat}>
                <span className={css.statChip}>共 {INBOUND.length} 个监听面</span>
                <span className={css.statChip}>{INBOUND.length} 条默认关闭</span>
              </div>
              <div className={css.rows}>
                {INBOUND.map((e) => <SurfaceRow key={e.label} e={e} />)}
              </div>
              <p className={css.keyBox}>
                与出网点不同，这一条<b>有真开关、而且默认是关的</b>：不打开「设置 → 远程访问（手机）」，
                本应用一个端口都不监听，别人无法从网络连进来。
              </p>
            </section>
          </div>
        </div>

        {/* 同意区（勾选 + 两个按钮）**在文档流内**（2026-09-30 用户要求：不要悬浮式）。
            它曾在 2026-09-29 被做成吸底条；悬浮条会盖住正文最后一行，也让人误以为它是
            浮层而不是文档的一部分。现在它作为最后一段随流排下，滚到底勾选即可。 */}
        <div className={css.consentBar}>
          <label className={css.consent} data-on={checked || undefined}>
            <input
              type="checkbox"
              className={css.consentBox}
              checked={checked}
              onChange={(e) => { setChecked(e.target.checked) }}
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
    </div>
  )
}
