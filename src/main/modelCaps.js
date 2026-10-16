// 模型推理能力库:按模型 ID 匹配官方宣称的推理强度(档位以各家官方规格为准)
// style 决定协议传参方式:
//   openai_effort → reasoning_effort(minimal/low/medium/high,部分支持 none/xhigh)
//   qwen          → enable_thinking + thinking_budget(数值)
//   zhipu         → thinking:{type: enabled|disabled}
//   anthropic     → thinking:{type:'enabled', budget_tokens}(数值,可自定义)
//   gemini        → generationConfig.thinkingConfig.thinkingBudget(数值,可自定义/动态-1)
//   fixed         → 始终深度推理
// levels 里可含 'custom'(数值预算型)与 'dynamic'(Gemini 动态预算)

// —— 模型能力数据库(models.dev 快照,8400+ 模型;支持在线更新) ——
const fs = require('fs');
const path = require('path');
const BUNDLED_DB_FILE = path.join(__dirname, '..', '..', 'resources', 'model-db.json');
let modelDb = null; // { updatedAt, count, models: { lowerId: {r, p, o?, if?} } }

function setModelDb(db) { modelDb = db && db.models ? db : null; }
function getBundledDb() {
  try { return JSON.parse(fs.readFileSync(BUNDLED_DB_FILE, 'utf8')); } catch (_) { return null; }
}
function getUserDbFile(store) { return store ? path.join(store.baseDir(), 'model-db.json') : null; }
function getModelDb(store) {
  if (store) {
    try {
      const f = getUserDbFile(store);
      if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { /* ignore */ }
  }
  return modelDb || getBundledDb();
}
function transformModelDb(raw) {
  const models = {};
  let count = 0;
  for (const [prov, pv] of Object.entries(raw || {})) {
    for (const [mid, m] of Object.entries((pv && pv.models) || {})) {
      if (!m || !m.id) continue;
      const key = String(m.id).toLowerCase();
      const rec = { r: !!m.reasoning, p: String(prov) };
      if (Array.isArray(m.reasoning_options)) {
        const opts = [];
        for (const o of m.reasoning_options) {
          if (o.type === 'effort' && Array.isArray(o.values)) opts.push({ t: 'effort', v: o.values });
          else if (o.type) opts.push({ t: o.type });
        }
        if (opts.length) rec.o = opts;
      }
      // 计价(美元/百万 token):费用统计用;无价的模型不计费
      if (m.cost && (Number(m.cost.input) > 0 || Number(m.cost.output) > 0)) {
        rec.c = { i: Number(m.cost.input) || 0, o: Number(m.cost.output) || 0 };
        if (m.cost.cache_read != null) rec.cr = Number(m.cost.cache_read) || 0;
      }
      // 上下文窗口(token):底部用量条「上下文已用 x%」分母用
      const lc = m.limit && Number(m.limit.context);
      if (lc > 0) rec.lc = lc;
      models[key] = rec;
      count++;
    }
  }
  return { updatedAt: new Date().toISOString(), source: 'https://models.dev', count, models };
}

// 模型计价:返回 {i, o, cr}(美元/百万 token)或 null(无价不可计费)
function pricingFor(store, model) {
  const db = getModelDb(store);
  const rec = db && db.models && db.models[String(model || '').toLowerCase()];
  return rec && rec.c ? { i: rec.c.i || 0, o: rec.c.o || 0, cr: rec.cr || 0 } : null;
}

const RULES = [
  // —— OpenAI 系 ——
  { re: /^gpt-5\.1-codex-max/i, style: 'openai_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { re: /^gpt-5\.1/i, style: 'openai_effort', levels: ['none', 'low', 'medium', 'high'] },
  { re: /^gpt-5/i, style: 'openai_effort', levels: ['minimal', 'low', 'medium', 'high'] },
  { re: /^o[134](-|\b)/i, style: 'openai_effort', levels: ['low', 'medium', 'high'] },
  { re: /^o1-mini|^o1-preview/i, style: 'none', levels: [] },
  // —— DeepSeek:R 系/Reasoner 始终推理;V3.1+ 混合推理(开关 + 预算,兼容 vLLM/SGLang/中转站) ——
  { re: /deepseek-r(?:\d|easoner)/i, style: 'fixed', levels: ['on'] },
  { re: /deepseek-v[2-9]|deepseek-hybrid/i, style: 'qwen', levels: ['off', 'on', 'low', 'medium', 'high', 'custom'] },
  // —— 智谱 GLM:4 代起全部支持思考开关 ——
  { re: /^glm-[1-9]/i, style: 'zhipu', levels: ['off', 'on'] },
  // —— Qwen 全系(3 代起支持 enable_thinking + 预算;老版本走开关) ——
  { re: /qwen/i, style: 'qwen', levels: ['off', 'low', 'medium', 'high', 'custom'] },
  // —— 豆包 / 字节 seed 系 ——
  { re: /^doubao|seed-1\.[5-9]|seed-oss/i, style: 'zhipu', levels: ['off', 'on'] },
  // —— Kimi ——
  { re: /kimi-k2-thinking|kimi-thinking/i, style: 'fixed', levels: ['on'] },
  // —— Claude ——
  { re: /claude-(3-7|3\.7|[4-9]|opus|sonnet|haiku)/i, style: 'anthropic', levels: ['off', 'low', 'medium', 'high', 'custom'] },
  // —— Gemini(Pro 不支持关闭;2.0-flash 无思考预算) ——
  { re: /^gemini-2\.0-flash(?!-thinking)/i, style: 'none', levels: [] },
  { re: /gemini-2\.5-pro|gemini-3-pro/i, style: 'gemini', levels: ['low', 'medium', 'high', 'dynamic', 'custom'] },
  { re: /gemini-[23]\.\d|gemini-2\.[5-9]|gemini-3/i, style: 'gemini', levels: ['off', 'low', 'medium', 'high', 'dynamic', 'custom'] },
  // —— xAI ——
  { re: /grok-[4-9]/i, style: 'openai_effort', levels: ['low', 'high'] },
  // —— 小米 MiMo / MiniMax M1(推理模型) ——
  { re: /mimo/i, style: 'fixed', levels: ['on'] },
  { re: /minimax-m\d/i, style: 'fixed', levels: ['on'] },
  // —— 通用兜底:名字带 thinking / reasoner / reasoning / -r1 ——
  { re: /thinking|reasoner|reasoning|-r1\b/i, style: 'fixed', levels: ['on'] },
];

// 手动配置可选的推理方式(供应商设置里逐模型指定)
const MANUAL_STYLES = {
  auto: { label: '自动(按内置库识别)' },
  none: { label: '不支持推理', levels: [] },
  openai_effort: { label: 'effort 档位(关闭/极简/低/中/高/超高/最大)', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  qwen: { label: '开关 + 预算(enable_thinking)', levels: ['off', 'low', 'medium', 'high', 'custom'] },
  zhipu: { label: '思考开关(thinking.type)', levels: ['off', 'on'] },
  fixed: { label: '始终深度推理', levels: ['on'] },
};

const DEFAULT_LEVEL = {
  openai_effort: 'medium',
  qwen: 'medium',
  zhipu: 'on',
  anthropic: 'off',
  gemini: 'medium',
  fixed: 'on',
  none: null,
};

const LEVEL_LABEL = {
  minimal: '极简', none: '关闭', off: '关闭', low: '低', medium: '中',
  high: '高', xhigh: '超高', max: '最大', dynamic: '动态', on: '深度推理', custom: '自定义预算…',
};

const BUDGET = {
  anthropic: { low: 4096, medium: 8192, high: 16384, min: 1024, max: 64000 },
  gemini: { off: 0, low: 1024, medium: 8192, high: 24576, max: 32768 },
  qwen: { low: 2048, medium: 8192, high: 16384, min: 1024, max: 38912 },
};

// 数值预算型 style(可选自定义数值)
const NUMERIC_STYLES = ['qwen', 'anthropic', 'gemini'];

// 默认档:优先 medium,否则取该模型支持的保守档
function defaultFor(style, levels) {
  const d = DEFAULT_LEVEL[style];
  if (d && levels.includes(d)) return d;
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('low')) return 'low';
  return levels[0] || null;
}

// 模型上下文窗口(token):models.dev limit.context;无数据返回 0
function contextLimit(modelId, db) {
  const entry = dbLookup(modelId, db);
  return (entry && Number(entry.lc)) || 0;
}

function dbLookup(modelId, db) {
  const d = db || modelDb;
  if (!d || !d.models) return null;
  const id = String(modelId || '').toLowerCase();
  if (d.models[id]) return d.models[id];
  if (id.includes('/')) {
    const stripped = id.split('/').pop();
    if (d.models[stripped]) return d.models[stripped];
  }
  return null;
}

// 从 db 条目(reasoning_options)映射官方档位
function levelsFromDb(entry) {
  const levels = [];
  let hasBudget = false;
  for (const o of entry.o || []) {
    if (o.t === 'toggle') { if (!levels.includes('off')) levels.unshift('off'); if (!levels.includes('on')) levels.push('on'); }
    else if (o.t === 'effort' && Array.isArray(o.v)) for (const v of o.v) if (!levels.includes(v)) levels.push(v);
    else if (o.t === 'budget') { hasBudget = true; if (!levels.includes('custom')) levels.push('custom'); }
  }
  if (!levels.length) levels.push('off', 'on');
  return { levels: [...new Set(levels)], hasBudget };
}

// 按模型 ID 解析能力;优先级:手动覆盖 > 上游探测 > 官方数据库 > 内置家族规则
function forModel(modelId, providerCaps, dbOverride) {
  const id = String(modelId || '');
  if (providerCaps && providerCaps[id] && providerCaps[id].levels) {
    const c = providerCaps[id];
    // 手动配置可带 defaultLevel(供应商编辑器里逐模型选定的默认档位),非法值回退计算
    const defaultLevel = (c.defaultLevel && c.levels.includes(c.defaultLevel))
      ? c.defaultLevel
      : defaultFor(c.style, c.levels);
    return { ...c, defaultLevel };
  }
  for (const r of RULES) {
    if (r.re.test(id)) {
      const base = { style: r.style, levels: [...r.levels], offValue: r.offValue, source: 'builtin', defaultLevel: defaultFor(r.style, r.levels) };
      // 官方数据库校正:db 明确不支持 → 不支持;db 有官方 effort 档位且与家族风格相容 → 采用官方档位
      const entry = dbLookup(id, dbOverride);
      if (entry) {
        if (!entry.r) return { style: 'none', levels: [], source: 'models.dev', defaultLevel: null };
        if (entry.o) {
          const efforts = (entry.o.find((o) => o.t === 'effort') || {}).v || [];
          const hasToggle = entry.o.some((o) => o.t === 'toggle');
          if (efforts.length && (r.style === 'openai_effort' || r.style === 'none')) {
            const levels = (hasToggle ? ['off'] : []).concat(efforts);
            return { style: 'openai_effort', levels: [...new Set(levels)], source: 'models.dev', defaultLevel: defaultFor('openai_effort', levels) };
          }
        }
      }
      return base;
    }
  }
  // 家族规则未命中 → 官方数据库兜底
  const entry = dbLookup(id, dbOverride);
  if (entry) {
    if (!entry.r) return { style: 'none', levels: [], source: 'models.dev', defaultLevel: null };
    const { levels, hasBudget } = levelsFromDb(entry);
    const effortVals = (entry.o && (entry.o.find((o) => o.t === 'effort') || {}).v) || [];
    const style = hasBudget || entry.o && entry.o.some((o) => o.t === 'budget') ? 'qwen' : (effortVals.length ? 'openai_effort' : 'qwen');
    return { style, levels, source: 'models.dev', defaultLevel: defaultFor(style, levels) };
  }
  return null;
}

// —— 各协议请求体映射(纯函数,便于测试) ——

// OpenAI 兼容系:按 style 生成附加字段;budget 用于 qwen 自定义
function openaiReasonBody(style, level, offValue, budget) {
  const body = {};
  if (style === 'openai_effort') {
    if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'].includes(level)) body.reasoning_effort = level;
    else if (level === 'off' && offValue) body.reasoning_effort = offValue;
  } else if (style === 'qwen') {
    if (level === 'off') { body.enable_thinking = false; return body; }
    body.enable_thinking = true;
    if (level === 'custom' && budget) body.thinking_budget = clampBudget('qwen', budget);
    else if (BUDGET.qwen[level]) body.thinking_budget = BUDGET.qwen[level];
  } else if (style === 'zhipu') {
    body.thinking = { type: level === 'off' ? 'disabled' : 'enabled' };
  }
  return body;
}

function clampBudget(style, budget) {
  const b = BUDGET[style];
  if (!b) return budget;
  return Math.min(b.max || 1e9, Math.max(b.min || 1, Math.round(Number(budget) || 0)));
}

// Anthropic:thinking 块 + 需要的 max_tokens(预算必须小于 max_tokens);支持自定义预算
function anthropicThinking(level, currentMaxTokens, budget) {
  if (level === 'off' || level === 'none') return { thinking: undefined, maxTokens: currentMaxTokens };
  let budgetTokens;
  if (level === 'custom') budgetTokens = clampBudget('anthropic', budget || 4096);
  else budgetTokens = BUDGET.anthropic[level];
  if (!budgetTokens) return { thinking: undefined, maxTokens: currentMaxTokens };
  return {
    thinking: { type: 'enabled', budget_tokens: budgetTokens },
    maxTokens: Math.max(currentMaxTokens || 4096, budgetTokens + 4096),
  };
}

// Gemini:thinkingBudget;pro 系不支持关闭 → off 时省略;dynamic = -1;支持自定义
function geminiThinking(modelId, level, budget) {
  if (level === 'off') {
    if (/pro/i.test(String(modelId || ''))) return undefined;
    return { thinkingBudget: 0 };
  }
  if (level === 'dynamic') return { thinkingBudget: -1 };
  if (level === 'custom') {
    const v = clampBudget('gemini', budget || 8192);
    if (/pro/i.test(String(modelId || '')) && v < 128) return { thinkingBudget: 128 };
    return { thinkingBudget: v };
  }
  if (BUDGET.gemini[level] !== undefined) return { thinkingBudget: BUDGET.gemini[level] };
  return undefined;
}

// 从上游 /models 载荷提取能力(OpenRouter 风格 supported_parameters 等)
function capsFromModelsPayload(payload) {
  const caps = {};
  const list = (payload && Array.isArray(payload.data)) ? payload.data : [];
  for (const entry of list) {
    if (!entry || !entry.id) continue;
    const sp = entry.supported_parameters || [];
    const levels = [];
    if (sp.includes('reasoning_effort')) levels.push('low', 'medium', 'high');
    if (sp.includes('enable_thinking')) levels.unshift('off');
    if (levels.length) {
      caps[entry.id] = {
        style: sp.includes('enable_thinking') ? 'qwen' : 'openai_effort',
        levels: [...new Set(levels)],
        source: 'upstream',
      };
    }
  }
  return caps;
}

module.exports = {
  RULES, LEVEL_LABEL, DEFAULT_LEVEL, BUDGET, NUMERIC_STYLES, MANUAL_STYLES,
  forModel, contextLimit, openaiReasonBody, anthropicThinking, geminiThinking, capsFromModelsPayload, clampBudget,
  setModelDb, getModelDb, transformModelDb, pricingFor,
};
