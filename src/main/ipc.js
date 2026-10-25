// IPC 接口:渲染进程与主进程的唯一通道
const { ipcMain, dialog, shell, BrowserWindow, Notification, session, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const providers = require('./providers');
const { runChat } = require('./agent');
const { DEFAULT_SKILLS } = require('./promptPresets');
const { DEFAULT_SUBAGENTS } = require('./store');
const { DEFAULT_TEAMS } = require('./store');
const oauth = require('./oauth');
const mcp = require('./mcp');
const dsh = require('./dsh');
const dshHost = require('./dshHost');
const security = require('./security')
const imagegen = require('./imagegen');
const debuglog = require('./debuglog');
const modelCaps = require('./modelCaps');
const compressPolicy = require('./compress.js');
const modeldb = require('./modeldb');
const pluginHost = require('./pluginHost');
const specialty = require('./specialty');
const attachments = require('./attachments');
const http = require('./http');
const proxy = require('./proxy');
const terminal = require('./terminal');
const datapath = require('./datapath');
const appower = require('./appower');
const traymgr = require('./traymgr');
const blender = require('./blender');

const streams = new Map(); // streamId → { ac, decisions, asks, convId }

function register(store) {
  ipcMain.handle('config:get', () => store.config);

  ipcMain.handle('config:set', (e, patch) => {
    const cfg = store.updateConfig(patch || {});
    debuglog.info(store, 'config', 'config:set', { keys: Object.keys(patch || {}) });
    // 远程控制(v0.54.0):启停/端口/授权变化 → 实时应用(开启且无 token 时在此生成并落盘)
    if (patch && patch.remote) {
      try { require('./remote').applyConfig(cfg, { store, streams, chatSendCore }); } catch (err) {
        debuglog.warn(store, 'remote', 'apply-fail', { message: String(err.message || err).slice(0, 200) });
      }
    }
    // 代理设置变化 → 立即应用到 session(下一次请求生效)
    if (patch && patch.proxy) proxy.applyProxy(store).catch((err) => {
      debuglog.warn(store, 'proxy', 'apply-failed', { message: String(err.message || err).slice(0, 200) });
    });
    // 毛玻璃/透明度变化 → 实时应用窗口材质('none' = 显式关闭;'auto' 会让 DWM 常驻合成,空闲 GPU 大增)
    // v0.49.4:UI 收敛为滑杆,渲染端 saveUi 同步派生 glass/transparent 标志;这里兼容滑杆直改。
    // v0.49.5:系统亚克力与窗口透明互斥 —— 透明优先,要透明时强制 none(透明由渲染端底面 alpha 承担)。
    if (patch && patch.ui && (patch.ui.glass !== undefined || patch.ui.glassLevel !== undefined || patch.ui.transparent !== undefined || patch.ui.bgOpacity !== undefined || patch.ui.powerSave !== undefined || patch.ui.pureTerminal !== undefined)) {
      const ui = store.config.ui || {};
      const glassWanted = ui.glass !== undefined ? !!ui.glass : (Number(ui.glassLevel) || 0) >= 10;
      const transWanted = ui.transparent !== undefined ? !!ui.transparent : (ui.bgOpacity !== undefined && Number(ui.bgOpacity) <= 99);
      const material = (glassWanted && !transWanted && !ui.powerSave && !ui.pureTerminal) ? 'acrylic' : 'none';
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (w.setBackgroundMaterial) w.setBackgroundMaterial(material); } catch (_) { /* 平台不支持 */ }
      }
    }
    // DSH 运行时层总开关(实验性,默认关)
    if (patch && patch.dev && patch.dev.dshHost !== undefined) {
      try { dshHost.applyConfigChange(store); } catch (_) { /* ignore */ }
    }
    // Blender 建模工具链(v0.55.0):开关/端口变化 → 实时应用(启停后端/看护/选中桥)
    if (patch && patch.blender) {
      try { blender.applyConfig(store); } catch (err) {
        debuglog.warn(store, 'blender', 'apply-fail', { message: String(err.message || err).slice(0, 200) });
      }
    }
    // 常规设置(v0.40):保持唤醒即时生效;托盘开关同步托盘生命周期
    if (patch && patch.general) {
      appower.apply(store.config);
      traymgr.sync(store.config);
    }
    return cfg;
  });

  // ---- 常规设置(v0.40):系统通知 / 数据与缓存路径 / 重启 ----
  ipcMain.handle('app:notify', (e, { title, body }) => {
    const g = (store.config && store.config.general) || {};
    if (g.taskNotify === false || !Notification.isSupported()) return { ok: false };
    try {
      const n = new Notification({ title: String(title || 'LiteAgent').slice(0, 60), body: String(body || '').slice(0, 200), silent: g.soundNotify === false });
      n.show();
      return { ok: true };
    } catch (_) { return { ok: false }; }
  });

  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.quit(); });

  ipcMain.handle('general:paths', () => {
    const base = store.baseDir();
    return {
      dataDir: base,
      cacheDir: path.join(base, 'Cache'),
      usingCustom: path.resolve(base) !== path.resolve(datapath.defaultDir()),
    };
  });
  ipcMain.handle('general:openDataDir', () => { try { shell.openPath(store.baseDir()); return { ok: true }; } catch (_) { return { ok: false }; } });
  ipcMain.handle('general:openCacheDir', () => {
    const dir = path.join(store.baseDir(), 'Cache');
    try { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); return { ok: true }; } catch (_) { return { ok: false }; }
  });
  ipcMain.handle('general:setDataDir', (e, dir) => datapath.setCustomDir(dir));
  ipcMain.handle('general:resetDataDir', () => datapath.resetToDefault());
  ipcMain.handle('general:clearCache', async () => {
    try {
      await session.defaultSession.clearCache();
      return { ok: true };
    } catch (err) { return { ok: false, message: String(err && err.message || err) }; }
  });

  // ---- 无边框窗口控制(自绘标题栏) ----
  ipcMain.handle('appwin:minimize', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.minimize(); });
  ipcMain.handle('appwin:maximize', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.handle('appwin:close', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.close(); });

  ipcMain.handle('app:presets', () => providers.PRESETS);

  // ---- 供应商账号 OAuth 登录 ----
  ipcMain.handle('oauth:login', (e, { kind, providerId }) => {
    if (!kind || !providerId) throw new Error('参数缺失');
    return oauth.login(store, kind, providerId); // 长耗时(等待用户授权),UI 轮询 oauth:status 展示进度
  });
  ipcMain.handle('oauth:status', (e, { kind }) => oauth.status(store, kind));
  ipcMain.handle('oauth:logout', (e, { kind, providerId }) => oauth.logout(store, kind, providerId));
  ipcMain.handle('oauth:refresh', async (e, { kind, providerId }) => {
    const token = await oauth.ensureFresh(store, kind, providerId);
    return { ok: !!token };
  });

  // ---- 右侧面板浏览器(主进程 WebContentsView,按标签 tabId 管理多视图) ----
  const panelViews = new Map(); // tabId → WebContentsView
  let panelViewAttachedId = null;
  const panelViewSend = (tabId, o) => { o.tabId = tabId; for (const w of BrowserWindow.getAllWindows()) w.webContents.send('panelweb:event', o); };
  const panelViewGet = (tabId) => {
    if (panelViews.has(tabId)) return panelViews.get(tabId);
    const { WebContentsView } = require('electron');
    const v = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:panel' },
    });
    v.webContents.on('did-navigate', (_e, url) => panelViewSend(tabId, { type: 'did-navigate', url }));
    v.webContents.on('did-fail-load', (_e, code, desc) => { if (code !== -3) panelViewSend(tabId, { type: 'did-fail-load', code, desc }); });
    v.webContents.on('did-finish-load', () => panelViewSend(tabId, { type: 'did-finish-load' }));
    v.webContents.on('page-title-updated', (_e, title) => panelViewSend(tabId, { type: 'title', title }));
    // 指针锁兜底(v0.54.21):FPS 游戏的 Pointer Lock 常带"重锁循环"(Esc 一释放立刻再锁,用户被卡死)。
    // 连按两次 Esc → 注入禁用 shim(覆盖 requestPointerLock 为 no-op)+ 强制 exitPointerLock,该页面本次不再锁定。
    const escAt = { t: 0 };
    v.webContents.on('before-input-event', (_e, input) => {
      if (!input || input.type !== 'keyDown' || input.key !== 'Escape') return;
      const now = Date.now();
      if (now - escAt.t > 700) { escAt.t = now; return; } // 第一次 Esc:让 Chromium 原生释放
      escAt.t = 0;
      v.webContents.executeJavaScript(`(function () {
        try {
          if (HTMLElement.prototype.requestPointerLock.toString().indexOf('native code') !== -1) {
            HTMLElement.prototype.requestPointerLock = function () { window.__litePtrKilled = true; return undefined; };
          }
        } catch (_) {}
        try { document.exitPointerLock && document.exitPointerLock(); } catch (_) {}
        window.__litePtrKilled = true;
        return true;
      })()`).then((ok) => { if (ok) panelViewSend(tabId, { type: 'ptr-unlocked' }); }).catch(() => {});
    });
    v.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) v.webContents.loadURL(url);
      return { action: 'deny' };
    });
    panelViews.set(tabId, v);
    return v;
  };
  const panelViewAttach = (tabId) => {
    const v = panelViewGet(tabId);
    const w = BrowserWindow.getAllWindows()[0];
    if (panelViewAttachedId !== tabId) {
      if (panelViewAttachedId != null && panelViews.has(panelViewAttachedId)) {
        try { w.contentView.removeChildView(panelViews.get(panelViewAttachedId)); } catch (_) { /* ignore */ }
      }
      w.contentView.addChildView(v);
      panelViewAttachedId = tabId;
    }
    v.setVisible(true);
    return v;
  };
  const panelViewDetachAll = () => {
    if (panelViewAttachedId == null) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (panelViews.has(panelViewAttachedId)) w.contentView.removeChildView(panelViews.get(panelViewAttachedId)); } catch (_) { /* ignore */ }
    }
    panelViewAttachedId = null;
  };
  ipcMain.handle('panelweb:navigate', (_e, { tabId, url }) => {
    if (!/^(https?:\/\/|file:\/\/|data:)/i.test(String(url))) throw new Error('仅支持 http/https/file/data 地址');
    const v = panelViewAttach(String(tabId));
    return v.webContents.loadURL(String(url)).then(() => ({ ok: true })).catch((err) => ({ ok: false, error: String(err.message || err) }));
  });
  // 打开前预检(v0.54.21):file/data 页面是否用 Pointer Lock —— 四个 HTML 入口统一走这里,命中则渲染端挂提示条
  ipcMain.handle('panelweb:precheck', (_e, { url }) => {
    try {
      const u = String(url || '');
      let html = '';
      if (/^file:\/\//i.test(u)) {
        const p = decodeURIComponent(u.replace(/^file:\/\/\/?/i, '')).split(/[?#]/)[0];
        const abs = require('path').resolve(p);
        const st = require('fs').statSync(abs);
        if (st.isFile() && st.size <= 2 * 1024 * 1024) html = require('fs').readFileSync(abs, 'utf8');
      } else if (/^data:text\/html/i.test(u)) {
        const b64 = /base64,(.*)$/i.exec(u);
        html = b64 ? Buffer.from(b64[1], 'base64').toString('utf8') : decodeURIComponent(u.replace(/^data:text\/html[,;]?/i, ''));
      }
      return { lock: /requestPointerLock|pointerLockElement/i.test(html.slice(0, 400000)) };
    } catch (_) { return { lock: false }; }
  });
  ipcMain.handle('panelweb:setBounds', (_e, { tabId, rect }) => {
    if (!tabId || !rect || rect.width < 1 || rect.height < 1) { panelViewDetachAll(); return; }
    const v = panelViewAttach(String(tabId));
    v.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  });
  ipcMain.handle('panelweb:hide', () => panelViewDetachAll());
  ipcMain.handle('panelweb:closeTab', (_e, { tabId }) => {
    const v = panelViews.get(String(tabId));
    if (!v) return;
    if (panelViewAttachedId === String(tabId)) panelViewDetachAll();
    try { v.webContents.close(); } catch (_) { /* ignore */ }
    panelViews.delete(String(tabId));
  });
  ipcMain.handle('panelweb:back', (_e, { tabId }) => { const v = panelViews.get(String(tabId)); if (v && v.webContents.canGoBack()) v.webContents.goBack(); });
  ipcMain.handle('panelweb:fwd', (_e, { tabId }) => { const v = panelViews.get(String(tabId)); if (v && v.webContents.canGoForward()) v.webContents.goForward(); });
  ipcMain.handle('panelweb:reload', (_e, { tabId }) => { const v = panelViews.get(String(tabId)); if (v) v.webContents.reload(); });

  ipcMain.handle('app:version', () => {
    try { return require('../../package.json').version; } catch (_) { return '?'; }
  });

  ipcMain.handle('app:openExternal', (e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
    return { ok: true };
  });

  // ---- 模型推理能力(内置官方库 + 供应商上游探测合并) ----
  ipcMain.handle('reason:caps', (e, { model, providerId }) => {
    const p = store.config.providers.find((x) => x.id === providerId);
    const db = modelCaps.getModelDb(store);
    const caps = modelCaps.forModel(model, p && p.modelCaps, db);
    // 手动最大上下文最优先(v0.51.0):供应商模型行填了 ctxLimit 就用它,否则查 models.dev 快照
    const manualCtx = p && p.modelCaps && p.modelCaps[model] && Number(p.modelCaps[model].ctxLimit);
    // 压缩策略窗口(GPT 272K / 按模型预设)与上下文显示统一:新模型不在快照里时也能拿到分母
    const policy = compressPolicy.resolvePolicy({ settings: store.config, provider: p, model, db });
    let contextLimit = manualCtx || modelCaps.contextLimit(model, db);
    if (policy.enabled && policy.window > 0) contextLimit = policy.window;
    // unknown = 规则与官方库都查无此模型(区别于 style:'none' 的"确认不支持"),渲染端徽章文案分叉
    return { ...caps, unknown: !caps, contextLimit }; // 用量条「上下文已用 x%」分母
  });
  ipcMain.handle('reason:capsBatch', (e, { models, providerId }) => {
    const p = store.config.providers.find((x) => x.id === providerId);
    const db = modelCaps.getModelDb(store);
    const out = {};
    for (const m of models || []) {
      const caps = modelCaps.forModel(m, p && p.modelCaps, db);
      const policy = compressPolicy.resolvePolicy({ settings: store.config, provider: p, model: m, db });
      let contextLimit = (p && p.modelCaps && p.modelCaps[m] && Number(p.modelCaps[m].ctxLimit)) || modelCaps.contextLimit(m, db);
      if (policy.enabled && policy.window > 0) contextLimit = policy.window;
      out[m] = { ...caps, contextLimit };
    }
    return out;
  });

  // ---- 模型能力数据库(models.dev) ----
  ipcMain.handle('modeldb:stats', () => {
    const db = modelCaps.getModelDb(store);
    return { count: (db && db.count) || 0, updatedAt: (db && db.updatedAt) || null, source: (db && db.source) || null };
  });
  ipcMain.handle('modeldb:update', async (e) => {
    const db = await modeldb.updateModelDb(store);
    debuglog.info(store, 'modeldb', '能力库已更新', { count: db.count });
    return { ok: true, count: db.count, updatedAt: db.updatedAt };
  });

  // ---- LiteAgent 原生插件(SDK) ----
  ipcMain.handle('lite:list', () => pluginHost.list(store));
  ipcMain.handle('lite:reload', async () => pluginHost.reload(store));
  ipcMain.handle('lite:setEnabled', (e, { id, enabled }) => {
    const map = { ...(store.config.pluginsLite || {}), [id]: !!enabled };
    store.updateConfig({ pluginsLite: map });
    return pluginHost.reload(store);
  });
  ipcMain.handle('lite:openDir', () => {
    const dir = pluginHost.pluginDir(store);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  // ---- 技能专精 ----
  ipcMain.handle('specialty:list', () => specialty.list(store));
  ipcMain.handle('specialty:setActive', (e, id) => {
    const cfg = store.updateConfig({ ui: { activeSpecialtyId: id || null } });
    debuglog.info(store, 'specialty', '切换专精', { id: id || null });
    return cfg;
  });
  ipcMain.handle('specialty:import', async (e, srcPath) => {
    const pack = await specialty.importFromPath(store, srcPath);
    debuglog.info(store, 'specialty', '导入专精', { id: pack.id, files: pack.fileCount });
    return { ok: true, pack };
  });
  ipcMain.handle('specialty:pick', async (e, mode) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = mode === 'dir'
      ? { title: '选择专精文件夹(含知识 Markdown)', properties: ['openDirectory'] }
      : { title: '选择专精包(.zip 或 .md)', filters: [{ name: '专精包 (zip/md)', extensions: ['zip', 'md'] }], properties: ['openFile'] };
    const r = await dialog.showOpenDialog(win, opts);
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('specialty:delete', (e, id) => {
    const ok = specialty.deletePack(store, id);
    const cfg = store.updateConfig({ ui: { activeSpecialtyId: store.config.ui.activeSpecialtyId === id ? null : store.config.ui.activeSpecialtyId } });
    return { ok, config: cfg };
  });
  ipcMain.handle('specialty:openDir', () => {
    const dir = specialty.userRoot(store);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  // ---- 服务商 ----
  ipcMain.handle('providers:upsert', (e, provider) => {
    const list = store.config.providers;
    const idx = list.findIndex((x) => x.id === provider.id);
    let apiKeys = Array.isArray(provider.apiKeys)
      ? provider.apiKeys.map((s) => String(s).trim()).filter(Boolean)
      : [];
    if (!apiKeys.length && typeof provider.apiKey === 'string' && provider.apiKey.trim()) {
      apiKeys = [provider.apiKey.trim()];
    }
    const existing = idx >= 0 ? list[idx] : null;
    const clean = {
      id: String(provider.id || ''),
      name: String(provider.name || '未命名').slice(0, 40),
      type: ['openai', 'anthropic', 'gemini'].includes(provider.type) ? provider.type : 'openai',
      baseUrl: String(provider.baseUrl || '').trim(),
      apiKey: apiKeys[0] || '',
      apiKeys,
      models: Array.isArray(provider.models) ? provider.models.map(String).filter(Boolean) : [],
      local: !!provider.local,
      modelCaps: (provider.modelCaps && typeof provider.modelCaps === 'object' && !Array.isArray(provider.modelCaps))
        ? provider.modelCaps
        : ((existing && existing.modelCaps) || {}),
    };
    if (!clean.id) return store.config;
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    store.updateConfig({ providers: list });
    return store.config;
  });

  ipcMain.handle('providers:delete', (e, id) => {
    const p = store.config.providers.find((x) => x.id === id);
    const patch = { providers: store.config.providers.filter((x) => x.id !== id) };
    // 删的是预置模板 → 记下,否则下次启动被预置注入重新加回来(v0.57.7)
    if (p && providers.PRESETS.some((x) => x.id === id)) {
      patch.removedPresets = [...new Set([...(store.config.removedPresets || []), id])];
    }
    store.updateConfig(patch);
    return store.config;
  });

  // —— 一键清理未使用的服务商模板(v0.57.7)——
  // 判定:无 Key、无已登录 OAuth,且未被任何入口引用(当前模型 / 子智能体 / 团队队员 / 生图服务商)。
  // 带 Key、已登录、被引用的一律不碰。dryRun 用于预览确认与按钮计数。
  const unusedProviderIds = (cfg) => {
    const refs = new Set();
    if (cfg.lastModel && cfg.lastModel.providerId) refs.add(cfg.lastModel.providerId);
    for (const s of cfg.subagents || []) if (s.providerId) refs.add(s.providerId);
    for (const tm of cfg.teams || []) for (const w of tm.workers || []) if (w.providerId) refs.add(w.providerId);
    if (cfg.imageGen && cfg.imageGen.providerId) refs.add(cfg.imageGen.providerId);
    const accounts = cfg.oauthAccounts || {};
    const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
    return (cfg.providers || []).filter((p) => {
      if (refs.has(p.id)) return false;
      if (p.oauth) {
        const acc = accounts[p.oauth];
        return !(acc && acc.accessToken); // 已登录的保留
      }
      const keys = (p.apiKeys || []).length + (p.apiKey ? 1 : 0);
      if (keys > 0) return false;
      // 只有「预设模板」或「连 BaseURL 都没填的空条目」才算可清理;
      // 用户自建/改过 BaseURL 的条目不碰(可能只是还没填 Key)
      const preset = providers.PRESETS.find((x) => x.id === p.id);
      if (!preset) return !String(p.baseUrl || '').trim();
      return norm(p.baseUrl) === norm(preset.baseUrl);
    }).map((p) => p.id);
  };
  ipcMain.handle('providers:cleanupUnused', (e, opts) => {
    const dry = !!(opts && opts.dryRun);
    const ids = unusedProviderIds(store.config);
    const names = ids.map((id) => (store.config.providers.find((p) => p.id === id) || {}).name).filter(Boolean);
    if (!dry && ids.length) {
      const del = new Set(ids);
      const patch = { providers: store.config.providers.filter((p) => !del.has(p.id)) };
      const presetIds = ids.filter((id) => providers.PRESETS.some((x) => x.id === id));
      if (presetIds.length) patch.removedPresets = [...new Set([...(store.config.removedPresets || []), ...presetIds])];
      store.updateConfig(patch);
    }
    return { config: store.config, removed: ids, names };
  });

  ipcMain.handle('providers:addPreset', (e, presetId) => {
    const preset = providers.PRESETS.find((p) => p.id === presetId);
    if (preset && !store.config.providers.some((p) => p.id === preset.id)) {
      store.config.providers.push({ ...preset, models: [...(preset.models || [])], apiKey: '' });
      // 手动重新添加 = 取消删除记录,以后版本升级仍会自动补册
      const kept = (store.config.removedPresets || []).filter((x) => x !== preset.id);
      store.updateConfig({ providers: store.config.providers, removedPresets: kept });
    }
    return store.config;
  });

  ipcMain.handle('providers:fetchModels', async (e, arg) => {
    // 兼容两种调用：旧版传 id 字符串 = 直接合并入库；新版传 { id, preview } = 只拉取，供二级窗口勾选
    const id = typeof arg === 'string' ? arg : (arg && arg.id);
    const preview = !!(arg && arg.preview);
    const p = store.config.providers.find((x) => x.id === id);
    if (!p) throw new Error('服务商不存在');
    if (!p.baseUrl) throw new Error('请先填写 BaseURL');
    // Gemini OAuth 账号:模型清单走 Cloud Code 专用端点
    if (p.oauth === 'gemini') {
      const models = await oauth.fetchModelsForOauth(store, 'gemini', id);
      return { models, config: store.config, capsMerged: 0, preview };
    }
    const adapter = providers.getAdapter(p.type);
    const guard = (u) => security.assertUrlAllowed(u, store.config.security || {});
    const primaryKey = (p.apiKeys && p.apiKeys[0]) || p.apiKey || '';
    const list = await adapter.listModels(p.baseUrl, primaryKey, guard);
    if (!preview) p.models = [...new Set([...(p.models || []), ...list])];
    // 上游推理能力探测(OpenRouter 风格 supported_parameters),失败静默;
    // 合并规则:手动逐模型配置(source:'manual')不被覆盖(mergeUpstreamCaps)
    let capsMerged = 0;
    try {
      if (adapter.fetchCaps) {
        const caps = await adapter.fetchCaps(p.baseUrl, primaryKey, guard);
        if (caps && Object.keys(caps).length) {
          p.modelCaps = modelCaps.mergeUpstreamCaps(p.modelCaps, caps);
          capsMerged = Object.keys(caps).length;
        }
      }
    } catch (_) { /* 能力探测失败不影响模型列表 */ }
    if (!preview) store.updateConfig({ providers: store.config.providers });
    return { models: list, config: store.config, capsMerged, preview };
  });

  // 二级窗口勾选后批量入库(v0.57.8):只加选中的模型,并把刚探测到的能力一起落盘
  ipcMain.handle('providers:addModels', (e, { id, models }) => {
    const p = store.config.providers.find((x) => x.id === id);
    if (p) {
      const add = (models || []).map((m) => String(m || '').trim()).filter(Boolean);
      p.models = [...new Set([...(p.models || []), ...add])];
      store.updateConfig({ providers: store.config.providers });
    }
    return store.config;
  });

  ipcMain.handle('providers:addModel', (e, { id, model }) => {
    const p = store.config.providers.find((x) => x.id === id);
    const m = String(model || '').trim();
    if (p && m && !p.models.includes(m)) {
      p.models = [...(p.models || []), m];
      store.updateConfig({ providers: store.config.providers });
    }
    return store.config;
  });

  ipcMain.handle('providers:removeModel', (e, { id, model }) => {
    const p = store.config.providers.find((x) => x.id === id);
    if (p) {
      p.models = (p.models || []).filter((m) => m !== model);
      store.updateConfig({ providers: store.config.providers });
    }
    return store.config;
  });

  // ---- 助手(提示词角色) ----
  ipcMain.handle('assistants:upsert', (e, a) => {
    const clean = {
      id: String(a.id || ''),
      name: String(a.name || '未命名').slice(0, 30),
      icon: String(a.icon || '🤖').slice(0, 8),
      prompt: String(a.prompt || '').slice(0, 8000),
    };
    if (!clean.id) return store.config;
    const list = store.config.assistants;
    const idx = list.findIndex((x) => x.id === clean.id);
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    store.updateConfig({ assistants: list });
    return store.config;
  });

  ipcMain.handle('assistants:delete', (e, id) => {
    if (id === 'default') return store.config; // 默认助手不可删
    store.updateConfig({ assistants: store.config.assistants.filter((a) => a.id !== id) });
    return store.config;
  });

  // ---- 技能 ----
  ipcMain.handle('skills:upsert', (e, s) => {
    const clean = {
      id: String(s.id || ''),
      name: String(s.name || '未命名').slice(0, 20),
      icon: String(s.icon || '⚡').slice(0, 8),
      prompt: String(s.prompt || '').slice(0, 4000),
      insert: String(s.insert || '').slice(0, 2000),
      agent: !!s.agent,
    };
    if (!clean.id) return store.config;
    const list = store.config.skills;
    const idx = list.findIndex((x) => x.id === clean.id);
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    store.updateConfig({ skills: list });
    return store.config;
  });

  ipcMain.handle('skills:delete', (e, id) => {
    store.updateConfig({ skills: store.config.skills.filter((s) => s.id !== id) });
    return store.config;
  });

  ipcMain.handle('skills:restoreDefaults', () => {
    const existing = new Set(store.config.skills.map((s) => s.id));
    const merged = [...store.config.skills, ...DEFAULT_SKILLS.filter((s) => !existing.has(s.id)).map((s) => ({ ...s }))];
    store.updateConfig({ skills: merged });
    return store.config;
  });

  // 子智能体/团队模板:恢复缺失的预设(按 id 合并,用户自建与改动保留)
  ipcMain.handle('subagents:restoreDefaults', () => {
    const subs = store.config.subagents || [];
    const subExisting = new Set(subs.map((s) => s.id));
    const mergedSubs = [...subs, ...DEFAULT_SUBAGENTS.filter((s) => !subExisting.has(s.id)).map((s) => ({ ...s }))];
    const teams = store.config.teams || [];
    const teamExisting = new Set(teams.map((t) => t.id));
    const mergedTeams = [...teams, ...DEFAULT_TEAMS.filter((t) => !teamExisting.has(t.id)).map((t) => ({ ...t, workers: t.workers.map((w) => ({ ...w })) }))];
    store.updateConfig({ subagents: mergedSubs, teams: mergedTeams });
    return store.config;
  });

  // ---- 安全审计 ----
  ipcMain.handle('audit:stats', () => security.auditStats(store));
  ipcMain.handle('audit:clear', () => security.auditClear(store));
  ipcMain.handle('audit:open', () => {
    const dir = security.auditDir(store);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  // ---- 调试诊断 ----
  ipcMain.handle('debug:report', (e, payload) => {
    const p = payload || {};
    debuglog.error(store, 'renderer', String(p.message || '未知错误').slice(0, 500), {
      stack: String(p.stack || '').slice(0, 2000),
      source: String(p.source || '').slice(0, 300),
    });
    return { ok: true };
  });
  ipcMain.handle('debug:stats', () => debuglog.stats(store));
  ipcMain.handle('debug:openDir', () => {
    const dir = debuglog.logDir(store);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });
  ipcMain.handle('debug:clear', () => {
    const dir = debuglog.logDir(store);
    let n = 0;
    try {
      for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('debug-'))) {
        fs.unlinkSync(path.join(dir, f));
        n++;
      }
    } catch (_) { /* ignore */ }
    debuglog.info(store, 'debug', '日志已清空', { removed: n });
    return n;
  });
  // 渲染修复:清除 GPU 着色器缓存(污染会导致黑块/字体糊边,跨版本共享 userData 时尤其致命)并重启。
  // 缓存被本进程占用 → 写一个分离的清理脚本,退出后由它完成删除。
  ipcMain.handle('diag:clearGpuCache', async () => {
    const base = store.baseDir();
    const targets = ['GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Code Cache'];
    const cleaner = path.join(os.tmpdir(), 'liteagent-gpu-cache-clean.js');
    
    fs.writeFileSync(cleaner, 'const fs=require("fs");const dirs=' + JSON.stringify(targets.map((t) => path.join(base, t))) + ';(function run(attempt){let n=0;for(const d of dirs){try{fs.rmSync(d,{recursive:true,force:true});n++;}catch(_){ }}if(n<dirs.length&&attempt<30)return setTimeout(()=>run(attempt+1),1000);try{fs.writeFileSync(__filename+".done",new Date().toISOString());}catch(_){}})(0);', 'utf8');
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [cleaner], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    child.unref();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
    return { ok: true };
  });

  ipcMain.handle('debug:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const name = `LiteAgent-诊断-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const r = await dialog.showSaveDialog(win, {
      title: '导出诊断信息',
      defaultPath: name,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const data = debuglog.diagnostics(store);
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
    debuglog.info(store, 'debug', '诊断包已导出', { path: r.filePath });
    return { ok: true, path: r.filePath };
  });

  // ---- 对话框 ----
  ipcMain.handle('dialog:pickWorkspace', async (e, title) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: String(title || '选择智能体工作目录'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickDir', async (e, title) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: String(title || '选择目录'),
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---- 网络代理 ----
  ipcMain.handle('proxy:resolve', (e, url) => proxy.resolveProxy(url));

  // ---- 内置终端 ----
  terminal.init({
    send: (obj) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (!w.isDestroyed()) w.webContents.send('term:event', obj); } catch (_) { /* ignore */ }
      }
    },
    shell: store.config && store.config.dev && store.config.dev.terminalShell,
  });
  ipcMain.handle('term:write', (e, line) => {
    terminal.write(String(line || ''));
    return { ok: true };
  });
  ipcMain.handle('term:reset', () => {
    terminal.reset();
    return { ok: true };
  });

  // ---- 分组 ----
  ipcMain.handle('groups:upsert', (e, g) => {
    const clean = {
      id: String(g.id || ''),
      name: String(g.name || '新分组').slice(0, 30),
      icon: String(g.icon || '📁').slice(0, 8),
      workspace: String(g.workspace || '').trim(),
    };
    if (!clean.id) clean.id = 'grp-' + Math.random().toString(36).slice(2, 8);
    const list = Array.isArray(store.config.groups) ? store.config.groups : [];
    const idx = list.findIndex((x) => x.id === clean.id);
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    store.updateConfig({ groups: list });
    if (clean.workspace) {
      try { fs.mkdirSync(clean.workspace, { recursive: true }); } catch (_) { /* ignore */ }
    }
    return store.config;
  });

  ipcMain.handle('groups:delete', (e, id) => {
    if (id === 'default') return store.config;
    store.reassignGroup(id, 'default');
    store.updateConfig({ groups: store.config.groups.filter((g) => g.id !== id) });
    return store.config;
  });

  // ---- 会话 ----
  ipcMain.handle('convs:list', () => store.listConvs());

  ipcMain.handle('convs:get', (e, id) => store.getConv(id));
  // 跨会话全局搜索(v0.54.3):扫全部会话的标题/用户消息/AI 正文/工具结果,每个会话给第一条命中
  ipcMain.handle('search:global', (e, { q, limit }) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return { hits: [] };
    const cap = Math.min(80, Math.max(10, Number(limit) || 40));
    const hits = [];
    for (const meta of store.listConvs()) {
      if (hits.length >= cap) break;
      let c = null;
      try { c = store.getConv(meta.id); } catch (_) { continue; }
      if (!c || !Array.isArray(c.messages)) continue;
      const titleHit = String(c.title || '').toLowerCase().includes(query);
      let pushed = false;
      for (let i = 0; i < c.messages.length && hits.length < cap; i++) {
        const m = c.messages[i];
        let text = '';
        if (m.role === 'user') text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ') : '');
        else if (m.role === 'assistant') text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.content || '').join('\n');
        else if (m.role === 'tool') text = String(m.content || '').slice(0, 4000);
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(query);
        if (idx < 0) continue;
        const pre = idx > 60 ? '…' : '';
        const post = idx + query.length + 90 < text.length ? '…' : '';
        const snippet = (pre + text.slice(Math.max(0, idx - 60), idx + query.length + 90)).replace(/\s+/g, ' ').trim();
        hits.push({ convId: meta.id, title: c.title || '(未命名)', idx, role: m.role, snippet, updatedAt: meta.updatedAt });
        pushed = true;
      }
      if (!pushed && titleHit) hits.push({ convId: meta.id, title: c.title || '(未命名)', idx: -1, role: 'title', snippet: '', updatedAt: meta.updatedAt });
    }
    return { hits };
  });

  ipcMain.handle('convs:delete', (e, id) => {
    store.deleteConv(id);
    return store.listConvs();
  });

  ipcMain.handle('convs:rename', (e, { id, title }) => {
    store.renameConv(id, title);
    return store.listConvs();
  });

  // 分支为新对话(v0.49.6):克隆 0..index 为独立会话,返回新会话镜像供渲染端直接打开
  // ---- 生图服务商(v0.50.0):与对话供应商完全独立的专属列表,同一套模式 ----
  ipcMain.handle('imagegen:upsert', (e, provider) => {
    const ig = store.config.imageGen;
    const list = ig.providers || [];
    const idx = list.findIndex((x) => x.id === provider.id);
    let apiKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!apiKeys.length && typeof provider.apiKey === 'string' && provider.apiKey.trim()) apiKeys = [provider.apiKey.trim()];
    const clean = {
      id: String(provider.id || ''),
      name: String(provider.name || '未命名').slice(0, 40),
      type: ['openai', 'gemini'].includes(provider.type) ? provider.type : 'openai',
      baseUrl: String(provider.baseUrl || '').trim(),
      apiKey: apiKeys[0] || '',
      apiKeys,
      models: Array.isArray(provider.models) ? provider.models.map(String).filter(Boolean) : [],
      local: !!provider.local,
    };
    if (!clean.id) return store.config;
    if (idx >= 0) list[idx] = clean;
    else list.push(clean);
    store.updateConfig({ imageGen: { ...ig, providers: list } });
    return store.config;
  });
  ipcMain.handle('imagegen:delete', (e, id) => {
    const ig = store.config.imageGen;
    store.updateConfig({ imageGen: { ...ig, providers: (ig.providers || []).filter((p) => p.id !== id) } });
    return store.config;
  });
  ipcMain.handle('imagegen:fetchModels', async (e, id) => {
    const ig = store.config.imageGen;
    const p = (ig.providers || []).find((x) => x.id === id);
    if (!p) throw new Error('生图服务商不存在');
    if (!p.baseUrl) throw new Error('请先填写 BaseURL');
    const adapter = providers.getAdapter(p.type);
    const guard = (u) => security.assertUrlAllowed(u, store.config.security || {});
    const primaryKey = (p.apiKeys && p.apiKeys[0]) || p.apiKey || '';
    const list = await adapter.listModels(p.baseUrl, primaryKey, guard);
    p.models = [...new Set([...(p.models || []), ...list])];
    store.updateConfig({ imageGen: { ...ig, providers: [...ig.providers] } });
    return { models: p.models, config: store.config };
  });

  // 生图直连(v0.50.0):/img 命令与渲染端调用;总开关关闭直接拒绝(双检)
  ipcMain.handle('imagegen:generate', async (e, { prompt }) => {
    const ig = store.config.imageGen || {};
    if (!ig.enabled || !ig.providerId || !ig.model) throw new Error('图片生成未启用(设置 → 模型 → 图片生成)');
    const provider = (ig.providers || []).find((p) => p.id === ig.providerId);
    if (!provider) throw new Error('未找到生图服务商');
    const apiKey = (provider.apiKeys && provider.apiKeys[0]) || provider.apiKey || '';
    security.auditAppend(store, { kind: 'image', brief: String(prompt || '').slice(0, 120), model: ig.model, via: 'cmd' });
    const imgs = await imagegen.imageGenerate(provider, apiKey, { model: ig.model, prompt: String(prompt || ''), size: ig.size, count: ig.count });
    return imgs;
  });

  // 模型切换提示线落盘(v0.50.0):把 note 追加进会话消息(独立轻量通道,不走 chat:send)
  ipcMain.handle('chat:saveNote', (e, { convId, note }) => {
    let conv = store.getConv(convId);
    if (!conv) {
      // 会话尚无盘上/缓存实体(首条提示线先到):就地建立,避免丢提示
      conv = store.createConv(convId, 'default');
    }
    if (!note) return { ok: false };
    conv.messages.push(note);
    store.saveConv(conv);
    return { ok: true };
  });

  ipcMain.handle('conv:fork', (e, { convId, index }) => {
    const conv = store.getConv(convId);
    const forked = store.forkFrom(conv, index);
    if (!forked) return null;
    store.saveConv(forked);
    debuglog.info(store, 'app', '对话分支新窗口', { from: convId, index, forked: forked.id });
    return forked;
  });

  ipcMain.handle('conv:switchBranch', (e, { convId, index, dir, to }) => {
    const conv = store.getConv(convId);
    if (!conv) return null;
    store.switchBranch(conv, index, dir, to);
    store.saveConv(conv);
    return conv;
  });

  ipcMain.handle('convs:resetUsage', (e, id) => {
    const conv = store.getConv(id);
    if (conv) {
      conv.usage = { prompt: 0, completion: 0, cached: 0, requests: 0 };
      store.saveConv(conv);
    }
    return { ok: true };
  });

  ipcMain.handle('convs:export', async (e, id) => {
    const conv = store.getConv(id);
    if (!conv) return { ok: false, message: '会话不存在' };
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, {
      title: '导出对话为 Markdown',
      defaultPath: `${(conv.title || '对话').replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, store.exportMarkdown(conv), 'utf8');
    return { ok: true, path: r.filePath };
  });

  // ---- 对话 ----
  // 发消息核心(v0.54.0):渲染端 chat:send 与远程控制共用。payload 字段同 chat:send;
  // deliver 决定每个事件的去向(渲染端 = webContents.send,远程 = SSE 广播)。
  function chatSendCore(payload, deliver) {
    const { streamId, convId, providerId, model, userText, retry, branch, agentMode, mode, assistantId, skillId, groupId, reasonLevel } = payload || {};
    // 附件:主进程二次校验(数量/大小/类型白名单);非法项的原因透传给渲染端提示
    const norm = attachments.normalizeIncoming(payload && payload.attachments);
    if (norm.errors.length) debuglog.warn(store, 'chat', 'attachments:rejected', { streamId, errors: norm.errors });
    // 同一会话已有进行中的流 → 自动接管:中止旧流(卡死/异常时用户直接重发即可恢复)
    for (const [sid, s] of streams) {
      if (sid !== streamId && s.convId === convId) {
        try { s.ac.abort(new Error('被新请求接管')); } catch (_) { /* ignore */ }
      }
    }
    const ac = new AbortController();
    streams.set(streamId, { ac, decisions: new Map(), asks: new Map(), convId });
    runChat({ store, send: deliver, streams, streamId, convId, providerId, model, userText, retry, branch, agentMode, mode, assistantId, skillId, groupId, reasonLevel, attachments: norm.attachments, attachWarnings: norm.errors, signal: ac.signal })
      .catch((err) => deliver({ type: 'error', message: (err && err.message) || String(err) }))
      .finally(() => streams.delete(streamId));
    return { ok: true, streamId, convId };
  }

  ipcMain.handle('chat:send', (e, payload) => {
    return chatSendCore(payload, (obj) => {
      if (!e.sender.isDestroyed()) e.sender.send('chat:event', { streamId: payload && payload.streamId, convId: payload && payload.convId, ...obj });
    });
  });

  ipcMain.handle('chat:abort', (e, streamId) => {
    const s = streams.get(streamId);
    if (s) s.ac.abort(new Error('用户停止'));
    return { ok: true };
  });

  ipcMain.handle('tool:decision', (e, { streamId, toolCallId, approved }) => {
    const s = streams.get(streamId);
    if (s && s.decisions.has(toolCallId)) {
      const resolve = s.decisions.get(toolCallId);
      resolve(!!approved);
    }
    return { ok: true };
  });

  ipcMain.handle('ask:answer', (e, { streamId, toolCallId, answer }) => {
    const s = streams.get(streamId);
    if (s && s.asks && s.asks.has(toolCallId)) {
      const done = s.asks.get(toolCallId);
      s.asks.delete(toolCallId);
      done(String(answer || ''));
    }
    return { ok: true };
  });

  // ---- 连接桥凭据安全(v0.54.5):密码 safeStorage 加密保存 + SSH 密码登录命令组装(askpass) ----
  const bridgesMod = require('./bridges');
  ipcMain.handle('bridge:saveEntry', (e, { kind, entry, password }) => {
    const k = kind === 'win' ? 'win' : 'ssh';
    const secure = bridgesMod.secureEntry(entry || {}, password || '');
    const cur = { ...(store.config.bridges || {}) };
    cur[k] = [...(cur[k] || []), secure];
    return store.updateConfig({ bridges: cur });
  });
  ipcMain.handle('bridge:connect', (e, p) => bridgesMod.buildConnectCommand(p || {}, (store.config.dev && store.config.dev.terminalShell) || 'powershell'));
  // 退出清理 askpass 残留脚本(与 terminal.dispose 同批)
  process.on('exit', () => { try { bridgesMod.cleanupAskpass(); } catch (_) {} });

  // ---- 自动任务(v0.54.13):cron 调度,任务到点自动发起对话 ----
  const cron = require('./cron');
  // 开发者选项 UA 覆盖(v0.54.14):全部出站请求(适配器/web_fetch/MCP/搜索)统一注入,getter 动态读配置即时生效
  http.setUserAgentGetter(() => (store.config.dev && store.config.dev.userAgent) || '');
  ipcMain.handle('cron:list', () => cron.list(store).map((x) => ({ ...x })));
  ipcMain.handle('cron:upsert', (e, task) => cron.upsert(store, task || {}));
  ipcMain.handle('cron:delete', (e, id) => { cron.remove(store, id); return { ok: true }; });
  ipcMain.handle('cron:runNow', (e, id) => {
    const task = cron.list(store).find((x) => x.id === id);
    if (!task) throw new Error('任务不存在');
    cron.fire(store, { chatSendCore }, task, Date.now());
    return { ok: true };
  });
  try {
    cron.start(store, { chatSendCore, onFire: (task) => debuglog.info(store, 'cron', 'auto-fire', { id: task.id, name: task.name }) });
  } catch (err) { debuglog.warn(store, 'cron', 'start-fail', { message: String(err && err.message || err).slice(0, 200) }); }

  // ---- Blender 建模工具链(v0.55.0):状态/测试/一键拉起/停止 + 选中桥广播 + boot 应用 ----
  blender.setBroadcaster((obj) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('blender:event', obj); } catch (_) { /* 窗口可能已销毁 */ }
    }
  });
  ipcMain.handle('blender:status', () => blender.status(store));
  ipcMain.handle('blender:test', async () => blender.test(store));
  ipcMain.handle('blender:launch', async (e, p) => blender.launch(store, p && p.file));
  ipcMain.handle('blender:stop', async () => blender.stop(store));
  // 视口面板数据面(v0.55.0:右侧面板「Blender 视口」标签):host 只读代理 / 点击选物 / 插入输入框
  ipcMain.handle('blender:host', (e, p) => blender.hostGet(store, p && p.path));
  ipcMain.handle('blender:insert', (e, p) => ({ ok: blender.insertText(p && p.text) }));
  ipcMain.handle('blender:pick', (e, p) => blender.pickAt(store, p && p.x, p && p.y));
  try {
    blender.applyConfig(store); // 已启用则 boot 即拉起后端 + 看护 + 选中桥(未启用为无操作)
  } catch (err) { debuglog.warn(store, 'blender', 'boot-apply-fail', { message: String(err && err.message || err).slice(0, 200) }); }

  // ---- DSH 插件兼容 ----
  ipcMain.handle('dsh:list', () => dsh.listInstalled(store.pluginsDir()));

  // MCP 设置页「测试连接」:连接并列出工具(失败抛错,渲染端展示 err.message)
  ipcMain.handle('mcp:test', (e, cfg) => mcp.testServer(cfg));

  ipcMain.handle('dsh:import', async (e, source) => {
    const pluginsDir = store.pluginsDir();
    const install = await dsh.installPackage(pluginsDir, source, proxy.npmEnv(store.config));
    if (!install.ok) return { ok: false, message: `安装失败:\n${install.output.slice(-800)}` };

    const installed = await dsh.listInstalled(pluginsDir);
    const imported = { mcp: 0, skills: 0, notes: [], targets: [] };
    for (const p of installed) {
      imported.targets.push(`${p.name}@${p.version}`);
      const scan = await dsh.scanPackage(p.dir);
      for (const cfg of scan.mcpServers) {
        if (!store.config.mcpServers.some((x) => x.name === cfg.name && (x.url || '') === (cfg.url || '') && (x.command || '') === (cfg.command || ''))) {
          store.config.mcpServers.push(cfg);
          imported.mcp++;
        }
      }
      for (const sk of scan.skills) {
        if (!store.config.skills.some((x) => x.name === sk.displayName || x.id === 'dsh-' + sk.name)) {
          store.config.skills.push({
            id: 'dsh-' + sk.name,
            name: (sk.displayName || sk.name).slice(0, 20),
            icon: '🧩',
            prompt: sk.content,
            insert: '',
            agent: false,
          });
          imported.skills++;
        }
      }
      imported.notes.push(...scan.notes.slice(0, 2));
    }
    store.updateConfig({ mcpServers: store.config.mcpServers, skills: store.config.skills });
    return { ok: true, ...imported };
  });

  ipcMain.handle('dsh:remove', async (e, name) => {
    const res = await dsh.removePackage(store.pluginsDir(), name, proxy.npmEnv(store.config));
    return { ok: res.ok, message: res.ok ? '已卸载' : res.output.slice(-500) };
  });

  // DSH 代码插件宿主(实验性)
  ipcMain.handle('dsh:setPluginEnabled', (e, { name, enabled }) => dshHost.setPluginEnabled(store, name, enabled));
  ipcMain.handle('dsh:hostStatus', () => dshHost.status(store));
  ipcMain.handle('dsh:importSkillsDir', async (e, dir) => {
    const scan = await dsh.scanPackage(dir);
    let count = 0;
    for (const sk of scan.skills) {
      if (!store.config.skills.some((x) => x.id === 'dsh-' + sk.name || x.name === sk.displayName)) {
        store.config.skills.push({
          id: 'dsh-' + sk.name,
          name: (sk.displayName || sk.name).slice(0, 20),
          icon: '🧩',
          prompt: sk.content,
          insert: '',
          agent: false,
        });
        count++;
      }
    }
    store.updateConfig({ skills: store.config.skills });
    return { ok: true, skills: count, notes: scan.notes };
  });

  // 启动时扫描加载原生插件与内置专精;DSH 运行时层(实验性)按需拉起已启用的代码插件
  console.error('[IPC] scanAndLoad begin');
  pluginHost.scanAndLoad(store).catch(() => {});
  specialty.ensureBuiltins(store);
  console.error('[IPC] specialty done');
  try { dshHost.ensure(store); } catch (e) { debuglog.error(store, 'dsh-host', 'ensure-fail', { message: String(e && e.message || e).slice(0, 300) }); }
  console.error('[IPC] register complete');

  // 远程控制(v0.54.0):配置已开启时开机自启;此后 config:set { remote } 实时启停(见 config:set 处理器)
  try { require('./remote').applyConfig(store.config, { store, streams, chatSendCore }); } catch (e) { debuglog.warn(store, 'remote', 'boot-fail', { message: String(e && e.message || e).slice(0, 200) }); }

  // 远程隧道(v0.54.0):状态读取 + 动作(下载二进制 / 立即重启隧道)
  const tunnels = require('./tunnels');
  ipcMain.handle('remote:tunnel-status', () => tunnels.status());
  ipcMain.handle('remote:tunnel-action', async (e, payload) => {
    const action = payload && payload.action;
    try {
      if (action === 'download') {
        const exe = await tunnels.download(payload.mode === 'easytier' ? 'easytier' : 'frp', store);
        return { ok: true, path: exe };
      }
      if (action === 'restart') {
        require('./remote').applyConfig(store.config, { store, streams, chatSendCore });
        return { ok: true };
      }
      return { ok: false, error: 'unknown-action' };
    } catch (err) {
      return { ok: false, error: String(err.message || err).slice(0, 300) };
    }
  });
}

module.exports = { register };
