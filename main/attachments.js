// 附件(图片/文件)处理:主进程侧的校验与多模态消息组装。
// 渲染端通过 <input type=file>/拖拽/粘贴用 FileReader 采集(沙箱内、无路径读取),
// 载荷经 chat:send 到这里做二次校验:数量/大小/MIME 白名单 —— 即使渲染进程被攻破,
// 越界数据也进不了会话落盘、发不到服务商。本模块保持零依赖,可被 providers 适配器引用。
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'ini', 'toml',
  'cfg', 'conf', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs',
  'go', 'rs', 'sql', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'vue', 'svelte', 'astro',
  'dart', 'lua', 'pl', 'r', 'gitignore', 'editorconfig', 'env',
  // Unity / VRChat 常见文本资产
  'shader', 'cginc', 'hlsl', 'glsl', 'asmdef', 'unity', 'prefab', 'asset', 'meta', 'uxml', 'uss',
]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // 单图 10MB(base64 后约 13.3MB)
const MAX_TEXT_BYTES = 1024 * 1024;         // 文本文件 1MB(超出直接拒绝,渲染端同样预检)
const MAX_TEXT_CHARS = 200000;              // 送入模型前截断,防止撑爆上下文
const MAX_ATTACHMENTS = 8;                  // 每条消息附件数上限
const IMAGE_TOKEN_ESTIMATE = 1500;          // 无精确视觉 token 计数时的固定估算

const extOf = (name) => {
  const base = String(name || '').split(/[\\/]/).pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : (base.startsWith('.') ? base.slice(1).toLowerCase() : '');
};

// 图片按 MIME 判定;其余按扩展名归为可内联文本;null = 不支持的类型
function kindOf(name, mime) {
  const m = String(mime || '').toLowerCase();
  if (m && IMAGE_MIMES.includes(m)) return 'image';
  const ext = extOf(name);
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif') return 'image';
  if (ext && TEXT_EXTS.has(ext)) return 'text';
  if (m && m.startsWith('text/')) return 'text';
  if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/toml'].includes(m)) return 'text';
  return null;
}

const cleanName = (name) => String(name || '').split(/[\\/]/).pop().slice(0, 120) || '附件';

// base64 dataURL → { mime, data };非法返回 null
function parseDataUrl(u) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(u || ''));
  if (!m) return null;
  return { mime: m[1].toLowerCase(), data: m[2].replace(/\s+/g, '') };
}

// 渲染端上传的附件载荷 → 干净数组;非法项的原因收集到 errors(不阻断合法部分)
function normalizeIncoming(list) {
  const out = [];
  const errors = [];
  if (list === undefined || list === null) return { attachments: out, errors };
  if (!Array.isArray(list)) return { attachments: out, errors: ['附件格式错误'] };
  if (list.length > MAX_ATTACHMENTS) errors.push(`附件最多 ${MAX_ATTACHMENTS} 个,已忽略多余的 ${list.length - MAX_ATTACHMENTS} 个`);
  for (const raw of list.slice(0, MAX_ATTACHMENTS)) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const name = cleanName(a.name);
    const kind = kindOf(name, a.mime);
    if (!kind) { errors.push(`「${name}」不是支持的类型(图片或文本文件)`); continue; }
    const item = { id: String(a.id || '').slice(0, 64) || undefined, name, mime: String(a.mime || '').slice(0, 80), kind, size: parseInt(a.size, 10) || 0 };
    if (kind === 'image') {
      const parsed = parseDataUrl(a.dataUrl);
      const bytes = parsed ? Math.floor(parsed.data.length * 3 / 4) : 0;
      if (!parsed || !IMAGE_MIMES.includes(parsed.mime)) { errors.push(`「${name}」图片数据无效`); continue; }
      if (bytes > MAX_IMAGE_BYTES) { errors.push(`「${name}」超过图片大小上限(10MB)`); continue; }
      item.dataUrl = `data:${parsed.mime};base64,${parsed.data}`;
      item.size = bytes;
    } else {
      if (typeof a.text !== 'string' || !a.text.length) { errors.push(`「${name}」文件内容为空或读取失败`); continue; }
      if (a.text.length > MAX_TEXT_BYTES) { errors.push(`「${name}」超过文件大小上限(1MB)`); continue; }
      item.text = a.text;
      item.size = Buffer.byteLength(a.text, 'utf8');
    }
    out.push(item);
  }
  return { attachments: out, errors };
}

// 文本附件 → 内联进用户正文的围栏块(敏感扫描因此天然覆盖文本附件)
function attachmentTextBlock(a) {
  const body = String(a.text || '').slice(0, MAX_TEXT_CHARS);
  const cut = String(a.text || '').length > MAX_TEXT_CHARS ? '\n[... 内容过长已截断 ...]' : '';
  return `[用户附加文件:${a.name}]\n\`\`\`\n${body}${cut}\n\`\`\``;
}

// 会话里的 user 消息 → 发给模型的内部 content:
// 无附件 → 字符串(与旧格式完全一致);有附件 → OpenAI 多模态数组
// (文本附件内联进 text part,图片作为 image_url part;三协议适配器再各自转换)
function composeUserContent(m) {
  const atts = Array.isArray(m && m.attachments) ? m.attachments : [];
  const imgs = atts.filter((a) => a && a.kind === 'image' && typeof a.dataUrl === 'string');
  const texts = atts.filter((a) => a && a.kind === 'text' && typeof a.text === 'string');
  const base = String((m && m.content) || '');
  if (!imgs.length && !texts.length) return base;
  let text = base;
  for (const t of texts) text += (text ? '\n\n' : '') + attachmentTextBlock(t);
  const parts = [{ type: 'text', text: text || '(见附件)' }];
  for (const img of imgs) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  return parts;
}

// content(字符串或多模态数组)→ 纯文本(供摘要/敏感文本估算等)
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

const imageCount = (content) => (Array.isArray(content) ? content.filter((p) => p && p.type === 'image_url').length : 0);

module.exports = {
  IMAGE_MIMES, TEXT_EXTS,
  MAX_IMAGE_BYTES, MAX_TEXT_BYTES, MAX_TEXT_CHARS, MAX_ATTACHMENTS, IMAGE_TOKEN_ESTIMATE,
  extOf, kindOf, cleanName, parseDataUrl,
  normalizeIncoming, attachmentTextBlock, composeUserContent, contentToText, imageCount,
};
