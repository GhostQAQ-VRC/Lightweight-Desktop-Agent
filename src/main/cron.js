// 自动任务引擎(v0.54.13):零依赖 cron(5 字段)+ 持久化任务表(config.cronTasks)+ 30s 调度循环。
// 到点任务经 chatSendCore 自动发起对话(专属 auto-<taskId> 会话,历史可查);重启恢复,错过的周期顺延跳过。
const DAY7 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// —— cron 表达式(分 时 日 月 周;支持 * , - / 与数字;周 0/7=周日)——
function parseField(f, [lo, hi]) {
  const out = new Set();
  for (const part of String(f).split(',')) {
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let a = lo, b = hi;
    if (m[1] !== '*') {
      const seg = m[1].split('-').map((x) => parseInt(x, 10));
      if (seg.length === 2) { a = seg[0]; b = seg[1]; } else { a = b = seg[0]; }
    }
    const step = parseInt(m[2] || '1', 10);
    if (!step || step < 1) return null;
    for (let v = a; v <= b; v += step) {
      if (v < lo || v > hi) return null;
      out.add(v);
    }
  }
  return out.size ? out : null;
}

function compile(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = [];
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    let s = parseField(parts[i], ranges[i]);
    if (!s) return null;
    if (i === 4 && s.has(7)) { s.add(0); s.delete(7); } // 周日 7 → 0
    sets.push(s);
  }
  return {
    matches(d) {
      return sets[0].has(d.getMinutes()) && sets[1].has(d.getHours())
        && sets[2].has(d.getDate()) && sets[3].has(d.getMonth() + 1) && sets[4].has(d.getDay());
    },
  };
}

// 下次运行时刻(逐分钟扫描;DOM/DOW 之一为 * 时按标准 cron 取 OR,都限定也取 OR)
function nextRun(expr, from = new Date()) {
  const c = compile(expr);
  if (!c) return null;
  const parts = String(expr).split(/\s+/);
  const domSet = parseField(parts[2], [1, 31]);
  const dowSet = parseField(parts[4], [0, 6]);
  if (dowSet.has(7)) { dowSet.add(0); dowSet.delete(7); } // 与 compile 同步:周日 7 → 0
  const domAny = domSet.size === 31;
  const dowAny = dowSet.size === 7;
  const t = new Date(from.getTime() + 60000 - (from.getTime() % 60000)); // 对齐到下一分钟
  for (let i = 0; i < 527040; i++) { // 扫描上限一年
    if (c.matches(t)) {
      const dom = domSet.has(t.getDate());
      const dow = dowSet.has(t.getDay());
      if ((domAny && dowAny) || (domAny ? dow : dowAny ? dom : dom || dow)) return new Date(t.getTime());
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

// 中文描述(常用形态;识别不了给原文)
function describe(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return String(expr);
  const [m, h, dom, mon, dow] = parts;
  if (mon !== '*') return String(expr);
  const hm = (hh, mm) => `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const everyMin = /^\/(\d+)$/.exec(m) || /^\*\/(\d+)$/.exec(m);
  if (everyMin && h === '*' && dom === '*' && dow === '*') return `每 ${everyMin[1]} 分钟`;
  if (h !== '*' && m !== '*' && dom === '*' && dow === '*') return `每天 ${hm(h, m)}`;
  if (h !== '*' && m !== '*' && dom === '*' && dow !== '*') return `每${DAY7[parseInt(dow, 10) % 7] || dow} ${hm(h, m)}`;
  return String(expr);
}

// —— 任务表(存 config.cronTasks;数组原样落盘) ——
function list(store) { return (store.config && store.config.cronTasks) || []; }

function upsert(store, task) {
  const clean = {
    id: String(task.id || 'at-' + Date.now().toString(36)),
    name: String(task.name || '自动任务').slice(0, 40),
    cron: String(task.cron || '').trim(),
    prompt: String(task.prompt || '').slice(0, 2000),
    mode: ['chat', 'restricted', 'full', 'create', 'team'].includes(task.mode) ? task.mode : 'chat',
    enabled: task.enabled !== false,
    convId: task.convId || null,
    lastRun: task.lastRun || null,
    lastStatus: task.lastStatus || null,
    nextAt: null,
    createdAt: task.createdAt || Date.now(),
  };
  if (!compile(clean.cron)) throw new Error(`无效的 cron 表达式: ${clean.cron}`);
  clean.nextAt = (nextRun(clean.cron) || {}).getTime() || null;
  const arr = list(store).filter((x) => x.id !== clean.id);
  arr.push(clean);
  store.updateConfig({ cronTasks: arr });
  return clean;
}

function remove(store, id) {
  store.updateConfig({ cronTasks: list(store).filter((x) => x.id !== id) });
}

// —— 调度循环 ——
let timer = null;

function tick(store, hooks) {
  const now = Date.now();
  for (const task of list(store)) {
    if (task.enabled === false || !task.nextAt || task.nextAt > now) continue;
    fire(store, hooks, task, now);
  }
}

function fire(store, hooks, task, now) {
  const convId = task.convId || ('auto-' + task.id + '-' + Date.now().toString(36));
  const streamId = 'at-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const lm = (store.config && store.config.lastModel) || {};
  const nextAt = (nextRun(task.cron, new Date(now)) || {}).getTime() || null;
  // 先落盘状态(防执行中崩溃重复触发)
  store.updateConfig({
    cronTasks: list(store).map((x) => (x.id === task.id ? { ...x, convId, lastRun: now, lastStatus: 'running', nextAt } : x)),
  });
  try {
    hooks.chatSendCore({
      streamId, convId,
      providerId: lm.providerId, model: lm.model,
      userText: `〖自动任务:${task.name}〗${task.prompt}`,
      mode: task.mode, agentMode: task.mode !== 'chat',
      groupId: 'default', reasonLevel: null,
    }, (ev) => {
      if (ev.type === 'done' || ev.type === 'error') {
        store.updateConfig({
          cronTasks: list(store).map((x) => (x.id === task.id ? { ...x, lastStatus: ev.type === 'done' ? 'done' : 'error' } : x)),
        });
        if (hooks.onDone) hooks.onDone(task, ev.type);
      }
    });
    if (hooks.onFire) hooks.onFire(task, convId);
  } catch (e) {
    store.updateConfig({
      cronTasks: list(store).map((x) => (x.id === task.id ? { ...x, lastStatus: 'error: ' + String(e.message).slice(0, 100) } : x)),
    });
  }
}

// 启动(boot 恢复:错过的周期顺延 —— nextAt 已过期的直接重算到未来,不补跑)
function start(store, hooks) {
  if (timer) return;
  const now = Date.now();
  const refreshed = list(store).map((x) => {
    if (!x.nextAt || x.nextAt < now) {
      const n = (nextRun(x.cron, new Date(now)) || {}).getTime() || null;
      return { ...x, nextAt: n, lastStatus: x.lastStatus === 'running' ? 'interrupted' : x.lastStatus };
    }
    return x;
  });
  if (refreshed.length) store.updateConfig({ cronTasks: refreshed });
  timer = setInterval(() => {
    try { tick(store, hooks); } catch (_) { /* 单任务失败不中断调度 */ }
  }, 30000);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { compile, nextRun, describe, list, upsert, remove, start, stop, fire };
