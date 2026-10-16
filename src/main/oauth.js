// 供应商账号 OAuth 登录(v0.30):用订阅账号而非 API Key。
// 依据:各家开源 CLI 公开使用的客户端凭据与端点(Qwen Code 设备码 / Claude Code PKCE / Gemini CLI PKCE)。
// 令牌存储在 config.oauthAccounts(与 API Key 同级,同为本地明文 —— 与现有安全口径一致)。
const http = require('./http');
const { shell } = require('electron');
const crypto = require('crypto');
const debuglog = require('./debuglog');

const LOGIN_DEADLINE_MS = 5 * 60 * 1000;

const KINDS = {
  qwen: {
    label: '通义千问',
    deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
    tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
    clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
    scope: 'openid profile email model.completion',
    resource: 'https://portal.qwen.ai/v1',
    pkce: true, // 千问的设备授权是 PKCE 扩展(device 带 challenge / 轮询带 verifier),GitHub 设备码不吃这个
  },
  claude: {
    label: 'Claude',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://claude.ai/api/oauth/token',
    clientId: '9d0c20c2-9616-4a17-8e5d-e0e10d8e0b5f',
    scope: 'oauth:create_api_key',
    callbackPath: '/callback',
  },
  codex: {
    label: 'ChatGPT',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoioEEPTYroMDKAmk7Jg8Q3',
    scope: 'openid profile email offline_access',
    callbackPath: '/auth/callback',
    originator: 'codex_cli_rs',
  },
  copilot: {
    label: 'GitHub Copilot',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: 'Iv1.b507b08cbd516c9f',
    scope: 'read:user',
  },
  gemini: {
    label: 'Google Gemini',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: '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',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email',
    callbackPath: '/oauth2callback',
  },
};

// 登录过程中的会话状态(UI 轮询 oauth:status 展示)
const sessions = {};

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256b64url = (s) => b64url(crypto.createHash('sha256').update(s).digest());
const pkcePair = () => {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: sha256b64url(verifier) };
};
const randomState = () => b64url(crypto.randomBytes(16));

// 登录接口的错误信息提取:兼容 {error:'…'} / {error:{code,message,type}} / {message} 三种形状
function extractLoginError(j, text, status) {
  if (j && j.error && typeof j.error === 'object') {
    const e = j.error;
    return `${e.code || e.type || 'HTTP ' + status}: ${e.message || ''}`.trim();
  }
  if (j && typeof j.error === 'string') return j.error;
  if (j && (j.error_description || j.message)) return j.error_description || j.message;
  return String(text || '').slice(0, 200);
}

async function postForm(url, params, signal) {
  const body = new URLSearchParams(params).toString();
  const res = await http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) { throw new Error(`登录接口返回异常(HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`登录接口错误(HTTP ${res.status}): ${extractLoginError(j, text, res.status)}`);
  return j;
}

// claude.ai 的令牌接口只收 JSON 体(其余家标准 OAuth 收表单)
async function postJson(url, obj, signal) {
  const res = await http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(obj),
    signal,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) { throw new Error(`登录接口返回异常(HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`登录接口错误(HTTP ${res.status}): ${extractLoginError(j, text, res.status)}`);
  return j;
}

// 令牌请求分发:claude 走 JSON,其余走表单
function tokenRequest(kind, url, params, signal) {
  return kind === 'claude' ? postJson(url, params, signal) : postForm(url, params, signal);
}

// 从 Codex 的 id_token(JWT)里解析 ChatGPT 账号 id(请求 chatgpt 后端必须携带)
function accountIdFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64').toString('utf8'));
    return payload.chatgpt_account_id || '';
  } catch (_) { return ''; }
}

function applyTokens(store, kind, providerId, tokens) {
  const cfg = store.config;
  cfg.oauthAccounts = cfg.oauthAccounts || {};
  cfg.oauthAccounts[kind] = {
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || (cfg.oauthAccounts[kind] && cfg.oauthAccounts[kind].refreshToken) || '',
    expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    accountId: kind === 'codex' ? accountIdFromIdToken(tokens.id_token) : '',
  };
  const p = cfg.providers.find((x) => x.id === providerId);
  if (p) p.apiKey = tokens.access_token || '';
  store.updateConfig({ oauthAccounts: cfg.oauthAccounts, providers: cfg.providers });
}

// 令牌到期前自动刷新;返回可用 access_token(无账号返回 null)
// copilot 特殊:refreshToken 是 GitHub 长期令牌,accessToken 是 ~30 分钟一换的 Copilot 短令牌(到期重新换发)
async function ensureFresh(store, kind, providerId) {
  const K = KINDS[kind];
  if (!K) return null;
  const acc = store.config.oauthAccounts && store.config.oauthAccounts[kind];
  if (!acc || !acc.accessToken) return null;
  if (acc.expiresAt && acc.expiresAt - 60000 > Date.now()) return acc.accessToken;
  if (kind === 'copilot') {
    if (!acc.refreshToken) return acc.accessToken;
    try {
      const res = await http.fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: { authorization: `Bearer ${acc.refreshToken}`, accept: 'application/json', 'user-agent': 'LiteAgent' },
      });
      const j = await res.json();
      if (!res.ok || !j.token) throw new Error(`Copilot 令牌换发失败(HTTP ${res.status})`);
      applyTokens(store, kind, providerId, { access_token: j.token, expires_in: Math.max(60, Number(j.expires_at) * 1000 - Date.now()) / 1000 });
      debuglog.info(store, 'oauth', 'copilot-token-refreshed', {});
      return store.config.oauthAccounts[kind].accessToken;
    } catch (e) {
      debuglog.warn(store, 'oauth', 'refresh-failed', { kind, message: String(e.message || e).slice(0, 200) });
      return acc.accessToken;
    }
  }
  if (!acc.refreshToken) return acc.accessToken; // 无刷新令牌只能用现值
  try {
    const params = { grant_type: 'refresh_token', refresh_token: acc.refreshToken, client_id: K.clientId };
    if (K.clientSecret) params.client_secret = K.clientSecret;
    const j = await tokenRequest(kind, K.tokenUrl, params);
    applyTokens(store, kind, providerId, j);
    debuglog.info(store, 'oauth', 'refreshed', { kind });
    return store.config.oauthAccounts[kind].accessToken;
  } catch (e) {
    debuglog.warn(store, 'oauth', 'refresh-failed', { kind, message: String(e.message || e).slice(0, 200) });
    return acc.accessToken; // 刷新失败先用旧令牌,让请求报出真实错误
  }
}

// —— 登录后拉取模型清单(各家的端点不同) ——
async function fetchModelsForOauth(store, kind, providerId) {
  const K = KINDS[kind];
  if (!K) throw new Error('未知的登录类型');
  const acc = store.config.oauthAccounts && store.config.oauthAccounts[kind];
  if (!acc || !acc.accessToken) throw new Error('尚未登录');
  const auth = { authorization: `Bearer ${acc.accessToken}` };
  let ids = [];
  if (kind === 'qwen') {
    const res = await http.fetch('https://portal.qwen.ai/v1/models', { headers: auth });
    const j = await res.json();
    if (!res.ok) throw new Error(`拉取模型失败(HTTP ${res.status})`);
    ids = (j.data || []).map((m) => m.id).filter(Boolean);
  } else if (kind === 'claude') {
    const res = await http.fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { ...auth, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`拉取模型失败(HTTP ${res.status})`);
    ids = (j.data || []).map((m) => m.id).filter(Boolean);
  } else if (kind === 'gemini') {
    const res = await http.fetch('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}',
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`拉取模型失败(HTTP ${res.status})`);
    ids = Object.keys(j.models || {}).map((k) => k.replace(/^models\//, '')).filter(Boolean);
  } else if (kind === 'copilot') {
    const res = await http.fetch('https://api.githubcopilot.com/models', {
      headers: { ...auth, accept: 'application/json', 'editor-version': 'vscode/1.96.2', 'editor-plugin-version': 'copilot-chat/0.26.2', 'x-github-api-version': '2025-04-01', 'copilot-integration-id': 'vscode-chat', 'user-agent': 'GitHubCopilotChat/0.26.2' },
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`拉取模型失败(HTTP ${res.status})`);
    ids = (j.data || []).map((m) => m.id).filter(Boolean);
  }
  const p = store.config.providers.find((x) => x.id === providerId);
  if (p && ids.length) {
    p.models = [...new Set(ids)].slice(0, 100);
    store.updateConfig({ providers: store.config.providers });
  }
  return ids;
}

// —— 构建 PKCE 授权 URL(导出供测试) ——
function buildAuthorizeUrl(kind, redirectUri, verifier, state) {
  const K = KINDS[kind];
  const q = new URLSearchParams({
    client_id: K.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: K.scope,
    code_challenge: sha256b64url(verifier),
    code_challenge_method: 'S256',
    state,
  });
  if (kind === 'gemini') {
    q.set('access_type', 'offline');
    q.set('prompt', 'consent');
  }
  if (kind === 'codex') {
    q.set('originator', K.originator);
  }
  return `${K.authorizeUrl}?${q.toString()}`;
}

// —— PKCE 登录:应用内授权窗口接 redirect(走应用网络栈与代理)→ 换令牌 ——
async function loginPkce(store, kind, providerId) {
  const K = KINDS[kind];
  const { verifier } = pkcePair();
  const state = randomState();
  let waiter = null;
  const callback = new Promise((resolve) => { waiter = resolve; });
  const server = require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    if (!code && !error) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:60px"><h2>✅ 授权成功</h2>回到 LiteAgent 继续即可,本页可以关闭。</body>');
    if (waiter) { waiter({ code: code || '', error: error || '', state: u.searchParams.get('state') || '' }); waiter = null; }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}${K.callbackPath || '/callback'}`;
  const url = buildAuthorizeUrl(kind, redirectUri, verifier, state);
  sessions[kind] = { phase: 'browser', url };
  // 应用内授权窗口:跟随应用的网络代理(系统浏览器走不到应用内代理,国内不开系统代理时 claude/google 打不开);
  // UA 伪装成正常 Chrome,规避 Google 对 Electron 内嵌窗的拦截
  const { BrowserWindow } = require('electron');
  let win = null;
  try {
    win = new BrowserWindow({
      width: 560, height: 760, title: `${K.label} 账号授权`, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    win.setMenuBarVisibility(false);
    await win.loadURL(url);
  } catch (e) {
    if (win) win.destroy();
    throw new Error(`打开授权窗口失败: ${e.message} —— 该域名需要网络代理,请在 设置 → 网络 配置后重试`);
  }

  let timer = null;
  const result = await Promise.race([
    callback,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), LOGIN_DEADLINE_MS); }),
  ]);
  clearTimeout(timer);
  server.close();
  if (win && !win.isDestroyed()) win.close();
  if (!result || result.timeout) { sessions[kind] = { phase: 'error', error: '登录超时(5 分钟内未完成授权)' }; throw new Error('登录超时'); }
  if (result.error) { sessions[kind] = { phase: 'error', error: result.error }; throw new Error(`授权被拒绝: ${result.error}`); }
  if (result.state !== state) { sessions[kind] = { phase: 'error', error: 'state 不匹配' }; throw new Error('授权回调 state 校验失败'); }
  sessions[kind] = { phase: 'exchanging' };
  const params = {
    grant_type: 'authorization_code', code: result.code, redirect_uri: redirectUri,
    client_id: K.clientId, code_verifier: verifier,
  };
  if (K.clientSecret) params.client_secret = K.clientSecret;
  const tokens = await tokenRequest(kind, K.tokenUrl, params);
  applyTokens(store, kind, providerId, tokens);
  return tokens;
}

// —— 设备码登录(千问):显示 user_code → 用户在浏览器确认 → 轮询令牌 ——
// 注意:千问的设备授权是 PKCE 保护的(device 请求带 code_challenge,轮询带 code_verifier),漏了会 400
async function loginDevice(store, kind, providerId) {
  const K = KINDS[kind];
  const { verifier, challenge } = pkcePair();
  const deviceParams = { client_id: K.clientId, scope: K.scope };
  if (K.pkce) { deviceParams.code_challenge = challenge; deviceParams.code_challenge_method = 'S256'; }
  if (K.resource) deviceParams.resource = K.resource;
  const init = await postForm(K.deviceCodeUrl, deviceParams);
  sessions[kind] = {
    phase: 'device',
    userCode: init.user_code || '',
    verificationUri: init.verification_uri || '',
    verificationUriComplete: init.verification_uri_complete || '',
  };
  if (init.verification_uri_complete || init.verification_uri) {
    await shell.openExternal(init.verification_uri_complete || init.verification_uri);
  }
  const interval = Math.max(2, Number(init.interval) || 5) * 1000;
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    if (Date.now() > deadline) { sessions[kind] = { phase: 'error', error: '登录超时' }; throw new Error('登录超时'); }
    await new Promise((r) => setTimeout(r, interval));
    const pollParams = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: K.clientId, device_code: init.device_code,
    };
    if (K.pkce) pollParams.code_verifier = verifier;
    if (K.resource) pollParams.resource = K.resource;
    const j = await postForm(K.tokenUrl, pollParams).catch((e) => ({ __err: e }));
    if (j.__err) {
      const msg = String(j.__err.message || '');
      if (msg.includes('authorization_pending')) continue;
      if (msg.includes('slow_down')) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      sessions[kind] = { phase: 'error', error: msg.slice(0, 200) };
      throw j.__err;
    }
    applyTokens(store, kind, providerId, j);
    return j;
  }
}

// 登录入口:完成授权 → 存令牌 → 拉模型清单(失败不抛 IPC 异常,返回结果对象供 UI 提示)
async function login(store, kind, providerId) {
  const K = KINDS[kind];
  if (!K) throw new Error('未知的登录类型');
  const p = store.config.providers.find((x) => x.id === providerId);
  if (!p) throw new Error('服务商不存在');
  try {
    const tokens = (kind === 'qwen' || kind === 'copilot')
      ? await loginDevice(store, kind, providerId)
      : await loginPkce(store, kind, providerId);
    // Copilot:GitHub 令牌只是入场券,还要换发短时的 Copilot API 令牌
    if (kind === 'copilot' && tokens && tokens.access_token) {
      const res = await http.fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json', 'user-agent': 'LiteAgent' },
      });
      const j = await res.json();
      if (!res.ok || !j.token) throw new Error(`Copilot 令牌换发失败(HTTP ${res.status})`);
      applyTokens(store, kind, providerId, { access_token: j.token, expires_in: Math.max(60, Number(j.expires_at) * 1000 - Date.now()) / 1000 });
    }
    sessions[kind] = { phase: 'done' };
    let models = [];
    try { models = await fetchModelsForOauth(store, kind, providerId); } catch (e) {
      debuglog.warn(store, 'oauth', 'models-failed', { kind, message: String(e.message || e).slice(0, 200) });
    }
    debuglog.info(store, 'oauth', 'login', { kind, provider: p.name, models: models.length });
    return { ok: true, models: models.length };
  } catch (e) {
    let msg = String(e.message || e);
    // claude/gemini/codex 的授权域名在国内需要网络代理(应用内授权窗口走 设置→网络 的应用代理)
    if (['claude', 'gemini', 'codex'].includes(kind) && /请求失败|请求超时|timeout|ENOTFOUND|ECONNRESET|ECONNREFUSED|ERR_NAME|ERR_CONNECTION|网络/i.test(msg)) {
      msg += ' —— 该服务商的授权域名需要网络代理:请在 设置 → 网络 配置后重试(授权窗口会跟随应用代理)';
    }
    // 服务商按出口 IP 地区拒绝(如 OpenAI 的 unsupported_country_region_territory):换节点,应用侧无法绕过
    if (/unsupported_country_region_territory|not supported|Country, region|request_forbidden/i.test(msg)) {
      msg = `当前网络出口 IP 所在地区不被该服务商支持(中国大陆、香港等均受限):请在 设置 → 网络 把代理节点切换到支持的地区(美国/日本/新加坡等),然后重新点「登录账号」;授权窗口与后续请求都会跟随该代理。原始错误:${msg.slice(0, 160)}`;
    }
    if ((sessions[kind] || {}).phase !== 'error') sessions[kind] = { phase: 'error', error: msg.slice(0, 300) };
    debuglog.warn(store, 'oauth', 'login-failed', { kind, message: msg.slice(0, 200) });
    return { ok: false, error: msg.slice(0, 300) };
  }
}

function status(store, kind) {
  const K = KINDS[kind];
  if (!K) throw new Error('未知的登录类型');
  const s = sessions[kind] || {};
  const acc = store.config.oauthAccounts && store.config.oauthAccounts[kind];
  return {
    label: K.label,
    phase: s.phase || 'idle',
    userCode: s.userCode || '',
    verificationUri: s.verificationUri || '',
    error: s.error || '',
    account: acc ? { expiresAt: acc.expiresAt || 0 } : null,
  };
}

async function logout(store, kind, providerId) {
  const cfg = store.config;
  if (cfg.oauthAccounts) delete cfg.oauthAccounts[kind];
  const p = cfg.providers.find((x) => x.id === providerId);
  if (p) p.apiKey = '';
  store.updateConfig({ oauthAccounts: cfg.oauthAccounts || {}, providers: cfg.providers });
  sessions[kind] = { phase: 'idle' };
  return { ok: true };
}

module.exports = { KINDS, login, status, logout, ensureFresh, fetchModelsForOauth, buildAuthorizeUrl, pkcePair, extractLoginError };
