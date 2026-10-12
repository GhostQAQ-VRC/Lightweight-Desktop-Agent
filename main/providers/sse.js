// SSE 流解析:把 fetch 响应体逐行拆成 data: 载荷
async function* sseData(res, signal) {
  if (!res.body) throw new Error('响应没有内容流(服务端或中转站返回了空响应)');
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    // 兜底:流结束时残留的一行
    if (buf.startsWith('data:')) yield buf.slice(5).trim();
  } finally {
    try { reader.releaseLock(); } catch (_) { /* ignore */ }
  }
}

async function httpError(res) {
  let text = '';
  try { text = await res.text(); } catch (_) { /* ignore */ }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || j.error.msg || j.error.type)) || j.message || j.msg || text;
  } catch (_) { /* 保留原文 */ }
  return new Error(`请求失败 (HTTP ${res.status}): ${String(msg).slice(0, 400)}`);
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

module.exports = { sseData, httpError, randomId };
