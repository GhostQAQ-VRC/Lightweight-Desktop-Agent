// Agent 调用循环:流式对话 + 工具调用 + 审批,一轮回复可能多次往返模型
const fs = require('fs');
const os = require('os');
const providers = require('./providers');
const tools = require('./tools');
const mcp = require('./mcp');
const security = require('./security');
const debuglog = require('./debuglog');
const modelCaps = require('./modelCaps');
const pluginHost = require('./pluginHost');
const specialty = require('./specialty');
const dshHost = require('./dshHost');
const attachments = require('./attachments');
const sandbox = require('./sandbox');
const oauth = require('./oauth');

// —— 多 API Key 轮换:每次请求轮换使用;401/403/429 且尚未输出内容时,自动换下一个 Key 重试 ——
const keyCursor = new Map();

function pickKey(providerId, pool) {
  const i = keyCursor.get(providerId) || 0;
  keyCursor.set(providerId, i + 1);
  return pool[i % pool.length];
}

async function streamWithKeyPool({ adapter, params, providerId, keyPool, onRotate }) {
  const pool = keyPool.length ? keyPool : [undefined];
  let emitted = false;
  const wrapped = {
    ...params,
    onText: (t) => { emitted = true; if (params.onText) params.onText(t); },
    onReasoning: (t) => { emitted = true; if (params.onReasoning) params.onReasoning(t); },
  };
  let lastErr = null;
  for (let attempt = 0; attempt < pool.length; attempt++) {
    try {
      return await adapter.streamChat({ ...wrapped, apiKey: pickKey(providerId, pool) });
    } catch (e) {
      lastErr = e;
      const retryable = /^请求失败 \(HTTP (401|403|429)\)/.test(String(e.message || ''));
      if (emitted || !retryable || attempt === pool.length - 1) throw e;
      if (onRotate) onRotate(attempt + 1, pool.length);
    }
  }
  throw lastErr;
}

function makeTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 18 ? t.slice(0, 18) + '…' : (t || '新对话');
}

// 从各家 usage 中提取缓存命中 tokens:
//   DeepSeek: prompt_cache_hit_tokens / OpenAI: prompt_tokens_details.cached_tokens
//   Anthropic: cache_read_input_tokens / Gemini: cachedContentTokenCount
function cachedFromUsage(u) {
  if (!u || typeof u !== 'object') return 0;
  if (typeof u.cached_tokens === 'number') return u.cached_tokens;
  if (typeof u.prompt_cache_hit_tokens === 'number') return u.prompt_cache_hit_tokens;
  if (u.prompt_tokens_details && typeof u.prompt_tokens_details.cached_tokens === 'number') return u.prompt_tokens_details.cached_tokens;
  if (typeof u.cache_read_input_tokens === 'number') return u.cache_read_input_tokens;
  if (typeof u.cached === 'number') return u.cached;
  return 0;
}

// token 估算:CJK 约 1 字 1 token,其他约 4 字符 1 token(供服务商不返回用量时兜底)
function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

// 单条消息 token 估算:文本内容 + 图片(按固定值)+ 工具调用参数;content 为多模态数组时也能正确估算
function messageTokens(m) {
  return estimateTokens(attachments.contentToText(m.content))
    + attachments.imageCount(m.content) * attachments.IMAGE_TOKEN_ESTIMATE
    + estimateTokens(JSON.stringify(m.tool_calls || []));
}

// 流式增量合批:高频 text/reasoning 增量攒 40ms 再发,大幅降低 IPC 消息量(流畅的关键)
function makeBatcher(send) {
  let textBuf = '';
  let reasonBuf = '';
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (textBuf) { send({ type: 'text-delta', text: textBuf }); textBuf = ''; }
    if (reasonBuf) { send({ type: 'reasoning-delta', text: reasonBuf }); reasonBuf = ''; }
  };
  return {
    text(t) { textBuf += t; if (!timer) timer = setTimeout(flush, 40); },
    reasoning(t) { reasonBuf += t; if (!timer) timer = setTimeout(flush, 40); },
    flush,
  };
}

// 系统提示词 = 模式能力 + 助手角色(可选)+ 环境 + 技能附加指令(可选)+ 工作规则
// memories/learned(v0.41):长期记忆与学习沉淀,由 runChat 按开发者选项开关传入(注入即上下文消耗)
function buildSystemPrompt({ mode, workspace, assistantPrompt, assistantName, skillPrompt, specialty, memories, learned }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const persona = String(assistantPrompt || '').trim();
  const skill = String(skillPrompt || '').trim();
  const spec = specialty && specialty.text ? String(specialty.text).trim() : '';
  const who = assistantName ? `你是${assistantName}` : '你是 LiteAgent';

  if (mode === 'chat') {
    const parts = [];
    if (persona) {
      parts.push(`${who},用户的 AI 助手。${persona}\n默认使用简体中文(用户使用其他语言时跟随用户)。当前时间: ${now}`);
    } else {
      parts.push(`你是 LiteAgent,一个乐于助人的 AI 助手。默认使用简体中文回答(用户使用其他语言时跟随用户)。当前时间: ${now}`);
    }
    if (skill) parts.push(`# 本次任务附加要求\n${skill}`);
    if (spec) parts.push(`# 技能专精:${specialty.name}\n${spec}\n(注:当前为纯对话模式,无法直接读取知识文件;如需检索知识库请切换到受限/完全模式)`);
    if (Array.isArray(memories) && memories.length) parts.push(memoryBlock(memories));
    if (Array.isArray(learned) && learned.length) parts.push(learnedBlock(learned));
    return parts.join('\n\n');
  }

  const parts = [];
  if (mode === 'restricted') {
    parts.push(`${who},一个运行在用户电脑上的桌面智能体(受限模式:只提供只读工具,不能写文件、不能执行命令)。${persona}`);
    parts.push([
      '# 环境',
      `- 操作系统: ${os.platform()} ${os.release()}(${process.arch})`,
      `- 工作目录: ${workspace}(工具里的相对路径都基于它解析)`,
      `- 当前时间: ${now}`,
    ].join('\n'));
    parts.push([
      '# 可用工具(只读)',
      '- list_dir:浏览目录',
      '- read_file:读取文件',
      '- web_search:联网搜索(查新闻/最新信息/文档)',
      '- web_fetch:抓取网页文本',
      '- ask_user:制定计划遇到关键分歧点时,向用户提出 3 个选项 + 用户自填的四选一请求(会暂停等待回答)',
    ].join('\n'));
  } else {
    parts.push(`${who},一个运行在用户电脑上的桌面智能体,可以通过调用工具来完成实际任务。${persona}`);
    parts.push([
      '# 环境',
      `- 操作系统: ${os.platform()} ${os.release()}(${process.arch})`,
      `- 工作目录: ${workspace}(工具里的相对路径都基于它解析)`,
      `- 当前时间: ${now}`,
    ].join('\n'));
    parts.push([
      '# 可用工具',
      '- list_dir / read_file / write_file:浏览与读写文件',
      '- run_command:执行 Shell 命令(可安装依赖、运行脚本等)',
      '- web_search:联网搜索(查新闻/最新信息/文档)',
      '- web_fetch:抓取网页文本',
      '- ask_user:制定计划/方案遇到关键分歧点时,向用户提出选择题(恰好 3 个由你设计的选项,系统会自动加上"用户自填"入口);用户回答后你再继续',
    ].join('\n'));
  }
  if (mode === 'create') {
    parts.push([
      '# 自我扩展(创造模式专属)',
      '- 你拥有 manage_assistants 与 manage_skills 两个工具,可以查看、创建、修改、删除「助手角色」和「技能」——也就是塑造你自己',
      '- 用户让你"给自己添加角色/技能"或任务适合沉淀为技能时,主动使用它们',
      '- 技能名 2-6 个字、配一个贴切的 emoji;提示词要写完整(身份、做法、输出格式),让一次点击就能稳定复现',
      '- 创建/修改后要用一句话告诉用户加了什么、怎么用',
      '- 不要随意删除用户自建的角色或技能,除非用户明确要求',
    ].join('\n'));
  }
  if (mode === 'team') {
    parts.push([
      '# 团队协同(你是指挥官)',
      '- 你的主模型担任团队指挥官:理解用户目标 → 把任务拆解成自包含的子任务 → 用 dispatch_agents 按队员职责派发(可并行)→ 收到结果后审校、汇总、整合成最终交付',
      '- 队员的模型与推理强度已由团队模板配置,派发时只传 agentId 和 task,不要传 model',
      '- 简单琐碎的事你自己直接做;复杂、可并行、需要多角度的任务才拆分派发',
      '- 队员看不到你们的对话,task 必须写清楚背景、目标与验收标准;对队员结果要把关,发现不合格可重新派发补充',
    ].join('\n'));
  }
  if (skill) parts.push(`# 本次任务附加要求\n${skill}`);
  if (spec) parts.push(`# 技能专精:${specialty.name}\n${spec}`);
  if (Array.isArray(memories) && memories.length) parts.push(memoryBlock(memories));
  if (Array.isArray(learned) && learned.length) parts.push(learnedBlock(learned));
  parts.push([
    '# 工作规则',
    '1. 先读取、后修改:改文件前先读它,不要凭空猜测内容。',
    mode === 'restricted' ? '2. 你处于受限模式,只读不改;用户要求写入/执行时,请说明需要切换到完全模式。' : '2. 删除文件、批量覆盖等破坏性操作,先向用户说明并征得同意。',
    '3. 回复使用简体中文;展示代码用 Markdown 代码块并标注语言。',
    '4. 任务完成后,简要总结做了什么、改动了哪些文件。',
    '5. 思路清楚、直接了当,不要冗长。',
  ].join('\n'));
  return parts.join('\n\n');
}

// 长期记忆块(继承用户积累;工具模式下的 memory_save 由工具定义自说明)
function memoryBlock(memories) {
  return ['# 长期记忆(跨会话继承,回答时主动遵循)']
    .concat(memories.map((m, i) => `${i + 1}. ${String(m.text || '').replace(/\s+/g, ' ')}`))
    .join('\n');
}

// 学习沉淀块(用户纠正/教给 AI 的正确方法)
function learnedBlock(learned) {
  return ['# 用户提示词(学习积累:用户教给你的规矩与偏好,长期有效、优先遵循)']
    .concat(learned.map((l, i) => `${i + 1}. ${String(l.text || '').replace(/\s+/g, ' ')}`))
    .join('\n');
}

// 会话消息(带 blocks)→ 发给模型的内部消息数组,并按 maxHistory 控制上下文长度
function buildHistory(convMessages, maxHistory) {
  const internal = [];
  for (const m of convMessages) {
    if (m.role === 'user') {
      // 无附件时返回字符串(与旧格式一致);有附件时组装为 OpenAI 多模态数组
      internal.push({ role: 'user', content: attachments.composeUserContent(m) });
    } else if (m.role === 'assistant') {
      const blocks = m.blocks || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.content).join('\n\n');
      const toolBlocks = blocks.filter((b) => b.type === 'tool');
      if (toolBlocks.length) {
        internal.push({
          role: 'assistant',
          content: text || '',
          tool_calls: toolBlocks.map((b) => ({
            id: b.id,
            name: b.name,
            arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args || {}),
          })),
        });
        for (const b of toolBlocks) {
          internal.push({ role: 'tool', tool_call_id: b.id, name: b.name, content: b.result || '(无结果)' });
        }
      } else if (text) {
        internal.push({ role: 'assistant', content: text });
      }
    }
  }
  let msgs = internal;
  if (maxHistory > 0 && msgs.length > maxHistory) msgs = msgs.slice(-maxHistory);
  while (msgs.length && msgs[0].role !== 'user') msgs = msgs.slice(1);
  return msgs;
}

// 等待用户对工具调用的批准;超时/中止视为拒绝。
// registry 缺失(无审批通道,如直连调用/集成测试)→ 不阻塞直接放行,避免无人值守场景挂死。
function waitDecision(registry, toolCallId, signal, timeoutMs = 300000) {
  if (!registry) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (registry) registry.decisions.delete(toolCallId);
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const onAbort = () => done(false);
    if (signal) {
      if (signal.aborted) return done(false);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (registry) registry.decisions.set(toolCallId, done);
  });
}

// 等待用户回答 ask_user 问询:应答字符串('opt:i'/'free:text');中止→null;超时→''
function waitAsk(registry, toolCallId, signal, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (registry && registry.asks) registry.asks.delete(toolCallId);
      resolve(v);
    };
    const timer = setTimeout(() => done(''), timeoutMs);
    const onAbort = () => done(null);
    if (signal) {
      if (signal.aborted) return done(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (registry && registry.asks) registry.asks.set(toolCallId, done);
  });
}

// 上下文压缩:超过 maxHistory 时把溢出部分滚动摘要,替换为一条摘要消息 + 最近 keepRecent 条原文
async function maybeSummarize({ settings, conv, store, send, adapter, provider, model, signal, guard }) {
  const ctx = settings.context || {};
  const strategy = ctx.strategy || 'trim';
  const maxHistory = Math.max(4, settings.chat.maxHistory || 40);
  if (strategy !== 'summarize') return null; // 不需要压缩

  const internal = buildHistory(conv.messages, 0); // 不截断,先取全量
  if (internal.length <= maxHistory) return null;

  const keep = Math.min(Math.max(2, parseInt(ctx.keepRecent, 10) || 8), Math.max(2, internal.length - 1));
  const overflowCount = Math.max(0, internal.length - keep);
  if (overflowCount <= 0) return null;
  const overflow = internal.slice(0, overflowCount);
  const recent = internal.slice(overflowCount);

  const sumT0 = Date.now();
  const prevSummary = String(conv.summary || '').trim();
  const sys = (ctx.summaryPrompt || '你是对话压缩器,把对话历史压缩成不超过500字的要点摘要,保留目标、已完成步骤、关键文件路径、重要决定与未完成事项。直接输出摘要正文。')
    + (prevSummary ? `\n\n此前已有摘要(请把下面的新内容合并进去):\n${prevSummary}` : '');
  const text = overflow.map((m) => {
    const tc = m.tool_calls ? `[调用工具: ${m.tool_calls.map((t) => t.name).join(', ')}]` : '';
    return `${m.role}: ${attachments.contentToText(m.content).slice(0, 500)}${tc}`;
  }).join('\n').slice(0, 24000);

  debuglog.info(store, 'context', 'summarize:start', { overflowCount, prevSummaryChars: prevSummary.length });
  send({ type: 'compress-note', stage: 'start' });
  const sec = security.filterMessages([{ role: 'user', content: text }], settings.security);
  const res = await adapter.streamChat({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    system: sys,
    messages: sec.messages,
    temperature: 0.3,
    signal,
    guard,
  });
  conv.summary = String(res.content || '').trim().slice(0, 4000);
  if (store) store.saveConv(conv);
  debuglog.info(store, 'context', 'summarize:done', { overflowCount, summaryChars: conv.summary.length, ms: Date.now() - sumT0 });
  send({ type: 'compress-note', stage: 'done', covered: overflowCount });

  const summaryMsg = { role: 'user', content: `[此前对话的自动摘要 —— 细节可能省略,最新要求以之后的消息为准]\n${conv.summary}` };
  return [summaryMsg, ...recent];
}

async function runChat(deps) {
  // deps: { store, send, streams, streamId, convId, providerId, model, userText, retry, agentMode, signal }
  const { store, send, streams, streamId, convId, providerId, model, agentMode, signal } = deps;
  const settings = store.config;
  const conv = store.getConv(convId) || store.createConv(convId, deps.groupId);
  const aborted = () => !!(signal && signal.aborted);
  const batch = makeBatcher(send);
  const flushSend = (obj) => { batch.flush(); send(obj); };

  try {
    // 分支重试:旧回复不删除,收进新回复的 variants(对话分支)
    let heldBranchTurn = null;
    if (deps.retry) {
      const last = conv.messages[conv.messages.length - 1];
      if (last && last.role === 'assistant') {
        heldBranchTurn = deps.branch ? last : null;
        conv.messages.pop();
        store.saveConv(conv);
      }
    } else {
      const isFirstUser = !conv.messages.some((m) => m.role === 'user');
      const atts = deps.attachments || [];
      conv.messages.push({ role: 'user', content: deps.userText, ...(atts.length ? { attachments: atts } : {}) });
      if (isFirstUser && (!conv.title || conv.title === '新对话')) {
        conv.title = makeTitle(deps.userText || (atts[0] && atts[0].name) || '');
      }
      store.saveConv(conv);
      flushSend({ type: 'user-saved', text: deps.userText, title: conv.title });
      for (const w of deps.attachWarnings || []) flushSend({ type: 'attach-note', message: w });
      if (atts.length) {
        // 审计只记元数据(名称/类型/大小),不落附件内容
        security.auditAppend(store, {
          kind: 'attachment', count: atts.length,
          items: atts.map((a) => ({ name: a.name, mime: a.mime, kind: a.kind, size: a.size })),
        });
        debuglog.info(store, 'chat', 'attachments', {
          streamId, count: atts.length,
          totalBytes: atts.reduce((n, a) => n + (a.size || 0), 0),
          names: atts.map((a) => a.name).slice(0, 8),
        });
      }
    }

    const provider = settings.providers.find((p) => p.id === providerId);
    if (!model) throw new Error('请先在顶部选择模型');
    if (!provider) throw new Error('未找到模型服务商,请到设置中检查');
    // OAuth 账号登录的供应商:令牌将到期时自动刷新(刷新结果写回 provider.apiKey)
    if (provider.oauth) await oauth.ensureFresh(store, provider.oauth, provider.id);

    // 模式:chat 纯对话 / restricted 受限(只读) / full 完全授权 / create 创造(完全+自我扩展) / team 团队协同(完全授权+指挥官编队)
    // 必须先于下方日志解析(chat:start 会引用)
    const mode = ['chat', 'restricted', 'full', 'create', 'team'].includes(deps.mode)
      ? deps.mode
      : (deps.agentMode === false ? 'chat' : 'restricted');

    const keyPool = (provider.apiKeys || []).map(String).filter(Boolean);
    if (!keyPool.length && provider.apiKey) keyPool.push(String(provider.apiKey));
    if (!keyPool.length && !provider.local) {
      throw new Error(`「${provider.name}」尚未配置 API Key(支持配置多个自动轮换),请到设置中填写`);
    }
    debuglog.info(store, 'chat', 'chat:start', {
      streamId, convId, provider: provider.name, host: security.hostOf(provider.baseUrl),
      model, mode, keyCount: keyPool.length, agentMode: !!deps.agentMode, retry: !!deps.retry,
    });

    // 推理强度:上游探测/内置官方能力库解析 + 校验用户选择(字符串档位或数值自定义预算)
    const caps = modelCaps.forModel(model, provider.modelCaps, modelCaps.getModelDb(store));
    let reasoning = null;
    if (caps && caps.levels.length) {
      const saved = deps.reasonLevel;
      if (typeof saved === 'number' && modelCaps.NUMERIC_STYLES.includes(caps.style)) {
        reasoning = { level: 'custom', budget: saved, style: caps.style };
      } else if (typeof saved === 'string' && caps.levels.includes(saved)) {
        reasoning = { level: saved, style: caps.style, offValue: caps.offValue };
      } else if (caps.defaultLevel) {
        reasoning = { level: caps.defaultLevel, style: caps.style, offValue: caps.offValue };
      }
    }
    debuglog.info(store, 'agent', 'reasoning', { model, caps: caps ? caps.style : null, levels: caps ? caps.levels : [], chosen: reasoning && reasoning.level });
    const adapter = providers.getAdapter(provider.type);

    // 工作目录:会话所属分组绑定的文件夹优先,否则用全局工作目录
    const group = (settings.groups || []).find((g) => g.id === (conv.groupId || 'default'));
    const workspace = (group && group.workspace) || settings.agent.workspace;
    try { fs.mkdirSync(workspace, { recursive: true }); } catch (_) { /* 目录不可建时工具会报错 */ }

    // 技能专精:激活的专精包 → 人设/常载核心/索引注入系统提示词 + read_specialty 工具
    let specialtyPack = null;
    let specialtyExtras = null;
    const specId = settings.ui && settings.ui.activeSpecialtyId;
    if (specId) {
      specialtyPack = specialty.getPack(store, specId);
      if (specialtyPack) specialtyExtras = specialty.promptExtras(store, specialtyPack);
      else debuglog.warn(store, 'specialty', '激活的专精包缺失', { specId });
    }

    // 安全设置:URL 门槛由适配器内 guard 执行;敏感信息在每次出站前过滤
    const secAction = (settings.security && settings.security.sensitiveScan)
      ? (settings.security.sensitiveAction || 'warn') : 'off';
    const guard = (u) => security.assertUrlAllowed(u, settings.security || {});
    const warnedTypes = new Set();
    const toolCap = Math.min(100000, Math.max(1000, parseInt(settings.context && settings.context.toolResultCap, 10) || 20000));
    // 沙箱策略:非创造模式强制(文件锁定必开、命令拦截至少宽松),创造模式按设置
    const sandboxPolicy = sandbox.policyFor(mode, settings);

    // 上下文:trim 策略按条数截断;summarize 策略把溢出部分滚动摘要
    let history;
    try {
      if ((settings.context && settings.context.strategy) === 'summarize') {
        history = (await maybeSummarize({
          settings, conv, store, send: flushSend, adapter, provider, model, signal, guard,
        })) || buildHistory(conv.messages, 0);
      } else {
        history = buildHistory(conv.messages, settings.chat.maxHistory);
      }
    } catch (e) {
      // 摘要失败(网络/安全拦截等)退回截断,不阻断对话
      flushSend({ type: 'compress-note', stage: 'error', message: e.message });
      history = buildHistory(conv.messages, settings.chat.maxHistory);
    }
    const assistant = (settings.assistants || []).find((a) => a.id === deps.assistantId)
      || { name: '默认助手', prompt: '' };
    const skill = (settings.skills || []).find((s) => s.id === deps.skillId);
    // 记忆/学习(开发者选项开关,默认关):开 = 注入全部记忆/学习沉淀(上下文消耗增大)
    const devFlags = settings.dev || {};
    const system = buildSystemPrompt({
      mode,
      workspace,
      specialty: specialtyExtras,
      assistantPrompt: assistant.prompt,
      assistantName: assistant.name && assistant.name !== '默认助手' ? assistant.name : '',
      skillPrompt: skill ? skill.prompt : '',
      memories: devFlags.memory ? (settings.memories || []) : null,
      learned: devFlags.learning ? (settings.learnedPrompts || []) : null,
    });

    let toolDefs = null;
    const SPECIALTY_TOOL = specialtyPack ? {
      name: 'read_specialty',
      description: `读取「${specialtyPack.name}」专精知识库中的文件(带行号)。先用系统提示词里的路由索引定位文件,再读取。大文件可用 offset/limit 分段。`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '知识库内相对路径,如 concepts/hybrid/osc-protocol.md' },
          offset: { type: 'integer', description: '起始行号,默认 1' },
          limit: { type: 'integer', description: '读取行数,默认 600,最大 1200' },
        },
        required: ['path'],
      },
    } : null;
    if (mode === 'restricted') {
      toolDefs = tools.DEFINITIONS.filter((t) => ['list_dir', 'read_file', 'web_fetch', 'web_search'].includes(t.name));
      toolDefs.push(buildDispatchDefinition(settings, mode));
      if (SPECIALTY_TOOL) toolDefs.push(SPECIALTY_TOOL);
    } else if (mode === 'full' || mode === 'create' || mode === 'team') {
      toolDefs = tools.DEFINITIONS.slice();
      toolDefs.push(buildDispatchDefinition(settings, mode));
      if (mode === 'create') toolDefs.push(...tools.SELF_DEFINITIONS);
      // 记忆/学习工具(开发者选项开关,默认关;受限=只读不含)
      if (devFlags.memory) toolDefs.push(...tools.MEMORY_DEFINITIONS);
      if (devFlags.learning) toolDefs.push(...tools.LEARN_DEFINITIONS);
      if (SPECIALTY_TOOL) toolDefs.push(SPECIALTY_TOOL);
    }
    if (toolDefs && (mode === 'full' || mode === 'create' || mode === 'team')) {
      // 并入 MCP 工具(插件桥);单个服务连接失败不影响其余工具
      try {
        const collected = await mcp.collectTools(settings.mcpServers || [], signal);
        for (const item of collected) {
          if (item.error) flushSend({ type: 'mcp-note', message: item.error });
          else toolDefs.push(item.def);
        }
      } catch (_) { /* 收集失败(含被中止)则仅用内置工具 */ }
      try {
        for (const item of pluginHost.collectTools(store)) toolDefs.push(item);
      } catch (_) { /* 插件工具收集失败不阻断 */ }
      try {
        for (const item of dshHost.collectTools(store)) toolDefs.push(item); // DSH 代码插件(实验性)
      } catch (_) { /* DSH 宿主失败不阻断 */ }
    }
    const maxIters = Math.max(1, settings.agent.maxIters || 20);
    const t0 = Date.now();
    const turn = { role: 'assistant', blocks: [] };
    if (heldBranchTurn) {
      // 完整时间序 = 旧分支序列 + 新回复;variants 不含自身(无环可落盘),pos 记位次
      const heldPos = Number.isInteger(heldBranchTurn.pos) ? heldBranchTurn.pos : (heldBranchTurn.variants || []).length;
      const seq = (heldBranchTurn.variants || []).slice();
      seq.splice(Math.min(heldPos, seq.length), 0, heldBranchTurn);
      seq.push(turn);
      turn.variants = seq.filter((x) => x !== turn);
      turn.pos = seq.length - 1;
    }
    conv.messages.push(turn); // 挂回会话:流式过程中的每轮落盘、中止保存都依赖它在 messages 里

    // —— 用量洞察采集(随 done 一次性写入全局/每日桶):token 构成 / 耗时分解 / 工具计数时长 ——
    const statParts = { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
    const statTimes = { wait: 0, think: 0, output: 0 };
    const statTools = { count: 0, ms: 0 };
    const sysTokens = estimateTokens(system || '');
    const toolsTokens = toolDefs && toolDefs.length ? estimateTokens(JSON.stringify(toolDefs)) : 0;
    const injectedTokens = estimateTokens(assistant && assistant.prompt)
      + estimateTokens(skill && skill.prompt)
      + estimateTokens(specialtyExtras && specialtyExtras.text);
    const partTokens = (messages) => {
      const acc = { user: 0, assistant: 0, toolResult: 0 };
      for (const m of messages || []) {
        if (m.role === 'user') acc.user += messageTokens(m);
        else if (m.role === 'assistant') acc.assistant += messageTokens(m);
        else if (m.role === 'tool') acc.toolResult += messageTokens(m);
      }
      return acc;
    };

    let usage = null;
    for (let iter = 0; iter < maxIters; iter++) {
      // 每轮迭代新开 text/reasoning 块,流式增量同时写入 turn(崩溃/中止时也能存下部分内容)
      let curText = null;
      let curReasoning = null;
      const iterStat = { firstReason: 0, firstText: 0 }; // 计时:首个思考/正文增量到达时刻
      const onText = (t) => {
        if (!curText) { curText = { type: 'text', content: '' }; turn.blocks.push(curText); }
        if (!iterStat.firstText) iterStat.firstText = Date.now();
        curText.content += t;
        batch.text(t);
      };
      const onReasoning = (t) => {
        if (!curReasoning) { curReasoning = { type: 'reasoning', content: '' }; turn.blocks.push(curReasoning); }
        if (!iterStat.firstReason) iterStat.firstReason = Date.now();
        curReasoning.content += t;
        batch.reasoning(t);
      };

      // —— 出站前安全过滤:warn 提示 / block 拦截 / redact 脱敏 ——
      let outMessages = history;
      if (secAction !== 'off') {
        const f = security.filterMessages(history, settings.security);
        outMessages = f.messages;
        if (f.findings.length) {
          const uniq = [...new Set(f.findings.map((x) => x.type))];
          if (secAction === 'block') {
            throw new Error(`已按安全设置拦截本次请求:检测到敏感信息(${uniq.join('、')})。可在 设置→安全审计 改为提醒或脱敏模式。`);
          }
          for (const t of uniq) {
            if (warnedTypes.has(t)) continue;
            warnedTypes.add(t);
            flushSend({ type: 'security-note', types: [t] });
            security.auditAppend(store, { kind: 'sensitive', types: [t] });
            debuglog.warn(store, 'security', 'sensitive-detected', { streamId, types: [t], action: secAction });
          }
        }
      }

      const iterT0 = Date.now();
      const res = await (async () => {
        const reqEntry = {
          kind: 'llm', provider: provider.name, host: security.hostOf(provider.baseUrl),
          model, mode, msgs: outMessages.length, messages: outMessages,
        };
        try {
          const r = await streamWithKeyPool({
            adapter,
            providerId: provider.id,
            keyPool,
            onRotate: (n, total) => {
              debuglog.warn(store, 'agent', 'keyRotate', { streamId, providerId: provider.id, attempt: n, total });
              flushSend({ type: 'mcp-note', message: `API Key 失效/限流,自动切换到下一个(第 ${n}/${total} 个)` });
            },
            params: {
              baseUrl: provider.baseUrl,
              model,
              reasoning,
              oauth: provider.oauth || null,
              oauthAccountId: provider.oauth ? ((store.config.oauthAccounts || {})[provider.oauth] || {}).accountId || '' : '',
              system,
              messages: outMessages,
              tools: toolDefs,
              temperature: settings.chat.temperature,
              signal,
              guard,
              onText,
              onReasoning,
            },
          });
          security.auditAppend(store, { ...reqEntry, status: 'ok', usage: r.usage || undefined });
          const cu = cachedFromUsage(r.usage);
          debuglog.info(store, 'agent', 'llm:ok', {
            streamId, iter, ms: Date.now() - iterT0,
            toolCalls: (r.toolCalls || []).length, finishReason: r.finishReason || null, usage: r.usage || null,
            cacheHitRate: r.usage && r.usage.prompt_tokens ? Math.round((cu / r.usage.prompt_tokens) * 100) + '%' : null,
          });
          return r;
        } catch (e) {
          security.auditAppend(store, { ...reqEntry, status: 'error', error: String(e.message || e).slice(0, 300) });
          debuglog.error(store, 'agent', 'llm:error', {
            streamId, iter, message: String(e.message || e).slice(0, 300), stack: String(e.stack || '').slice(0, 1500),
          });
          throw e;
        }
      })();
      if (res.usage) {
        // 多轮工具循环的用量要累计,不能只记最后一轮
        usage = usage || { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
        usage.prompt_tokens += res.usage.prompt_tokens || 0;
        usage.completion_tokens += res.usage.completion_tokens || 0;
        usage.cached_tokens += cachedFromUsage(res.usage);
      }
      // 本轮 LLM 调用的耗时分解与 token 构成(等待 = 首增量前;思考 = 思考期;输出 = 正文/工具参数期)
      const iterEnd = Date.now();
      statTimes.wait += Math.max(0, (iterStat.firstReason || iterStat.firstText || iterEnd) - iterT0);
      if (iterStat.firstReason && !iterStat.firstText) statTimes.think += iterEnd - iterStat.firstReason;
      else if (iterStat.firstReason && iterStat.firstText > iterStat.firstReason) statTimes.think += iterStat.firstText - iterStat.firstReason;
      if (iterStat.firstText) statTimes.output += iterEnd - iterStat.firstText;
      const pt = partTokens(history);
      statParts.system += sysTokens;
      statParts.tools += toolsTokens;
      statParts.injected += injectedTokens;
      statParts.user += pt.user;
      statParts.assistant += pt.assistant;
      statParts.toolResult += pt.toolResult;
      flushSend({ type: 'text-end', content: res.content || '' });
      if (aborted()) break;

      if (!res.toolCalls || !res.toolCalls.length) break;

      history.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls,
      });

      for (const tc of res.toolCalls) {
        let argsObj = {};
        try { argsObj = JSON.parse(tc.arguments || '{}'); } catch (_) { argsObj = { _raw: tc.arguments }; }

        if (tc.name === 'ask_user') {
          const q = {
            question: String(argsObj.question || '请做出选择').slice(0, 300),
            context: String(argsObj.context || '').slice(0, 500),
            options: (Array.isArray(argsObj.options) ? argsObj.options : []).slice(0, 3).map((o) => ({
              label: String((o && o.label) || '').slice(0, 80),
              detail: String((o && o.detail) || '').slice(0, 200),
            })),
          };
          flushSend({ type: 'ask-user', toolCallId: tc.id, ...q });
          security.auditAppend(store, { kind: 'ask', question: q.question });
          debuglog.info(store, 'agent', 'ask_user', { streamId, question: q.question, options: q.options.map((o) => o.label) });
          const registry = streams.get(streamId);
          const answer = await waitAsk(registry, tc.id, signal);
          let answerKind = 'none', answerIndex = -1, answerText = '', display = '用户未在时限内回应,请基于已有信息给出建议并继续。';
          if (answer === null) { answerKind = 'stop'; display = '用户已停止本次任务。'; }
          else if (answer.startsWith('opt:')) {
            const i = parseInt(answer.slice(4), 10) || 0;
            answerKind = 'opt'; answerIndex = i; answerText = q.options[i] ? q.options[i].label : '';
            display = `用户选择了选项 ${i + 1}:${answerText}`;
          } else if (answer.startsWith('free:')) {
            answerKind = 'free'; answerText = answer.slice(5);
            display = `用户自己输入:${answerText}`;
          }
          debuglog.info(store, 'agent', 'ask_user:answered', { streamId, kind: answerKind, index: answerIndex, text: answerText.slice(0, 100) });
          flushSend({ type: 'tool-end', toolCallId: tc.id, status: aborted() ? 'aborted' : 'done', result: display });
          turn.blocks.push({ type: 'ask', question: q.question, context: q.context, options: q.options, answerKind, answerIndex, answerText, answerDisplay: display });
          history.push({ role: 'tool', tool_call_id: tc.id, name: 'ask_user', content: display });
          if (answerKind === 'stop' || aborted()) break;
          continue;
        }

        const isMcp = tc.name.startsWith('mcp__');
        const route0 = isMcp ? mcp.routeInfo(tc.name) : null;
        let status = 'done';
        let result = '';

        if (aborted()) break;
        // run_command 人工审批(v0.49.3 安全修复):审批三件套(waitDecision/tool:decision/渲染端按钮)此前断链,
        // 命令黑名单成了唯一闸门。run_command 是唯一不受文件沙箱约束的任意执行面,执行前必须用户批准。
        // 审批等待期用户中止 → waitDecision 内部按拒绝收敛;registry 缺失(直连测试)→ 不阻塞。
        if (tc.name === 'run_command') {
          flushSend({ type: 'tool-start', toolCallId: tc.id, name: tc.name, args: argsObj, status: 'awaiting' });
          security.auditAppend(store, { kind: 'approval', name: tc.name, brief: JSON.stringify(argsObj).slice(0, 200) });
          const approved = await waitDecision(streams.get(streamId), tc.id, signal);
          if (aborted()) break;
          if (!approved) {
            const deniedMsg = '用户拒绝了这次命令执行(审批未通过)。不要重试同一命令;如任务仍需继续,请先询问用户。';
            flushSend({ type: 'tool-end', toolCallId: tc.id, status: 'denied', result: deniedMsg });
            turn.blocks.push({ type: 'tool', id: tc.id, name: tc.name, args: argsObj, result: deniedMsg, status: 'denied' });
            history.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: deniedMsg });
            continue;
          }
        }
        flushSend({ type: 'tool-start', toolCallId: tc.id, name: tc.name, args: argsObj, status: 'running' });
        security.auditAppend(store, { kind: 'tool', name: tc.name, brief: JSON.stringify(argsObj).slice(0, 200), host: isMcp ? (route0 && route0.serverName) : undefined });
        const toolT0 = Date.now();
        try {
          result = tc.name === 'dispatch_agents'
            ? await runDispatch({ settings, provider, adapter, mode, toolDefs, signal, send, store, keyPool, model, workspace, toolCap, toolCallId: tc.id, args: argsObj, mainReason: reasoning })
            : isMcp
            ? await mcp.callTool(settings.mcpServers, tc.name, argsObj, signal)
            : tc.name === 'read_specialty'
            ? await specialty.readKnowledge(store, specId, argsObj.path, argsObj.offset, argsObj.limit)
            : tc.name.startsWith('dsh_')
            ? await dshHost.callTool(store, tc.name, argsObj, signal)
            : tc.name.startsWith('lite_')
            ? await pluginHost.callTool(store, tc.name, argsObj, signal)
            : await tools.execute(tc.name, argsObj, {
                workspace,
                shellTimeout: settings.agent.shellTimeout,
                signal,
                store,
                security: settings.security || {},
                sandbox: sandboxPolicy,
                onChange: () => flushSend({ type: 'config-changed' }),
              });
        } catch (e) {
          status = 'error';
          result = `工具执行出错: ${e.message}`;
        }
        if (aborted()) status = 'aborted';
        if (tc.name !== 'ask_user') { statTools.count += 1; statTools.ms += Math.max(0, Date.now() - toolT0); }
        debuglog[status === 'done' ? 'info' : 'warn'](store, 'agent', 'tool', {
          streamId, name: tc.name, status, ms: Date.now() - toolT0,
          error: status === 'error' ? String(result).slice(0, 300) : undefined,
        });
        flushSend({ type: 'tool-end', toolCallId: tc.id, status, result: String(result).slice(0, 2000) });
        turn.blocks.push({ type: 'tool', id: tc.id, name: tc.name, args: argsObj, result: String(result), status });
        history.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: String(result).slice(0, toolCap) });
      }

      if (aborted()) break;
      store.saveConv(conv); // 每轮落盘:崩溃/断电也能保住已生成内容
    }

    if (!turn.blocks.length) {
      conv.messages.pop();
      if (heldBranchTurn) conv.messages.push(heldBranchTurn); // 分支重试无产出 → 还原旧分支
    }

    // —— 用量统计:会话累计 + 全局累计 + 按模型汇总;上下文占用估算 ——
    // 注意:多会话并发时,这里必须在写前重读 store.config.usage(活引用),
    // 读改写在同一个同步块内完成,否则并发流会互相覆盖丢用量
    let estimated = false;
    if (!usage) {
      estimated = true;
      let est = estimateTokens(system || '');
      for (const m of history) est += messageTokens(m);
      usage = { prompt_tokens: est, completion_tokens: estimateTokens(turn.blocks.map((b) => (b.content || '')).join('\n')) };
    }
    const p = usage.prompt_tokens || 0;
    const c = usage.completion_tokens || 0;
    const cached = usage.cached_tokens || 0;
    conv.usage = conv.usage || { prompt: 0, completion: 0, cached: 0, requests: 0 };
    conv.usage.prompt += p;
    conv.usage.completion += c;
    conv.usage.cached = (conv.usage.cached || 0) + cached;
    conv.usage.requests += 1;
    const ctxTokens = estimateTokens(system || '') + history.reduce((n, m) => n + messageTokens(m), 0);
    conv.ctx = { messages: history.length, tokens: ctxTokens, parts: { ...statParts } }; // parts:底部用量条「上下文已用」明细(系统提示词/工具定义/对话消息)
    const g = store.config.usage || { prompt: 0, completion: 0, requests: 0, cached: 0, byModel: {} };
    g.prompt = (g.prompt || 0) + p;
    g.completion = (g.completion || 0) + c;
    g.cached = (g.cached || 0) + cached;
    g.requests = (g.requests || 0) + 1;
    const mk = `${provider.name}/${model}`;
    g.byModel = g.byModel || {};
    g.byModel[mk] = g.byModel[mk] || { prompt: 0, completion: 0, cached: 0, requests: 0 };
    g.byModel[mk].prompt += p;
    g.byModel[mk].completion += c;
    g.byModel[mk].cached = (g.byModel[mk].cached || 0) + cached;
    g.byModel[mk].requests += 1;
    // —— 洞察采集落账:费用估算(models.dev 价目)/活跃时长/耗时分解/token 构成/工具计数 + 每日桶 ——
    const activeMs = Math.max(0, Date.now() - t0);
    const price = modelCaps.pricingFor(store, model);
    const cost = price
      ? (Math.max(0, p - cached) * price.i + cached * (price.cr || price.i) + c * price.o) / 1e6
      : 0;
    g.cost = (g.cost || 0) + cost;
    g.activeMs = (g.activeMs || 0) + activeMs;
    g.tools = g.tools || { count: 0, ms: 0 };
    g.tools.count = (g.tools.count || 0) + statTools.count;
    g.tools.ms = (g.tools.ms || 0) + statTools.ms;
    g.times = g.times || { wait: 0, think: 0, output: 0 };
    g.times.wait = (g.times.wait || 0) + statTimes.wait;
    g.times.think = (g.times.think || 0) + statTimes.think;
    g.times.output = (g.times.output || 0) + statTimes.output;
    statParts.output += c;
    g.parts = g.parts || { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
    for (const k of Object.keys(statParts)) g.parts[k] = (g.parts[k] || 0) + statParts[k];
    const dk = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    g.daily = g.daily || {};
    const day = g.daily[dk] || { requests: 0, prompt: 0, completion: 0, cached: 0, cost: 0, activeMs: 0, toolCount: 0, toolMs: 0, wait: 0, think: 0, output: 0, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 } };
    day.requests += 1;
    day.prompt += p;
    day.completion += c;
    day.cached += cached;
    day.cost += cost;
    day.activeMs += activeMs;
    day.toolCount += statTools.count;
    day.toolMs += statTools.ms;
    day.wait += statTimes.wait;
    day.think += statTimes.think;
    day.output += statTimes.output;
    for (const k of Object.keys(statParts)) day.parts[k] = (day.parts[k] || 0) + statParts[k];
    g.daily[dk] = day;
    store.updateConfig({ usage: g });

    store.saveConv(conv);
    debuglog.info(store, 'chat', 'chat:done', { streamId, ms: Date.now() - t0, aborted: aborted(), usage: usage || null });
    flushSend({ type: 'done', ms: Date.now() - t0, usage, aborted: aborted() });
    flushSend({
      type: 'usage', estimated,
      convUsage: conv.usage, ctx: conv.ctx, global: g,
    });
  } catch (err) {
    if (!aborted() && err && err.name !== 'AbortError') {
      const last = conv.messages[conv.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.blocks.push({ type: 'error', message: err.message });
      }
      if (last && last.role === 'assistant' && !last.blocks.length) conv.messages.pop();
      store.saveConv(conv);
      debuglog.error(store, 'chat', 'chat:error', { streamId, message: String(err.message || '').slice(0, 300), stack: String(err.stack || '').slice(0, 1500) });
      flushSend({ type: 'error', message: err.message });
    } else {
      const last = conv.messages[conv.messages.length - 1];
      if (last && last.role === 'assistant' && !(last.blocks || []).length) {
        conv.messages.pop();
        if (heldBranchTurn) conv.messages.push(heldBranchTurn);
      }
      store.saveConv(conv);
      flushSend({ type: 'done', ms: 0, usage: null, aborted: true });
    }
  }
}


// —— 多智能体并行调度:主智能体把可并行的任务拆给多个子智能体 ——
const DISPATCH_BASE_DESCRIPTION = '并行调度多个子智能体(每个子智能体拥有独立上下文,继承当前模式的工具与工作目录),适合把可并行的调研、生成、分析任务拆分执行。返回各子智能体的结果汇总。子智能体看不到你们的对话,任务描述必须自包含。';
const DISPATCH_DEFINITION = {
  name: 'dispatch_agents',
  description: DISPATCH_BASE_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        description: '2-6 个子任务',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '子智能体短名,如"调研组"' },
            task: { type: 'string', description: '完整、自包含的任务描述' },
            model: { type: 'string', description: '可选,指定该子智能体使用的模型 ID(默认与主智能体相同)' },
          },
          required: ['name', 'task'],
        },
      },
    },
    required: ['agents'],
  },
};

// 按用户配置生成工具定义:把子智能体库(名称/职责/专属模型)注入描述,供主智能体按职责路由;
// 团队协同模式下改为注入当前团队模板的队员名册(指挥官编队)
function buildDispatchDefinition(settings, mode) {
  const def = JSON.parse(JSON.stringify(DISPATCH_DEFINITION));
  const list = (settings && Array.isArray(settings.subagents) ? settings.subagents : []).filter((s) => s && s.enabled !== false);
  const team = (settings && Array.isArray(settings.teams) ? settings.teams : []).find((t) => t.id === (settings.ui && settings.ui.activeTeamId) && t.enabled !== false);
  if (mode === 'team' && team && (team.workers || []).length) {
    def.description = DISPATCH_BASE_DESCRIPTION
      + '\n\n【团队协同模式】你是团队指挥官(主模型):把目标拆解成自包含的子任务,按队员职责用 agentId 派发(可并行),收到结果后汇总审校、整合成最终交付。队员名册(模型与推理强度已由模板配置,无需传 model):\n'
      + team.workers.map((w, i) => `- agentId: ${team.id}#${i} | 名称: ${w.name || '队员' + (i + 1)} | 模型: ${w.model || '跟随主模型'} | 推理强度: ${w.strength || '跟随主对话'}`).join('\n');
    def.parameters.properties.agents.items.properties.agentId = {
      type: 'string',
      description: '队员的 agentId(见上方名册);传入后仍必须提供 task',
    };
    return def;
  }
  if (list.length) {
    def.description = DISPATCH_BASE_DESCRIPTION
      + '\n\n可用的预配置子智能体 —— 任务与其职责匹配时优先用 agentId 派发(其角色提示词与专属模型自动生效,无需再传 model):\n'
      + list.map((s) => `- agentId: ${s.id} | 名称: ${s.name} | 职责: ${s.description || '通用执行'} | 模型: ${s.model || '跟随主智能体'}`).join('\n');
    def.parameters.properties.agents.items.properties.agentId = {
      type: 'string',
      description: '预配置子智能体的 id(见上方列表);传入后仍必须提供 task',
    };
  } else {
    def.description = DISPATCH_BASE_DESCRIPTION + '\n\n当前没有预配置的子智能体,请在 agents 中自由描述 name 与 task。';
  }
  return def;
}

// 子智能体的模型/供应商解析:
// ① agentId 命中团队模板队员(teamId#序号)→ 用该队员配置的 providerId+model+strength(未配置则跟随主模型)
// ② agentId 命中子智能体定义 → 用其 providerId+model+prompt+strength(未配置则跟随主智能体)
// ③ 只传 model(自由派发)→ 当前供应商有该模型就用,否则全局找拥有该模型的服务商(多模型协作)
// ④ 都没有 → 跟随主智能体;目标供应商没有可用 Key 时回退主供应商
function resolveSubTarget(a, settings, mainProvider, mainModel) {
  const defs = (settings && Array.isArray(settings.subagents) ? settings.subagents : []).filter((s) => s && s.enabled !== false);
  const teams = (settings && Array.isArray(settings.teams) ? settings.teams : []);
  let def = null;
  let worker = null;
  const agentId = a && a.agentId ? String(a.agentId) : '';
  if (agentId.includes('#')) {
    const teamId = agentId.slice(0, agentId.indexOf('#'));
    const idx = Number(agentId.slice(agentId.indexOf('#') + 1));
    const team = teams.find((t) => t.id === teamId);
    worker = team && Array.isArray(team.workers) ? team.workers[idx] : null;
  } else if (agentId) {
    def = defs.find((s) => s.id === agentId) || null;
  }
  let provider = mainProvider;
  let model = mainModel;
  let prompt = null;
  let name = null;
  let strength = null;
  if (worker) {
    name = worker.name || null;
    strength = worker.strength != null ? worker.strength : null;
    if (worker.providerId && worker.model) {
      const p = settings.providers.find((x) => x.id === worker.providerId);
      if (p) { provider = p; model = worker.model; }
    }
  } else if (def) {
    name = def.name || null;
    prompt = def.prompt || null;
    strength = def.strength != null ? def.strength : null;
    if (def.providerId && def.model) {
      const p = settings.providers.find((x) => x.id === def.providerId);
      if (p) { provider = p; model = def.model; }
    }
  } else if (a && a.model) {
    if ((mainProvider.models || []).includes(a.model)) {
      model = a.model;
    } else {
      const p = settings.providers.find((x) => (x.models || []).includes(a.model));
      if (p) { provider = p; model = a.model; }
    }
  }
  let keyPool = (provider.apiKeys || []).map(String).filter(Boolean);
  if (!keyPool.length && provider.apiKey) keyPool.push(String(provider.apiKey));
  if (!keyPool.length && !provider.local && provider.id !== mainProvider.id) {
    // 目标供应商没有可用 Key:回退主供应商,保证子任务能跑(实际用的模型会通过事件回显)
    provider = mainProvider;
    model = mainModel;
    keyPool = (mainProvider.apiKeys || []).map(String).filter(Boolean);
    if (!keyPool.length && mainProvider.apiKey) keyPool.push(String(mainProvider.apiKey));
  }
  return { provider, model, prompt, name, strength };
}

async function runSubAgent(sub, ctx, index) {
  const { settings, mode, signal, send, workspace, store, toolCap } = ctx;
  const provider = sub.provider || ctx.provider;
  // 主供应商沿用 runChat 的适配器实例(可被测试注入);跨供应商才按协议新建
  const adapter = provider.id === ctx.provider.id ? ctx.adapter : providers.getAdapter(provider.type);
  const keyPool = (sub.keyPool && sub.keyPool.length) ? sub.keyPool : ctx.keyPool;
  const model = sub.model || ctx.model;
  const caps = modelCaps.forModel(model, provider.modelCaps, modelCaps.getModelDb(store));
  let reasoning = caps && caps.levels.length && caps.defaultLevel
    ? { level: caps.defaultLevel, style: caps.style, offValue: caps.offValue } : null;
  // 推理强度优先级:模板/子智能体显式配置 > 主对话当前档位(滑块) > 该模型默认档
  // openai_effort 族放开 GPT 全阶(与供应商编辑器逐模型档位同一哲学:不支持该档 API 会报错,属用户自选)
  const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let wanted = sub.strength;
  if (wanted == null && ctx.mainReason && ctx.mainReason.level) {
    wanted = ctx.mainReason.level === 'custom' ? ctx.mainReason.budget : ctx.mainReason.level;
  }
  if (reasoning && wanted != null) {
    if (typeof wanted === 'number' && modelCaps.NUMERIC_STYLES.includes(caps.style)) {
      reasoning = { level: 'custom', budget: wanted, style: caps.style };
    } else if (typeof wanted === 'string') {
      const allowed = caps.style === 'openai_effort' ? EFFORT_LADDER : caps.levels;
      if (allowed.includes(wanted)) reasoning = { level: wanted, style: caps.style, offValue: caps.offValue };
    }
  }
  const send2 = (o) => send({ ...o, toolCallId: ctx.toolCallId, index, name: sub.name, model });
  send2({ type: 'sub-agent', status: 'running' });

  const system = buildSystemPrompt({
    mode, workspace,
    assistantName: sub.name || ('子智能体' + (index + 1)),
    assistantPrompt: sub.prompt || '你是被主智能体并行调派的执行者:专注完成交给你的任务,完成后输出结果报告(要点式,直接给结论与数据)。不要寒暄。',
    skillPrompt: null,
  });
  const history = [{ role: 'user', content: sub.task }];
  const t0 = Date.now();
  let final = '';
  try {
    for (let iter = 0; iter < ctx.maxIters; iter++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const res = await streamWithKeyPool({
        adapter,
        providerId: provider.id,
        keyPool,
        params: {
          baseUrl: provider.baseUrl, model, system, messages: history,
          oauth: provider.oauth || null,
              oauthAccountId: provider.oauth ? ((store.config.oauthAccounts || {})[provider.oauth] || {}).accountId || '' : '',
          tools: ctx.subToolDefs, temperature: settings.chat.temperature,
          signal, reasoning,
          onText: () => {}, onReasoning: () => {},
        },
      });
      if (res.content) final += (final ? '\n' : '') + res.content;
      send2({ type: 'sub-agent', status: 'running', text: final.slice(0, 2000) });
      if (!res.toolCalls || !res.toolCalls.length) break;
      history.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
      for (const tc of res.toolCalls) {
        let argsObj = {};
        try { argsObj = JSON.parse(tc.arguments || '{}'); } catch (_) { argsObj = {}; }
        let out = '';
        try {
          out = tc.name.startsWith('mcp__')
            ? await mcp.callTool(settings.mcpServers, tc.name, argsObj, signal)
            : tc.name.startsWith('dsh_')
            ? await dshHost.callTool(store, tc.name, argsObj, signal)
            : tc.name.startsWith('lite_')
            ? await pluginHost.callTool(store, tc.name, argsObj, signal)
            : await tools.execute(tc.name, argsObj, {
                workspace, shellTimeout: settings.agent.shellTimeout, signal,
                store, security: settings.security || {}, onChange: () => {},
                sandbox: sandbox.policyFor(ctx.mode, settings),
              });
        } catch (e) {
          out = '工具执行出错: ' + e.message;
        }
        history.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: String(out).slice(0, ctx.toolCap) });
      }
    }
    send2({ type: 'sub-agent', status: 'done', text: final.slice(0, 4000), ms: Date.now() - t0 });
    return final.slice(0, 6000) || '(无输出)';
  } catch (e) {
    const msg = signal && signal.aborted ? '(已被用户中止)' : ('子智能体出错: ' + e.message);
    send2({ type: 'sub-agent', status: 'error', text: msg });
    return msg;
  }
}

async function runDispatch({ settings, provider, adapter, mode, toolDefs, signal, send, store, keyPool, model, workspace, toolCap, toolCallId, args, mainReason }) {
  const agents = (Array.isArray(args && args.agents) ? args.agents : []).slice(0, 6)
    .map((a, i) => {
      const t = resolveSubTarget(a, settings, provider, model);
      return {
        name: String((a && a.name) || t.name || ('子智能体' + (i + 1))).slice(0, 20),
        task: String((a && a.task) || '').slice(0, 8000),
        model: t.model,
        prompt: t.prompt,
        provider: t.provider,
        keyPool: t.keyPool,
        strength: t.strength,
      };
    })
    .filter((a) => a.task);
  if (!agents.length) return '未提供任何子任务。请在 agents 数组中传入 {name, task}(或已配置子智能体的 {agentId, task})。';
  debuglog.info(store, 'agent', 'dispatch:resolve', {
    agents: agents.map((a) => ({ name: a.name, model: a.model, provider: (a.provider && a.provider.name) || '?', hasPrompt: !!a.prompt })),
  });
  const ctx = {
    settings, provider, adapter, mode, signal, send, store, workspace,
    model, keyPool, toolCap,
    toolCallId: toolCallId || null,
    mainReason: mainReason || null, // 主对话当前推理档位(队员留空强度时跟随)
    maxIters: Math.min(8, Math.max(1, settings.agent.maxIters || 20)),
    subToolDefs: toolDefs.filter((t) => t.name !== 'dispatch_agents' && t.name !== 'ask_user'),
  };
  const results = new Array(agents.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, agents.length) }, async () => {
    while (cursor < agents.length) {
      const i = cursor++;
      results[i] = await runSubAgent(agents[i], { ...ctx, toolCallId: ctx.toolCallId }, i);
    }
  });
  await Promise.all(workers);
  const summary = agents.map((a, i) => '### ' + a.name + '\n' + (results[i] || '(无输出)')).join('\n\n');
  return '共 ' + agents.length + ' 个子智能体已完成:\n\n' + summary;
}

module.exports = { runChat, buildHistory, buildSystemPrompt, makeTitle, maybeSummarize, streamWithKeyPool, pickKey, estimateTokens, cachedFromUsage, runDispatch, DISPATCH_DEFINITION, buildDispatchDefinition, resolveSubTarget };
