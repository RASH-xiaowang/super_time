import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import { apiFetchLlmModels, type WechatLlmConfig } from '../api.ts'

const MODELS_CACHE_KEY = 'st-llm-models-v1'

export type AiModelMessage = { kind: 'ok' | 'err'; text: string } | null

function keyTag(apiKey: string): string {
  const key = String(apiKey || '')
  return key ? `${key.length}:${key.slice(-4)}` : 'anon'
}

function readModelsCache(apiUrl: string, apiKey: string): string[] {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    if (!raw) return []
    const map = JSON.parse(raw) as Record<string, unknown>
    const hit = map?.[apiUrl]
    if (Array.isArray(hit)) {
      return keyTag(apiKey) === 'anon'
        ? hit.filter((model): model is string => typeof model === 'string')
        : []
    }
    const entry = hit as { models?: unknown; tag?: unknown } | undefined
    if (!entry || entry.tag !== keyTag(apiKey)) return []
    return Array.isArray(entry.models)
      ? entry.models.filter((model): model is string => typeof model === 'string')
      : []
  } catch {
    return []
  }
}

function writeModelsCache(apiUrl: string, apiKey: string, models: string[]): void {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    map[apiUrl] = { models, tag: keyTag(apiKey) }
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(map))
  } catch {
    // 模型列表缓存只影响便利性，写入失败不阻塞配置保存。
  }
}

/**
 * 模型列表与草稿配置解耦：切厂商/换 Key 时先用隔离缓存回填，再按需拉实时列表。
 * 抽成 hook 是为了让 AiModelConfig 只保留页面编排。
 */
export function useAiModelModels(
  config: WechatLlmConfig | null,
  setMessage: (message: AiModelMessage) => void,
  keepMessageRef: MutableRefObject<boolean>,
) {
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<'live' | 'catalog' | null>(null)

  useEffect(() => {
    if (!config) return
    setModels(readModelsCache(config.apiUrl, config.apiKey))
    setSource(null)
    if (keepMessageRef.current) keepMessageRef.current = false
    else setMessage(null)
  }, [config?.apiUrl, config?.apiKey, keepMessageRef, setMessage])

  const fetchModels = useCallback(async (): Promise<void> => {
    if (!config || loading) return
    setLoading(true)
    setMessage(null)
    try {
      const result = await apiFetchLlmModels({ apiUrl: config.apiUrl, apiKey: config.apiKey })
      if (result.models.length === 0) {
        setMessage({ kind: 'err', text: '接口已连接，但没有返回任何模型；仍可直接手输模型名。' })
        setModels([])
        setSource(null)
      } else {
        setModels(result.models)
        setSource(result.source)
        writeModelsCache(config.apiUrl, config.apiKey, result.models)
        setMessage({
          kind: 'ok',
          text: result.source === 'catalog'
            ? `已加载 ${result.models.length} 个内置参考模型；填入 API Key 后可拉取实时列表。`
            : `已获取 ${result.models.length} 个可用模型。`,
        })
      }
    } catch (error) {
      setMessage({ kind: 'err', text: `模型列表获取失败：${(error as Error).message}` })
      setModels(readModelsCache(config.apiUrl, config.apiKey))
      setSource(null)
    } finally {
      setLoading(false)
    }
  }, [config, loading, setMessage])

  return { models, loading, source, fetchModels }
}
