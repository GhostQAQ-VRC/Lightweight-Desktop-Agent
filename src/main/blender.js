// Blender 建模工具链(原生移植自 @dsh-external/dsh-blender-plugin v2.6.1,零依赖)
// 架构:主进程托管后端子进程(resources/blender-runtime/server.mjs,ELECTRON_RUN_AS_NODE)
//   后端 ─TCP 9876→ Blender addon(dsh_blender_bridge.py,GUI 模式)
//        ─TCP 9879+→ 无头 worker(blender -b)
//   15 个模型工具名字与原插件一致(技能包 blender-modeling 的 SOP 直接生效);
//   图片回传走 agent.js 的 imageResult 路径(多模态回灌);
//   选中桥:3s 轮询 /host/selection → blender:event → 渲染端插输入框(不自动发送)。
// 端口契约 9876/9877/9879 与原插件一致 → Blender 侧 addon 与 runtime Python 模块零改动。
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const debuglog = require('./debuglog');
const security = require('./security');

const PLUGIN_VERSION = '2.6.1';
const HOST = '127.0.0.1';

// 工具静态超时表(照搬原插件 T 表:内部超时先于任何外部截止触发)
const T = {
  see: 300000, act: 300000, watch: 600000, cmd: 360000, commands: 60000,
  loop: 360000, perf: 660000, opt: 660000, headless: 1200000, plan: 360000,
  worker: 1920000, txn: 360000, preset: 360000, job: 660000, viewport: 60000,
};
// headless 单次同步等待窗口:到点转作业层回 jobId(服务端子进程继续跑,结果不丢)
const HEADLESS_WAIT_MS = 100000;

// ---------- 路径 ----------
function runtimeRoot() {
  const packed = process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'blender-runtime') : '';
  if (packed && fs.existsSync(path.join(packed, 'server.mjs'))) return packed;
  return path.join(__dirname, '..', '..', 'resources', 'blender-runtime');
}
function serverPath() { return path.join(runtimeRoot(), 'server.mjs'); }
function addonFile() { return path.join(runtimeRoot(), 'addon', 'dsh_blender_bridge.py'); }

// ---------- 配置 ----------
function cfg(store) {
  const c = (store && store.config && store.config.blender) || {};
  return {
    enabled: !!c.enabled,
    viewportPanel: !!c.viewportPanel,
    httpPort: Number(c.httpPort) > 0 ? Number(c.httpPort) : 9877,
    addonPort: Number(c.addonPort) > 0 ? Number(c.addonPort) : 9876,
    blenderExe: String(c.blenderExe || ''),
    workDir: String(c.workDir || ''),
    holder: String(c.holder || ('liteagent-pid-' + process.pid)),
  };
}
function defaultWorkDir() {
  return process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-blender-rt')
    : path.join(os.homedir(), '.dsh', 'dsh-blender-rt');
}
let exeCache = null;
// blender.exe 自动探测:配置优先,其次常见安装位(Program Files / 用户级 / Steam 库)
function resolveBlenderExe(store) {
  const c = cfg(store);
  if (c.blenderExe) {
    try { if (fs.statSync(c.blenderExe).isFile()) { exeCache = c.blenderExe; return c.blenderExe; } } catch (_) { /* 配置的路径不存在,继续探测 */ }
  }
  if (exeCache) return exeCache;
  if (process.platform !== 'win32') { exeCache = ''; return ''; }
  const cands = [];
  const roots = [
    path.join('C:', 'Program Files', 'Blender Foundation'),
    path.join('D:', 'Program Files', 'Blender Foundation'),
  ];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Blender'));
  for (const root of roots) {
    try {
      const subs = fs.readdirSync(root).filter((d) => /^blender/i.test(d)).sort();
      for (const s of subs) cands.push(path.join(root, s, 'blender.exe'));
    } catch (_) { /* 目录不存在 */ }
  }
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    cands.push(drive + ':\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe');
    cands.push(drive + ':\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe');
  }
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) { exeCache = p; return p; } } catch (_) { /* next */ }
  }
  exeCache = '';
  return '';
}
function backendEnv(store) {
  const c = cfg(store);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_BLENDER_HTTP_PORT: String(c.httpPort), DSH_BLENDER_ADDON_PORT: String(c.addonPort), DSH_BLENDER_HOLDER: c.holder };
  env.DSH_BLENDER_WORKDIR = c.workDir || defaultWorkDir();
  const exe = resolveBlenderExe(store);
  if (exe) env.DSH_BLENDER_EXE = exe;
  return env;
}
function audit(store, detail) {
  try { security.auditAppend(store, { kind: 'blender', ...detail }); } catch (_) { /* ignore */ }
}

// ---------- HTTP(本地回环,原生 http,不经代理出口) ----------
const ABORT_HINT = '本次等待已取消(用户打断)。服务端任务可能仍在跑 —— 长任务请用 blender_rt_job 按 id 回收。';
function base(port) { return 'http://' + HOST + ':' + String(port); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rawRequest(port, method, p, bodyObj, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    let firedTimeout = false;
    const timer = setTimeout(() => { firedTimeout = true; ac.abort(); }, timeoutMs);
    const onExtAbort = () => ac.abort();
    let extAborted = false;
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', onExtAbort, { once: true });
    }
    const done = (fn, v) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onExtAbort); fn(v); };
    const payload = bodyObj === undefined ? null : JSON.stringify(bodyObj);
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    const req = http.request({ host: HOST, port, path: p, method, headers, timeout: 0 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => {
      if (signal && signal.aborted) { extAborted = true; done(reject, new Error(ABORT_HINT)); return; }
      if (ac.signal.aborted && firedTimeout) { done(reject, new Error('后端请求超时(' + Math.round(timeoutMs / 1000) + 's):' + p)); return; }
      if (ac.signal.aborted) { done(reject, new Error(ABORT_HINT)); return; }
      if (e && e.code === 'ECONNREFUSED') { done(reject, new Error('后端未运行(' + base(port) + ')。可在 设置→Agent→Blender 打开开关,或让 AI 调 blender_viewport(op="start")')); return; }
      done(reject, e);
    });
    ac.signal.addEventListener('abort', () => { try { req.destroy(new Error('aborted')); } catch (_) { /* already */ } });
    if (payload) req.write(payload);
    req.end();
  });
}

// 后端响应可能是 NDJSON(流式路由每 15s 一条心跳,最后一条才是结果)
function parseBackendBody(text) {
  const t = String(text == null ? '' : text);
  try {
    const o = JSON.parse(t);
    if (o && typeof o === 'object') return o;
  } catch (_) { /* 流式响应,往下走 */ }
  const lines = t.split('\n').map((s) => s.trim()).filter(Boolean);
  let last = null;
  let beats = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o = null;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || typeof o !== 'object' || o.heartbeat === true) continue;
    last = o; break;
  }
  for (let i = 0; i < lines.length; i++) {
    try { const o = JSON.parse(lines[i]); if (o && o.heartbeat === true) beats++; } catch (_) { /* 非 JSON 行 */ }
  }
  if (last) { last.__heartbeats = beats; return last; }
  return { ok: false, raw: t.slice(-500), parseError: 'no JSON line found' };
}

async function backendJson(port, p, timeoutMs, signal) {
  const r = await rawRequest(port, 'GET', p, undefined, timeoutMs, signal);
  const text = r.buf.toString('utf8');
  try { return JSON.parse(text); } catch (_) { return { ok: false, raw: text.slice(0, 500) }; }
}
async function backendPost(port, p, body, timeoutMs, signal) {
  const c = body && body.__holder === false ? {} : { holder: currentHolder };
  const r = await rawRequest(port, 'POST', p, { ...(body || {}), ...c }, timeoutMs, signal);
  const j = parseBackendBody(r.buf.toString('utf8'));
  j.__status = r.status;
  return j;
}
let currentHolder = 'liteagent-pid-' + process.pid;

// ---------- 帧与图片 ----------
const FRAME_CACHE = new Map();
function frameDedupe(key, hash, force) {
  const k = String(key || 'default');
  const h = String(hash || '');
  const cur = FRAME_CACHE.get(k);
  if (!force && cur && h && cur.hash === h) {
    cur.repeats += 1;
    return { dup: true, repeats: cur.repeats };
  }
  FRAME_CACHE.set(k, { hash: h, repeats: 0 });
  if (FRAME_CACHE.size > 32) {
    const oldest = FRAME_CACHE.keys().next().value;
    if (oldest !== undefined && oldest !== k) FRAME_CACHE.delete(oldest);
  }
  return { dup: false, repeats: 0 };
}
function dedupeNote(repeats) {
  return ' · **与上一张完全相同**(第 ' + String(repeats + 1) + ' 次)⇒ 未重复附图;要重发传 force=true';
}
function pngResult(buf) {
  if (!buf || !buf.length) return null;
  return { mime: 'image/png', base64: Buffer.from(buf).toString('base64') };
}
async function fetchFrame(port, size, signal, full, area) {
  const t0 = Date.now();
  const url = '/frame.png?' + (full ? ('full=1&area=' + String(area || 0)) : ('size=' + String(size)));
  const r = await rawRequest(port, 'GET', url, undefined, 60000, signal);
  if (r.status !== 200) throw new Error('frame http ' + r.status);
  return { png: r.buf, ms: Date.now() - t0, hash: crypto.createHash('md5').update(r.buf).digest('hex').slice(0, 8) };
}
async function fetchView(port, spec, signal) {
  const t0 = Date.now();
  const r = await rawRequest(port, 'POST', '/view', spec || {}, 180000, signal);
  if (r.status !== 200) {
    let j = null;
    try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) { /* ignore */ }
    throw new Error('view http ' + r.status + ' · ' + String((j && j.error) || r.buf.toString('utf8').slice(0, 300)));
  }
  let meta = null;
  try {
    const rawHdr = String(r.headers['x-dsh-view'] || 'null');
    const txt = rawHdr.indexOf('%7B') === 0 ? decodeURIComponent(rawHdr) : rawHdr;
    meta = JSON.parse(txt);
  } catch (_) { meta = null; }
  return { png: r.buf, ms: Date.now() - t0, meta: meta, hash: crypto.createHash('md5').update(r.buf).digest('hex').slice(0, 8) };
}
// 本地 PNG 读取(worker/plan 产物路径;Windows 直接读)
function readLocalPng(p) {
  const s = String(p == null ? '' : p);
  if (!s) return null;
  try { return fs.readFileSync(s); } catch (_) { return null; }
}

// ---------- 后端托管 ----------
let child = null;
let paused = false;
let watchdogTimer = null;
let probeMisses = 0;

async function probe(port, timeoutMs) {
  try {
    const r = await rawRequest(port, 'GET', '/health', undefined, timeoutMs || 1500, null);
    if (r.status !== 200) return false;
    // 版本校验(v0.55.0 修复「旧代后端误认」):本代(2.6.1)后端 /health 带 backend.pid;
    // 端口被旧代(如 1.1.0 的 DSH 残留)占着时 probe 必须失败,否则 /host/* 全 404 且永不自愈
    try { const h = JSON.parse(r.buf.toString('utf8')); return !!(h && h.backend && h.backend.pid); } catch (_) { return false; }
  } catch (_) { return false; }
}
// 端口清障:netstat 找 LISTENING 的 pid,只杀命令行含 server.mjs 的(绝不误杀无关服务)
function killPortOwner(port) {
  try {
    const r = spawnSync('cmd.exe', ['/c', 'netstat -ano | findstr ":' + String(port) + '" | findstr LISTENING'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const pids = new Set();
    for (const line of String(r.stdout || '').split('\n')) {
      if (line.indexOf('LISTENING') < 0) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        const q = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        const cmd = String(q.stdout || '');
        if (cmd.indexOf('server.mjs') >= 0) {
          spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
          return 'killed-pid-' + pid;
        }
      } catch (_) { /* 查询失败跳过 */ }
    }
  } catch (_) { /* netstat 不可用则跳过 */ }
  return '';
}
function spawnChild(store) {
  const c = cfg(store);
  const p = spawn(process.execPath, [serverPath(), '--port', String(c.httpPort)], {
    env: backendEnv(store),
    cwd: runtimeRoot(),
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
    windowsHide: true,
  });
  p.unref();
  let errBuf = '';
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-2000); });
  p.on('exit', () => { if (child === p) child = null; });
  child = p;
  debuglog.info(store, 'blender', 'backend-spawn', { pid: p.pid, port: c.httpPort });
  audit(store, { action: 'backend-spawn', port: c.httpPort, pid: p.pid });
  return 'spawned pid=' + String(p.pid);
}
async function startBackend(store) {
  const port = cfg(store).httpPort;
  if (await probe(port, 800)) return 'already-running';
  // 端口被旧代后端占着(严格 probe 失败但有人听)→ 清障后再起
  const cleared = killPortOwner(port);
  if (cleared) await sleep(600);
  if (child) { try { child.kill(); } catch (_) { /* ignore */ } child = null; }
  return spawnChild(store);
}
async function ensureBackend(store) {
  const port = cfg(store).httpPort;
  if (await probe(port)) return true;
  if (paused) return false;
  try { await startBackend(store); } catch (e) { audit(store, { action: 'backend-start-fail', error: String(e && e.message || e).slice(0, 200) }); return false; }
  for (let i = 0; i < 25; i++) {
    if (await probe(port)) return true;
    await sleep(300);
  }
  return false;
}
// 后端是独立常驻进程(detached):LiteAgent 退出不杀它,下次启动 /health 探活直接复用,
// worker 会话与租约跨启动保留 —— 与原 DSH 插件行为一致。显式停止走 stopBackend。
async function stopBackend(store, reason) {
  const c = cfg(store);
  paused = true;
  if (child) { try { child.kill(); } catch (_) { /* ignore */ } child = null; }
  let killed = '';
  try {
    const h = await backendJson(c.httpPort, '/health', 2500, null);
    const pid = h && h.backend && h.backend.pid;
    if (pid) {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
      killed = ' pid=' + String(pid);
    }
  } catch (_) { /* 后端本来就没跑 */ }
  audit(store, { action: 'backend-stop', reason: reason || 'user', note: killed || 'not-running' });
  return killed ? '已停止后端' + killed : '后端未在运行';
}
// 15s 看护:探活失败连续 2 次(≈30s)才认定卡死 → 杀 → 重生;租约心跳只续自己持有的
function startWatchdog(store) {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void (async () => {
      try {
        const c = cfg(store);
        if (!c.enabled || paused) return;
        if (await probe(c.httpPort)) {
          probeMisses = 0;
          try { await backendPost(c.httpPort, '/lease', { renewOnly: true }, 5000, null); } catch (_) { /* 后端可能刚挂 */ }
          return;
        }
        probeMisses += 1;
        if (probeMisses >= 2) {
          probeMisses = 0;
          try { await stopBackend(store, 'watchdog-stale'); } catch (_) { /* ignore */ }
          paused = false; // 看护路径的重启不受 stop 的 paused 影响
          await sleep(600);
        }
        await startBackend(store);
      } catch (_) { /* 看护失败静默,下一轮再试 */ }
    })();
  }, 15000);
  if (watchdogTimer.unref) watchdogTimer.unref();
}
function stopWatchdog() { clearInterval(watchdogTimer); watchdogTimer = null; }

// ---------- 选中桥(Blender 原生选中 → 渲染端输入框,不自动发送) ----------
let selectionTimer = null;
let lastSeq = -1;
let broadcaster = null; // ipc.js 装配: (obj) => mainWindow.webContents.send('blender:event', obj)
function setBroadcaster(fn) { broadcaster = typeof fn === 'function' ? fn : null; }
function startSelectionBridge(store) {
  if (selectionTimer) return;
  selectionTimer = setInterval(() => {
    void (async () => {
      try {
        const c = cfg(store);
        if (!c.enabled) return;
        const snap = await backendJson(c.httpPort, '/host/selection/latest', 2500, null);
        if (!snap || snap.ok === false) return;
        if (lastSeq < 0) { lastSeq = Number(snap.seq) || 0; return; } // 首轮只记水位,不回放存量
        const seq = Number(snap.seq) || 0;
        if (!snap.unconsumed || seq <= lastSeq) return;
        const sel = snap.selection || {};
        const names = Array.isArray(sel.names) ? sel.names : [];
        if (!names.length) { lastSeq = seq; return; }
        const consumed = await backendPost(c.httpPort, '/host/selection/consume', { seq }, 2500, null);
        if (!consumed || consumed.ok === false) return;
        lastSeq = seq;
        if (broadcaster) broadcaster({ type: 'selection', names: names.slice(0, 20), total: names.length, scene: snap.scene || null });
        audit(store, { action: 'selection-sync', objects: names.length });
      } catch (_) { /* 后端未运行时静默 */ }
    })();
  }, 3000);
  if (selectionTimer.unref) selectionTimer.unref();
}
function stopSelectionBridge() { clearInterval(selectionTimer); selectionTimer = null; lastSeq = -1; }

// 开关/配置变更入口(ipc.js config:set 钩子调用)
function applyConfig(store) {
  const c = cfg(store);
  if (c.enabled) {
    startWatchdog(store);
    startSelectionBridge(store);
    void ensureBackend(store);
  } else {
    stopWatchdog();
    stopSelectionBridge();
  }
  // 视口面板(config.blender.viewportPanel)在渲染端右侧面板实现,主进程无窗口要管
}

// ---------- 视口面板支撑(右侧面板「Blender 视口」标签的数据面,复刻 1.1.0 的视口面板) ----------
// /host/* 只读代理(面板数据面;渲染端 file:// origin 直接 fetch 9877 会被 CORS 拒,统一走主进程原生 http)
async function hostGet(store, p) {
  const c = cfg(store);
  const url = String(p || '');
  if (!/^\/host\/(state|jobs|jobs\/log|scene-items)(\?|$)/.test(url)) throw new Error('仅允许 /host/ 只读路由');
  try {
    const r = await rawRequest(c.httpPort, 'GET', url, undefined, 5000, null);
    try { return JSON.parse(r.buf.toString('utf8')); } catch (_) { return { ok: false, error: 'bad-json' }; }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
// 面板「插入到输入框」(不自动发送)
function insertText(text) {
  const t = String(text || '').slice(0, 2000);
  if (!t || !broadcaster) return false;
  broadcaster({ type: 'insert-text', text: t });
  return true;
}
// 点击选物(1.1.0 视口面板 /host/view/pick 的等价物):归一化坐标(0..1,左上原点 y 向下)
// → GUI Blender 主线程 raycast → 选中并激活;需要 GUI addon 在线
async function pickAt(store, x, y, signal) {
  const c = cfg(store);
  const ok = await ensureBackend(store);
  if (!ok) return { ok: false, error: '后端不可用' };
  const nx = Math.max(0, Math.min(1, Number(x) || 0));
  const ny = Math.max(0, Math.min(1, Number(y) || 0));
  const code = [
    'import bpy, json',
    'from bpy_extras import view3d_utils',
    'def _pick(nx, ny):',
    '    for area in bpy.context.window.screen.areas:',
    '        if area.type != "VIEW_3D": continue',
    '        for region in area.regions:',
    '            if region.type != "WINDOW": continue',
    '            rv3d = area.spaces.active.region_3d',
    '            rx = region.x + nx * region.width',
    '            ry = region.y + (1.0 - ny) * region.height',
    '            origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, (rx, ry))',
    '            direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, (rx, ry))',
    '            res = bpy.context.scene.ray_cast(bpy.context.view_layer.depsgraph, origin, direction)',
    '            hit, loc, normal, face, obj = res[0], res[1], res[2], res[3], res[4]',
    '            if hit and obj is not None:',
    '                for o in list(bpy.context.selected_objects): o.select_set(False)',
    '                obj.select_set(True)',
    '                bpy.context.view_layer.objects.active = obj',
    '                return {"ok": True, "object": obj.name}',
    '            return {"ok": False, "error": "no_hit"}',
    '    return {"ok": False, "error": "no_view3d"}',
    'print("PICK " + json.dumps(_pick(' + nx.toFixed(4) + ', ' + ny.toFixed(4) + ')))',
  ].join('\n');
  try {
    const r = await backendPost(c.httpPort, '/act', { code }, 30000, signal);
    if (!r || r.ok !== true) return { ok: false, error: '需要 Blender 已连接(GUI 模式):' + String((r && (r.error || r.raw)) || '通道不可用') };
    const m = /PICK (\{.*\})/.exec(String(r.stdout || ''));
    if (m) { try { return JSON.parse(m[1]); } catch (_) { /* fallthrough */ } }
    return { ok: false, error: 'pick 无回执' + (r.stderr ? '(' + String(r.stderr).trim().slice(0, 120) + ')' : '') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------- 工具辅助 ----------
function numTriple(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map((x) => Number(x));
  return String(v).split(/[,\s]+/).filter(Boolean).map((x) => Number(x));
}
function jsonPayload(v) {
  if (v === undefined || v === null || v === '') return {};
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {}; } catch (_) { return {}; }
  }
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v };
  return {};
}
function splitArgs(s) {
  if (Array.isArray(s)) return s.map((x) => String(x));
  const str = String(s == null ? '' : s);
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function leasedText(r) {
  if (!r || r.error !== 'leased') return undefined;
  return '写通道被别的会话占用(holder=' + String(r.holder) + ',剩余 ' + String(Math.round(Number(r.expiresInMs || 0) / 1000)) + 's)。'
    + String(r.hint || '') + ';要强抢:blender_viewport op=lease force=true';
}
// 产物目录守卫:默认工作目录下 blender-out/,显式给路径则过文件沙箱(越界报错)
async function resolveOutdir(v, ctx) {
  const tools = require('./tools');
  if (!v) return path.join(ctx.workspace, 'blender-out');
  const abs = path.isAbsolute(String(v)) ? String(v) : path.join(ctx.workspace, String(v));
  return tools.assertFsPath(abs, ctx, 'blender_outdir');
}
// 批量附图:读本地 PNG 路径(≤max 张)
function attachPaths(paths, tag, max) {
  const images = [];
  const failed = [];
  const seen = new Set();
  for (const p of paths || []) {
    if (images.length >= (max || 2)) break;
    const s = String(p == null ? '' : p);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const data = readLocalPng(s);
    const img = data ? pngResult(data) : null;
    if (img) images.push(img); else failed.push(s);
  }
  return { images, failed };
}

// ---------- 无头 worker 降级(GUI 不在时 see/do/watch/plan 的备用通路) ----------
async function seeViaWorker(port, spec, name, signal) {
  try {
    const r = await backendPost(port, '/worker', { op: 'see', name: name || 'default', spec: spec || {}, isolated: true }, 90000, signal);
    if (!r || r.ok !== true) return null;
    const res = (r.result && typeof r.result === 'object') ? r.result : {};
    if (res.ok === false) return { text: '无头 see 失败 · ' + String(res.error || 'unknown') + (res.traceback ? '\n' + String(res.traceback).slice(-1200) : ''), images: [] };
    let data = null;
    if (res.png_b64) { try { data = Buffer.from(String(res.png_b64), 'base64'); } catch (_) { data = null; } }
    if (!data && res.path) data = readLocalPng(res.path);
    const text = '无头 see(Workbench 离屏,GUI 未连接自动降级)· ' + String(res.ms) + 'ms · ' + String(res.width) + 'x' + String(res.height)
      + ' · ' + String(res.bytes || 0) + 'B · 场景与用户视口未改动';
    const img = data ? pngResult(data) : null;
    return img ? { text, images: [img] } : { text: text + '\n⚠ 图片未回传(无 png_b64/path)', images: [] };
  } catch (_) { return null; }
}
async function doViaSession(port, opts, signal) {
  try {
    const nm = String(opts.session || 'interactive');
    if (opts.preload) {
      const st = await backendPost(port, '/worker', { op: 'start', name: nm, preload: String(opts.preload), engine: 'workbench', warmup: true, isolated: true }, 120000, signal);
      if (!st || st.ok !== true) return { text: '无头会话启动失败 · ' + String((st && (st.error || st.raw)) || 'unknown'), images: [] };
    }
    let code = String(opts.code || '');
    if (!code && opts.file) {
      try { code = fs.readFileSync(String(opts.file), 'utf8'); } catch (_) { return { text: '读不到脚本文件:' + String(opts.file), images: [] }; }
    }
    if (!code) return null;
    const r = await backendPost(port, '/worker', { op: 'exec', name: nm, code, isolated: true }, 180000, signal);
    const rr = (r && r.result) || {};
    if (!r || r.ok !== true) {
      return { text: 'ACT(session) 失败 · ' + String((r && (r.error || rr.error)) || 'unknown') + (rr.traceback ? '\n' + String(rr.traceback).slice(-1800) : ''), images: [] };
    }
    const parts = ['ACT(session=' + nm + ') ok · ' + String(rr.ms) + 'ms'];
    if (rr.stdout && String(rr.stdout).trim()) parts.push('stdout: ' + String(rr.stdout).trim().slice(0, 3000));
    if (rr.stderr && String(rr.stderr).trim()) parts.push('stderr: ' + String(rr.stderr).trim().slice(0, 1200));
    let img = null;
    if (opts.see !== false) {
      const size = Math.max(120, Math.min(1600, Number(opts.max_size || 560)));
      const spec = { from: numTriple(opts.from) || [7, -7, 5], look_at: numTriple(opts.look_at) || [0, 0, 1], width: size, height: Math.max(120, Math.round(size * 9 / 16)) };
      const vs = String(opts.view_size || '');
      const mm = /^(\d+)\s*[x×]\s*(\d+)$/.exec(vs);
      if (mm) { spec.width = Number(mm[1]); spec.height = Number(mm[2]); }
      const sr = await backendPost(port, '/worker', { op: 'see', name: nm, spec, isolated: true }, 90000, signal);
      const sres = (sr && sr.result) || {};
      if (sres.ok !== false) {
        let data = null;
        if (sres.png_b64) { try { data = Buffer.from(String(sres.png_b64), 'base64'); } catch (_) { data = null; } }
        if (!data && sres.path) data = readLocalPng(sres.path);
        img = data ? pngResult(data) : null;
        parts.push('SEE(session) ' + spec.width + 'x' + spec.height + ' · ' + String(sres.ms) + 'ms');
        if (!img) parts.push('⚠ 图片未回传');
      } else parts.push('SEE(session) 失败: ' + String(sres.error || 'unknown'));
    }
    return { text: parts.join('\n'), images: img ? [img] : [] };
  } catch (_) { return null; }
}
async function watchViaWorker(port, args, session, signal) {
  const size = Math.max(120, Math.min(1600, Number((args && args.max_size) || 420)));
  const spec = {
    width: size, height: Math.max(120, Math.round(size * 9 / 16)),
    seconds: Math.max(0.2, Math.min(20, Number((args && args.seconds) || 2))),
    fps: Math.max(0.5, Math.min(8, Number((args && args.fps) || 4))),
    code: args && args.code ? String(args.code) : undefined,
  };
  const nm = session ? String(session) : 'watch';
  try {
    await backendPost(port, '/worker', { op: 'start', name: nm, engine: 'workbench', warmup: true, isolated: true }, 120000, signal);
    const r = await backendPost(port, '/worker', { op: 'watch', name: nm, spec, isolated: true }, 180000, signal);
    const res = (r && r.result) || {};
    if (!r || r.ok !== true || res.ok !== true) return { text: 'WATCH 无头失败 · ' + String((r && (r.error || res.error)) || 'unknown'), images: [] };
    const fr = res.frames || [];
    const hashes = fr.filter((x) => x && x.ok).map((x) => x.hash);
    const distinct = new Set(hashes).size;
    const parts = [];
    if (res.code) parts.push('code: ' + (res.code.ok ? 'ok' : '失败') + (res.code.error ? ' · ' + String(res.code.error) : ''));
    parts.push('WATCH(headless) ' + String(res.sampled || fr.length) + ' 帧 · 不同画面 ' + distinct + '/' + hashes.length + ' · ' + String(res.ms || 0) + 'ms');
    parts.push('timeline: ' + fr.slice(0, 16).map((x) => String(x.frame) + ':' + String(x.hash)).join(' '));
    const images = [];
    const picks = Array.isArray(res.picks) ? res.picks.slice(0, 6) : [];
    for (const p of picks) {
      let data = null;
      if (p.png_b64) { try { data = Buffer.from(String(p.png_b64), 'base64'); } catch (_) { data = null; } }
      if (!data && p.path) data = readLocalPng(p.path);
      const img = data ? pngResult(data) : null;
      if (img) images.push(img);
    }
    parts.push('附帧:' + images.length + ' 张');
    return { text: parts.join('\n'), images };
  } catch (e) {
    return { text: 'WATCH 无头异常 · ' + String((e && e.message) || e), images: [] };
  }
}
// plan op → 无头 worker 模块 API 映射(照搬原插件 PLAN_HEADLESS_MAP)
const PLAN_HEADLESS_MAP = [
  ['visualreport_', 'dsh_visualreport_api', 'visualreport,qc,imgtools'],
  ['shapesolve_', 'dsh_shapesolve_api', 'shapesolve,imgtools'],
  ['eval_', 'dsh_evalharness_api', 'evalharness,assembly,audit,contract,clearance,gate,imgtools,calib,mesh_fix'],
  ['blockout_', 'dsh_blockout_api', 'blockout,qc,qc_render,montage'],
  ['asm_', 'dsh_assembly_api', 'assembly,audit,contract,clearance,gate,mesh_fix,geo,txn'],
  ['img_', 'dsh_img_api', 'imgtools'],
  ['audit_', 'dsh_audit_api', 'audit'],
  ['qc_', 'dsh_qc_api', 'qc,imgtools'],
  ['gate_', 'dsh_gate_api', 'gate,audit'],
  ['shape_', 'dsh_shape_api', 'shapegen,imgtools'],
  ['vehicle_', 'dsh_vehicle_api', 'vehicle,audit,clearance,gate'],
  ['clear_', 'dsh_clearance_api', 'clearance'],
  ['deliver_', 'dsh_deliver_api', 'deliver,gate'],
  ['fix_', 'dsh_fix_api', 'mesh_fix'],
  ['uv_', 'dsh_uv_api', 'uv_tools'],
  ['print_', 'dsh_print_api', 'printcheck'],
  ['sculpt_', 'dsh_sculpt_api', 'sculpt'],
  ['sweep_', 'dsh_sweep_api', 'sweep'],
  ['material_', 'dsh_material_api', 'material'],
  ['motion_', 'dsh_motion_api', 'motion'],
  ['generator_', 'dsh_generator_api', 'generator'],
  ['face_', 'dsh_face_api', 'faceeval'],
  ['human_', 'dsh_human_api', 'human,imgtools'],
];
const PLAN_HEADLESS_ALIAS = {
  qc_visual_report: ['dsh_visualreport_api', 'report', 'visualreport,qc,imgtools'],
  shape_solve: ['dsh_shapesolve_api', 'solve', 'shapesolve,imgtools'],
  fix_clash: ['dsh_assembly_api', 'repair', 'assembly,audit,contract,clearance,gate,mesh_fix,geo,txn'],
  fix_interference: ['dsh_assembly_api', 'fix_interference', 'assembly,audit,contract,clearance,gate,mesh_fix,geo,txn'],
  audit_clash_all: ['dsh_assembly_api', 'scan', 'assembly,audit,contract,clearance,gate,mesh_fix,geo,txn'],
  model_preflight: ['dsh_gate_api', 'preflight', 'gate,audit'],
  model_checkpoint: ['dsh_gate_api', 'checkpoint', 'gate,txn'],
  model_deliver: ['dsh_gate_api', 'deliver', 'gate,audit,txn,deliver'],
};
function planHeadlessTarget(op) {
  const o = String(op || '');
  if (PLAN_HEADLESS_ALIAS[o]) { const a = PLAN_HEADLESS_ALIAS[o]; return { api: a[0], sub: a[1], preload: a[2] }; }
  for (const row of PLAN_HEADLESS_MAP) {
    if (o.indexOf(row[0]) === 0) return { api: row[1], sub: o.slice(row[0].length), preload: row[2] };
  }
  return null;
}
async function planViaWorker(port, op, payload, session, signal) {
  const t = planHeadlessTarget(op);
  if (!t) return { ok: false, error: '该 plan op 没有无头映射(先 op="catalog" 查,或走 GUI 通道)' };
  const nm = session ? String(session) : ('plan-' + String(t.api).replace(/^dsh_|_api$/g, ''));
  try {
    const st = await backendPost(port, '/worker', { op: 'start', name: nm, preload: t.preload, engine: 'workbench', warmup: false, isolated: true }, 120000, signal);
    if (!st || st.ok !== true) return { ok: false, error: '无头 worker 启动失败:' + String((st && (st.error || st.raw)) || 'unknown') };
    const code = 'import json as _json\n_s = _json.dumps(_json.loads(' + JSON.stringify(JSON.stringify(payload || {})) + '))\n'
      + '_r = K.' + t.api + '["dispatch"](' + JSON.stringify(String(t.sub)) + ', _s)\n'
      + 'print("HEADLESS " + (_r if isinstance(_r, str) else _json.dumps(_r, ensure_ascii=False)))';
    const r = await backendPost(port, '/worker', { op: 'exec', name: nm, code, isolated: true }, 900000, signal);
    const rr = (r && r.result) || {};
    if (!r || r.ok !== true) return { ok: false, error: '无头 plan 执行失败:' + String((r && (r.error || rr.error)) || 'unknown'), hint: String(rr.traceback || '').slice(-1200) };
    return { ok: true, res: rr.result };
  } catch (e) {
    return { ok: false, error: '无头 plan 异常:' + String((e && e.message) || e) };
  }
}
// plan 产物附图路径收集
function planImagePaths(res) {
  const r = (res && typeof res === 'object') ? res : {};
  const out = [];
  const push = (x) => { const s = typeof x === 'string' ? x : (x && (x.path || x.crop || x.out || x.file)); if (s) out.push(String(s)); };
  if (Array.isArray(r.images)) for (const x of r.images) push(x);
  else if (r.images && typeof r.images === 'object') {
    for (const k of ['overlay', 'sheet', 'crops', 'per_view']) {
      const v = r.images[k];
      if (Array.isArray(v)) for (const x of v) push(x);
      else if (v) push(v);
    }
  }
  for (const k of ['overlay', 'sheet', 'diff_heat', 'annotated', 'atlas', 'out']) push(r[k]);
  if (Array.isArray(r.crops)) for (const c of r.crops) push(c);
  if (Array.isArray(r.views)) for (const v of r.views) push(v);
  if (r.overlay && r.overlay.path) push(r.overlay.path);
  if (r.sheet && r.sheet.path) push(r.sheet.path);
  return out;
}
// plan 回执统一收尾:verdict 信封 + 截断文本 + 可选附图
async function finishPlanResponse(op, res, argsIn) {
  const txt = typeof res === 'string' ? res : JSON.stringify(res, null, 1);
  const CAP = 12000;
  const r = (res && typeof res === 'object') ? res : { value: res };
  const verdict = r.verdict || r.state || (r.ok === false ? 'fail' : (r.ok === true ? (r.clean === false ? 'degraded' : 'pass') : null));
  const attachWanted = argsIn && argsIn.attach_images !== undefined
    ? !!argsIn.attach_images
    : ['img_digest', 'qc_compare', 'visualreport_report', 'qc_visual_report', 'shapesolve_solve'].indexOf(op) >= 0;
  let images = [];
  let attachNote = '';
  if (attachWanted) {
    const att = attachPaths(planImagePaths(res), 'plan', 2);
    images = att.images;
    if (att.failed.length) attachNote = '\n⚠ 部分图未附:' + att.failed.slice(0, 2).join(' · ');
  }
  const head = 'PLAN ' + op + ' ok · ' + txt.length + ' chars · verdict=' + String(verdict) + attachNote + '\n';
  return {
    text: head + (txt.length > CAP ? txt.slice(0, CAP) + '\n…[已截断,共 ' + txt.length + ' 字符;结构化全量可用 headless(out_json=…) 落盘]' : txt),
    images,
  };
}

// ---------- headless/job 回执 ----------
function clipText(s, head, tail) {
  const t = String(s == null ? '' : s);
  if (t.length <= head + tail) return t;
  return t.slice(0, head) + '\n…[中间省略 ' + (t.length - head - tail) + ' 字符]…\n' + t.slice(-tail);
}
// 结构化回执:人读文本(信封并入文本头,模型可直接读 verdict/resultJson)
function headlessReceipt(res, notes) {
  const r = res || {};
  const rj = (r.resultJson !== undefined) ? r.resultJson : r.result;
  let rjStr = null;
  try { rjStr = (rj === null || rj === undefined) ? null : JSON.stringify(rj); } catch (_) { rjStr = null; }
  const parts = [];
  if (notes && notes.length) for (const n of notes) parts.push(String(n));
  const status = String(r.status || (r.ok === false ? 'fail' : 'done'));
  parts.push('HEADLESS ' + status + (r.exit !== undefined ? ' · exit=' + String(r.exit) : '') + ' · ' + String(r.ms || 0) + 'ms'
    + (r.gpu ? ' · GPU=' + JSON.stringify(r.gpu).slice(0, 120) : ''));
  if (r.stderr && String(r.stderr).trim()) parts.push('stderr: ' + String(r.stderr).trim().slice(0, 1200));
  if (r.stdout) parts.push('stdout(尾):\n' + clipText(String(r.stdout), 400, 1600));
  if (rjStr) parts.push('result: ' + (rjStr.length > 6000 ? rjStr.slice(0, 6000) + '…[已截断]' : rjStr));
  const shots = r.shots || null;
  if (shots && Array.isArray(shots.rows) && shots.rows.length) {
    parts.push('shots: ' + shots.rows.map((x) => String(x.name) + '→' + String(x.path)).slice(0, 8).join(' · '));
  }
  const artifacts = r.artifacts || [];
  if (artifacts.length) parts.push('产物 ' + artifacts.length + ' 项:' + artifacts.slice(0, 10).map((a) => String(a && (a.path || a))).join(' · '));
  return { text: parts.join('\n'), shots };
}
// 等待窗口到点/转后台:回 jobId 回执(不是失败)
function promotedReceipt(job, jobId, why) {
  const j = job || {};
  const lines = [
    why,
    'jobId: ' + String(jobId),
    'status=' + String(j.status || 'running') + (j.stageName ? ' · stage=' + String(j.stageName) : '') + (j.pid ? ' · pid=' + String(j.pid) : ''),
    '跟进:blender_rt_job(op="wait", id="' + String(jobId) + '") 阻塞等结果;op=collect 看进展;op=kill 中止。日志目录:' + String(j.logDir || '(见 outdir/jobs)'),
  ];
  if (j.hint) lines.push(String(j.hint));
  return { text: lines.join('\n') };
}
async function startJobThenMaybeWait(port, body, waitS, signal) {
  const jr = await backendPost(port, '/headless', { ...body, asJob: true }, 60000, signal);
  const lt = leasedText(jr);
  if (lt) return { text: lt };
  if (!jr || jr.error) return { text: 'HEADLESS 转作业层失败 · ' + String((jr && (jr.error || jr.raw)) || 'unknown') };
  const inner = (jr.result && typeof jr.result === 'object') ? jr.result : jr;
  const jobId = String(inner.jobId || (inner.job && inner.job.id) || '');
  const budget = waitS && waitS > 0 ? Math.min(Math.round(waitS * 1000), HEADLESS_WAIT_MS + 2000) : 0;
  if (!budget) return { jobId, job: inner.job || null, finished: false };
  const wr = await backendPost(port, '/job', { op: 'wait', id: jobId, timeoutMs: budget }, budget + 30000, signal);
  const lt2 = leasedText(wr);
  if (lt2) return { text: lt2 };
  const job = (wr && wr.job) || null;
  if (job && job.status && job.status !== 'running') return { jobId, job, finished: true };
  return { jobId, job: job || inner.job || null, finished: false };
}
// 客户端窗口到点:按 runId 查台账,能拿到 jobId 就回 promoted
async function promotedFromTimeout(port, runId, err, signal) {
  try {
    const jr = await backendPost(port, '/job', { op: 'status', id: runId }, 15000, signal);
    const job = (jr && jr.job) || null;
    const jobId = String((job && job.id) || runId);
    return promotedReceipt(job, jobId, '同步等待窗口(' + Math.round(HEADLESS_WAIT_MS / 1000) + 's)到点,任务已后台化(**不是失败**)');
  } catch (_) {
    return { text: 'HEADLESS 等待中断:' + String((err && err.message) || err) + '\nrunId=' + runId + '(结果可能仍在服务端,稍后用 blender_rt_job op=status id=' + runId + ' 回收)' };
  }
}

// ---------- 15 个工具定义(名字/参数与原插件一致,技能包 SOP 直接生效) ----------
const BLENDER_DEFINITIONS = [
  {
    name: 'blender_viewport',
    description: 'Blender 实时通道运维入口:status(健康/版本)、doctor(真跑一次 bpy 往返的三级体检:未连/主线程忙/addon 线程卡死 + 修法)、start/stop/restart(后端进程与 15s 看护)、who/lease/release(写租约;被别人持有时写路由 409,只读 op 豁免)、launch(一键拉起 GUI Blender 并自动装/启用 addon 后 Connect,幂等,约 11s)。Blender 没开时先 launch。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'status | doctor | who | lease | release | start | stop | restart | launch' },
        holder: { type: 'string', description: 'lease/release 的持有者名(默认本会话)' },
        ttl_ms: { type: 'integer', description: 'lease 有效期毫秒,默认 600000' },
        force: { type: 'boolean', description: 'lease 时抢占别人的租约(默认 false)' },
        scope: { type: 'string', description: 'lease 写作用域:collection:COL 或 prefix:LGT-,逗号分隔' },
        wait_ms: { type: 'integer', description: 'launch 等 addon 端口打开的上限,默认 90000' },
        file: { type: 'string', description: 'launch 启动时要打开的 .blend' },
        exe: { type: 'string', description: 'launch 显式指定 blender.exe' },
        addon_module: { type: 'string', description: 'launch 要 enable 的 addon 模块名(逗号分隔)' },
        addon_file: { type: 'string', description: 'launch 按文件 import 的 addon .py 绝对路径' },
        dry_run: { type: 'boolean', description: 'launch 只回报将执行的命令,不真启动' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_see',
    description: '【看视口】约 55–160ms 出一帧:改一步看一眼就用它。GUI 不在或传 session 时自动走持久 worker 的 Workbench 离屏(无头也能同步看)。给 from/look_at(可配 lens/ortho/view_size/shading)走自定义视角:自建矩阵离屏绘制,不建相机、不动用户视口。full=true+area=N 走整窗截图(看 Blender UI 时用)。同画面默认不重复附图,要重发传 force=true。',
    parameters: {
      type: 'object',
      properties: {
        max_size: { type: 'integer', description: '最长边像素,默认 560(420 更快,900 更清晰)' },
        session: { type: 'string', description: '无头 worker 会话名(不走 GUI)' },
        auto: { type: 'boolean', description: 'GUI 不可用时自动降级到无头 see(默认 true)' },
        full: { type: 'boolean', description: '整窗口/区域截图(看 Blender UI 时用);默认 false = 3D 视口离屏帧' },
        area: { type: 'integer', description: 'full=true 时的区域序号,默认 0' },
        from: { type: 'string', description: '自定义视角:相机位置 "x,y,z"(世界坐标)' },
        look_at: { type: 'string', description: '自定义视角:看向的点 "x,y,z"' },
        lens: { type: 'number', description: '焦距 mm,默认 50' },
        ortho: { type: 'boolean', description: '正交投影(配合 ortho_scale)' },
        ortho_scale: { type: 'number', description: '正交尺度(贴长边),默认 10' },
        view_size: { type: 'string', description: '分辨率 "宽x高",如 "1280x720"' },
        shading: { type: 'string', description: '临时切换着色 WIREFRAME/SOLID/MATERIAL/RENDERED(出图后还原)' },
        overlays: { type: 'boolean', description: '临时开关覆盖物(网格/坐标轴),出图后还原' },
        view_mode: { type: 'string', description: 'viewport(默认)/ render(临时相机+Workbench 快渲)' },
        diagnostics: { type: 'boolean', description: '强制跑诊断三项(覆盖率/场景bbox/入镜对象);默认不跑' },
        force: { type: 'boolean', description: '同画面默认不重复附图;传 true 强制重发' },
      },
      required: [],
    },
  },
  {
    name: 'blender_rt_do',
    description: '实时驱动 Blender:在持久内核 K 里执行 Python(或直接跑 .py 文件),可选立刻回一帧视口。只补 plan op 没有的局部编辑;有 plan op 先用 op。GUI 可用时走 addon;传 session 时在持久无头 worker 里 exec+see(GUI 不可达自动降级);每步约 50–150ms。预置 bpy/math/mathutils/Vector 与持久内核 K(K 跨调用保留);异常也回传 partial stdout/stderr/traceback。返回 ms 即主线程占用,>1s 建议改走 blender_rt_headless/worker。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python 代码(与 file 二选一)' },
        file: { type: 'string', description: '要执行的 .py 文件路径(长脚本用这个)' },
        see: { type: 'boolean', description: '是否同时回一帧视口(默认 true)' },
        max_size: { type: 'integer', description: '回帧最长边像素,默认 560' },
        force: { type: 'boolean', description: '回帧与上一帧相同时默认不重复附图;传 true 强制重发' },
        session: { type: 'string', description: '无头交互会话名(复用同一 blender -b)' },
        auto: { type: 'boolean', description: 'GUI 不可用时降级无头 session(默认 true)' },
        preload: { type: 'string', description: '无头 session 预载模块(逗号分隔)' },
        from: { type: 'string', description: '无头 see 相机位置 "x,y,z"' },
        look_at: { type: 'string', description: '无头 see 看向点 "x,y,z"' },
      },
      required: [],
    },
  },
  {
    name: 'blender_rt_watch',
    description: '观察时间窗/帧序列:先跑 code,再采样最多 6 帧+逐帧 hash(判断动画/修改器有没有动);GUI 不可用时自动走无头 worker。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '可选:观察前先执行的 Python' },
        seconds: { type: 'number', description: '观察时长秒,默认 2(0.2-20)' },
        fps: { type: 'number', description: '采样率,默认 4(0.5-8)' },
        max_size: { type: 'integer', description: '帧最长边像素,默认 420' },
        session: { type: 'string', description: '无头 worker 会话(不给则 GUI 失败自动降级)' },
      },
      required: [],
    },
  },
  {
    name: 'blender_rt_cmd',
    description: '直连调用 Blender addon 的任意命令(39 个:24 常驻+15 集成门控),含 get_scene_info/get_world_state_snapshot/get_object_info/get_viewport_screenshot/execute_code/export_scene 及资产类(PolyHaven/Sketchfab/Hyper3D/Hunyuan3D)。仅 GUI addon 在线时可用;纯无头用 rt_worker/rt_headless。参数必须匹配 addon 真实签名(get_scene_info 无参、get_object_info 用 name)。先 blender_rt_commands 看清单。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'addon 命令名,如 get_world_state_snapshot' },
        params: { type: 'object', description: '参数对象(可选),如 {"asset_type":"hdris"}' },
        timeout_ms: { type: 'integer', description: '超时毫秒,默认 120000(下载/生成类可调大)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'blender_rt_commands',
    description: '列出直连通道当前可用的 addon 命令与 5 个集成的真实状态(开关是否打开、是否缺 API key)。调 blender_rt_cmd 之前先用它。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'blender_rt_loop',
    description: '【内环搜索】把"要试几十~几千组参数"的活从模型回合搬进 Blender(160 tick/s,迭代/时间双上限+急停):你只写目标与区间,机器去搜。任务形状:对齐/拟合/反推尺寸/参数扫描——判据能写成一个数(轮廓 IoU、包围盒误差、剖面差或自写 score)。setup 只跑一次,step/measure 共享 ns(measure 必须给 ns["score"]);现成目标函数 K.dsh_measure={silhouette_iou,aabb_err,profile_err}。节奏:op=start→status→board→export。内环收敛后必须换通路复核+rt_see 看一眼(防 Goodhart)。只试 ≤5 组用 rt_do 自己循环更省。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'start | status | stop | board | export | help | bench' },
        target: { type: 'string', description: 'gui(默认)| session(无头 worker 同步阻塞,无头主路径)' },
        session: { type: 'string', description: 'target=session 的 worker 实例名(默认 dsh-loop)' },
        spec: { type: 'object', description: 'op=start 规格:{setup,step,measure,iterations,budget_ms,measure_every,minimize,top_k}' },
        history: { type: 'integer', description: 'op=status 指标尾迹长度,默认 8' },
        board: { type: 'integer', description: 'op=status 同时返回前 N 个候选' },
        limit: { type: 'integer', description: 'op=board 候选条数,默认 10' },
        groups: { type: 'boolean', description: 'op=board 是否含分组候选(默认 true)' },
        path: { type: 'string', description: 'op=export 写出脚本路径,省略=只回文本' },
        top: { type: 'integer', description: 'op=export 变体数量' },
        include_variants: { type: 'boolean', description: 'op=export 是否把候选表一起导出' },
        note: { type: 'string', description: 'op=export 备注' },
        iterations: { type: 'integer', description: 'op=bench 迭代次数' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_perf',
    description: '【渲染性能】Cycles CPU 瓶颈诊断与优化预设。op=analyze 差分实测每轮同步/每采样 GPU 成本;op=apply 应用预设(persistent_data/OptiX 降噪/采样上限);op=revert 还原;op=status 看当前设置。实测:2318 对象场景每轮 CPU 同步≈4.2s,persistent_data 让重复渲染 14.6s→0.79s。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'status | analyze | apply | revert | help' },
        args: { type: 'object', description: 'analyze{pct,low,high};apply{samples,persistent,denoiser,denoise_gpu,auto_tile}' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_opt',
    description: '【对象精简】降 Cycles 每轮场景同步成本(≈1.4ms/对象)。op=analyze 列可安全合并分组与预计节省;op=join 执行合并(默认 dry_run=true 只报告,几何零损失)。合并规则:同集合/同材质/无修改器动画/无形态键。强烈建议 save_before 先存回退点。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'analyze | join | help' },
        args: { type: 'object', description: 'join{dry_run,save_before}' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_headless',
    description: '【无头 Blender · 备用】独立进程跑脚本(blender -b):GUI 不可用/批处理/长活用,不占 GUI 不动场景。Windows 给 Windows 路径。print("HEADLESS " + json.dumps(obj)) 回传结构化结果。默认 factory-startup+EEVEE 前导。>100s 或长渲染用 as_job=true(rt_job 收)。attach_images 回图;shots 多视角;preload 后直调 K.dsh_*_api。产物目录不传时默认工作目录 blender-out/。',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Python 源码(注入 K+bpy)' },
        script_file: { type: 'string', description: '直接跑一个 .py 文件' },
        file: { type: 'string', description: '要打开的 .blend(传 .py 会自动当脚本)' },
        outdir: { type: 'string', description: '产物目录(默认工作目录 blender-out/,显式给路径须在工作目录内)' },
        as_job: { type: 'boolean', description: 'true=立刻后台化成作业(预期 >100s 的活推荐)' },
        wait_s: { type: 'number', description: 'as_job 后最多再等几秒,到点回 jobId' },
        timeout_ms: { type: 'integer', description: '子进程上限,默认 180000(上限 1800000)' },
        engine: { type: 'string', description: 'eevee(默认)| cycles | keep | none' },
        preload: { type: 'string', description: '预载 runtime 模块(逗号分隔)→ K.dsh_*_api' },
        shots: { type: 'object', description: '多视角出图 [{name,from,look_at,lens,res,samples}]' },
        out_json: { type: 'string', description: '结构化结果落盘路径' },
        env: { type: 'object', description: '子进程环境变量' },
        args: { type: 'string', description: '追加到 -- 之后的命令行参数' },
        workdir: { type: 'string', description: '脚本内 chdir + sys.path 首位' },
        factory_startup: { type: 'boolean', description: '默认 true' },
        use_user_config: { type: 'boolean', description: '透传 BLENDER_USER_CONFIG/SCRIPTS' },
        bootstrap: { type: 'boolean', description: '默认 true=注入持久内核 K' },
        gpu: { type: 'string', description: '仅 cycles:auto | true | false' },
        include_noise: { type: 'boolean', description: '产物清单含噪音文件' },
        attach_images: { type: 'object', description: 'shots 附图:true=3 张,"sheet"=拼图' },
        hard_exit: { type: 'boolean', description: 'done 后 os._exit(0) 规避 5.2.3 退出 AV,默认 true' },
      },
      required: [],
    },
  },
  {
    name: 'blender_rt_plan',
    description: '【判定/验收/导出/造型】契约层总入口:33 family / 217 op。有 op 不许自写等价几何/验收。不确定就先 op="catalog"(本地直出目录,含"什么时候用/别用/最小骨架");单族展开 op="catalog" args={family:"audit"};算子细节 <family>_help。常用:audit_* · qc_compare · sculpt_* · fix_* · uv_* · print_report · deliver_* · motion_* · asm_*(装配)· blockout_*(白模)· img_*(参考图量具)· gate_*(验收门)· visualreport_report · shapesolve_solve。写 op 过租约,只读豁免。传 session="auto" 自动起无头 worker 同步执行(不依赖 GUI)。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: '契约 op 或 catalog/help' },
        args: { type: 'object', description: 'op 参数对象,如 {"cid":"joint","err":184,"tolerance":220}' },
        path: { type: 'string', description: 'op=report 输出路径(Markdown)' },
        attach_images: { type: 'boolean', description: '产物图附图回模型(≤2 张)' },
        session: { type: 'string', description: '无头 worker 会话;"auto"=自动起' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_worker',
    description: '【交互式无头热会话】常驻 blender -b 进程:start 拉起/exec 跑代码/see 离屏出一帧(Workbench)/watch 逐帧采样/reset 清场景/status/stop/restart/list。start 可带 preload(把 imgtools/assembly/blockout 等模块注入 K)与 warmup;see 在无 GUI 时就是 AI 的视口,每步 50–100ms。同一 session 场景与 K 跨调用保留;空闲 TTL 15min。串行无窗口:依赖 GUI 的 bpy.ops 可能失败。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'start | exec | see | reset | status | stop | restart | list' },
        name: { type: 'string', description: '实例名(默认 default)' },
        code: { type: 'string', description: 'op=exec 的 Python 源码' },
        timeout_ms: { type: 'integer', description: 'op=exec 响应超时,默认 120000' },
        preload: { type: 'string', description: 'op=start 预载模块(逗号分隔)' },
        warmup: { type: 'boolean', description: 'op=start 预热渲染器(默认 true)' },
        from: { type: 'string', description: 'op=see 相机位置 "x,y,z"' },
        look_at: { type: 'string', description: 'op=see 看向点 "x,y,z"' },
        lens: { type: 'number', description: 'op=see 焦距 mm' },
        ortho: { type: 'boolean', description: 'op=see 正交投影' },
        view_size: { type: 'string', description: 'op=see 分辨率 "宽x高"' },
        gpu: { type: 'string', description: 'op=start GPU 语义(仅 cycles):auto/true/false' },
        engine: { type: 'string', description: 'op=start 渲染引擎:eevee/cycles/workbench/keep' },
        purge_prefix: { type: 'string', description: 'op=exec 前清掉的模块前缀(逗号分隔)' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_txn',
    description: '【事务/回滚】两级快照:文件级 snapshot/restore(整场景回退,写 .blend 副本)+对象级 mark/revert(只记 transform/材质槽/可见性/修改器开关,毫秒级)。拓扑改动前用文件级 snapshot;对象级不含拓扑/UV(Boolean、合并、删面后回不去,revert 会跳过并报告)。restore 默认 into="auto" 载入后回快照出处文件。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'snapshot | restore | list | prune | mark | revert | marks | drop | help' },
        label: { type: 'string', description: '快照/mark 名字' },
        objects: { type: 'string', description: 'mark 时限定对象(逗号分隔;省略=全场景)' },
        keep: { type: 'integer', description: 'prune 只保留最近 N 个,默认 5' },
        note: { type: 'string', description: 'snapshot 备注' },
        into: { type: 'string', description: 'restore 口径:auto(默认)| snapshot(非破坏)| original' },
        backup: { type: 'boolean', description: 'restore 前自动留备份(默认 true)' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_preset',
    description: '【配方库】把"参数组合"变成可保存/套用/分发的资产:save/list/get/apply/delete/export/import。data 用点路径:材质节点 {"inputs.Base Color":[1,0,0,1]}、对象 {"location":[0,0,1]}、场景 {"render.resolution_x":640}。apply 的 targets 用 MAT:材质名/OBJ:对象名/SCENE;不给 targets 只预览。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'save | list | get | apply | delete | export | import | help' },
        name: { type: 'string', description: '配方名' },
        kind: { type: 'string', description: '分类(list 过滤)' },
        tags: { type: 'string', description: '标签(逗号分隔)' },
        note: { type: 'string', description: '备注(save)' },
        data: { type: 'string', description: '点路径 JSON 字符串(save)' },
        targets: { type: 'string', description: 'apply 目标:MAT:名/OBJ:名/SCENE(逗号分隔)' },
        path: { type: 'string', description: 'export/import 路径' },
        names: { type: 'string', description: 'export 选定配方名(逗号分隔)' },
        overwrite: { type: 'boolean', description: 'save/import 覆盖同名(默认 true)' },
      },
      required: ['op'],
    },
  },
  {
    name: 'blender_rt_job',
    description: '【作业层】长活后台化:op=start 立刻回 jobId(不占连接、不会被工具超时掐断);status/collect/**wait**(单次≤600s,别连发 status)/kill/list。与 headless 分工:预期 <100s 用 headless 直接拿结果;更长用 as_job=true 或本工具。run 与 job 同一 id 空间;磁盘台账断电可恢复。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'start | status | collect | wait | kill | list' },
        id: { type: 'string', description: 'job-… 或 headless 的 run-…' },
        script: { type: 'string', description: 'Python 源码' },
        script_file: { type: 'string', description: '直接跑 .py 文件' },
        args: { type: 'string', description: '命令行参数' },
        env: { type: 'object', description: '额外环境变量' },
        file: { type: 'string', description: '要打开的 .blend' },
        outdir: { type: 'string', description: '产物目录(默认工作目录 blender-out/)' },
        timeout_ms: { type: 'integer', description: '作业上限默认 3600000;wait 时是单次等待上限(默认 120000)' },
        engine: { type: 'string', description: 'eevee/cycles/keep' },
        preload: { type: 'string', description: '预载 runtime 模块' },
        factory_startup: { type: 'boolean', description: '默认 true' },
        bootstrap: { type: 'boolean', description: '默认 true' },
        workdir: { type: 'string', description: '脚本内 chdir' },
        include_noise: { type: 'boolean', description: '产物清单含噪音(默认 false)' },
        out_json: { type: 'string', description: '结构化结果落盘路径' },
        tail: { type: 'integer', description: 'collect/wait 的 stdout 尾字符数(默认 4000)' },
      },
      required: ['op'],
    },
  },
];
const TOOL_NAMES = BLENDER_DEFINITIONS.map((d) => d.name);

// ---------- callTool:15 工具执行 ----------
async function callTool(name, args, ctx) {
  const store = ctx && ctx.store;
  const signal = ctx && ctx.signal;
  const c = cfg(store);
  const a = args || {};
  const images = [];
  const ok = await ensureBackend(store);
  const BACKEND_DOWN = '后端不可用(127.0.0.1:' + c.httpPort + ')。可让 AI 调 blender_viewport(op="start"),或在 设置→Agent→Blender 检查配置。';
  if (!ok) return { text: BACKEND_DOWN, images };
  const port = c.httpPort;
  currentHolder = c.holder;

  if (name === 'blender_rt_see') {
    const size = Math.max(120, Math.min(1600, Number(a.max_size || 560)));
    const full = !!a.full;
    const frm = numTriple(a.from);
    const look = numTriple(a.look_at);
    const wantSession = a.session ? String(a.session) : '';
    if (wantSession) {
      const spec = { from: frm || [7, -7, 5], look_at: look || [0, 0, 1], lens: a.lens === undefined ? undefined : Number(a.lens), ortho: a.ortho === undefined ? undefined : !!a.ortho, ortho_scale: a.ortho_scale === undefined ? undefined : Number(a.ortho_scale), shading: a.shading || undefined, width: size, height: Math.max(120, Math.round(size * 9 / 16)) };
      const mm = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(a.view_size || ''));
      if (mm) { spec.width = Number(mm[1]); spec.height = Number(mm[2]); }
      const fb = await seeViaWorker(port, spec, wantSession, signal);
      return fb || { text: '无头 see 失败:worker 会话 ' + wantSession + ' 不可用(先 blender_rt_worker op=start name=' + wantSession + ')', images: [] };
    }
    if (frm || look) {
      const spec = { from: frm || [7, -7, 5], look_at: look || [0, 0, 1], lens: a.lens === undefined ? undefined : Number(a.lens), ortho: a.ortho === undefined ? undefined : !!a.ortho, ortho_scale: a.ortho_scale === undefined ? undefined : Number(a.ortho_scale), shading: a.shading || undefined, overlays: a.overlays === undefined ? undefined : !!a.overlays, mode: a.view_mode || undefined };
      const mm = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(a.view_size || ''));
      if (mm) { spec.width = Number(mm[1]); spec.height = Number(mm[2]); }
      else { spec.width = size; spec.height = Math.max(120, Math.round(size * 9 / 16)); }
      if (a.diagnostics !== undefined) spec.diagnostics = !!a.diagnostics;
      let fv;
      try { fv = await fetchView(port, spec, signal); } catch (e) {
        if (a.auto !== false) {
          const fb = await seeViaWorker(port, spec, a.session, signal);
          if (fb) return fb;
        }
        throw e;
      }
      const dkey = 'view:' + JSON.stringify([spec.width, spec.height, spec.from, spec.look_at, spec.lens || null, !!spec.ortho, spec.ortho_scale || null, spec.shading || null, spec.overlays === undefined ? null : !!spec.overlays, spec.mode || null]);
      const dd = frameDedupe(dkey, fv.hash, !!a.force);
      const mt = fv.meta || {};
      let text = '自定义视角 ' + String(mt.mode || spec.mode || 'viewport') + ' · ' + spec.width + 'x' + spec.height + ' · ' + fv.ms + 'ms · ' + fv.png.length + 'B · hash ' + fv.hash
        + ' · from ' + JSON.stringify(spec.from) + ' → look_at ' + JSON.stringify(spec.look_at)
        + (mt.coverage_estimate === undefined || mt.coverage_estimate === null ? '' : ' · 覆盖 ' + (Number(mt.coverage_estimate) * 100).toFixed(2) + '%')
        + ' · 场景与用户视口均未改动';
      if (mt.warning && mt.warning.code === 'frame_looks_empty') {
        const w = mt.warning;
        text += '\n⚠ frame_looks_empty:' + String(w.why || '画面里几乎只剩底色')
          + (w.suggest ? '\n  建议照这组再出一次:from=' + JSON.stringify(w.suggest.from) + ' look_at=' + JSON.stringify(w.suggest.look_at) : '');
      }
      if (dd.dup) text += dedupeNote(dd.repeats);
      else { const img = pngResult(fv.png); if (img) images.push(img); }
      return { text, images };
    }
    let f;
    try { f = await fetchFrame(port, size, signal, full, Number(a.area || 0)); } catch (e) {
      if (a.auto !== false) {
        const fb = await seeViaWorker(port, { from: [7, -7, 5], look_at: [0, 0, 1], width: size, height: Math.max(120, Math.round(size * 9 / 16)) }, a.session, signal);
        if (fb) return fb;
      }
      throw e;
    }
    const dd = frameDedupe(full ? ('area:' + String(a.area || 0)) : ('viewport:' + String(size)), f.hash, !!a.force);
    let text = (full ? '区域截图(screenshot_area)· ' : '视口帧 ' + size + 'px · ') + f.ms + 'ms · ' + f.png.length + 'B · hash ' + f.hash;
    if (dd.dup) text += dedupeNote(dd.repeats);
    else { const img = pngResult(f.png); if (img) images.push(img); }
    return { text, images };
  }

  if (name === 'blender_rt_do') {
    const code = String(a.code || '');
    const file = a.file ? String(a.file) : null;
    if (!code && !file) return { text: '需要 code 或 file 之一', images: [] };
    const sessOpts = { code, file, session: a.session, preload: a.preload, see: a.see !== false, max_size: a.max_size, from: a.from, look_at: a.look_at, view_size: a.view_size };
    if (a.session) {
      const s = await doViaSession(port, sessOpts, signal);
      return s || { text: '无头交互会话失败:worker 不可用(先 blender_rt_worker op=start name=' + String(a.session) + ')', images: [] };
    }
    const body = { code };
    if (file) body.file = file;
    let r = null;
    try { r = await backendPost(port, '/act', body, 180000, signal); } catch (e) {
      if (a.auto !== false) {
        const s = await doViaSession(port, sessOpts, signal);
        if (s) return s;
      }
      throw e;
    }
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (r && r.ok === false && a.auto !== false) {
      const s = await doViaSession(port, sessOpts, signal);
      if (s) return s;
    }
    const parts = [];
    parts.push(r && r.ok ? 'ACT ok · ' + String(r.ms) + 'ms' : 'ACT 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'));
    if (r && Number(r.mainThreadMs) > 1000) parts.push('⚠️ 占用 Blender 主线程约 ' + r.mainThreadMs + 'ms —— 超过 ~1s 的重活建议改走 blender_rt_headless / blender_rt_worker');
    if (r && r.stderr && String(r.stderr).trim()) parts.push('stderr: ' + String(r.stderr).trim().slice(0, 1200));
    if (r && r.traceback) parts.push('--- traceback ---\n' + String(r.traceback).slice(0, 2000));
    if (r && r.stdout) parts.push('stdout: ' + String(r.stdout).trim().slice(0, 3000));
    if (a.see !== false) {
      try {
        const size = Math.max(120, Math.min(1600, Number(a.max_size || 560)));
        const f = await fetchFrame(port, size, signal);
        const dd = frameDedupe('do-see:' + String(size), f.hash, !!a.force);
        if (dd.dup) parts.push('SEE ' + size + 'px · ' + f.ms + 'ms · hash ' + f.hash + dedupeNote(dd.repeats));
        else {
          const img = pngResult(f.png);
          if (img) images.push(img);
          parts.push('SEE ' + size + 'px · ' + f.ms + 'ms · hash ' + f.hash);
        }
      } catch (e) { parts.push('SEE 失败: ' + String((e && e.message) || e)); }
    }
    return { text: parts.join('\n'), images };
  }

  if (name === 'blender_rt_watch') {
    const seconds = Math.max(0.2, Math.min(20, Number(a.seconds || 2)));
    const fps = Math.max(0.5, Math.min(8, Number(a.fps || 4)));
    const size = Math.max(120, Math.min(1600, Number(a.max_size || 420)));
    const parts = [];
    if (a.session) return await watchViaWorker(port, a, String(a.session), signal);
    if (a.code) {
      const r = await backendPost(port, '/act', { code: String(a.code) }, 180000, signal);
      const lt = leasedText(r);
      parts.push(lt ? lt : (r && r.ok ? 'ACT ok · ' + String(r.ms) + 'ms' + (r.stdout ? ' · stdout: ' + String(r.stdout).trim().slice(0, 600) : '') : 'ACT 失败 · ' + String((r && (r.error || r.raw)) || '')));
    }
    const total = Math.max(1, Math.min(32, Math.round(seconds * fps)));
    const interval = (seconds * 1000) / total;
    const shots = [];
    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      try {
        const f = await fetchFrame(port, size, signal);
        shots.push({ t: Date.now() - t0, ms: f.ms, hash: f.hash, png: f.png });
      } catch (_) { shots.push({ t: Date.now() - t0, ms: -1, hash: 'ERR', png: null }); }
      const wait = (i + 1) * interval - (Date.now() - t0);
      if (wait > 1) await sleep(wait);
    }
    if (shots.length && shots.every((s) => s.hash === 'ERR')) {
      const fb = await watchViaWorker(port, a, undefined, signal);
      if (fb && fb.text) return fb;
    }
    const hashes = shots.map((s) => s.hash);
    const distinct = Array.from(new Set(hashes)).length;
    const avgMs = Math.round(shots.reduce((acc, s) => acc + Math.max(0, s.ms), 0) / Math.max(1, shots.length));
    parts.push('WATCH ' + seconds + 's @' + fps + 'fps → ' + shots.length + ' 帧 · 平均 ' + avgMs + 'ms/帧 · 不同画面 ' + distinct + '/' + hashes.length);
    parts.push('timeline: ' + shots.map((s, i) => i + '@' + s.t + 'ms:' + s.hash).join(' '));
    const picks = [];
    const maxImages = 6;
    if (shots.length <= maxImages) { for (const s of shots) if (s.png) picks.push(s); }
    else { for (let k = 0; k < maxImages; k++) { const idx = Math.round((k * (shots.length - 1)) / (maxImages - 1)); if (shots[idx] && shots[idx].png) picks.push(shots[idx]); } }
    for (const p of picks) { const img = pngResult(p.png); if (img) images.push(img); }
    parts.push('附帧:' + images.length + ' 张(均匀抽取)');
    return { text: parts.join('\n'), images };
  }

  if (name === 'blender_rt_cmd') {
    const nm = String(a.name || '');
    if (!nm) return { text: 'blender_rt_cmd 需要 name 参数', images: [] };
    const r = await backendPost(port, '/cmd', { name: nm, params: (a.params && typeof a.params === 'object') ? a.params : {}, timeoutMs: Number(a.timeout_ms || 120000) }, 300000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'CMD ' + nm + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    const payload = JSON.stringify(r.result);
    return { text: 'CMD ' + nm + ' ok · ' + String(r.ms) + 'ms\n' + (payload.length > 3000 ? payload.slice(0, 3000) + '\n…(已截断)' : payload), images: [] };
  }

  if (name === 'blender_rt_commands') {
    const r = await backendJson(port, '/commands', 120000, signal);
    if (!r || r.ok !== true) return { text: 'COMMANDS 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    const lines = [];
    lines.push('场景 ' + String(r.scene) + (r.file ? ' · 文件 ' + String(r.file) : ' · 未保存文件'));
    lines.push('可用命令 ' + String(r.total) + ' 条;被集成开关挡住 ' + String((r.disabled || []).length) + ' 条');
    lines.push('集成:' + Object.keys(r.integrations || {}).map((k) => k + '=' + (r.integrations[k].enabled ? 'on' : 'off')).join(' · '));
    for (const k of Object.keys(r.integrations || {})) {
      const it = r.integrations[k];
      if (!it.enabled && it.message) lines.push('  [' + k + '] ' + String(it.message));
    }
    if ((r.disabled || []).length) lines.push('被挡住:' + r.disabled.join(', '));
    lines.push('可用:' + (r.available || []).join(', '));
    return { text: lines.join('\n'), images: [] };
  }

  if (name === 'blender_rt_loop') {
    const op = String(a.op || 'status');
    const target = String(a.target || 'gui');
    if (target === 'session') {
      const nm = String(a.session || 'dsh-loop');
      const st = await backendPost(port, '/worker', { op: 'start', name: nm, preload: 'runner', engine: 'workbench', warmup: true, isolated: true }, 120000, signal);
      if (!st || st.ok !== true) return { text: 'LOOP session 启动失败 · ' + String((st && (st.error || st.raw)) || 'unknown'), images: [] };
      const specJ = JSON.stringify(JSON.stringify((a.spec && typeof a.spec === 'object') ? a.spec : {}));
      const code = op === 'start'
        ? 'import json as _json\n_s = _json.loads(' + specJ + ')\n_r = K.dsh_loop_api["sync"](_s)\nprint("HEADLESS " + (_r if isinstance(_r, str) else _json.dumps(_r, ensure_ascii=False)))'
        : op === 'status'
          ? 'print("HEADLESS " + K.dsh_loop_api["status"](' + String(Number(a.history || 8)) + ', ' + String(Number(a.board || 0)) + '))'
          : op === 'board'
            ? 'print("HEADLESS " + K.dsh_loop_api["board"](' + String(Number(a.limit || 10)) + ', ' + (a.groups === false ? 'False' : 'True') + '))'
            : op === 'export'
              ? 'print("HEADLESS " + K.dsh_loop_api["export"](' + JSON.stringify(a.path ? String(a.path) : null) + ', ' + String(Number(a.top || 1)) + ', ' + (a.include_variants ? 'True' : 'False') + ', ' + JSON.stringify(String(a.note || '')) + '))'
              : op === 'stop' ? 'print("HEADLESS " + K.dsh_loop_api["stop"]())'
                : op === 'bench' ? 'print("HEADLESS " + K.dsh_loop_api["bench"](' + String(Number(a.iterations || 5000)) + '))'
                  : 'print("HEADLESS " + K.dsh_loop_api["help"]())';
      const r = await backendPost(port, '/worker', { op: 'exec', name: nm, code, isolated: true }, 300000, signal);
      const rr = (r && r.result) || {};
      if (!r || r.ok !== true) return { text: 'LOOP session 失败 · ' + String((r && (r.error || rr.error)) || 'unknown') + (rr.traceback ? '\n' + String(rr.traceback).slice(-1500) : ''), images: [] };
      return { text: 'LOOP ' + op + ' (session=' + nm + ') ok · ' + JSON.stringify(rr.result || rr).slice(0, 6000), images: [] };
    }
    const payload = { op, spec: (a.spec && typeof a.spec === 'object') ? a.spec : {}, history: a.history || 8, board: a.board || 0, limit: a.limit || 10, groups: a.groups !== false, path: a.path, top: a.top || 1, include_variants: !!a.include_variants, note: String(a.note || ''), iterations: a.iterations || 5000 };
    const r = await backendPost(port, '/loop', payload, 300000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'LOOP ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    return { text: 'LOOP ' + op + ' ' + JSON.stringify(r.result), images: [] };
  }

  if (name === 'blender_rt_perf') {
    const op = String(a.op || 'status');
    const pargs = jsonPayload(a.args);
    const r = await backendPost(port, '/perf', { op, args: Object.keys(pargs).length ? pargs : undefined }, 600000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'PERF ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    return { text: 'PERF ' + op + ' ' + JSON.stringify(r.result), images: [] };
  }

  if (name === 'blender_rt_opt') {
    const op = String(a.op || 'analyze');
    const oargs = jsonPayload(a.args);
    const r = await backendPost(port, '/opt', { op: op === 'join' ? 'opt_join' : 'opt_analyze', args: Object.keys(oargs).length ? oargs : undefined }, 600000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'OPT ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    return { text: 'OPT ' + op + ' ' + JSON.stringify(r.result), images: [] };
  }

  if (name === 'blender_rt_headless') {
    const runId = 'run-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const asJob = !!a.as_job;
    const waitS = (a.wait_s !== undefined && a.wait_s !== null && a.wait_s !== '') ? Number(a.wait_s) : null;
    const outdir = await resolveOutdir(a.outdir, ctx);
    const body = {
      script: String(a.script || ''),
      file: (a.file === undefined || a.file === null) ? undefined : String(a.file),
      outdir,
      timeoutMs: a.timeout_ms ? Number(a.timeout_ms) : undefined,
      factoryStartup: a.factory_startup !== false,
      bootstrap: a.bootstrap !== false,
      preload: a.preload || undefined,
      gpu: a.gpu || undefined,
      engine: a.engine || undefined,
      useUserConfig: !!a.use_user_config,
      includeNoise: !!a.include_noise,
      workdir: a.workdir || undefined,
      scriptFile: a.script_file || undefined,
      env: (a.env && typeof a.env === 'object') ? a.env : undefined,
      outJson: a.out_json || undefined,
      shots: (a.shots && typeof a.shots === 'object') ? a.shots : undefined,
      hardExit: (typeof a.hard_exit === 'boolean') ? a.hard_exit : undefined,
      runId,
    };
    if (a.args) body.args = splitArgs(a.args);
    audit(store, { action: 'headless', outdir, file: body.file || null, asJob });
    const serverBudget = 60000 + Number(body.timeoutMs || 180000);
    if (asJob) {
      const r2 = await startJobThenMaybeWait(port, body, waitS, signal);
      if (r2.text) return { text: r2.text, images: [] };
      if (r2.finished && r2.job) {
        const rec = headlessReceipt(r2.job, ['已后台化并在等待窗口内完成 —— 这就是完整结果,不必再 collect']);
        return { text: rec.text, images: [] };
      }
      return { text: promotedReceipt(r2.job, r2.jobId, 'as_job=true:已后台化,等待窗口内没跑完(**不是失败**)').text, images: [] };
    }
    let res = null;
    try { res = await backendPost(port, '/headless', body, Math.min(serverBudget, HEADLESS_WAIT_MS + 2000), signal); } catch (e) {
      if (signal && signal.aborted) throw e;
      const p = await promotedFromTimeout(port, runId, e, signal);
      return { text: p.text, images: [] };
    }
    const lt = leasedText(res);
    if (lt) return { text: lt, images: [] };
    if (!res || res.error) return { text: 'HEADLESS 失败 · ' + String((res && (res.error || res.raw)) || 'unknown') + (res && res.hint ? '\n' + String(res.hint) : ''), images: [] };
    const bodyRes = (res && res.result && typeof res.result === 'object') ? res.result : null;
    if (!bodyRes || (!bodyRes.status && bodyRes.result === undefined && bodyRes.resultJson === undefined && !bodyRes.shots)) {
      const keys = Object.keys(res || {}).filter((k) => k.indexOf('__') !== 0);
      return { text: 'HEADLESS 结果缺字段(不是"失败")· 后端回的键:' + (keys.length ? keys.join(', ') : '(空)') + '\n跟进:blender_viewport(op="status") 看 runs 台账;预期日志:' + outdir + '\\dsh_headless_*.stdout.log', images: [] };
    }
    const out = headlessReceipt(bodyRes, []);
    const beats = Number((res && res.__heartbeats) || 0);
    let text = out.text;
    if (beats > 0) text += '\n(本次耗时 > 15s,后端走了流式回执:' + beats + ' 条心跳后收到结果)';
    if (a.attach_images) {
      const rows = (bodyRes.shots && bodyRes.shots.rows) || [];
      const paths = rows.map((x) => x && x.path).filter(Boolean);
      const wantSheet = String(a.attach_images) === 'sheet';
      const picked = wantSheet ? paths.filter((p) => /sheet|montage/i.test(p)).slice(0, 1) : paths.filter((p) => !/sheet|montage/i.test(p)).slice(0, 3);
      const att = attachPaths(picked, 'headless-shot', 3);
      if (att.images.length) for (const img of att.images) images.push(img);
      else text += '\n(attach_images 已开,但没有可附的图;看 shots 路径)';
    }
    return { text, images };
  }

  if (name === 'blender_rt_plan') {
    const op = String(a.op || 'status');
    const payload = jsonPayload(a.args);
    if (!Object.keys(payload).length && a.args && typeof a.args === 'string' && a.args.trim() && a.args.trim() !== '{}') {
      return { text: 'PLAN ' + op + ' 失败 · args 不是合法 JSON 对象:' + String(a.args).slice(0, 200), images: [] };
    }
    if (op === 'report' && a.path) payload.path = String(a.path);
    const sessRaw = a.session ? String(a.session) : '';
    if (sessRaw) {
      const pr = await planViaWorker(port, op, payload, sessRaw === 'auto' ? undefined : sessRaw, signal);
      if (!pr || pr.ok !== true) {
        return { text: 'PLAN ' + op + ' 无头执行失败 · ' + String((pr && pr.error) || 'unknown') + (pr && pr.hint ? '\n' + pr.hint : '') + '\n提示:先 blender_rt_worker(op="start", name="…", preload="…"),或传 session="auto"', images: [] };
      }
      return await finishPlanResponse(op, pr.res, a);
    }
    const r = await backendPost(port, '/plan', { op, args: payload }, 300000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'PLAN ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    return await finishPlanResponse(op, r.result, a);
  }

  if (name === 'blender_rt_worker') {
    const op = String(a.op || 'status');
    const body = { op, isolated: true };
    if (a.code !== undefined) body.code = String(a.code);
    if (a.timeout_ms) body.timeoutMs = Number(a.timeout_ms);
    if (a.gpu) body.gpu = String(a.gpu);
    if (a.engine) body.engine = String(a.engine);
    if (a.preload) body.preload = String(a.preload);
    if (a.warmup !== undefined) body.warmup = !!a.warmup;
    if (a.purge_prefix) body.purgePrefix = String(a.purge_prefix);
    if (a.name) body.name = String(a.name);
    if (op === 'see') {
      const mm = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(a.view_size || '560x315'));
      body.spec = {
        from: numTriple(a.from) || [7, -7, 5],
        look_at: numTriple(a.look_at) || [0, 0, 1],
        lens: a.lens !== undefined ? Number(a.lens) : undefined,
        ortho: a.ortho !== undefined ? !!a.ortho : undefined,
        ortho_scale: a.ortho_scale !== undefined ? Number(a.ortho_scale) : undefined,
        shading: a.shading || undefined,
        width: mm ? Number(mm[1]) : 560,
        height: mm ? Number(mm[2]) : 315,
      };
    }
    const budget = 60000 + Number(body.timeoutMs || 120000);
    const r = await backendPost(port, '/worker', body, budget, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) {
      const rr = (r && r.result) || {};
      const bits = ['WORKER ' + op + ' 失败 · ' + String((r && (r.error || rr.error)) || 'unknown')];
      if (rr.traceback) bits.push('--- traceback ---\n' + String(rr.traceback).slice(0, 2000));
      if (rr.stderr && String(rr.stderr).trim()) bits.push('stderr: ' + String(rr.stderr).trim().slice(0, 1200));
      if (r && r.hint) bits.push(String(r.hint));
      return { text: bits.join('\n'), images: [] };
    }
    const res = (r && r.result) || {};
    if (op === 'see') {
      if (res.ok === false) return { text: 'WORKER see 失败 · ' + String(res.error || 'unknown') + (res.traceback ? '\n' + String(res.traceback).slice(-1200) : ''), images: [] };
      let data = null;
      if (res.png_b64) { try { data = Buffer.from(String(res.png_b64), 'base64'); } catch (_) { data = null; } }
      if (!data && res.path) data = readLocalPng(res.path);
      const text = 'WORKER see ok · ' + String(res.ms) + 'ms · ' + String(res.width) + 'x' + String(res.height) + ' · ' + String(res.bytes || 0) + 'B · ' + String(res.mode || 'workbench');
      const img = data ? pngResult(data) : null;
      if (img) images.push(img);
      return { text: img ? text : text + '\n⚠ 图片未回传', images };
    }
    if (op === 'reset') return { text: 'WORKER reset ' + (res.ok ? 'ok' : '失败') + ' · objects=' + String(res.objects), images: [] };
    if (op === 'exec') {
      const parts = [(res.ok ? 'WORKER exec ok' : 'WORKER exec 失败') + ' · ' + String(res.ms) + 'ms'];
      if (res.result) parts.push('result: ' + JSON.stringify(res.result).slice(0, 2000));
      if (res.error) parts.push('error: ' + String(res.error));
      if (res.stdout && String(res.stdout).trim()) parts.push('--- stdout ---\n' + String(res.stdout).slice(-2500));
      if (res.stderr && String(res.stderr).trim()) parts.push('--- stderr ---\n' + String(res.stderr).slice(-1200));
      if (res.traceback) parts.push('--- traceback ---\n' + String(res.traceback).slice(0, 1500));
      return { text: parts.join('\n'), images: [] };
    }
    if (op === 'list') {
      const ws = (res && res.workers) || [];
      const lines = ws.length
        ? ws.map((w) => '- ' + String(w.name) + (w.alive ? (w.ready ? ' · 热(pid ' + String(w.pid) + ',端口 ' + String(w.port) + ')' : ' · 进程在但未就绪') : ' · 未启动'))
        : ['- (还没有任何 worker 实例;op=start 起一个)'];
      return { text: 'WORKER list ok · ' + ws.length + ' 个实例\n' + lines.join('\n'), images: [] };
    }
    const parts = ['WORKER ' + op + ' ok · ' + JSON.stringify({ name: res.name, alive: res.alive, ready: res.ready, pid: res.pid, port: res.port, uptimeMs: res.uptimeMs })];
    if (res.gpu) parts.push('GPU:' + (res.gpu.fell_back_to_cpu ? '⚠️ 回落 CPU' : '✅ ' + String((res.gpu.after || {}).device_type || '')));
    if (res.status) parts.push('status: ' + JSON.stringify(res.status));
    if (res.lastError) parts.push('lastError: ' + String(res.lastError));
    return { text: parts.join('\n'), images: [] };
  }

  if (name === 'blender_rt_txn') {
    const op = String(a.op || 'list');
    const ta = {};
    if (a.label) ta.label = String(a.label);
    if (a.note) ta.note = String(a.note);
    if (a.keep) ta.keep = Number(a.keep);
    if (a.into) ta.into = String(a.into);
    if (typeof a.backup === 'boolean') ta.backup = a.backup;
    if (a.objects) ta.objects = String(a.objects).split(',').map((s) => s.trim()).filter(Boolean);
    const r = await backendPost(port, '/txn', { op, args: ta }, 300000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'TXN ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    const res = (r && r.result) || {};
    const parts = ['TXN ' + op + ' ok'];
    if (op === 'snapshot' && res.snapshot) parts.push('快照 ' + String(res.snapshot.label) + ' · ' + String(res.snapshot.bytes) + 'B · ' + String(res.snapshot.ms) + 'ms · ' + String(res.snapshot.objects) + ' 对象\n路径:' + String(res.snapshot.path));
    else if (op === 'restore') parts.push('已恢复:' + JSON.stringify(res.restored || {}).slice(0, 200) + '\n' + String(res.warning || ''));
    else if (op === 'list') {
      parts.push('快照 ' + String((res.snapshots || []).length) + ' 个:' + (res.snapshots || []).map((s) => s.label + '(' + s.bytes + 'B)').join(' · '));
      parts.push('mark:' + JSON.stringify(res.marks || []));
    }
    else if (op === 'mark') parts.push('已记 mark ' + String(res.mark) + ' · ' + String(res.objects) + ' 个对象');
    else if (op === 'revert') parts.push('回滚 ' + String(res.reverted) + ':改了 ' + String(res.changed_count) + ' 个' + (res.blocked && res.blocked.length ? ' · 跳过 ' + JSON.stringify(res.blocked).slice(0, 200) : ''));
    else parts.push(JSON.stringify(res).slice(0, 800));
    return { text: parts.join('\n'), images: [] };
  }

  if (name === 'blender_rt_preset') {
    const op = String(a.op || 'list');
    const pa = {};
    if (a.name) pa.name = String(a.name);
    if (a.kind) pa.kind = String(a.kind);
    if (a.note) pa.note = String(a.note);
    if (a.path) pa.path = String(a.path);
    if (a.tags) pa.tags = String(a.tags).split(',').map((x) => x.trim()).filter(Boolean);
    if (a.names) pa.names = String(a.names).split(',').map((x) => x.trim()).filter(Boolean);
    if (a.targets) pa.targets = String(a.targets).split(',').map((x) => x.trim()).filter(Boolean);
    if (a.data) {
      try { pa.data = JSON.parse(String(a.data)); } catch (e) { return { text: 'data 不是合法 JSON: ' + String(e.message).slice(0, 120), images: [] }; }
    }
    if (a.overwrite === false) pa.overwrite = false;
    const r = await backendPost(port, '/preset', { op, args: pa }, 300000, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'PRESET ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    const res = (r && r.result) || {};
    const parts = ['PRESET ' + op + ' ok'];
    if (op === 'list') {
      parts.push('共 ' + String(res.count) + ' 个:' + (res.presets || []).map((p) => p.name + '(' + p.kind + ')').join(' · '));
      parts.push('目录:' + String(res.dir || ''));
    } else if (op === 'apply') {
      const rr = res.report || {};
      parts.push('配方 ' + String(res.preset) + ' · 目标 ' + JSON.stringify(res.targets) + ' · 写入 ' + String((rr.applied || []).length) + ' 项');
      if ((rr.skipped || []).length) parts.push('跳过:' + JSON.stringify(rr.skipped).slice(0, 300));
      if ((rr.errors || []).length) parts.push('错误:' + JSON.stringify(rr.errors).slice(0, 300));
    } else parts.push(JSON.stringify(res).slice(0, 900));
    return { text: parts.join('\n'), images: [] };
  }

  if (name === 'blender_rt_job') {
    const op = String(a.op || 'list');
    const body = { op };
    if (a.id) body.id = String(a.id);
    if (a.script !== undefined) body.script = String(a.script);
    if (a.script_file) body.scriptFile = String(a.script_file);
    if (a.args) body.args = splitArgs(a.args);
    if (a.env && typeof a.env === 'object') body.env = a.env;
    if (a.file) body.file = String(a.file);
    if (a.outdir !== undefined) body.outdir = await resolveOutdir(a.outdir, ctx);
    if (a.engine) body.engine = String(a.engine);
    if (a.preload) body.preload = String(a.preload);
    if (a.workdir) body.workdir = String(a.workdir);
    if (a.out_json) body.outJson = String(a.out_json);
    if (a.include_noise !== undefined) body.includeNoise = !!a.include_noise;
    if (a.factory_startup !== undefined) body.factoryStartup = !!a.factory_startup;
    if (a.bootstrap !== undefined) body.bootstrap = !!a.bootstrap;
    if (a.tail) body.tail = Number(a.tail);
    if (a.timeout_ms) body.timeoutMs = Number(a.timeout_ms);
    audit(store, { action: 'job', op, outdir: body.outdir || null });
    const budget = op === 'wait' ? Math.min(600000, Number(a.timeout_ms) || 120000) + 30000 : 60000;
    const r = await backendPost(port, '/job', body, budget, signal);
    const lt = leasedText(r);
    if (lt) return { text: lt, images: [] };
    if (!r || r.ok !== true) return { text: 'JOB ' + op + ' 失败 · ' + String((r && (r.error || r.raw)) || 'unknown'), images: [] };
    if (op === 'list') {
      const js = (r && r.jobs) || [];
      if (!js.length) return { text: '没有作业', images: [] };
      return { text: '作业(' + js.length + '):\n' + js.map((j) => '  ' + String(j.id) + ' · ' + String(j.status) + (typeof j.ms === 'number' ? ' · ' + String(Math.round(j.ms / 1000)) + 's' : '') + ' · 产物 ' + String((j.artifacts || []).length) + ' 项').join('\n'), images: [] };
    }
    const j = (r && r.job) || {};
    if (op === 'start') return { text: promotedReceipt(j, String(j.id), 'op=start 已接受(pid ' + String(j.pid) + ')').text, images: [] };
    if (op === 'kill') {
      const t = (j.alreadyFinished || j.status === 'unknown')
        ? 'JOB kill · ' + String(j.id) + ' · ' + String(j.status) + '(' + String(j.note || '已结束/不存在') + ')'
        : 'JOB kill · ' + String(j.id) + ' · status=' + String(j.status) + '(已发 SIGKILL)';
      return { text: t, images: [] };
    }
    if (j.recovered) {
      return { text: 'JOB ' + op + ' · ' + String(j.id || '') + ' · status=' + String(j.status) + '\n(已完成 · 磁盘产物对账 recovered)\n' + String(j.hint || ''), images: [] };
    }
    if (j.status === 'stale' || j.fromLedger) {
      return { text: 'JOB ' + op + ' · ' + String(j.id || '') + ' · status=' + String(j.status) + '\n(磁盘台账记录)' + String(j.staleReason || '') + '\n' + String(j.hint || ''), images: [] };
    }
    if (op === 'collect' && j.status === 'running') {
      return { text: promotedReceipt(j, String(j.id), 'op=collect:任务还在跑(stage=' + String(j.stageName || j.stage || '-') + ',最近输出 ' + String(Math.round(Number(j.idleMs || 0) / 1000)) + 's 前)—— 不是失败').text, images: [] };
    }
    if (op === 'wait' && j.waitTimedOut) {
      return { text: promotedReceipt(j, String(j.id), 'op=wait:等待窗口(' + String(Math.round(Number(j.waitedMs || 0) / 1000)) + 's)到点,任务仍在跑').text, images: [] };
    }
    const notes = [];
    if (op === 'wait') notes.push('op=wait 等到终态(等了 ' + String(Math.round(Number(j.waitedMs || 0) / 1000)) + 's)');
    if (String(j.id || '').indexOf('run-') === 0) notes.push('这是 blender_rt_headless 的运行台账(run 与 job 同一 id 空间)');
    const rec = headlessReceipt(j, notes);
    return { text: rec.text, images: [] };
  }

  if (name === 'blender_viewport') {
    const op = String(a.op || 'status');
    if (op === 'start') {
      paused = false;
      if (await probe(port, 800)) return { text: '后端已在运行:' + base(port) + '/(看护已启用)', images: [] };
      const how = await startBackend(store);
      for (let i = 0; i < 50; i++) { if (await probe(port, 300)) return { text: '后端已启动(' + how + '):' + base(port) + '/', images: [] }; await sleep(300); }
      return { text: '启动失败:' + how + '(15s 内 /health 仍不通;可 op=restart 清残留,或检查 server.mjs 与配置)', images: [] };
    }
    if (op === 'restart') {
      paused = false;
      const killed = await stopBackend(store, 'restart').catch(() => '');
      paused = false;
      await sleep(400);
      const how2 = await startBackend(store);
      for (let i = 0; i < 50; i++) { if (await probe(port, 300)) return { text: '后端已重启(' + how2 + (killed ? ',清除了旧进程' : '') + '):' + base(port) + '/', images: [] }; await sleep(300); }
      return { text: '重启失败:' + how2 + '(15s 内 /health 仍不通)', images: [] };
    }
    if (op === 'stop') {
      const msg = await stopBackend(store, 'user');
      return { text: msg + '(看护已暂停,op=start 恢复)', images: [] };
    }
    if (op === 'who' || op === 'lease' || op === 'release') {
      try {
        if (op === 'who') {
          const w = await backendJson(port, '/who', 15000, signal);
          const lz = (w && w.lease) || {};
          const m = (w && w.metrics) || {};
          return { text: [
            '租约:' + (lz.active ? ('持有者 ' + String(lz.holder) + '(剩余 ' + String(Math.round(Number(lz.expiresInMs || 0) / 1000)) + 's)') : '空闲(谁都能写)'),
            '本会话 holder:' + c.holder + (lz.active && lz.holder === c.holder ? '(就是本会话)' : ''),
            '通道:calls=' + String(m.calls || 0) + ' errors=' + String(m.errors || 0) + ' lastCmd=' + String(m.lastCmd || '-'),
          ].join('\n'), images: [] };
        }
        const body = { holder: String(a.holder || c.holder) };
        if (a.ttl_ms) body.ttlMs = Number(a.ttl_ms);
        if (op === 'lease' && a.force) body.force = true;
        if (op === 'lease' && a.scope) body.scope = String(a.scope);
        const r = await backendPost(port, op === 'lease' ? '/lease' : '/release', body, 20000, signal);
        if (op === 'lease' && r && r.error === 'leased') {
          return { text: '租约被占用:holder=' + String(r.holder) + ',剩余 ' + String(Math.round(Number(r.expiresInMs || 0) / 1000)) + 's\n' + String(r.hint || '') + '\n(要强抢再加 force=true)', images: [] };
        }
        return { text: (op === 'lease' ? 'LEASE ' : 'RELEASE ') + JSON.stringify(r), images: [] };
      } catch (e) {
        return { text: op + ' 失败:' + String((e && e.message) || e) + '(后端没起?blender_viewport op=start)', images: [] };
      }
    }
    if (op === 'launch') {
      try {
        // 默认只启用本插件模块:后端的自动扫描会把名字带 mcp 的模块一起启用(如 MCP for Blender)→ 抢 9876
        const body = { waitMs: Number(a.wait_ms || 90000), addonFile: addonFile(), addonModule: String(a.addon_module || 'dsh_blender_bridge') };
        if (a.file) body.file = String(a.file);
        if (a.exe) body.exe = String(a.exe);
        else { const exe = resolveBlenderExe(store); if (exe) body.exe = exe; }
        if (a.addon_module) body.addonModule = String(a.addon_module);
        if (a.addon_file) body.addonFile = String(a.addon_file);
        if (a.dry_run) body.dryRun = true;
        audit(store, { action: 'launch', exe: body.exe || null });
        const r = await backendPost(port, '/launch', body, Math.max(30000, Number(a.wait_ms || 90000) + 30000), signal);
        const lines = [];
        lines.push((r && r.ok ? 'LAUNCH ok' : 'LAUNCH 未成功')
          + (r && r.already ? ' · 已经在监听(幂等,未重复启动)' : (r && r.dryRun ? ' · dryRun(没启动)' : ''))
          + (r && r.launched ? ' · 已 spawn pid=' + String(r.pid) : '')
          + ' · addon 端口 ' + String((r && r.addonPort) || '-'));
        if (r && r.exe) lines.push('blender.exe:' + String(r.exe));
        if (r && r.error) lines.push('错误:' + String(r.error));
        if (r && r.hint) lines.push('提示:' + String(r.hint));
        if (Array.isArray(r && r.steps)) for (const s of r.steps) lines.push('· ' + String(s));
        const doc = r && r.doctor;
        if (doc && doc.addon) lines.push('启动后体检:' + String((doc.addon && doc.addon.summary) || JSON.stringify(doc.addon)).slice(0, 400));
        return { text: lines.join('\n'), images: [] };
      } catch (e) {
        return { text: 'launch 失败:' + String((e && e.message) || e) + '(后端没起?先 blender_viewport op=start —— 那是管后端进程的,本 op 才是管 Blender 的)', images: [] };
      }
    }
    if (op === 'doctor') {
      const d = await backendJson(port, '/doctor', 60000, signal);
      const diag = (d && d.diagnosis) || (d && d.metrics && d.metrics.lastDiagnosis) || null;
      const lines = [];
      lines.push('诊断:' + String((d && d.kind) || (diag && diag.kind) || (d && d.ok ? 'ok' : 'unknown')));
      lines.push('插件:v' + PLUGIN_VERSION + '(LiteAgent 原生移植)');
      if (diag && diag.summary) lines.push('结论:' + String(diag.summary));
      if (diag && diag.fix) lines.push('修法:' + String(diag.fix));
      if (d && d.addon) lines.push('addon:' + JSON.stringify(d.addon).slice(0, 300));
      const led = (d && d.ledger) || null;
      if (led && led.workDir) lines.push('工作目录:' + String((led.workDir && (led.workDir.wsl || led.workDir.win)) || '?') + (led.workDir && led.workDir.writable ? '(可写)' : '(⚠️ 不可写)'));
      if (led && !led.writable && led.hint) lines.push('修法:' + String(led.hint));
      return { text: lines.join('\n'), images: [] };
    }
    // 默认 status
    const s = await backendJson(port, '/status', 60000, signal);
    if (!s || s.ok !== true) return { text: '后端状态异常:' + String((s && (s.error || s.raw)) || 'unknown'), images: [] };
    const m = s.metrics || {};
    return { text: [
      '后端:' + base(port) + ' 运行中',
      '通道:calls=' + String(m.calls || 0) + ' errors=' + String(m.errors || 0) + ' inflight=' + String(m.inflight || 0) + ' lastCmd=' + String(m.lastCmd || '-'),
      'runs(无头台账)' + String((s.runs || []).length) + ' 条 · jobs ' + String((s.jobs || []).length) + ' 条',
    ].join('\n'), images: [] };
  }

  throw new Error('未知 Blender 工具: ' + name);
}

// ---------- 对外:状态/测试/停止 ----------
async function status(store) {
  const c = cfg(store);
  const out = { enabled: c.enabled, httpPort: c.httpPort, addonPort: c.addonPort, backendRunning: false, pid: null, addonConnected: false, lastCmd: null, renderBusy: false, jobs: 0, exe: resolveBlenderExe(store) };
  if (!c.enabled) return out;
  try {
    const h = await backendJson(c.httpPort, '/health', 2000, null);
    if (h && h.ok) { out.backendRunning = true; out.pid = h.backend && h.backend.pid; }
  } catch (_) { /* 未运行 */ }
  if (out.backendRunning) {
    try {
      const st = await backendJson(c.httpPort, '/host/state', 2000, null);
      if (st && st.ok) {
        const lastOkAge = st.channel && st.channel.lastOkAgeMs;
        out.addonConnected = typeof lastOkAge === 'number' && lastOkAge < 300000;
        out.lastCmd = (st.channel && st.channel.lastCmd) || null;
        out.renderBusy = !!(st.render && st.render.busy);
        out.jobs = (st.jobs && st.jobs.running) || 0;
      }
    } catch (_) { /* 后端刚起 */ }
  }
  return out;
}
async function test(store) {
  const c = cfg(store);
  const ok = await ensureBackend(store);
  if (!ok) return { ok: false, text: '后端无法启动(127.0.0.1:' + c.httpPort + ')。检查端口占用或重启应用。' };
  try {
    const d = await backendJson(c.httpPort, '/doctor', 60000, null);
    const kind = String((d && d.kind) || 'unknown');
    const diag = (d && d.diagnosis) || null;
    return { ok: kind === 'ok', text: '诊断:' + kind + (diag && diag.summary ? '\n结论:' + diag.summary : '') + (diag && diag.fix ? '\n修法:' + diag.fix : '') };
  } catch (e) {
    return { ok: false, text: 'doctor 失败:' + String((e && e.message) || e) };
  }
}
async function launch(store, file) {
  const c = cfg(store);
  const ok = await ensureBackend(store);
  if (!ok) return { ok: false, text: '后端无法启动' };
  // addonModule 显式指定:默认扫描会把 MCP for Blender 一起启用抢 9876
  const body = { waitMs: 90000, addonFile: addonFile(), addonModule: 'dsh_blender_bridge' };
  const exe = resolveBlenderExe(store);
  if (exe) body.exe = exe;
  if (file) body.file = String(file);
  audit(store, { action: 'launch-ui', exe: body.exe || null });
  const r = await backendPost(c.httpPort, '/launch', body, 125000, null);
  return { ok: !!(r && r.ok), text: (r && r.ok ? '已拉起 Blender' + (r.already ? '(已在运行)' : '') : '未成功:' + String((r && r.error) || 'unknown')) + (r && r.hint ? '\n' + String(r.hint) : '') };
}
async function stop(store) { return { ok: true, text: await stopBackend(store, 'user-ui') }; }

process.on('exit', () => { try { if (child) child.kill(); } catch (_) { /* ignore */ } });

module.exports = {
  BLENDER_DEFINITIONS, TOOL_NAMES, T,
  callTool, status, test, launch, stop, applyConfig,
  setBroadcaster, runtimeRoot, addonFile, resolveBlenderExe,
  hostGet, insertText, pickAt, killPortOwner,
  // 测试内部入口
  _internal: { cfg, probe, ensureBackend, parseBackendBody, frameDedupe, rawRequest, backendPost, backendJson, leasedText, jsonPayload, splitArgs, numTriple, resolveOutdir, planHeadlessTarget },
};
