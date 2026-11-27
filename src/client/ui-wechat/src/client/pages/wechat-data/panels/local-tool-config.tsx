/**
 * 「AI 回复工具」的配置抽屉（2026-11-24）。
 *
 * ## 它解决什么
 *
 * 天气查询与网页搜索这两张卡长期写着「待配置」，而它们的四个配置项此前**没有界面入口** ——
 * 只能手改 `config.json` / `secrets.json`。这个抽屉把入口补上：选数据源、选使用方式、填 Key。
 *
 * ## 两条刻意的设计
 *
 *   · **密钥不回显**：已保存的 Key 只显示「已保存」，输入框恒为空。想换就填新的；
 *     这与任务中心的凭据同一口径（一旦能读回，它就会出现在截图与日志里）。
 *   · **下拉选项来自后端**：`open-meteo` / `brave` 这些字面量只在后端判据里写一次，
 *     前端不复制一份 —— 否则加一个数据源要改两处，漏一处就是「保存成功但工具仍未配置」。
 *
 * @module panels/local-tool-config
 */
import { useEffect, useState } from 'react'
import { Drawer } from '../ui/kit.tsx'
import { apiGetLocalToolConfig, apiSaveLocalToolConfig } from '../api.ts'
import type { LocalToolConfig } from '@deepseek-ai/dsh-wechat-data/types'
import kitCss from '../ui/kit.module.css'
import css from './local-tools.module.css'

/** 表单态（密钥恒从空串开始：不回显）。 */
interface FormState {
  weatherProvider: string
  weatherAccess: string
  weatherApiKey: string
  searchProvider: string
  searchApiKey: string
}

const EMPTY: FormState = {
  weatherProvider: '', weatherAccess: '', weatherApiKey: '', searchProvider: '', searchApiKey: '',
}

/**
 * 配置抽屉。
 * @param props.open - 是否打开。
 * @param props.focus - 打开时先显示哪一段（`weather` / `search`；缺省 = 两段都显示）。
 * @param props.onClose - 关闭。
 * @param props.onSaved - 保存成功（回带新快照）。
 * @returns 抽屉。
 */
export function LocalToolConfigDrawer({ open, focus, onClose, onSaved }: {
  open: boolean
  focus?: 'weather' | 'search'
  onClose: () => void
  onSaved: (config: LocalToolConfig) => void
}): React.JSX.Element {
  const [config, setConfig] = useState<LocalToolConfig | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    setBusy(false)
    setError('')
    setForm(EMPTY)
    apiGetLocalToolConfig()
      .then((snapshot) => {
        if (!alive) return
        setConfig(snapshot)
        setForm({
          weatherProvider: snapshot.weather.provider,
          weatherAccess: snapshot.weather.access,
          weatherApiKey: '',
          searchProvider: snapshot.search.provider,
          searchApiKey: '',
        })
      })
      .catch((e: unknown) => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [open])

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await apiSaveLocalToolConfig({
        weatherProvider: form.weatherProvider,
        weatherAccess: form.weatherAccess,
        searchProvider: form.searchProvider,
        ...(form.weatherApiKey.trim() === '' ? {} : { weatherApiKey: form.weatherApiKey.trim() }),
        ...(form.searchApiKey.trim() === '' ? {} : { searchApiKey: form.searchApiKey.trim() }),
      })
      if (!result.ok || result.config === undefined) {
        setError(result.error ?? '保存失败')
        return
      }
      onSaved(result.config)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const showWeather = focus === undefined || focus === 'weather'
  const showSearch = focus === undefined || focus === 'search'

  return (
    <Drawer open={open} onClose={onClose} title="AI 回复工具配置" width={520}>
      <div className={css.form}>
        <p className={css.fieldHint}>
          这两个工具只在「AI 回复 / 回复助手」生成候选回复时由模型按需调用。密钥只保存在本机
          <code> secrets.json</code>，不会回显，也不会随数据打包。
        </p>

        {showWeather && (
          <div className={css.configBlock}>
            <span className={css.fieldLabel}>天气查询</span>
            <label className={css.field}>
              <span className={css.subLabel}>数据源</span>
              <select
                className={css.input}
                value={form.weatherProvider}
                aria-label="天气数据源"
                onChange={(e) => { setForm((prev) => ({ ...prev, weatherProvider: e.target.value })) }}
              >
                {(config?.weatherProviders ?? [{ value: '', label: '（未选择）' }]).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}{option.hint === undefined ? '' : ` — ${option.hint}`}</option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.subLabel}>使用方式</span>
              <select
                className={css.input}
                value={form.weatherAccess}
                aria-label="天气使用方式"
                onChange={(e) => { setForm((prev) => ({ ...prev, weatherAccess: e.target.value })) }}
              >
                {(config?.weatherAccessModes ?? [{ value: '', label: '（未选择）' }]).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}{option.hint === undefined ? '' : ` — ${option.hint}`}</option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.subLabel}>
                Open-Meteo API Key
                {config?.weather.apiKeySaved === true && <span className={css.savedTag}>已保存</span>}
              </span>
              <input
                className={css.input}
                type="password"
                value={form.weatherApiKey}
                placeholder={config?.weather.apiKeySaved === true ? '已保存；留空表示不修改' : '商用模式才需要，非商用可留空'}
                aria-label="Open-Meteo API Key"
                autoComplete="off"
                onChange={(e) => { setForm((prev) => ({ ...prev, weatherApiKey: e.target.value })) }}
              />
            </label>
          </div>
        )}

        {showSearch && (
          <div className={css.configBlock}>
            <span className={css.fieldLabel}>网页搜索</span>
            <label className={css.field}>
              <span className={css.subLabel}>搜索服务</span>
              <select
                className={css.input}
                value={form.searchProvider}
                aria-label="网页搜索服务"
                onChange={(e) => { setForm((prev) => ({ ...prev, searchProvider: e.target.value })) }}
              >
                {(config?.searchProviders ?? [{ value: '', label: '（未选择）' }]).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}{option.hint === undefined ? '' : ` — ${option.hint}`}</option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              <span className={css.subLabel}>
                Brave API Key
                {config?.search.apiKeySaved === true && <span className={css.savedTag}>已保存</span>}
              </span>
              <input
                className={css.input}
                type="password"
                value={form.searchApiKey}
                placeholder={config?.search.apiKeySaved === true ? '已保存；留空表示不修改' : '在 Brave Search API 控制台创建'}
                aria-label="Brave API Key"
                autoComplete="off"
                onChange={(e) => { setForm((prev) => ({ ...prev, searchApiKey: e.target.value })) }}
              />
            </label>
          </div>
        )}

        {error !== '' && <div className={kitCss.error} role="alert">{error}</div>}

        <div className={css.formActions}>
          <button type="button" className={css.btn} onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className={css.btn} data-primary="true" onClick={() => { void save() }} disabled={busy}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
