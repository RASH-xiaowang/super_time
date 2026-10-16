/**
 * 启动页第四屏：**关于**（它是什么 / 数据在哪 · 怎么删 · 怎么断网 / 出问题时）。
 *
 * 三块回答三个首启最关心的问题：装了什么、我的数据在哪、出问题该给什么。
 */
import React from 'react'
import { Reveal } from '../Reveal.tsx'
import css from '../onboarding.module.css'
import cssstages from '../onboarding-stages.module.css'
import { StageHead } from '../stage-chrome.tsx'
import { APP_VERSION, type RuntimeVersions } from '../runtime.ts'

export interface AboutPageProps {
  versions: RuntimeVersions | null
}

export function AboutPage({ versions }: AboutPageProps): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="04"
        title="关于 Super Time"
        lead="它是什么、数据放在哪、怎么彻底删掉，以及出问题时该发什么给我们。"
      />
      <div className={cssstages.aboutLayout}>
        <Reveal>
          <section className={cssstages.aboutBlock}>
            <h3 className={cssstages.aboutTitle}>它是什么</h3>
            <p className={cssstages.aboutText}>
              面向个人的本地微信数据分析桌面应用：Electron 桌面壳 + React 前端 + 独立
              utilityProcess 后端（本机 SQLite）。你机器上的解密库只被它只读使用，
              解析、检索、统计、导出都在本机完成；AI 问答与总结把检索到的片段发给你
              <b>自己配置</b>的模型接口。
            </p>
            <dl className={cssstages.metaList}>
              {/*
                应用版本优先用主进程下发的那个值（`package.json` 是唯一来源）：
                2026-10-12 起 `app:versions` 带上它，`version-consistency.spec.ts` 头注释里
                「根治做法是让渲染层从主进程拿版本」的欠账就此结掉；字面量只在取不到时兜底
                （守卫仍要求它与 package.json 一致，所以兜底值不会静默漂移）。
              */}
              <div className={css.metaRow}><dt>应用版本</dt><dd>{versions?.app ?? APP_VERSION}</dd></div>
              <div className={css.metaRow}><dt>Electron</dt><dd>{versions?.electron ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>Chromium</dt><dd>{versions?.chrome ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>Node</dt><dd>{versions?.node ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>产品名</dt><dd>Super Time</dd></div>
            </dl>
          </section>
        </Reveal>
        <Reveal>
          <section className={cssstages.aboutBlock}>
            <h3 className={cssstages.aboutTitle}>数据在哪 · 怎么删 · 怎么断网</h3>
            <ul className={cssstages.contactList}>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>本机位置</span>
                <span className={cssstages.contactDesc}>
                  %APPDATA%\Super Time 下的 wechat（密钥与配置）与 wechat-data（解密库、图片缓存与索引）；
                  数据根可在设置里改。
                </span>
              </li>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>彻底删除</span>
                <span className={cssstages.contactDesc}>删掉上面两个目录即可；卸载程序不会自动删。</span>
              </li>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>断网使用</span>
                <span className={cssstages.contactDesc}>
                  应用内已没有任何出网开关：断网或在系统防火墙里禁止本应用出站，即可让所有请求都不发生。
                </span>
              </li>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>出网点清单</span>
                <span className={cssstages.contactDesc}>
                  首次启动的「隐私同意」页逐条列出目的地与发什么；同意之后那一站会整体撤下，
                  要再看就从「隐私体检 → 数据边界与出网」进，仓库里对应 docs/PRIVACY.md。
                </span>
              </li>
            </ul>
          </section>
        </Reveal>
        <Reveal>
          <section className={cssstages.aboutBlock}>
            <h3 className={cssstages.aboutTitle}>出问题时</h3>
            <p className={cssstages.aboutText}>
              提交问题或建议时请勿附带密钥或完整聊天内容。
            </p>
            <ul className={cssstages.contactList}>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>带上诊断</span>
                <span className={cssstages.contactDesc}>导出「操作日志」，连同复现步骤一并提交</span>
              </li>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>在线文档</span>
                <span className={cssstages.contactDesc}>仓库 README 与 docs/ 下的 ARCHITECTURE / DEPLOYMENT / PRIVACY</span>
              </li>
              <li className={css.contactItem}>
                <span className={cssstages.contactTitle}>隐私承诺</span>
                <span className={cssstages.contactDesc}>不上传聊天数据；AI 只在你配置的接口处理</span>
              </li>
            </ul>
          </section>
        </Reveal>
      </div>
    </div>
  )
}
