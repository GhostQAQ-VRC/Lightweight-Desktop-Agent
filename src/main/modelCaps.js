// 模型推理能力库:按模型 ID 匹配官方宣称的推理强度(档位以各家官方规格为准)
// style 决定协议传参方式:
//   openai_effort  → reasoning_effort(minimal/low/medium/high,部分支持 none/xhigh/max)
//   thinking_effort → thinking:{type} 开关 + reasoning_effort 档位(DeepSeek V3.2/V4+ 官方制式)
//   qwen           → enable_thinking + thinking_budget(数值)
//   zhipu          → thinking:{type: enabled|disabled}
//   anthropic      → thinking:{type:'enabled', budget_tokens}(数值,可自定义)
//   gemini         → generationConfig.thinkingConfig.thinkingBudget(数值,可自定义/动态-1)
//   fixed          → 始终深度推理
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
// —— 官方供应商映射:models.dev 里第一方命名空间(deepseek/xai/google/openai/…)的条目最可信 ——
// 聚合商(openrouter/nano-gpt/llmgacht 等)条目常缺推理标注,r:false 只代表“没标”不代表确认没有
const OFFICIAL_PROVIDERS = [
  [/^deepseek/, /^deepseek/],
  [/^grok/, /^xai/],
  [/^gemini/, /^google/],
  [/^(gpt-|chatgpt|o[134](-|\b))/, /^openai/],
  [/^claude/, /^anthropic/],
  [/^qwen/, /^alibaba/],
  [/^glm/, /^zhipu/],
  [/^kimi/, /^moonshot/],
  [/^(doubao|seed-)/, /^(bytedance|volcengine)/],
  [/^minimax/, /^minimax/],
];
// 该模型条目是否来自其家族的官方供应商(合并取优与 r:false 采信都区分官方/聚合商)
function isOfficialProvider(modelId, prov) {
  const id = String(modelId || '').toLowerCase();
  const p = String(prov || '').toLowerCase();
  return OFFICIAL_PROVIDERS.some(([fam, off]) => fam.test(id) && off.test(p));
}

function transformModelDb(raw) {
  const models = {};
  for (const [prov, pv] of Object.entries(raw || {})) {
    for (const [mid, m] of Object.entries((pv && pv.models) || {})) {
      if (!m || !m.id) continue;
      const key = String(m.id).toLowerCase();
      const rec = { r: !!m.reasoning, p: String(prov) };
      if (Array.isArray(m.reasoning_options)) {
        const opts = [];
        for (const o of m.reasoning_options) {
          if (o.type === 'effort' && Array.isArray(o.values)) {
            const vals = o.values.filter((v) => typeof v === 'string' && v); // 滤掉 null 值(如 sarvam 系)
            if (vals.length) opts.push({ t: 'effort', v: vals });
          } else if (o.type === 'toggle') opts.push({ t: 'toggle' });
          else if (o.type === 'budget' || o.type === 'budget_tokens') opts.push({ t: 'budget' });
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
      // 同 id 多供应商合并取优:官方 > 带官方档位(o)> r:true > 其他;
      // 同级冲突(如 alibaba 国际站与 alibaba-cn 对同一模型标注不一致)取"有推理"方
      // —— 标注有推理是肯定性知识,且另一官方地区证实了该能力;
      // 计价/上下文窗口取有值者补缺(不同供应商登记的维度不同)
      const prev = models[key];
      if (!prev) { models[key] = rec; continue; }
      const rank = (e) => (isOfficialProvider(key, e.p) ? 4 : e.o ? 3 : e.r ? 2 : 1);
      const better = (cand, cur) => {
        const rc = rank(cand), rk = rank(cur);
        if (rc !== rk) return rc > rk ? cand : cur;
        if (cand.r !== cur.r) return cand.r ? cand : cur;
        return cand; // 全同 → 后写者(数据更新)
      };
      const win = better(rec, prev);
      const lose = win === rec ? prev : rec;
      models[key] = {
        r: win.r,
        p: win.p,
        o: win.o || lose.o,
        c: win.c || lose.c,
        cr: win.cr != null ? win.cr : lose.cr,
        lc: win.lc || lose.lc,
      };
    }
  }
  return { updatedAt: new Date().toISOString(), source: 'https://models.dev', count: Object.keys(models).length, models };
}

// 模型计价:返回 {i, o, cr}(美元/百万 token)或 null(无价不可计费)
function pricingFor(store, model) {
  const db = getModelDb(store);
  const rec = db && db.models && db.models[String(model || '').toLowerCase()];
  return rec && rec.c ? { i: rec.c.i || 0, o: rec.c.o || 0, cr: rec.cr || 0 } : null;
}

const RULES = [
  // —— OpenAI 系(版本开放:gpt/o 系任意代际,档位由官方库校正;例外先行) ——
  { re: /^gpt-5\.1-codex-max/i, style: 'openai_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { re: /^gpt-5\.1/i, style: 'openai_effort', levels: ['none', 'low', 'medium', 'high'] },
  { re: /^o1-mini|^o1-preview/i, style: 'none', levels: [] },
  // 推理代际 = gpt-5 起;两位数代际(gpt-10/12…)延续。gpt-4/4o 是无推理代际,由官方库亲标 r:false 收敛
  { re: /^gpt-(?:[5-9]|\d{2,})/i, style: 'openai_effort', levels: ['minimal', 'low', 'medium', 'high'] },
  { re: /^o\d+(-|\b)/i, style: 'openai_effort', levels: ['low', 'medium', 'high'] },
  // —— DeepSeek:R 系/Reasoner 始终推理;V3.2/V4+ 官方 effort 制(thinking.type 开关 + reasoning_effort,
  //     官方映射 minimal→low、medium/xhigh→high、max/ultra→max,默认 effort=high);V2~V3.1 老混合推理
  //     (开关 + 预算,兼容 vLLM/SGLang/中转站)。顺序敏感:V3.2/两位代际规则必须在前 ——
  { re: /deepseek-r(?:\d|easoner)/i, style: 'fixed', levels: ['on'] },
  { re: /deepseek-v3\.2|deepseek-v\d\d|deepseek-v[4-9]|deepseek-flash/i, style: 'thinking_effort', levels: ['off', 'low', 'high', 'max'] },
  { re: /deepseek-v\d|deepseek-hybrid/i, style: 'qwen', levels: ['off', 'on', 'low', 'medium', 'high', 'custom'] },
  // —— 智谱 GLM:4 代起思考开关;5.x 起 effort 代际由数据库校正 ——
  { re: /^glm-\d/i, style: 'zhipu', levels: ['off', 'on'] },
  // —— Qwen 全系(3 代起支持 enable_thinking + 预算;老版本走开关) ——
  { re: /qwen/i, style: 'qwen', levels: ['off', 'low', 'medium', 'high', 'custom'] },
  // —— 豆包 / 字节 seed 系 ——
  { re: /^doubao|seed-\d|seed-oss/i, style: 'zhipu', levels: ['off', 'on'] },
  // —— Kimi:thinking 变体始终推理;K2.5+/K3+ 代际带思考开关(官方 effort 制由数据库校正),
  //     K2 及其日期/加速变体(-0905/-turbo)是非推理模型,不得吞入 ——
  { re: /kimi-k2-thinking|kimi-thinking/i, style: 'fixed', levels: ['on'] },
  { re: /kimi-k(?!2(?:$|-))\d/i, style: 'zhipu', levels: ['off', 'on'] },
  // —— Claude ——
  { re: /claude-(\d|opus|sonnet|haiku)/i, style: 'anthropic', levels: ['off', 'low', 'medium', 'high', 'custom'] },
  // —— Gemini(Pro 系不支持关闭;2.0-flash 无思考预算) ——
  { re: /^gemini-2\.0-flash(?!-thinking)/i, style: 'none', levels: [] },
  { re: /gemini-\d+(\.\d+)?-pro/i, style: 'gemini', levels: ['low', 'medium', 'high', 'dynamic', 'custom'] },
  { re: /gemini-\d/i, style: 'gemini', levels: ['off', 'low', 'medium', 'high', 'dynamic', 'custom'] },
  // —— xAI ——
  { re: /grok-\d+/i, style: 'openai_effort', levels: ['low', 'high'] },
  // —— 小米 MiMo / MiniMax M 系(推理模型) ——
  { re: /mimo/i, style: 'fixed', levels: ['on'] },
  { re: /minimax-m\d+/i, style: 'fixed', levels: ['on'] },
  // —— 通用兜底:名字带 thinking / reasoner / reasoning / -r1 ——
  { re: /thinking|reasoner|reasoning|-r1\b/i, style: 'fixed', levels: ['on'] },
];

// 手动配置可选的推理方式(供应商设置里逐模型指定)
const MANUAL_STYLES = {
  auto: { label: '自动(按内置库识别)' },
  none: { label: '不支持推理', levels: [] },
  openai_effort: { label: 'effort 档位(关闭/极简/低/中/高/超高/最大)', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  thinking_effort: { label: '思考开关 + effort 档位(DeepSeek V4 式)', levels: ['off', 'low', 'high', 'max'] },
  qwen: { label: '开关 + 预算(enable_thinking)', levels: ['off', 'low', 'medium', 'high', 'custom'] },
  zhipu: { label: '思考开关(thinking.type)', levels: ['off', 'on'] },
  fixed: { label: '始终深度推理', levels: ['on'] },
};

const DEFAULT_LEVEL = {
  openai_effort: 'medium',
  thinking_effort: 'high',
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

// 档位强度次序(滑块从左到右:关闭 → 强度递增 → 特殊)
const LEVEL_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'on', 'dynamic', 'custom'];
function sortLevels(levels) {
  const idx = (l) => { const i = LEVEL_ORDER.indexOf(l); return i === -1 ? LEVEL_ORDER.length : i; };
  return [...new Set(levels)].sort((a, b) => idx(a) - idx(b));
}

// 默认档:优先 medium,否则取该模型支持的保守档
function defaultFor(style, levels) {
  const d = DEFAULT_LEVEL[style];
  if (d && levels.includes(d)) return d;
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('low')) return 'low';
  return levels[0] || null;
}

// 模型上下文窗口(token):models.dev limit.context;无数据时用家族兜底(新模型不在快照里时仍能匹配)
// GPT 5+ 按用户规则 272000;4.1/4o 按官方窗口;Claude/Gemini 按家族常规值。
const FAMILY_CTX = [
  { re: /(?:^|[:/])gpt-(?:[5-9]|\d{2,})(?:[.-]|$)/i, ctx: 272000 },
  { re: /(?:^|[:/])gpt-4\.1(?:[.-]|$)/i, ctx: 1047576 },
  { re: /(?:^|[:/])gpt-4o(?:[.-]|$)/i, ctx: 128000 },
  { re: /(?:^|[:/])o[1-9](?:[.-]|$)/i, ctx: 200000 },
  { re: /claude/i, ctx: 200000 },
  { re: /gemini/i, ctx: 1048576 },
];
function contextLimit(modelId, db) {
  const entry = dbLookup(modelId, db);
  const lc = Number(entry && entry.lc) || 0;
  if (lc > 0) return lc;
  const id = String(modelId || '').toLowerCase().trim();
  for (const r of FAMILY_CTX) if (r.re.test(id)) return r.ctx;
  return 0;
}

// 候选核心名:原名 → 短命名空间剥离(cn:glm-5.3-flash / global:gpt-5.4)→ 装饰剥离(normalizeModelId)
function coreCandidates(modelId) {
  const raw = String(modelId || '').toLowerCase().trim();
  const out = [raw];
  const ns = raw.match(/^([a-z_-]{1,10}):(.+)$/);
  if (ns && ns[2]) out.push(ns[2]);
  for (const c of [...out]) {
    const n = normalizeModelId(c);
    if (n) out.push(n);
  }
  return [...new Set(out)].filter(Boolean);
}

// 能力库查找的容错层。供应商会改写模型 id:挂命名空间(cn:glm-5.3-flash / global:gpt-5.4)、
// 挂后缀(-0731 / :free / @eu)、粘连装饰(cnglm-5.3-flash)。查找顺序:各候选精确 →
// '/' 剥离 → 边界感知最长前缀(接缝必须是分隔符,防 gpt-4 误吞 gpt-4o)→ 包含匹配
// (键长 ≥4,两侧接缝为分隔符或 ≤3 字符粘连;仅采纳带真实能力数据的条目,聚合商裸 r:false 不采纳)
function dbLookup(modelId, db) {
  const d = db || modelDb;
  if (!d || !d.models) return null;
  const raw = String(modelId || '').toLowerCase().trim();
  if (!raw) return null;
  const candidates = coreCandidates(raw);
  for (const id of candidates) {
    if (d.models[id]) return d.models[id];
    if (id.includes('/')) {
      const stripped = id.split('/').pop();
      if (d.models[stripped]) return d.models[stripped];
    }
  }
  for (const id of candidates) {
    let best = null;
    for (const key in d.models) {
      if (key.length >= id.length || !id.startsWith(key)) continue;
      const seam = id.charAt(key.length);
      if (seam === '-' || seam === '.' || seam === '_' || seam === ':' || seam === '@') {
        if (!best || key.length > best.length) best = key;
      }
    }
    if (best) return d.models[best];
  }
  let containBest = null;
  for (const key in d.models) {
    if (key.length < 4) continue;
    const idx = raw.indexOf(key);
    if (idx < 0) continue;
    const L = raw.slice(0, idx);
    const R = raw.slice(idx + key.length);
    const lOk = L === '' || /[-_.:@]$/.test(L) || (L.length <= 3 && /^[a-z0-9]+$/.test(L));
    const rOk = R === '' || /^[-_.:@]/.test(R) || (R.length <= 3 && /^[a-z0-9]/.test(R));
    if (!lOk || !rOk) continue;
    if (!containBest || key.length > containBest.length) containBest = key;
  }
  if (containBest) {
    const e = d.models[containBest];
    if (e && (e.r || e.o)) return e;
  }
  return null;
}

// 从 db 条目提取官方档位数据
function dbOptionsOf(entry) {
  const o = entry && entry.o ? entry.o : [];
  return {
    efforts: sortLevels((o.find((x) => x.t === 'effort') || {}).v || []),
    hasToggle: o.some((x) => x.t === 'toggle'),
    hasBudget: o.some((x) => x.t === 'budget' || x.t === 'budget_tokens'), // budget_tokens = 旧版快照遗留写法
  };
}

// 模型名装饰剥离：部分供应商在 id 前后粘连区域/发布记号（cnglm-5.3-flash = cn + glm-5.3-flash）。
// 只剥白名单记号（cn2/cn/intl/global，可无分隔符粘连），剥离结果必须真的解析出能力才被采纳，
// 因此误剥（如 user → er…）只会返回原来的"未识别"，不会误报能力。
const DECORATION_TOKENS = ['cn2', 'cn', 'intl', 'global'];
function normalizeModelId(modelId) {
  const raw = String(modelId || '').toLowerCase().trim();
  if (!raw) return null;
  let s = raw;
  let prev = null;
  while (prev !== s && s) {
    prev = s;
    for (const t of DECORATION_TOKENS) {
      if (s !== t && s.startsWith(t)) s = s.slice(t.length);
      if (s !== t && s.endsWith(t)) s = s.slice(0, -t.length);
    }
    s = s.replace(/^[-_.]+|[-_.]+$/g, '');
  }
  return s && s !== raw ? s : null;
}

// 按模型 ID 解析能力;优先级:手动覆盖 > 上游探测 > 内置家族规则(官方数据库校正)> 官方数据库兜底。
// 解析按候选核心名循环:原名 → 命名空间剥离(cn:glm-5.3-flash)→ 装饰剥离(cnglm-5.3-flash),
// 任一候选解析出能力即采纳;全部落空才是真正的"未识别"。
function forModel(modelId, providerCaps, dbOverride) {
  const id = String(modelId || '');
  for (const cand of coreCandidates(id)) {
    const c = resolveModel(cand, providerCaps, dbOverride);
    if (c) return c;
  }
  return null;
}

function resolveModel(id, providerCaps, dbOverride) {
  // 手动覆盖仅在档位集合非空时生效 —— 空 levels 的条目只是 ctxLimit 载体(最大上下文),
  // 不能短路自动解析(曾致填过上下文的模型全部显示"不支持推理")
  if (providerCaps && providerCaps[id] && Array.isArray(providerCaps[id].levels) && providerCaps[id].levels.length) {
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
      // 官方数据库校正。采信规则:① 官方供应商亲标 r:false → 确实不支持;
      // ② 聚合商的 r:false 不覆盖内置规则(只是"没标",grok-4 案例);③ db 有官方 effort 档位 → 按风格采纳。
      const entry = dbLookup(id, dbOverride);
      if (!entry) return base;
      if (!entry.r && isOfficialProvider(id, entry.p)) {
        return { style: 'none', levels: [], source: 'models.dev', defaultLevel: null };
      }
      const { efforts, hasToggle, hasBudget } = dbOptionsOf(entry);
      if (efforts.length && (r.style === 'openai_effort' || r.style === 'none')) {
        // effort 制:toggle 补 off 前缀;官方已给 none 档时不再加(都是"关闭")
        const levels = sortLevels((hasToggle && !efforts.includes('none') ? ['off'] : []).concat(efforts));
        return { style: 'openai_effort', levels, source: 'models.dev', defaultLevel: defaultFor('openai_effort', levels) };
      }
      if ((efforts.length || hasToggle) && r.style === 'thinking_effort') {
        // DeepSeek V4 式:官方枚举 {low,high,max}(medium/xhigh 等由协议归一,不上滑块);toggle/none → off
        const canon = efforts.filter((v) => ['low', 'high', 'max'].includes(v));
        if (!canon.length) return base;
        const levels = sortLevels(['off'].concat(canon));
        return { style: 'thinking_effort', levels, source: 'models.dev', defaultLevel: defaultFor('thinking_effort', levels) };
      }
      if (efforts.length && r.style === 'fixed') {
        // 官方档位推翻"始终推理"假设(如 minimax-m2 已改 effort 制)
        const levels = sortLevels((efforts.includes('none') ? [] : ['off']).concat(efforts));
        return { style: 'openai_effort', levels, source: 'models.dev', defaultLevel: defaultFor('openai_effort', levels) };
      }
      if (efforts.length && r.style === 'zhipu' && !hasToggle) {
        // 开关家族的官方 effort 代际(GLM-5.x:thinking.type 开关被 reasoning_effort 档位取代)
        const levels = sortLevels(efforts);
        return { style: 'openai_effort', levels, source: 'models.dev', defaultLevel: defaultFor('openai_effort', levels) };
      }
      if (hasBudget && r.style === 'qwen' && !base.levels.includes('custom')) {
        base.levels = sortLevels(base.levels.concat(['custom']));
        base.defaultLevel = defaultFor(base.style, base.levels);
      }
      return base;
    }
  }
  // 家族规则未命中 → 官方数据库兜底(此路径 db 是唯一知识来源,r:false 可信)
  const entry = dbLookup(id, dbOverride);
  if (entry) {
    if (!entry.r) return { style: 'none', levels: [], source: 'models.dev', defaultLevel: null };
    const { efforts, hasToggle, hasBudget } = dbOptionsOf(entry);
    let style;
    let levels;
    if (efforts.length) {
      style = 'openai_effort';
      levels = sortLevels((hasToggle && !efforts.includes('none') ? ['off'] : []).concat(efforts));
    } else if (hasBudget) {
      style = 'qwen';
      levels = hasToggle ? ['off', 'on', 'custom'] : ['on', 'custom'];
    } else {
      // 仅开关:thinking.type 是 DeepSeek/GLM/豆包/Kimi 系的通用形态(enable_thinking 限 Qwen,
      // 而 Qwen 家族 id 都命中 /qwen/ 规则,走不到这里)
      style = 'zhipu';
      levels = ['off', 'on'];
    }
    return { style, levels, source: 'models.dev', defaultLevel: defaultFor(style, levels) };
  }
  return null;
}

// 上游探测结果合并进既有能力表:手动配置(source:'manual')最优先不被覆盖,其余以新探测为准
function mergeUpstreamCaps(existing, caps) {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(caps || {})) {
    const cur = out[k];
    if (cur && cur.source === 'manual') {
      // 手动条目:风格/档位保持手动,但允许补上游上下文长度(手动没填时,标记 ctxSource)
      if (!Number(cur.ctxLimit) && Number(v.ctxLimit)) out[k] = { ...cur, ctxLimit: Number(v.ctxLimit), ctxSource: 'upstream' };
      continue;
    }
    out[k] = v;
  }
  return out;
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
  } else if (style === 'thinking_effort') {
    // DeepSeek V3.2/V4+:thinking.type 开关 + reasoning_effort 档位;
    // 客户端把各家属别名归一到官方输出枚举 {low,high,max}(medium/xhigh→high 等),对严格中转站也安全
    if (level === 'off') { body.thinking = { type: 'disabled' }; return body; }
    body.thinking = { type: 'enabled' };
    const MAP = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max' };
    body.reasoning_effort = MAP[level] || 'high';
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
    const rec = {};
    // 上游若直接返回上下文长度(OpenRouter 的 context_length / vLLM 的 max_model_len)则一并吸收
    const ctx = Number(entry.context_length || entry.max_context_length || entry.max_model_len) || 0;
    if (ctx > 0) rec.ctxLimit = Math.round(ctx);
    if (levels.length) {
      rec.style = sp.includes('enable_thinking') ? 'qwen' : 'openai_effort';
      rec.levels = [...new Set(levels)];
    }
    if (Object.keys(rec).length) {
      rec.source = 'upstream';
      caps[entry.id] = rec;
    }
  }
  return caps;
}

module.exports = {
  RULES, LEVEL_LABEL, DEFAULT_LEVEL, BUDGET, NUMERIC_STYLES, LEVEL_ORDER, MANUAL_STYLES,
  forModel, contextLimit, openaiReasonBody, anthropicThinking, geminiThinking, capsFromModelsPayload, clampBudget,
  mergeUpstreamCaps, isOfficialProvider,
  setModelDb, getModelDb, transformModelDb, pricingFor,
};
