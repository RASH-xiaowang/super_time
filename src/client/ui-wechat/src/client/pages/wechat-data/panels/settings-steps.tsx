
import type { ImageUpgradeResult, OriginalBatchResult, OriginalFetchPlan, WechatAccount, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { Select } from '../ui/kit.tsx'
/**
 * 设置面板的五张流程卡片：检测账号 / 数据库密钥 / 图片密钥 / 图片解码 / 语音转写
 * （M21 第二十九刀自 Settings.tsx 拆出）。
 *
 * 原样搬出：JSX（含 `data-settings-section` 锚点）一字未改，面板侧只剩组件调用；
 * 「状态与副作用留在面板」不变 —— 这些卡片只是把面板的状态/回调当道具用，
 * 状态仍是一份（面板要拿它算左侧导航的完成度与 stepStates）。
 * 依赖靠脚本从「这块里真实用到的面板 import」生成，类型从面板里的声明反推。
*/
import { apiOpenPath } from '../api.ts'
import kitCss from '../ui/kit.module.css'
import { AccountAvatar, MsgSlot, StatusSlot, WHISPER_MODEL_FALLBACK, fmtActive } from './settings-common.tsx'
import { acctCss, css, modelCss } from './settings-css.ts'
import { Button, IconGlobeOutline14, IconPersonalizationOutline16, IconSparkle16, Input, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { clsx } from 'clsx'

/** 检测账号 卡片（面板里的第 1 节）。 */
export interface SettingsDetectSectionProps {
  accounts: readonly WechatAccount[]
  current: (a: WechatAccount) => boolean
  dbDir: string
  dbDirMsg: { kind: 'ok' | 'err'; text: string } | null
  dbFiles: number
  detect: (force?: boolean) => Promise<void>
  detectInfo: { version?: string; install_dir?: string }
  detectMsg: { kind: 'ok' | 'err'; text: string } | null
  detecting: boolean
  pickDbDir: () => Promise<void>
  setDbDir: React.Dispatch<React.SetStateAction<string>>
  useAccount: (a: WechatAccount) => void
}

export function SettingsDetectSection({
  accounts, current, dbDir,
  dbDirMsg, dbFiles, detect,
  detectInfo, detectMsg, detecting,
  pickDbDir, setDbDir, useAccount,
}: SettingsDetectSectionProps): React.JSX.Element {
  return (
      <section className={css.card} data-settings-section="detect">
        <header className={css.cardHd}>
          <span className={css.cardIconChip}><IconGlobeOutline14 size={14} /></span>
          <div className={css.cardTitleBox}>
            <span className={css.cardTitle}>检测账号</span>
            <span className={kitCss.textCaptionTrunc}>扫描本机微信账号与安装目录</span>
          </div>
          <span className={css.cardBadge}>
            <StateDot state={accounts.length > 0 ? 'done' : 'warning'} />
            {accounts.length > 0 ? `${accounts.length} 个账号` : '未检测到微信'}
          </span>
        </header>
        <div className={css.cardBody}>
          <div className={css.stats}>
            <div className={css.statChip}><span className={css.statNum}>{detectInfo.version ?? '—'}</span><span className={kitCss.textCaption}>微信版本</span></div>
            <div className={css.statChip}>
              <span className={css.statNum}>{String(accounts.length)}</span>
              <span className={kitCss.textCaption}>检测账号</span>
            </div>
            <div className={css.statChip}>
              <span className={css.statNum}>{String(dbFiles)}</span>
              <span className={kitCss.textCaption}>数据库文件</span>
            </div>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>微信账号检测</span>
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} icon={detecting ? <span className={css.spin} /> : undefined} onClick={() => { void detect(true) }} disabled={detecting}>
              {detecting ? '检测中…' : '检测本机微信账号'}
            </Button>
          </div>
          <MsgSlot
            placeholder="点击「检测本机微信账号」后，结果实时显示在这里"
            msg={detectMsg}
          />
          <div className={css.row}>
            <span className={css.rowName}>微信安装目录</span>
            <span className={css.rowMeta} title={detectInfo.install_dir ?? ''}>{detectInfo.install_dir ?? '检测中…'}</span>
          </div>
          <div className={acctCss.accounts}>
            {accounts.length > 0 ? accounts.map(a => (
              <div key={a.db_dir} className={clsx(acctCss.acct, current(a) && acctCss.acctCurrent)}>
                <AccountAvatar wxid={a.wxid} />
                <div className={acctCss.acctMain}>
                  <div className={acctCss.acctTop}>
                    <span className={acctCss.acctName}>{a.wxid}</span>
                    {current(a) && <span className={acctCss.acctBadge}>当前使用</span>}
                  </div>
                  <span className={kitCss.textCaptionTrunc}>
                    {a.db_files !== undefined ? `${a.db_files} 个库文件` : '库文件未知'} · 最近活动 {fmtActive(a.last_active)} · 路径已确认
                  </span>
                  <span className={acctCss.acctPath} title={a.db_dir}>{a.db_dir}</span>
                </div>
                <Button size="sm" variant={current(a) ? 'ghost' : 'primary'} className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { useAccount(a) }} disabled={current(a)}>
                  {current(a) ? '当前使用' : '使用此账号'}
                </Button>
              </div>
            )) : (
              <div className={acctCss.accountsEmpty}>点击「检测本机微信账号」后，可操作的账号将显示在这里</div>
            )}
          </div>
          <div className={css.row}>
            <span className={css.rowName}>数据库目录</span>
            <Input className={css.input} value={dbDir} onChange={(e) => { setDbDir(e.target.value) }} placeholder="留空自动检测本机微信账号" />
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void pickDbDir() }}>选择…</Button>
          </div>
          <MsgSlot
            placeholder="点击「选择…」或账号卡「使用此账号」后，结果实时显示在这里"
            msg={dbDirMsg}
          />
        </div>
      </section>
  )
}

/** 数据库密钥 卡片（面板里的第 2 节）。 */
export interface SettingsDbKeySectionProps {
  autoGetDb: () => Promise<void>
  dbGetting: boolean
  dbKey: string
  dbOpMsg: { kind: 'ok' | 'err'; text: string } | null
  dbProgress: { active: boolean; done: number; total: number; failed: number; message: string }
  decryptAll: () => Promise<void>
  decrypting: boolean
  keyOk: boolean
  keysInfo: { keyFormat?: string; keyCount: number; loaded: boolean }
  setDbKey: React.Dispatch<React.SetStateAction<string>>
  verifyDb: () => Promise<void>
}

export function SettingsDbKeySection({
  autoGetDb, dbGetting, dbKey,
  dbOpMsg, dbProgress, decryptAll,
  decrypting, keyOk, keysInfo,
  setDbKey, verifyDb,
}: SettingsDbKeySectionProps): React.JSX.Element {
  return (
      <section className={css.card} data-settings-section="dbkey">
        <header className={css.cardHd}>
          <span className={css.cardIconChip}><IconPersonalizationOutline16 size={14} /></span>
          <div className={css.cardTitleBox}>
            <span className={css.cardTitle}>数据库密钥</span>
            <span className={kitCss.textCaptionTrunc}>64 位密钥、密钥映射与全库解密</span>
          </div>
          <span className={css.cardBadge}>
            <StateDot state={keyOk ? 'done' : 'warning'} />
            {keyOk ? `${keysInfo.keyCount} 个密钥` : '尚未加载密钥文件'}
          </span>
        </header>
        <div className={css.cardBody}>
          <div className={css.row}>
            <span className={css.rowName}>数据库密钥</span>
            <Input className={css.input} value={dbKey} onChange={(e) => { setDbKey(e.target.value) }} placeholder="64 位 hex 主密钥 / 口令" />
            <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={dbGetting ? <span className={css.spin} /> : undefined} onClick={() => { void autoGetDb() }} disabled={dbGetting}>
              {dbGetting ? '获取中…' : '一键获取数据库密钥'}
            </Button>
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void verifyDb() }} disabled={dbGetting}>
              校验
            </Button>
          </div>
          <MsgSlot
            placeholder="点击「一键获取数据库密钥」或「校验」后，结果实时显示在这里"
            msg={dbOpMsg}
          />
          <div className={css.row}>
            <span className={css.rowName}>密钥文件概览</span>
            <span className={css.rowMeta}>{keyOk ? `${keysInfo.keyFormat ?? ''} · ${keysInfo.keyCount} 个密钥` : '尚未加载密钥文件'}</span>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>立即解密</span>
            <span className={css.rowMeta}>将 db_storage 下全部 .db 解密写入解密库目录</span>
            <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={decrypting ? <span className={css.spin} /> : undefined} onClick={() => { void decryptAll() }} disabled={decrypting}>
              {decrypting ? '解密中…' : '立即解密'}
            </Button>
          </div>
          <StatusSlot
            placeholder="点击「立即解密」开始，进度与结果实时显示在这里"
            active={dbProgress.active}
            pct={dbProgress.total > 0 ? Math.round((dbProgress.done / dbProgress.total) * 100) : 0}
            text={`解密 ${dbProgress.done}/${dbProgress.total} · 成功 ${dbProgress.done - dbProgress.failed} · 失败 ${dbProgress.failed}`}
            item={dbProgress.message}
            doneText={dbProgress.done > 0 ? `上次解密：成功 ${dbProgress.done - dbProgress.failed}/${dbProgress.total} · 失败 ${dbProgress.failed}` : ''}
            doneKind=""
          />
          <div className={css.row}>
            <span className={css.rowNote}>✅ 自动获取密钥已支持（V4 内存扫描 + Weixin.dll 内部键解掩码，需微信进程运行中）；SQLCipher 全库解密通过「立即解密」完成。</span>
          </div>
        </div>
      </section>
  )
}

/** 图片密钥 卡片（面板里的第 3 节）。 */
export interface SettingsImgKeySectionProps {
  autoGetImg: () => Promise<void>
  imgAes: string
  imgGetting: boolean
  imgOpMsg: { kind: 'ok' | 'err'; text: string } | null
  imgXor: string
  setImgAes: React.Dispatch<React.SetStateAction<string>>
  setImgXor: React.Dispatch<React.SetStateAction<string>>
  verifyImg: () => Promise<void>
}

export function SettingsImgKeySection({
  autoGetImg, imgAes, imgGetting,
  imgOpMsg, imgXor, setImgAes,
  setImgXor, verifyImg,
}: SettingsImgKeySectionProps): React.JSX.Element {
  return (
      <section className={css.card} data-settings-section="imgkey">
        <header className={css.cardHd}>
          <span className={css.cardIconChip}><IconSparkle16 size={14} /></span>
          <div className={css.cardTitleBox}>
            <span className={css.cardTitle}>图片密钥</span>
            <span className={kitCss.textCaptionTrunc}>AES 密钥与 XOR 偏移量管理</span>
          </div>
          <span className={css.cardBadge}>
            <StateDot state={imgAes.trim() !== '' ? 'done' : 'warning'} />
            {imgAes.trim() !== '' ? '已就绪' : '未配置'}
          </span>
        </header>
        <div className={css.cardBody}>
          <div className={css.row}>
            <span className={css.rowName}>图片 AES 密钥</span>
            <Input className={css.input} value={imgAes} onChange={(e) => { setImgAes(e.target.value) }} placeholder="32 位 hex（留空自动）" />
            <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={imgGetting ? <span className={css.spin} /> : undefined} onClick={() => { void autoGetImg() }} disabled={imgGetting}>
              {imgGetting ? '获取中…' : '扫描微信内存'}
            </Button>
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void verifyImg() }} disabled={imgGetting}>
              校验
            </Button>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>XOR key</span>
            <Input className={css.inputNarrow} value={imgXor} onChange={(e) => { setImgXor(e.target.value) }} />
          </div>
          <MsgSlot
            placeholder="点击「扫描微信内存」或「校验」后，结果实时显示在这里"
            msg={imgOpMsg}
          />
          <div className={css.row}>
            <span className={css.rowNote}>✅ 自动获取已支持（V2 模板验证内存扫描，需微信进程运行中）；填写后点击保存即可用于图片离线解码。</span>
          </div>
        </div>
      </section>
  )
}

/** 图片解码 卡片（面板里的第 4 节）。 */
export interface SettingsImgDecodeSectionProps {
  decryptImgs: () => Promise<void>
  imgConcurrency: number
  imgDecryptDetail: { errors: Array<{ file: string; error: string }>; skippedDetails: Array<{ file: string; reason: string }> }
  imgDecrypting: boolean
  imgProgress: { active: boolean; done: number; total: number; failed: number; skipped: number; message: string }
  /** 「升级为原图」的实时进度（与批量解密各持一个，互不串台）。 */
  imgUpgradeProgress: { active: boolean; done: number; total: number; message: string }
  /** 上一次升级的结论；null = 还没跑过。 */
  imgUpgradeResult: ImageUpgradeResult | null
  imgUpgrading: boolean
  /** 「联网补齐原图」：扫描/取回的进行态，null = 空闲。 */
  origBusy: 'scan' | 'fetch' | null
  /** 本次上限（0 = 不限）。 */
  origLimit: number
  /** 上一次盘点（三类答案分开报）。 */
  origPlan: OriginalFetchPlan | null
  origProgress: { active: boolean; done: number; total: number; failed: number; message: string }
  /** 上一次取回的结论；null = 还没跑过。 */
  origResult: OriginalBatchResult | null
  fetchOriginals: () => Promise<void>
  scanOriginals: () => Promise<void>
  setOrigLimit: React.Dispatch<React.SetStateAction<number>>
  setImgConcurrency: React.Dispatch<React.SetStateAction<number>>
  setImgDetailOpen: React.Dispatch<React.SetStateAction<boolean>>
  upgradeImgs: () => Promise<void>
}

export function SettingsImgDecodeSection({
  decryptImgs, imgConcurrency, imgDecryptDetail,
  imgDecrypting, imgProgress, imgUpgradeProgress, imgUpgradeResult,
  imgUpgrading, setImgConcurrency,
  setImgDetailOpen, upgradeImgs,
  fetchOriginals, origBusy, origLimit, origPlan, origProgress, origResult, scanOriginals, setOrigLimit,
}: SettingsImgDecodeSectionProps): React.JSX.Element {
  /** 盘点报告里的「预计下载量」（XML 声明的下界）。 */
  const planMb = origPlan === null ? 0 : Math.round(origPlan.declaredBytes / 1024 / 1024)
  return (
      <section className={css.card} data-settings-section="img">
        <header className={css.cardHd}>
          <span className={css.cardIconChip}><IconGlobeOutline14 size={14} /></span>
          <div className={css.cardTitleBox}>
            <span className={css.cardTitle}>图片解码</span>
            <span className={kitCss.textCaptionTrunc}>批量解密 .dat · 升级已缓存的原图</span>
          </div>
        </header>
        <div className={css.cardBody}>
          <div className={css.row}>
            <span className={css.rowName}>批量解密图片</span>
            <span className={css.rowMeta} title="解密 msg/attach 下所有 .dat 图片到解码缓存，聊天/朋友圈图片即时显示">解密 msg/attach 全部 .dat 到解码缓存</span>
            <Input className={css.inputNarrow} value={String(imgConcurrency)} onChange={(e) => { setImgConcurrency(Number(e.target.value) || 8) }} title="并行线程数" />
            <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={imgDecrypting ? <span className={css.spin} /> : undefined} onClick={() => { void decryptImgs() }} disabled={imgDecrypting || imgUpgrading}>
              {imgDecrypting ? '解密中…' : '立即解密'}
            </Button>
          </div>
          <StatusSlot
            placeholder="点击「立即解密」开始，进度与结果实时显示在这里"
            active={imgProgress.active}
            pct={imgProgress.total > 0 ? Math.round((imgProgress.done / imgProgress.total) * 100) : 0}
            text={`解密 ${imgProgress.done}/${imgProgress.total} · 成功 ${imgProgress.done - imgProgress.failed - imgProgress.skipped} · 跳过 ${imgProgress.skipped} · 失败 ${imgProgress.failed}`}
            item={imgProgress.message}
            doneText={imgProgress.done > 0 ? `上次解密：成功 ${imgProgress.done - imgProgress.failed - imgProgress.skipped}/${imgProgress.total} · 跳过 ${imgProgress.skipped} · 失败 ${imgProgress.failed}` : ''}
            doneKind=""
            detail={imgProgress.done > 0 && (imgDecryptDetail.errors.length > 0 || imgDecryptDetail.skippedDetails.length > 0)
              ? <button type="button" className={acctCss.slotDetailBtn} onClick={() => { setImgDetailOpen(true) }}>详情</button>
              : undefined}
          />
          <div className={css.row}>
            <span className={css.rowName}>升级为原图</span>
            <span className={css.rowMeta} title="把**已经解出来**的图按本机现存最好的一档重解（含 wxgf 原图转码）；只有严格更大的那一份才会覆盖缓存，不联网">把已缓存的图重解成本机最好的那一份</span>
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixed)} icon={imgUpgrading ? <span className={css.spin} /> : undefined} onClick={() => { void upgradeImgs() }} disabled={imgUpgrading || imgDecrypting}>
              {imgUpgrading ? '升级中…' : '立即升级'}
            </Button>
          </div>
          <StatusSlot
            placeholder="点击「立即升级」开始，进度与结果实时显示在这里"
            active={imgUpgradeProgress.active}
            pct={imgUpgradeProgress.total > 0 ? Math.round((imgUpgradeProgress.done / imgUpgradeProgress.total) * 100) : 0}
            text={`检查 ${imgUpgradeProgress.done}/${imgUpgradeProgress.total} · 已升级 ${imgUpgradeResult?.upgraded ?? 0}`}
            item={imgUpgradeProgress.message}
            doneText={imgUpgradeResult
              ? `上次升级：检查 ${imgUpgradeResult.total} · 已升级 ${imgUpgradeResult.upgraded} · 无需升级 ${imgUpgradeResult.unchanged} · 本机无源 ${imgUpgradeResult.noSource} · 失败 ${imgUpgradeResult.failed}`
              : ''}
            doneKind=""
            detail={imgUpgradeResult && (imgUpgradeResult.errors.length > 0 || (imgUpgradeResult.skippedDetails?.length ?? 0) > 0)
              ? <button type="button" className={acctCss.slotDetailBtn} onClick={() => { setImgDetailOpen(true) }}>详情</button>
              : undefined}
          />
          <div className={css.row}>
            <span className={css.rowName}>联网补齐原图</span>
            <span className={css.rowMeta} title="只取消息里自带的免登录预签名直链（带 tpauthkey 的那一类，个人微信账号常见；企业微信的 wwfile 端点实测需登录态，会被自动排除、不浪费请求）；先「扫描」看能补多少再决定取回。不点「取回」就一张都不取，也不存在任何后台自动取">先扫描看能补多少，再决定取回</span>
            <Input className={css.inputNarrow} value={String(origLimit)} onChange={(e) => { setOrigLimit(Number(e.target.value) || 0) }} title="本次最多取几张（0 = 不限）" />
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} icon={origBusy === 'scan' ? <span className={css.spin} /> : undefined} onClick={() => { void scanOriginals() }} disabled={origBusy !== null}>
              {origBusy === 'scan' ? '扫描中…' : '扫描'}
            </Button>
            <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={origBusy === 'fetch' ? <span className={css.spin} /> : undefined} onClick={() => { void fetchOriginals() }} disabled={origBusy !== null}>
              {origBusy === 'fetch' ? '取回中…' : '开始取回'}
            </Button>
          </div>
          {origPlan !== null && (
            <div className={css.row}>
              <span className={css.rowNote}>
                {`带免登录直链的候选 ${String(origPlan.candidates)} 张（XML 声明合计约 ${String(planMb)} MB，实际以下载为准）`
                  + ` · 本机已有原图 ${String(origPlan.alreadyHd)} 张`
                  + ` · 已取回过 ${String(origPlan.alreadyFetched)} 张`
                  + ` · 只能靠回微信点开 ${String(origPlan.loginRequired)} 张（需要登录态，本应用不取`
                  + (origPlan.wecomDirectLink > 0
                    ? `；其中 ${String(origPlan.wecomDirectLink)} 张虽带链接，但属企业微信下载端点，实测匿名请求一律 403`
                    : '')
                  + '）'}
              </span>
            </div>
          )}
          <StatusSlot
            placeholder="点「扫描」先看能补多少；点「开始取回」后进度与结果实时显示在这里"
            active={origProgress.active}
            pct={origProgress.total > 0 ? Math.round((origProgress.done / origProgress.total) * 100) : 0}
            text={`取回 ${origProgress.done}/${origProgress.total} · 失败 ${origProgress.failed}`}
            item={origProgress.message}
            doneText={origResult
              ? (origResult.blocked !== undefined
                ? `未发起任何请求：${origResult.blocked}`
                : `上次取回：成功 ${origResult.fetched}/${origResult.attempted} 张 · ${(origResult.bytes / 1024 / 1024).toFixed(1)} MB · 失败 ${origResult.failed} · 剩余候选 ${origResult.remaining}`)
              : ''}
            doneKind=""
            detail={origResult && origResult.errors.length > 0
              ? <button type="button" className={acctCss.slotDetailBtn} onClick={() => { setImgDetailOpen(true); }}>详情</button>
              : undefined}
          />
          <div className={css.row}>
            <span className={css.rowNote}>✅ 朋友圈/聊天图片离线解码已支持（本地缓存 .dat 解密），wxgf 原图档会调本机微信解码库转码成可渲染图片；视频格式自动跳过。</span>
          </div>
        </div>
      </section>
  )
}

/** 语音转写 卡片（面板里的第 5 节）。 */
export interface SettingsVoiceSectionProps {
  batchTranscribe: () => Promise<void>
  installEngine: () => Promise<void>
  nativeTranscribe: () => void
  pickWhisperDir: () => Promise<void>
  refreshWhisper: () => Promise<void>
  setWhisperDevice: React.Dispatch<React.SetStateAction<'cpu' | 'gpu'>>
  setWhisperModel: React.Dispatch<React.SetStateAction<string>>
  setWhisperModelsDir: React.Dispatch<React.SetStateAction<string>>
  setWhisperThreads: React.Dispatch<React.SetStateAction<number>>
  skipTranscribe: () => void
  voiceOpMsg: { kind: 'ok' | 'err'; text: string } | null
  whisperDevice: 'cpu' | 'gpu'
  whisperDirMsg: { kind: 'ok' | 'err'; text: string } | null
  whisperDownload: (m: { id: string; name: string }) => Promise<void>
  whisperDownloading: { model: string; file: string; received: number; total: number } | null
  whisperModel: string
  whisperModelsDir: string
  whisperStatus: WhisperStatus | null
  whisperStatusLoading: boolean
  whisperThreads: number
  whisperTranscribing: { active: boolean; done: number; total: number; failed: number; skipped: number; current: string }
}

export function SettingsVoiceSection({
  batchTranscribe, installEngine, nativeTranscribe,
  pickWhisperDir, refreshWhisper, setWhisperDevice,
  setWhisperModel, setWhisperModelsDir, setWhisperThreads,
  skipTranscribe, voiceOpMsg, whisperDevice,
  whisperDirMsg, whisperDownload, whisperDownloading,
  whisperModel, whisperModelsDir, whisperStatus,
  whisperStatusLoading, whisperThreads, whisperTranscribing,
}: SettingsVoiceSectionProps): React.JSX.Element {
  return (
      <section className={css.card} data-settings-section="voice">
        <header className={css.cardHd}>
          <span className={css.cardIconChip}><IconSparkle16 size={14} /></span>
          <div className={css.cardTitleBox}>
            <span className={css.cardTitle}>语音转写（可选）</span>
            <span className={kitCss.textCaptionTrunc}>whisper 引擎与模型管理</span>
          </div>
          <span className={css.cardBadge}>
            <StateDot state={whisperStatus?.engine ? 'done' : 'warning'} />
            {whisperStatus?.engine ? '引擎已就绪' : '待配置引擎'}
          </span>
        </header>
        <div className={css.cardBody}>
          <div className={modelCss.whisperBanner}>
            <div className={modelCss.whisperBannerText}>
              <span className={modelCss.whisperBannerTitle}>本地处理，不上传语音</span>
              <span className={modelCss.whisperBannerDesc}>
                已由微信转写的语音会直接复用数据库文字；其余语音才会交给本地 Whisper，需 whisper.cpp 引擎。
              </span>
            </div>
            <button type="button" className={modelCss.whisperRefresh} onClick={() => { void refreshWhisper() }} disabled={whisperStatusLoading}>
              {whisperStatusLoading ? '检测中…' : '刷新状态'}
            </button>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>转写引擎</span>
            <span className={css.rowMeta} title={whisperStatus?.enginePath ?? ''}>
              {whisperStatusLoading ? '检测中…' : whisperStatus?.engine
                ? `已就绪（${whisperStatus.enginePath ?? whisperStatus.engine}）`
                : '未检测到 whisper.cpp 引擎，可一键下载'}
            </span>
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixed)} icon={whisperDownloading?.model === 'engine' ? <span className={css.spin} /> : undefined}
              disabled={whisperDownloading !== null || Boolean(whisperStatus?.engine)} onClick={() => { void installEngine() }}>
              {whisperDownloading?.model === 'engine' ? '下载中…' : whisperStatus?.engine ? '已安装' : '下载引擎'}
            </Button>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>推理设备</span>
            <span className={css.rowMeta}>CPU 兼容所有设备；NVIDIA GPU 使用 CUDA 加速，失败会自动回退 CPU。</span>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>当前设备</span>
            <div className={modelCss.deviceSeg}>
              <button type="button" className={clsx(modelCss.deviceSegBtn, whisperDevice === 'cpu' && modelCss.deviceSegOn)} onClick={() => { setWhisperDevice('cpu') }}>CPU</button>
              <button type="button" className={clsx(modelCss.deviceSegBtn, whisperDevice === 'gpu' && modelCss.deviceSegOn)} disabled={!whisperStatus?.hasCuda} title={whisperStatus?.hasCuda ? 'NVIDIA GPU（CUDA 加速）' : '未检测到可用的 NVIDIA CUDA 设备或驱动'} onClick={() => { setWhisperDevice('gpu') }}>NVIDIA GPU</button>
            </div>
            <span className={clsx(css.rowMeta, !whisperStatus?.hasCuda && css.rowMetaWarn)}>
              {whisperStatus?.hasCuda ? 'CUDA 可用' : '未检测到可用的 NVIDIA CUDA 设备或驱动。'}
            </span>
          </div>
          <div className={css.row}>
            <span className={css.rowName}>模型目录</span>
            <Input className={css.input} value={whisperModelsDir} onChange={(e) => { setWhisperModelsDir(e.target.value) }} placeholder="留空使用默认目录（<项目>/wechat/whisper）" />
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void pickWhisperDir() }}>选择…</Button>
            <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { const d = whisperModelsDir.trim(); if (d) void apiOpenPath(d) }}>打开</Button>
          </div>
          <MsgSlot
            placeholder="点击「选择…/下载」后，结果实时显示在这里"
            msg={whisperDirMsg}
          />
          <div className={modelCss.gridHd}>
            <span className={modelCss.gridHdTitle}>选择模型</span>
            <span className={kitCss.textCaption}>当前设备：{whisperDevice === 'gpu' ? 'NVIDIA GPU' : 'CPU'}</span>
          </div>
          {/* 2026-09-30 合并（用户要求精简按钮）：原来是六个模型卡片、各带一个「下载」按钮，
              截图里就是这样一排 6 个按钮。现在一个下拉 + 一个按钮：已安装与体积都并进选项文案，
              下载进度显示在按钮下方 —— 信息没丢，按钮从 6 个降到 1 个。 */}
          {(() => {
            const models = whisperStatus?.models ?? WHISPER_MODEL_FALLBACK
            const current = models.find((m) => m.id === whisperModel)
            const downloadingThis = whisperDownloading?.model === whisperModel
            const pct = downloadingThis && whisperDownloading.total > 0
              ? Math.round((whisperDownloading.received / whisperDownloading.total) * 100)
              : 0
            return (
              <div className={modelCss.whisperPick}>
                <Select
                  value={whisperModel}
                  onChange={(v) => { setWhisperModel(v) }}
                  ariaLabel="选择语音识别模型"
                  options={models.map((m) => ({
                    value: m.id,
                    label: `${m.name} · ${m.sizeLabel}${m.installed ? ' · 已安装' : ''}`,
                  }))}
                />
                {downloadingThis ? (
                  <span className={modelCss.modelProgress}>
                    <span className={modelCss.modelProgressTrack}><span className={modelCss.modelProgressFill} style={{ width: `${Math.max(2, pct)}%` }} /></span>
                    <span className={modelCss.modelProgressPct}>{pct}%</span>
                  </span>
                ) : current?.installed ? (
                  <span className={clsx(modelCss.modelDownload, modelCss.modelDownloadDone)}>已就绪</span>
                ) : (
                  <button type="button" className={modelCss.modelDownload} onClick={() => { if (current) void whisperDownload(current) }}>
                    下载
                  </button>
                )}
              </div>
            )
          })()}
          <div className={css.row}>
            <span className={css.rowNote}>
              {whisperStatus?.models.some(m => m.installed)
                ? `已安装 ${whisperStatus.models.filter(m => m.installed).length} 个模型到本机缓存；模型仅本地推理、不上传语音。`
                : '模型从 huggingface.co 下载（失败自动切换 hf-mirror；可用 DSH_WECHAT_WHISPER_MIRROR 指定镜像）；仅本地推理、不上传语音。'}
            </span>
          </div>
          <div className={modelCss.whisperThreads}>
            <span className={modelCss.whisperThreadsLabel}>并发线程数</span>
            <Input className={css.inputNarrow} value={String(whisperThreads)} onChange={(e) => { setWhisperThreads(Math.max(0, Number(e.target.value) || 0)) }} placeholder="0" />
            <span className={css.rowMeta}>0 自动，输入正整数</span>
          </div>
          <div className={modelCss.whisperFooter}>
            <button type="button" className={modelCss.whisperSkip} onClick={() => { skipTranscribe() }}>跳过，查看聊天记录</button>
            <Button variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={whisperTranscribing.active ? <span className={css.spin} /> : undefined} disabled={whisperTranscribing.active} onClick={() => { void batchTranscribe() }}>
              {whisperTranscribing.active ? '转写中…' : '本地批量转文字'}
            </Button>
            <Button variant="outline" className={clsx(css.btnFx, css.btnFixed)} onClick={() => { nativeTranscribe() }}>
              微信原生批量转文字
            </Button>
          </div>
          <StatusSlot
            placeholder="点击「本地批量转文字」后，转写进度实时显示在这里"
            active={whisperTranscribing.active}
            pct={whisperTranscribing.total > 0 ? Math.round((whisperTranscribing.done / whisperTranscribing.total) * 100) : 0}
            text={`转写 ${whisperTranscribing.done}/${whisperTranscribing.total} · 成功 ${whisperTranscribing.done} · 跳过 ${whisperTranscribing.skipped} · 失败 ${whisperTranscribing.failed}`}
            item={whisperTranscribing.current}
            doneText={voiceOpMsg?.text ?? (whisperTranscribing.done > 0 ? `上次转写：成功 ${whisperTranscribing.done}/${whisperTranscribing.total} · 跳过 ${whisperTranscribing.skipped} · 失败 ${whisperTranscribing.failed}` : '')}
            doneKind={voiceOpMsg?.kind ?? ''}
          />
        </div>
      </section>
  )
}
