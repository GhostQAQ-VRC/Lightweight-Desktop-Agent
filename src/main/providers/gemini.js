// Google Gemini 协议适配器(generateContent,streamGenerateContent + SSE)
const { sseData, httpError, randomId } = require('./sse');
const modelCaps = require('../modelCaps');
const { parseDataUrl } = require('../attachments');
const http = require('../http');

function joinUrl(base, path) {
  return String(base || '').trim().replace(/\/+$/, '') + '/' + path;
}

// Gemini 只接受 OpenAPI 子集:类型统一大写、剔除 additionalProperties/$schema
function cleanSchema(node) {
  if (node === undefined || node === null) return undefined;
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'additionalProperties') continue;
    if (k === 'type' && typeof v === 'string') { out.type = v.toUpperCase(); continue; }
    out[k] = cleanSchema(v);
  }
  return out;
}

// 内部 content(字符串或 OpenAI 多模态数组)→ Gemini parts
function partsFromContent(content) {
  if (!Array.isArray(content)) return [{ text: content || '(空)' }];
  const parts = [];
  for (const p of content) {
    if (p && p.type === 'text' && typeof p.text === 'string') {
      parts.push({ text: p.text });
    } else if (p && p.type === 'image_url') {
      const img = parseDataUrl(p.image_url && p.image_url.url);
      if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    }
  }
  return parts.length ? parts : [{ text: '(空)' }];
}

function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: partsFromContent(m.content) });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); } catch (_) { args = {}; }
        parts.push({ functionCall: { name: tc.name, args } });
      }
      if (!parts.length) parts.push({ text: '(空)' });
      contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'tool', response: { result: m.content || '' } } }],
      });
    }
  }
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push(c);
  }
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: '(请继续)' }] });
  }
  return merged;
}

async function streamChat(p) {
  // OAuth 账号登录(Gemini CLI 同款):走 Cloud Code 内部端点,标准 body 包进 request 信封
  const isOauth = p.oauth === 'gemini';
  const url = isOauth
    ? 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
    : joinUrl(p.baseUrl, `v1beta/models/${encodeURIComponent(p.model)}:streamGenerateContent`) + '?alt=sse';
  if (p.guard) p.guard(url);
  const reqHeaders = { 'content-type': 'application/json' };
  if (isOauth) {
    if (p.apiKey) reqHeaders.authorization = `Bearer ${p.apiKey}`;
  } else if (p.apiKey) {
    reqHeaders['x-goog-api-key'] = p.apiKey;
  }

  const body = { contents: toGeminiContents(p.messages) };
  if (p.system) body.systemInstruction = { parts: [{ text: p.system }] };
  if (p.temperature !== undefined && p.temperature !== null) {
    body.generationConfig = body.generationConfig || {};
    body.generationConfig.temperature = p.temperature;
  }
  if (p.reasoning && p.reasoning.level) {
    const tc = modelCaps.geminiThinking(p.model, p.reasoning.level, p.reasoning.budget);
    if (tc) {
      body.generationConfig = body.generationConfig || {};
      body.generationConfig.thinkingConfig = tc;
    }
  }
  if (p.tools && p.tools.length) {
    body.tools = [
      {
        functionDeclarations: p.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: cleanSchema(t.parameters),
        })),
      },
    ];
  }

  const res = await http.fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(isOauth ? { model: `models/${p.model}`, request: body } : body),
    signal: p.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = '';
  let usage = null;
  let finishReason = null;
  const calls = [];

  for await (const data of sseData(res, p.signal)) {
    let j;
    try { j = JSON.parse(data); } catch (_) { continue; }
    if (j.error) throw new Error(j.error.message || 'Gemini 流错误');
    if (j.usageMetadata) {
      usage = {
        prompt_tokens: j.usageMetadata.promptTokenCount,
        completion_tokens: j.usageMetadata.candidatesTokenCount,
        cached: j.usageMetadata.cachedContentTokenCount || 0,
      };
    }
    const cand = j.candidates && j.candidates[0];
    if (!cand) continue;
    if (cand.finishReason) finishReason = cand.finishReason;
    const parts = (cand.content && cand.content.parts) || [];
    for (const part of parts) {
      if (part.functionCall && part.functionCall.name) {
        calls.push({
          id: randomId('call'),
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        });
      } else if (typeof part.text === 'string' && part.text) {
        if (part.thought) {
          if (p.onReasoning) p.onReasoning(part.text);
        } else {
          content += part.text;
          if (p.onText) p.onText(part.text);
        }
      }
    }
  }

  return { content, reasoning: '', toolCalls: calls, usage, finishReason };
}

async function listModels(baseUrl, apiKey, guard) {
  const url = joinUrl(baseUrl, 'v1beta/models?pageSize=200');
  if (guard) guard(url);
  const res = await http.fetch(url, {
    headers: apiKey ? { 'x-goog-api-key': apiKey } : {},
  });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const ids = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

module.exports = { streamChat, listModels, toGeminiContents };
