// 上下文压缩策略(v0.56.0):按 token 阈值决定何时压缩。
// 优先级:按模型预设 > GPT 专属规则(模型名含 GPT) > 系统默认百分比;窗口优先取预设,其次 GPT 规则,
// 再次供应商手动 ctxLimit,最后 models.dev 快照。窗口未知(0)时退回旧的「按消息条数」逻辑。
const modelCaps = require('./modelCaps.js');

const DEFAULTS = {
  enabled: true,          // 关闭后回到旧的按条数压缩(maxHistory)
  mode: 'standard',       // 'standard' 标准 | 'cache' 保缓存命中 | 'extreme' 极致压缩
  defaultPercent: 80,     // 系统默认:窗口的 80% 触发
  gpt: {
    enabled: true,        // GPT 专属规则总开关
    window: 272000,       // GPT 模型统一按 272K 窗口计算
    percent: 90,          // 272K 的 90% = 244800 tokens 触发
  },
  models: [],             // [{ providerId, model, window, percent }] 按模型覆盖
};

const MODES = ['standard', 'cache', 'extreme'];

// 每种模式的压缩力度:保留条数 / 摘要额外要求 / 工具结果截断上限
function modeConfig(mode, settings) {
  const ctx = (settings && settings.context) || {};
  const baseKeep = Math.max(2, parseInt(ctx.keepRecent, 10) || 8);
  if (mode === 'cache') {
    // 保缓存:保留更多原文,压缩后进入冷却期(见 resolvePolicy.cacheSlack),减少摘要重写
    return { mode: 'cache', keepRecent: Math.max(baseKeep, 12), summarySuffix: '' };
  }
  if (mode === 'extreme') {
    // 极致:只留极少数原文,摘要更短,工具结果截断更狠
    return {
      mode: 'extreme',
      keepRecent: Math.min(baseKeep, 3),
      summarySuffix: '\n\n(极致压缩模式:请控制在 200 字以内,只保留用户目标、关键决定、未完成事项与必要的文件路径。不要保留细节与寒暄。)',
    };
  }
  return { mode: 'standard', keepRecent: baseKeep, summarySuffix: '' };
}

function isGptModel(model) {
  return /gpt/i.test(String(model || ''));
}

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(10, Math.round(n)));
}

// 把用户配置补全成完整结构(旧配置没有 compress 字段时也能用)
function normalizeCompress(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const gpt = cfg.gpt && typeof cfg.gpt === 'object' ? cfg.gpt : {};
  const models = [];
  if (Array.isArray(cfg.models)) {
    for (const m of cfg.models) {
      if (!m || !m.model) continue;
      models.push({
        providerId: m.providerId ? String(m.providerId) : '',
        model: String(m.model),
        window: Number(m.window) > 0 ? Math.round(Number(m.window)) : 0,
        percent: Number(m.percent) > 0 ? clampPercent(m.percent, DEFAULTS.defaultPercent) : 0,
      });
    }
  }
  return {
    enabled: cfg.enabled !== false,
    mode: MODES.includes(cfg.mode) ? cfg.mode : DEFAULTS.mode,
    defaultPercent: clampPercent(cfg.defaultPercent, DEFAULTS.defaultPercent),
    gpt: {
      enabled: gpt.enabled !== false,
      window: Number(gpt.window) > 0 ? Math.round(Number(gpt.window)) : DEFAULTS.gpt.window,
      percent: clampPercent(gpt.percent, DEFAULTS.gpt.percent),
    },
    models,
  };
}

// 解析本次请求生效的压缩策略
// 返回 { enabled, gpt, preset, window, windowSource, percent, percentSource, threshold, hardCap }
function resolvePolicy({ settings, provider, model, db }) {
  const ctx = (settings && settings.context) || {};
  const cfg = normalizeCompress(ctx.compress);
  const gptModel = isGptModel(model);
  let preset = null;
  for (const m of cfg.models) {
    if (m.model !== String(model || '')) continue;
    if (m.providerId && provider && m.providerId !== provider.id) continue;
    preset = m;
    break;
  }

  // 模型自身窗口:区分「用户手动 ctxLimit」与「上游 /models 带回的 ctxLimit」——
  // GPT 家族规则只让手动值覆盖,上游值仍排在 GPT 规则之后。
  const rec = provider && provider.modelCaps && provider.modelCaps[model] ? provider.modelCaps[model] : null;
  const recCtx = rec ? Number(rec.ctxLimit) || 0 : 0;
  const ctxFromUpstream = !!(rec && (rec.source === 'upstream' || rec.ctxSource === 'upstream'));
  const manualCtx = recCtx > 0 && !ctxFromUpstream ? recCtx : 0;
  const upstreamCtx = recCtx > 0 && ctxFromUpstream ? recCtx : 0;
  const dbCtx = Number(modelCaps.contextLimit(model, db)) || 0;

  let window = 0;
  let windowSource = 'none';
  if (preset && preset.window > 0) {
    window = preset.window;
    windowSource = 'preset';
  } else if (manualCtx > 0) {
    // 用户手动填的 ctxLimit 优先于 GPT 家族规则(显式覆盖)
    window = manualCtx;
    windowSource = 'manual';
  } else if (gptModel && cfg.gpt.enabled) {
    window = cfg.gpt.window;
    windowSource = 'gpt';
  } else if (upstreamCtx > 0) {
    window = upstreamCtx;
    windowSource = 'upstream';
  } else if (dbCtx > 0) {
    window = dbCtx;
    windowSource = 'modeldb';
  }

  let percent = cfg.defaultPercent;
  let percentSource = 'default';
  if (preset && preset.percent > 0) {
    percent = preset.percent;
    percentSource = 'preset';
  } else if (gptModel && cfg.gpt.enabled) {
    percent = cfg.gpt.percent;
    percentSource = 'gpt';
  }

  if (!cfg.enabled) {
    window = 0;
    percent = 0;
    windowSource = 'off';
    percentSource = 'off';
  }
  const threshold = window > 0 && percent > 0 ? Math.floor((window * percent) / 100) : 0;
  // 缓存模式的冷却幅度:窗口的 3%(至少 1000 tokens)—— 压缩后再涨这么多才再次压缩,
  // 避免每次请求都重写摘要导致 prompt cache 全失效。
  const cacheSlack = cfg.mode === 'cache' && window > 0 ? Math.max(1000, Math.floor(window * 0.03)) : 0;
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    gpt: gptModel,
    preset: !!preset,
    window,
    windowSource,
    percent,
    percentSource,
    threshold,
    cacheSlack,
    hardCap: 400, // 兜底:即使 token 估算偏低,消息数超过这个值也强制压缩
  };
}

module.exports = { DEFAULTS, MODES, isGptModel, clampPercent, normalizeCompress, resolvePolicy, modeConfig };
