// 联网搜索:多后端聚合 —— DuckDuckGo(免 Key)/ Tavily / Brave / SearXNG / 博查(中文)
//   + 智谱 / Serper / SerpAPI / Google PSE / Jina(免 Key) / Exa(2026-10-25 扩充,共 11 后端)。
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
  zhipu: { label: '智谱搜索(中文,需 Key)', needsKey: true, keyField: 'zhipuKey' },
  serper: { label: 'Serper.dev(Google 系,需 Key)', needsKey: true, keyField: 'serperKey' },
  serpapi: { label: 'SerpAPI(Google 系,需 Key)', needsKey: true, keyField: 'serpapiKey' },
  google: { label: 'Google 可编程搜索(需 Key + 搜索引擎 ID)', needsKey: true, keyField: 'googleKey', extraFields: ['googleCx'] },
  jina: { label: 'Jina AI(免 Key,限流)', needsKey: false },
  exa: { label: 'Exa(面向智能体,需 Key)', needsKey: true, keyField: 'exaKey' },
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

// —— 2026-10-25 扩充后端解析(纯函数) ——
function parseZhipu(j) {
  return (j && Array.isArray(j.search_result) ? j.search_result : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.link || r.url || ''), snippet: String(r.content || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseSerper(j) {
  return (j && Array.isArray(j.organic) ? j.organic : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.link || ''), snippet: String(r.snippet || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseSerpapi(j) {
  return (j && Array.isArray(j.organic_results) ? j.organic_results : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.link || ''), snippet: String(r.snippet || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseGooglePse(j) {
  return (j && Array.isArray(j.items) ? j.items : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.link || ''), snippet: String(r.snippet || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

function parseExa(j) {
  return (j && Array.isArray(j.results) ? j.results : []).slice(0, 10)
    .map((r) => ({ title: String(r.title || '').trim(), url: String(r.url || ''), snippet: String(r.text || '').slice(0, 300) }))
    .filter((r) => r.title && r.url);
}

// Jina s.jina.ai/<query> 返回 Markdown SERP。宽松解析:抓 markdown 链接 + "Title:/URL Source:" 行对,
// 排除 jina 自身与 data URL;两条来源命中同一 URL 去重。格式变化时最多解析为空(诚实"无结果"),不误报。
function parseJinaMarkdown(md) {
  const out = [];
  const seen = new Set();
  const push = (title, url, snippet) => {
    if (!title || !/^https?:\/\//i.test(url)) return;
    if (/jina\.ai|^data:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ title: stripTags(title).slice(0, 200), url, snippet: stripTags(snippet || '').slice(0, 300) });
  };
  const lines = String(md || '').split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    const urlSrc = /^URL Source:\s*(\S+)/i.exec(lines[i]);
    if (urlSrc) {
      const title = /^Title:\s*(.+)$/i.exec(lines[i - 1] || '') || /^#*\s*(.+)$/.exec(lines[i + 1] || '');
      push(title ? title[1] : urlSrc[1], urlSrc[1], lines[i + 1] || '');
      continue;
    }
    // matchAll 独立迭代,不复用 lastIndex —— exec+replace 共用同一全局正则会重置 lastIndex
    // 造成 exec 永远重复首个匹配,被排除项不增长 out 即同步死循环(事件循环冻结,看门狗都失灵)
    for (const m of lines[i].matchAll(/\[([^\]\n]{2,200})\]\((https?:\/\/[^\s)]+)\)/g)) {
      if (out.length >= 10) break;
      push(m[1], m[2], lines[i]);
    }
  }
  return out;
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
  } else if (backend === 'zhipu') {
    if (!sc.zhipuKey) throw new Error('未配置智谱 API Key(设置 → 沙箱与搜索;open.bigmodel.cn 申请)');
    security.assertUrlAllowed('https://open.bigmodel.cn/api/paas/v4/web-search', sec);
    const res = await fetchWithTimeout('https://open.bigmodel.cn/api/paas/v4/web-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sc.zhipuKey}` },
      body: JSON.stringify({ query, count }),
    }, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`智谱搜索失败 HTTP ${res.status}: ${(j && j.error && j.error.message) || ''}`.trim());
    results = parseZhipu(j);
  } else if (backend === 'serper') {
    if (!sc.serperKey) throw new Error('未配置 Serper API Key(设置 → 沙箱与搜索;serper.dev 免费 2500 次/月)');
    security.assertUrlAllowed('https://google.serper.dev/search', sec);
    const res = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': sc.serperKey },
      body: JSON.stringify({ q: query, num: count }),
    }, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Serper 搜索失败 HTTP ${res.status}`);
    results = parseSerper(j);
  } else if (backend === 'serpapi') {
    if (!sc.serpapiKey) throw new Error('未配置 SerpAPI Key(设置 → 沙箱与搜索;serpapi.com 免费档 100 次/月)');
    security.assertUrlAllowed('https://serpapi.com/search', sec);
    const url = `https://serpapi.com/search?q=${encodeURIComponent(query)}&num=${count}&api_key=${encodeURIComponent(sc.serpapiKey)}`;
    const res = await fetchWithTimeout(url, {}, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`SerpAPI 搜索失败 HTTP ${res.status}`);
    results = parseSerpapi(j);
  } else if (backend === 'google') {
    if (!sc.googleKey) throw new Error('未配置 Google API Key(设置 → 沙箱与搜索;programmablesearchengine.google.com 创建搜索引擎并获得 ID)');
    if (!sc.googleCx) throw new Error('未配置 Google 搜索引擎 ID(cx;设置 → 沙箱与搜索)');
    security.assertUrlAllowed('https://www.googleapis.com/customsearch/v1', sec);
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(sc.googleKey)}&cx=${encodeURIComponent(sc.googleCx)}&q=${encodeURIComponent(query)}&num=${Math.min(10, count)}`;
    const res = await fetchWithTimeout(url, {}, 20000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Google 搜索失败 HTTP ${res.status}: ${(j && j.error && j.error.message) || ''}`.trim());
    results = parseGooglePse(j);
  } else if (backend === 'jina') {
    // 免 Key(限流 ~20 次/分);带 Key 可提额:在下方 Key 框填 Bearer 令牌即自动携带
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    security.assertUrlAllowed('https://s.jina.ai/', sec);
    const headers = { accept: 'text/plain' };
    if (sc.jinaKey) headers.authorization = `Bearer ${sc.jinaKey}`;
    const res = await fetchWithTimeout(url, { headers }, 25000, signal);
    if (!res.ok) throw new Error(`Jina 搜索失败 HTTP ${res.status}(免 Key 有速率限制,可稍后再试或配置 Key)`);
    results = parseJinaMarkdown(await res.text());
  } else if (backend === 'exa') {
    if (!sc.exaKey) throw new Error('未配置 Exa API Key(设置 → 沙箱与搜索;exa.ai 免费额度)');
    security.assertUrlAllowed('https://api.exa.ai/search', sec);
    const res = await fetchWithTimeout('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': sc.exaKey },
      body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 300 } } }),
    }, 25000, signal);
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Exa 搜索失败 HTTP ${res.status}`);
    results = parseExa(j);
  }
  return formatResults(query, label, results);
}

module.exports = {
  BACKENDS, parseDuckduckgoHtml, parseTavily, parseBrave, parseSearxng, parseBocha, formatResults, webSearchExec,
  parseZhipu, parseSerper, parseSerpapi, parseGooglePse, parseJinaMarkdown, parseExa,
};
