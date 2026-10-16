// 数据目录迁移(v0.40 常规设置):Electron 启动早期必须先 app.setPath('userData') 才能让 store
// 读到自定义目录。但自定义目录本身写在配置里,而配置又在 userData 里 —— 鸡生蛋问题。
// 解法:在【默认】userData 目录放一个标记文件 data-dir.txt(内容 = 自定义目录绝对路径),
// 启动时先读标记再 setPath;恢复默认 = 删标记。标记文件所在目录永远可定位,不依赖任何配置。
const fs = require('fs');
const path = require('path');

let defaultDir = null;   // 默认 userData(启动最早期定格)
let markerFile = null;

// main.js 在任何 setPath 之前调用
function initDefault(app) {
  defaultDir = app.getPath('userData');
  markerFile = path.join(defaultDir, 'data-dir.txt');
}

function readMarker() {
  try {
    const v = fs.readFileSync(markerFile, 'utf8').trim();
    return (v && path.isAbsolute(v)) ? v : null;
  } catch (_) { return null; }
}

// 启动应用:标记有效(目录存在)则切 userData;返回实际生效目录
function applyStartup(app) {
  const custom = readMarker();
  if (custom && fs.existsSync(custom)) {
    app.setPath('userData', custom);
    return { dir: custom, custom: true };
  }
  return { dir: defaultDir, custom: false };
}

// 缓存类目录:不随数据迁移(体积大且可再生)
const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'Crashpad', 'crash_dumps']);
const SKIP_FILES = new Set(['data-dir.txt', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);

// 切换数据目录:写标记 + 把现有数据复制过去(目标已有 config.json 则视为既有数据,不覆盖)。
// 旧目录原样保留(迁移失败/后悔时可改回)。需要重启生效。
function setCustomDir(target) {
  const dir = String(target || '').trim();
  if (!dir || !path.isAbsolute(dir)) return { ok: false, message: '请填写绝对路径' };
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(defaultDir)) return { ok: false, message: '该路径就是默认数据目录' };
  if (resolved === path.resolve(process.execPath, '..')) return { ok: false, message: '不能选程序安装目录' };
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (e) { return { ok: false, message: '目录不可写: ' + (e.message || e) }; }
  const hasData = fs.existsSync(path.join(resolved, 'config.json'));
  if (!hasData) {
    // 复制现有数据(跳过缓存与标记/锁文件)
    try {
      for (const entry of fs.readdirSync(defaultDir, { withFileTypes: true })) {
        if (entry.name.startsWith('Singleton') || entry.name === 'lockfile' || entry.name === 'data-dir.txt') continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const from = path.join(defaultDir, entry.name);
        const to = path.join(resolved, entry.name);
        if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
        else if (!fs.existsSync(to)) fs.copyFileSync(from, to);
      }
    } catch (e) { return { ok: false, message: '数据复制失败(目录已写入标记,可重试或改回): ' + (e.message || e) }; }
  }
  try { fs.writeFileSync(markerFile, resolved, 'utf8'); } catch (e) { return { ok: false, message: '标记写入失败: ' + (e.message || e) }; }
  return { ok: true, dir: resolved, reusedExisting: hasData };
}

// 恢复默认:删标记(自定义目录的数据保留在原地)
function resetToDefault() {
  try { fs.unlinkSync(markerFile); return { ok: true }; } catch (_) { return { ok: true }; }
}

module.exports = { initDefault, applyStartup, setCustomDir, resetToDefault, defaultDir: () => defaultDir, markerFile: () => markerFile };
