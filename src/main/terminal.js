// 内置终端:持久 shell 会话(免 node-pty 原生依赖)。
// 原理:常驻一个真实 shell 进程(pipes 直连),命令写入 stdin、输出流式回传渲染端。
// 因为是同一进程,cd / 环境变量在命令间保持;限制:无 TTY 伪终端 ——
// 不支持交互式全屏程序(vim/htop)与密码输入,适合跑命令、看输出。
// 本模块不依赖 electron(sender 由 ipc 注入),可在 RUN_AS_NODE 测试下加载。
const { spawn } = require('child_process');

let proc = null;
let sender = () => {};
let opts = {};

// Windows 下命令输出可能是 GBK:优先 UTF-8,出现替换符时回退 GBK
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

function defaultShell() {
  if (process.platform === 'win32') {
    return opts.shell === 'cmd' ? { cmd: 'cmd.exe', args: ['/q'] } : { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
  }
  return { cmd: process.env.SHELL || 'bash', args: [] };
}

function init(o) {
  sender = o && typeof o.send === 'function' ? o.send : sender;
  opts = o || {};
}

function ensure() {
  if (proc && proc.exitCode === null && !proc.killed) return proc;
  const sh = defaultShell();
  const self = spawn(sh.cmd, sh.args, { windowsHide: true, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } });
  proc = self;
  const onData = (d) => sender({ type: 'data', text: decodeBuffer(d) });
  self.stdout.on('data', onData);
  self.stderr.on('data', onData);
  self.on('close', (code) => {
    // 只有当前会话退出才清引用:reset 后旧 shell 的 close 会晚到,不能误杀新会话
    if (proc === self) proc = null;
    sender({ type: 'exit', code });
  });
  sender({ type: 'started', shell: sh.cmd });
  return self;
}

// 执行一行命令(自动补换行;发送前确保 shell 存活)
function write(line) {
  ensure();
  if (proc && proc.stdin.writable) {
    proc.stdin.write(String(line).replace(/\r?\n$/, '') + '\n');
    return true;
  }
  return false;
}

// 重置:杀掉当前 shell 并重开(会话状态清空)
function reset() {
  try { if (proc && proc.exitCode === null) proc.kill(); } catch (_) { /* ignore */ }
  proc = null;
  ensure();
}

// 终止会话:应用退出时调用 —— 否则 shell 成为孤儿进程常驻后台(每开一次应用堆一个)
function dispose() {
  try { if (proc && proc.exitCode === null) proc.kill(); } catch (_) { /* ignore */ }
  proc = null;
}

function isActive() {
  return !!(proc && proc.exitCode === null && !proc.killed);
}

module.exports = { init, ensure, write, reset, dispose, isActive };
