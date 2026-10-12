// LiteAgent 原生插件宿主(通用插件接口)
// 插件 = userData/plugins-lite/ 下的:
//   1) 单文件:xxx.liteagent.js,导出 { name, version?, tools: [...] }
//   2) 目录:含 package.json,其 "liteagent" 字段为 true 或 { entry: '文件名' },入口导出同上
// 工具定义: { name, description, parameters(JSON Schema), async execute(args, ctx) }
// ctx: { workspace, signal, appVersion, dataDir(插件专属读写目录), log(level, msg, extra?) }
// 工具在智能体中以 lite_<插件名>_<工具名> 注入(完全/创造模式)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const debuglog = require('./debuglog');

const registry = new Map(); // id → { id, name, version, dir, tools, enabled, error? }

function pluginDir(store) {
  return path.join(store.baseDir(), 'plugins-lite');
}

function enabledMap(store) {
  const v = store.config && store.config.pluginsLite;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function sanitize(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'plugin';
}

async function scanAndLoad(store) {
  registry.clear();
  const dir = pluginDir(store);
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  const enabledMap0 = enabledMap(store);

  for (const e of entries) {
    let loadPath = null;
    let id = null;
    if (e.isFile() && e.name.endsWith('.liteagent.js')) {
      loadPath = path.join(dir, e.name);
      id = sanitize(e.name.replace(/\.liteagent\.js$/, ''));
    } else if (e.isDirectory()) {
      const pkgFile = path.join(dir, e.name, 'package.json');
      try {
        const pkg = JSON.parse(await fsp.readFile(pkgFile, 'utf8'));
        if (!pkg.liteagent) continue;
        const entryFile = (pkg.liteagent && pkg.liteagent.entry) || pkg.main || 'plugin.js';
        loadPath = path.join(dir, e.name, entryFile);
        id = sanitize(pkg.name || e.name);
      } catch (_) { continue; }
    }
    if (!loadPath) continue;
    try {
      delete require.cache[require.resolve(loadPath)];
      const mod = require(loadPath);
      if (!mod || !Array.isArray(mod.tools)) throw new Error('插件必须导出 tools 数组');
      const tools = mod.tools
        .filter((t) => t && t.name && typeof t.execute === 'function')
        .map((t) => ({
          name: String(t.name),
          description: String(t.description || t.name).slice(0, 500),
          parameters: t.parameters || { type: 'object', properties: {} },
          execute: t.execute,
        }));
      registry.set(id, {
        id,
        name: String(mod.name || id).slice(0, 30),
        version: String(mod.version || '1.0.0'),
        dir: path.dirname(loadPath),
        file: loadPath,
        tools,
        enabled: enabledMap0[id] !== false,
        error: null,
      });
      debuglog.info(store, 'plugin', '插件已加载', { id, tools: tools.length, file: loadPath });
    } catch (err) {
      registry.set(id || sanitize(path.basename(loadPath)), {
        id: id || sanitize(path.basename(loadPath)),
        name: id || path.basename(loadPath),
        version: '?', dir: path.dirname(loadPath), file: loadPath,
        tools: [], enabled: false,
        error: String(err.message || err).slice(0, 300),
      });
      debuglog.error(store, 'plugin', '插件加载失败', { file: loadPath, error: String(err.message || err).slice(0, 300) });
    }
  }
}

function list(store) {
  return [...registry.values()].map((r) => ({
    id: r.id, name: r.name, version: r.version, dir: r.dir,
    toolCount: r.tools.length, enabled: r.enabled, error: r.error,
    tools: r.tools.map((t) => t.name),
  }));
}

async function reload(store) {
  await scanAndLoad(store);
  return list(store);
}

// 收集启用插件的工具定义(注入智能体)
function collectTools(store) {
  const out = [];
  for (const r of registry.values()) {
    if (!r.enabled) continue;
    const prefix = 'lite_' + sanitize(r.name || r.id);
    for (const t of r.tools) {
      out.push({
        def: {
          name: `${prefix}__${sanitize(t.name)}`,
          description: `[插件·${r.name}] ${t.description}`.slice(0, 500),
          parameters: t.parameters,
        },
      });
    }
  }
  return out;
}

function findTool(fullName) {
  for (const r of registry.values()) {
    if (!r.enabled) continue;
    const prefix = 'lite_' + sanitize(r.name || r.id) + '__';
    if (!fullName.startsWith(prefix)) continue;
    const short = fullName.slice(prefix.length);
    const t = r.tools.find((x) => sanitize(x.name) === short);
    if (t) return { plugin: r, tool: t };
  }
  return null;
}

async function callTool(store, fullName, args, signal) {
  const found = findTool(fullName);
  if (!found) throw new Error(`未找到 LiteAgent 插件工具: ${fullName}`);
  const { plugin, tool } = found;
  const dataDir = path.join(pluginDir(store), '.data', plugin.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const ctx = {
    workspace: store.config.agent.workspace,
    signal,
    appVersion: store.config.version || '',
    dataDir,
    log: (sev, msg, extra) => debuglog.log(store, ['error', 'warn', 'info', 'debug'].includes(sev) ? sev : 'info', 'plugin:' + plugin.id, msg, extra),
  };
  debuglog.info(store, 'plugin', 'tool:call', { plugin: plugin.id, tool: tool.name });
  // 超时保护 120s + 中止信号
  let timer = null;
  try {
    const p = Promise.resolve(tool.execute(args || {}, ctx));
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`插件工具超时(120s): ${plugin.id}.${tool.name}`)), 120000);
    });
    const onAbort = () => { try { clearTimeout(timer); } catch (_) {} };
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onAbort, { once: true });
      signal.removeEventListener('abort', onAbort);
    }
    const out = await Promise.race([p, timeout]);
    return typeof out === 'string' ? out : JSON.stringify(out).slice(0, 20000);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pluginDir, scanAndLoad, reload, list, collectTools, callTool, registry };
