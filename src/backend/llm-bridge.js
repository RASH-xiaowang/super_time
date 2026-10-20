'use strict';

/**
 * LLM 桥接层（从 `wechat-host.js` 拆出，M 级大文件治理）。
 *
 * 这一层只负责：LLM 配置解析、OpenAI 兼容请求组装、chat/embed/rerank 的出网与
 * 有界重试。所有 LLM 出网请求统一走 `llm-http.js`，重试实现仍只住在
 * `wechat-data/src/net/fetch-retry.ts`。
 */

const wechatPaths = require('./wechat-paths');
const { llmRequest, parseLlmBaseUrl, joinLlmEndpoint, headersFor } = require('./llm-http');
const { resolveLlmConfig } = require('./llm-config-store');

/** 每次重试打一条日志：重试过程不上界面（成功的重试应当无感），但诊断日志里要留痕。 */
function logRetry(what) {
  return (info) => {
    console.warn(`[llm] ${what} 请求失败（${info.reason}），${info.delayMs}ms 后重试（第 ${info.attempt} 次尝试）`);
  };
}

/** 可注入的 LLM 桥接配置（wechat/llm.json 优先，其次环境变量/覆盖参数）。 */
function llmConfigFromEnv(overrides = {}) {
  return resolveLlmConfig({
    overrides,
    file: wechatPaths.loadLlmConfig(),
    env: process.env,
  });
}

/**
 * 解析「这次 embedding 实际会用哪个模型名」。
 *
 * 单独抽出来是为了让**发送方与记账方拿到同一个值**。此前 gateway 往向量库里记的是
 * `rag-config.embedding.model || 'default'`，而这里真正发出去的是
 * `opts.model || cfg.embeddingModel || cfg.model` —— 两个字符串来自两条互不相通的链，
 * 而 rag-config 那个字段界面配不到、默认空 ⇒ 记进去的恒是字符串 `'default'`。
 * 后果不是难看而是错：向量库判「换没换模型」用的就是这个记录值，恒等于 'default'
 * 意味着**换嵌入模型永远不触发重建**，旧模型的向量被当成新模型的用。
 *  F1 / C4。
 * @param cfg - {@link llmConfigFromEnv} 的结果。
 * @param override - 调用方显式指定的模型名（可空）。
 * @returns 实际生效的模型名；三者都空时为空串（调用方据此判「未配置」）。
 */
function resolveEmbedModel(cfg, override = '') {
  return String(override || cfg.embeddingModel || cfg.model || '');
}

/**
 * 把 dsh-llm 的 Message 内容块投影成 OpenAI 聊天消息。
 *
 * 纯文本仍是一个字符串（保持旧行为）；一旦内容里带图片，就投影成 OpenAI 的
 * `content` parts 数组：`{ type:'text' }` + `{ type:'image_url', image_url:{ url } }`。
 * 图片有两种来源，本层都认：
 *   · `part.image_url.url` —— 调用方已给出 data URL / 远端 URL；
 *   · `part.data` + `part.mediaType` —— ClawBot 自动回复从本机媒体缓存读出的
 *     canonical base64（Super Time 的 mini 宿主没有附件服务，只能直接带字节）。
 * 不认识的块一律按旧口径取 `text`（不静默丢内容）。
 * @param {object} message - dsh-llm 形状的消息。
 * @returns {string|Array<object>} OpenAI 的 content。
 */
function toOpenAiContent(message) {
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: String(message.content ?? '') }];
  const texts = [];
  const images = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image') {
      const remote = part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '';
      const dataUrl = typeof part.data === 'string' && part.data !== ''
        ? `data:${typeof part.mediaType === 'string' && part.mediaType !== '' ? part.mediaType : 'image/jpeg'};base64,${part.data}`
        : '';
      const url = remote !== '' ? remote : dataUrl;
      if (url !== '') images.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    texts.push(String(part.text ?? ''));
  }
  if (images.length === 0) return texts.join('');
  const content = [];
  const text = texts.join('');
  if (text !== '') content.push({ type: 'text', text });
  content.push(...images);
  return content;
}

/** 把 dsh-llm 的 Message 内容块转成 OpenAI 聊天消息。 */
function toOpenAiMessage(message) {
  return { role: message.role ?? 'user', content: toOpenAiContent(message) };
}

/**
 * 极简 LLM 桥：未配置时方法抛错（与上游“未配置默认模型”一致）；
 * 配置了 SUPERTIME_LLM_* 时走 OpenAI 兼容的 /chat/completions。
 *
 * stream() 是**真流式**：以 `stream: true` 发请求并按 SSE 逐块 yielding text-delta，
 * 调用方（gateway）因此可以在生成过程中把增量推给界面。
 * 厂商不支持 SSE 时自动退化为整段返回 —— 一次 yield 完整 text。
 */
/**
 * 把 OpenAI 兼容的 `usage` 归一成 `dsh-llm` 的 {@link TokenUsage} 口径。
 *
 * 两者计数口径不同：dsh-llm 的 `inputTokens` 是**未命中缓存**的输入，缓存命中单独记
 * `cacheReadTokens`；而 OpenAI/DeepSeek 的 `prompt_tokens` 通常把缓存算在里面
 * （DeepSeek 另有 `prompt_cache_hit_tokens`）。这里统一减掉缓存，避免「统计里 input 虚高」。
 * @param {unknown} raw - 供应商返回的 usage 对象。
 * @returns {object|null} TokenUsage；没有可用计数时返回 null（不伪造 0）。
 */
function toTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.round(x) : 0;
  };
  const prompt = n(raw.prompt_tokens ?? raw.input_tokens);
  const completion = n(raw.completion_tokens ?? raw.output_tokens);
  const cached = n(raw.prompt_tokens_details?.cached_tokens
    ?? raw.cache_read_input_tokens
    ?? raw.prompt_cache_hit_tokens);
  const reasoning = n(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens);
  const total = n(raw.total_tokens) || (prompt + completion);
  if (prompt === 0 && completion === 0 && total === 0) return null;
  const usage = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
    totalTokens: total,
  };
  if (cached > 0) usage.cacheReadTokens = cached;
  if (reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

/** chat/stream 的请求组装与出网逻辑；重试只在握手阶段进行。 */
function createChatTransport(configOverrides) {
  /** 组装一次请求所需的 URL / headers / body。 */
  function buildRequest(opts, streamMode, includeUsage = false) {
    const cfg = llmConfigFromEnv(configOverrides);
    const configured = Boolean(cfg.model && (cfg.apiKey || cfg.baseUrl));
    if (!configured) {
      throw new Error('LLM 未配置：请在「微信问答 → 模型配置」中填写模型与 API Key');
    }
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...(opts.messages || []).map(toOpenAiMessage),
    ];
    const base = parseLlmBaseUrl(cfg.baseUrl).base;
    const url = base + (cfg.apiPath.startsWith('/') ? cfg.apiPath : '/' + cfg.apiPath);
    const headers = headersFor(cfg.apiKey, {
      'content-type': 'application/json',
      accept: streamMode ? 'text/event-stream' : 'application/json',
    });
    return {
      cfg,
      url,
      headers,
      body: {
        model: opts.model || cfg.model,
        messages,
        max_tokens: opts.maxTokens ?? 2048,
        stream: streamMode,
        // 只有流式请求需要显式要 usage：OpenAI / DeepSeek 在最后一个 SSE 块里回。
        // 不支持的供应商会在下面按 4xx 文案回退一次（不带这个字段重发）。
        ...(streamMode && includeUsage ? { stream_options: { include_usage: true } } : {}),
      },
    };
  }

  async function fetchCompletion(opts) {
    const req = buildRequest(opts, false);
    // 有界重试：网络抖动 / 429 / 5xx 自动重来，401/400 这类立刻失败。
    const res = await llmRequest(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      timeoutMs: req.cfg.timeoutMs,
      maxAttempts: 3,
      onRetry: logRetry('chat'),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const payload = await res.json();
    return payload?.choices?.[0]?.message?.content ?? '';
  }

  async function* stream(opts) {
    let includeUsage = true;
    let req = buildRequest(opts, true, includeUsage);
    // 只对握手做重试：一旦开始吐 chunk 就不能重来（会重复输出内容）。
    let res = await llmRequest(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      timeoutMs: req.cfg.timeoutMs,
      maxAttempts: 3,
      onRetry: logRetry('chat(stream)'),
    });
    if (!res.ok) {
      let text = await res.text().catch(() => '');
      // 兼容性回退：部分 OpenAI 兼容端点不认 `stream_options`（400/422）。
      // 只在文案明确指向该字段时才重发，避免把真正的鉴权/参数错误吞成第二次请求。
      const retryable = (res.status === 400 || res.status === 422) && includeUsage
        && /stream_options|include_usage|unknown|unsupported|invalid/i.test(text);
      if (retryable) {
        includeUsage = false;
        req = buildRequest(opts, true, false);
        res = await llmRequest(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          timeoutMs: req.cfg.timeoutMs,
          maxAttempts: 3,
          onRetry: logRetry('chat(stream)'),
        });
        if (!res.ok) text = await res.text().catch(() => '');
      }
      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    const contentType = String(res.headers.get('content-type') || '');
    // 厂商忽略 stream:true 直接返回整段 JSON 时走这里（也覆盖 res.body 为空的情况）
    if (!res.body || !contentType.includes('event-stream')) {
      const payload = await res.json();
      const text = payload?.choices?.[0]?.message?.content ?? '';
      const usage = toTokenUsage(payload?.usage);
      if (usage) yield { type: 'usage', usage };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // 心跳/非 JSON 行忽略
        }
        // usage 块通常 choices 为空，必须在取 delta 之前处理。
        const usage = toTokenUsage(parsed?.usage);
        if (usage) yield { type: 'usage', usage };
        const delta = parsed?.choices?.[0]?.delta?.content
          ?? parsed?.choices?.[0]?.message?.content
          ?? '';
        if (!delta) continue;
        full += delta;
        yield { type: 'text-delta', index: 0, text: delta };
      }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: full } };
    yield { type: 'finish', reason: 'stop' };
  }

  return { fetchCompletion, stream };
}

/** 向量化：嵌入端点/Key 优先，留空回落 chat 那一对。 */
async function embedTexts(configOverrides, texts, opts = {}) {
  const cfg = llmConfigFromEnv(configOverrides);
  const model = resolveEmbedModel(cfg, opts.model);
  const baseUrl = cfg.embeddingApiUrl || cfg.baseUrl;
  const apiKey = cfg.embeddingApiKey || cfg.apiKey;
  if (!model || (!apiKey && !baseUrl)) {
    throw new Error('未配置 embedding（请在「数据配置 → AI 大模型」填写向量模型名与端点凭据）');
  }
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
  if (list.length === 0) return [];
  // 容错拼接：用户把完整端点填进 `embeddingApiUrl` 时不再重复拼 `/embeddings`
  // （重复会 404，而后果是稠密通道**静默失效** —— 见 joinLlmEndpoint 的说明）。
  const url = joinLlmEndpoint(baseUrl, cfg.embedPath);
  const res = await llmRequest(url, {
    method: 'POST',
    apiKey,
    body: { model, input: list },
    timeoutMs: cfg.timeoutMs,
    maxAttempts: 3,
    onRetry: logRetry('embedding'),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embedding HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const payload = await res.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];
  // 按 index 排序保证与输入顺序一致（部分厂商不保证返回顺序）。
  const sorted = data.slice().sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
  return sorted.map((d) => (Array.isArray(d?.embedding) ? d.embedding : []));
}

/** 精排：返回按输入下标索引的分数数组，缺项按 0 分而不是抛错。 */
async function rerankDocuments(configOverrides, query, documents, opts = {}) {
  const cfg = llmConfigFromEnv(configOverrides);
  const model = String(opts.model || cfg.rerankModel || '');
  const baseUrl = cfg.rerankApiUrl || cfg.baseUrl;
  const apiKey = cfg.rerankApiKey || cfg.apiKey;
  if (!model || (!apiKey && !baseUrl)) {
    throw new Error('未配置 rerank（请在「数据配置 → AI 大模型」填写重排序模型名与端点凭据）');
  }
  const docs = (Array.isArray(documents) ? documents : []).map((d) => String(d ?? ''));
  if (docs.length === 0) return [];
  // 同上：`rerankApiUrl` 填完整端点时不再重复拼 `/rerank`。
  const url = joinLlmEndpoint(baseUrl, cfg.rerankPath);
  const body = { model, query: String(query ?? ''), documents: docs, return_documents: false };
  if (Number.isFinite(Number(opts.topN)) && Number(opts.topN) > 0) body.top_n = Number(opts.topN);
  const res = await llmRequest(url, {
    method: 'POST',
    apiKey,
    body,
    timeoutMs: cfg.rerankTimeoutMs,
    maxAttempts: 3,
    onRetry: logRetry('rerank'),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rerank HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const payload = await res.json();
  const rows = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload?.data) ? payload.data : []);
  const scores = new Array(docs.length).fill(0);
  for (const r of rows) {
    const i = Number(r?.index);
    if (!Number.isInteger(i) || i < 0 || i >= docs.length) continue;
    const s = Number(r?.relevance_score ?? r?.score ?? r?.relevance ?? 0);
    scores[i] = Number.isFinite(s) ? s : 0;
  }
  return scores;
}

function createLlmBridge(configOverrides = {}) {
  const chat = createChatTransport(configOverrides);

  return {
    get configured() {
      const cfg = llmConfigFromEnv(configOverrides);
      return Boolean(cfg.model && (cfg.apiKey || cfg.baseUrl));
    },
    get config() {
      return llmConfigFromEnv(configOverrides);
    },
    stream: chat.stream,
    embed(texts, opts = {}) {
      return embedTexts(configOverrides, texts, opts);
    },
    /**
     * 这次 embedding 会用的模型名 —— 与 embed 同一个解析函数，
     * 避免「记的模型名与实际发的模型名不是一回事」。
     */
    embeddingModelName(override) {
      return resolveEmbedModel(llmConfigFromEnv(configOverrides), override);
    },
    rerank(query, documents, opts = {}) {
      return rerankDocuments(configOverrides, query, documents, opts);
    },
    /**
     * 这次精排会用的模型名 —— 与 rerank 同一个取值口径。
     */
    rerankModelName(override) {
      const cfg = llmConfigFromEnv(configOverrides);
      return String(override || cfg.rerankModel || '');
    },
    async generate(opts) {
      return { content: await chat.fetchCompletion(opts) };
    },
    listConfigurableProviders() {
      const cfg = llmConfigFromEnv(configOverrides);
      const ok = Boolean(cfg.model && (cfg.apiKey || cfg.baseUrl));
      return ok ? [{ provider: cfg.provider, model: cfg.model }] : [];
    },
    async listModels(provider) {
      const cfg = llmConfigFromEnv(configOverrides);
      if (!cfg.model) return [];
      if (provider && provider !== cfg.provider) return [];
      return [{ id: cfg.model }];
    },
  };
}


module.exports = {
  createLlmBridge,
  llmConfigFromEnv,
  resolveEmbedModel,
  toOpenAiContent,
  toOpenAiMessage,
  toTokenUsage,
};
