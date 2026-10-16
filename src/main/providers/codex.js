// OpenAI Responses 协议适配器(ChatGPT 账号登录专用,走 chatgpt.com/backend-api/codex)
// 与 Chat Completions 的差异:输入是 items 序列(function_call/function_call_output 平铺)、
// 工具定义扁平、SSE 事件为 response.* 增量流。
const { sseData, httpError } = require('./sse');
const { parseDataUrl } = require('../attachments');
const http = require('../http');

function joinUrl(base, path) {
  return String(base || '').trim().replace(/\/+$/, '') + '/' + path;
}

// 内部消息(OpenAI 风格)→ Responses input items
function toResponsesInput(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        const parts = m.content.map((p) => {
          if (p && p.type === 'image_url') {
            const img = parseDataUrl(p.image_url && p.image_url.url);
            return img ? { type: 'input_image', image_url: `data:${img.mime};base64,${img.data}` } : null;
          }
          return { type: 'input_text', text: (p && p.text) || '' };
        }).filter(Boolean);
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: [{ type: 'input_text', text: String(m.content || '') }] });
      }
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (m.content) out.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content) }] });
        for (const tc of m.tool_calls) {
          out.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments || '{}' });
        }
      } else {
        out.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content || '') }] });
      }
    } else if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content || '') });
    }
  }
  return out;
}

// Chat 格式工具定义({type:'function', function:{name,…}})→ Responses 扁平格式
function toResponsesTools(tools) {
  return (tools || []).map((t) => {
    const fn = (t && t.function) ? t.function : t;
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: (fn.parameters && fn.parameters.properties) ? fn.parameters : { type: 'object', properties: {} },
    };
  });
}

async function streamChat(p) {
  const url = joinUrl(p.baseUrl, 'responses');
  if (p.guard) p.guard(url);
  const reqHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${p.apiKey || ''}`,
  };
  if (p.oauthAccountId) reqHeaders['chatgpt-account-id'] = p.oauthAccountId;

  const body = {
    model: p.model,
    instructions: p.system || '',
    input: toResponsesInput(p.messages),
    tools: toResponsesTools(p.tools),
    stream: true,
    store: false,
  };
  if (p.reasoning && p.reasoning.level && ['minimal', 'low', 'medium', 'high', 'xhigh', 'none'].includes(p.reasoning.level)) {
    body.reasoning = { effort: p.reasoning.level, summary: 'auto' };
  }

  const res = await http.fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(body),
    signal: p.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = 'stop';
  const calls = [];
  const pending = new Map(); // Responses item id → {callId, name, args}

  for await (const data of sseData(res, p.signal)) {
    let j;
    try { j = JSON.parse(data); } catch (_) { continue; }
    const type = j.type || '';
    if (type === 'response.output_item.added' && j.item && j.item.type === 'function_call') {
      pending.set(j.item.id, { callId: j.item.call_id || j.item.id, name: j.item.name || '', args: j.item.arguments || '' });
    } else if (type === 'response.function_call_arguments.delta') {
      const cur = pending.get(j.item_id);
      if (cur) cur.args += j.delta || '';
    } else if (type === 'response.output_item.done' && j.item && j.item.type === 'function_call') {
      const cur = pending.get(j.item.id);
      calls.push({
        id: j.item.call_id || (cur && cur.callId) || j.item.id,
        name: j.item.name || (cur && cur.name) || '',
        arguments: j.item.arguments || (cur && cur.args) || '{}',
      });
      pending.delete(j.item.id);
    } else if (type === 'response.output_text.delta') {
      content += j.delta || '';
      if (p.onText && j.delta) p.onText(j.delta);
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      reasoning += j.delta || '';
      if (p.onReasoning && j.delta) p.onReasoning(j.delta);
    } else if (type === 'response.completed' && j.response) {
      const u = j.response.usage || {};
      usage = {
        prompt_tokens: u.input_tokens || 0,
        completion_tokens: u.output_tokens || 0,
        cached: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
      };
      finishReason = calls.length ? 'tool_calls' : 'stop';
    } else if (type === 'response.failed') {
      const err = (j.response && j.response.error) || {};
      throw new Error(err.message || 'ChatGPT 请求失败');
    } else if (j.error) {
      throw new Error(j.error.message || 'ChatGPT 流错误');
    }
  }

  return { content, reasoning, toolCalls: calls, usage, finishReason };
}

// Codex 端点没有公开的模型清单接口,返回常见可用集(用户可手动添加)
async function listModels(baseUrl, apiKey, guard) {
  return ['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5-codex'];
}

module.exports = { streamChat, listModels };
