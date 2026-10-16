'use strict';

/**
 * 宿主层 LLM 配置仓库。
 *
 * 从 `wechat-paths.js` 抽出：路径模块只负责“路径与微信设置”，LLM 的当前配置、
 * profile 集合与切换规则全部住在这里。文件读写通过 `atomic-json.js` 与路径注入，
 * 因此不依赖 `wechat-paths.js` 的内部状态，也避免在测试里用假路径时互相污染。
 */

const fs = require('node:fs');
const path = require('node:path');
const LLM_DEFAULTS = require('../shared/llm-defaults.json');
const atomic = require('./atomic-json');

/** 后端、桥接层与前端共用的唯一默认配置来源。 */
function defaultLlmConfig() {
  // 字段语义见 src/shared/llm-defaults.json；不要在本函数里再次抄写。
  return { ...LLM_DEFAULTS };
}

/**
 * 「一次实际出网要用哪套配置」的唯一解析点。
 *
 * 之前 `llm-bridge.js` 自己逐字段写 `overrides || file || env || default`，探针又
 * 另读一份默认值。任何一侧少抄一个字段或把优先级写反，都不会被行为测试立刻发现。
 * 这里把优先级收成一张表，`llm-bridge.js` 与 `llm-balance.js` 只负责喂入三层来源。
 *
 * 兼容旧语义：空串、0、null、undefined 都视为「这一层没给值」，继续往下一层回落。
 */
const LLM_RESOLVE_FIELDS = [
  { key: 'provider', fileKey: 'provider', envKey: 'SUPERTIME_LLM_PROVIDER', fallback: LLM_DEFAULTS.provider },
  { key: 'model', fileKey: 'model', envKey: 'SUPERTIME_LLM_MODEL', fallback: '' },
  { key: 'apiKey', fileKey: 'apiKey', envKey: 'SUPERTIME_LLM_API_KEY', fallback: '' },
  { key: 'baseUrl', fileKey: 'apiUrl', envKey: 'SUPERTIME_LLM_API_URL', fallback: LLM_DEFAULTS.apiUrl },
  { key: 'apiPath', fileKey: 'apiPath', envKey: 'SUPERTIME_LLM_API_PATH', fallback: LLM_DEFAULTS.apiPath },
  { key: 'embeddingModel', fileKey: 'embeddingModel', envKey: 'SUPERTIME_LLM_EMBED_MODEL', fallback: '' },
  { key: 'embedPath', fileKey: 'embedPath', envKey: 'SUPERTIME_LLM_EMBED_PATH', fallback: LLM_DEFAULTS.embedPath },
  { key: 'embeddingApiUrl', fileKey: 'embeddingApiUrl', envKey: 'SUPERTIME_LLM_EMBED_URL', fallback: '' },
  { key: 'embeddingApiKey', fileKey: 'embeddingApiKey', envKey: 'SUPERTIME_LLM_EMBED_KEY', fallback: '' },
  { key: 'rerankModel', fileKey: 'rerankModel', envKey: 'SUPERTIME_LLM_RERANK_MODEL', fallback: '' },
  { key: 'rerankPath', fileKey: 'rerankPath', envKey: 'SUPERTIME_LLM_RERANK_PATH', fallback: LLM_DEFAULTS.rerankPath },
  { key: 'rerankApiUrl', fileKey: 'rerankApiUrl', envKey: 'SUPERTIME_LLM_RERANK_URL', fallback: '' },
  { key: 'rerankApiKey', fileKey: 'rerankApiKey', envKey: 'SUPERTIME_LLM_RERANK_KEY', fallback: '' },
  { key: 'rerankTimeoutMs', fileKey: 'rerankTimeoutMs', envKey: 'SUPERTIME_LLM_RERANK_TIMEOUT_MS', fallback: LLM_DEFAULTS.rerankTimeoutMs, numeric: true },
  { key: 'timeoutMs', fileKey: 'timeoutMs', envKey: 'SUPERTIME_LLM_TIMEOUT_MS', fallback: LLM_DEFAULTS.timeoutMs, numeric: true },
];

/** 旧实现用 `||` 回落，因此空串与 0 都算「没给值」；这里保持同一口径。 */
function llmFirstValue(...values) {
  const last = values.length - 1;
  for (let i = 0; i < last; i += 1) {
    const value = values[i];
    if (value) return value;
  }
  // 最后一层就是 `a || b || ''` 的最终兜底：空串也是合法的最终结果。
  return values[last];
}

/**
 * 合并三层 LLM 配置，返回 `llm-bridge.js` 使用的扁平形状。
 *
 * @param {object} [inputs]
 * @param {object} [inputs.overrides] - 调用方本次显式覆盖。
 * @param {object} [inputs.file] - `llm.json` 当前顶层配置（键名为 `apiUrl`）。
 * @param {object} [inputs.env] - 环境变量表（测试可注入）。
 * @returns {{provider:string, model:string, apiKey:string, baseUrl:string, apiPath:string,
 *   embeddingModel:string, embedPath:string, embeddingApiUrl:string, embeddingApiKey:string,
 *   rerankModel:string, rerankPath:string, rerankApiUrl:string, rerankApiKey:string,
 *   rerankTimeoutMs:number, timeoutMs:number}}
 */
function resolveLlmConfig(inputs = {}) {
  const overrides = inputs.overrides && typeof inputs.overrides === 'object' ? inputs.overrides : {};
  const file = inputs.file && typeof inputs.file === 'object' ? inputs.file : {};
  const env = inputs.env && typeof inputs.env === 'object' ? inputs.env : {};
  const out = {};
  for (const field of LLM_RESOLVE_FIELDS) {
    const raw = llmFirstValue(overrides[field.key], file[field.fileKey], env[field.envKey], field.fallback);
    out[field.key] = field.numeric ? Number(raw) : raw;
  }
  return out;
}

/**
 * 一条模型配置里「成套」的字段。
 *
 * 为什么必须成套：这些字段描述的是同一家厂商的同一次连接；只换其中几项会拼出
 * 「A 家的地址 + B 家的 Key」，下一次提问必然 401，而用户从界面上看不出问题。
 */
const LLM_PROFILE_FIELDS = [
  'provider', 'model', 'apiKey', 'apiUrl', 'apiPath', 'timeoutMs',
  'embeddingModel', 'embedPath', 'embeddingApiUrl', 'embeddingApiKey',
  'rerankModel', 'rerankPath', 'rerankApiUrl', 'rerankApiKey', 'rerankTimeoutMs',
];

/**
 * 取一份配置里**确实存在**的成套字段（profile 的载荷）。
 * 缺失的字段不填空串，交给默认值补；超时字段只接受正数。
 */
function pickLlmProfileFields(src) {
  const out = {};
  for (const k of LLM_PROFILE_FIELDS) {
    if (!src || src[k] === undefined || src[k] === null) continue;
    out[k] = src[k];
  }
  for (const key of ['timeoutMs', 'rerankTimeoutMs']) {
    if (out[key] === undefined) continue;
    const ms = Number(out[key]);
    out[key] = Number.isFinite(ms) && ms > 0 ? ms : defaultLlmConfig()[key];
  }
  return out;
}

/** 收敛一条 profile：补缺省字段、id/label 可读、usedAt 数值化。 */
function normalizeLlmProfile(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : String(fallbackId || '');
  if (!id) return null;
  const base = defaultLlmConfig();
  const cfg = { ...pickLlmProfileFields(raw) };
  // 成套字段：缺就是缺，**不继承全局默认的 apiUrl**（否则「缺地址与 Key」的闸门形同虚设）。
  if (typeof cfg.provider !== 'string' || !cfg.provider) cfg.provider = 'openai-compat';
  if (typeof cfg.model !== 'string') cfg.model = '';
  if (typeof cfg.apiKey !== 'string') cfg.apiKey = '';
  if (typeof cfg.apiUrl !== 'string') cfg.apiUrl = '';
  if (typeof cfg.embeddingModel !== 'string') cfg.embeddingModel = '';
  // 嵌入/精排的独立凭据与地址：留空是**有意的**（= 复用 chat 那对），所以只收敛类型不改默认。
  for (const key of ['embeddingApiUrl', 'embeddingApiKey', 'rerankModel', 'rerankApiUrl', 'rerankApiKey']) {
    if (typeof cfg[key] !== 'string') cfg[key] = '';
  }
  // 协议旋钮：界面上从不暴露，缺失（或空串）就按默认 —— 与读取端一致。
  if (typeof cfg.apiPath !== 'string' || !cfg.apiPath) cfg.apiPath = base.apiPath;
  if (typeof cfg.embedPath !== 'string' || !cfg.embedPath) cfg.embedPath = base.embedPath;
  if (typeof cfg.rerankPath !== 'string' || !cfg.rerankPath) cfg.rerankPath = base.rerankPath;
  const ms = Number(cfg.timeoutMs);
  cfg.timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : base.timeoutMs;
  const rms = Number(cfg.rerankTimeoutMs);
  cfg.rerankTimeoutMs = Number.isFinite(rms) && rms > 0 ? rms : base.rerankTimeoutMs;
  const label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim().slice(0, 40)
    : (cfg.model ? `${cfg.provider} · ${cfg.model}` : cfg.provider);
  return { id, label, usedAt: Number.isFinite(Number(raw.usedAt)) ? Number(raw.usedAt) : 0, ...pickLlmProfileFields(cfg) };
}

/** 自动派生的 label（用于判断用户有没有自己改过名字）。 */
function autoLlmLabel(p) {
  return p.model ? `${p.provider} · ${p.model}` : p.provider;
}

/** 下一个 profile id：单调递增，删掉中间某条也不复用编号。 */
function nextLlmProfileId(profiles) {
  let max = 0;
  for (const p of profiles || []) {
    const m = /^p(\d+)$/.exec(String(p && p.id ? p.id : ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'p' + (max + 1);
}

/**
 * @param {object} [options]
 * @param {() => string} options.getConfigPath - 返回 `llm.json` 绝对路径。
 * @returns {object} LLM 配置仓库。
 */
function createLlmConfigStore(options = {}) {
  const getConfigPath = options.getConfigPath;
  if (typeof getConfigPath !== 'function') {
    throw new Error('createLlmConfigStore: missing getConfigPath');
  }

  /** 读取 LLM 配置（缺失时返回默认值）。 */
  function loadLlmConfig() {
    const base = defaultLlmConfig();
    try {
      const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
      for (const k of Object.keys(base)) {
        if (raw[k] !== undefined) base[k] = raw[k];
      }
    } catch (e) {
      // 首次运行（ENOENT）或文件损坏：用默认值，但损坏要留下可读痕迹（同指纹只报一次）
      atomic.warnCorruptOnce(getConfigPath(), e);
    }
    return base;
  }

  /** 写入 llm.json（原子写 + 内容损坏时先备份）。 */
  function writeLlmFile(payload) {
    const target = getConfigPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomic.preserveIfUnparseable(target);
    atomic.writeFileAtomic(target, JSON.stringify(payload, null, 2) + '\n');
  }

  /** 读 llm.json 原文；缺失或损坏时返回 {}（损坏由 warnCorruptOnce 报一次）。 */
  function readLlmRaw() {
    try {
      const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      atomic.warnCorruptOnce(getConfigPath(), e);
      return {};
    }
  }

  /**
   * 读「当前生效配置 + 已保存的模型配置」。
   *
   * 顶层扁平字段**仍是当前生效值的权威**：`loadLlmConfig`（每次请求都会调）与旧版本读取
   * 都只认它，所以升级、回退都不会坏。`profiles` / `activeProfileId` 是新增的配置集。
   */
  function loadLlmStore() {
    const base = defaultLlmConfig();
    const raw = readLlmRaw();
    const config = { ...base };
    for (const k of Object.keys(base)) if (raw[k] !== undefined) config[k] = raw[k];
    let profiles = [];
    if (Array.isArray(raw.profiles)) {
      const seen = new Set();
      profiles = raw.profiles
        .map((p, i) => normalizeLlmProfile(p, 'p' + (i + 1)))
        .filter((p) => {
          if (!p) return false;
          // 手工编辑过的文件可能写出两条同 id：留着会让「切换」指向不确定的那条。
          if (seen.has(p.id)) return false;
          seen.add(p.id);
          return true;
        });
    }
    let activeProfileId = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : '';
    if (profiles.length === 0 && (config.model || config.apiKey)) {
      const migrated = normalizeLlmProfile(pickLlmProfileFields(config), 'p1');
      if (migrated) {
        profiles = [migrated];
        activeProfileId = migrated.id;
      }
    }
    if (!profiles.some((p) => p.id === activeProfileId)) activeProfileId = profiles.length > 0 ? profiles[0].id : '';
    return { config, profiles, activeProfileId };
  }

  /** 落盘：顶层扁平字段（当前生效值）+ profiles + activeProfileId。 */
  function persistLlmStore(store) {
    const base = defaultLlmConfig();
    const flat = {};
    for (const k of Object.keys(base)) flat[k] = store.config && store.config[k] !== undefined ? store.config[k] : base[k];
    writeLlmFile({ ...flat, profiles: store.profiles, activeProfileId: store.activeProfileId });
  }

  /**
   * 保存「当前配置」表单。
   *
   * 顶层扁平字段照旧写入（老路径不变）；同时**更新使用中的那条 profile** ——
   * 否则「改了表单再保存」之后切换条上显示的还是旧值，点它反而会把刚做的改动顶掉。
   */
  function saveLlmConfig(cfg) {
    const base = defaultLlmConfig();
    const merged = { ...base };
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    for (const k of Object.keys(base)) if (src[k] !== undefined) merged[k] = src[k];
    // 两个超时是数值，**落盘前**就收敛干净。不能指望读取端那句 `Number(x || 默认)`：
    // 它对 0 有效、对 -5 无效，而 `setTimeout(-5)` 会让请求在发出的同一刻被 abort ——
    // 界面上只看到「模型调用失败」，查不到是自己写进去的坏值。
    for (const k of ['timeoutMs', 'rerankTimeoutMs']) {
      const ms = Number(merged[k]);
      merged[k] = Number.isFinite(ms) && ms > 0 ? ms : base[k];
    }
    const store = loadLlmStore();
    let { profiles, activeProfileId } = store;
    let at = profiles.findIndex((p) => p.id === activeProfileId);
    if (at < 0) {
      // 还没有任何 profile：把这次保存的配置补建成第一条。
      const created = normalizeLlmProfile(
        { ...pickLlmProfileFields(merged), usedAt: Date.now() },
        nextLlmProfileId(profiles),
      );
      if (created && (created.model || created.apiKey)) {
        profiles = [...profiles, created];
        activeProfileId = created.id;
        at = profiles.length - 1;
      }
    }
    if (at >= 0) {
      const prev = profiles[at];
      // 名字是用户自己起的就保留；还是自动派生的就跟着新内容重新派生。
      const keepLabel = prev.label && prev.label !== autoLlmLabel(prev) ? prev.label : '';
      const updated = normalizeLlmProfile(
        { ...pickLlmProfileFields(merged), id: prev.id, label: keepLabel, usedAt: Date.now() },
        prev.id,
      );
      if (updated) {
        profiles = profiles.slice();
        profiles[at] = updated;
      }
    }
    persistLlmStore({ config: merged, profiles, activeProfileId });
    return merged;
  }

  /**
   * 切换使用中的模型配置。
   *
   * 成套切换是这里的核心不变量（见 `LLM_PROFILE_FIELDS` 的说明）；因为 llm-bridge.js 每次请求
   * 都重读 llm.json（`llmConfigFromEnv`），切换后**下一次提问立即生效，不需要重启应用**。
   */
  function activateLlmProfile(id) {
    const store = loadLlmStore();
    const want = String(id || '');
    const hit = store.profiles.find((p) => p.id === want);
    if (!hit) throw new Error('这条模型配置已不存在，请刷新后重试');
    if (!hit.model) throw new Error('这条配置没有模型名，无法切换为使用中（请先补全并保存）');
    if (!hit.apiKey && !hit.apiUrl) throw new Error('这条配置缺少 API 地址与 API Key，无法切换为使用中');
    hit.usedAt = Date.now();
    const config = { ...store.config, ...pickLlmProfileFields(hit) };
    persistLlmStore({ config, profiles: store.profiles, activeProfileId: hit.id });
    return { config, profiles: store.profiles, activeProfileId: hit.id };
  }

  /**
   * 新增 / 更新一条模型配置。
   * @param {object} options - { id?: string, label?: string, config?: object, activate?: boolean }
   *   缺 `id` 为新增；`activate` 默认为 true（新增出来就是想用它）。
   */
  function upsertLlmProfile(options = {}) {
    const store = loadLlmStore();
    const src = options.config && typeof options.config === 'object' ? options.config : store.config;
    const id = typeof options.id === 'string' && options.id.trim() ? options.id.trim() : nextLlmProfileId(store.profiles);
    const existing = store.profiles.find((p) => p.id === id);
    const label = typeof options.label === 'string' && options.label.trim()
      ? options.label.trim().slice(0, 40)
      : (existing ? existing.label : '');
    const profile = normalizeLlmProfile({ ...pickLlmProfileFields(src), id, label, usedAt: Date.now() }, id);
    if (!profile) throw new Error('保存模型配置失败：内容无法解析');
    if (!profile.model) throw new Error('保存模型配置失败：模型名不能为空');
    if (!profile.apiKey && !profile.apiUrl) throw new Error('保存模型配置失败：请至少填写 API 地址');
    const profiles = [...store.profiles.filter((p) => p.id !== id), profile];
    const activate = options.activate !== false;
    const activeProfileId = activate ? id : (store.activeProfileId || id);
    const config = activate ? { ...store.config, ...pickLlmProfileFields(profile) } : store.config;
    persistLlmStore({ config, profiles, activeProfileId });
    return { config, profiles, activeProfileId };
  }

  /**
   * 删除一条模型配置。
   *
   * 两条硬规则：① 至少保留一条 —— 删空之后切换条与「已配置」徽标必然互相矛盾；
   * ② 删掉的正是使用中的那条时，自动切到最近使用的一条，否则顶层「当前生效值」会指向
   * 一个已不存在的配置。
   */
  function deleteLlmProfile(id) {
    const store = loadLlmStore();
    const want = String(id || '');
    if (!store.profiles.some((p) => p.id === want)) {
      return { config: store.config, profiles: store.profiles, activeProfileId: store.activeProfileId };
    }
    if (store.profiles.length <= 1) throw new Error('至少保留一条模型配置；不用的话请改成别的厂商');
    const profiles = store.profiles.filter((p) => p.id !== want);
    let activeProfileId = store.activeProfileId;
    let config = store.config;
    if (activeProfileId === want) {
      const next = profiles.slice().sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0))[0];
      activeProfileId = next.id;
      config = { ...store.config, ...pickLlmProfileFields(next) };
    }
    persistLlmStore({ config, profiles, activeProfileId });
    return { config, profiles, activeProfileId };
  }

  return {
    defaultLlmConfig,
    loadLlmConfig,
    saveLlmConfig,
    loadLlmStore,
    activateLlmProfile,
    upsertLlmProfile,
    deleteLlmProfile,
    LLM_PROFILE_FIELDS,
  };
}

module.exports = {
  createLlmConfigStore,
  resolveLlmConfig,
};
