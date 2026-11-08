import { useCallback, useState } from 'react'
import type { WechatLlmConfig } from '../api.ts'
import { AiModelPanel } from './ai-model-panel.tsx'
import { EmbedPanelBody, RerankPanelBody } from './ai-model-roles.tsx'
import css from './ai-model.module.css'

export interface AiModelAdvancedProps {
  cfg: WechatLlmConfig
  onPatch: (patch: Partial<WechatLlmConfig>) => void
}

/**
 * 知识库与精排能力。
 *
 * 对话模型是主流程，始终展开；向量与重排序只在特定场景需要，因此默认折叠，
 * 避免把最常改的表单埋在长页面里。
 */
export function AiModelAdvanced({ cfg, onPatch }: AiModelAdvancedProps): React.JSX.Element {
  const [open, setOpen] = useState<Record<'embed' | 'rerank', boolean>>({ embed: false, rerank: false })
  const toggle = useCallback((id: 'embed' | 'rerank'): void => {
    setOpen((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  return (
    <section className={css.advancedSection} aria-labelledby="ai-model-advanced-title">
      <header className={css.advancedHead}>
        <div>
          <span className={css.sectionKicker}>高级能力</span>
          <h2 className={css.advancedTitle} id="ai-model-advanced-title">知识库与精排</h2>
          <p className={css.advancedDesc}>只有建立语义索引或需要精排候选时才用配置；留空会自动回落到本地流程。</p>
        </div>
        <span className={css.advancedCount}>
          {cfg.embeddingModel ? '向量已启用' : '向量跟随对话'} · {cfg.rerankModel ? '精排已启用' : '本地排序'}
        </span>
      </header>

      <AiModelPanel
        id="embed"
        title="嵌入模型"
        subtitle="知识库与语义检索使用；更换模型后已有索引需要重建"
        status={cfg.embeddingModel
          ? { text: cfg.embeddingModel, tone: 'ok' }
          : { text: '跟随对话模型', tone: 'idle' }}
        open={open.embed}
        onToggle={() => { toggle('embed') }}
      >
        <EmbedPanelBody cfg={cfg} onPatch={onPatch} />
      </AiModelPanel>

      <AiModelPanel
        id="rerank"
        title="重排序模型"
        subtitle="把召回候选按相关性精排；留空则使用本地加权排序"
        status={cfg.rerankModel
          ? { text: cfg.rerankModel, tone: 'ok' }
          : { text: '未启用（本地排序）', tone: 'idle' }}
        open={open.rerank}
        onToggle={() => { toggle('rerank') }}
      >
        <RerankPanelBody cfg={cfg} onPatch={onPatch} />
      </AiModelPanel>
    </section>
  )
}
