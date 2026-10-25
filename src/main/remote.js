// 远程控制(v0.54.0):局域网 HTTP 服务,手机/平板浏览器 = 轻量 Agent 控制台。
// 安全模型:① 默认关闭,设置显式开启;② 全站 token 门禁(开启时生成,URL 携带);③ 发送节流;
// ④ 远程审批单独授权(config.remote.allowApproval,默认关);⑤ AI 输出在远程页一律 textContent 渲染。
// 复用:chatSendCore / streams 来自 ipc.js(与主界面同一会话流状态表),事件经 SSE 实时推送,
// 同时镜像到主界面(webContents.send)—— 主界面侧栏/审批卡对远程发起的对话完全可见。
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { BrowserWindow } = require('electron');

let server = null;          // http.Server | null(非空 = 运行中)
const sseClients = new Set(); // 活跃 SSE 连接(response 对象)
const rateWindow = new Map(); // token → 时间戳数组(发送节流)
const MODES = [['chat', '对话'], ['restricted', '受限'], ['full', '完全'], ['create', '创造'], ['team', '团队']];
let tunnelTimer = null;     // 隧道模式下轮询 accessHost 变化(虚拟 IP / frp 状态)

// 访问源派生:隧道优先(frps 公网地址 / EasyTier 虚拟 IP),否则局域网 IP
function accessHostOf(cfg) {
  const remote = cfg.remote || {};
  const tunnel = remote.tunnel || {};
  const st = require('./tunnels').status();
  if (tunnel.mode === 'frp' && st.frp.running) {
    const f = tunnel.frp || {};
    return f.serverAddr ? `${f.serverAddr}:${parseInt(f.remotePort, 10) || 18629}` : '';
  }
  if (tunnel.mode === 'easytier' && st.easytier.running && st.easytier.virtualIP) {
    return `${st.easytier.virtualIP}:${remote.port || 8629}`;
  }
  return `${remote.lanIP || lanIP()}:${remote.port || 8629}`;
}

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function running() { return !!server; }

// 配置应用:启停/端口变更;开启且无 token 时生成(写回 store.config 并原子落盘);lanIP 每次刷新(渲染端拼 URL 用)
function applyConfig(cfg, deps) {
  const conf = cfg.remote || {};
  const want = !!conf.enabled;
  const port = Math.min(65535, Math.max(1024, parseInt(conf.port, 10) || 8629));
  const ip = lanIP();
  if (conf.lanIP !== ip) { conf.lanIP = ip; if (deps && deps.store) deps.store.saveNow(); }
  if (want && !conf.token) {
    conf.token = crypto.randomBytes(24).toString('hex');
    if (deps && deps.store) deps.store.saveNow();
  }
  // 出网隧道(v0.54.0):frp / easytier 期望状态应用 + accessHost 轮询刷新
  const tunnels = require('./tunnels');
  tunnels.apply(cfg, deps).catch((e) => {
    if (deps && deps.store) require('./debuglog').warn(deps.store, 'remote', 'tunnel-apply-fail', { message: String(e.message || e).slice(0, 200) });
  });
  const tmode = (conf.tunnel || {}).mode || 'off';
  if (want && tmode !== 'off' && !tunnelTimer) {
    tunnelTimer = setInterval(() => {
      try {
        const host = accessHostOf(cfg);
        if (host && conf.accessHost !== host) { conf.accessHost = host; if (deps && deps.store) deps.store.saveNow(); }
      } catch (_) {}
    }, 3000);
  }
  if ((tmode === 'off' || !want) && tunnelTimer) { clearInterval(tunnelTimer); tunnelTimer = null; }
  conf.accessHost = accessHostOf(cfg);
  if (want && conf.token && (!server || server.__port !== port)) {
    if (server) stop();
    start(conf, port, deps);
  } else if (!want && server) {
    stop();
  }
  return { running: running(), port: server ? server.__port : port, token: conf.token || '', lanIP: conf.lanIP || lanIP() };
}

function start(conf, port, deps) {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024 * 512) req.destroy(); });
    req.on('end', () => route(req, res, body, conf, deps || {}));
  });
  server.__port = port;
  server.on('error', (e) => {
    server = null;
    if (deps && deps.store) {
      const debuglog = require('./debuglog');
      debuglog.warn(deps.store, 'remote', 'listen-fail', { port, message: String(e.message || e).slice(0, 200) });
    }
  });
  server.listen(port, '0.0.0.0');
  if (deps && deps.store) {
    const debuglog = require('./debuglog');
    const security = require('./security');
    debuglog.info(deps.store, 'remote', 'listening', { port });
    security.auditAppend(deps.store, { kind: 'remote', detail: `远程控制已开启: 0.0.0.0:${port}(token 门禁${conf.allowApproval ? ',允许远程审批' : ',远程仅查看'})` });
  }
}

function stop() {
  if (!server) return;
  const s = server;
  server = null;
  for (const res of sseClients) { try { res.end(); } catch (_) {} }
  sseClients.clear();
  try { s.close(); } catch (_) {}
}

function tokenOk(req, url, conf) {
  const t = new URL(url, 'http://x').searchParams.get('t') || req.headers['x-token'] || '';
  return !!conf.token && String(t) === String(conf.token);
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

function broadcast(ev) {
  if (!sseClients.size) return;
  const data = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of [...sseClients]) {
    try { res.write(data); } catch (_) { sseClients.delete(res); }
  }
}

// 镜像到主界面:远程发起的对话在主界面侧栏/审批卡完全可见(渲染端多流架构按 streamId 处理)
function pushToRenderer(ev) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('chat:event', ev); } catch (_) {}
  }
}

const IMG_INLINE_LIMIT = 256 * 1024; // 小图内联(远程页可直接看),大图占位

function stripHeavy(m) {
  // 远程页轻量化:大图占位、小图内联;文本/思考/工具块截断(完整内容仍在主界面)
  const out = { role: m.role };
  if (typeof m.content === 'string') { out.content = m.content.slice(0, 4000); return out; }
  out.blocks = (m.blocks || []).map((b) => {
    if (b.type === 'image') {
      return b.base64 && b.base64.length <= IMG_INLINE_LIMIT
        ? { type: 'image', dataUrl: `data:${b.mime || 'image/png'};base64,${b.base64}` }
        : { type: 'image', label: '[图片较大,请在主界面查看]' };
    }
    if (b.type === 'tool') return { type: 'tool', name: b.name, status: b.status };
    if (b.type === 'text') return { type: 'text', content: String(b.content || '').slice(0, 4000) };
    if (b.type === 'reasoning') return { type: 'reasoning', content: String(b.content || '').slice(0, 1500) };
    if (b.type === 'ask') return { type: 'ask', question: b.question, options: b.options, answerDisplay: b.answerDisplay };
    return { type: b.type };
  });
  return out;
}

function statePayload(deps, conf, convId) {
  const store = deps.store;
  const cfg = store.config;
  const convs = store.listConvs().slice(0, 50).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.count, streaming: [...deps.streams.values()].some((s) => s.convId === c.id) }));
  const cid = convId || (convs[0] && convs[0].id) || null;
  const conv = cid ? store.getConv(cid) : null;
  const messages = conv ? (conv.messages || []).slice(-80).map(stripHeavy) : [];
  const streams = [...deps.streams.entries()].map(([sid, s]) => ({
    streamId: sid,
    convId: s.convId,
    decisions: [...(s.decisions ? s.decisions.keys() : [])],
    asks: [...(s.asks ? s.asks.keys() : [])],
  }));
  const models = (cfg.providers || []).flatMap((p) => (p.models || []).map((m) => ({ providerId: p.id, providerName: p.name, model: m })));
  // 当前模型的思考档位(主界面同源 modelCaps;无能力数据时页面回退通用档)
  let levels = [];
  try {
    const modelCaps = require('./modelCaps');
    const prov = (cfg.providers || []).find((p) => p.id === ((cfg.lastModel || {}).providerId));
    if (prov) {
      const caps = modelCaps.forModel((cfg.lastModel || {}).model, prov.modelCaps, modelCaps.getModelDb(store));
      if (caps && caps.levels) levels = caps.levels;
    }
  } catch (_) { /* 能力库缺失时忽略 */ }
  return {
    ok: true,
    convs,
    convId: cid,
    messages,
    streams,
    allowApproval: !!conf.allowApproval,
    model: (cfg.lastModel && cfg.lastModel.model) || '',
    providerId: (cfg.lastModel && cfg.lastModel.providerId) || '',
    mode: (cfg.ui && cfg.ui.mode) || 'chat',
    modes: MODES,
    models,
    levels,
  };
}

// 发送节流:同一 token 2 秒内最多 3 条(防脚本滥用;真人不受影响)
function rateLimited(token) {
  const now = Date.now();
  const arr = (rateWindow.get(token) || []).filter((ts) => now - ts < 2000);
  if (arr.length >= 3) { rateWindow.set(token, arr); return true; }
  arr.push(now);
  rateWindow.set(token, arr);
  return false;
}

function route(req, res, body, conf, deps) {
  const url = req.url || '/';
  const pathOnly = url.split('?')[0];
  // 全站 token 门禁(含页面):无有效 token 一律 401
  if (!tokenOk(req, url, conf)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const token = new URL(url, 'http://x').searchParams.get('t') || req.headers['x-token'] || ''; // 门禁已过;取值仅作节流 key

  if (req.method === 'GET' && pathOnly === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && pathOnly === '/api/state') {
    const cid = new URL(url, 'http://x').searchParams.get('convId') || null;
    json(res, 200, statePayload(deps, conf, cid));
    return;
  }
  if (req.method === 'GET' && pathOnly === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(':connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/send') {
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    const text = String(bodyObj.text || '').trim();
    if (!text && !(Array.isArray(bodyObj.attachments) && bodyObj.attachments.length)) { json(res, 400, { ok: false, error: 'empty' }); return; }
    if (rateLimited(token)) { json(res, 429, { ok: false, error: 'rate-limited' }); return; }
    const cfg = deps.store.config;
    const convId = String(bodyObj.convId || '') || 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const existing = deps.store.getConv(convId);
    // 模型/模式:请求可指定(远程页顶部选择器),缺省跟随全局配置;白名单校验防任意值
    const MODE_SET = new Set(MODES.map(([k]) => k));
    const mode = MODE_SET.has(bodyObj.mode) ? bodyObj.mode : ((cfg.ui && cfg.ui.mode) || 'chat');
    const known = (cfg.providers || []).some((p) => p.id === bodyObj.providerId && (p.models || []).includes(bodyObj.model));
    const lm = cfg.lastModel || {};
    const providerId = known ? bodyObj.providerId : lm.providerId || null;
    const model = known ? bodyObj.model : lm.model || null;
    const payload = {
      streamId: 'rm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      convId,
      providerId,
      model,
      userText: text,
      agentMode: mode !== 'chat',
      mode,
      assistantId: (cfg.ui && cfg.ui.activeAssistantId) || null,
      skillId: null,
      groupId: (existing && existing.groupId) || 'default',
      reasonLevel: (typeof bodyObj.reasonLevel === 'string' && bodyObj.reasonLevel) || null,
      attachments: Array.isArray(bodyObj.attachments) ? bodyObj.attachments.slice(0, 8) : undefined, // normalizeIncoming 权威校验
    };
    const deliver = (obj) => {
      const envelope = { streamId: payload.streamId, convId, ...obj };
      broadcast(envelope);
      pushToRenderer(envelope);
    };
    deps.chatSendCore(payload, deliver);
    pushToRenderer({ type: 'convs-changed', streamId: payload.streamId, convId });
    json(res, 200, { ok: true, streamId: payload.streamId, convId });
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/abort') {
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    for (const [, s] of deps.streams) {
      if (!bodyObj.convId || s.convId === bodyObj.convId) { try { s.ac.abort(new Error('远程停止')); } catch (_) {} }
    }
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/decision') {
    if (!conf.allowApproval) { json(res, 403, { ok: false, error: 'remote-approval-disabled' }); return; }
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    const s = deps.streams.get(String(bodyObj.streamId || ''));
    const toolCallId = String(bodyObj.toolCallId || '');
    if (s && s.decisions && s.decisions.has(toolCallId)) {
      const resolve = s.decisions.get(toolCallId);
      s.decisions.delete(toolCallId);
      resolve(!!bodyObj.approved);
      json(res, 200, { ok: true });
    } else json(res, 404, { ok: false, error: 'no-pending' });
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/ask') {
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    const s = deps.streams.get(String(bodyObj.streamId || ''));
    const toolCallId = String(bodyObj.toolCallId || '');
    if (s && s.asks && s.asks.has(toolCallId)) {
      const done = s.asks.get(toolCallId);
      s.asks.delete(toolCallId);
      done(String(bodyObj.answer || ''));
      json(res, 200, { ok: true });
    } else json(res, 404, { ok: false, error: 'no-pending' });
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/prefs') {
    // 远程页的全局偏好:模式 / 模型(白名单校验;与主界面即时同步)
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    const cfg = deps.store.config;
    const patch = {};
    if (MODES.some(([k]) => k === bodyObj.mode)) patch.ui = { ...(patch.ui || {}), mode: bodyObj.mode };
    if (bodyObj.providerId && bodyObj.model && (cfg.providers || []).some((p) => p.id === bodyObj.providerId && (p.models || []).includes(bodyObj.model))) {
      patch.lastModel = { providerId: bodyObj.providerId, model: bodyObj.model };
    }
    if (Object.keys(patch).length) {
      deps.store.updateConfig(patch);
      pushToRenderer({ type: 'config-changed', streamId: 'remote', convId: null });
    }
    json(res, 200, { ok: true, mode: (cfg.ui && cfg.ui.mode) || 'chat', providerId: (cfg.lastModel && cfg.lastModel.providerId) || '', model: (cfg.lastModel && cfg.lastModel.model) || '' });
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/conv-rename') {
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    const convId = String(bodyObj.convId || '');
    if (!convId || !deps.store.getConv(convId)) { json(res, 404, { ok: false, error: 'no-conv' }); return; }
    deps.store.renameConv(convId, String(bodyObj.title || '').trim());
    pushToRenderer({ type: 'convs-changed', streamId: 'remote', convId });
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/conv-delete') {
    let bodyObj = {};
    try { bodyObj = JSON.parse(body || '{}'); } catch (_) {}
    const convId = String(bodyObj.convId || '');
    if (!convId || !deps.store.getConv(convId)) { json(res, 404, { ok: false, error: 'no-conv' }); return; }
    if ([...deps.streams.values()].some((s) => s.convId === convId)) { json(res, 409, { ok: false, error: 'streaming' }); return; }
    deps.store.deleteConv(convId);
    pushToRenderer({ type: 'convs-changed', streamId: 'remote', convId });
    json(res, 200, { ok: true });
    return;
  }
  json(res, 404, { ok: false, error: 'not-found' });
}

// ===== 远程页面(单文件,内嵌样式与脚本;AI 输出一律 textContent 渲染) =====
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LiteAgent 远程控制</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #101014; color: #e8e8ec; height: 100vh; display: flex; flex-direction: column; }
  header { background: #17171d; border-bottom: 1px solid #2a2a33; padding: 6px 10px; display: flex; flex-direction: column; gap: 6px; }
  .hrow { display: flex; align-items: center; gap: 6px; }
  select, header button.hb { background: #22222b; color: #e8e8ec; border: 1px solid #2a2a33; border-radius: 8px; padding: 7px 8px; font-size: 13px; max-width: 100%; }
  #convs { flex: 1; min-width: 0; }
  header button.hb:disabled { opacity: .4; }
  #msgs { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .m { max-width: 88%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .m.user { align-self: flex-end; background: #2b4bcd; }
  .m.ai { align-self: flex-start; background: #1d1d25; }
  .m.reason { align-self: flex-start; background: transparent; color: #8a8a96; font-size: 12px; }
  .m.tool { align-self: flex-start; background: transparent; color: #9a9aa8; font-size: 12px; font-family: ui-monospace, monospace; }
  .m.err { align-self: center; background: #3a1d22; color: #ff8a8f; font-size: 13px; }
  .m img { max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; }
  .card { align-self: stretch; background: #241f2e; border: 1px solid #4a3f5e; border-radius: 12px; padding: 10px 12px; font-size: 13px; }
  .card .q { font-weight: 600; margin-bottom: 8px; }
  .card .detail { font-family: ui-monospace, monospace; font-size: 11.5px; color: #9a9aa8; background: #191920; border-radius: 8px; padding: 6px 8px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; }
  .card .opts { display: flex; flex-direction: column; gap: 6px; }
  .card button { text-align: left; background: #2f2a3d; color: #e8e8ec; border: 1px solid #4a3f5e; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
  .card button:hover { background: #3a3450; }
  .card button:disabled { opacity: .45; }
  .card .done { color: #8a8a96; }
  .card input { width: 100%; background: #191920; color: #e8e8ec; border: 1px solid #4a3f5e; border-radius: 8px; padding: 7px 9px; font-size: 13px; margin-bottom: 6px; }
  #bar { background: #17171d; border-top: 1px solid #2a2a33; padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); }
  #atts { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  #atts:empty { display: none; }
  .att { background: #22222b; border: 1px solid #2a2a33; border-radius: 8px; padding: 4px 8px; font-size: 11.5px; color: #9a9aa8; display: inline-flex; gap: 6px; align-items: center; }
  .att button { background: none; border: none; color: #ff8a8f; font-size: 13px; cursor: pointer; }
  .inrow { display: flex; gap: 8px; align-items: flex-end; }
  #inp { flex: 1; background: #22222b; color: #e8e8ec; border: 1px solid #2a2a33; border-radius: 12px; padding: 11px 14px; font-size: 15px; outline: none; }
  #send { background: #2b4bcd; color: #fff; border: none; border-radius: 12px; padding: 11px 16px; font-size: 14px; font-weight: 600; }
  #send:disabled { opacity: .4; }
  #pick { background: #22222b; color: #9a9aa8; border: 1px solid #2a2a33; border-radius: 12px; padding: 10px 12px; font-size: 15px; }
  .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #6f8bff; margin-right: 6px; animation: p 1.1s infinite; }
  @keyframes p { 0%,100% { opacity: .3; } 50% { opacity: 1; } }
  #lock { position: fixed; inset: 0; background: #101014; display: flex; align-items: center; justify-content: center; color: #8a8a96; font-size: 14px; z-index: 10; }
</style></head>
<body>
<div id="lock">连接中…</div>
<header>
  <div class="hrow">
    <button class="hb" id="new" title="新建会话">＋</button>
    <select id="convs"></select>
    <button class="hb" id="more" title="会话操作">⋯</button>
  </div>
  <div class="hrow">
    <select id="mode"></select>
    <select id="reason"></select>
    <select id="model"></select>
    <button class="hb" id="stop" style="margin-left:auto" title="停止当前回复" disabled>■ 停止</button>
  </div>
</header>
<div id="msgs"></div>
<div id="bar">
  <div id="atts"></div>
  <div class="inrow">
    <button id="pick" title="添加图片">＋图</button>
    <input id="inp" type="text" placeholder="给 Agent 发消息…(Enter 发送)" autocomplete="off">
    <button id="send">发送</button>
  </div>
</div>
<input id="file" type="file" accept="image/*" multiple style="display:none">
<script>
(function () {
  var qs = new URLSearchParams(location.search);
  var T = qs.get('t') || localStorage.getItem('ra-token') || '';
  if (T) localStorage.setItem('ra-token', T);
  var curConv = null;
  var pendingAtt = []; // 待发图片 [{name, mime, dataUrl}]
  var msgsEl = document.getElementById('msgs');
  var convsEl = document.getElementById('convs');
  var modeEl = document.getElementById('mode');
  var reasonEl = document.getElementById('reason');
  var modelEl = document.getElementById('model');
  var inp = document.getElementById('inp');
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var allowApproval = false;
  var MODE_NAMES = { chat: '对话', restricted: '受限', full: '完全', create: '创造', team: '团队' };
  var REASON_NAMES = { off: '关闭思考', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
  var reasonSel = localStorage.getItem('ra-reason') || '';
  var live = {}; // key → { el, txt } 当前流式块

  function api(path, opts) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(path + sep + 't=' + encodeURIComponent(T), opts || {});
  }
  function el(tag, cls, text) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d;
  }

  /* ---- state 渲染 ---- */
  function renderState(st) {
    allowApproval = !!st.allowApproval;
    convsEl.innerHTML = '';
    (st.convs || []).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = (c.streaming ? '● ' : '') + (c.title || '未命名');
      if (c.id === st.convId) o.selected = true;
      convsEl.appendChild(o);
    });
    // 模式选择器
    modeEl.innerHTML = '';
    (st.modes || []).forEach(function (m) {
      var o = document.createElement('option');
      o.value = m[0]; o.textContent = MODE_NAMES[m[0]] || m[1];
      if (m[0] === st.mode) o.selected = true;
      modeEl.appendChild(o);
    });
    // 模型选择器(按 供应商 · 模型 分组显示)
    modelEl.innerHTML = '';
    (st.models || []).forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.providerId + '|' + m.model;
      o.textContent = (m.providerName || m.providerId) + ' · ' + m.model;
      if (m.providerId === st.providerId && m.model === st.model) o.selected = true;
      modelEl.appendChild(o);
    });
    // 思考强度选择器(模型支持档位优先;无能力数据给通用档)
    reasonEl.innerHTML = '';
    var lv = (st.levels && st.levels.length) ? st.levels : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    var follow = document.createElement('option');
    follow.value = ''; follow.textContent = '思考:跟随默认';
    reasonEl.appendChild(follow);
    lv.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l; o.textContent = '思考:' + (REASON_NAMES[l] || l);
      if (l === reasonSel) o.selected = true;
      reasonEl.appendChild(o);
    });
    var anyStream = (st.streams || []).length > 0;
    stopBtn.disabled = !anyStream;
    (st.streams || []).forEach(function (s) {
      (s.decisions || []).forEach(function (tc) { ensureDecision(s.streamId, tc); });
      (s.asks || []).forEach(function (tc) { ensureAsk(s.streamId, tc); });
    });
  }

  /* ---- 审批卡:工具名 + 参数详情 + 批准/拒绝(允许时) ---- */
  var decisionEls = {}, askEls = {};
  function ensureDecision(streamId, toolCallId, detail) {
    if (decisionEls[toolCallId] && decisionEls[toolCallId].isConnected) return;
    var card = document.createElement('div'); card.className = 'card';
    var q = document.createElement('div'); q.className = 'q';
    q.textContent = '⚙ ' + (detail && detail.name ? detail.name : '工具') + ' 请求执行' + (allowApproval ? '' : '(远程审批未开启,请在主界面批准)');
    card.appendChild(q);
    if (detail && detail.args) {
      var d = document.createElement('div'); d.className = 'detail';
      d.textContent = String(detail.args).slice(0, 500);
      card.appendChild(d);
    }
    var row = document.createElement('div'); row.className = 'opts';
    if (allowApproval) {
      var ok = document.createElement('button'); ok.textContent = '✓ 批准执行';
      ok.onclick = function () { decide(streamId, toolCallId, true, card); };
      var no = document.createElement('button'); no.textContent = '✕ 拒绝';
      no.onclick = function () { decide(streamId, toolCallId, false, card); };
      row.appendChild(ok); row.appendChild(no);
    } else {
      var tip = document.createElement('div'); tip.className = 'done'; tip.textContent = '请在电脑主界面上批准该请求。';
      row.appendChild(tip);
    }
    card.appendChild(row);
    msgsEl.appendChild(card);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    decisionEls[toolCallId] = card;
  }
  function decide(streamId, toolCallId, approved, card) {
    api('/api/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streamId: streamId, toolCallId: toolCallId, approved: approved }) })
      .then(function () {
        card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        var d = document.createElement('div'); d.className = 'done'; d.textContent = approved ? '已批准' : '已拒绝';
        card.appendChild(d);
      });
  }
  function ensureAsk(streamId, toolCallId, detail) {
    if (askEls[toolCallId] && askEls[toolCallId].isConnected) return;
    var card = document.createElement('div'); card.className = 'card';
    var q = document.createElement('div'); q.className = 'q'; q.textContent = '❓ ' + ((detail && detail.question) || 'Agent 请求你做出选择');
    card.appendChild(q);
    var row = document.createElement('div'); row.className = 'opts';
    ((detail && detail.options) || []).forEach(function (o, i) {
      var btn = document.createElement('button');
      btn.textContent = (i + 1) + '. ' + (o.label || '') + (o.detail ? ' —— ' + o.detail : '');
      btn.onclick = function () { answerAsk(streamId, toolCallId, 'opt:' + i, card, o.label); };
      row.appendChild(btn);
    });
    card.appendChild(row);
    var free = document.createElement('input'); free.type = 'text'; free.placeholder = '或输入自定义回答…';
    free.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && free.value.trim()) { e.preventDefault(); answerAsk(streamId, toolCallId, 'free:' + free.value.trim(), card, free.value.trim()); }
    });
    card.appendChild(free);
    msgsEl.appendChild(card);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    askEls[toolCallId] = card;
  }
  function answerAsk(streamId, toolCallId, answer, card, label) {
    api('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ streamId: streamId, toolCallId: toolCallId, answer: answer }) })
      .then(function () {
        var d = document.createElement('div'); d.className = 'done'; d.textContent = '已回答: ' + (label || answer);
        card.appendChild(d);
        card.querySelectorAll('button, input').forEach(function (b) { b.disabled = true; });
      });
  }

  /* ---- SSE 事件渲染(仅当前会话) ---- */
  function onEvent(ev) {
    if (ev.type === 'convs-changed' || ev.type === 'config-changed') { poll(); return; }
    if (ev.convId && ev.convId !== curConv) return; // 非当前会话的流:不渲染(state 轮询负责列表圆点)
    switch (ev.type) {
      case 'text-delta': {
        if (!live[ev.streamId] || !live[ev.streamId].el.isConnected) {
          var d = el('ai', null);
          var s = document.createElement('span');
          d.appendChild(s);
          live[ev.streamId] = { el: d, txt: s };
        }
        live[ev.streamId].txt.textContent += ev.text || '';
        msgsEl.scrollTop = msgsEl.scrollHeight;
        break;
      }
      case 'text-end':
        if (live[ev.streamId]) live[ev.streamId].txt.textContent = ev.content || live[ev.streamId].txt.textContent;
        break;
      case 'reasoning-delta': {
        var k = 'r' + ev.streamId;
        if (!live[k] || !live[k].el.isConnected) {
          var rd = el('reason', null);
          var rs = document.createElement('span');
          rd.appendChild(rs);
          live[k] = { el: rd, txt: rs };
        }
        live[k].txt.textContent += ev.text || '';
        break;
      }
      case 'tool-start':
        ensureDecision(ev.streamId, ev.toolCallId, { name: ev.name, args: ev.args ? JSON.stringify(ev.args) : '' });
        if (!decisionEls[ev.toolCallId]) {}
        var tl = el('tool', null, (ev.status === 'awaiting' ? '⏸ ' : '⚙ ') + (ev.name || 'tool'));
        live[ev.toolCallId] = { el: tl };
        break;
      case 'tool-end':
        if (live[ev.toolCallId]) live[ev.toolCallId].el.textContent = '⚙ ' + (live[ev.toolCallId].el.textContent.replace(/^[⏸⚙] /, '')) + ' · ' + (ev.status || '');
        break;
      case 'ask-user':
        ensureAsk(ev.streamId, ev.toolCallId, { question: ev.question, options: ev.options });
        break;
      case 'error':
        el('err', null, '⚠ ' + (ev.message || '出错'));
        break;
      case 'done':
        live = {};
        poll();
        break;
      default: break;
    }
  }

  /* ---- state 轮询 ---- */
  var lastKey = '';
  function poll() {
    return api('/api/state' + (curConv ? '?convId=' + encodeURIComponent(curConv) : ''))
      .then(function (r) { return r.json(); })
      .then(function (st) {
        document.getElementById('lock').style.display = 'none';
        if (!curConv || !st.convs.some(function (c) { return c.id === curConv; })) curConv = st.convId;
        renderState(st);
        var last = (st.messages && st.messages[st.messages.length - 1]) || null;
        var key = st.convId + '|' + (st.messages || []).length + '|' + (last ? JSON.stringify(last).length : 0);
        if (key !== lastKey) { lastKey = key; renderMessages(st); }
      })
      .catch(function () { document.getElementById('lock').textContent = '连接失败,正在重试…'; });
  }
  function renderMessages(st) {
    msgsEl.innerHTML = '';
    live = {};
    (st.messages || []).forEach(function (m) {
      if (m.role === 'user') {
        var u = el('user', null, typeof m.content === 'string' ? m.content : '');
        if (typeof m.content !== 'string') u.textContent = '[消息]';
        return;
      }
      (m.blocks || []).forEach(function (b) {
        if (b.type === 'text' && b.content) el('ai', null, b.content);
        else if (b.type === 'reasoning' && b.content) el('reason', null, b.content.slice(0, 600));
        else if (b.type === 'tool') el('tool', null, '⚙ ' + (b.name || '') + '(' + (b.status || '') + ')');
        else if (b.type === 'image') {
          if (b.dataUrl) {
            var wrap = el('ai', null);
            var img = document.createElement('img');
            img.src = b.dataUrl;
            img.alt = '图片';
            wrap.appendChild(img);
          } else el('tool', null, b.label || '[图片]');
        } else if (b.type === 'ask') el('card', null, '问询: ' + (b.question || '') + (b.answerDisplay ? ' → ' + b.answerDisplay : ''));
      });
      if (m.role === 'assistant' && !m.blocks) el('ai', null, m.content || '');
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ---- 发送(文本 + 图片附件) ---- */
  function send() {
    var text = inp.value.trim();
    if (!text && !pendingAtt.length) return;
    inp.value = '';
    var u = el('user', null, text || '');
    if (pendingAtt.length) {
      u.textContent = (text ? text + '\\n' : '') + '[图片 ×' + pendingAtt.length + ']';
    }
    var payload = { text: text, convId: curConv || '', mode: modeEl.value, attachments: pendingAtt.slice() };
    payload.reasonLevel = reasonEl.value || null;
    var pm = modelEl.value.split('|');
    if (pm.length === 2) { payload.providerId = pm[0]; payload.model = pm[1]; }
    if (reasonEl.value) { localStorage.setItem('ra-reason', reasonEl.value); reasonSel = reasonEl.value; } else { localStorage.removeItem('ra-reason'); reasonSel = ''; }
    pendingAtt = [];
    renderAtts();
    api('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) { curConv = r.convId; poll(); }
        else if (r.error === 'rate-limited') el('err', null, '发送太快,稍后再试');
        else el('err', null, '发送失败');
      })
      .catch(function () { el('err', null, '发送失败,请检查连接'); });
  }
  function renderAtts() {
    var box = document.getElementById('atts');
    box.innerHTML = '';
    pendingAtt.forEach(function (a, i) {
      var chip = document.createElement('span'); chip.className = 'att';
      chip.textContent = a.name || ('图片' + (i + 1));
      var rm = document.createElement('button'); rm.textContent = '×';
      rm.onclick = function () { pendingAtt.splice(i, 1); renderAtts(); };
      chip.appendChild(rm);
      box.appendChild(chip);
    });
  }
  sendBtn.onclick = send;
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  document.getElementById('pick').onclick = function () { document.getElementById('file').click(); };
  document.getElementById('file').addEventListener('change', function (e) {
    var files = [...(e.target.files || [])].slice(0, 8);
    files.forEach(function (f) {
      if (f.size > 10 * 1024 * 1024) { el('err', null, '图片过大(>10MB): ' + f.name); return; }
      var fr = new FileReader();
      fr.onload = function () {
        pendingAtt.push({ name: f.name, mime: f.type || 'image/png', dataUrl: String(fr.result || '') });
        renderAtts();
      };
      fr.readAsDataURL(f);
    });
    e.target.value = '';
  });

  /* ---- 会话操作 ---- */
  stopBtn.onclick = function () { api('/api/abort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ convId: curConv }) }); };
  convsEl.addEventListener('change', function () { curConv = convsEl.value; lastKey = ''; poll(); });
  document.getElementById('new').onclick = function () {
    // 新会话:清空本地视图,下一条消息自动落新会话
    curConv = '';
    lastKey = '';
    msgsEl.innerHTML = '';
    el('ai', null, '新会话已就绪:输入第一条消息开始(将创建新对话)。');
    inp.focus();
  };
  document.getElementById('more').onclick = function () {
    if (!curConv) return;
    var act = window.prompt('输入操作:1 = 重命名当前会话,2 = 删除当前会话', '1');
    if (act === '1') {
      var t = window.prompt('新标题:');
      if (t && t.trim()) api('/api/conv-rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ convId: curConv, title: t.trim() }) }).then(poll);
    } else if (act === '2') {
      if (!window.confirm('确定删除当前会话?不可恢复。')) return;
      api('/api/conv-delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ convId: curConv }) })
        .then(function () { curConv = ''; lastKey = ''; poll(); });
    }
  };
  modeEl.addEventListener('change', function () {
    api('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: modeEl.value }) });
  });
  modelEl.addEventListener('change', function () {
    var pm = modelEl.value.split('|');
    if (pm.length === 2) api('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: pm[0], model: pm[1] }) });
  });

  if (!T) { document.getElementById('lock').textContent = '缺少访问令牌:请从主界面显示的完整 URL 进入。'; }
  else {
    try {
      var es = new EventSource('/api/events?t=' + encodeURIComponent(T));
      es.onmessage = function (e) { try { onEvent(JSON.parse(e.data)); } catch (_) {} };
    } catch (_) {}
    poll();
    setInterval(poll, 1500);
  }
})();
</script>
</body></html>`;

module.exports = { applyConfig, stop, running, broadcast, _internal: { tokenOk, statePayload, rateLimited, route, lanIP } };
