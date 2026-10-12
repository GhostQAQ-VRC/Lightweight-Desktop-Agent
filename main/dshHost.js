// DSH 运行时层 · 主进程侧宿主管理(v0.42.0 实验性,默认关闭)
// 详见 HANDOFF 0.42.0:子进程隔离 + stdio JSON 行桥 + 空闲 5 分钟自停 + 审计。
// 摘除 = 删本文件 + resources/dsh-runtime + 相关开关,不碰其他功能。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('./http');
const security = require('./security');
const debuglog = require('./debuglog');

const IDLE_MS = 5 * 60 * 1000;   // 空闲自动退出
const CALL_TIMEOUT = 120000;     // 工具调用超时

let child = null;
let ready = false;
let caps = [];                   // [{plugin, kind, tools?, error?, note?}]
let seq = 0;
const pending = new Map();       // callId → {resolve, reject, timer}
const httpPending = new Map();   // httpId → {resolve, reject}
let idleTimer = null;
let readyPromise = null;         // 起 → ready(或失败 reject);callTool 等它
let bootTo = null; let readyResolve = null; let readyReject = null;

function enabled(store) {
  return !!(store.config && store.config.dev && store.config.dev.dshHost);
}
function pluginMap(store) {
  const v = store.config && store.config.dshPlugins;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}
function enabledPackages(store) {
  const m = pluginMap(store);
  return Object.entries(m).filter(([k, v]) => v).map(([k]) => k);
}
function sanitize(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'plugin';
}
function runtimeDir() {
  // 打包:asarUnpack 后的真实目录;开发:仓库内目录
  const packed = process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'dsh-runtime') : '';
  if (packed && fs.existsSync(path.join(packed, 'host-entry.js'))) return packed;
  return path.join(__dirname, '..', '..', 'resources', 'dsh-runtime');
}
function pluginsDir(store) {
  return path.join(store.baseDir(), 'dsh-plugins');
}
function audit(store, detail) {
  try { security.auditAppend(store, { kind: 'dsh-host', ...detail }); } catch (_) { /* ignore */ }
}

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stop('idle'); }, IDLE_MS);
}

function stop(reason) {
  clearTimeout(idleTimer);
  if (child) {
    try { child.stdin.write(JSON.stringify({ t: 'stop' }) + '\n'); } catch (_) { /* ignore */ }
    try { child.kill(); } catch (_) { /* ignore */ }
    child = null;
  }
  ready = false;
  caps = [];
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('DSH 宿主已停止')); }
  pending.clear();
  for (const [, p] of httpPending) p.reject(new Error('DSH 宿主已停止'));
  httpPending.clear();
}

// 安装包目录 → {name → dir}(dsh-plugins/node_modules 下,与 dsh.js listInstalled 同源)
function findPackageDirs(store) {
  const root = path.join(pluginsDir(store), 'node_modules');
  const out = [];
  const scan = (dir, scope) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (scope) out.push({ name: scope + '/' + e.name, dir: full });
      else if (e.name.startsWith('@')) scan(full, e.name);
      else out.push({ name: e.name, dir: full });
    }
  };
  scan(root, null);
  return out;
}

function ensure(store) {
  if (child) return readyPromise || Promise.resolve();
  if (!enabled(store)) return Promise.resolve();
  const pkgs = findPackageDirs(store).filter((p) => pluginMap(store)[p.name] === true);
  if (!pkgs.length) return Promise.resolve();

  const initPath = path.join(os.tmpdir(), `dsh-host-init-${Date.now()}.json`);
  fs.writeFileSync(initPath, JSON.stringify({
    runtimeDir: runtimeDir(),
    plugins: pkgs,
    dataDir: path.join(pluginsDir(store), '.data'),
  }));

  readyPromise = new Promise((resolveReady2, rejectReady2) => {
    readyResolve = resolveReady2; readyReject = rejectReady2;
    bootTo = setTimeout(() => rejectReady2(new Error('DSH 宿主启动超时(20s)')), 20000);
    const entry = path.join(runtimeDir(), 'host-entry.js');
    const c = spawn(process.execPath, [entry, initPath], {
      cwd: pluginsDir(store),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = c;
    ready = false;
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch (_) { msg = null; }
        if (msg && msg.t) handleMsg(store, msg);
        else debuglog.info(store, 'dsh-host', 'stdout', { line: line.slice(0, 300) }); // 插件的 console 输出
      }
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (d) => { debuglog.warn(store, 'dsh-host', 'stderr', { line: String(d).slice(0, 300) }); });
    c.on('exit', (code) => {
      const wasCrash = ready || pending.size > 0;
      child = null; ready = false; caps = [];
      clearTimeout(idleTimer);
      clearTimeout(bootTo);
      try { rejectReady(new Error('DSH 宿主进程退出(code=' + code + ')')); } catch (_) { /* already settled */ }
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('DSH 宿主进程已退出')); }
      pending.clear();
      if (wasCrash) debuglog.warn(store, 'dsh-host', 'exit', { code });
    });
    // init 行:首条写入
    c.stdin.write(JSON.stringify({ t: 'init', plugins: pkgs, dataDir: path.join(pluginsDir(store), '.data') }) + '\n');
    debuglog.info(store, 'dsh-host', 'boot', { plugins: pkgs.map((p) => p.name) });
    audit(store, { action: 'boot', plugins: pkgs.map((p) => p.name) });
  });
  return readyPromise;
}

function handleMsg(store, msg) {
  if (msg.t === 'ready') {
    ready = true;
    caps = msg.caps || [];
    clearTimeout(bootTo);
    try { readyResolve(); } catch (_) { /* ignore */ }
    resetIdle();
    debuglog.info(store, 'dsh-host', 'ready', { caps: caps.map((c) => `${c.plugin}:${c.kind}`).join(',') });
  } else if (msg.t === 'result') {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || '插件工具执行失败'));
    }
  } else if (msg.t === 'http') {
    // 子进程出站请求桥:走统一出口(代理 + 安全审计生效);二进制响应 v1 以文本回落
    const opts = { ...msg.opts, headers: msg.opts.headers || {} };
    http.fetch(msg.url, opts).then(async (res) => {
      let body = '';
      try { body = await res.text(); } catch (_) { body = ''; }
      const headers = {};
      try { for (const [k, v] of res.headers.entries()) headers[k] = v; } catch (_) { /* ignore */ }
      return { id: msg.id, ok: res.ok, status: res.status, headers, body };
    }).then((r) => {
      try { child && child.stdin.write(JSON.stringify({ t: 'http-res', ...r }) + '\n'); } catch (_) { /* ignore */ }
    }).catch((e) => {
      try { child && child.stdin.write(JSON.stringify({ t: 'http-res', id: msg.id, ok: false, error: String(e && e.message || e).slice(0, 200) }) + '\n'); } catch (_) { /* ignore */ }
    });
  } else if (msg.t === 'log') {
    const sev = String(msg.level || 'info').startsWith('error') ? 'error' : String(msg.level || 'info').startsWith('warn') ? 'warn' : 'info';
    debuglog[sev](store, 'dsh-host', 'plugin', { line: String(msg.msg || '').slice(0, 300) });
  } else if (msg.t === 'exit') {
    debuglog.info(store, 'dsh-host', 'child-exit', { reason: msg.reason });
  }
}

function findTool(fullName) {
  // dsh_<pkg>__<tool>
  const m = /^dsh_([a-z0-9_]+?)__(.+)$/.exec(fullName);
  if (!m) return null;
  const pkgSlug = m[1];
  const toolSlug = m[2];
  const cap = caps.find((c) => sanitize(c.plugin) === pkgSlug);
  if (!cap || !Array.isArray(cap.tools)) return null;
  const tool = cap.tools.find((t) => sanitize(t.name) === toolSlug);
  return tool ? { cap, tool } : null;
}

// 同步收集(agent.js 每轮调一次):未就绪时先异步拉起,本轮返回空,下一轮生效
function collectTools(store) {
  if (!enabled(store)) return [];
  const pkgs = enabledPackages(store);
  if (!pkgs.length) return [];
  if (!child) ensure(store);
  if (!ready) return [];
  const out = [];
  for (const cap of caps) {
    if (pluginMap(store)[cap.plugin] !== true) continue;
    if (!Array.isArray(cap.tools)) continue;
    const prefix = 'dsh_' + sanitize(cap.plugin);
    for (const t of cap.tools) {
      out.push({
        def: {
          name: `${prefix}__${sanitize(t.name)}`,
          description: `[DSH 插件·${cap.plugin}] ${t.description}`.slice(0, 500),
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

async function callTool(store, fullName, args, signal) {
  if (!enabled(store)) throw new Error('插件兼容未开启(设置 → 开发者选项 → 插件兼容)');
  await ensure(store);
  if (!ready || !child) throw new Error('DSH 宿主未就绪(无已载入插件或启动失败)');
  const found = findTool(fullName);
  if (!found) throw new Error(`未找到 DSH 插件工具: ${fullName}`);
  const id = 'c' + (++seq);
  resetIdle();
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try { child && child.stdin.write(JSON.stringify({ t: 'abort', id }) + '\n'); } catch (_) { /* ignore */ }
      reject(new Error(`DSH 插件工具超时(120s): ${fullName}`));
    }, CALL_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
  });
  const onAbort = () => {
    const p2 = pending.get(id);
    if (p2) { clearTimeout(p2.timer); pending.delete(id); p2.reject(new DOMException('Aborted', 'AbortError')); }
    try { child && child.stdin.write(JSON.stringify({ t: 'abort', id }) + '\n'); } catch (_) { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    child.stdin.write(JSON.stringify({ t: 'call', id, plugin: found.cap.plugin, tool: found.tool.name, args: args || {} }) + '\n');
  } catch (e) {
    pending.delete(id);
    throw new Error('DSH 宿主通信失败: ' + e.message);
  }
  const out = await p;
  audit(store, { action: 'call', tool: fullName });
  return typeof out === 'string' ? out.slice(0, 20000) : JSON.stringify(out).slice(0, 20000);
}

// 渲染端状态查询(扩展页)
function status(store) {
  return {
    enabled: enabled(store),
    running: !!child,
    ready,
    caps: caps.map((c) => ({ plugin: c.plugin, kind: c.kind, tools: (c.tools || []).map((t) => t.name), error: c.error, note: c.note })),
    plugins: findPackageDirs(store).map((p) => ({ name: p.name, enabled: pluginMap(store)[p.name] === true })),
  };
}

// 开关变更:重启宿主(配置与启用集合简单同步)
function applyConfigChange(store) {
  if (!enabled(store) || !enabledPackages(store).length) { stop('config'); return; }
  stop('config');
  ensure(store);
}

function setPluginEnabled(store, name, on) {
  const m = pluginMap(store);
  const next = { ...m, [String(name).slice(0, 100)]: !!on };
  store.updateConfig({ dshPlugins: next });
  audit(store, { action: on ? 'enable' : 'disable', plugin: name });
  applyConfigChange(store);
  return next;
}

process.on('exit', () => { try { stop('quit'); } catch (_) { /* ignore */ } });

module.exports = { ensure, collectTools, callTool, status, setPluginEnabled, applyConfigChange, stop, enabled };
