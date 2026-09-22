/**
 * 微信设置面板 — 按 ST_Wechat_V2「本地检测 → 数据库解密 → 图片密钥 →
 * 图片解密 → 表情/语音」流程重新设计为步骤导航。数据源 / 解密密钥 /
 * 图片密钥 / 图片解码 / 语音转写 五步卡片 + 高级设置（输出目录 · 诊断日志 · 启动引导）。
 * 自动获取密钥（V4 内存扫描 + Weixin.dll 内部键 + V2 图片验证）已支持；
 * SQLCipher 全库解密仍为说明态（本地解密能力独立立项）；语音转写已本地化（whisper.cpp）。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Input, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createPollRegistry, type PollRegistry } from './poll-registry.ts'
import { useTransientNotice } from './hooks.tsx'
import {
  IconGlobeOutline14, IconPersonalizationOutline16, IconRefreshOutline14, IconSettingsOutline14, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { apiAutoGetDbKey, apiAutoGetImageKey, apiDecryptAllDatabases, apiDecryptAllImages, apiDetectWechatAccounts, apiDownloadWhisperModel, apiGenerateKeysFile, apiGetAvatar, apiDiagLogInfo, apiExportDiagLog, apiGetWechatPathConfig, apiOpenPath, apiRevealDiagLog, apiGetDecryptStatus, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWhisperStatus, apiInstallWhisperEngine, apiSaveWechatConfig, apiSetCdnImageEnabled, apiSetCdnImageLocalDecrypt, apiTranscribeVoiceBatch, apiVerifyDatabaseKey, apiVerifyImageKey, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { WechatAccount, WechatConfigFull, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Dialog, PanelHeader } from '../ui/kit.tsx'
import { AiModelConfig } from './AiModelConfig.tsx'
import { PrivacyTrustPanel } from './PrivacyTrust.tsx'
import { BackupPanel } from './Backup.tsx'
import { HealthPanel } from './Health.tsx'
import { HookPanel } from './Hook.tsx'
import { LicenseSection, UpdateSection } from './settings-sections.tsx'
import { CachedSettingsConfig, cacheableConfig, Notice, runWhenIdle, SETTINGS_CONFIG_CACHE_KEY, SETTINGS_SCAN_TTL_MS, SETTINGS_SECRET_FIELDS, StepState, STEP_ICONS, STEPS } from './settings-common.tsx'
import { SettingsDbKeySection, SettingsDetectSection, SettingsImgDecodeSection, SettingsImgKeySection, SettingsVoiceSection } from './settings-steps.tsx'
import { useSettingsState } from './settings-state.tsx'
import { css, modelCss, acctCss } from './settings-css.ts'
import kitCss from '../ui/kit.module.css'
import { avatarColors, fmtBytes } from '../utils/format.ts'


/* 固定高度状态槽:空闲占位 / 实时进度 / 完成结果,始终占位、永不跳动。 */




export interface SettingsPanelProps {
  /** 嵌在弹窗里时：标题栏与关闭按钮由弹窗提供，面板自身不再重复画 PanelHeader。 */
  inDialog?: boolean
  /**
   * 打开时直接落在哪一节。
   *
   * 「数据边界与出网 / 备份恢复 / 数据健康（数据库健康、原图链路自检）」已从外层侧栏迁进本弹窗，
   * 但深链（#privacytrust / #health / #backup …）与跨页跳转（数据总览的风险提示、数据健康的
   * 「数据边界与出网」按钮）仍要落到正确的一节。
   * 弹窗关闭会卸载内容，所以每次重开这个初值都会生效。
   */
  initialSection?: string
  /**
   * 弹窗里装不下的跳转（如「文件资产」「存储分析」）交回宿主：由它关掉弹窗再切主内容区。
   * 装得下的那些（设置 / 数据边界与出网 / 数据健康 …）在弹窗内部切节，不出去。
   */
  onNavigateOut?: (tab: string) => void
}

/**
 * Render the wechat-settings panel.
 * @returns the settings element tree.
 */
export function SettingsPanel({ inDialog = false, initialSection, onNavigateOut }: SettingsPanelProps = {}): React.JSX.Element {
  const {
    accounts, activeKey, autoGetDb, autoGetImg, batchTranscribe, cdnEnabled,
    cdnLocal, cdnMsg, cfg, cfgLoading, clear, current,
    dbDir, dbDirMsg, dbFiles, dbGetting, dbKey, dbOpMsg,
    dbProgress, decryptAll, decryptImgs, decrypting, detect, detectInfo,
    detectMsg, detecting, diagInfo, exportDiagLog, goToSection, imgAes,
    imgConcurrency, imgDecryptDetail, imgDecrypting, imgDetailOpen, imgGetting, imgOpMsg,
    imgProgress, imgXor, innerNavigate, installEngine, keyOk, keysInfo,
    nativeTranscribe, navItems, onPaneScroll, paneRef, pathConfigPath, pickDbDir,
    pickWhisperDir, refreshWhisper, revealDiagLog, save, saveMsg, saving,
    setDbDir, setDbKey, setImgAes, setImgConcurrency, setImgDetailOpen, setImgXor,
    setWhisperDevice, setWhisperModel, setWhisperModelsDir, setWhisperThreads, skipTranscribe, toggleCdn,
    toggleCdnLocal, useAccount, userScrolled, verifyDb, verifyImg, voiceOpMsg,
    whisperDevice, whisperDirMsg, whisperDownload, whisperDownloading, whisperModel, whisperModelsDir,
    whisperStatus, whisperStatusLoading, whisperThreads, whisperTranscribing,
    message,
  } = useSettingsState({ inDialog, initialSection, onNavigateOut })

  return (
    <div className={css.root} data-in-dialog={inDialog || undefined}>
      {!inDialog && (
        <PanelHeader
          title={(
            <>
              <IconSettingsOutline14 size={16} />
              微信数据配置
            </>
          )}
          desc="本地检测 · 数据库密钥 · 图片密钥 · 图片解码 · 语音转写"
        />
      )}
      {/* 左导航 + 右内容：15 节全部堆叠在右侧同一个滚动区里连续滚动（滚到一节末尾自然接
          下一节），左导航是**目录** —— 点击滚到该节，高亮跟着滚动位置走。
          这替换掉了早期「右侧一次只显示一节、切节回到顶部」的做法：那时滚到一节底部就停住，
          想继续看下一节只能回左栏再点一次。 */}
      <div className={css.layout}>
        <nav className={css.navRail} aria-label="设置导航">
          {navItems.map((it, i) => {
            const prev = i > 0 ? navItems[i - 1] : undefined
            return (
              <Fragment key={it.key}>
                {prev?.group !== it.group && <div className={css.navGroupLabel}>{it.group}</div>}
                <button
                  type="button"
                  className={clsx(css.navItem, activeKey === it.key && css.navItemActive)}
                  onClick={() => { goToSection(it.key) }}
                  aria-current={activeKey === it.key ? 'true' : undefined}
                  title={it.label}
                >
                  <span className={css.navIcon}>{it.icon}</span>
                  <span className={css.navBody}>
                    <span className={css.navLabel}>{it.label}</span>
                    <span className={css.navValue}>{it.value}</span>
                  </span>
                  {it.dot ? <StateDot state={it.dot} /> : null}
                </button>
              </Fragment>
            )
          })}
        </nav>

        <div
          className={css.mainScroll}
          ref={paneRef}
          onScroll={onPaneScroll}
          onWheel={() => { userScrolled.current = true }}
        >

      {message && (
        <div className={clsx(css.notice, message.kind === 'ok' ? css.toastOk : css.toastErr)}>
          <div className={css.noticeHead}>
            <span className={css.noticeText}>{message.text}</span>
            <button type="button" className={css.noticeClose} onClick={() => { clear() }} aria-label="关闭提示">✕</button>
          </div>
          {message.details && message.details.length > 0 && (
            <div className={css.noticeDetails}>
              {message.details.slice(0, 20).map((d, i) => <div key={i} className={css.noticeDetailItem}>{d}</div>)}
              {message.details.length > 20 && <div className={css.noticeDetailMore}>…仅显示前 20 条</div>}
            </div>
          )}
        </div>
      )}

        <SettingsDetectSection
          accounts={accounts}
          current={current}
          dbDir={dbDir}
          dbDirMsg={dbDirMsg}
          dbFiles={dbFiles}
          detect={detect}
          detectInfo={detectInfo}
          detectMsg={detectMsg}
          detecting={detecting}
          pickDbDir={pickDbDir}
          setDbDir={setDbDir}
          useAccount={useAccount}
        />

        <SettingsDbKeySection
          autoGetDb={autoGetDb}
          dbGetting={dbGetting}
          dbKey={dbKey}
          dbOpMsg={dbOpMsg}
          dbProgress={dbProgress}
          decryptAll={decryptAll}
          decrypting={decrypting}
          keyOk={keyOk}
          keysInfo={keysInfo}
          setDbKey={setDbKey}
          verifyDb={verifyDb}
        />

        <SettingsImgKeySection
          autoGetImg={autoGetImg}
          imgAes={imgAes}
          imgGetting={imgGetting}
          imgOpMsg={imgOpMsg}
          imgXor={imgXor}
          setImgAes={setImgAes}
          setImgXor={setImgXor}
          verifyImg={verifyImg}
        />

        <SettingsImgDecodeSection
          cdnEnabled={cdnEnabled}
          cdnLocal={cdnLocal}
          cdnMsg={cdnMsg}
          decryptImgs={decryptImgs}
          imgConcurrency={imgConcurrency}
          imgDecryptDetail={imgDecryptDetail}
          imgDecrypting={imgDecrypting}
          imgProgress={imgProgress}
          setImgConcurrency={setImgConcurrency}
          setImgDetailOpen={setImgDetailOpen}
          toggleCdn={toggleCdn}
          toggleCdnLocal={toggleCdnLocal}
        />

        <SettingsVoiceSection
          batchTranscribe={batchTranscribe}
          installEngine={installEngine}
          nativeTranscribe={nativeTranscribe}
          pickWhisperDir={pickWhisperDir}
          refreshWhisper={refreshWhisper}
          setWhisperDevice={setWhisperDevice}
          setWhisperModel={setWhisperModel}
          setWhisperModelsDir={setWhisperModelsDir}
          setWhisperThreads={setWhisperThreads}
          skipTranscribe={skipTranscribe}
          voiceOpMsg={voiceOpMsg}
          whisperDevice={whisperDevice}
          whisperDirMsg={whisperDirMsg}
          whisperDownload={whisperDownload}
          whisperDownloading={whisperDownloading}
          whisperModel={whisperModel}
          whisperModelsDir={whisperModelsDir}
          whisperStatus={whisperStatus}
          whisperStatusLoading={whisperStatusLoading}
          whisperThreads={whisperThreads}
          whisperTranscribing={whisperTranscribing}
        />

        {/* ── AI 大模型（全应用唯一的模型配置入口） ── */}
        <div data-settings-section="ai"><AiModelConfig /></div>

        {/* ── 数据边界与出网（原外层侧栏的独立页，整页迁入本弹窗） ── */}
        <div className={css.embedPane} data-settings-section="boundary">
          <PrivacyTrustPanel embedded />
        </div>

        {/* ── 隐私体检已迁回主界面：它是只读的数据视图（扫描结果 + 风险 TOP10，命中样本
               还要跳回会话），与「配置 / 维护动作」不同类。见 WechatDataPanel 的 renderTab。 ── */}

        {/* ── 软件授权 License ── */}
        <div data-settings-section="license"><LicenseSection /></div>

        {/* ── 软件更新 ── */}
        <div data-settings-section="update"><UpdateSection /></div>

        {/* ── 备份恢复（原外层侧栏项，整页迁入） ── */}
        <div className={css.embedPane} data-settings-section="backup">
          <BackupPanel embedded />
        </div>

        {/* ── 数据库健康 / 原图链路自检（原外层「数据健康」的两个分段） ── */}
        <div className={css.embedPane} data-settings-section="health">
          <HealthPanel embedded onNavigate={innerNavigate} />
        </div>
        <div className={css.embedPane} data-settings-section="hook">
          <HookPanel embedded onNavigate={innerNavigate} />
        </div>

        {/* ── 操作日志已迁回主界面：审计长表在 660px 宽的弹窗右区里翻查很别扭。
               见 WechatDataPanel 的 renderTab。 ── */}

        {/* ── 高级设置（输出路径 · 诊断日志 · 启动引导） ── */}
        <section className={css.card} data-settings-section="advanced">
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconSettingsOutline14 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>高级设置</span>
              <span className={kitCss.textCaptionTrunc}>输出目录 · 诊断日志 · 启动引导</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={cfg?.resolved?.decrypted_dir ? 'done' : 'warning'} />
              {cfg?.resolved?.decrypted_dir ? '路径已解析' : '路径未知'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.row}>
              <span className={css.rowName}>解密输出</span>
              <span className={css.rowMeta}>{cfg?.resolved?.decrypted_dir ?? '—'}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>图片输出</span>
              <span className={css.rowMeta}>{cfg?.resolved?.decoded_image_dir ?? '—'}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>密钥文件</span>
              <span className={css.rowMeta}>{cfg?.resolved?.keys_file ?? '—'}</span>
            </div>
            <div className={css.row}>
              {/* N24：原先这里还有「启用 / 访问令牌 / 监听端口」三个 HTTP API 开关，
                  而全仓没有任何服务端读它们 —— 界面能存、行为为零。已撤下，
                  避免用户以为「关掉端口就等于关掉了外部访问」。 */}
              <span className={css.rowNote}>本应用不提供本地 HTTP 服务：所有能力都经 Remote 直连进程内后端，无需端口与令牌。</span>
            </div>
            {/* 诊断日志（M6）：GUI 态 stdout 会被管道丢弃，crash/报障时只有这份落盘日志 */}
            <div className={css.row}>
              <span className={css.rowName}>诊断日志</span>
              <button type="button" className={modelCss.whisperSkip} onClick={() => { void exportDiagLog() }}>
                导出…
              </button>
              <button type="button" className={modelCss.whisperSkip} onClick={() => { void revealDiagLog() }}>
                打开所在目录
              </button>
              <span className={css.rowMeta} title={diagInfo?.dir ?? ''}>
                {diagInfo ? `${diagInfo.dir} · ${Math.round(diagInfo.bytes / 1024)} KB` : '读取中…'}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>启动引导</span>
              <button
                type="button"
                className={modelCss.whisperSkip}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('super-time:show-onboarding'))
                }}
              >
                重新查看启动页
              </button>
              <span className={css.rowMeta}>清除本地进度并回到首启流程</span>
            </div>
          </div>
        </section>
      </div>

      </div>

      <div className={acctCss.saveBar}>
        <span
          className={acctCss.saveMeta}
          title={pathConfigPath ? `打开路径配置文件：${pathConfigPath}` : '读取路径配置文件…'}
          {...(pathConfigPath ? clickableKey(() => { void apiOpenPath(pathConfigPath) }, { role: 'link' }) : {})}
          style={{
            cursor: pathConfigPath ? 'pointer' : 'default',
            textDecoration: pathConfigPath ? 'underline' : 'none',
            color: pathConfigPath ? 'var(--nm-cyan)' : undefined,
          }}
        >{cfg ? '配置: wechat/config.json ↗' : cfgLoading ? '读取配置…' : ''}</span>
        <span className={saveMsg ? (saveMsg.kind === 'ok' ? acctCss.saveMsgOk : acctCss.saveMsgErr) : acctCss.saveMsgIdle}>
          {saveMsg ? saveMsg.text : '修改后点击「保存配置」生效'}
        </span>
        <Button variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={saving ? <span className={css.spin} /> : undefined} onClick={() => { void save() }} disabled={saving || !cfg}>
          {saving ? '保存中…' : '保存配置'}
        </Button>
      </div>

      <Dialog
        open={imgDetailOpen}
        onClose={() => { setImgDetailOpen(false) }}
        title="图片解密详情"
        footer={(
          <Button size="sm" variant="outline" onClick={() => { setImgDetailOpen(false) }}>关闭</Button>
        )}
      >
        <div className={acctCss.imgDetailBody}>
          {imgDecryptDetail.skippedDetails.length > 0 && (
            <div className={acctCss.imgDetailGroup}>
              <div className={acctCss.imgDetailTitle}>跳过原因（{imgDecryptDetail.skippedDetails.length} 条）</div>
              {Array.from(new Map(imgDecryptDetail.skippedDetails.map(s => [s.reason, (imgDecryptDetail.skippedDetails.filter(x => x.reason === s.reason).length)])).entries()).map(([reason, count]) => (
                <div key={reason} className={acctCss.imgDetailRow}>
                  <span className={acctCss.imgDetailReason}>{reason}</span>
                  <span className={acctCss.imgDetailCount}>×{count}</span>
                </div>
              ))}
            </div>
          )}
          {imgDecryptDetail.errors.length > 0 && (
            <div className={acctCss.imgDetailGroup}>
              <div className={acctCss.imgDetailTitle}>失败原因（{imgDecryptDetail.errors.length} 条）</div>
              {imgDecryptDetail.errors.slice(0, 100).map((f) => (
                <div key={f.file} className={acctCss.imgDetailRow}>
                  <span className={acctCss.imgDetailFile} title={f.file}>{f.file}</span>
                  <span className={acctCss.imgDetailError}>{f.error}</span>
                </div>
              ))}
              {imgDecryptDetail.errors.length > 100 && (
                <div className={acctCss.imgDetailMore}>仅显示前 100 条失败，共 {imgDecryptDetail.errors.length} 条</div>
              )}
            </div>
          )}
          {imgDecryptDetail.errors.length === 0 && imgDecryptDetail.skippedDetails.length === 0 && (
            <div className={acctCss.imgDetailEmpty}>暂无失败或跳过记录</div>
          )}
        </div>
      </Dialog>
    </div>
  )
}
