// 调试日志(诊断接入口):
//  - 分级:off(仅错误)/ info(默认)/ verbose(含请求响应规模等细节)
//  - 按天分文件 userData/logs/debug-YYYY-MM-DD.log,超 4MB 轮转为 .1
//  - 导出诊断包:环境信息 + 脱敏配置 + 会话列表 + 日志尾部,一键生成给开发者定位
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_SEV = { off: 0, info: 2, verbose: 3 }; // 允许记录的最高严重级
const SEV = { error: 0, warn: 1, info: 2, debug: 3 };
const ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_STR = 8000;

function levelName(store) {
  const d = (store.config && store.config.debug) || {};
  if (d.enabled === false) return 'off';
  return ['off', 'info', 'verbose'].includes(d.level) ? d.level : 'info';
}

function logDir(store) {
  return path.join(store.baseDir(), 'logs');
}

function fileFor(store, d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(logDir(store), `debug-${y}-${m}-${day}.log`);
}

function clip(v) {
  if (typeof v === 'string' && v.length > MAX_LINE_STR) return v.slice(0, MAX_LINE_STR) + '…(截断)';
  return v;
}

function safeClone(extra) {
  try {
    return JSON.parse(JSON.stringify(extra, (k, v) => clip(v)));
  } catch (_) {
    return { unserializable: true };
  }
}

function allowed(store, sev) {
  const max = MAX_SEV[levelName(store)];
  return (SEV[sev] ?? 0) <= max;
}

function write(store, sev, scope, msg, extra) {
  try {
    const dir = logDir(store);
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(store);
    try {
      const st = fs.statSync(file);
      if (st.size > ROTATE_BYTES) {
        const rot = file + '.1';
        try { fs.unlinkSync(rot); } catch (_) { /* ignore */ }
        fs.renameSync(file, rot);
      }
    } catch (_) { /* 文件不存在等 */ }
    const rec = { t: new Date().toISOString(), sev, scope, msg: clip(String(msg)) };
    if (extra !== undefined) rec.extra = safeClone(extra);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) { /* 日志失败不阻断主流程 */ }
}

function log(store, sev, scope, msg, extra) {
  try {
    if (!store || !allowed(store, sev)) return;
    write(store, sev, scope, msg, extra);
  } catch (_) { /* ignore */ }
}

const error = (store, scope, msg, extra) => log(store, 'error', scope, msg, extra);
const warn = (store, scope, msg, extra) => log(store, 'warn', scope, msg, extra);
const info = (store, scope, msg, extra) => log(store, 'info', scope, msg, extra);
const debug = (store, scope, msg, extra) => log(store, 'debug', scope, msg, extra);

function stats(store) {
  const dir = logDir(store);
  const out = { dir, files: 0, bytes: 0, lines: 0 };
  try {
    const names = fs.readdirSync(dir).filter((f) => f.startsWith('debug-') && f.endsWith('.log'));
    out.files = names.length;
    for (const f of names) {
      const st = fs.statSync(path.join(dir, f));
      out.bytes += st.size;
      if (f === path.basename(fileFor(store))) {
        out.lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length;
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function recentLines(store, n = 500) {
  try {
    const file = fileFor(store);
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-n);
  } catch (_) {
    return [];
  }
}

// 配置脱敏:所有密钥只保留长度与数量
function sanitizeConfig(config) {
  const c = JSON.parse(JSON.stringify(config || {}));
  for (const p of c.providers || []) {
    const n = Array.isArray(p.apiKeys) ? p.apiKeys.length : (p.apiKey ? 1 : 0);
    p.apiKeys = undefined;
    p.apiKey = n ? `(已隐藏,${n} 个)` : '';
  }
  for (const m of c.mcpServers || []) {
    if (m.headers) m.headers = Object.keys(m.headers).reduce((o, k) => (o[k] = '(已隐藏)', o), {});
    if (m.env) m.env = Object.keys(m.env).reduce((o, k) => (o[k] = '(已隐藏)', o), {});
  }
  return c;
}

function diagnostics(store) {
  let pkgVersion = '?';
  try { pkgVersion = require('../../package.json').version; } catch (_) { /* ignore */ }
  return {
    exportedAt: new Date().toISOString(),
    app: {
      name: 'LiteAgent',
      version: pkgVersion,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    },
    config: sanitizeConfig(store.config),
    conversations: store.listConvs(),
    logTail: recentLines(store, 500),
  };
}

module.exports = { log, error, warn, info, debug, stats, recentLines, diagnostics, sanitizeConfig, logDir, levelName };
