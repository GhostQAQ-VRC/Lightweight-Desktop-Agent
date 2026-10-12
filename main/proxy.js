// 网络代理策略:把 设置→网络 的三档配置应用到 Electron 默认 session(Chromium 网络栈)。
//   system  使用系统代理 —— 跟随 Windows 互联网选项/系统级代理(Clash 等开启系统代理即生效)
//   manual  手动配置 —— 用户自行添加 http/https/socks5 代理条目,按条目拼 Chromium proxyRules
//   direct  不使用任何代理 —— 强制直连,忽略系统与代理软件
// 校验函数保持纯函数(不触 electron),可被测试直接加载;
// applyProxy/resolveProxy 内部才 require('electron')。
const debuglog = require('./debuglog');

const SCHEMES = ['http', 'https', 'socks5'];
const MODES = ['system', 'manual', 'direct'];
// 本地地址强制旁路:LLM 本地服务(Ollama/LM Studio)与 MCP 本地服务永不被送进代理
const LOCAL_BYPASS = 'localhost;127.0.0.1;::1;<local>';
const MAX_RULES = 8;

// 越界数据清洗:非法条目剔除而非整体报错,保证损坏的 config 不至于把应用网络弄瘫
function cleanProxyConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(r.mode) ? r.mode : 'system';
  const rules = [];
  if (Array.isArray(r.rules)) {
    for (const item of r.rules.slice(0, MAX_RULES)) {
      const o = item && typeof item === 'object' ? item : {};
      const scheme = SCHEMES.includes(o.scheme) ? o.scheme : null;
      const host = String(o.host || '').trim().slice(0, 200);
      const port = parseInt(o.port, 10);
      if (!scheme || !host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (rules.some((x) => x.scheme === scheme && x.host === host && x.port === port)) continue;
      rules.push({ scheme, host, port });
    }
  }
  // 旁路规则:空白/逗号统一折成分号,再剔除安全字符集之外的字符
  //(< > 保留 —— Chromium 语法需要 <local> / <-loopback>;该串只进 setProxy,不进 HTML)
  const bypass = String(r.bypass || '')
    .replace(/[\s,]+/g, ';')
    .replace(/[^\w.:\-*\[\];<>]/g, '')
    .replace(/;{2,}/g, ';')
    .replace(/^;|;$/g, '')
    .slice(0, 500);
  return { mode, rules, bypass };
}

// 条目 → Chromium proxyRules(格式经 Electron 33 实测:每协议一条;socks5 用 URL 形式)。
// 注意:Chromium 的 http= 规则只覆盖 http 明文 —— 用户添加的 HTTP 代理条目会自动同时
// 接管 https(除非显式添加了 https 或 socks5 条目,后者本身覆盖全部协议)。
function buildRules(rules) {
  const list = rules || [];
  const hasHttps = list.some((r) => r.scheme === 'https');
  const hasSocks = list.some((r) => r.scheme === 'socks5');
  const parts = [];
  for (const r of list) {
    if (r.scheme === 'http') {
      parts.push(`http=${r.host}:${r.port}`);
      if (!hasHttps && !hasSocks) parts.push(`https=${r.host}:${r.port}`);
    } else if (r.scheme === 'https') {
      parts.push(`https=${r.host}:${r.port}`);
    } else if (r.scheme === 'socks5') {
      parts.push(`socks5://${r.host}:${r.port}`);
    }
  }
  return parts.join(';');
}

// 用户旁路 + 强制本地旁路(本地条目不可被用户配置移除)
function buildBypass(bypass) {
  const user = String(bypass || '').split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set([...user, ...LOCAL_BYPASS.split(';')])].join(';');
}

// manual 模式下给 npm 子进程(DSH 插件安装)用的环境变量
function npmEnv(config) {
  const p = cleanProxyConfig(config && config.proxy);
  if (p.mode === 'manual' && p.rules.length) {
    const httpEntry = p.rules.find((r) => r.scheme === 'http');
    const httpsEntry = p.rules.find((r) => r.scheme === 'https') || httpEntry || p.rules.find((r) => r.scheme === 'socks5');
    const env = {};
    if (httpEntry) env.HTTP_PROXY = env.HTTP_PROXY || `http://${httpEntry.host}:${httpEntry.port}`;
    if (httpsEntry) env.HTTPS_PROXY = env.HTTPS_PROXY || (httpsEntry.scheme === 'socks5' ? `socks5://${httpsEntry.host}:${httpsEntry.port}` : `http://${httpsEntry.host}:${httpsEntry.port}`);
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
    return env;
  }
  if (p.mode === 'direct') return { HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' };
  return {}; // system:交给 npm 自己继承系统环境
}

// 纯函数:清洗后的配置 → session.setProxy 的实际参数(可单测)
function resolveEffective(raw) {
  const p = cleanProxyConfig(raw);
  // manual 但没有任何有效条目 → 回退直连(fixed_servers 空规则会让所有请求失败)
  const mode = p.mode === 'manual' && !p.rules.length ? 'direct' : p.mode;
  const cfg = { mode: mode === 'manual' ? 'fixed_servers' : mode, proxyBypassRules: buildBypass(p.bypass) };
  if (mode === 'manual') cfg.proxyRules = buildRules(p.rules);
  return cfg;
}

async function applyProxy(store) {
  const { session } = require('electron');
  const cfg = resolveEffective(store && store.config && store.config.proxy);
  await session.defaultSession.setProxy(cfg);
  debuglog.info(store, 'proxy', 'apply', {
    mode: cfg.mode, proxyRules: cfg.proxyRules || null, bypass: cfg.proxyBypassRules,
  });
  return cfg;
}

async function resolveProxy(url) {
  const { session } = require('electron');
  const u = String(url || 'https://api.deepseek.com');
  if (!/^https?:\/\//i.test(u)) throw new Error('仅支持 http(s) 地址');
  return session.defaultSession.resolveProxy(u);
}

module.exports = { SCHEMES, MODES, LOCAL_BYPASS, MAX_RULES, cleanProxyConfig, buildRules, buildBypass, resolveEffective, npmEnv, applyProxy, resolveProxy };
