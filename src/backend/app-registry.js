/**
 * 被托管应用的实例注册表（2026-11-24）。
 *
 * 这张表回答两个问题：
 *   ① **哪些实例**被这台 Super Time 授权过（席位、能力、配额、目录）；
 *   ② 每个实例用哪把密钥校验 Super Time 签出的票据。
 *
 * 为什么不用 SQLite：实例数量是个位数到几十，读多写少；JSON + 原子替换足够，
 * 还能让 ACL 收紧只作用在一个文件上。真正的数据（queue.db）留在实例目录里，
 * 由 SuperLanguage 自己维护 —— 这里只存「绑定关系」，不做队列镜像。
 *
 * **密钥纪律**：
 *   · `masterKey` 只落在 `<STATE_DIR>/apps/registry.json`（ACL 只允许当前用户），
 *     每实例的票据密钥由它派生，不单独存明文；
 *   · 派生值不下发给渲染层，只写进实例目录的 `instance.ini`（同样收紧 ACL）；
 *   · 删除实例 = 删登记行；旧票据到期后自然失效，再配合轮换 masterKey 可全局吊销。
 *
 * @module backend/app-registry
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { restrictDir, restrictFile } = require('./secure-fs.js');

/** 目前只托管一个应用；新增应用要同时改 SuperLanguage 侧的识别表。 */
const APP_DEFINITIONS = {
  superlanguage: {
    id: 'superlanguage',
    label: 'SuperLanguage',
    exeName: 'SuperLanguage.exe',
    /** 实例目录在 `<STATE_DIR>/apps/<dirName>/` 下。 */
    dirName: 'superlanguage',
    /** 票据里的应用标识；SuperLanguage 会逐字比对。 */
    ticketApp: 'superlanguage',
  },
};

const REGISTRY_VERSION = 1;
const NAME_MAX = 40;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorText(e) {
  const message = e && typeof e === 'object' ? e.message : '';
  return typeof message === 'string' && message !== '' ? message : String(e);
}

function textOf(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 目录名只允许 ASCII 安全字符：实例 id 是 UUID，应用名来自常量表。 */
function safeSegment(value) {
  const raw = String(value || '').toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(raw) ? raw : '';
}

/**
 * 派生某实例的票据密钥。
 *
 * 用 HMAC 当 KDF：输入固定、长度固定，不需要额外的盐（instanceId 本身就是唯一名），
 * 也没有 PBKDF 的迭代成本 —— 秘密是 32 字节随机数，不是用户口令。
 * 输出是 **64 位十六进制**：C++ 侧只需 hex 解码，不必再实现 base64url。
 * @param {Buffer} masterKey - 32 字节主密钥。
 * @param {string} instanceId - 实例 UUID。
 * @returns {string} 64 位小写十六进制密钥。
 */
function deriveInstanceKey(masterKey, instanceId) {
  return crypto.createHmac('sha256', masterKey)
    .update('supertime-app:v1:' + instanceId, 'utf8')
    .digest('hex');
}

function normalizeCaps(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [...new Set(value.filter((cap) => typeof cap === 'string' && cap !== ''))];
  return out.length > 0 ? out : [...fallback];
}

function normalizeQuota(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : fallback;
}

function publicInstance(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: String(row.id || ''),
    appId: String(row.appId || ''),
    name: String(row.name || ''),
    seat: Number(row.seat) || 0,
    enabled: row.enabled !== false,
    /**
     * `local` = 本机命名管道自取票据；`lan` = 票据由本机推送，实例在别的电脑上。
     * 跨机实例不能再 spawn（exe 不在这台机上），启动靠共享目录里的请求文件。
     */
    mode: row.mode === 'lan' ? 'lan' : 'local',
    /** 局域网实例所在电脑的 IPv4（`local` 时恒为空串）。 */
    host: String(row.host || ''),
    caps: Array.isArray(row.caps) ? [...row.caps] : [],
    maxJobsPerHour: Number(row.maxJobsPerHour) || 0,
    dir: String(row.dir || ''),
    exeVersion: String(row.exeVersion || ''),
    exeSha256: String(row.exeSha256 || ''),
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
    lastLeaseAt: Number(row.lastLeaseAt) || 0,
    lastSeenAt: Number(row.lastSeenAt) || 0,
    lastError: String(row.lastError || ''),
  };
}

/**
 * 解析「局域网实例」的作用域：IP + 共享目录。
 *
 * 抽成模块级函数是为了让 `createAppRegistry` 留在单函数行数阈值内；
 * 校验口径也只有这一份（create 与 update 共用同一套正则）。
 * @param {object} input - `{ mode, host, dir }`。
 * @returns {{ ok: true, lan: boolean, host: string, dir: string }
 *   | { ok: false, code: string, error: string }}
 */
function lanScopeOf(input) {
  const lan = input?.mode === 'lan';
  if (!lan) return { ok: true, lan: false, host: '', dir: '' };
  const host = textOf(input?.host, 64);
  const dir = textOf(input?.dir, 400);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { ok: false, code: 'BAD_HOST', error: '局域网部署需要填写目标电脑的 IPv4 地址' };
  }
  if (!/^\\\\[^\\]+\\/.test(dir)) {
    return {
      ok: false,
      code: 'BAD_DIR',
      error: '局域网部署需要填写目标电脑上的共享目录（形如 \\\\PC-B\\SuperTimeApps\\inst-xxx）',
    };
  }
  return { ok: true, lan: true, host, dir };
}

/**
 * 建注册表。
 * @param {object} deps - `{ stateDir, defaultCaps, defaultMaxJobsPerHour }`。
 * @returns {object} 读写与席位分配接口。
 */
function createAppRegistry(deps) {
  const stateDir = String(deps?.stateDir || '');
  const defaultCaps = Array.isArray(deps?.defaultCaps) ? deps.defaultCaps : [];
  const defaultMaxJobsPerHour = Number(deps?.defaultMaxJobsPerHour) || 120;
  if (stateDir === '') throw new Error('应用注册表缺少状态目录');
  const appsRoot = path.join(stateDir, 'apps');
  const registryPath = path.join(appsRoot, 'registry.json');

  function emptyRegistry() {
    return { version: REGISTRY_VERSION, masterKey: '', instances: [] };
  }

  function readRaw() {
    try {
      const text = fs.readFileSync(registryPath, 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyRegistry();
      return {
        version: REGISTRY_VERSION,
        masterKey: typeof parsed.masterKey === 'string' ? parsed.masterKey : '',
        instances: Array.isArray(parsed.instances) ? parsed.instances : [],
      };
    } catch {
      return emptyRegistry();
    }
  }

  /**
   * 读注册表；主密钥缺失时**现场生成**并落盘。
   *
   * 生成必须和读取走同一把锁点（单进程主进程），否则并发读会各生成一把，
   * 已签发实例的密钥随之失效。这里用同步读写，天然串行。
   */
  function read() {
    const current = readRaw();
    if (current.masterKey !== '') return current;
    current.masterKey = crypto.randomBytes(32).toString('base64');
    write(current);
    return current;
  }

  let aclApplied = false;

  function write(registry) {
    fs.mkdirSync(appsRoot, { recursive: true });
    const tmp = registryPath + '.' + String(process.pid) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      version: REGISTRY_VERSION,
      masterKey: registry.masterKey,
      instances: registry.instances,
    }, null, 2), 'utf8');
    fs.renameSync(tmp, registryPath);
    // 每个进程只收紧一次：之后每次租约回写都跑 icacls 会白白多一次进程创建。
    if (!aclApplied) {
      restrictDir(appsRoot);
      restrictFile(registryPath);
      aclApplied = true;
    }
  }

  function masterKeyBuffer() {
    const registry = read();
    const buffer = Buffer.from(registry.masterKey, 'base64');
    if (buffer.length !== 32) {
      throw new Error('应用注册表的主密钥损坏，请重新部署实例');
    }
    return buffer;
  }

  function listRaw() {
    return read().instances;
  }

  function list() {
    return listRaw().map(publicInstance).filter((item) => item !== null);
  }

  function getRaw(id) {
    const target = String(id || '');
    return listRaw().find((row) => row && String(row.id) === target);
  }

  function get(id) {
    return publicInstance(getRaw(id));
  }

  /** 实例目录只能落在 `<STATE_DIR>/apps/<appDir>/inst-<uuid>` 内。 */
  function instanceDir(appId, id) {
    const def = APP_DEFINITIONS[appId];
    if (!def) return '';
    const safeApp = safeSegment(def.dirName);
    const safeId = safeSegment(id);
    if (safeApp === '' || safeId === '') return '';
    return path.join(appsRoot, safeApp, 'inst-' + safeId);
  }

  function withLock(mutator) {
    // 主进程是单线程；重读一次再写，避免用旧快照覆盖并发改动。
    const registry = read();
    const result = mutator(registry);
    write(registry);
    return result;
  }

  /**
   * 新建实例并分配最小空闲席位。
   * @param {object} input - `{ appId, name, maxInstances, caps, maxJobsPerHour }`。
   * @returns {{ ok: true, instance: object } | { ok: false, error: string, code?: string }}
   */
  function create(input) {
    const appId = String(input?.appId || 'superlanguage');
    const def = APP_DEFINITIONS[appId];
    if (!def) return { ok: false, error: '不支持的应用：' + appId, code: 'UNKNOWN_APP' };
    const name = textOf(input?.name, NAME_MAX) || def.label + ' 实例';
    const maxInstances = Number.isInteger(input?.maxInstances) ? input.maxInstances : 1;
    const caps = normalizeCaps(input?.caps, defaultCaps);
    const maxJobsPerHour = normalizeQuota(input?.maxJobsPerHour, defaultMaxJobsPerHour);
    // 局域网实例：目录由用户给（通常是 UNC 共享），IP 用于代理与票据推送。
    const scope = lanScopeOf(input);
    if (!scope.ok) return { ok: false, code: scope.code, error: scope.error };
    const lan = scope.lan;
    return withLock((registry) => {
      const own = registry.instances.filter((row) => row && row.appId === appId);
      if (own.length >= maxInstances) {
        return {
          ok: false,
          code: 'SEAT_EXHAUSTED',
          error: '席位已用满（' + String(own.length) + '/' + String(maxInstances) + '），请先释放一个实例或升级授权',
        };
      }
      const used = new Set(own.map((row) => Number(row.seat) || 0));
      let seat = 1;
      while (used.has(seat)) seat += 1;
      const now = Date.now();
      const row = {
        id: crypto.randomUUID(),
        appId,
        name,
        seat,
        enabled: true,
        mode: lan ? 'lan' : 'local',
        host: scope.host,
        caps,
        maxJobsPerHour,
        dir: '',
        exeVersion: '',
        exeSha256: '',
        createdAt: now,
        updatedAt: now,
        lastLeaseAt: 0,
        lastSeenAt: 0,
        lastError: '',
      };
      row.dir = lan ? scope.dir : instanceDir(appId, row.id);
      if (row.dir === '') {
        return { ok: false, code: 'BAD_INSTANCE_ID', error: '实例 id 无效，无法分配目录' };
      }
      registry.instances.push(row);
      return { ok: true, instance: publicInstance(row) };
    });
  }

  /**
   * 局部更新实例。
   * @param {string} id - 实例 id。
   * @param {object} patch - 只允许白名单字段。
   * @returns {{ ok: true, instance: object } | { ok: false, error: string }}
   */
  function update(id, patch) {
    return withLock((registry) => {
      const row = registry.instances.find((item) => item && String(item.id) === String(id));
      if (!row) return { ok: false, error: '实例不存在' };
      if (patch?.name !== undefined) {
        const name = textOf(patch.name, NAME_MAX);
        if (name === '') return { ok: false, error: '实例名称不能为空' };
        row.name = name;
      }
      if (patch?.enabled !== undefined) row.enabled = patch.enabled !== false;
      if (patch?.caps !== undefined) row.caps = normalizeCaps(patch.caps, defaultCaps);
      if (patch?.maxJobsPerHour !== undefined) {
        row.maxJobsPerHour = normalizeQuota(patch.maxJobsPerHour, defaultMaxJobsPerHour);
      }
      if (patch?.exeVersion !== undefined) row.exeVersion = textOf(patch.exeVersion, 40);
      if (patch?.exeSha256 !== undefined) row.exeSha256 = textOf(patch.exeSha256, 64).toLowerCase();
      // 局域网实例换 IP / 换共享目录：只允许在 lan 模式下改，避免把本机实例误指向远端。
      if (patch?.host !== undefined && row.mode === 'lan') {
        const host = textOf(patch.host, 64);
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, error: 'IPv4 地址无效' };
        row.host = host;
      }
      if (patch?.dir !== undefined && row.mode === 'lan') {
        const dir = textOf(patch.dir, 400);
        // 允许 UNC 或盘符绝对路径；相对路径会让文件落到进程 cwd，必须拒绝。
        const absolute = /^\\\\[^\\]+\\/.test(dir) || /^[A-Za-z]:[\\/]/.test(dir);
        if (!absolute) return { ok: false, error: '共享目录必须是 \\\\电脑\\共享\\… 或 X:\\… 形式' };
        row.dir = dir;
      }
      if (patch?.lastLeaseAt !== undefined) row.lastLeaseAt = Number(patch.lastLeaseAt) || 0;
      if (patch?.lastSeenAt !== undefined) row.lastSeenAt = Number(patch.lastSeenAt) || 0;
      if (patch?.lastError !== undefined) row.lastError = textOf(patch.lastError, 300);
      row.updatedAt = Date.now();
      return { ok: true, instance: publicInstance(row) };
    });
  }

  /** 删除登记；实例目录由调用方决定是否清理（默认保留队列数据）。 */
  function remove(id) {
    return withLock((registry) => {
      const before = registry.instances.length;
      registry.instances = registry.instances.filter((row) => !row || String(row.id) !== String(id));
      if (registry.instances.length === before) return { ok: false, error: '实例不存在' };
      return { ok: true };
    });
  }

  /** 派生密钥（只给主进程用；渲染层永远拿不到）。 */
  function instanceKey(id) {
    const row = getRaw(id);
    if (!row) return '';
    return deriveInstanceKey(masterKeyBuffer(), String(row.id));
  }

  /** 换主密钥：所有实例的旧票据立即失效，需要重新下发 instance.ini。 */
  function rotateMasterKey() {
    return withLock((registry) => {
      registry.masterKey = crypto.randomBytes(32).toString('base64');
      return { ok: true };
    });
  }

  return {
    paths: { appsRoot, registryPath },
    list,
    get,
    create,
    update,
    remove,
    instanceKey,
    instanceDir,
    rotateMasterKey,
    definitions: APP_DEFINITIONS,
  };
}

module.exports = {
  APP_DEFINITIONS,
  REGISTRY_VERSION,
  createAppRegistry,
  deriveInstanceKey,
  ID_PATTERN,
};
