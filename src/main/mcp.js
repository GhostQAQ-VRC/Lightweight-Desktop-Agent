// MCP(Model Context Protocol)客户端 —— 插件兼容的通用桥梁
// 支持 stdio 与 Streamable HTTP 两种传输;工具以 mcp__<服务>__<工具> 命名并入智能体
const { spawn } = require('child_process');
const http = require('./http');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'LiteAgent', version: '0.3.0' };

function sanitize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'srv';
}

// Windows 上 npx/npm 等是 .cmd 垫片,必须经由 cmd 启动
function wrapWindowsCmd(command, args) {
  if (process.platform !== 'win32') return { cmd: command, argv: args };
  if (/\.(cmd|bat|ps1)$/i.test(command) || /^(npx|npm|uvx|pnpm|yarn|bunx)$/i.test(command)) {
    return { cmd: 'cmd.exe', argv: ['/d', '/s', '/c', command, ...args] };
  }
  return { cmd: command, argv: args };
}

// 命令行智能拆分:启动命令字段允许填「整条命令行」(UI placeholder 即此指引,npx -y @scope/server 形态)
// 或纯程序名。引号感知(含空格路径);拆出的参数与「参数」框里的显式 args 拼接。
// 没有这一层时整行会被当成程序名 → spawn ENOENT → MCP「无法使用」(2026-10-25 复现锚定)。
function splitCommandLine(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}

function expandCommand(command, args) {
  const parts = splitCommandLine(command);
  if (!parts.length) return { cmd: '', argv: args || [] };
  if (parts.length === 1) return { cmd: parts[0], argv: args || [] };
  return { cmd: parts[0], argv: [...parts.slice(1), ...(args || [])] };
}

/* ---------------- stdio 传输(换行分隔 JSON-RPC) ---------------- */
class StdioTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.proc = null;
    this.buffer = '';
    this.stderrTail = '';
    this.pending = new Map();
    this.nextId = 1;
    this.dead = false;
  }

  start() {
    const expanded = expandCommand(this.cfg.command, this.cfg.args || []);
    const { cmd, argv } = wrapWindowsCmd(expanded.cmd, expanded.argv);
    this.proc = spawn(cmd, argv, {
      env: { ...process.env, ...(this.cfg.env || {}) },
      cwd: this.cfg.cwd || undefined,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    this.proc.on('exit', (code) => {
      this.dead = true;
      for (const p of this.pending.values()) {
        p.cleanup();
        p.reject(new Error(`MCP 进程已退出(code=${code})${this.stderrTail ? ':' + this.stderrTail.slice(-300) : ''}`));
      }
      this.pending.clear();
    });
    this.proc.on('error', (e) => {
      this.dead = true;
      for (const p of this.pending.values()) {
        p.cleanup();
        p.reject(e);
      }
      this.pending.clear();
    });
  }

  handleLine(line) {
    let j;
    try { j = JSON.parse(line); } catch (_) { return; } // 忽略非 JSON 日志输出
    if (j.id === undefined) return; // 通知/请求暂不处理
    const p = this.pending.get(j.id);
    if (!p) return;
    this.pending.delete(j.id);
    p.cleanup();
    if (j.error) p.reject(new Error(j.error.message || JSON.stringify(j.error).slice(0, 300)));
    else p.resolve(j.result);
  }

  write(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) { /* 进程已退出:由 exit/error 事件统一 reject */ }
  }

  request(method, params, timeoutMs = 20000, signal) {
    if (this.dead || !this.proc) return Promise.reject(new Error('MCP stdio 进程未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时(${timeoutMs / 1000}s): ${method}`));
      }, timeoutMs);
      const entry = { resolve, reject, timer };
      const onAbort = () => {
        cleanup();
        this.pending.delete(id);
        reject(new DOMException('已中止', 'AbortError'));
      };
      const cleanup = () => {
        clearTimeout(entry.timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      entry.cleanup = cleanup;
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }

  notify(method, params) {
    try { this.write({ jsonrpc: '2.0', method, params: params || {} }); } catch (_) { /* ignore */ }
  }

  close() {
    try { this.proc && this.proc.kill(); } catch (_) { /* ignore */ }
  }
}

/* ---------------- Streamable HTTP 传输 ---------------- */
class HttpTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params, timeoutMs = 30000, signal) {
    const id = this.nextId++;
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(this.cfg.headers || {}),
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`MCP HTTP 请求超时(${timeoutMs / 1000}s)`)), timeoutMs);
    const onOuterAbort = () => ac.abort(signal.reason || new Error('已中止'));
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let res;
    try {
      res = await http.fetch(this.cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
        signal: ac.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/event-stream')) {
        return await this.readSseResponse(res, id);
      }
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || 'MCP HTTP 错误');
      return j.result;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async readSseResponse(res, wantId) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        let j;
        try { j = JSON.parse(payload); } catch (_) { continue; }
        if (j.id === wantId) {
          if (j.error) throw new Error(j.error.message || 'MCP HTTP 错误');
          return j.result;
        }
      }
    }
    throw new Error('MCP HTTP SSE 流中断,未收到响应');
  }

  notify() { /* HTTP 模式下无需独立通知 */ }

  close() { /* 无持久连接 */ }
}

/* ---------------- 客户端封装 ---------------- */
class McpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.transport = cfg.transport === 'http' ? new HttpTransport(cfg) : new StdioTransport(cfg);
    this.serverInfo = null;
  }

  async connect(signal) {
    if (this.cfg.transport !== 'http') this.transport.start();
    try {
      const res = await this.transport.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }, 20000, signal);
      this.serverInfo = res && res.serverInfo;
      this.transport.notify('notifications/initialized');
    } catch (e) {
      this.close(); // 清理半启动的进程/连接
      throw e;
    }
  }

  async listTools(signal) {
    const r = await this.transport.request('tools/list', {}, 20000, signal);
    return (r && Array.isArray(r.tools)) ? r.tools : [];
  }

  async callTool(name, args, signal) {
    const r = await this.transport.request('tools/call', { name, arguments: args || {} }, 180000, signal);
    if (r === undefined || r === null) return '(MCP 返回空结果)';
    if (r.isError) {
      const t = extractText(r);
      throw new Error(t || 'MCP 工具执行失败');
    }
    return extractText(r);
  }

  close() { this.transport.close(); }
}

function extractText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result && result.content)) {
    const parts = result.content.map((c) => {
      if (!c) return '';
      if (c.type === 'text') return c.text || '';
      return JSON.stringify(c).slice(0, 2000);
    });
    return parts.join('\n').trim() || '(MCP 工具无文本输出)';
  }
  return JSON.stringify(result).slice(0, 4000);
}

/* ---------------- 管理器:连接缓存 + 工具路由 ---------------- */
const clients = new Map(); // serverId → { client, sig }
const routes = new Map();  // 'mcp__srv__tool' → { serverId, toolName, autoApprove, serverName }

function sig(cfg) {
  return JSON.stringify([cfg.transport, cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers]);
}

function serverEnabled(cfg) {
  if (cfg.enabled === false) return false;
  return cfg.transport === 'http' ? !!cfg.url : !!cfg.command;
}

async function getClient(cfg, signal) {
  let entry = clients.get(cfg.id);
  // 配置变更 或 stdio 进程已死 → 重建连接
  if (entry && (entry.sig !== sig(cfg) || (cfg.transport !== 'http' && entry.client.transport.dead))) {
    try { entry.client.close(); } catch (_) { /* ignore */ }
    clients.delete(cfg.id);
    entry = null;
  }
  if (!entry) {
    const client = new McpClient(cfg);
    try {
      await client.connect(signal);
    } catch (e) {
      try { client.close(); } catch (_) { /* ignore */ }
      throw e;
    }
    entry = { client, sig: sig(cfg) };
    clients.set(cfg.id, entry);
  }
  return entry.client;
}

function invalidate(serverId) {
  const entry = clients.get(serverId);
  if (entry) {
    try { entry.client.close(); } catch (_) { /* ignore */ }
    clients.delete(serverId);
  }
}

// 收集所有启用服务的工具,返回 [{def, autoApprove, serverName}] 与 [{error}]
async function collectTools(servers, signal) {
  routes.clear();
  const out = [];
  for (const cfg of servers || []) {
    if (!serverEnabled(cfg)) continue;
    try {
      const client = await getClient(cfg, signal);
      const tools = await client.listTools(signal);
      const prefix = 'mcp__' + sanitize(cfg.name || cfg.id);
      for (const t of tools) {
        if (!t || !t.name) continue;
        const full = `${prefix}__${sanitize(t.name)}`;
        routes.set(full, {
          serverId: cfg.id,
          toolName: t.name,
          autoApprove: !!cfg.autoApprove,
          serverName: cfg.name,
        });
        out.push({
          def: {
            name: full,
            description: `[MCP·${cfg.name}] ${t.description || t.name}`.slice(0, 500),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
          autoApprove: !!cfg.autoApprove,
          serverName: cfg.name,
        });
      }
    } catch (e) {
      out.push({ error: `MCP「${cfg.name}」连接失败: ${e.message}` });
    }
  }
  return out;
}

async function callTool(servers, fullName, args, signal) {
  const route = routes.get(fullName);
  if (!route) throw new Error(`未找到 MCP 工具路由: ${fullName}`);
  const cfg = (servers || []).find((c) => c.id === route.serverId);
  if (!cfg) throw new Error('MCP 服务已被删除或禁用,请到设置中检查');
  const client = await getClient(cfg, signal);
  return client.callTool(route.toolName, args, signal);
}

function routeInfo(fullName) {
  return routes.get(fullName) || null;
}

// 设置页测试:连接并列出工具
async function testServer(cfg) {
  const probe = new McpClient(cfg);
  try {
    await probe.connect();
    const tools = await probe.listTools();
    return { ok: true, toolCount: tools.length, tools: tools.map((t) => t.name).slice(0, 30) };
  } finally {
    probe.close();
  }
}

module.exports = { collectTools, callTool, routeInfo, invalidate, testServer, expandCommand, splitCommandLine };
