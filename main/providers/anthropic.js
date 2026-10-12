// Anthropic Messages 协议适配器(Claude 全系)
const { sseData, httpError } = require('./sse');
const modelCaps = require('../modelCaps');
const { parseDataUrl } = require('../attachments');
const http = require('../http');

function joinUrl(base, path) {
  return String(base || '').trim().replace(/\/+$/, '') + '/' + path;
}

function headers(apiKey) {
  // OAuth 账号令牌(claude.ai 登录,sk-ant-oat01-)用 Bearer + beta 头;普通 API Key 用 x-api-key
  if (/^sk-ant-oat01-/.test(apiKey || '')) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    };
  }
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey || '',
    'anthropic-version': '2023-06-01',
  };
}

// 内部 content(字符串或 OpenAI 多模态数组)→ Anthropic blocks
function blocksFromContent(content) {
  if (!Array.isArray(content)) return [{ type: 'text', text: content || '(空)' }];
  const blocks = [];
  for (const p of content) {
    if (p && p.type === 'text' && typeof p.text === 'string') {
      blocks.push({ type: 'text', text: p.text });
    } else if (p && p.type === 'image_url') {
      const img = parseDataUrl(p.image_url && p.image_url.url);
      if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '(空)' }];
}

// 内部消息 → Anthropic 格式:tool 结果合并为 user 消息里的 tool_result 块,
// 并保证相邻同角色合并、首条为 user
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', blocks: blocksFromContent(m.content) });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.arguments || '{}'); } catch (_) { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '(空)' });
      out.push({ role: 'assistant', blocks });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        blocks: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '' }],
      });
    }
  }
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.blocks.push(...m.blocks);
    else merged.push(m);
  }
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', blocks: [{ type: 'text', text: '(请继续)' }] });
  }
  return merged.map((m) => ({ role: m.role, content: m.blocks }));
}

async function streamChat(p) {
  const url = joinUrl(p.baseUrl, 'v1/messages');
  if (p.guard) p.guard(url);
  const body = {
    model: p.model,
    max_tokens: p.maxTokens || 8192,
    stream: true,
    messages: toAnthropicMessages(p.messages),
  };
  if (p.system) body.system = p.system;
  if (p.reasoning && p.reasoning.level && p.reasoning.level !== 'off') {
    // Claude 思考模式:预算必须小于 max_tokens,且开启时不允许自定义 temperature
    const t = modelCaps.anthropicThinking(p.reasoning.level, p.maxTokens || 8192, p.reasoning.budget);
    if (t.thinking) {
      body.thinking = t.thinking;
      body.max_tokens = t.maxTokens;
      delete body.temperature;
    }
  } else if (p.temperature !== undefined && p.temperature !== null) {
    body.temperature = Math.min(1, Math.max(0, p.temperature));
  }
  if (p.tools && p.tools.length) {
    body.tools = p.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    body.tool_choice = { type: 'auto' };
  }

  const res = await http.fetch(url, {
    method: 'POST',
    headers: headers(p.apiKey),
    body: JSON.stringify(body),
    signal: p.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = '';
  let usage = null;
  let stopReason = null;
  const blocks = new Map(); // index → {type, id, name, text, json}

  for await (const data of sseData(res, p.signal)) {
    let j;
    try { j = JSON.parse(data); } catch (_) { continue; }
    switch (j.type) {
      case 'error':
        throw new Error((j.error && j.error.message) || 'Anthropic 流错误');
      case 'content_block_start': {
        const b = j.content_block || {};
        blocks.set(j.index, { type: b.type, id: b.id, name: b.name, text: '', json: '' });
        break;
      }
      case 'content_block_delta': {
        const blk = blocks.get(j.index) || { type: 'text', text: '', json: '' };
        const d = j.delta || {};
        if (d.type === 'text_delta' && d.text) {
          blk.text += d.text;
          content += d.text;
          if (p.onText) p.onText(d.text);
        } else if (d.type === 'thinking_delta' && d.thinking) {
          if (p.onReasoning) p.onReasoning(d.thinking);
        } else if (d.type === 'input_json_delta' && d.partial_json) {
          blk.json += d.partial_json;
        }
        blocks.set(j.index, blk);
        break;
      }
      case 'message_delta':
        if (j.usage) usage = j.usage;
        if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
        break;
      default:
        break;
    }
  }

  const toolCalls = [...blocks.values()]
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.json || '{}' }));
  return { content, reasoning: '', toolCalls, usage, finishReason: stopReason };
}

async function listModels(baseUrl, apiKey, guard) {
  const url = joinUrl(baseUrl, 'v1/models?limit=100');
  if (guard) guard(url);
  const res = await http.fetch(url, { headers: headers(apiKey) });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const ids = (Array.isArray(j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean).map(String);
  return [...new Set(ids)].sort();
}

module.exports = { streamChat, listModels, toAnthropicMessages };
