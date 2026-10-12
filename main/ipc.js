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
const security = require('./security');
const debuglog = require('./debuglog');
const modelCaps = require('./modelCaps');
const pluginHost = require('./pluginHost');
const specialty = require('./specialty');
const attachments = require('./attachments');
const http = require('./http');
const proxy = require('./proxy');
const terminal = require('./terminal');
const datapath = require('./datapath');
const appower = require('./appower');
const traymgr = require('./traymgr');

const streams = new Map(); // streamId → { ac, decisions, asks, convId }

function register(store) {
  ipcMain.handle('config:get', () => store.config);

  ipcMain.handle('config:set', (e, patch) => {
    const cfg = store.updateConfig(patch || {});
    debuglog.info(store, 'config', 'config:set', { keys: Object.keys(patch || {}) });
    // 代理设置变化 → 立即应用到 session(下一次请求生效)
    if (patch && patch.proxy) proxy.applyProxy(store).catch((err) => {
      debuglog.warn(store, 'proxy', 'apply-failed', { message: String(err.message || err).slice(0, 200) });
    });
    // 毛玻璃变化 → 实时应用窗口材质('none' = 显式关闭;'auto' 会让 DWM 常驻合成,空闲 GPU 大增)
    if (patch && patch.ui && (patch.ui.glass !== undefined || patch.ui.powerSave !== undefined || patch.ui.pureTerminal !== undefined)) {
      const ui = store.config.ui || {};
      const material = (ui.glass && !ui.powerSave && !ui.pureTerminal) ? 'acrylic' : 'none';
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (w.setBackgroundMaterial) w.setBackgroundMaterial(material); } catch (_) { /* 平台不支持 */ }
      }
    }
    // DSH 运行时层总开关(实验性,默认关)
    if (patch && patch.dev && patch.dev.dshHost !== undefined) {
      try { dshHost.applyConfigChange(store); } catch (_) { /* ignore */ }
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
    if (!/^(https?:\/\/|data:)/i.test(String(url))) throw new Error('仅支持 http/https 地址');
    const v = panelViewAttach(String(tabId));
    return v.webContents.loadURL(String(url)).then(() => ({ ok: true })).catch((err) => ({ ok: false, error: String(err.message || err) }));
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
    return { ...caps, contextLimit: modelCaps.contextLimit(model, db) }; // 用量条「上下文已用 x%」分母
  });
  ipcMain.handle('reason:capsBatch', (e, { models, providerId }) => {
    const p = store.config.providers.find((x) => x.id === providerId);
    const out = {};
    for (const m of models || []) out[m] = modelCaps.forModel(m, p && p.modelCaps, modelCaps.getModelDb(store));
    return out;
  });

  // ---- 模型能力数据库(models.dev) ----
  ipcMain.handle('modeldb:stats', () => {
    const db = modelCaps.getModelDb(store);
    return { count: (db && db.count) || 0, updatedAt: (db && db.updatedAt) || null, source: (db && db.source) || null };
  });
  ipcMain.handle('modeldb:update', async (e) => {
    const res = await http.fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
    const raw = await res.json();
    const db = modelCaps.transformModelDb(raw);
    fs.writeFileSync(store.baseDir() + '/model-db.json', JSON.stringify(db), 'utf8');
    store.updateConfig({ modelDbUpdatedAt: db.updatedAt });
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
    store.updateConfig({ providers: store.config.providers.filter((p) => p.id !== id) });
    return store.config;
  });

  ipcMain.handle('providers:addPreset', (e, presetId) => {
    const preset = providers.PRESETS.find((p) => p.id === presetId);
    if (preset && !store.config.providers.some((p) => p.id === preset.id)) {
      store.config.providers.push({ ...preset, models: [...(preset.models || [])], apiKey: '' });
      store.updateConfig({ providers: store.config.providers });
    }
    return store.config;
  });

  ipcMain.handle('providers:fetchModels', async (e, id) => {
    const p = store.config.providers.find((x) => x.id === id);
    if (!p) throw new Error('服务商不存在');
    if (!p.baseUrl) throw new Error('请先填写 BaseURL');
    // Gemini OAuth 账号:模型清单走 Cloud Code 专用端点
    if (p.oauth === 'gemini') {
      const models = await oauth.fetchModelsForOauth(store, 'gemini', id);
      return { models, config: store.config, capsMerged: 0 };
    }
    const adapter = providers.getAdapter(p.type);
    const guard = (u) => security.assertUrlAllowed(u, store.config.security || {});
    const primaryKey = (p.apiKeys && p.apiKeys[0]) || p.apiKey || '';
    const list = await adapter.listModels(p.baseUrl, primaryKey, guard);
    p.models = [...new Set([...(p.models || []), ...list])];
    // 上游推理能力探测(OpenRouter 风格 supported_parameters),失败静默
    let capsMerged = 0;
    try {
      if (adapter.fetchCaps) {
        const caps = await adapter.fetchCaps(p.baseUrl, primaryKey, guard);
        if (caps && Object.keys(caps).length) {
          p.modelCaps = { ...(p.modelCaps || {}), ...caps };
          capsMerged = Object.keys(caps).length;
        }
      }
    } catch (_) { /* 能力探测失败不影响模型列表 */ }
    store.updateConfig({ providers: store.config.providers });
    return { models: list, config: store.config, capsMerged };
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

  ipcMain.handle('convs:delete', (e, id) => {
    store.deleteConv(id);
    return store.listConvs();
  });

  ipcMain.handle('convs:rename', (e, { id, title }) => {
    store.renameConv(id, title);
    return store.listConvs();
  });

  ipcMain.handle('conv:switchBranch', (e, { convId, index, dir }) => {
    const conv = store.getConv(convId);
    if (!conv) return null;
    store.switchBranch(conv, index, dir);
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
  ipcMain.handle('chat:send', (e, payload) => {
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
    const send = (obj) => {
      if (!e.sender.isDestroyed()) e.sender.send('chat:event', { streamId, convId, ...obj });
    };
    runChat({ store, send, streams, streamId, convId, providerId, model, userText, retry, branch, agentMode, mode, assistantId, skillId, groupId, reasonLevel, attachments: norm.attachments, attachWarnings: norm.errors, signal: ac.signal })
      .catch((err) => send({ type: 'error', message: (err && err.message) || String(err) }))
      .finally(() => streams.delete(streamId));
    return { ok: true };
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
}

module.exports = { register };
