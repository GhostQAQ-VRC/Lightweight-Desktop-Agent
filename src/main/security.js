// 网络安全审计:面向中转站/第三方 API 的请求门槛、敏感信息防护与本地审计日志
const fs = require('fs');
const path = require('path');

// 敏感信息检测规则(按顺序应用;redact 时逐条替换)
const SENSITIVE_PATTERNS = [
  { name: '私钥文件', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'API密钥', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'GitHub令牌', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'AWS密钥', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'JWT令牌', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: '内网地址', re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
];

const isLocalHost = (host) =>
  ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.localhost') || host.endsWith('.local');

// 请求门槛:协议白名单(仅 http/https,file:///ftp:///javascript: 等一律拒)+ HTTPS 强制(本地豁免)+ 域名白名单。
// 违规直接抛错中断请求。
function assertUrlAllowed(url, security) {
  const sec = security || {};
  let u;
  try { u = new URL(url); } catch { throw new Error(`无效的请求地址: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`已拦截非 http/https 协议请求: ${u.protocol}(file/ftp 等协议不在允许范围)`);
  }
  const host = u.hostname.toLowerCase();
  const local = isLocalHost(host);

  if (sec.httpsOnly !== false && u.protocol === 'http:' && !local) {
    throw new Error(`已按安全设置拦截非 HTTPS 请求: ${host}(中转站走明文 HTTP 会被第三方窃听)。如确需关闭,到 设置→安全审计 调整。`);
  }
  const list = String(sec.allowedHosts || '')
    .split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length && !local) {
    const ok = list.some((d) => host === d || host.endsWith('.' + d.replace(/^\*\./, '')));
    if (!ok) {
      throw new Error(`已按白名单拦截请求: ${host} 不在允许列表 [${list.join(', ')}] 中。请在 设置→安全审计 调整。`);
    }
  }
}

// 敏感信息处理:warn/block 记录并原样返回;redact 生成脱敏副本
function filterMessages(messages, security) {
  const sec = security || {};
  const action = sec.sensitiveScan ? (sec.sensitiveAction || 'warn') : 'off';
  const findings = [];
  if (action === 'off' || !Array.isArray(messages)) return { messages, findings };

  const transform = (text) => {
    let t = text;
    for (const p of SENSITIVE_PATTERNS) {
      t = t.replace(p.re, (match) => {
        findings.push({ type: p.name, sample: String(match).slice(0, 3) + '***' });
        return action === 'redact' ? `[已脱敏:${p.name}]` : match;
      });
    }
    return t;
  };

  const out = messages.map((m) => {
    let nm = m;
    if (typeof m.content === 'string') {
      const c = transform(m.content);
      if (c !== m.content) nm = { ...m, content: c };
    } else if (Array.isArray(m.content)) {
      // 多模态数组(附件消息):扫描/脱敏 text part;图片等非文本 part 原样保留
      let changed = false;
      const parts = m.content.map((p) => {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          const c = transform(p.text);
          if (c !== p.text) { changed = true; return { ...p, text: c }; }
        }
        return p;
      });
      if (changed) nm = { ...m, content: parts };
    }
    // 工具调用参数同样出站(上一轮 assistant 的 tool_calls 会原样回传 API):
    // write_file 内容等参数里的密钥若不扫描,敏感扫描形同虚设(攻防审计2 S6 锚定)
    if (Array.isArray(m.tool_calls)) {
      let tcChanged = false;
      const tool_calls = m.tool_calls.map((tc) => {
        if (tc && typeof tc.arguments === 'string') {
          const a = transform(tc.arguments);
          if (a !== tc.arguments) { tcChanged = true; return { ...tc, arguments: a }; }
        }
        return tc;
      });
      if (tcChanged) nm = { ...nm, tool_calls };
    }
    return nm;
  });
  return { messages: out, findings };
}

/* ---------------- 审计日志(userData/audit/audit-YYYY-MM.jsonl) ---------------- */
function auditDir(store) {
  return path.join(store.baseDir(), 'audit');
}

function auditAppend(store, entry) {
  try {
    if (!store || !store.config) return;
    const sec = store.config.security || {};
    if (sec.auditLog === false) return;
    const dir = auditDir(store);
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const file = path.join(dir, `audit-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
    const rec = { t: Date.now(), ...entry };
    if (sec.logFullContent && entry.messages) {
      rec.contentSnapshot = JSON.stringify(entry.messages).slice(0, 120000);
    }
    delete rec.messages;
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) { /* 审计失败不阻断主流程 */ }
}

function auditStats(store) {
  const dir = auditDir(store);
  const out = { files: 0, bytes: 0, entries: 0, dir };
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return out; }
  out.files = names.length;
  const d = new Date();
  const cur = `audit-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`;
  for (const f of names) {
    try {
      const st = fs.statSync(path.join(dir, f));
      out.bytes += st.size;
      if (f === cur) {
        out.entries = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length;
      }
    } catch (_) { /* ignore */ }
  }
  return out;
}

function auditClear(store) {
  const dir = auditDir(store);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return 0; }
  let n = 0;
  for (const f of names) {
    try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* ignore */ }
  }
  return n;
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return String(url || '').slice(0, 60); }
}

module.exports = {
  SENSITIVE_PATTERNS,
  assertUrlAllowed,
  filterMessages,
  auditAppend,
  auditStats,
  auditClear,
  auditDir,
  hostOf,
};
