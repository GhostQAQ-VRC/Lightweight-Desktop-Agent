// Agent 调用循环:流式对话 + 工具调用 + 审批,一轮回复可能多次往返模型
const fs = require('fs');
const os = require('os');
const providers = require('./providers');
const tools = require('./tools');
const mcp = require('./mcp');
const security = require('./security');
const debuglog = require('./debuglog');
const modelCaps = require('./modelCaps');
const compressPolicy = require('./compress.js');
const pluginHost = require('./pluginHost');
const specialty = require('./specialty');
const imagegen = require('./imagegen');
const dshHost = require('./dshHost');
const blender = require('./blender');
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

// 本次请求的上下文 token 估算(系统提示词 + 工具定义 + 历史消息)
// 用于按阈值判断是否压缩;与用量条的分项估算同源,避免两套口径。
function contextTokens(system, toolDefs, history) {
  let total = estimateTokens(system || '');
  if (toolDefs && toolDefs.length) total += estimateTokens(JSON.stringify(toolDefs));
  for (const m of history || []) total += messageTokens(m);
  return total;
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
function buildSystemPrompt({ mode, workspace, assistantPrompt, assistantName, skillPrompt, specialty, memories, learned, extraTail, agentMd }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const persona = String(assistantPrompt || '').trim();
  const skill = String(skillPrompt || '').trim();
  const spec = specialty && specialty.text ? String(specialty.text).trim() : '';
  const who = assistantName ? `你是${assistantName}` : '你是 LiteAgent';
  const tail = String(extraTail || '');
  // Agent 规约(Agent.md,v0.57.9):用户在设置里写的全局规则,所有模式与子智能体都生效。
  // 位置紧跟身份声明 —— 优先级高于默认风格设定,但不凌驾于系统安全/沙箱约束。
  const rules = String(agentMd || '').trim();
  const rulesBlock = rules
    ? `# Agent 规约(用户全局规则)\n以下是用户要求在所有对话中长期遵守的规则;与默认风格冲突时以本规约为准(不得超越安全与沙箱约束):\n\n${rules}`
    : '';

  if (mode === 'chat') {
    const parts = [];
    if (persona) {
      parts.push(`${who},用户的 AI 助手。${persona}\n默认使用简体中文(用户使用其他语言时跟随用户)。当前时间: ${now}`);
    } else {
      parts.push(`你是 LiteAgent,一个乐于助人的 AI 助手。默认使用简体中文回答(用户使用其他语言时跟随用户)。当前时间: ${now}`);
    }
    if (skill) parts.push(`# 本次任务附加要求\n${skill}`);
    if (rulesBlock) parts.push(rulesBlock);
    if (spec) parts.push(`# 技能专精:${specialty.name}\n${spec}\n(注:当前为纯对话模式,无法直接读取知识文件;如需检索知识库请切换到受限/完全模式)`);
    if (Array.isArray(memories) && memories.length) parts.push(memoryBlock(memories));
    if (Array.isArray(learned) && learned.length) parts.push(learnedBlock(learned));
    return parts.join('\n\n') + tail;
  }

  const parts = [];
  if (mode === 'restricted') {
    parts.push(`${who},一个运行在用户电脑上的桌面智能体(受限模式:只提供只读工具,不能写文件、不能执行命令)。${persona}`);
    if (rulesBlock) parts.push(rulesBlock);
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
      '- glob_files / grep_text:按文件名/内容搜索',
      '- file_info / system_info / process_list:查看文件、系统与进程信息',
      '- web_search:联网搜索(查新闻/最新信息/文档)',
      '- web_fetch / web_request:抓取网页文本、调用只读 API',
      '- ask_user:制定计划遇到关键分歧点时,向用户提出 2-4 个选项的四选一请求(每项带一行说明,推荐项标「(推荐)」,系统自动附加自定义输入入口;会暂停等待回答)',
    ].join('\n'));
  } else {
    parts.push(`${who},一个运行在用户电脑上的桌面智能体,可以通过调用工具来完成实际任务。${persona}`);
    if (rulesBlock) parts.push(rulesBlock);
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
      '- ask_user:制定计划/方案遇到关键分歧点时,向用户提出选择题(2-4 个由你设计的选项,每项 detail 带一行说明,推荐项标「(推荐)」;系统会自动加上"自定义输入"入口);用户回答后你再继续',
      '- serve_dir / stop_serve:启动/停止本地 HTTP 服务器(仅本机)—— 网页游戏、ES 模块、本地 API 都需要 http:// 源,file:// 直开会失败',
      '- browser_check:无头加载页面并截图回传,还能拿到控制台报错 —— 交付网页/游戏前实际验证渲染,不要只凭代码推断',
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
      '- 你是决策者与整合者,不是唯一执行者:除一句话就能回答的琐碎问题外,实质工作默认拆解派发给队员;每个多步骤任务先判断"能不能拆、怎么拆",能并行的子任务一次派出,不要全部自己串行做完',
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
    `6. 需要打开/预览 HTML 文件(你生成的页面等)时,一律用 open_external 工具 —— 它会把页面直接展示在应用内置浏览器里供用户立即查看;不要用 run_command 的 start/explorer 等命令弹外部浏览器。`,
    '7. 网页游戏/H5 交付纪律:用 serve_dir 起本地 http:// 服务交付(file:// 会坏掉 ES 模块/音频/CORS);用 browser_check 实际加载验证(报错、白屏、画面)后再交付;FPS 视角的鼠标锁定(requestPointerLock)必须由"点击开始按钮"等用户手势触发,交付说明里提醒用户:按 Esc 释放,被反复重新锁定时快速连按两次 Esc 可强制解除。',
  ].join('\n'));
  return parts.join('\n\n') + tail;
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
function buildHistory(convMessages, maxHistory, options) {
  const internal = [];
  for (const m of convMessages) {
    if (m.role === 'user') {
      // 无附件时返回字符串(与旧格式一致);有附件时组装为 OpenAI 多模态数组
      internal.push({ role: 'user', content: attachments.composeUserContent(m) });
    } else if (m.role === 'assistant') {
      const blocks = m.blocks || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.content).join('\n\n');
      // 思考文本:DeepSeek V4 系(thinking_effort)带 tools 时要求完整回传 reasoning_content 否则 400;
      // 平时存在内部字段 _reasoning 上,适配器按需转正(其他协议忽略)
      const reasoningText = blocks.filter((b) => b.type === 'reasoning').map((b) => b.content).join('');
      const toolBlocks = blocks.filter((b) => b.type === 'tool');
      if (toolBlocks.length) {
        internal.push({
          role: 'assistant',
          content: text || '',
          ...(reasoningText ? { _reasoning: reasoningText } : {}),
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
        internal.push({ role: 'assistant', content: text, ...(reasoningText ? { _reasoning: reasoningText } : {}) });
      }
      // 历史 image 块(v0.51.1):重开会话后,把之前生成的图作为多模态 user 消息回灌,
      // 让文字模型在新会话请求里依然能看到此前生成过什么(生图记忆)
      // 极致压缩模式不回溯图片(options.includeImages=false),避免历史图片长期占用大量 token
      const imgBlocks = blocks.filter((b) => b.type === 'image' && b.base64);
      if (imgBlocks.length && (!options || options.includeImages !== false)) {
        internal.push({
          role: 'user',
          content: [
            { type: 'text', text: `[系统] 以下是此前为本会话生成的图片(共 ${imgBlocks.length} 张),用户可能基于它们继续修改:` },
            ...imgBlocks.slice(-4).map((b) => ({ type: 'image_url', image_url: { url: `data:${b.mime || 'image/png'};base64,${b.base64}` } })),
          ],
        });
      }
    }
  }
  let msgs = internal;
  if (maxHistory > 0 && msgs.length > maxHistory) msgs = msgs.slice(-maxHistory);
  while (msgs.length && msgs[0].role !== 'user') msgs = msgs.slice(1);
  return msgs;
}

// —— 权限档位工具分类(v0.54.2;安全加固:clipboard 读取用户剪贴板涉隐私,
//    从只读集合移出并归入写入集合 —— plan/writes 档现在都会审批它;risk 档保持历史默认不询问。
//    工具链第二批:写盘类(copy/zip)与截屏入写入集合,stop_process 在 risk 档也属高危需审批。
//    Blender 工具链(v0.55.0):场景改动/无头执行入写入集;纯看(blender_rt_see/commands)只读;
//    rt_do/rt_cmd/rt_headless 执行任意 Python,与 run_code 同级 —— risk 档也审批) ——
const PERM_WRITES = new Set(['write_file', 'edit_file', 'move_path', 'delete_path', 'copy_path', 'zip_create', 'zip_extract', 'run_command', 'run_code', 'download_file', 'stop_process', 'screen_capture', 'make_video', 'extract_frames', 'window_action', 'system_notify', 'schedule_task', 'manage_assistants', 'manage_skills', 'memory_save', 'self_learn', 'clipboard', 'serve_dir', 'browser_check', 'blender_viewport', 'blender_rt_do', 'blender_rt_watch', 'blender_rt_cmd', 'blender_rt_loop', 'blender_rt_perf', 'blender_rt_opt', 'blender_rt_headless', 'blender_rt_plan', 'blender_rt_worker', 'blender_rt_txn', 'blender_rt_preset', 'blender_rt_job']);
const PERM_READONLY = new Set(['list_dir', 'read_file', 'glob_files', 'grep_text', 'file_info', 'system_info', 'web_search', 'web_fetch', 'web_request', 'process_list', 'video_info', 'window_list', 'read_conversation', 'read_specialty', 'blender_rt_see', 'blender_rt_commands']);
function needApprove(toolName, permLevel) {
  if (permLevel === 'plan') return !PERM_READONLY.has(toolName);
  if (permLevel === 'writes') return PERM_WRITES.has(toolName);
  if (permLevel === 'full') return false;
  if (toolName === 'blender_rt_do' || toolName === 'blender_rt_cmd' || toolName === 'blender_rt_headless') return true; // 任意 Python/命令执行,与 run_code 同级
  return toolName === 'run_command' || toolName === 'run_code' || toolName === 'delete_path' || toolName === 'stop_process'; // risk(历史默认 + 结束进程)
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

// 上下文压缩核心:把溢出的历史滚动摘要,替换为一条摘要消息 + 最近 keepRecent 条原文。
// 可对任意内部消息数组工作(会话全量 / 工具循环中的活历史),供 runChat 开始时与循环内主动压缩共用
async function summarizeInternal({ internal, settings, conv, store, send, adapter, provider, model, signal, guard, force, detail, modeCfg }) {
  const ctx = settings.context || {};
  if (!Array.isArray(internal) || internal.length <= 1) return null;

  const keepBase = Math.max(2, parseInt(ctx.keepRecent, 10) || 8);
  const keepWanted = modeCfg && modeCfg.keepRecent ? modeCfg.keepRecent : keepBase;
  const keep = Math.min(Math.max(2, keepWanted), Math.max(2, internal.length - 1));
  const overflowCount = Math.max(0, internal.length - keep);
  if (overflowCount <= 0) return null;
  const overflow = internal.slice(0, overflowCount);
  const recent = internal.slice(overflowCount);

  const sumT0 = Date.now();
  const prevSummary = String(conv.summary || '').trim();
  const sys = (ctx.summaryPrompt || '你是对话压缩器,把对话历史压缩成不超过500字的要点摘要,保留目标、已完成步骤、关键文件路径、重要决定与未完成事项。直接输出摘要正文。')
    + (modeCfg && modeCfg.summarySuffix ? modeCfg.summarySuffix : '')
    + (prevSummary ? `\n\n此前已有摘要(请把下面的新内容合并进去):\n${prevSummary}` : '');
  const text = overflow.map((m) => {
    const tc = m.tool_calls ? `[调用工具: ${m.tool_calls.map((t) => t.name).join(', ')}]` : '';
    return `${m.role}: ${attachments.contentToText(m.content).slice(0, 500)}${tc}`;
  }).join('\n').slice(0, 24000);

  debuglog.info(store, 'context', 'summarize:start', { overflowCount, prevSummaryChars: prevSummary.length, force: !!force, detail: detail || null });
  send({ type: 'compress-note', stage: 'start', ...(detail || {}) });
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

// 兼容导出(自 v0.56.0 起 runChat 不再调用):按消息条数的会话级压缩入口,
// 保留给外部/测试使用;主流程统一走 runChat 内的 token 阈值检查。
async function maybeSummarize({ settings, conv, store, send, adapter, provider, model, signal, guard }) {
  const ctx = settings.context || {};
  if ((ctx.strategy || 'trim') !== 'summarize') return null;
  const maxHistory = Math.max(4, settings.chat.maxHistory || 40);
  const internal = buildHistory(conv.messages, 0);
  if (internal.length <= maxHistory) return null;
  return summarizeInternal({ internal, settings, conv, store, send, adapter, provider, model, signal, guard });
}

// API 的"上下文超限"类错误识别(各家措辞不一,取宽匹配;误判的代价只是多试一次压缩)
const OVERFLOW_RE = /context[_ ]?(length|window)|maximum context|too long|length exceeded|longer than|请减少|上下文.{0,4}(超|过长|超出)|input.{0,12}length/i;
function isContextOverflow(e) { return OVERFLOW_RE.test(String((e && e.message) || e)); }

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
      if (last && last.role === 'assistant' && last.durationMs == null) last.durationMs = Date.now() - t0;
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
    // 上下文压缩策略(整个任务固定):优先级 按模型预设 > GPT 专属(272K·90%) > 系统默认
    const compressStrategy = (settings.context && settings.context.strategy) === 'summarize';
    const compressCfg = compressPolicy.resolvePolicy({ settings, provider, model, db: modelCaps.getModelDb(store) });
    const compressMode = compressPolicy.modeConfig(compressCfg.mode, settings);
    const toolCapBase = Math.min(100000, Math.max(1000, parseInt(settings.context && settings.context.toolResultCap, 10) || 20000));
    // 极致压缩:工具结果截断更狠(最多 4000 字符)
    const toolCap = compressCfg.mode === 'extreme' ? Math.min(toolCapBase, 4000) : toolCapBase;
    // 沙箱策略:非创造模式强制(文件锁定必开、命令拦截至少宽松),创造模式按设置
    const sandboxPolicy = sandbox.policyFor(mode, settings);

    // 上下文:trim 策略按条数截断;summarize 策略取全量,压缩时机由每次请求前的 token 阈值检查决定(v0.56.0)
    let history = buildHistory(conv.messages, compressStrategy ? 0 : settings.chat.maxHistory, {
      includeImages: compressCfg.mode !== 'extreme', // 极致压缩不回溯历史图片
    });
    const assistant = (settings.assistants || []).find((a) => a.id === deps.assistantId)
      || { name: '默认助手', prompt: '' };
    const skill = (settings.skills || []).find((s) => s.id === deps.skillId);
    // 记忆/学习(开发者选项开关,默认关):开 = 注入全部记忆/学习沉淀(上下文消耗增大)
    const devFlags = settings.dev || {};
    let system = buildSystemPrompt({
      mode,
      workspace,
      specialty: specialtyExtras,
      assistantPrompt: assistant.prompt,
      assistantName: assistant.name && assistant.name !== '默认助手' ? assistant.name : '',
      skillPrompt: skill ? skill.prompt : '',
      memories: devFlags.memory ? (settings.memories || []) : null,
      learned: devFlags.learning ? (settings.learnedPrompts || []) : null,
      agentMd: settings.agentMd,
    });
    // 权限档位=计划模式:注入"先出计划"纪律(与审批档位联动 —— 变更类工具都会走人工审批)
    if (((settings.agent || {}).permLevel) === 'plan') {
      system += '\n\n# 权限:计划模式\n当前处于计划模式:先输出简短的执行计划(目标 + 步骤清单),让用户确认后再调用变更类工具逐步执行;只读类工具(查看/搜索)可直接使用。';
    }

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
    // 生图桥接(v0.50.0):总开关关闭 = 工具永不下发(三条路径之一被封);
    // autoBridge 开启时注入提示词,让文字模型自行决定调用。
    const ig = settings.imageGen || {};
    const igOn = !!(ig.enabled && ig.providerId && ig.model);
    const igProvider = igOn ? (ig.providers || []).find((p) => p.id === ig.providerId) : null;
    const IMAGE_TOOL = igOn && igProvider ? {
      name: 'generate_image',
      description: `生成图片:根据文字描述(${ig.model})生成图像并直接展示给用户。当用户要求画画/画一张/生成图片/来张图等图像创作时使用;纯文字回答不需要调用。`,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述,越具体越好(主体/风格/构图/光线)' },
        },
        required: ['prompt'],
      },
    } : null;
    // 截屏工具(工具链第二批):desktopCapturer 主屏 → PNG → 对话展示 + 多模态回灌(模型真看见屏幕)
    const SCREEN_TOOL = {
      name: 'screen_capture',
      description: '截取屏幕画面(主显示器整屏)并查看。适合"看看我屏幕上是什么/确认报错弹窗/检查程序界面状态"等需要视觉的场景。注意:截屏会捕获屏幕上全部可见内容(含其他应用窗口)。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '可选,本次截屏目的(便于用户在审批卡上判断)' },
        },
        required: [],
      },
    };
    // 视频抽帧(工具链第三批):video 逐时刻 seek → PNG 落盘 + 多模态回灌 —— 文字/多模态模型都能拿到帧文件,多模态模型还能直接"看"
    const EXTRACT_TOOL = {
      name: 'extract_frames',
      description: '从视频文件抽取指定时刻的帧并保存为 PNG(工作目录),帧图片会同时回传给你(多模态模型可直接看画面)。适合理解视频内容、截取画面、检查动画效果。配合 video_info 先看时长,再选抽帧时刻;上限 8 帧。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '视频文件路径(工作目录内)' },
          times: { type: 'array', items: { type: 'number' }, description: '抽帧时刻数组(秒),如 [0, 1.5, 3];上限 8 个' },
          outPrefix: { type: 'string', description: '输出 PNG 前缀(工作目录内),默认用视频文件名' },
        },
        required: ['path', 'times'],
      },
    };
    // 网页检查(游戏工具链 v0.54.21):无头加载 → 收集控制台报错 → 截图回灌,模型真"看见"页面渲染效果
    const BROWSER_TOOL = {
      name: 'browser_check',
      description: '无头加载一个页面(http/file/data 均可),等待渲染后收集控制台报错/警告并截图回传给你。做网页/H5/游戏时的"眼睛":交付前实际加载验证(报错、白屏、画面是否正确),不要只凭代码推断。配合 serve_dir 用 http:// 源效果最好。注意:截图是静态帧,听不到音频。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '页面地址(serve_dir 的 http://127.0.0.1:端口/ 或 file:// 本地文件)' },
          waitMs: { type: 'integer', description: '渲染等待毫秒数(500-15000,默认 2500;游戏/动画可给 4000+)' },
        },
        required: ['url'],
      },
    };
    if (mode === 'restricted') {
      toolDefs = tools.DEFINITIONS.filter((t) => ['list_dir', 'read_file', 'web_fetch', 'web_search', 'web_request', 'process_list', 'read_conversation', 'glob_files', 'grep_text', 'file_info', 'system_info', 'video_info', 'window_list', 'ask_user'].includes(t.name));
      toolDefs.push(buildDispatchDefinition(settings, mode));
      if (SPECIALTY_TOOL) toolDefs.push(SPECIALTY_TOOL);
    } else if (mode === 'full' || mode === 'create' || mode === 'team') {
      toolDefs = tools.DEFINITIONS.slice();
      toolDefs.push(buildDispatchDefinition(settings, mode));
      if (IMAGE_TOOL) toolDefs.push(IMAGE_TOOL);
      toolDefs.push(SCREEN_TOOL);
      toolDefs.push(EXTRACT_TOOL);
      toolDefs.push(BROWSER_TOOL);
      // Blender 建模工具链(15 个,门控 config.blender.enabled;名字与原插件一致,技能包 SOP 直接生效)
      if (settings.blender && settings.blender.enabled) toolDefs.push(...blender.BLENDER_DEFINITIONS);
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
    // 生图自动桥接提示(v0.50.0):工具在位 + autoBridge 开 → system 追加提示(此处 IMAGE_TOOL 已初始化,无 TDZ)
    if (IMAGE_TOOL && ig.autoBridge !== false) {
      system += '\n【图片生成】用户要求画画/画一张/生成图片/来张图等图像创作时,优先调用 generate_image 工具(不要只输出文字描述);完成后可对图做简短说明。';
    }
    // Blender 建模工具链提示(v0.55.0):工具在位 → system 追加工作纪律(详细 SOP 在 blender-modeling 专精包)
    if (settings.blender && settings.blender.enabled) {
      system += '\n【Blender 建模】你拥有 15 个 blender_viewport / blender_rt_* 工具,可直接驱动 Blender 做 3D 建模。纪律:'
        + '①Blender 未启动/未连接时先 blender_viewport(op="launch") 一键拉起(自动装 addon 并连接);'
        + '②每改一步用 blender_rt_see 看一眼再决定下一步,不要一口气做完再看;'
        + '③有 plan op 就用 blender_rt_plan(不确定先 op="catalog" 查 33 family/217 op 目录),不要自写等价几何/验收;'
        + '④回执先读 verdict(pass|fail|degraded),degraded 不算通过;'
        + '⑤拓扑改动前先 blender_rt_txn(op="snapshot") 留回退点;'
        + '⑥预期 >100s 的活走 blender_rt_job(as_job=true);'
        + '⑦完整建模流程用 read_specialty 查「blender-modeling」专精包(SKILL.md 与 references)。';
    }
    const maxIters = Math.max(1, settings.agent.maxIters || 20);
    const t0 = Date.now();
    const turn = { role: 'assistant', blocks: [], model: `${provider.name}/${model}` };
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
    // 输出速度专用计数(v0.57.6):旧口径 completion/outputMs 把思考 tokens 也算进分子,
    // 而分母只含「出正文」的时长 → TPS 虚高,思考越多的模型显得越快。
    // 这里只累计「有正文的轮次」且剔除 reasoning_tokens,与分母同口径。
    const statTps = { tokens: 0, ms: 0 };
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
      let overflowRescued = false; // 超限自救只做一次(压缩后仍超限就把错误如实抛出)
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

      // —— 每次请求前的主动压缩(v0.56.0):按 token 阈值判断(预设 > GPT 规则 > 系统默认),
      //    阈值未知时退回旧的「消息条数」逻辑;超出硬上限(400 条)无论如何压缩一次 ——
      if (compressStrategy) {
        const usedTokens = contextTokens(system, toolDefs, history);
        const legacyLimit = Math.max(4, settings.chat.maxHistory || 40);
        const overTokens = compressCfg.threshold > 0 && usedTokens >= compressCfg.threshold;
        const overLegacy = compressCfg.threshold <= 0 && history.length > legacyLimit;
        const overHard = history.length > compressCfg.hardCap;
        // 保缓存模式:压缩后进入冷却期(默认再涨 3% 窗口),避免每次请求重写摘要导致 prompt cache 失效
        let cacheCooling = false;
        if (compressCfg.mode === 'cache' && compressCfg.cacheSlack > 0 && conv.compressState && conv.compressState.mode === 'cache') {
          const floor = Number(conv.compressState.tokens || 0) + compressCfg.cacheSlack;
          if (usedTokens < floor) cacheCooling = true;
        }
        if (!cacheCooling && (overTokens || overLegacy || overHard)) {
          try {
            const compacted = await summarizeInternal({
              internal: history, settings, conv, store, send, adapter, provider, model, signal, guard,
              modeCfg: compressMode,
              detail: {
                usedTokens, window: compressCfg.window, percent: compressCfg.percent,
                threshold: compressCfg.threshold, source: compressCfg.windowSource, mode: compressCfg.mode,
              },
            });
            if (compacted) {
              history = compacted;
              if (compressCfg.mode === 'cache') {
                // 记下压缩前的用量;下次要再涨 cacheSlack 才允许再次压缩
                conv.compressState = { mode: 'cache', tokens: usedTokens, at: Date.now() };
                store.saveConv(conv);
              }
            }
          } catch (e) {
            debuglog.warn(store, 'context', 'inline-summarize-fail', { streamId, message: String(e.message || e).slice(0, 200) });
          }
        }
      }

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
      const callLlm = async () => {
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
      };
      let res = await callLlm().catch(async (e) => {
        // 超限自救:任务中途撞上下文上限时,立即滚动压缩并在同一次任务内重试(仅一次),
        // 不再以报错终结整轮 —— 这是"压缩系统打断流程"问题的第二道兜底
        if (overflowRescued || aborted() || !isContextOverflow(e)) throw e;
        overflowRescued = true;
        debuglog.warn(store, 'context', 'overflow-rescue', { streamId, message: String(e.message || e).slice(0, 200) });
        const compacted = await summarizeInternal({ internal: history, settings, conv, store, send, adapter, provider, model, signal, guard, force: true });
        if (!compacted) throw e;
        history = compacted;
        outMessages = history;
        return callLlm();
      });
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
      // 输出速度:仅统计有正文的轮次,分子剔除思考 tokens(工具参数仍算输出,且分母也包含那段)
      if (iterStat.firstText) {
        const det = res.usage && res.usage.completion_tokens_details;
        const rtok = Number(det && det.reasoning_tokens) || 0;
        const ctok = Number(res.usage && res.usage.completion_tokens) || 0;
        statTps.tokens += Math.max(0, ctok - rtok);
        statTps.ms += Math.max(0, iterEnd - iterStat.firstText);
      }
      const pt = partTokens(history);
      statParts.system += sysTokens;
      statParts.tools += toolsTokens;
      statParts.injected += injectedTokens;
      statParts.user += pt.user;
      statParts.assistant += pt.assistant;
      statParts.toolResult += pt.toolResult;
      flushSend({ type: 'text-end', content: res.content || '' });
      // 轮间实时用量快照:多轮工具循环中每轮 LLM 完成即推送(不等整轮结束),用量条三段实时跳动
      if (usage) {
        const baseCu = conv.usage || { prompt: 0, completion: 0, cached: 0, requests: 0 };
        const baseG = store.config.usage || { prompt: 0, completion: 0, requests: 0, cached: 0 };
        const curP = (baseCu.prompt || 0) + (usage.prompt_tokens || 0);
        const curC = (baseCu.completion || 0) + (usage.completion_tokens || 0);
        const curCache = (baseCu.cached || 0) + (usage.cached_tokens || 0);
        flushSend({
          type: 'usage', estimated: false,
          convUsage: { prompt: curP, completion: curC, cached: curCache, requests: (baseCu.requests || 0) + 1 },
          ctx: { messages: history.length, tokens: estimateTokens(system || '') + history.reduce((n, m) => n + messageTokens(m), 0), parts: { ...statParts } },
          global: { ...baseG, prompt: (baseG.prompt || 0) + (usage.prompt_tokens || 0), completion: (baseG.completion || 0) + (usage.completion_tokens || 0) },
        });
      }
      if (aborted()) break;

      if (!res.toolCalls || !res.toolCalls.length) break;

      history.push({
        role: 'assistant',
        content: res.content || '',
        ...(res.reasoning ? { _reasoning: res.reasoning } : {}),
        tool_calls: res.toolCalls,
      });

      for (const tc of res.toolCalls) {
        let argsObj = {};
        try { argsObj = JSON.parse(tc.arguments || '{}'); } catch (_) { argsObj = { _raw: tc.arguments }; }

        if (tc.name === 'ask_user') {
          const q = {
            question: String(argsObj.question || '请做出选择').slice(0, 300),
            context: String(argsObj.context || '').slice(0, 500),
            options: (Array.isArray(argsObj.options) ? argsObj.options : []).slice(0, 4).map((o) => ({
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
        let imageResult = null; // 生图结果:[{ base64, mime }](v0.50.0)

        if (aborted()) break;
        // 人工审批(v0.49.3 起;v0.53.0 扩展到任意执行/破坏面):run_command(任意命令)、
        // run_code(任意代码)、delete_path(不可逆删除)执行前必须用户批准。
        // 审批等待期用户中止 → waitDecision 内部按拒绝收敛;registry 缺失(直连测试)→ 不阻塞。
        // 权限档位(v0.54.2,对话框左下角选择):plan=变更类全审批+先出计划 / writes=写与执行类审批 /
        // risk=仅高危三件套(历史默认) / full=全自动(沙箱与命令黑名单仍在)。与「模式」正交,只管确认频率。
        const permLevel = (settings.agent && settings.agent.permLevel) || 'risk';
        if (needApprove(tc.name, permLevel)) {
          flushSend({ type: 'tool-start', toolCallId: tc.id, name: tc.name, args: argsObj, status: 'awaiting' });
          security.auditAppend(store, { kind: 'approval', name: tc.name, brief: JSON.stringify(argsObj).slice(0, 200) });
          const approved = await waitDecision(streams.get(streamId), tc.id, signal);
          if (aborted()) break;
          if (!approved) {
            const deniedMsg = `用户拒绝了这次 ${tc.name} 执行(审批未通过)。不要重试同一操作;如任务仍需继续,请先询问用户。`;
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
            : tc.name === 'generate_image'
            ? await (async () => {
                // 生图桥接执行(v0.50.0):开关已在工具注入处把关,这里双检(防御直改配置)
                if (!igOn || !igProvider) throw new Error('图片生成未启用');
                const apiKey = (igProvider.apiKeys && igProvider.apiKeys[0]) || igProvider.apiKey || '';
                security.auditAppend(store, { kind: 'image', brief: String(argsObj.prompt || '').slice(0, 120), model: ig.model });
                const pText = String(argsObj.prompt || '');
                const sizeMatch = /(\d{3,4})\s*[xX×]\s*(\d{3,4})/.exec(pText);
                const size = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}` : (ig.size || '1024x1024');
                const imgs = await imagegen.imageGenerate(igProvider, apiKey, { model: ig.model, prompt: pText, size });
                imageResult = imgs;
                return `已生成 ${imgs.length} 张图片(${ig.model})。图片已直接展示给用户;请用一两句话说明画面,不要重复输出图片链接。`;
              })()
            : tc.name === 'screen_capture'
            ? await (async () => {
                // 截屏执行(工具链第二批):desktopCapturer 主屏 PNG;走 imageResult 路径展示 + 多模态回灌
                const electron = require('electron');
                const dc = electron && typeof electron === 'object' ? electron.desktopCapturer : null;
                if (!dc || !dc.getSources) throw new Error('screen_capture 仅在应用内可用');
                const sources = await dc.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
                const src = sources && sources[0];
                if (!src || src.thumbnail.isEmpty()) throw new Error('未获取到屏幕画面(可能无显示器访问权限)');
                const png = src.thumbnail.toPNG();
                security.auditAppend(store, { kind: 'screen-capture', note: String(argsObj.note || '').slice(0, 120), bytes: png.length });
                imageResult = [{ mime: 'image/png', base64: png.toString('base64') }];
                return `已截取屏幕(${src.name || '主屏'},${(png.length / 1024).toFixed(0)} KB PNG)。画面已展示给用户并回传给你,请基于画面内容回答。`;
              })()
            : tc.name === 'extract_frames'
            ? await (async () => {
                // 视频抽帧(工具链第三批):PNG 落盘 + imageResult 回灌(与 screen_capture 同路径)
                const videogen = require('./videogen');
                const pathMod = require('path');
                const fsCtx = { workspace, sandbox: sandboxPolicy, store, security: settings.security || {} };
                const rawIn = String(argsObj.path || '');
                const abs = await tools.assertFsPath(pathMod.isAbsolute(rawIn) ? pathMod.normalize(rawIn) : pathMod.resolve(workspace, rawIn), fsCtx, 'extract_frames');
                let prefix = abs.replace(/\.[^.]+$/, '');
                if (argsObj.outPrefix) {
                  const rawPfx = String(argsObj.outPrefix);
                  prefix = await tools.assertFsPath(pathMod.isAbsolute(rawPfx) ? pathMod.normalize(rawPfx) : pathMod.resolve(workspace, rawPfx), fsCtx, 'extract_frames');
                }
                security.auditAppend(store, { kind: 'video-frames', path: abs.slice(0, 200), count: (argsObj.times || []).length });
                const r = await videogen.extractFrames(abs, argsObj.times, prefix);
                imageResult = r.images.slice(0, 4); // 回灌上限 4 帧(上下文成本)
                return `已抽取 ${r.saved.length} 帧并保存:\n${r.saved.join('\n')}\n前 ${imageResult.length} 帧已回传给你(多模态模型可直接查看画面)。`;
              })()
            : tc.name === 'browser_check'
            ? await (async () => {
                // 网页检查(游戏工具链 v0.54.21):无头加载 → 控制台收集 → 截图 imageResult 回灌
                const electron = require('electron');
                const BW = electron && typeof electron === 'object' && typeof electron.BrowserWindow === 'function' ? electron.BrowserWindow : null;
                if (!BW) throw new Error('browser_check 仅在应用内可用');
                const url = String(argsObj.url || '');
                if (!/^(https?:\/\/|file:\/\/|data:)/i.test(url)) throw new Error('url 仅支持 http/https/file/data');
                const waitMs = Math.min(15000, Math.max(500, parseInt(argsObj.waitMs, 10) || 2500));
                const win = new BW({ show: false, width: 1280, height: 720, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
                const logs = [];
                const pushLog = (kind, text) => { if (logs.length < 40) logs.push(`[${kind}] ${String(text).slice(0, 300)}`); };
                win.webContents.on('console-message', (_e, level, message) => pushLog(level >= 2 ? 'error' : level === 1 ? 'warn' : 'log', message));
                try {
                  await win.loadURL(url);
                  await new Promise((r) => setTimeout(r, waitMs));
                  const title = win.webContents.getTitle();
                  const img = await win.webContents.capturePage();
                  const png = img.toPNG();
                  if (png.length) imageResult = [{ mime: 'image/png', base64: png.toString('base64') }];
                  security.auditAppend(store, { kind: 'browser-check', url: url.slice(0, 200) });
                  return `页面「${title || '(无标题)'}」已加载并截图(画面已展示给用户并回传给你)。控制台输出:\n${logs.length ? logs.join('\n') : '(无输出)'}${logs.length >= 40 ? '\n(截断至 40 条)' : ''}`;
                } finally {
                  try { win.destroy(); } catch (_) { /* 已销毁 */ }
                }
              })()
            : tc.name === 'blender_viewport' || tc.name.startsWith('blender_rt_')
            ? await (async () => {
                // Blender 建模工具链(v0.55.0):后端托管 + 图片走 imageResult 回灌(模型真看见视口)
                const r = await blender.callTool(tc.name, argsObj, { signal, store, workspace, sandbox: sandboxPolicy, security: settings.security || {} });
                if (r && Array.isArray(r.images) && r.images.length) imageResult = r.images;
                return r.text;
              })()
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
        // HTML 内部预览:open_external 对 .html 返回内部标记 → 事件驱动渲染端在面板浏览器打开
        if (typeof result === 'string' && result.startsWith('__INTERNAL_PREVIEW__')) {
          const raw = result.slice('__INTERNAL_PREVIEW__'.length);
          const cut = raw.indexOf('||');
          const pPath = cut >= 0 ? raw.slice(0, cut) : raw;
          const pNote = cut >= 0 ? raw.slice(cut + 2) : '';
          result = `已在内置浏览器打开: ${pPath}${pNote}`;
          flushSend({ type: 'internal-preview', path: pPath });
        }
        debuglog[status === 'done' ? 'info' : 'warn'](store, 'agent', 'tool', {
          streamId, name: tc.name, status, ms: Date.now() - toolT0,
          error: status === 'error' ? String(result).slice(0, 300) : undefined,
        });
        flushSend({ type: 'tool-end', toolCallId: tc.id, status, result: String(result).slice(0, 2000) });
        turn.blocks.push({ type: 'tool', id: tc.id, name: tc.name, args: argsObj, result: String(result), status });
        if (imageResult) {
          // 生图结果:作为 image 块落进 turn(含 base64,随会话落盘),渲染端直接展示
          for (const img of imageResult) {
            turn.blocks.push({ type: 'image', mime: img.mime, base64: img.base64 });
          }
          flushSend({ type: 'images', toolCallId: tc.id, images: imageResult.map((x) => ({ mime: x.mime, base64: x.base64 })) });
          // 多模态回灌(v0.51.1):把生成的图作为紧随的 user 消息进入 history ——
          // 文字模型下一轮能真实看到图(修改/迭代生图的上下文基础)
          history.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统] 以上 generate_image 的结果如下(共 ${imageResult.length} 张),用户后续可能要求修改,请结合图片回答:` },
              ...imageResult.map((x) => ({ type: 'image_url', image_url: { url: `data:${x.mime || 'image/png'};base64,${x.base64}` } })),
            ],
          });
        }
        history.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: String(result).slice(0, toolCap) });
      }

      if (aborted()) break;
      store.saveConv(conv); // 每轮落盘:崩溃/断电也能保住已生成内容
    }

    if (!turn.blocks.length) {
      conv.messages.pop();
      if (heldBranchTurn) conv.messages.push(heldBranchTurn); // 分支重试无产出 → 还原旧分支
    } else {
      // 纯空白正文/思考块不进档(v0.57.5):模型偶尔在工具轮之间只发一个空格/换行,
      // 落盘后渲染成空 iframe(默认 150px)→ 对话里出现上下中间一大片空白
      const kept = turn.blocks.filter((b) => {
        if (b.type !== 'text' && b.type !== 'reasoning') return true;
        return !!String(b.content || '').replace(/\s+/g, '');
      });
      if (kept.length !== turn.blocks.length) turn.blocks = kept;
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
    g.byModel[mk].tps = g.byModel[mk].tps || { tokens: 0, ms: 0 };
    g.byModel[mk].tps.tokens = (g.byModel[mk].tps.tokens || 0) + statTps.tokens;
    g.byModel[mk].tps.ms = (g.byModel[mk].tps.ms || 0) + statTps.ms;
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
    // 输出速度新口径累计(与旧 times/completion 并存,界面优先用 tps)
    g.tps = g.tps || { tokens: 0, ms: 0 };
    g.tps.tokens = (g.tps.tokens || 0) + statTps.tokens;
    g.tps.ms = (g.tps.ms || 0) + statTps.ms;
    statParts.output += c;
    g.parts = g.parts || { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 };
    for (const k of Object.keys(statParts)) g.parts[k] = (g.parts[k] || 0) + statParts[k];
    const dk = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    g.daily = g.daily || {};
    const day = g.daily[dk] || { requests: 0, prompt: 0, completion: 0, cached: 0, cost: 0, activeMs: 0, toolCount: 0, toolMs: 0, wait: 0, think: 0, output: 0, tps: { tokens: 0, ms: 0 }, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 } };
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
    day.tps = day.tps || { tokens: 0, ms: 0 };
    day.tps.tokens = (day.tps.tokens || 0) + statTps.tokens;
    day.tps.ms = (day.tps.ms || 0) + statTps.ms;
    for (const k of Object.keys(statParts)) day.parts[k] = (day.parts[k] || 0) + statParts[k];
    g.daily[dk] = day;
    store.updateConfig({ usage: g });

    turn.durationMs = Date.now() - t0; // 每条对话条旁的用时徽章(绿✓)
    store.saveConv(conv);
    debuglog.info(store, 'chat', 'chat:done', { streamId, ms: Date.now() - t0, aborted: aborted(), usage: usage || null });
    flushSend({ type: 'done', ms: Date.now() - t0, usage, aborted: aborted(), model: `${provider.name}/${model}` });
    flushSend({
      type: 'usage', estimated,
      convUsage: conv.usage, ctx: conv.ctx, global: g,
    });
  } catch (err) {
    if (!aborted() && err && err.name !== 'AbortError') {
      const last = conv.messages[conv.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.blocks.push({ type: 'error', message: err.message });
        last.durationMs = Date.now() - t0;
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
const DISPATCH_BASE_DESCRIPTION = '并行调度多个子智能体(每个子智能体拥有独立上下文,继承当前模式的工具与工作目录),返回各子智能体的结果汇总。子智能体看不到你们的对话,任务描述必须自包含。【使用纪律】凡是能拆成独立子任务的工作 —— 多文件/多模块生成、多角度调研、批量分析处理、需要第二意见的审查 —— 都应主动派发执行,不要为了省事全部自己串行做完;只有一句话就能回答的琐碎问题才不派发。拿到任务先判断"能不能拆、怎么拆",可并行的子任务放在一次调用里同时派出。';
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
    agentMd: settings.agentMd, // 全局规约对子智能体同样生效
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

module.exports = { runChat, buildHistory, buildSystemPrompt, makeTitle, maybeSummarize, streamWithKeyPool, pickKey, estimateTokens, cachedFromUsage, runDispatch, DISPATCH_DEFINITION, buildDispatchDefinition, resolveSubTarget, needApprove, PERM_WRITES, PERM_READONLY };
