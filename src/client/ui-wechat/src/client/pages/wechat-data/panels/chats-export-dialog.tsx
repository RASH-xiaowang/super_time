/**
 * 「导出消息」弹窗（#19 第四刀，自 `chats-view.tsx#ChatsView` 那棵 752 行的树里切出）。
 *
 * 为什么先切这一屏：它是本面板里**唯一一处"用户填了半天、一个动作全丢"的地方** ——
 * 遮罩点击的判断（`e.target === e.currentTarget`）写错一次，就是"点在对话框里也关掉"，
 * 而格式/类型/时间范围/目录全是当场选的、没有第二处能看见。它的另一组规则也全是"看着小、
 * 直接影响导出文件里有什么"：类型一个都没选时是**全部**（不是 0 类）、`0` 那格代表「全部」、
 * 导出中必须同时给出「中止」并把主按钮锁住、进度在 `total<=0` 时只能是不确定态。
 *
 * JSX 是逐行搬来的，道具名与原作用域同名 ⇒ 搬动本身不改变渲染；改的是**能不能测**。
 */
import kitCss from '../ui/kit.module.css'
import { DateRangeField, ProgressBar } from '../ui/kit.tsx'
import type { ExpoType, ExpFormat } from './chats-export.tsx'
import csscards from './chats-cards.module.css'
import cssrows from './chats-rows.module.css'
import cssshell from './chats-shell.module.css'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ChatsExportDialogProps {
  EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }>
  EXPO_TYPES: ReadonlyArray<ExpoType>
  cancelExport: () => void
  chooseExportDir: () => Promise<void>
  expCount: number
  expDir: string
  expFilename: string
  expFormat: ExpFormat
  expFrom: string
  expTo: string
  expTypes: readonly string[]
  expZip: boolean
  exportOpen: boolean
  exportProgress: { phase: string; done: number; total: number } | null
  exportSession: () => Promise<void>
  exporting: boolean
  pickingDir: boolean
  setExpCount: React.Dispatch<React.SetStateAction<number>>
  setExpFilename: React.Dispatch<React.SetStateAction<string>>
  setExpFormat: React.Dispatch<React.SetStateAction<ExpFormat>>
  setExpFrom: React.Dispatch<React.SetStateAction<string>>
  setExpTo: React.Dispatch<React.SetStateAction<string>>
  setExpTypes: React.Dispatch<React.SetStateAction<readonly string[]>>
  setExpZip: React.Dispatch<React.SetStateAction<boolean>>
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
}

/** 进度条那一格：没有进度就整块不渲染（弹窗不该凭空长出一条 0% 的杠）。 */
function pctOf(progress: { done: number; total: number }): number {
  return progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0
}

/**
 * 导出消息弹窗。
 * @param props - 弹窗要读的表单值与写回它们的 setter（都来自 `useChatsExport`）。
 * @returns 打开时是整屏对话框，关闭时什么都不渲染。
 */
export function ChatsExportDialog(props: ChatsExportDialogProps): React.JSX.Element | null {
  const {
    EXPO_FORMATS, EXPO_TYPES, cancelExport, chooseExportDir, expCount, expDir, expFilename, expFormat,
    expFrom, expTo, expTypes, expZip, exportOpen, exportProgress, exportSession, exporting, pickingDir,
    setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen,
  } = props
  if (!exportOpen) return null
  return (
    <div className={csscards.calOverlay} data-st-dialog="chats-export" onClick={(e) => { if (e.target === e.currentTarget) setExportOpen(false) }} role="dialog" aria-modal="true">
      <div className={csscards.exportDialog}>
        <div className={cssshell.calHeader}>
          <span className={csscards.calTitle}>导出消息</span>
          <button type="button" className={csscards.calClose} onClick={() => { setExportOpen(false) }}><IconCloseOutline16 size={15} /></button>
        </div>
        <div className={cssshell.exportBody}>
          <div className={cssshell.exportSection}>
            <div className={cssshell.exportSectionHead}>
              <span className={csscards.exportSectionTitle}>格式与内容</span>
              <span className={csscards.exportCountBadge}>{expTypes.length === 0 ? '全部消息' : `${expTypes.length} 类消息`}</span>
            </div>
            <div className={cssshell.exportField}>
              <span className={kitCss.textMeta}>文件格式</span>
              <div className={cssshell.exportFormatGrid}>
                {EXPO_FORMATS.map(f => (
                  <button key={f.value} type="button" className={csscards.exportFormatCard}
                    data-active={expFormat === f.value || undefined}
                    onClick={() => { setExpFormat(f.value as typeof expFormat) }}>
                    <span>{f.label}</span>
                    <i className={csscards.exportRadio} data-active={expFormat === f.value || undefined} />
                  </button>
                ))}
              </div>
            </div>
            <div className={cssshell.exportField}>
              <span className={kitCss.textMeta}>导出条数</span>
              <div className={cssshell.exportChips}>
                {[10, 50, 100, 0].map(n => (
                  <button key={String(n)} type="button" className={cssrows.exportChip} data-active={(expCount === n) || undefined}
                    onClick={() => { setExpCount(n) }}>{n === 0 ? '全部' : String(n) + ' 条'}</button>
                ))}
              </div>
            </div>
            <div className={cssshell.exportField}>
              <div className={cssshell.exportLabelRow}>
                <span className={kitCss.textMeta}>消息类型</span>
                <button type="button" className={csscards.exportLinkBtn}
                  onClick={() => { setExpTypes(prev => prev.length > 0 ? [] : EXPO_TYPES.map(c => c.key)) }}>
                  {expTypes.length > 0 ? '取消全选' : '全选'}
                </button>
              </div>
              <div className={cssshell.exportChips}>
                {EXPO_TYPES.map(c => (
                  <button key={c.key} type="button" className={csscards.exportChipCheck}
                    data-active={expTypes.includes(c.key) || undefined}
                    onClick={() => { setExpTypes(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key]) }}>
                    <i className={csscards.exportCheck} data-active={expTypes.includes(c.key) || undefined}>{expTypes.includes(c.key) ? '✓' : ''}</i>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className={cssshell.exportSection}>
            <div className={cssshell.exportSectionHead}>
              <span className={csscards.exportSectionTitle}>时间范围</span>
              <button type="button" className={csscards.exportLinkBtn} onClick={() => { setExpFrom(''); setExpTo('') }}>全部时间</button>
            </div>
            <div className={cssshell.exportRangeRow}>
              <DateRangeField
                from={expFrom}
                to={expTo}
                onFrom={setExpFrom}
                onTo={setExpTo}
                presets={['today', 'week', 'month', 'last-7', 'last-30']}
                ariaLabel="导出时间范围"
              />
            </div>
          </div>
          <div className={cssshell.exportSection}>
            <div className={cssshell.exportSectionHead}>
              <span className={csscards.exportSectionTitle}>导出文件名</span>
              <span className={cssshell.exportHint}>可选，留空时自动生成</span>
            </div>
            <input type="text" className={csscards.exportInput} placeholder="例如：微信聊天记录_2026-07-11"
              value={expFilename} onChange={(e) => { setExpFilename(e.target.value) }} />
            <label className={cssshell.exportCheckbox}>
              <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
              打包为 ZIP（含导出文件与 record_media.json）
            </label>
          </div>
          <div className={cssshell.exportSection}>
            <div className={cssshell.exportSectionHead}>
              <span className={csscards.exportSectionTitle}>保存目录</span>
            </div>
            <div className={csscards.exportDirBox} data-chosen={(!!expDir.trim()) || undefined}>
              <span className={cssshell.exportDirIcon}>📁</span>
              <div className={cssshell.exportDirInfo}>
                <span className={cssshell.exportDirTitle}>{expDir.trim() ? '已选择保存目录' : '尚未选择保存目录'}</span>
                <span className={kitCss.textCaptionTrunc}>{expDir.trim() ? expDir.trim() : '留空时导出到默认目录 ~/.dsh/wechat-data/exports'}</span>
              </div>
              <button type="button" className={csscards.exportBtn} onClick={() => { void chooseExportDir() }} disabled={pickingDir}>
                {'＋ ' + (pickingDir ? '选择中…' : '选择目录')}
              </button>
            </div>
          </div>
          {/* 实时进度（M3）：后端按 jobId 推 `wechat-export/progress`，
              没有这一段时用户只有一个「导出中…」的按钮可以看，取消也无从下手。 */}
          {exportProgress ? (
            <div className={cssshell.exportField}>
              <ProgressBar value={pctOf(exportProgress)} indeterminate={exportProgress.total <= 0} />
              <span className={kitCss.textCaptionTrunc}>
                {(exportProgress.phase || '导出中') + ' · ' + exportProgress.done + (exportProgress.total ? ' / ' + exportProgress.total : '')}
              </span>
            </div>
          ) : null}
          <div className={cssshell.exportActions}>
            <button type="button" className={csscards.exportBtnGhost} onClick={() => { setExportOpen(false) }}>取消</button>
            {exporting ? (
              <button type="button" className={csscards.exportBtnGhost} onClick={cancelExport}>中止导出</button>
            ) : null}
            <button type="button" className={csscards.exportBtnPrimary} onClick={() => { void exportSession() }} disabled={exporting}>
              {exporting ? '导出中…' : '导出'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
