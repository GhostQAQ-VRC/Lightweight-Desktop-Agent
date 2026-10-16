// 生图适配器(v0.50.0):统一 imageGenerate 入口,按供应商 type 分协议。
// 只支持 openai 兼容(/v1/images/generations)与 gemini(generateContent 返回 inline image)。
// 零 electron 依赖,http 走统一出口;返回 [{ base64, mime }]。
const http = require('./http');

const HEURISTIC = /\b(dall-?e|gpt-image|flux|sd[3x]?|stable-?diffusion|midjourney|mj-|cogview|wanx|seedream|irag|qwen-image|kolors)\b/i;

function isImageModel(name) {
  return HEURISTIC.test(String(name || ''));
}

// OpenAI 兼容:POST {base}/images/generations { model, prompt, n, size } → data[{ b64_json | url }]
async function viaOpenAI(provider, apiKey, args) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
  const body = {
    model: args.model,
    prompt: args.prompt,
    n: 1, // v0.50.0 用户裁定:张数功能删除,固定 1 张
  };
  if (args.size) body.size = args.size;
  const res = await http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`生图失败(${res.status}): ${text.slice(0, 300)}`);
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('生图返回不是 JSON'); }
  const out = [];
  for (const d of j.data || []) {
    if (d.b64_json) out.push({ base64: d.b64_json, mime: 'image/png' });
    else if (d.url) {
      const r2 = await http.fetch(d.url, {});
      const buf = Buffer.from(await r2.arrayBuffer());
      out.push({ base64: buf.toString('base64'), mime: r2.headers.get('content-type') || 'image/png' });
    }
  }
  if (!out.length) throw new Error('生图返回为空');
  return out;
}

// Gemini:generateContent 响应里 candidates[].content.parts[].inlineData
async function viaGemini(provider, apiKey, args) {
  const base = String(provider.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`生图失败(${res.status}): ${text.slice(0, 300)}`);
  let j;
  try { j = JSON.parse(text); } catch (_) { throw new Error('生图返回不是 JSON'); }
  const out = [];
  for (const cand of j.candidates || []) {
    for (const part of (cand.content && cand.content.parts) || []) {
      if (part.inlineData && part.inlineData.data) {
        out.push({ base64: part.inlineData.data, mime: part.inlineData.mimeType || 'image/png' });
      }
    }
  }
  if (!out.length) throw new Error('生图返回为空(该模型可能不支持纯图输出)');
  return out;
}

// 统一入口:provider = { type, baseUrl }, apiKey, args = { model, prompt, size, count }
async function imageGenerate(provider, apiKey, args) {
  if (!args || !String(args.prompt || '').trim()) throw new Error('缺少生图提示词');
  if (!args.model) throw new Error('未指定生图模型');
  if (provider.type === 'gemini') return viaGemini(provider, apiKey, args);
  return viaOpenAI(provider, apiKey, args);
}

module.exports = { imageGenerate, isImageModel, HEURISTIC };
