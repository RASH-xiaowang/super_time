/**
 * 向量 / 重排序两块面板的内容（2026-09-30 从 `AiModelConfig` 拆出，重做时按用户要求
 * 让它们与「对话模型」并列成独立板块）。
 *
 * 两块各自带**自己的测试按钮**（`LlmProbeButton`）与结果行 —— 这是上一个缺口的直接修法：
 * 三套端点的地址 / Key / 路径本来就可以不同（实测有「对话用 DeepSeek、向量与精排用
 * SiliconFlow」这种组合），把测试按钮只放在对话模型那边等于没测后两条。
 *
 * 两条口径刻意保留在文案里（都是踩过的坑）：
 *   · 地址与 Key **留空回落上一套**（同厂商是常态；自建向量服务与云端对话并存时才分开填）；
 *   · 重排序**没有独立开关**：填了模型名就启用，留空则整段跳过、由本地启发式排序。
 */
import type { WechatLlmConfig } from '../api.ts'
import { LlmProbeButton } from './llm-probe.tsx'
import css from './ai-model.module.css'
import setCss from './settings.module.css'

/** 一块面板里的单行输入（标签 + 输入框）。 */
export function RoleInput({ label, value, placeholder, onInput, type = 'text' }: {
  label: string
  value: string
  placeholder: string
  onInput: (v: string) => void
  type?: 'text' | 'number'
}): React.JSX.Element {
  return (
    <label className={css.modelField}>
      <span className={setCss.rowName}>{label}</span>
      <input
        className={css.modelInput}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onInput(e.target.value) }}
      />
    </label>
  )
}

export interface RolePanelBodyProps {
  /** 当前表单草稿配置。 */
  cfg: WechatLlmConfig
  /** 局部更新（只改这几个字段，不动别的）。 */
  onPatch: (patch: Partial<WechatLlmConfig>) => void
}

/**
 * 嵌入模型面板的内容：模型 / 端点 / Key + 一条测试。
 * @param props - 草稿配置与更新函数。
 * @returns 面板内容。
 */
export function EmbedPanelBody({ cfg, onPatch }: RolePanelBodyProps): React.JSX.Element {
  return (
    <>
      <div className={css.modelGrid}>
        <RoleInput
          label="向量模型（留空复用对话模型）"
          value={cfg.embeddingModel ?? ''}
          placeholder="如 text-embedding-3-small / bge-m3"
          onInput={(v) => { onPatch({ embeddingModel: v }) }}
        />
        <RoleInput
          label="向量端点（留空复用对话模型的 API 地址）"
          value={cfg.embeddingApiUrl ?? ''}
          placeholder="如 https://api.siliconflow.cn/v1"
          onInput={(v) => { onPatch({ embeddingApiUrl: v }) }}
        />
        <RoleInput
          label="向量 API Key（留空复用对话模型的 Key）"
          value={cfg.embeddingApiKey ?? ''}
          placeholder="sk-..."
          onInput={(v) => { onPatch({ embeddingApiKey: v }) }}
        />
        <RoleInput
          label="向量接口路径（默认 /embeddings）"
          value={cfg.embedPath ?? ''}
          placeholder="/embeddings"
          onInput={(v) => { onPatch({ embedPath: v }) }}
        />
      </div>
      <p className={css.roleTip}>
        换掉向量模型后，各知识库的向量需要**重建**（下次语义检索会再次出网）。
      </p>
      <LlmProbeButton kind="embed" cfg={cfg} label="测试向量" />
    </>
  )
}

/**
 * 重排序模型面板的内容：模型 / 端点 / Key / 超时 + 一条测试。
 * @param props - 草稿配置与更新函数。
 * @returns 面板内容。
 */
export function RerankPanelBody({ cfg, onPatch }: RolePanelBodyProps): React.JSX.Element {
  return (
    <>
      <div className={css.modelGrid}>
        <RoleInput
          label="重排序模型（填了就启用；留空则整段跳过）"
          value={cfg.rerankModel ?? ''}
          placeholder="如 bge-reranker-v2-m3 / Qwen3-Reranker"
          onInput={(v) => { onPatch({ rerankModel: v }) }}
        />
        <RoleInput
          label="重排序端点（留空复用对话模型的 API 地址）"
          value={cfg.rerankApiUrl ?? ''}
          placeholder="如 https://api.siliconflow.cn/v1"
          onInput={(v) => { onPatch({ rerankApiUrl: v }) }}
        />
        <RoleInput
          label="重排序 API Key（留空复用对话模型的 Key）"
          value={cfg.rerankApiKey ?? ''}
          placeholder="sk-..."
          onInput={(v) => { onPatch({ rerankApiKey: v }) }}
        />
        <RoleInput
          label="重排序接口路径（默认 /rerank）"
          value={cfg.rerankPath ?? ''}
          placeholder="/rerank"
          onInput={(v) => { onPatch({ rerankPath: v }) }}
        />
        <label className={css.modelField}>
          <span className={setCss.rowName}>重排序超时（毫秒）</span>
          <input
            className={css.modelInput}
            type="number"
            min={1000}
            step={1000}
            value={cfg.rerankTimeoutMs ?? 20000}
            onChange={(e) => { onPatch({ rerankTimeoutMs: Number(e.target.value) || 20000 }) }}
          />
        </label>
      </div>
      <p className={css.roleTip}>
        它跑在每次提问的热路径上：失败**不会**让问答失败，只是退回本地加权并在依据行写明。
      </p>
      <LlmProbeButton kind="rerank" cfg={cfg} label="测试精排" />
    </>
  )
}
