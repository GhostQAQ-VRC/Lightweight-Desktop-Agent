// 模型能力库(models.dev 快照)更新:手动按钮(modeldb:update)与启动自动更新共用
const fs = require('fs');
const path = require('path');
const http = require('./http');
const modelCaps = require('./modelCaps');

const MODELS_DEV_URL = 'https://models.dev/api.json';
const AUTO_INTERVAL_MS = 7 * 24 * 3600 * 1000;

// 拉取 → 转换 → 原子写用户数据目录(model-db.json,优先级高于内置 resources 快照)→ 记录更新时间
async function updateModelDb(store) {
  const res = await http.fetch(MODELS_DEV_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const raw = await res.json();
  const db = modelCaps.transformModelDb(raw);
  if (!db.count || db.count < 1000) throw new Error(`转换后仅 ${db.count} 条,疑似异常载荷,丢弃不写`);
  // 原子写:先 .tmp 再 rename(教训 #19,大 JSON 写一半被断电/强杀会留截断文件)
  const out = path.join(store.baseDir(), 'model-db.json');
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, out);
  store.updateConfig({ modelDbUpdatedAt: db.updatedAt });
  return db;
}

// 启动自动更新:默认开(config.dev.autoModelDb !== false);用户库距上次更新 ≥7 天,
// 或用户库比内置快照还旧(新版本发行自带更座行) → 视为过期,后台静默拉取;
// 任何失败只记 debuglog,绝不阻塞/打断启动
async function maybeAutoUpdate(store, debuglog) {
  try {
    const cfg = store.config || {};
    if (cfg.dev && cfg.dev.autoModelDb === false) return false;
    const last = Date.parse(cfg.modelDbUpdatedAt || '') || 0;
    const stale = Date.now() - last >= AUTO_INTERVAL_MS;
    let bundledOlder = false;
    try {
      const user = JSON.parse(fs.readFileSync(path.join(store.baseDir(), 'model-db.json'), 'utf8'));
      const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'model-db.json'), 'utf8'));
      bundledOlder = Date.parse(bundled.updatedAt || 0) > Date.parse(user.updatedAt || 0);
    } catch (_) { bundledOlder = true; } // 用户库缺失/损坏 → 视为需要更新
    if (!stale && !bundledOlder) return false;
    const db = await updateModelDb(store);
    if (debuglog) debuglog.info(store, 'modeldb', 'auto-update', { count: db.count, updatedAt: db.updatedAt, reason: bundledOlder ? 'bundled-newer' : 'stale' });
    return true;
  } catch (e) {
    if (debuglog) debuglog.warn(store, 'modeldb', 'auto-update-fail', { message: String((e && e.message) || e).slice(0, 200) });
    return false;
  }
}

module.exports = { updateModelDb, maybeAutoUpdate, AUTO_INTERVAL_MS, MODELS_DEV_URL };
