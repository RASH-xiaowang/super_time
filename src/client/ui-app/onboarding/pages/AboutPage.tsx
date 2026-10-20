/**
 * 启动页第四屏：**关于**（它是什么 / 数据在哪 / 出问题时）。
 *
 * 微信化改版（2026-10-19）：
 *   · 版本表压到两行（应用版本 + Electron / Chromium），不再把 Node / 平台 / 产品名
 *     堆成五行的「构建信息墙」—— 那些进诊断日志更有用；
 *   · 数据位置压成一句 + 一个「打开数据目录」按钮（不再重复隐私同意页逐条写过的
 *     删除 / 断网说明，只留一句边界与指向完整声明的出口）；
 *   · 去两栏卡、去键值行的发光字号，全部走灰阶层级。
 */
import React, { useCallback } from 'react'
import { capabilities } from '../../capabilities.ts'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { StageHead } from '../stage-chrome.tsx'
import { APP_VERSION, type RuntimeVersions } from '../runtime.ts'

export interface AboutPageProps {
  versions: RuntimeVersions | null
}

export function AboutPage({ versions }: AboutPageProps): React.JSX.Element {
  /**
   * 在资源管理器中打开数据根：走 `capabilities.shellOpen`（浏览器态没有这个能力，
   * 本页也只在桌面端的首启流程里渲染）。数据根取自主进程 `app:run-mode` 下发的
   * 配置值 —— 用户可能在设置里换过目录，这里不拼死路径。
   */
  const openDataDir = useCallback((): void => {
    if (!capabilities.shellOpen) return
    const api = window.electronAPI
    if (!api?.runMode || !api.showInFolder) return
    void api.runMode().then(async ({ dataRoot }) => {
      if (dataRoot !== '') await api.showInFolder?.(dataRoot)
    }).catch(() => { /* 目录没配置或打不开：设置 → 数据配置 里能看到具体原因 */ })
  }, [])

  return (
    <div className={css.page}>
      <StageHead
        title="关于 Super Time"
        lead="它是什么、数据放在哪，以及出问题时该发什么给我们。"
      />

      <section className={cssstages.aboutBlock}>
        <h3 className={cssstages.aboutTitle}>它是什么</h3>
        <p className={cssstages.aboutText}>
          面向个人的本地微信数据分析桌面应用：Electron 桌面壳 + React 前端 + 独立
          utilityProcess 后端（本机 SQLite）。解密库只被只读使用，解析、检索、统计、导出
          都在本机完成；AI 问答与总结把检索到的片段发给你<b>自己配置</b>的模型接口。
        </p>
        <dl className={cssstages.metaList}>
          {/* 应用版本优先用主进程下发的那个值（`package.json` 是唯一来源）；
              字面量只在取不到时兜底，守卫（version-consistency.spec.ts）要求它与 package.json 一致。 */}
          <div className={css.metaRow}><dt>应用版本</dt><dd>{versions?.app ?? APP_VERSION}</dd></div>
          <div className={css.metaRow}>
            <dt>Electron / Chromium</dt>
            <dd>{versions?.electron ?? '—'} / {versions?.chrome ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className={cssstages.aboutBlock}>
        <h3 className={cssstages.aboutTitle}>数据在哪</h3>
        <p className={cssstages.aboutText}>
          %APPDATA%\Super Time 下的 wechat（密钥与配置）与 wechat-data（解密库、图片缓存与索引）；
          数据根可在设置里改，删掉这两个目录即彻底删除（卸载不会自动删）。
        </p>
        <div className={cssstages.dataActions}>
          <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={openDataDir}>
            打开数据目录
          </button>
          <span className={cssstages.contactDesc}>
            应用内已没有任何出网开关：断网或在系统防火墙里禁止本应用出站，即可让所有请求都不发生。
          </span>
        </div>
      </section>

      <section className={cssstages.aboutBlock}>
        <h3 className={cssstages.aboutTitle}>出问题时</h3>
        <p className={cssstages.aboutText}>
          提交问题或建议时请勿附带密钥或完整聊天内容；带上「操作日志」与复现步骤即可。
          完整的数据与出网声明见首启的「隐私同意」页（之后可从「隐私体检 → 数据边界与出网」重看），
          仓库里对应 docs/PRIVACY.md。
        </p>
      </section>
    </div>
  )
}
