// OpenAI 兼容协议适配器:覆盖 DeepSeek / 智谱 / Kimi / 通义 / OpenRouter /
// SiliconFlow / Groq / xAI / Ollama / LM Studio 等几乎所有主流与本地服务商
const { sseData, httpError, randomId } = require('./sse');
const http = require('../http');
const modelCaps = require('../modelCaps');

// BaseURL 规则(与 Cherry Studio 一致):
//   以 # 结尾        → 去掉 # 后按原样使用
//   路径以 /v数字 结尾 → 按原样使用(如 /v1、/v4)
//   其他             → 自动补 /v1
function normalizeBase(raw) {
  let base = String(raw || '').trim();
  if (!base) throw new Error('BaseURL 未配置');
  if (base.endsWith('#')) return base.slice(0, -1);
  if (/\/v\d+\/?$/i.test(base)) return base;
  return base.replace(/\/+$/, '') + '/v1';
}

function toOpenaiMessages(messages, system, reasoning) {
  // DeepSeek V4 系(thinking_effort)带 tools 时官方要求完整回传 reasoning_content,否则 400;
  // 其他模型不发(内部字段 _reasoning 只在此按需转正,避免严格服务商拒收未知字段)
  const passReasoning = reasoning && reasoning.style === 'thinking_effort';
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (passReasoning && typeof m._reasoning === 'string' && m._reasoning) msg.reasoning_content = m._reasoning;
      if (m.tool_calls && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return out;
}

// GitHub Copilot 的短令牌(tid= 前缀)需要编辑器伪装头,否则 API 直接 401
function copilotHeaders(apiKey) {
  if (!/^tid=/.test(apiKey || '')) return null;
  return {
    'editor-version': 'vscode/1.96.2',
    'editor-plugin-version': 'copilot-chat/0.26.2',
    'x-github-api-version': '2025-04-01',
    'copilot-integration-id': 'vscode-chat',
    'user-agent': 'GitHubCopilotChat/0.26.2',
  };
}

async function streamChat(p) {
  const url = normalizeBase(p.baseUrl) + '/chat/completions';
  if (p.guard) p.guard(url);
  const headers = { 'content-type': 'application/json' };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  Object.assign(headers, copilotHeaders(p.apiKey) || {});

  const body = {
    model: p.model,
    messages: toOpenaiMessages(p.messages, p.system, p.reasoning),
    stream: true,
  };
  if (p.temperature !== undefined && p.temperature !== null) body.temperature = p.temperature;
  if (p.reasoning && p.reasoning.level) {
    Object.assign(body, modelCaps.openaiReasonBody(p.reasoning.style, p.reasoning.level, p.reasoning.offValue, p.reasoning.budget));
  }
  if (p.tools && p.tools.length) {
    body.tools = p.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  const res = await http.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: p.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  const tcAcc = new Map(); // index → {id, name, arguments}

  for await (const data of sseData(res, p.signal)) {
    if (data === '[DONE]') break;
    let j;
    try { j = JSON.parse(data); } catch (_) { continue; }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error).slice(0, 300));
    if (j.usage) usage = j.usage;

    const ch = j.choices && j.choices[0];
    if (!ch) continue;
    if (ch.finish_reason) finishReason = ch.finish_reason;
    const d = ch.delta || {};
    if (!d) continue;

    const r = d.reasoning_content !== undefined ? d.reasoning_content : d.reasoning;
    if (typeof r === 'string' && r) {
      reasoning += r;
      if (p.onReasoning) p.onReasoning(r);
    }
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      if (p.onText) p.onText(d.content);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const idx = t.index === undefined ? 0 : t.index;
        if (!tcAcc.has(idx)) tcAcc.set(idx, { id: '', name: '', arguments: '' });
        const acc = tcAcc.get(idx);
        if (t.id) acc.id = t.id;
        if (t.function) {
          if (t.function.name) acc.name += t.function.name;
          if (t.function.arguments) acc.arguments += t.function.arguments;
        }
      }
    }
  }

  const toolCalls = [...tcAcc.values()]
    .filter((t) => t.name)
    .map((t) => ({ id: t.id || randomId('call'), name: t.name, arguments: t.arguments || '{}' }));
  return { content, reasoning, toolCalls, usage, finishReason };
}

async function listModels(baseUrl, apiKey, guard) {
  const url = normalizeBase(baseUrl) + '/models';
  if (guard) guard(url);
  const headers = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  Object.assign(headers, copilotHeaders(apiKey) || {});
  const res = await http.fetch(url, { headers });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const ids = (Array.isArray(j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean).map(String);
  return [...new Set(ids)].sort();
}

// 上游推理能力探测:读取 /models 条目的能力字段(OpenRouter 风格),失败静默返回空
async function fetchCaps(baseUrl, apiKey, guard) {
  try {
    const url = normalizeBase(baseUrl) + '/models';
    if (guard) guard(url);
    const headers = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    Object.assign(headers, copilotHeaders(apiKey) || {});
    const res = await http.fetch(url, { headers });
    if (!res.ok) return {};
    const j = await res.json();
    return modelCaps.capsFromModelsPayload(j);
  } catch (_) {
    return {};
  }
}

module.exports = { streamChat, listModels, fetchCaps, normalizeBase, toOpenaiMessages };
