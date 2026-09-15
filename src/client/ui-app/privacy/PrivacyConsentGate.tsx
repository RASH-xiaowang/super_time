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
 *     `src/backend/tests/privacy-statement.spec.ts` 守着不许漂。
 */
import React, { useState } from 'react'

import { PRIVACY_VERSION } from './consent.ts'

/** 与启动引导同一套配色/字体，避免「进来先看到一屏不像本应用的东西」。 */
const BG = '#050a18'
const INK = '#e2e8f0'
const DIM = '#94a3b8'
const ACCENT = '#00f0ff'
const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'

const SECTIONS: ReadonlyArray<{ title: string; lines: readonly string[] }> = [
  {
    title: '数据在本机处理',
    lines: [
      '微信数据库在本机解密、存储与分析；检索、统计、导出、图谱、账本、备份全部为纯本地操作。',
      '我们没有任何服务器，不会上传你的聊天记录、图片或导出物。',
    ],
  },
  {
    title: '只读扫描微信进程内存（取解密密钥）',
    lines: [
      '微信 4.x 的数据库密钥只存在于运行中的微信进程内存里。',
      '「自动获取密钥」会以只读方式扫描 Weixin.exe 的内存区域，用数据库校验命中结果，',
      '不写入、不修改、不注入、不挂钩，也不保存或外发任何内存内容。',
    ],
  },
  {
    title: '会出网的地方（逐条）',
    lines: [
      '· AI 问答与总结：把检索到的聊天片段发给你自己配置的模型接口（可整体关闭、可先打码、有审计）；',
      '· AI embedding：同上，用于向量检索（同一道闸门）；',
      '· 头像图片：本地未缓存时按微信记录的头像地址从腾讯图片 CDN 加载（无开关）；',
      '· 远程图片/视频/公众号封面：本机没有缓存时从微信 CDN 取回（无开关）；',
      '· 地图底图：拉取行政区划 GeoJSON（jsdelivr / unpkg / datav.aliyun，无开关）；',
      '· 语音模型下载：只在你点击下载时访问 huggingface / hf-mirror / github（默认不下载）。',
    ],
  },
  {
    title: '你的控制',
    lines: [
      '主界面「数据配置 → 数据边界与出网」可随时：禁止 AI 出网、开启敏感字段打码、查看/导出出站审计。',
      '删除数据 = 删除 %APPDATA%\\Super Time 下的 wechat 与 wechat-data 目录（安装目录只读，卸载不会带走配置）。',
    ],
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

  return (
    <div style={{
      height: '100vh', overflowY: 'auto', background: BG, color: INK,
      fontFamily: FONT, display: 'flex', justifyContent: 'center', padding: '40px 20px',
    }}>
      <div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '.01em' }}>
            隐私与数据边界
          </h1>
          <p style={{ margin: 0, color: DIM, fontSize: 13, lineHeight: 1.7 }}>
            在开始之前，请确认你了解本应用会读取什么、会往哪里发东西。
            完整声明见仓库里的 <code>docs/PRIVACY.md</code>（声明版本 v{PRIVACY_VERSION}）。
          </p>
        </header>

        {SECTIONS.map((s) => (
          <section key={s.title} style={{
            border: '1px solid rgba(148,163,184,.22)', borderRadius: 12,
            padding: '14px 16px', background: 'rgba(148,163,184,.05)',
          }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: ACCENT }}>{s.title}</h2>
            {s.lines.map((line) => (
              <p key={line} style={{ margin: '0 0 4px', fontSize: 13, lineHeight: 1.75, color: INK }}>{line}</p>
            ))}
          </section>
        ))}

        <label style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
          padding: '12px 16px', borderRadius: 12, border: `1px solid ${checked ? 'rgba(0,240,255,.45)' : 'rgba(148,163,184,.22)'}`,
          background: checked ? 'rgba(0,240,255,.06)' : 'transparent',
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ marginTop: 3, width: 16, height: 16, accentColor: ACCENT }}
          />
          <span style={{ fontSize: 13, lineHeight: 1.7 }}>
            我已阅读并理解上述数据处理方式，同意本应用读取本机微信数据、只读扫描微信进程内存以获取解密密钥，
            并按上述方式使用网络。
          </span>
        </label>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          {onExit && (
            <button type="button" onClick={onExit} style={{
              padding: '10px 18px', borderRadius: 10, cursor: 'pointer', fontFamily: FONT, fontSize: 13,
              border: '1px solid rgba(148,163,184,.35)', background: 'transparent', color: DIM,
            }}>
              不同意并退出
            </button>
          )}
          <button
            type="button"
            disabled={!checked}
            onClick={onAccepted}
            style={{
              padding: '10px 22px', borderRadius: 10, fontFamily: FONT, fontSize: 13, fontWeight: 600,
              cursor: checked ? 'pointer' : 'not-allowed',
              border: '1px solid rgba(0,240,255,.45)',
              background: checked ? 'rgba(0,240,255,.12)' : 'rgba(148,163,184,.08)',
              color: checked ? ACCENT : DIM,
            }}
          >
            同意并继续
          </button>
        </div>
      </div>
    </div>
  )
}
