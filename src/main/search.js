// 联网搜索:多后端聚合 —— DuckDuckGo(免 Key)/ Tavily / Brave / SearXNG / 博查(中文)。
// 模型通过 web_search 工具调用;所有出站走 http.js(受代理设置约束)并过安全 URL 门槛。
// 解析函数保持纯函数(不触网络),可被测试直接加载。
const security = require('./security');

const UA = 'Mozilla/5.0 (LiteAgent/0.1)';

const BACKENDS = {
  duckduckgo: { label: 'DuckDuckGo(免 Key)', needsKey: false },
  tavily: { label: 'Tavily(需 API Key,面向智能体)', needsKey: true, keyField: 'tavilyKey' },
  brave: { label: 'Brave Search(需 API Key)', needsKey: true, keyField: 'braveKey' },
  searxng: { label: 'SearXNG(自建/公共实例)', needsKey: false, urlField: 'searxUrl' },
  bocha: { label: '博查 Bocha(中文搜索,需 Key)', needsKey: true, keyField: 'bochaKey' },
};

const decodeEntities = (s) => String(s || '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp|copy|mdash|hellip|#x27|#x2F);/g, (m) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
    '&copy;': '©', '&mdash;': '—', '&hellip;': '…', '&#x27;': "'", '&#x2F;': '/',
  }[m] || m));

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// —— 各后端解析(纯函数) ——
function parseDuckduckgoHtml(html) {
  const out = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snips = [];
  let sm;
  while ((sm = snipRe.exec(html))) snips.push(stripTags(sm[1]));
  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < 10) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    try {
      if (uddg) url = decodeURIComponent(uddg[1]);
      else if (url.startsWith('//')) url = 'https:' + url;
    } catch (_) { /* 保留原值 */ }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    out.push({ title, url, snippet: snips[i] || '' });
    i += 1;
  }
  return out;
}

function parseTavily(j) {
  return (j && Array.isArray(j.results) ? j.results : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.url || ''), snippet: String(r.content || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseBrave(j) {
  const list = (j && j.web && Array.isArray(j.web.results) ? j.web.results : []).slice(0, 10);
  return list.map((r) => ({ title: String(r.title || '').trim(), url: String(r.url || ''), snippet: String(r.description || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseSearxng(j) {
  return (j && Array.isArray(j.results) ? j.results : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.url || ''), snippet: String(r.content || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseBocha(j) {
  const pages = j && j.data && j.data.webPages && Array.isArray(j.data.webPages.value) ? j.data.webPages.value : [];
  return pages.slice(0, 10)
    .map((r) => ({ title: String(r.name || '').trim(), url: String(r.url || ''), snippet: String(r.snippet || r.summary || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function formatResults(query, backendLabel, results) {
  if (!results.length) return `搜索「${query}」(${backendLabel}):无结果。可换关键词或换其他搜索引擎(设置 → 沙箱与搜索)。`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + r.snippet : ''}`);
  return `搜索「${query}」(${backendLabel},共 ${results.length} 条;需要全文时用 web_fetch 打开链接):\n\n${lines.join('\n')}`;
}

async function fetchWithTimeout(url, opts, ms, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`请求超时(${ms / 1000}s)`)), ms);
  const onAbort = () => ac.abort(signal && signal.reason ? signal.reason : new Error('已中止'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const http = require('./http'); // 延迟引入:保持本模块在 RUN_AS_NODE 下可加载
  try {
    return await http.fetch(url, { headers: { 'user-agent': UA }, signal: ac.signal, ...opts });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 统一入口:args = { query, count };ctx = { store, security, signal }
async function webSearchExec(args, ctx) {
  const config = (ctx.store && ctx.store.config) || {};
  const sc = config.search || {};
  const backend = BACKENDS[sc.backend] ? sc.backend : 'duckduckgo';
  const query = String((args && args.query) || '').trim();
  if (!query) throw new Error('缺少 query 参数');
  const count = Math.min(10, Math.max(1, parseInt(args && args.count, 10) || 5));
  const sec = config.security || {};
  const signal = ctx.signal;

  let results = [];
  const label = BACKENDS[backend].label;
  if (backend === 'duckduckgo') {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    security.assertUrlAllowed(url, sec);
    const res = await fetchWithTimeout(url, { redirect: 'follow' }, 20000, signal);
    if (!res.ok) throw new Error(`DuckDuckGo 搜索失败 HTTP ${res.status}`);
    results = parseDuckduckgoHtml(await res.text());
  } else if (backend === 'tavily') {
    if (!sc.tavilyKey) throw new Error('未配置 Tavily API Key(设置 → 沙箱与搜索)');
    security.assertUrlAllowed('https://api.tavily.com/search', sec);
    const res = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: sc.tavilyKey, query, max_results: count, search_depth: 'basic' }),
    }, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Tavily 搜索失败 HTTP ${res.status}: ${j && j.detail ? String(j.detail).slice(0, 200) : ''}`);
    results = parseTavily(j);
  } else if (backend === 'brave') {
    if (!sc.braveKey) throw new Error('未配置 Brave Search API Key(设置 → 沙箱与搜索)');
    security.assertUrlAllowed('https://api.search.brave.com/res/v1/web/search', sec);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetchWithTimeout(url, { headers: { 'x-subscription-token': sc.braveKey, accept: 'application/json' } }, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Brave 搜索失败 HTTP ${res.status}`);
    results = parseBrave(j);
  } else if (backend === 'searxng') {
    const base = String(sc.searxUrl || '').trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\//i.test(base)) throw new Error('未配置 SearXNG 实例地址(设置 → 沙箱与搜索;实例需开启 JSON 输出 format=json)');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    security.assertUrlAllowed(url, sec);
    const res = await fetchWithTimeout(url, {}, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`SearXNG 搜索失败 HTTP ${res.status}(实例需启用 JSON 格式输出)`);
    results = parseSearxng(j);
  } else if (backend === 'bocha') {
    if (!sc.bochaKey) throw new Error('未配置博查 API Key(设置 → 沙箱与搜索)');
    security.assertUrlAllowed('https://api.bochaai.com/v1/web-search', sec);
    const res = await fetchWithTimeout('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sc.bochaKey}` },
      body: JSON.stringify({ query, summary: true, count }),
    }, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`博查搜索失败 HTTP ${res.status}`);
    results = parseBocha(j);
  }
  return formatResults(query, label, results);
}

module.exports = {
  BACKENDS, parseDuckduckgoHtml, parseTavily, parseBrave, parseSearxng, parseBocha, formatResults, webSearchExec,
};
