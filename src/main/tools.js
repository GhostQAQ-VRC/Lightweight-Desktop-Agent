// Agent 工具集:定义(发给模型)+ 执行器(在主进程跑)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const security = require('./security');
const sandbox = require('./sandbox');
const search = require('./search');
const http = require('./http');

const DEFINITIONS = [
  {
    name: 'list_dir',
    description: '列出指定目录下的文件和子目录。相对路径基于当前工作目录解析。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径,默认为工作目录 "."' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取文本文件内容(输出带行号)。大文件可用 offset/limit 分段读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'integer', description: '起始行号,从 1 开始,默认 1' },
        limit: { type: 'integer', description: '读取行数,默认 400,最大 1000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '把文本内容写入文件(覆盖已有文件;目录不存在会自动创建)。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: `在用户电脑上用系统 Shell(${process.platform === 'win32' ? 'cmd.exe' : 'bash'})执行命令并返回输出。受沙箱约束:危险命令会被拦截,当前目录锁定在工作目录内。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '可选,执行目录,默认为工作目录' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: '联网搜索:用搜索引擎查询,返回标题/链接/摘要列表。适合查新闻、最新信息、文档定位;需要网页全文时再用 web_fetch 打开具体链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '可选,结果条数 1-10,默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '抓取网页内容并转为纯文本(去除 HTML 标签),用于查阅在线资料。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整的 http/https 链接' },
      },
      required: ['url'],
    },
  },
];

// 创造模式专属:智能体自我扩展(管理自己的助手角色与技能)
const SELF_DEFINITIONS = [
  {
    name: 'manage_assistants',
    description: '管理"助手角色"(顶栏可切换的系统提示词预设)。action=list 查看现有;create 创建;update 修改;delete 删除(默认助手不可删)。创建的助手立即出现在顶栏选择器中。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: '操作类型' },
        id: { type: 'string', description: 'update/delete 时必填,先用 list 查询' },
        name: { type: 'string', description: '角色名,简短(如:编程专家)' },
        icon: { type: 'string', description: '一个 emoji 图标' },
        prompt: { type: 'string', description: '角色系统提示词,写清楚身份、风格、输出要求' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_skills',
    description: '管理"技能"(输入框上方的快捷任务卡片,点击即激活对应指令)。action=list/create/update/delete。创建的技能立即出现在技能栏。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: '操作类型' },
        id: { type: 'string', description: 'update/delete 时必填' },
        name: { type: 'string', description: '技能名,2-6 个字最佳' },
        icon: { type: 'string', description: '一个 emoji 图标' },
        prompt: { type: 'string', description: '激活该技能时附加的系统指令' },
        insert: { type: 'string', description: '可选,激活时预填到输入框的模板' },
        agent: { type: 'boolean', description: '是否需要调用工具(建议配合完全/受限模式)' },
      },
      required: ['action'],
    },
  },
];

function selfChange(ctx) {
  try { if (ctx && ctx.onChange) ctx.onChange(); } catch (_) { /* ignore */ }
}

// ---- 记忆 / 学习(v0.41,开发者选项开关门控,由 agent.js 按开关注入工具) ----
const MEMORY_DEFINITIONS = [
  {
    name: 'memory_save',
    description: '保存一条长期记忆:用户的偏好、习惯、重要事实、项目背景、与用户的约定等。跨会话生效(开启记忆功能时,所有新对话自动继承)。只在值得长期记住时使用;不要保存密码/密钥等敏感信息;不要重复保存已有内容。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆内容,一句话,简明具体(如:用户的 VRChat 工程在 D:\\VRChat\\Projects)' },
      },
      required: ['text'],
    },
  },
];

const LEARN_DEFINITIONS = [
  {
    name: 'self_learn',
    description: '把用户纠正你的做法/教授的经验沉淀为长期知识。两种去向:kind=prompt 写入「用户提示词」—— 之后的每次对话自动生效,适合通用规矩与偏好(如"回答先给结论再给细节");kind=skill 创建「用户技能」—— 出现在输入框上方技能栏,用户点击启用,适合可复现的操作流程(如"部署步骤")。当用户指出你的错误并给出正确方法,或说"以后都这样做/记住这个方法"时使用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['prompt', 'skill'], description: 'prompt=每次对话自动生效的规矩;skill=技能栏卡片,按需启用' },
        title: { type: 'string', description: '标题:prompt 是规矩名(如"先结论后细节");skill 是技能名(2-6 个字)' },
        content: { type: 'string', description: '完整内容:用户教的正确方法,写具体、可执行,让下次照做不再犯错' },
      },
      required: ['kind', 'title', 'content'],
    },
  },
];

function memorySaveExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const clean = String(args.text || '').trim().slice(0, 400);
  if (!clean) throw new Error('缺少 text');
  let list = (store.config.memories || []).slice();
  if (list.some((m) => m.text === clean)) return '该记忆已存在,无需重复保存。';
  list.push({ id: 'mem-' + Math.random().toString(36).slice(2, 8), text: clean, createdAt: Date.now() });
  if (list.length > 200) list = list.slice(-200); // 上限 200 条:超出淘汰最旧
  store.updateConfig({ memories: list });
  selfChange(ctx);
  return `已保存长期记忆(${list.length}/200): ${clean}`;
}

function selfLearnExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const kind = String(args.kind || '');
  const title = String(args.title || '').trim();
  const content = String(args.content || '').trim();
  if (!title || !content) throw new Error('缺少 title 或 content');
  if (kind === 'prompt') {
    const list = (store.config.learnedPrompts || []).slice();
    const clean = content.slice(0, 2000);
    if (list.some((x) => x.text === clean)) return '该经验已在用户提示词中,无需重复学习。';
    list.push({ id: 'lp-' + Math.random().toString(36).slice(2, 8), title: title.slice(0, 30), text: clean, createdAt: Date.now() });
    if (list.length > 100) list = list.slice(-100);
    store.updateConfig({ learnedPrompts: list });
    selfChange(ctx);
    return `已沉淀为用户提示词「${title.slice(0, 30)}」(${list.length}/100):之后的每次对话自动生效。`;
  }
  if (kind === 'skill') {
    const list = (store.config.skills || []).slice();
    const name0 = title.slice(0, 20);
    const exist = list.find((s) => s.learned && s.name === name0);
    if (exist) {
      exist.prompt = content.slice(0, 4000);
      store.updateConfig({ skills: list });
      selfChange(ctx);
      return `已更新学习技能「${name0}」。`;
    }
    // 与既有技能同名时加后缀,不覆盖用户自建技能
    const name = list.some((s) => s.name === name0) ? (name0 + '-学').slice(0, 20) : name0;
    list.push({ id: 'learned-' + Math.random().toString(36).slice(2, 8), name, icon: '📖', prompt: content.slice(0, 4000), insert: '', agent: false, learned: true });
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return `已沉淀为用户技能「${name}」(📖 输入框上方技能栏可启用):之后的对话中按需启用。`;
  }
  throw new Error('kind 必须是 prompt 或 skill');
}

function manageAssistantsExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const action = String(args.action || '');
  let list = (store.config.assistants || []).slice();

  if (action === 'list') {
    if (!list.length) return '(暂无助手角色)';
    return list.map((a) => `- id:${a.id} | ${a.icon || '🤖'} ${a.name}${a.id === 'default' ? '(默认,不可删)' : ''}\n  提示词: ${(a.prompt || '(空)').slice(0, 100).replace(/\n/g, ' ')}`).join('\n');
  }
  if (action === 'create') {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('缺少 name');
    if (list.some((a) => a.name === name)) throw new Error(`已存在同名助手「${name}」,可换名或用 update 修改它`);
    const item = {
      id: 'ast-' + Math.random().toString(36).slice(2, 8),
      name: name.slice(0, 30),
      icon: String(args.icon || '🧩').slice(0, 8) || '🧩',
      prompt: String(args.prompt || '').slice(0, 8000),
    };
    list.push(item);
    store.updateConfig({ assistants: list });
    selfChange(ctx);
    return `已创建助手「${item.name}」(id: ${item.id}),已出现在顶栏选择器。`;
  }
  if (action === 'update') {
    const item = list.find((a) => a.id === args.id);
    if (!item) throw new Error('未找到该助手 id,可先 action=list 查询');
    if (args.name !== undefined && String(args.name).trim()) item.name = String(args.name).trim().slice(0, 30);
    if (args.icon !== undefined && String(args.icon).trim()) item.icon = String(args.icon).trim().slice(0, 8);
    if (args.prompt !== undefined) item.prompt = String(args.prompt).slice(0, 8000);
    store.updateConfig({ assistants: list });
    selfChange(ctx);
    return `已更新助手「${item.name}」。`;
  }
  if (action === 'delete') {
    if (args.id === 'default') throw new Error('默认助手不可删除');
    const before = list.length;
    list = list.filter((a) => a.id !== args.id);
    if (list.length === before) throw new Error('未找到该助手 id');
    store.updateConfig({ assistants: list });
    selfChange(ctx);
    return '已删除该助手。';
  }
  throw new Error('action 必须是 list/create/update/delete');
}

function manageSkillsExec(args, ctx) {
  const store = ctx.store;
  if (!store || !store.config) throw new Error('内部错误:缺少配置访问');
  const action = String(args.action || '');
  let list = (store.config.skills || []).slice();

  if (action === 'list') {
    if (!list.length) return '(暂无技能)';
    return list.map((s) => `- id:${s.id} | ${s.icon || '⚡'} ${s.name} | 需工具:${!!s.agent}\n  附加指令: ${(s.prompt || '(空)').slice(0, 100).replace(/\n/g, ' ')}`).join('\n');
  }
  if (action === 'create') {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('缺少 name');
    if (list.some((s) => s.name === name)) throw new Error(`已存在同名技能「${name}」`);
    const item = {
      id: 'skill-' + Math.random().toString(36).slice(2, 8),
      name: name.slice(0, 20),
      icon: String(args.icon || '⚡').slice(0, 8) || '⚡',
      prompt: String(args.prompt || '').slice(0, 4000),
      insert: String(args.insert || '').slice(0, 2000),
      agent: !!args.agent,
    };
    list.push(item);
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return `已创建技能「${item.name}」(id: ${item.id}),已出现在输入框上方技能栏。`;
  }
  if (action === 'update') {
    const item = list.find((s) => s.id === args.id);
    if (!item) throw new Error('未找到该技能 id,可先 action=list 查询');
    if (args.name !== undefined && String(args.name).trim()) item.name = String(args.name).trim().slice(0, 20);
    if (args.icon !== undefined && String(args.icon).trim()) item.icon = String(args.icon).trim().slice(0, 8);
    if (args.prompt !== undefined) item.prompt = String(args.prompt).slice(0, 4000);
    if (args.insert !== undefined) item.insert = String(args.insert).slice(0, 2000);
    if (args.agent !== undefined) item.agent = !!args.agent;
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return `已更新技能「${item.name}」。`;
  }
  if (action === 'delete') {
    const before = list.length;
    list = list.filter((s) => s.id !== args.id);
    if (list.length === before) throw new Error('未找到该技能 id');
    store.updateConfig({ skills: list });
    selfChange(ctx);
    return '已删除该技能。';
  }
  throw new Error('action 必须是 list/create/update/delete');
}

function resolveIn(p, workspace) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('缺少 path 参数');
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspace, p);
}

// Windows 下很多命令输出 GBK:优先按 UTF-8 解码,出现替换符时回退 GBK
function decodeBuffer(buf) {
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    try {
      const alt = new TextDecoder('gbk').decode(buf);
      if (!alt.includes('\uFFFD')) text = alt;
    } catch (_) { /* ICU 不含 gbk 时忽略 */ }
  }
  return text;
}

function stripHtml(html) {
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&nbsp;': ' ', '&copy;': '©', '&mdash;': '—',
  };
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp|copy|mdash);/g, (m) => entities[m] || m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function fetchWithTimeout(url, ms, outerSignal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`请求超时(${ms / 1000}s)`)), ms);
  const onAbort = () => ac.abort(outerSignal && outerSignal.reason ? outerSignal.reason : new Error('已中止'));
  if (outerSignal) {
    if (outerSignal.aborted) onAbort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  return http.fetch(url, {
    signal: ac.signal,
    headers: { 'user-agent': 'Mozilla/5.0 (LiteAgent/0.1)' },
    redirect: 'follow',
  }).finally(() => {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  });
}

function runCommand(command, cwd, timeoutSec, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      });
    } catch (e) {
      resolve(`命令启动失败: ${e.message}`);
      return;
    }

    const CAP = 64 * 1024;
    const chunks = [];
    const size = () => chunks.reduce((n, c) => n + c.length, 0);
    let killed = false;

    const killTree = () => {
      killed = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (_) { try { child.kill(); } catch (_) { /* ignore */ } }
    };

    const timer = setTimeout(killTree, Math.max(5, Number(timeoutSec) || 120) * 1000);
    const onAbort = () => killTree();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => { if (size() < CAP * 2) chunks.push(d); });
    child.stderr.on('data', (d) => { if (size() < CAP * 2) chunks.push(d); });

    child.on('error', (e) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(`命令启动失败: ${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      let out = decodeBuffer(Buffer.concat(chunks)).trim();
      let truncated = '';
      if (out.length > CAP) { out = out.slice(0, CAP); truncated = '\n…(输出过长已截断)'; }
      const head = killed ? '命令超时或被中止,已强制结束。\n' : '';
      resolve(`${head}退出码: ${code === null ? '-' : code}\n${out ? out + truncated : '(无输出)'}`);
    });
  });
}

// 沙箱检查:文件路径锁定/系统区黑名单;失败抛错并记审计。
// 在 path.resolve 之上追加 realpath 防线:junction/symlink 的真实指向也必须在工作目录内
// (path.resolve 不解析链接,mklink /J 建在工作目录内即可让表面路径穿透 —— 攻防测试 B2 锚定)。
async function assertFsPath(abs, ctx, toolName) {
  const sb = ctx.sandbox || { fsLock: true, cmdScreen: 'strict' };
  const c = sandbox.checkFsPath(abs, ctx.workspace, sb.fsLock);
  if (!c.ok) {
    if (ctx.store) security.auditAppend(ctx.store, { kind: 'sandbox', tool: toolName, detail: String(c.reason).slice(0, 200) });
    throw new Error(c.reason);
  }
  let real = null;
  try {
    real = await fsp.realpath(c.path);
  } catch (_) {
    // 路径尚不存在(写入场景):对最近的现存祖先解析链接后再拼回
    try { real = path.join(await fsp.realpath(path.dirname(c.path)), path.basename(c.path)); } catch (_) { /* 祖先也不存在时无从解析 */ }
  }
  if (real) {
    const c2 = sandbox.checkFsPath(real, ctx.workspace, sb.fsLock);
    if (!c2.ok) {
      const reason = `已按沙箱设置拦截:该路径是目录链接(junction/symlink)或短文件名,真实指向越出允许范围。${c2.reason}`;
      if (ctx.store) security.auditAppend(ctx.store, { kind: 'sandbox', tool: toolName, detail: reason.slice(0, 200) });
      throw new Error(reason);
    }
  }
  return c.path;
}

async function execute(name, args, ctx) {
  // ctx: { workspace, shellTimeout, signal, sandbox: {fsLock, cmdScreen}, store, security }
  args = args || {};
  switch (name) {
    case 'list_dir': {
      const abs = await assertFsPath(resolveIn(args.path || '.', ctx.workspace), ctx, 'list_dir');
      let entries;
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch (e) {
        throw new Error(`无法读取目录 ${abs}: ${e.message}`);
      }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      const items = entries.slice(0, 500).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
      return `目录: ${abs}(共 ${entries.length} 项${entries.length > 500 ? ',仅显示前 500' : ''})\n${items.join('\n') || '(空目录)'}`;
    }

    case 'read_file': {
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'read_file');
      const st = await fsp.stat(abs).catch(() => { throw new Error(`文件不存在: ${abs}`); });
      if (st.isDirectory()) throw new Error(`这是一个目录,请改用 list_dir: ${abs}`);
      if (st.size > 512 * 1024) throw new Error(`文件过大(${(st.size / 1024).toFixed(0)}KB),超过 512KB 上限,请用命令行工具处理`);
      const raw = await fsp.readFile(abs, 'utf8');
      const lines = raw.split(/\r?\n/);
      const offset = Math.max(1, parseInt(args.offset, 10) || 1);
      const limit = Math.min(1000, Math.max(1, parseInt(args.limit, 10) || 400));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n');
      const more = offset - 1 + slice.length < lines.length
        ? `\n…(共 ${lines.length} 行,可用 offset=${offset + limit} 继续读取)`
        : '';
      return `文件: ${abs}(${st.size} 字节)\n${numbered}${more}`;
    }

    case 'write_file': {
      if (typeof args.content !== 'string') throw new Error('缺少 content 参数');
      const abs = await assertFsPath(resolveIn(args.path, ctx.workspace), ctx, 'write_file');
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, args.content, 'utf8');
      const lineCount = args.content ? args.content.split(/\r?\n/).length : 0;
      return `已写入: ${abs}(${args.content.length} 字符,${lineCount} 行)`;
    }

    case 'run_command': {
      const command = String(args.command || '').trim();
      if (!command) throw new Error('缺少 command 参数');
      const sb = ctx.sandbox || { fsLock: true, cmdScreen: 'strict' };
      const screen = sandbox.screenCommand(command, sb.cmdScreen);
      if (!screen.ok) {
        if (ctx.store) security.auditAppend(ctx.store, { kind: 'sandbox', tool: 'run_command', detail: screen.reason.slice(0, 200) });
        throw new Error(screen.reason);
      }
      const cwd = await assertFsPath(resolveIn(args.cwd || '.', ctx.workspace), ctx, 'run_command');
      const st = await fsp.stat(cwd).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error(`执行目录不存在: ${cwd}`);
      return runCommand(command, cwd, ctx.shellTimeout, ctx.signal);
    }

    case 'web_search':
      return search.webSearchExec(args, ctx);

    case 'web_fetch': {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 链接');
      // 与模型请求同门槛:HTTPS 强制 + 域名白名单(防借工具探测内网/明文外发)
      if (ctx.security) security.assertUrlAllowed(url, ctx.security);
      const res = await fetchWithTimeout(url, 20000, ctx.signal);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!/text\/|json|xml|html/.test(ct)) throw new Error(`不支持的内容类型: ${ct || '未知'}`);
      const body = await res.text();
      const isHtml = /html/.test(ct) || /^\s*<(!doctype|html)/i.test(body);
      let text = isHtml ? stripHtml(body) : body;
      if (text.length > 12000) text = text.slice(0, 12000) + '\n…(内容过长已截断)';
      return `URL: ${url}\n状态码: ${res.status}\n\n${text || '(空内容)'}`;
    }

    case 'manage_assistants':
      return manageAssistantsExec(args, ctx);

    case 'manage_skills':
      return manageSkillsExec(args, ctx);

    case 'memory_save':
      return memorySaveExec(args, ctx);

    case 'self_learn':
      return selfLearnExec(args, ctx);

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

module.exports = { DEFINITIONS, SELF_DEFINITIONS, MEMORY_DEFINITIONS, LEARN_DEFINITIONS, execute };
