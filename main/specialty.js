// 技能专精(Specialty Packs):领域知识包 = 专精人设 + 知识库 + 按需读取工具
// 内置包随应用分发(resources/specialties),用户包在 userData/specialties;
// 激活后:系统提示词注入 专精人设 + 常载核心 + 路由索引,智能体用 read_specialty 工具按需查阅知识文件
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const debuglog = require('./debuglog');

function builtinRoot() {
  return path.join(__dirname, '..', '..', 'resources', 'specialties');
}
function userRoot(store) {
  return path.join(store.baseDir(), 'specialties');
}

function packDir(store, id, builtin) {
  return builtin ? path.join(builtinRoot(), id) : path.join(userRoot(store), id);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// 启动时把内置包同步到用户目录(版本更新时覆盖)
function ensureBuiltins(store) {
  let builtins = [];
  try { builtins = fs.readdirSync(builtinRoot()); } catch (_) { return; }
  fs.mkdirSync(userRoot(store), { recursive: true });
  for (const id of builtins) {
    const src = path.join(builtinRoot(), id);
    const meta = readJson(path.join(src, 'specialty.json'));
    if (!meta || !fs.existsSync(path.join(src, 'knowledge'))) continue;
    const dst = path.join(userRoot(store), id);
    const dstMeta = readJson(path.join(dst, 'specialty.json'));
    if (dstMeta && (dstMeta.version || 0) >= (meta.version || 1)) continue;
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
      debuglog.info(store, 'specialty', '内置专精已同步', { id, version: meta.version || 1 });
    } catch (_) { /* 磁盘问题时保留旧版 */ }
  }
}

// 列出全部包(用户包优先展示;同名 id 视为同一个)
function list(store) {
  ensureBuiltins(store);
  const out = new Map();
  for (const base of [builtinRoot(), userRoot(store)]) {
    let ids = [];
    try { ids = fs.readdirSync(base); } catch (_) { continue; }
    for (const id of ids) {
      const meta = readJson(path.join(base, id, 'specialty.json'));
      if (!meta) continue;
      const knowledgeDir = path.join(base, id, 'knowledge');
      let fileCount = 0;
      try { fileCount = countFiles(knowledgeDir); } catch (_) { /* ignore */ }
      out.set(meta.id || id, {
        id: meta.id || id,
        name: meta.name || id,
        icon: meta.icon || '🎓',
        description: meta.description || '',
        version: meta.version || 1,
        builtin: base === builtinRoot(),
        fileCount,
        alwaysLoad: meta.alwaysLoad || [],
        prompt: meta.prompt || '',
      });
    }
  }
  return [...out.values()];
}

function getPack(store, id) {
  for (const base of [userRoot(store), builtinRoot()]) {
    const meta = readJson(path.join(base, id, 'specialty.json'));
    if (meta) {
      const knowledgeDir = path.join(base, id, 'knowledge');
      return {
        id: meta.id || id,
        name: meta.name || id,
        icon: meta.icon || '🎓',
        version: meta.version || 1,
        prompt: meta.prompt || '',
        alwaysLoad: meta.alwaysLoad || ['index.md'],
        knowledgeDir,
        builtin: base === builtinRoot(),
      };
    }
  }
  return null;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.toLowerCase().endsWith('.md')) n++;
    }
  };
  walk(dir);
  return n;
}

// 文件树(相对路径),用于索引与校验
function fileTree(knowledgeDir) {
  const out = [];
  const walk = (d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.name.toLowerCase().endsWith('.md')) out.push(rel);
    }
  };
  walk(knowledgeDir, '');
  return out.sort();
}

// 系统提示词注入内容:人设 + 常载核心 + 路由索引
function promptExtras(store, pack) {
  const parts = [];
  if (pack.prompt) parts.push(pack.prompt);
  const files = fileTree(pack.knowledgeDir);
  parts.push(`# 知识库使用说明\n本专精附带了 ${files.length} 篇领域知识文件,位于 read_specialty 工具可访问的目录。先用下方路由索引定位相关文件,再用 read_specialty 读取全文。引用时注明文件路径。`);
  for (const rel of pack.alwaysLoad) {
    try {
      const text = fs.readFileSync(path.join(pack.knowledgeDir, rel), 'utf8');
      // 去掉 frontmatter 元数据,只留正文,并截断
      const body = text.replace(/^---[\s\S]*?---\r?\n?/, '').trim();
      parts.push(`## 常载:${rel}\n${body.slice(0, 6000)}`);
    } catch (_) { /* 常载文件缺失则跳过 */ }
  }
  if (files.length) {
    parts.push('## 知识文件索引(' + files.length + ' 篇)\n' + files.slice(0, 400).join('\n'));
  }
  return { name: pack.name, text: parts.join('\n\n').slice(0, 18000) };
}

// 读取知识文件(带行号,防目录穿越)
async function readKnowledge(store, packId, relPath, offset, limit) {
  const pack = getPack(store, packId);
  if (!pack) throw new Error('专精包不存在: ' + packId);
  const root = path.resolve(pack.knowledgeDir);
  const target = path.resolve(root, String(relPath || ''));
  if (!target.startsWith(root)) throw new Error('非法路径(目录穿越已拦截): ' + relPath);
  const st = await fsp.stat(target).catch(() => { throw new Error(`知识文件不存在: ${relPath}`); });
  if (st.isDirectory()) throw new Error('这是目录,请指定具体文件。可用索引见系统提示词,或用 path=index.md 开始浏览');
  if (st.size > 1024 * 1024) throw new Error(`文件过大(${(st.size / 1024).toFixed(0)}KB)`);
  const raw = await fsp.readFile(target, 'utf8');
  const lines = raw.split(/\r?\n/);
  const off = Math.max(1, parseInt(offset, 10) || 1);
  const lim = Math.min(1200, Math.max(1, parseInt(limit, 10) || 600));
  const slice = lines.slice(off - 1, off - 1 + lim);
  const numbered = slice.map((l, i) => `${String(off + i).padStart(5)}| ${l}`).join('\n');
  const more = off - 1 + slice.length < lines.length ? `\n…(共 ${lines.length} 行,可用 offset=${off + lim} 续读)` : '';
  return `文件: ${relPath}(${st.size} 字节)\n${numbered}${more}`;
}

// 导入:zip(经 PowerShell 展开)或文件夹 → 生成用户专精包
async function importFromPath(store, srcPath, win) {
  const src = String(srcPath || '');
  const stat = await fsp.stat(src).catch(() => null);
  if (!stat) throw new Error('路径不存在');
  let name = path.basename(src).replace(/\.(zip)$/i, '');
  const tmpExtract = path.join(userRoot(store), '.tmp-import-' + Date.now());
  let contentDir = null;
  if (stat.isFile() && /\.zip$/i.test(src)) {
    fs.mkdirSync(tmpExtract, { recursive: true });
    const ps = `Expand-Archive -Path "${src.replace(/'/g, "''")}" -DestinationPath "${tmpExtract.replace(/'/g, "''")}" -Force`;
    const { spawnSync } = require('child_process');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 120000 });
    if (r.status !== 0) throw new Error('解压失败: ' + String(r.stderr || '').slice(0, 200));
    // 若解压后只有单一根目录则进入
    let entries = fs.readdirSync(tmpExtract);
    contentDir = tmpExtract;
    if (entries.length === 1 && fs.statSync(path.join(tmpExtract, entries[0])).isDirectory()) {
      contentDir = path.join(tmpExtract, entries[0]);
    }
  } else if (stat.isDirectory()) {
    contentDir = src;
  } else if (stat.isFile() && /\.md$/i.test(src)) {
    name = path.basename(src, '.md');
    contentDir = null;
    fs.mkdirSync(tmpExtract, { recursive: true });
    fs.copyFileSync(src, path.join(tmpExtract, path.basename(src)));
    contentDir = tmpExtract;
  } else {
    throw new Error('仅支持 .zip 压缩包、文件夹或单个 .md 文件');
  }
  // 找到知识根(含 md 最多的层;若根本身就有 index.md/_always-load.md 直接用)
  const hasLlmRoot = fs.existsSync(path.join(contentDir, 'LLMWikiPage')) || fs.existsSync(path.join(contentDir, 'index.md')) || fs.existsSync(path.join(contentDir, '_always-load.md'));
  let knowledgeDir = contentDir;
  if (fs.existsSync(path.join(contentDir, 'LLMWikiPage'))) knowledgeDir = path.join(contentDir, 'LLMWikiPage');

  const id = 'user-' + Date.now().toString(36);
  const dst = path.join(userRoot(store), id);
  fs.mkdirSync(path.join(dst, 'knowledge'), { recursive: true });
  fs.cpSync(knowledgeDir, path.join(dst, 'knowledge'), { recursive: true });
  const meta = readJson(path.join(knowledgeDir, 'specialty.json')) || {};
  const finalMeta = {
    id,
    name: meta.name || name || ('专精 ' + id),
    icon: meta.icon || '🎓',
    version: meta.version || 1,
    builtin: false,
    description: meta.description || `导入的知识专精(${countFiles(path.join(dst, 'knowledge'))} 篇)`,
    prompt: meta.prompt || `你是「${meta.name || name}」领域的资深专家。回答优先依据知识库内容(用 read_specialty 工具查阅),引用时注明文件路径;知识库未覆盖的内容明确说明,不要编造。`,
    alwaysLoad: meta.alwaysLoad || (fs.existsSync(path.join(dst, 'knowledge', '_always-load.md')) ? ['_always-load.md', 'index.md'] : (fs.existsSync(path.join(dst, 'knowledge', 'index.md')) ? ['index.md'] : [])),
  };
  fs.writeFileSync(path.join(dst, 'specialty.json'), JSON.stringify(finalMeta, null, 2), 'utf8');
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  return { ...getPack(store, id), fileCount: countFiles(path.join(dst, 'knowledge')) };
}

function deletePack(store, id) {
  const dst = path.join(userRoot(store), id);
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
    return true;
  }
  return false; // 内置包不可物理删除
}

module.exports = { ensureBuiltins, list, getPack, promptExtras, readKnowledge, importFromPath, deletePack, userRoot, fileTree };
