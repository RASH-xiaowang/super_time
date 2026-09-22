/**
 * 朋友圈的三个浮层：导出对话框 / 图片查看器 / 单条动态详情（M21 第二十三刀自 moments-panel.tsx 拆出）。
 *
 * 拆法：这些块原本长在面板的 return 里，**道具名与面板作用域里的名字完全相同** ⇒ JSX 可以逐行搬过来。
 * 只有两处结构性改动，都写在各组件上方：
 *   · `{cond && (…)}` 换成组件内的「早返回」（否则要包一层 fragment、多一层 DOM 语义）；
 *   · 原来读模块作用域的 `css` / `MEDIA_LABELS` 等改成从 support 模块 import（值一样）。
 * @module moments-portals
 */
import { DateRangeField } from '../ui/kit.tsx'
import { MEDIA_LABELS, type MediaFilter } from './moments-support.tsx'
import css from './moments.module.css'

/** 导出对话框的道具。 */
export interface MomentsExportDialogProps {
  exportOpen: boolean
  setExportOpen: (v: boolean) => void
  authorFilter: string | null
  author: string | null | undefined
  search: string
  mediaFilter: MediaFilter
  monthFilter: string | null
  mineFilter: 'all' | 'mine' | 'others'
  expFormat: string
  setExpFormat: (f: string) => void
  expFrom: string
  setExpFrom: (v: string) => void
  expTo: string
  setExpTo: (v: string) => void
  expDir: string
  pickDir: () => unknown
  pickingDir: boolean
  expImages: boolean
  setExpImages: (v: boolean) => void
  expZip: boolean
  setExpZip: (v: boolean) => void
  doExport: () => unknown
  exporting: boolean
}

/**
 * 「导出朋友圈」对话框。
 *
 * 原先是 `{exportOpen && (<div …>…)}` —— 这里改成早返回：`exportOpen` 为假时返回 null，
 * 为真时返回同一棵子树（DOM 结构与属性一字未改）。
 */
export function MomentsExportDialog({
  exportOpen, setExportOpen, authorFilter, author, search, mediaFilter, monthFilter, mineFilter,
  expFormat, setExpFormat, expFrom, setExpFrom, expTo, setExpTo, expDir, pickDir, pickingDir,
  expImages, setExpImages, expZip, setExpZip, doExport, exporting,
}: MomentsExportDialogProps): React.JSX.Element | null {
  if (!exportOpen) return null
  return (
    <div className={css.overlay} data-st-dialog="moments-export" onClick={() => { setExportOpen(false) }} role="dialog" aria-modal="true">
      <div className={css.lightbox} onClick={(e) => { e.stopPropagation() }}>
        <div className={css.lightboxHead}>
          <span>导出朋友圈</span>
          <button type="button" className={css.btn} onClick={() => { setExportOpen(false) }} aria-label="关闭">×</button>
        </div>
        <div className={css.exportForm}>
          <div className={css.exportField}>
            <span className={css.exportLabel}>格式</span>
            <div className={css.exportChips}>
              {['html', 'json', 'txt', 'csv'].map(f => (
                <button key={f} type="button" className={css.btn} data-on={expFormat === f || undefined} onClick={() => { setExpFormat(f) }}>{f.toUpperCase()}</button>
              ))}
            </div>
          </div>
          <div className={css.exportField}>
            <span className={css.exportLabel}>范围</span>
            <span className={css.exportHint}>
              {(() => {
                const parts: string[] = []
                if (authorFilter) parts.push('作者：' + authorFilter)
                if (author) parts.push('指定用户：' + author)
                if (search.trim()) parts.push('关键词：' + search.trim())
                if (mediaFilter !== 'all') parts.push('类型：' + MEDIA_LABELS[mediaFilter])
                if (monthFilter) parts.push('月份：' + monthFilter)
                if (mineFilter !== 'all') parts.push('范围：' + (mineFilter === 'mine' ? '我' : '他人'))
                return (parts.length > 0 ? parts.join(' · ') : '全部联系人') + ' · 服务端全量'
              })()}
            </span>
          </div>
          <div className={css.exportField}>
            <span className={css.exportLabel}>时间</span>
            <div className={css.exportChips}>
              <DateRangeField
                from={expFrom}
                to={expTo}
                onFrom={setExpFrom}
                onTo={setExpTo}
                onClear={() => { setExpFrom(''); setExpTo('') }}
                presets={['today', 'week', 'month', 'last-7', 'last-30']}
                ariaLabel="朋友圈导出时间"
              />
            </div>
          </div>
          <div className={css.exportField}>
            <span className={css.exportLabel}>目录</span>
            <div className={css.exportChips}>
              <button type="button" className={css.btn} onClick={() => { void pickDir() }} disabled={pickingDir}>选择目录{expDir ? ' ✓' : ''}</button>
              {expDir && <span className={css.exportHint} title={expDir}>{expDir}</span>}
            </div>
          </div>
          <div className={css.exportField}>
            <span className={css.exportLabel}>媒体</span>
            <div className={css.exportChips}>
              <label className={css.exportCheck} title="HTML 导出时内嵌离线解码图片（base64），体积较大">
                <input type="checkbox" checked={expImages} onChange={(e) => { setExpImages(e.target.checked) }} disabled={expFormat !== 'html'} />
                <span>HTML 内嵌离线图片</span>
              </label>
              <label className={css.exportCheck} title="把动态 JSON + 离线图片/视频打包成一个 ZIP（媒体较多时体积大）">
                <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
                <span>ZIP 含媒体</span>
              </label>
            </div>
          </div>
          <button type="button" className={`${css.btn} ${css.btnBottom}`} onClick={() => { void doExport() }} disabled={exporting}>{exporting ? '导出中…' : '导出'}</button>
        </div>
      </div>
    </div>
  )
}
