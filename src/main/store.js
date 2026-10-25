// 配置与会话持久化(纯 JSON 文件,存于 userData 目录)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PRESETS = require('./providers/presets');
const { PRESET_VERSION, DEFAULT_ASSISTANTS, DEFAULT_SKILLS } = require('./promptPresets');

const DEFAULT_SUMMARY_PROMPT =
  '你是对话压缩器。请把用户发来的对话历史压缩成一份要点摘要(不超过500字),必须保留:用户的目标与约束、已完成的步骤、关键文件路径与名称、重要决定、未完成的事项。不要寒暄,直接输出摘要正文。';

let dirs = null;
let config = null;
const convCache = new Map();

const uid = () => crypto.randomUUID();

function seedProviders() {
  return PRESETS.map((p) => ({ ...p, models: [...(p.models || [])], apiKey: '' }));
}

// 子智能体预设:主智能体按职责路由(dispatch_agents 的 agentId);providerId/model 为 null = 跟随主智能体
const DEFAULT_SUBAGENTS = [
  { id: 'researcher', name: '调研员', builtin: true, enabled: true, providerId: null, model: null,
    description: '联网调研与资料汇总:查资料、比较方案、收集多来源信息并给出带出处的结论',
    prompt: '你是调研专员:优先使用 web_search 与 web_fetch 收集多来源信息,交叉验证后输出带来源链接的要点式结论;信息不足时明确说明,不要编造。' },
  { id: 'coder', name: '程序员', builtin: true, enabled: true, providerId: null, model: null,
    description: '写代码 / 改代码 / 跑命令:实现功能、修复报错、重构与验证',
    prompt: '你是资深工程师:先读懂相关文件再动手,改动最小化、风格贴近现有代码;完成后主动运行可用命令验证,并报告改动点与验证结果。' },
  { id: 'reviewer', name: '审阅员', builtin: true, enabled: true, providerId: null, model: null,
    description: '代码审查 / 方案评审:找 bug、安全隐患、边界情况与改进点',
    prompt: '你是严格的审阅者:逐项检查正确性、边界、安全与可维护性,按严重度排序输出问题清单,每条给出位置与修复建议;没有问题也要说明检查了什么。' },
  { id: 'writer', name: '文案师', builtin: true, enabled: true, providerId: null, model: null,
    description: '写作 / 润色 / 翻译:文档、文案、邮件、多语言内容创作',
    prompt: '你是专业文案:先确认受众与语气,输出结构清晰、可直接使用的成稿;需要风格取舍时给出两版对比。' },
  { id: 'analyst', name: '分析师', builtin: true, enabled: true, providerId: null, model: null,
    description: '数据分析 / 表格处理:读数据、算指标、给结论与建议',
    prompt: '你是数据分析师:先核对数据口径,再计算并输出关键数字、趋势与异常点;结论必须能从数据推出,标注假设。' },
  { id: 'tester', name: '测试员', builtin: true, enabled: true, providerId: null, model: null,
    description: '测试设计与执行:设计用例、运行测试、报告复现步骤',
    prompt: '你是 QA 工程师:覆盖正常流/边界/异常,输出可复现的步骤与期望结果;发现缺陷时给出最小复现与严重级别。' },
  { id: 'planner', name: '规划师', builtin: true, enabled: true, providerId: null, model: null,
    description: '任务拆解与计划:把模糊目标变成可执行的分步计划',
    prompt: '你是项目经理:把目标拆成有依赖顺序的阶段与任务,标注每步的产出物与验收标准;风险与前置条件单独列出。' },
];

function seedSubagents() {
  return DEFAULT_SUBAGENTS.map((s) => ({ ...s }));
}

// 团队协同模板:指挥官 = 当前主模型;workers 每人可选不同供应商模型与推理强度(null = 跟随默认)
const DEFAULT_TEAMS = [
  {
    id: 'team-4', name: '团队协同(1 指挥 4 执行)', builtin: true, enabled: true,
    workers: [
      { name: '队员A', providerId: null, model: null, strength: null },
      { name: '队员B', providerId: null, model: null, strength: null },
      { name: '队员C', providerId: null, model: null, strength: null },
      { name: '队员D', providerId: null, model: null, strength: null },
    ],
  },
];

function seedTeams() {
  return DEFAULT_TEAMS.map((t) => ({ ...t, workers: t.workers.map((w) => ({ ...w })) }));
}

function defaultConfig() {
  return {
    providers: seedProviders(),
    assistants: DEFAULT_ASSISTANTS.map((a) => ({ ...a })),
    skills: DEFAULT_SKILLS.map((s) => ({ ...s })),
    subagents: seedSubagents(),
    teams: seedTeams(),
    mcpServers: [],
    bridges: { ssh: [], win: [] }, // v0.52.0 连接桥:SSH(密钥登录)/ Windows(远程桌面)连接条目
    remote: { enabled: false, port: 8629, allowApproval: false, token: '', lanIP: '', accessHost: '', tunnel: { mode: 'off', frp: { path: '', serverAddr: '', serverPort: 7000, authToken: '', remotePort: 18629 }, et: { path: '', name: '', secret: '', server: 'tcp://public.easytier.top:11010' } } }, // v0.54.0 远程控制:局域网网页控制台(token 门禁,默认关);tunnel = 出网隧道(frps 映射 / EasyTier 虚拟组网)
    groups: [{ id: 'default', name: '默认分组', icon: '📁', workspace: '' }],
    agent: { workspace: '', autoApproveFile: true, autoApproveCommand: false, maxIters: 20, shellTimeout: 120 },
    chat: { maxHistory: 40, temperature: 0.7 },
    security: { auditLog: true, logFullContent: false, httpsOnly: true, allowedHosts: '', sensitiveScan: true, sensitiveAction: 'warn' },
    proxy: { mode: 'system', rules: [], bypass: '' },
    sandbox: { fsLock: true, cmdScreen: 'strict' },
    search: { backend: 'duckduckgo', tavilyKey: '', braveKey: '', searxUrl: '', bochaKey: '' },
    context: { strategy: 'trim', keepRecent: 8, toolResultCap: 20000, summaryPrompt: DEFAULT_SUMMARY_PROMPT, compress: { enabled: true, mode: 'standard', defaultPercent: 80, gpt: { enabled: true, window: 272000, percent: 90 }, models: [] } },
    debug: { enabled: true, level: 'info' },
    usage: { prompt: 0, completion: 0, requests: 0, cached: 0, cost: 0, activeMs: 0, byModel: {}, tools: { count: 0, ms: 0 }, times: { wait: 0, think: 0, output: 0 }, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 }, daily: {} },
    reasonChoice: {},
    oauthAccounts: {},
    pluginsLite: {},
    memories: [],
    learnedPrompts: [],
    agentMd: '', // Agent 规约(Agent.md,v0.57.9):用户全局规则,注入每次请求的 system
    dshPlugins: {},
    ui: { theme: 'light', agentMode: true, mode: 'chat', activeAssistantId: 'default', activeSkillId: null, activeTeamId: 'team-4', pureTerminal: false, perfLowMemory: false, glass: false, transparent: false, bgImage: '', sliderZoom: 1, sliderAlign: 'center', sidebarWidth: 264, panelWidth: 400, usageBarStyle: 'compact', forceLowPowerGpu: false, softwareRender: false, codeColors: { tag: '#5b9bff', attr: '#d9a441', str: '#4fb96a', com: '#8b949e' } },
    imageGen: { enabled: false, providers: [], providerId: '', model: '', size: '1024x1024', autoBridge: true },
    blender: { enabled: false, viewportPanel: false, httpPort: 9877, addonPort: 9876, blenderExe: '', workDir: '', holder: '' }, // v0.55.0 Blender 建模工具链(15 工具 + 后端托管 9877 + addon 9876;viewportPanel = 右侧面板「Blender 视口」标签,默认关)
    dev: { terminalCorner: 'bottom-right', terminalShell: 'powershell', memory: false, learning: false, dshHost: false },
    general: { language: 'zh-CN', hardwareAccel: true, taskNotify: true, soundNotify: true, closeToTray: false, keepAwake: false },
    lastModel: null,
  };
}

function init(app) {
  const base = app.getPath('userData');
  const convDir = path.join(base, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  dirs = { base, convDir, configFile: path.join(base, 'config.json') };

  let loaded = null;
  try { loaded = JSON.parse(fs.readFileSync(dirs.configFile, 'utf8')); } catch (_) { /* 首次运行 */ }
  const def = defaultConfig();
  config = { ...def, ...(loaded || {}) };
  for (const k of ['agent', 'chat', 'ui', 'security', 'context', 'debug', 'usage', 'reasonChoice', 'pluginsLite', 'proxy', 'sandbox', 'search', 'dev', 'general', 'dshPlugins', 'bridges', 'remote', 'blender']) {
    config[k] = { ...def[k], ...((loaded && loaded[k]) || {}) };
  }
  // 上下文压缩策略(v0.56.0):旧配置无 compress 字段时补默认;嵌套 gpt 也要合并,避免只读到一半
  const loadedCompress = (config.context && config.context.compress) || {};
  const defCompress = def.context.compress;
  config.context.compress = {
    ...defCompress,
    ...loadedCompress,
    gpt: { ...defCompress.gpt, ...((loadedCompress && loadedCompress.gpt) || {}) },
    models: Array.isArray(loadedCompress.models) ? loadedCompress.models : [],
  };
  // 模式迁移:仅当旧配置存在 agentMode 开关时映射(false→对话,true→受限);全新安装保持默认对话模式
  const loadedUi = (loaded && loaded.ui) || {};
  if (!loadedUi.mode && loadedUi.agentMode !== undefined) {
    config.ui.mode = loadedUi.agentMode === false ? 'chat' : 'restricted';
  }
  if (!Array.isArray(config.providers) || !config.providers.length) config.providers = seedProviders();
  if (!Array.isArray(config.removedPresets)) config.removedPresets = [];
  // Agent 规约:老配置无此字段时补空串(统一为字符串,避免 null 拼进提示词)
  if (typeof config.agentMd !== 'string') config.agentMd = '';
  // 迁移:老版本配置没有助手/技能字段时补默认
  if (!Array.isArray(config.assistants) || !config.assistants.length) config.assistants = DEFAULT_ASSISTANTS.map((a) => ({ ...a }));
  if (!Array.isArray(config.skills)) config.skills = DEFAULT_SKILLS.map((s) => ({ ...s }));
  // 子智能体:老配置无此字段时补预设(用户删除的条目不复活 —— 只补缺失的整字段)
  if (!Array.isArray(config.subagents)) config.subagents = seedSubagents();
  // 团队协同模板:同上;activeTeamId 指向不存在的模板时回退首个
  if (!Array.isArray(config.teams)) config.teams = seedTeams();
  if (!config.teams.some((t) => t.id === config.ui.activeTeamId)) {
    config.ui.activeTeamId = config.teams.length ? config.teams[0].id : '';
  }
  if (!Array.isArray(config.mcpServers)) config.mcpServers = [];
  // 记忆/学习(v0.41):旧配置无此字段时补空数组
  if (!Array.isArray(config.memories)) config.memories = [];
  if (!Array.isArray(config.learnedPrompts)) config.learnedPrompts = [];
  if (!(config.dshPlugins && typeof config.dshPlugins === 'object' && !Array.isArray(config.dshPlugins))) config.dshPlugins = {}; // DSH 代码插件载入开关(实验性)
  // 账号登录供应商(OAuth 预置):新版本自动补进旧配置 —— 不然老用户根本看不到登录入口;未登录零成本,不需要可删
  // v0.57.7:用户主动删过的预置不再复活(记在 config.removedPresets),否则删了下次启动又回来
  if (!Array.isArray(config.removedPresets)) config.removedPresets = [];
  for (const preset of PRESETS.filter((p) => p.oauth)) {
    if (config.removedPresets.includes(preset.id)) continue;
    if (!config.providers.some((x) => x.id === preset.id)) {
      config.providers.push({ ...preset, models: [...(preset.models || [])], apiKey: '' });
    }
  }
  // 预设包版本升级:把新增的预置助手/技能补进旧配置(用户删过的不复活;下次版本提升才会再补)
  mergePresets(config);

  // 供应商多 Key 迁移:apiKey → apiKeys 数组(数组为权威,apiKey 同步首个)
  for (const p of config.providers) {
    if (!Array.isArray(p.apiKeys)) {
      p.apiKeys = (typeof p.apiKey === 'string' && p.apiKey.trim()) ? [p.apiKey.trim()] : [];
    }
    p.apiKeys = p.apiKeys.map((s) => String(s)).filter(Boolean);
    p.apiKey = p.apiKeys[0] || '';
  }
  // 分组迁移:保证默认分组存在
  if (!Array.isArray(config.groups) || !config.groups.length) {
    config.groups = [{ id: 'default', name: '默认分组', icon: '📁', workspace: '' }];
  }
  if (!config.groups.some((g) => g.id === 'default')) {
    config.groups.unshift({ id: 'default', name: '默认分组', icon: '📁', workspace: '' });
  }

  if (!config.agent.workspace) {
    config.agent.workspace = path.join(app.getPath('documents'), 'LiteAgent-workspace');
  }
  try { fs.mkdirSync(config.agent.workspace, { recursive: true }); } catch (_) { /* 目录不可建则保留设置 */ }
  saveNow();
}

function saveNow() {
  // 原子写入:config.json 可达 4MB+(bgImage 内嵌),直接 writeFileSync 被进程退出/崩溃打断会留下截断文件,
  // 下次启动解析失败即丢全部配置 —— 先写临时文件再 rename 保证任一时刻磁盘上都是完整 JSON
  try {
    const tmp = dirs.configFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, dirs.configFile);
  } catch (_) { /* 只读等情况 */ }
}

function updateConfig(patch) {
  patch = patch || {};
  for (const [k, v] of Object.entries(patch)) {
    if (['agent', 'chat', 'ui', 'security', 'context', 'debug', 'usage', 'reasonChoice', 'pluginsLite', 'proxy', 'sandbox', 'search', 'dev', 'general', 'dshPlugins', 'bridges', 'remote', 'blender'].includes(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      config[k] = { ...config[k], ...v };
    } else {
      config[k] = v;
    }
  }
  if (config.agent && config.agent.workspace) {
    try { fs.mkdirSync(config.agent.workspace, { recursive: true }); } catch (_) { /* ignore */ }
  }
  // 不变量:activeTeamId 必须指向存在的模板(删除/恢复/任意路径都自愈)
  if (!Array.isArray(config.teams) || !config.teams.some((t) => t.id === config.ui.activeTeamId)) {
    config.ui.activeTeamId = (Array.isArray(config.teams) && config.teams.length) ? config.teams[0].id : '';
  }
  saveNow();
  return config;
}

const convFile = (id) => path.join(dirs.convDir, `${id}.json`);

// 会话 ID 白名单:渲染端 uid()、远程 r- 前缀、fork uid 均为 [A-Za-z0-9_-]。
// 挡路径穿越(../、盘符、分隔符)——remote HTTP 面(/api/send?convId=)与 IPC 直通本层,是网络攻击的最后一道防线
const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function validConvId(id) {
  return typeof id === 'string' && CONV_ID_RE.test(id);
}

function createConv(id, groupId) {
  if (id && !validConvId(id)) throw new Error(`非法会话 ID: ${String(id).slice(0, 40)}`);
  const conv = {
    id: id || uid(),
    groupId: groupId || 'default',
    title: '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  convCache.set(conv.id, conv);
  saveConv(conv);
  return conv;
}

function getConv(id) {
  if (!id || !validConvId(id)) return null;
  if (convCache.has(id)) return convCache.get(id);
  try {
    const conv = JSON.parse(fs.readFileSync(convFile(id), 'utf8'));
    convCache.set(id, conv);
    return conv;
  } catch (_) {
    return null;
  }
}

function saveConv(conv) {
  if (!conv || !validConvId(conv.id)) return; // 非法 id 一律拒写(防穿越落盘)
  conv.updatedAt = Date.now();
  convCache.set(conv.id, conv);
  try { fs.writeFileSync(convFile(conv.id), JSON.stringify(conv), 'utf8'); } catch (_) { /* ignore */ }
}

function listConvs() {
  let files = [];
  try { files = fs.readdirSync(dirs.convDir).filter((f) => f.endsWith('.json')); } catch (_) { /* ignore */ }
  const list = [];
  for (const f of files) {
    const c = getConv(f.slice(0, -5));
    if (!c) continue;
    // 尾部状态(v0.54.5 侧栏状态色):error 块 → 异常;durationMs → 完成;尾部是 user(待回复) → 无状态
    let lastStatus = null;
    let lastMs = null;
    const msgs = c.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'assistant') break;
      lastStatus = (msgs[i].blocks || []).some((b) => b.type === 'error') ? 'error' : 'done';
      lastMs = Number.isFinite(msgs[i].durationMs) ? msgs[i].durationMs : null;
      break;
    }
    list.push({ id: c.id, groupId: c.groupId || 'default', title: c.title, updatedAt: c.updatedAt, count: (c.messages || []).length, usage: c.usage || null, ctx: c.ctx || null, lastStatus, lastMs });
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

function deleteConv(id) {
  if (!validConvId(id)) return; // 非法 id 拒删(防穿越删除任意 JSON)
  convCache.delete(id);
  try { fs.unlinkSync(convFile(id)); } catch (_) { /* ignore */ }
}

function renameConv(id, title) {
  const c = getConv(id); // getConv 已含白名单
  if (c) {
    c.title = String(title || '').slice(0, 60) || '新对话';
    saveConv(c);
  }
  return c;
}

// 对话分支存储模型:消息的 variants = 除自身外的全部兄弟回复(按时间序),
// pos = 本消息在完整时间序中的位次(无环,可直接 JSON 落盘)。
// 切换分支:messages[index] 与相邻位次的变体互换(循环);dir = ±1 逐步切换,
// to = 直接切到指定位次(分支管理面板点击节点直达,v0.54.5)。
function switchBranch(conv, index, dir, to) {
  const m = conv.messages && conv.messages[index];
  if (!m || !Array.isArray(m.variants) || !m.variants.length) return conv;
  const pos = Number.isInteger(m.pos) ? m.pos : m.variants.length;
  const seq = m.variants.slice();
  seq.splice(Math.min(pos, seq.length), 0, m);
  const total = seq.length;
  if (total < 2) return conv;
  const next = Number.isInteger(to) ? Math.min(Math.max(0, to), total - 1) : (pos + (dir >= 0 ? 1 : -1) + total) % total;
  const target = seq[next];
  if (!target || target === m) return conv;
  target.variants = seq.filter((x) => x !== target);
  target.pos = next;
  conv.messages[index] = target;
  return conv;
}

// 分支为新对话(v0.49.6):以 conv 的 0..index 消息(含该条)为上下文,克隆出一个独立会话。
// variants 结构不克隆(克隆的是活跃分支的线性视图,无环);标题沿用原会话 + 标记。
function forkFrom(conv, index) {
  if (!conv || !Array.isArray(conv.messages)) return null;
  const upto = conv.messages.slice(0, Math.min(index + 1, conv.messages.length));
  if (!upto.length) return null;
  const forked = createConv(null, conv.groupId);
  forked.title = ((conv.title || '对话') + ' · 分支').slice(0, 40);
  forked.messages = JSON.parse(JSON.stringify(upto)).map((m) => {
    const c = { role: m.role, content: m.content };
    if (m.attachments) c.attachments = m.attachments;
    if (m.blocks) c.blocks = m.blocks;
    return c;
  });
  return forked;
}

function exportMarkdown(conv) {
  const lines = [`# ${conv.title}`, '', `> 导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, ''];
  for (const m of conv.messages || []) {
    if (m.role === 'user') {
      lines.push('## 🧑 用户', '', m.content, '');
      for (const a of m.attachments || []) {
        lines.push(`> 📎 附件:${a.name}(${a.kind === 'image' ? '图片' : '文本文件'}, ${a.size} 字节)`);
      }
      if ((m.attachments || []).length) lines.push('');
    } else if (m.role === 'assistant') {
      lines.push('## 🤖 LiteAgent', '');
      for (const b of m.blocks || []) {
        if (b.type === 'reasoning') lines.push('<details><summary>思考过程</summary>', '', b.content, '', '</details>', '');
        else if (b.type === 'text') lines.push(b.content, '');
        else if (b.type === 'tool') {
          lines.push(`> 🔧 工具 **${b.name}**(${b.status})`, '> ```json', `> ${JSON.stringify(b.args).slice(0, 300)}`, '> ```', '');
        } else if (b.type === 'error') lines.push(`> ⚠️ 出错: ${b.message}`, '');
      }
    }
  }
  return lines.join('\n');
}

// 把某分组下的全部会话迁移到另一分组(删除分组时用)
function reassignGroup(fromId, toId) {
  let files = [];
  try { files = fs.readdirSync(dirs.convDir).filter((f) => f.endsWith('.json')); } catch (_) { return; }
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(convFile(f.slice(0, -5)), 'utf8'));
      if ((c.groupId || 'default') === fromId) {
        c.groupId = toId;
        convCache.set(c.id, c);
        fs.writeFileSync(convFile(c.id), JSON.stringify(c), 'utf8');
      }
    } catch (_) { /* 跳过损坏文件 */ }
  }
}

function pluginsDir() {
  return path.join(dirs.base, 'dsh-plugins');
}

// 把缺失的预置助手/技能按 id 补入配置(预设包版本升级时用)
function mergePresets(config) {
  if (!Array.isArray(config.assistants)) config.assistants = [];
  if (!Array.isArray(config.skills)) config.skills = [];
  if ((config.presetVersion || 0) >= PRESET_VERSION) return;
  const haveA = new Set(config.assistants.map((a) => a.id));
  for (const a of DEFAULT_ASSISTANTS) {
    if (!haveA.has(a.id)) config.assistants.push({ ...a });
  }
  const haveS = new Set(config.skills.map((s) => s.id));
  for (const s of DEFAULT_SKILLS) {
    if (!haveS.has(s.id)) config.skills.push({ ...s });
  }
  config.presetVersion = PRESET_VERSION;
}

function baseDir() {
  return dirs.base;
}

module.exports = {
  init,
  get config() { return config; },
  pluginsDir,
  baseDir,
  updateConfig,
  saveNow,
  createConv,
  getConv,
  saveConv,
  listConvs,
  deleteConv,
  renameConv,
  reassignGroup,
  mergePresets,
  exportMarkdown,
  switchBranch,
  forkFrom,
  DEFAULT_SUBAGENTS,
  DEFAULT_TEAMS,
};
