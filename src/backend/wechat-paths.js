'use strict';

/**
 * Super Time 宿主路径与微信设置配置中心。
 *
 * 本模块只负责三件事：
 *   1. 安装资产目录与运行期状态目录；
 *   2. `config.json` 里的路径与微信设置镜像；
 *   3. 保持旧有导入面，把 LLM 配置与原子 JSON 工具转发给各自模块。
 *
 * LLM 当前配置 / profile 集合在 `llm-config-store.js`；
 * JSON 原子写与损坏备份在 `atomic-json.js`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  writeFileAtomic,
  warnCorruptOnce,
  preserveIfUnparseable,
} = require('./atomic-json');
const { createLlmConfigStore } = require('./llm-config-store');

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

/**
 * LLM 仓库只注入一个路径读取器，不让它反向依赖本模块的内部状态。
 * `configure()` 改的是 `stateDir` 变量，路径读取器在调用时实时取值。
 */
const llmConfigStore = createLlmConfigStore({
  getConfigPath: () => path.join(stateDir, 'llm.json'),
});

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

/**
 * 凭据类设置项：**不镜像**进 config.json。
 *
 * 理由：config.json 是「用户可手工编辑、出问题会被整目录拷贝或交给支持人员」的文件
 * （H1/N6 那条泄漏路径的载体），密钥镜像一份进去等于凭空多一份副本。
 * 密钥的真源是后端写的 `<STATE_DIR>/secrets.json`（见 `config/wechat-config.ts` 的
 * `SECRET_FIELDS` —— M24 之后配置实现从 `query/config.ts` 下沉到了 `config/` 层，
 * `query/config.ts` 现在只是转发门面）。
 */
const SECRET_SETTING_KEYS = new Set(['db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token']);

/** 已迁移过的 `<stateDir>\0<legacyDir>` 组合，避免重复迁移（且允许不同状态目录各迁一次）。 */
const migratedCombos = new Set();

/**
 * 迁移时必须剔除的镜像设置字段（N6）。
 *
 * 两类：① **数据源**（`db_dir` 指向真实微信库，带着它就会在新状态目录里静默全量解密）；
 * ② **凭据**（`SECRET_SETTING_KEYS`）与**随安装位置变化的派生路径**
 * （`DERIVED_SETTING_KEYS`）。其余普通设置（开关、端口、whisper 参数）是用户偏好，
 * 与机器无关，照旧迁移。
 */
const MIGRATED_DROP_SETTING_KEYS = new Set(['db_dir', ...SECRET_SETTING_KEYS, ...DERIVED_SETTING_KEYS]);

/**
 * 生成**可安全迁移**的 `config.json` 内容。
 *
 * 顶层路径字段（`dataRoot` / `decryptedDir` / `decodedImagesDir` / `sourceDir` / `baseDir` /
 * `selfWxid` / `silkBinary` / `resolved`）**一律不迁移**：它们要么指向真实数据源、要么是
 * 上一台机器/上一次安装位置解析出来的绝对路径。剔除后应用会在新状态下重新解析，
 * 并在需要用户确认数据源时报「数据源未配置」，而不是拿旧路径直接开工。
 * @param raw - 仓库 `wechat/config.json` 的解析结果（可能是任意形状）。
 * @returns `{ config, dropped }`：待写入的内容，以及被剔除的字段名（用于日志）。
 */
function sanitizeMigratedConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mirrored = src.wechatSettings && typeof src.wechatSettings === 'object' ? src.wechatSettings : {};
  const dropped = [];
  const settings = {};
  for (const [k, v] of Object.entries(mirrored)) {
    if (MIGRATED_DROP_SETTING_KEYS.has(k)) {
      dropped.push(`wechatSettings.${k}`);
      continue;
    }
    settings[k] = v;
  }
  for (const k of Object.keys(src)) {
    if (k === 'wechatSettings') continue;
    // 其余顶层字段全部不带走（含 resolved 与各类路径，见函数说明）
    dropped.push(k);
  }
  return { config: { ...defaults(), wechatSettings: settings }, dropped };
}

/**
 * 开发态一次性迁移：把项目 `wechat/` 下的老配置搬进 STATE_DIR。
 * 打包态直接返回 —— 安装目录里的任何配置都不许被继承（跨机泄漏的根源）。
 *
 * `config.json` 走 `sanitizeMigratedConfig`（数据源与凭据不搬，N6）；`llm.json` 原样搬。
 * 任一步失败都只影响该文件，且不会中断启动。
 * @param legacyDir - 老配置所在目录；默认随包资产目录（参数供单测注入临时布局）。
 */
function migrateLegacyState(legacyDir = ASSETS_DIR) {
  const combo = `${stateDir}\u0000${legacyDir}`;
  if (migratedCombos.has(combo)) return;
  migratedCombos.add(combo);
  if (PACKAGED) return;

  // ① 运行期配置：只搬非路径、非凭据的设置镜像（N6）
  try {
    const target = path.join(stateDir, 'config.json');
    const legacy = path.join(legacyDir, 'config.json');
    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
      const { config, dropped } = sanitizeMigratedConfig(JSON.parse(fs.readFileSync(legacy, 'utf8')));
      fs.mkdirSync(stateDir, { recursive: true });
      writeFileAtomic(target, JSON.stringify(config, null, 2) + '\n');
      const detail = dropped.length > 0 ? `；已剔除 ${dropped.join('、')}` : '';
      console.log(`[config] 开发态迁移：已把 ${legacy} 的非路径设置搬进 ${target}${detail}` +
        '。数据源与密钥不迁移 —— 请在新状态目录的「数据配置」里重新确认数据源，否则不会有任何解密数据。');
    }
  } catch (e) {
    console.warn(`[config] 开发态迁移 config.json 失败（继续用默认配置启动）：${e && e.message ? e.message : e}`);
  }

  // ② 问答模型配置：与数据源无关，原样搬
  try {
    const target = path.join(stateDir, 'llm.json');
    const legacy = path.join(legacyDir, 'llm.json');
    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.copyFileSync(legacy, target);
    }
  } catch {
    /* 迁移失败就当没有老配置，不影响启动 */
  }
}

/**
 * 设定运行期状态目录（主进程与后端进程都要调用，且必须传同一个 userData）。
 * @param options.userDataPath - Electron `app.getPath('userData')`。
 * @param options.legacyAssetsDir - 老配置所在目录，默认随包资产目录（参数供单测注入）。
 * @returns 状态目录绝对路径。
 */
function configure(options = {}) {
  const dir = typeof options.userDataPath === 'string' ? options.userDataPath.trim() : '';
  if (dir) stateDir = path.join(dir, 'wechat');
  const legacyDir = typeof options.legacyAssetsDir === 'string' && options.legacyAssetsDir.trim()
    ? options.legacyAssetsDir.trim()
    : ASSETS_DIR;
  migrateLegacyState(legacyDir);
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
  } catch (e) {
    // 首次运行（文件不存在）或文件损坏。**不改动文件**：损坏内容由下一次保存时的
    // preserveIfUnparseable 先备份再覆盖；这里只提示一次，避免静默当成「没有配置」。
    warnCorruptOnce(configPath(), e);
  }
  return base;
}

/** 将配置写入 config.json（自动创建状态目录）。 */
function saveConfig(config) {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  preserveIfUnparseable(target);
  writeFileAtomic(target, JSON.stringify(config, null, 2) + '\n');
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
 * 把「数据配置」保存的微信设置 (db_dir/开关等) 镜像到 config.json，供用户查看/手工编辑。
 * **派生字段一律不镜像**（见 DERIVED_SETTING_KEYS）：它们随安装位置与数据根变化，
 * 镜像过去只会把别的机器/别的安装位置的路径推回来。
 * **凭据字段也不镜像**（见 SECRET_SETTING_KEYS）：它们有单独的、受权限保护的文件。
 *
 * **是合并不是整体替换**：这个函数不只被界面保存调用，也会被主进程的内部保存调用
 * （启动期把旧密钥交给后端、空 patch 保存等），而那些 patch 往往是**部分字段**。
 * 整体替换会让一次内部保存把镜像里的普通设置全部抹掉（实测踩过两次：空 patch 保存 +
 * 只在镜像里的密钥搬迁），而镜像本来就是「最近一次设置的样子」，合并才是正确语义。
 * 界面的保存会带上全部字段，所以对它而言合并与替换等价。
 * @param settings - saveWechatConfig 的 patch（不写入元数据字段）。
 */
function recordWechatSettings(settings) {
  const config = loadConfig();
  const clean = {};
  // 先继承既有镜像，但**顺手丢掉派生/凭据字段** —— 否则合并会让 M1 之前残留在
  // `config.json.wechatSettings` 里的密钥副本永远留在文件里（既走不了 pre-patch 的 RPC，
  // 也永远等不到一次「整体替换」来清掉）。
  for (const [k, v] of Object.entries(config.wechatSettings || {})) {
    if (DERIVED_SETTING_KEYS.has(k) || SECRET_SETTING_KEYS.has(k)) continue;
    clean[k] = v;
  }
  for (const [k, v] of Object.entries(settings || {})) {
    if (k === 'wechatSettings' || k === 'wechatSettingsMeta') continue;
    if (DERIVED_SETTING_KEYS.has(k)) continue;
    if (SECRET_SETTING_KEYS.has(k)) continue;
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
    if (SECRET_SETTING_KEYS.has(k)) continue; // 密钥不在 config.json 里，镜像残留也不回放
    clean[k] = v;
  }
  return clean;
}

/**
 * 取出宿主镜像里的密钥字段（**只读，不删除**）。
 *
 * 为什么需要：`saveWechatConfig` 返回前 `wechat-host.js` 会调 `recordWechatSettings(patch)`
 * 把整份镜像**重写**成「已过滤密钥」的干净版 —— 那些**只存在于镜像里**的密钥（后端
 * config.json 里没有对应值 → `saveConfig` 的 `carried` 也捞不到）会在那一步被无声丢掉。
 * 所以调用方（`main.js` 的 `applySavedWechatSettings`）必须把它们**并进同一次回灌 patch**：
 * 后端会把它们写进 `secrets.json`，而回写镜像时会顺手把副本过滤掉 —— 迁移与去副本一步完成，
 * 也就不需要再单独「清理镜像」了。
 *
 * 这里不做「值是否等于默认值」的判断：后端 `saveConfig` 的 `secretIsMeaningful` 才是唯一
 * 口径（宿主层再抄一份默认值只会漂移）。空串这里就滤掉，省一次无意义的 RPC 字段。
 * @returns {Record<string, unknown>} 非空的密钥字段。
 */
function mirroredSecretValues() {
  const config = loadConfig();
  const settings = config.wechatSettings;
  const out = {};
  if (!settings || typeof settings !== 'object') return out;
  for (const key of SECRET_SETTING_KEYS) {
    const v = settings[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[key] = v;
  }
  return out;
}

const {
  defaultLlmConfig,
  loadLlmConfig,
  saveLlmConfig,
  loadLlmStore,
  activateLlmProfile,
  upsertLlmProfile,
  deleteLlmProfile,
  LLM_PROFILE_FIELDS,
} = llmConfigStore;

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
  mirroredSecretValues,
  defaultLlmConfig,
  loadLlmConfig,
  saveLlmConfig,
  loadLlmStore,
  activateLlmProfile,
  upsertLlmProfile,
  deleteLlmProfile,
  LLM_PROFILE_FIELDS,
  FIELD_TO_ENV,
  DERIVED_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  // 导出给单测：这两个是纯文件函数，不依赖 stateDir 初始化
  writeFileAtomic,
  preserveIfUnparseable,
  // 导出给单测（N6）：迁移的剔除规则必须能被独立验证
  sanitizeMigratedConfig,
  migrateLegacyState,
};
