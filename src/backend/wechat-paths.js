'use strict';

/**
 * 微信+路径配置中心
 *
 * ## 目录职责（2026-09-13 重构）
 *
 *   ASSETS_DIR  安装目录里的**只读**资产：`<安装位置>/resources/app.asar.unpacked/wechat/`
 *               随包分发，只有 whisper 引擎/模型与 README。运行时**绝不写入**。
 *   STATE_DIR   运行期**可写**状态：`<userData>/wechat/`
 *               `config.json`（路径配置 + 微信设置镜像）与 `llm.json`（问答模型配置）。
 *
 * 为什么要拆开：旧实现把状态写在 ASSETS_DIR 里（当时为修 `ENOTDIR` 才把 asar 重定向到
 * `app.asar.unpacked`），后果是
 *   - **跨机泄漏本机绝对路径**：整个安装目录被拷到另一台电脑时，`config.json` 里的
 *     `db_dir` / 微信解密密钥会被带过去，那边开机直接拿它去解密，报「数据库目录不存在
 *     (D:\Tencent\...\wxid_xxx\db_storage)」——用户看到的就是这条；
 *   - 装到 `Program Files` 时没有写权限；
 *   - 升级/卸载会连带丢掉用户配置。
 * 现在 STATE 只落在 userData，安装目录保持只读。
 *
 * ## 开发态迁移
 *
 * 开发态（非 asar）首次启动会把项目 `wechat/config.json`、`wechat/llm.json` 复制到
 * STATE_DIR，让老配置继续生效；此后**只读写 STATE_DIR**，项目里那两个文件不再被使用。
 * 打包态**不做任何迁移** —— 那正是跨机泄漏的入口。
 *
 * ## 字段
 *
 *   {
 *     "dataRoot":         "",   // 数据根（默认 <userData>/wechat-data）
 *     "decryptedDir":     "",   // 解密库目录（默认 <dataRoot>/decrypted）
 *     "decodedImagesDir": "",   // 解码图片缓存（默认 <dataRoot>/decoded_images）
 *     "sourceDir":        "",   // 一次性导入源目录
 *     "baseDir":          "",   // 原始微信账号根目录（.dat 回退用）
 *     "selfWxid":         "",   // 当前微信账号 wxid
 *     "silkBinary":       "",   // wx_silk 解码器路径
 *     "wechatSettings":   {},   // 「数据配置」保存的微信设置镜像
 *     "wechatSettingsMeta": {}, // 最近一次保存的来源与时间
 *     "resolved":         {}    // 启动时自动记录的实际解析路径（勿手改）
 *   }
 *
 * 非空字段会映射为后端的 DSH_WECHAT_* 环境变量；为空则沿用默认行为。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 安装目录根（只读资产所在）。
 *
 * **打包后必须重定向到 app.asar.unpacked**：`electron-builder` 把 `wechat/**` 列为
 * asarUnpack，运行时可读的文件躺在 `resources/app.asar.unpacked/wechat/`，而
 * `__dirname` 指向的是 `resources/app.asar/...`（一个**只读归档**，不是目录）。
 * Electron 的 asar 层只会把**读**透明地转到 unpacked 目录 —— 所以读资产必须先改写路径。
 */
const INSTALL_ROOT = (() => {
  const raw = path.resolve(__dirname, '..', '..');
  // 注意：上溯两级后正好**停在** `...\resources\app.asar`（结尾没有分隔符），
  // 所以不能只匹配 `app.asar\` —— 必须同时覆盖「就是归档根」与「归档内子路径」两种形态。
  const marker = 'app.asar';
  const i = raw.indexOf(marker);
  if (i < 0) return raw;
  const rest = raw.slice(i + marker.length).replace(/^[\\/]+/, '');
  return path.join(raw.slice(0, i), 'app.asar.unpacked', rest);
})();

/** 随包分发的只读资产目录（whisper 引擎/模型、README）。 */
const ASSETS_DIR = path.join(INSTALL_ROOT, 'wechat');

/** 是否运行在 asar 打包态。开发态为 false。 */
const PACKAGED = INSTALL_ROOT.includes('app.asar');

/** 运行期可写状态目录；`configure()` 会把它指向 `<userData>/wechat`。 */
let stateDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'wechat');

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

/**
 * 由运行环境自行解析、**不该跨机复用**的设置项。
 *
 * 它们都是绝对路径，且要么随安装位置变化（whisper 引擎/模型），要么随数据根变化
 * （decrypted/decoded/keys）。后端每次启动都会按当前机器重新解析，所以镜像里
 * 一旦留下它们，就只会把「上一台机器/上一次安装位置」的路径再推回后端。
 */
const DERIVED_SETTING_KEYS = new Set([
  'resolved',
  'decrypted_dir',
  'decoded_image_dir',
  'keys_file',
  'whisper_models_dir',
  'whisper_bin',
]);

let migrated = false;

/**
 * 开发态一次性迁移：把项目 `wechat/` 下的老配置搬进 STATE_DIR。
 * 打包态直接返回 —— 安装目录里的任何配置都不许被继承（跨机泄漏的根源）。
 */
function migrateLegacyState() {
  if (migrated) return;
  migrated = true;
  if (PACKAGED) return;
  for (const name of ['config.json', 'llm.json']) {
    try {
      const target = path.join(stateDir, name);
      if (fs.existsSync(target)) continue;
      const legacy = path.join(ASSETS_DIR, name);
      if (!fs.existsSync(legacy)) continue;
      fs.mkdirSync(stateDir, { recursive: true });
      fs.copyFileSync(legacy, target);
    } catch {
      /* 迁移失败就当没有老配置，不影响启动 */
    }
  }
}

/**
 * 设定运行期状态目录（主进程与后端进程都要调用，且必须传同一个 userData）。
 * @param options.userDataPath - Electron `app.getPath('userData')`。
 * @returns 状态目录绝对路径。
 */
function configure(options = {}) {
  const dir = typeof options.userDataPath === 'string' ? options.userDataPath.trim() : '';
  if (dir) stateDir = path.join(dir, 'wechat');
  migrateLegacyState();
  return stateDir;
}

/** 运行期状态目录。 */
function stateDirPath() {
  return stateDir;
}

/** 随包分发的只读资产目录。 */
function assetsDirPath() {
  return ASSETS_DIR;
}

/** 是否运行在打包态。 */
function isPackaged() {
  return PACKAGED;
}

/** 路径配置文件路径（外部可读）。 */
function configPath() {
  return path.join(stateDir, 'config.json');
}

/** LLM 配置文件路径（微信问答模型配置）。 */
function llmConfigPath() {
  return path.join(stateDir, 'llm.json');
}

function defaultLlmConfig() {
  return {
    provider: 'openai-compat',
    model: '',
    apiKey: '',
    apiUrl: 'https://api.openai.com/v1',
    apiPath: '/chat/completions',
    // RAG 稠密检索用的向量接口。留空时回退到 chat model 同名调用；
    // 厂商若不提供 /embeddings，稠密通道会自动降级（稀疏通道照常工作）。
    embeddingModel: '',
    embedPath: '/embeddings',
    timeoutMs: 120000,
  };
}

/** 读取 LLM 配置（缺失时返回默认值）。 */
function loadLlmConfig() {
  const base = defaultLlmConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(llmConfigPath(), 'utf8'));
    for (const k of Object.keys(base)) {
      if (raw[k] !== undefined) base[k] = raw[k];
    }
  } catch { /* 首次运行或文件损坏：用默认值 */ }
  return base;
}

/** 保存 LLM 配置（自动创建状态目录）。 */
function saveLlmConfig(cfg) {
  const merged = { ...defaultLlmConfig(), ...(cfg || {}) };
  const target = llmConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf8');
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

/** 读取 config.json（缺失或损坏时返回默认值）。 */
function loadConfig() {
  const base = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    for (const key of Object.keys(base)) {
      if (raw[key] !== undefined) base[key] = raw[key];
    }
  } catch {
    // 首次运行或文件损坏：使用默认值，下次启动会自动写入 resolved。
  }
  return base;
}

/** 将配置写入 config.json（自动创建状态目录）。 */
function saveConfig(config) {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
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
 * 把后端启动后解析到的真实路径记录到 config.json 的 resolved 节。
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
 * 把「数据配置」保存的微信设置（db_dir/密钥/图片密钥/开关等）镜像到 config.json，
 * 供用户查看/手工编辑。**派生字段一律不镜像**（见 DERIVED_SETTING_KEYS）：
 * 它们随安装位置与数据根变化，镜像过去只会把别的机器/别的安装位置的路径推回来。
 * @param settings - saveWechatConfig 的 patch（不写入元数据字段）。
 */
function recordWechatSettings(settings) {
  const config = loadConfig();
  const clean = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (k === 'wechatSettings' || k === 'wechatSettingsMeta') continue;
    if (DERIVED_SETTING_KEYS.has(k)) continue;
    clean[k] = v;
  }
  config.wechatSettings = clean;
  config.wechatSettingsMeta = {
    savedAt: new Date().toISOString(),
    source: '数据配置·保存配置',
  };
  return saveConfig(config);
}

/** 读取 config.json 中记录过的微信设置（patch 形态，派生字段已剔除）。 */
function loadWechatSettings() {
  const config = loadConfig();
  const settings = config.wechatSettings || {};
  const clean = {};
  for (const [k, v] of Object.entries(settings)) {
    if (DERIVED_SETTING_KEYS.has(k)) continue;
    clean[k] = v;
  }
  return clean;
}

module.exports = {
  configure,
  stateDirPath,
  assetsDirPath,
  isPackaged,
  configPath,
  llmConfigPath,
  loadConfig,
  saveConfig,
  applyConfig,
  recordResolved,
  recordWechatSettings,
  loadWechatSettings,
  loadLlmConfig,
  saveLlmConfig,
  FIELD_TO_ENV,
  DERIVED_SETTING_KEYS,
};
