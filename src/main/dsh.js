// DeepSeek Harness (DSH) 插件兼容层
// DSH 插件 = npm/GitHub 分发的包;本模块负责安装、扫描并抽取可直接挂载的部分:
//   1) MCP 服务配置(package.json 或包内 JSON 中的 mcpServers)→ 导入 LiteAgent 的 MCP 客户端
//   2) 技能文件(带 frontmatter 的 Markdown,与 dsh-skill-filesystem 同源格式)→ 导入为 LiteAgent 技能
// 其余 Cordis 代码插件需要完整 DSH 运行时,如实标注、不强加载。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const MAX_SKILL_FILES = 100;
const MAX_SKILL_CHARS = 4000;

// 安装来源白名单:包名 / @scope/name / name@版本 / user/repo#tag / https URL。
// Windows 下 npm.cmd 必须经 shell 执行,元字符会进 cmd,这里必须挡住注入面。
const SPEC_RE = /^[A-Za-z0-9@/._~:#?=+-]+$/;
function validNpmSpec(s) {
  return typeof s === 'string' && s.length <= 300 && !s.includes('..') && SPEC_RE.test(s);
}

function runNpm(args, cwd, timeoutMs = 300000, extraEnv) {
  return new Promise((resolve) => {
    // Node 20.12+/Electron 33 起,spawn npm.cmd 且 shell:false 一律同步抛 EINVAL
    // (CVE-2024-27980 批处理注入防御)。Windows 上必须走 shell 让 cmd 解析 npm.cmd;
    // args 均已过 validNpmSpec 白名单(无空格/元字符),join 拼接安全。
    const win = process.platform === 'win32';
    const env = extraEnv && Object.keys(extraEnv).length ? { ...process.env, ...extraEnv } : undefined;
    const child = spawn('npm', args, { cwd, windowsHide: true, shell: win, env });
    let out = '';
    const timer = setTimeout(() => {
      try {
        // shell 模式下 child 是 cmd.exe,kill() 不杀 npm 本体 → Windows 用 taskkill 清树
        if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else child.kill();
      } catch (_) {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const npmMissing = (msg) => /not recognized|不是内部或外部|无法将.*识别|ENOENT/i.test(msg)
      ? '\n未检测到 npm:请先安装 Node.js(自带 npm)并重启应用后重试。'
      : '';
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: `npm 启动失败: ${e.message}${npmMissing(e.message)}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = out.slice(-4000);
      resolve({ ok: code === 0, output: code === 0 ? output : output + npmMissing(output) });
    });
  });
}

// 安装:npm 包名 / GitHub (user/repo 或完整 url) 都交给 npm 处理
async function installPackage(pluginsDir, source, extraEnv) {
  const spec = String(source || '').trim();
  if (!spec) return { ok: false, output: '安装来源为空' };
  if (!validNpmSpec(spec)) return { ok: false, output: '来源格式无效:仅支持 npm 包名(@scope/name、name@版本)或 GitHub 仓库(user/repo 或 https URL),不能包含空格或特殊字符' };
  await fsp.mkdir(pluginsDir, { recursive: true });
  const res = await runNpm(['install', '--no-audit', '--no-fund', '--legacy-peer-deps', '--loglevel=error', '--ignore-scripts', spec], pluginsDir, 300000, extraEnv);
  return res;
}

async function listInstalled(pluginsDir) {
  const root = path.join(pluginsDir, 'node_modules');
  const out = [];
  async function scanScope(dir, scope) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (scope) {
        out.push(await describePkg(full, `${scope}/${e.name}`));
      } else if (e.name.startsWith('@')) {
        await scanScope(full, e.name);
      } else {
        out.push(await describePkg(full, e.name));
      }
    }
  }
  await scanScope(root, null);
  return out.filter(Boolean);
}

async function describePkg(dir, name) {
  let pkg = null;
  try { pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')); } catch (_) { return null; }
  const keywords = pkg.keywords || [];
  const isDsh = keywords.includes('dsh-plugin') || keywords.includes('deepseek-harness')
    || /@deepseek-ai\//.test(JSON.stringify(pkg.dependencies || {}) + JSON.stringify(pkg.peerDependencies || {}));
  return { name: pkg.name || name, version: pkg.version || '', dir, isDsh, hasMain: !!pkg.main };
}

// 从包中抽取可挂载内容
async function scanPackage(dir) {
  const result = { mcpServers: [], skills: [], notes: [] };
  let pkg = {};
  try { pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')); } catch (_) { /* ignore */ }

  // 1) MCP 配置:package.json 的 mcpServers / dsh.mcpServers / contributes.mcpServers
  const candidates = [pkg.mcpServers, pkg.dsh && pkg.dsh.mcpServers, pkg.contributes && pkg.contributes.mcpServers];
  for (const c of candidates) collectMcpMap(c, result);

  // 2) 包内 JSON 文件里的 mcpServers(常见:mcp.json、dsh.json)
  const jsonFiles = await walk(dir, '.json', 3);
  for (const f of jsonFiles.slice(0, 30)) {
    try {
      const j = JSON.parse(await fsp.readFile(f, 'utf8'));
      if (j && typeof j === 'object' && j.mcpServers) collectMcpMap(j.mcpServers, result);
      if (j && typeof j === 'object' && j.servers) collectMcpMap(j.servers, result);
    } catch (_) { /* ignore */ }
  }

  // 3) 技能文件:带 frontmatter 的 Markdown(兼容 dsh skill 与 SKILL.md 约定)
  const mdFiles = await walk(dir, '.md', 4);
  for (const f of mdFiles) {
    if (result.skills.length >= MAX_SKILL_FILES) { result.notes.push('技能文件过多,仅导入前 100 个'); break; }
    const skill = parseSkillMd(f);
    if (skill) result.skills.push(skill);
  }

  if (!result.mcpServers.length && !result.skills.length) {
    result.notes.push('未发现可直接挂载的 MCP 配置或技能文件,已安装到本地。若它是代码插件:开启 设置 → 开发者选项 的「插件兼容(DSH 运行时层)」后,在开发者选项的插件兼容框中对该包点「载入」。注意:工具型插件可用;客户端 UI 扩展型(桌面宠物/小组件等)依赖 DSH 客户端环境,载入时会明确提示缺少哪些服务。');
  }
  return result;
}

function collectMcpMap(map, result) {
  if (!map || typeof map !== 'object') return;
  for (const [name, s] of Object.entries(map)) {
    if (!s || typeof s !== 'object') continue;
    const cfg = { id: 'mcp-' + Math.random().toString(36).slice(2, 8), name: String(name).slice(0, 30), enabled: true, autoApprove: false };
    if (s.url) {
      cfg.transport = 'http';
      cfg.url = String(s.url);
      cfg.headers = sanitizeHeaders(s.headers);
    } else if (s.command) {
      cfg.transport = 'stdio';
      cfg.command = String(s.command);
      cfg.args = Array.isArray(s.args) ? s.args.map(String) : [];
      cfg.env = sanitizeEnv(s.env);
    } else {
      continue;
    }
    if (!result.mcpServers.some((x) => x.name === cfg.name && x.url === cfg.url && x.command === cfg.command)) {
      result.mcpServers.push(cfg);
    }
  }
}

function sanitizeHeaders(h) {
  const out = {};
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === 'string') out[k] = v.slice(0, 500);
    }
  }
  return out;
}

function sanitizeEnv(e) {
  const out = {};
  if (e && typeof e === 'object') {
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

// 解析带 YAML frontmatter 的 Markdown 技能文件
function parseSkillMd(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  if (!raw.trim()) return null;
  let meta = {};
  let content = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    content = raw.slice(m[0].length);
  }
  const base = path.basename(file, '.md');
  const name = (meta.name || base).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 30);
  // 认定技能:frontmatter 带 name 字段,或文件名是 SKILL.md / *.skill.md
  const isSkill = (m && meta.name) || /^skill\.md$/i.test(path.basename(file)) || /\.skill\.md$/i.test(path.basename(file));
  if (!isSkill) return null; // 普通文档不当作技能
  content = content.trim();
  if (!content) return null;
  return {
    name,
    displayName: meta.name || base,
    description: (meta.description || '').slice(0, 200),
    content: content.slice(0, MAX_SKILL_CHARS),
    file,
  };
}

async function walk(dir, ext, maxDepth, depth = 0) {
  if (depth > maxDepth) return [];
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'test' || e.name === 'tests') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full, ext, maxDepth, depth + 1)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

async function removePackage(pluginsDir, name, extraEnv) {
  if (!validNpmSpec(name)) return { ok: false, output: '插件名无效' };
  const res = await runNpm(['uninstall', '--loglevel=error', name], pluginsDir, 120000, extraEnv);
  return res;
}

module.exports = { installPackage, listInstalled, scanPackage, removePackage, validNpmSpec };
