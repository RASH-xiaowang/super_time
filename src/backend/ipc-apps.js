/**
 * 应用托管 IPC（2026-11-24）。
 *
 * 渲染层只看到这一层：**没有任何一个频道会把票据密钥或实例 Bearer 令牌回传**。
 * 授权判定统一走 `licenseService.getAppEntitlement`（与 `wechat:call` 同一份许可证
 * 状态），并且失败方向永远是拒绝 —— 许可证模块抛错也拒绝，不放行。
 *
 * 分组：
 *   · 摘要/列表：永远可读（界面要靠它显示「为什么不能用」）；
 *   · 部署/启动/发送代理：必须先过功能位；
 *   · 停止/日志/状态：允许在授权失效后继续用，方便用户收尾与诊断。
 *
 * @module backend/ipc-apps
 */

/**
 * 读当前应用托管额度。
 * @param {object} ctx - `{ app, licenseService, APP_VERSION }`。
 * @returns {{ ok: true, status: object, entitlement: object }
 *   | { ok: false, message: string, code: string, licenseState?: string, status?: object }}
 */
function currentEntitlement(ctx) {
  try {
    const status = ctx.licenseService.getLicenseStatus(ctx.app.getPath('userData'), ctx.APP_VERSION);
    const entitlement = ctx.licenseService.getAppEntitlement(status);
    if (!entitlement.ok) {
      return {
        ok: false,
        message: entitlement.message,
        code: entitlement.code,
        licenseState: status && status.state ? status.state : 'unknown',
        // 功能位没开时许可证本身可能完全有效 —— 把状态一起带回，
        // 面板才能显示「授权状态：licensed / 剩余 N 天」而不是 unknown。
        status,
      };
    }
    return {
      ok: true,
      status,
      entitlement: {
        ...entitlement,
        licenseId: status && status.payload ? String(status.payload.licenseId || '') : '',
      },
    };
  } catch (e) {
    return {
      ok: false,
      message: '许可校验失败，已拒绝本次调用：' + (e && e.message ? e.message : String(e)),
      code: 'LICENSE_CHECK_FAILED',
    };
  }
}

function licenseSummaryOf(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    state: String(status.state || ''),
    licensed: status.licensed === true,
    code: String(status.code || ''),
    reason: String(status.reason || ''),
    daysToExpiry: typeof status.daysToExpiry === 'number' ? status.daysToExpiry : null,
    licenseId: status.payload ? String(status.payload.licenseId || '') : '',
    expiresAt: status.payload ? status.payload.expiresAt ?? null : null,
  };
}

/**
 * 列表：可以作为「下游 Webhook」的托管实例。
 *
 * 只回**脱敏**地址（令牌变 `***`）：真实地址只在主进程里用于代写规则，
 * 否则渲染层拿到令牌就能绕过 `apps:*` 的功能位闸门直连实例。
 * @param {object} deps - 见 {@link registerAppsIpc}。
 * @param {object} gate - {@link currentEntitlement} 的结果。
 * @returns {Array<object>} 选项列表。
 */
function webhookTargets(deps, gate) {
  const out = [];
  for (const instance of deps.registry.list()) {
    if (instance.appId !== 'superlanguage') continue;
    const real = deps.host.webhookUrlOf(instance);
    const live = deps.host.isRunning(instance.id);
    out.push({
      id: instance.id,
      name: instance.name,
      seat: instance.seat,
      enabled: instance.enabled,
      running: live,
      // 端口由系统分配，只有实例真在跑、`api-port.txt` 与令牌都就绪时才可解析。
      ready: real !== '',
      maskedUrl: real === '' ? '' : deps.host.redactEndpoint(real),
    });
  }
  return out.sort((a, b) => a.seat - b.seat).map((item) => ({
    ...item,
    // 功能位被收走/实例停用时仍列出（让用户看到现状），但界面会禁止选择。
    usable: gate.ok && item.enabled && item.ready,
  }));
}

/**
 * 把某实例的 Webhook 地址同步到它引用的规则。
 *
 * 为什么需要：实例端口是系统分配的，**每次启动都可能变**。规则里存的是地址快照
 * （投递路径不变，这是有意的），所以实例起来之后必须把引用它的规则改到新端口，
 * 否则一重启规则就指向死端口。`keepManagedBy: true` 保住 AI 默认规则的系统标记。
 * @param {object} deps - 见 {@link registerAppsIpc}。
 * @param {string} instanceId - 实例 id。
 * @param {string} realUrl - 当前真实的 `/webhook/<token>` 地址。
 * @returns {Promise<number>} 实际改写的规则条数。
 */
async function syncRulesForInstance(deps, instanceId, realUrl) {
  if (realUrl === '' || typeof deps.callBackend !== 'function') return 0;
  const listed = await deps.callBackend('listMessageListRules', []);
  const rules = listed && listed.ok && listed.value && Array.isArray(listed.value.items)
    ? listed.value.items
    : [];
  let updated = 0;
  for (const rule of rules) {
    if (rule.appInstanceId !== instanceId) continue;
    // 列表里的地址是脱敏的，不能拿来比较；直接用真实地址覆盖一次即可（幂等）。
    const saved = await deps.callBackend('saveMessageListRule', [{
      id: rule.id,
      chatName: rule.chatName,
      targetName: rule.targetName,
      webhookUrl: realUrl,
      greetingText: rule.greetingText,
      note: rule.note,
      enabled: rule.enabled,
      appInstanceId: instanceId,
      keepManagedBy: true,
    }]);
    if (saved && saved.ok) updated += 1;
  }
  return updated;
}

/**
 * 注册 `apps:*` 频道。
 * @param {object} ctx - `{ ipcMain, ipcTrust, app, shell, licenseService, APP_VERSION, registry, broker, host, callBackend }`。
 */
function registerAppsIpc(ctx) {
  const {
    ipcMain,
    ipcTrust,
    app,
    shell,
    licenseService,
    APP_VERSION,
    registry,
    broker,
    host,
    callBackend,
  } = ctx;
  // 命名必须叫 handleIpc：preload-contract 的静态扫描与本目录其余 ipc-* 模块同一口径。
  const handleIpc = (channel, handler) => ipcMain.handle(channel, ipcTrust.wrap(channel, handler));
  const guard = () => currentEntitlement({ app, licenseService, APP_VERSION });
  const deps = { registry, host, callBackend };

  async function instanceView(instance) {
    let live = { ok: false, running: false, deployed: false, error: '未运行' };
    try {
      live = await host.status(instance.id);
    } catch (e) {
      live = { ok: false, running: false, deployed: false, error: e && e.message ? e.message : String(e) };
    }
    return { ...instance, live };
  }

  handleIpc('apps:summary', async () => {
    const gate = guard();
    const instances = registry.list();
    const instancesView = await Promise.all(instances.map(instanceView));
    const status = gate.status ?? null;
    return {
      ok: true,
      licensed: gate.ok,
      error: gate.ok ? '' : gate.message,
      code: gate.ok ? '' : gate.code,
      license: licenseSummaryOf(status),
      entitlement: gate.ok
        ? {
          maxInstances: gate.entitlement.maxInstances,
          caps: gate.entitlement.caps,
          maxJobsPerHour: gate.entitlement.maxJobsPerHour,
          standalone: gate.entitlement.standalone,
        }
        : null,
      seats: {
        used: instances.length,
        max: gate.ok ? gate.entitlement.maxInstances : 0,
      },
      broker: broker.status(),
      sourceExe: host.sourceExe(),
      instances: instancesView,
    };
  });

  handleIpc('apps:create', (_event, input) => {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const result = registry.create({
      appId: 'superlanguage',
      name: input && input.name,
      maxInstances: gate.entitlement.maxInstances,
      caps: gate.entitlement.caps,
      maxJobsPerHour: gate.entitlement.maxJobsPerHour,
      // 局域网部署：目录与目标电脑由用户给（见 app-registry 的 BAD_HOST/BAD_DIR 校验）。
      mode: input && input.mode === 'lan' ? 'lan' : 'local',
      host: input && input.host,
      dir: input && input.dir,
    });
    return result.ok ? { ok: true, instance: result.instance } : { ok: false, error: result.error, code: result.code };
  });

  handleIpc('apps:update', (_event, input) => {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const patch = input && typeof input.patch === 'object' ? input.patch : {};
    // 能力与配额只能收窄到证书允许的范围，不能借 IPC 自行提权。
    const next = { ...patch };
    if (patch.caps !== undefined) {
      const allowed = new Set(gate.entitlement.caps);
      next.caps = (Array.isArray(patch.caps) ? patch.caps : []).filter((cap) => allowed.has(cap));
    }
    if (patch.maxJobsPerHour !== undefined) {
      const value = Number(patch.maxJobsPerHour);
      next.maxJobsPerHour = Math.min(
        Number.isInteger(value) ? value : gate.entitlement.maxJobsPerHour,
        gate.entitlement.maxJobsPerHour,
      );
    }
    const result = registry.update(String(input && input.id || ''), next);
    return result.ok ? { ok: true, instance: result.instance } : { ok: false, error: result.error };
  });

  handleIpc('apps:remove', async (_event, input) => {
    const id = String(input && input.id || '');
    const gate = guard();
    // 授权失效后仍允许删除登记（否则用户清不掉已绑定的实例）；purge 会删数据目录，必须过闸。
    if (!gate.ok && input && input.purge === true) {
      return { ok: false, error: gate.message, code: gate.code };
    }
    const result = await host.remove(id, { purge: input && input.purge === true });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  handleIpc('apps:deploy', async (_event, input) => {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const instanceId = String(input && input.id || '');
    // 重新部署前先停掉在跑的实例：Windows 会锁住正在运行的 exe，直接覆盖会失败。
    // 这一步也让「旧版本 → 新版本」升级不需要用户先去点停止。
    await host.stop(instanceId).catch(() => undefined);
    return host.deploy(instanceId, {
      ...(input && typeof input.source === 'string' ? { source: input.source } : {}),
      ...(input && input.keepExe === true ? { keepExe: true } : {}),
    });
  });

  handleIpc('apps:start', async (_event, input) => {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const id = String(input && input.id || '');
    const started = await host.start(id);
    // 端口可能变了：把引用这条实例的规则地址同步过去（失败不回滚启动）。
    if (started.ok) {
      const instance = registry.get(id);
      if (instance) {
        const synced = await syncRulesForInstance(deps, id, host.webhookUrlOf(instance));
        if (synced > 0) return { ...started, rulesSynced: synced };
      }
    }
    return started;
  });

  handleIpc('apps:stop', (_event, input) => host.stop(String(input && input.id || '')));

  handleIpc('apps:restart', async (_event, input) => {
    const id = String(input && input.id || '');
    await host.stop(id);
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const started = await host.start(id);
    if (started.ok) {
      const instance = registry.get(id);
      if (instance) {
        const synced = await syncRulesForInstance(deps, id, host.webhookUrlOf(instance));
        if (synced > 0) return { ...started, rulesSynced: synced };
      }
    }
    return started;
  });

  handleIpc('apps:status', (_event, input) => host.status(String(input && input.id || '')));

  /** 立即补推一次票据：改配额/改 IP 后不必等下一个续期周期。 */
  handleIpc('apps:push-ticket', async (_event, input) => {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const id = String(input && input.id || '');
    const instance = registry.get(id);
    if (!instance) return { ok: false, error: '实例不存在' };
    if (instance.mode !== 'lan') {
      return { ok: false, error: '本机实例的票据由命名管道自取，不需要推送' };
    }
    return host.pushTicket(id);
  });

  handleIpc('apps:logs', (_event, input) => host.logs(String(input && input.id || '')));

  handleIpc('apps:proxy', async (_event, input) => {
    const action = String(input && input.action || '');
    const write = action === 'sendMessage' || action === 'sendAttachments';
    if (write) {
      const gate = guard();
      if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    }
    return host.proxy(String(input && input.id || ''), action, input && input.payload);
  });

  handleIpc('apps:open-dir', (_event, input) => {
    const instance = registry.get(String(input && input.id || ''));
    if (!instance) return { ok: false, error: '实例不存在' };
    const dir = host.instanceDirOf(instance);
    try {
      const error = shell.openPath(dir);
      return error ? { ok: false, error } : { ok: true, dir };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  handleIpc('apps:seed-caps', (_event, input) => {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const instance = registry.get(String(input && input.id || ''));
    if (!instance) return { ok: false, error: '实例不存在' };
    // 把证书里的能力/配额重新对齐到该实例（新增功能位后无需手工逐项勾选）。
    const result = registry.update(instance.id, {
      caps: gate.entitlement.caps,
      maxJobsPerHour: gate.entitlement.maxJobsPerHour,
    });
    return result.ok ? { ok: true, instance: result.instance } : { ok: false, error: result.error };
  });

  /**
   * 可作为「下游 Webhook」的托管实例清单。
   *
   * 两种调用方：规则表单的「托管应用环境」下拉、AI 回复的默认 Webhook 区块。
   * 地址一律脱敏；真实地址只在 {@link apps:save-rule} 里解析。
   */
  handleIpc('apps:webhook-targets', () => {
    const gate = guard();
    return { ok: true, licensed: gate.ok, targets: webhookTargets(deps, gate) };
  });

  registerWebhookAddressChannels(handleIpc, deps, guard);
}

/**
 * 「下游地址选托管应用」的三个频道。
 *
 * 独立成一个函数是因为 `registerAppsIpc` 已经逼近单函数行数闸门；
 * 这三条也只是「解析实例地址 → 代写一条后端记录」，与其余实例管理动作无关。
 * @param {(channel: string, handler: Function) => void} handleIpc - 已包好 trust 的注册器。
 * @param {object} deps - `{ registry, host, callBackend }`。
 * @param {() => object} guard - 现取授权结论。
 */
function registerWebhookAddressChannels(handleIpc, deps, guard) {
  const { registry, host } = deps;

  /** 解析实例 → 真实地址；任何不可用都回带机器码的拒绝。 */
  function resolveInstance(input, verb) {
    const gate = guard();
    if (!gate.ok) return { ok: false, error: gate.message, code: gate.code };
    const instanceId = String(input && input.instanceId || '');
    const instance = registry.get(instanceId);
    if (!instance) return { ok: false, error: '托管实例不存在，请刷新后重试', code: 'UNKNOWN_INSTANCE' };
    if (!instance.enabled) {
      return { ok: false, error: '该实例已停用，请先在「应用托管」中启用', code: 'INSTANCE_DISABLED' };
    }
    const realUrl = host.webhookUrlOf(instance);
    if (realUrl === '') {
      return {
        ok: false,
        error: '该实例还没运行（缺少 API 端口或令牌）；请先在「应用托管」启动它，再' + verb,
        code: 'APP_NOT_READY',
      };
    }
    if (typeof deps.callBackend !== 'function') {
      return { ok: false, error: '后端不可用，无法' + verb, code: 'BACKEND_UNAVAILABLE' };
    }
    return { ok: true, instance, realUrl };
  }

  handleIpc('apps:save-rule', async (_event, input) => {
    const target = resolveInstance(input, '保存规则');
    if (!target.ok) return target;
    const payload = input && typeof input.rule === 'object' ? input.rule : {};
    const saved = await deps.callBackend('saveMessageListRule', [{
      ...(payload.id === undefined ? {} : { id: payload.id }),
      chatName: payload.chatName,
      targetName: payload.targetName,
      webhookUrl: target.realUrl,
      greetingText: payload.greetingText,
      note: payload.note,
      enabled: payload.enabled,
      appInstanceId: target.instance.id,
    }]);
    const value = saved && saved.ok ? saved.value : null;
    if (!value || value.ok !== true) {
      const message = (value && value.error) || (saved && saved.error && saved.error.message) || '规则保存失败';
      return { ok: false, error: message };
    }
    return {
      ok: true,
      id: value.id,
      backfilled: value.backfilled,
      maskedUrl: host.redactEndpoint(target.realUrl),
      instanceId: target.instance.id,
    };
  });

  handleIpc('apps:save-ai-reply-webhook', async (_event, input) => {
    const target = resolveInstance(input, '保存地址');
    if (!target.ok) return target;
    const chatUsername = String(input && input.chatUsername || '');
    if (chatUsername === '') return { ok: false, error: '缺少当前会话', code: 'BAD_REQUEST' };
    const saved = await deps.callBackend('saveChatAiReplyDefaultWebhook', [{
      chatUsername,
      ...(input && input.chatName ? { chatName: String(input.chatName) } : {}),
      webhookUrl: target.realUrl,
      appInstanceId: target.instance.id,
    }]);
    const value = saved && saved.ok ? saved.value : null;
    if (!value || value.ok !== true) {
      const message = (value && value.error) || (saved && saved.error && saved.error.message) || '保存默认 Webhook 失败';
      return { ok: false, error: message };
    }
    return {
      ok: true,
      ...value,
      maskedUrl: host.redactEndpoint(target.realUrl),
      instanceId: target.instance.id,
    };
  });
}

module.exports = {
  currentEntitlement,
  licenseSummaryOf,
  registerAppsIpc,
};

