'use strict';

/**
 * 微信+路径配置中心
 *
 * 所有路径配置统一记录在项目根目录 `wechat/config.json`：
 *
 *   {
 *     "dataRoot":         "",   // 数据根（默认 <userData>/wechat-data）
 *     "decryptedDir":     "",   // 解密库目录（默认 <dataRoot>/decrypted）
 *     "decodedImagesDir": "",   // 解码图片缓存（默认 <dataRoot>/decoded_images）
 *     "sourceDir":        "",   // 一次性导入源目录
 *     "baseDir":          "",   // 原始微信账号根目录（.dat 回退用）
 *     "selfWxid":         "",   // 当前微信账号 wxid
 *     "silkBinary":       "",   // wx_silk 解码器路径
 *     "resolved": {}            // 启动时自动记录的实际解析路径（勿手改）
 *   }
 *
 * 非空字段会映射为后端的 DSH_WECHAT_* 环境变量；为空则沿用默认行为。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 项目根目录（本文件位于 src/backend/ 下）。 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** 路径配置文件。 */
const CONFIG_PATH = path.join(PROJECT_ROOT, 'wechat', 'config.json');

/** 用户可配置的路径字段 → 后端环境变量。 */
const FIELD_TO_ENV = {
  dataRoot: 'DSH_WECHAT_DATA_DIR',
  decryptedDir: 'DSH_WECHAT_DECRYPTED_DIR',
  decodedImagesDir: 'DSH_WECHAT_DECODED_DIR',
  sourceDir: 'DSH_WECHAT_SOURCE_DIR',
  baseDir: 'DSH_WECHAT_BASE_DIR',
  selfWxid: 'DSH_WECHAT_SELF_WXID',
  silkBinary: 'DSH_WECHAT_SILK_BIN',
};

/** 配置文件路径（外部可读）。 */
function configPath() {
  return CONFIG_PATH;
}

/** LLM 配置路径（微信问答模型配置）。 */
const LLM_CONFIG_PATH = path.join(PROJECT_ROOT, 'wechat', 'llm.json');

function defaultLlmConfig() {
  return {
    provider: 'openai-compat',
    model: '',
    apiKey: '',
    apiUrl: 'https://api.openai.com/v1',
    apiPath: '/chat/completions',
    timeoutMs: 120000,
  };
}

/** 读取 LLM 配置（wechat/llm.json，缺失时返回默认值）。 */
function loadLlmConfig() {
  const base = defaultLlmConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf8'));
    for (const k of Object.keys(base)) {
      if (raw[k] !== undefined) base[k] = raw[k];
    }
  } catch { /* default */ }
  return base;
}

/** 保存 LLM 配置到 wechat/llm.json。 */
function saveLlmConfig(cfg) {
  const merged = { ...defaultLlmConfig(), ...(cfg || {}) };
  fs.mkdirSync(path.dirname(LLM_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/** 空配置默认值。 */
function defaults() {
  return {
    dataRoot: '',
    decryptedDir: '',
    decodedImagesDir: '',
    sourceDir: '',
    baseDir: '',
    selfWxid: '',
    silkBinary: '',
    resolved: {},
    wechatSettings: {},
    wechatSettingsMeta: {},
  };
}

/** 读取 wechat/config.json（缺失或损坏时返回默认值）。 */
function loadConfig() {
  const base = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    for (const key of Object.keys(base)) {
      if (raw[key] !== undefined) base[key] = raw[key];
    }
  } catch {
    // 首次运行或文件损坏：使用默认值，下次启动会自动写入 resolved。
  }
  return base;
}

/** 将配置写入 wechat/config.json（自动创建目录）。 */
function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

/**
 * 把配置里非空的路径字段应用到 process.env（DSH_WECHAT_*）。
 * @param config - 可选，默认 loadConfig()；env - 可选，默认 process.env。
 */
function applyConfig(config = loadConfig(), env = process.env) {
  for (const [field, envName] of Object.entries(FIELD_TO_ENV)) {
    const value = config[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      env[envName] = value.trim();
    }
  }
  return env;
}

/**
 * 把后端启动后解析到的真实路径记录到 wechat/config.json 的 resolved 节。
 * @param info - wechat-host 的 info() 返回值（root/decrypted/decoded/selfUsername）。
 */
function recordResolved(info) {
  const config = loadConfig();
  config.resolved = {
    dataRoot: info?.root ?? '',
    configFile: info?.root ? path.join(info.root, 'config.json') : '',
    decrypted: info?.decrypted ?? '',
    decoded: info?.decoded ?? '',
    selfWxid: info?.selfUsername ?? '',
    recordedAt: new Date().toISOString(),
  };
  return saveConfig(config);
}

/**
 * 把「数据配置」保存的微信设置（db_dir/密钥/图片密钥/开关等）镜像到
 * wechat/config.json，供用户查看/手工编辑。
 * @param settings - saveWechatConfig 的 patch（不写入元数据字段）。
 */
function recordWechatSettings(settings) {
  const config = loadConfig();
  const clean = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (k === 'resolved' || k === 'wechatSettings' || k === 'wechatSettingsMeta') continue;
    clean[k] = v;
  }
  config.wechatSettings = clean;
  config.wechatSettingsMeta = {
    savedAt: new Date().toISOString(),
    source: '数据配置·保存配置',
  };
  return saveConfig(config);
}

/** 读取 wechat/config.json 中记录过的微信设置（patch 形态）。 */
function loadWechatSettings() {
  const config = loadConfig();
  const settings = config.wechatSettings || {};
  return { ...settings };
}

module.exports = {
  configPath,
  loadConfig,
  saveConfig,
  applyConfig,
  recordResolved,
  recordWechatSettings,
  loadWechatSettings,
  loadLlmConfig,
  saveLlmConfig,
  FIELD_TO_ENV,
};
