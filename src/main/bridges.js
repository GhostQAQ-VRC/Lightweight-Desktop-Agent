// 连接桥凭据安全(v0.54.5):① 密码经 Electron safeStorage(Windows = DPAPI,机器绑定)加密后落盘,
// 明文永不出现在 config.json;② SSH 密码登录 = SSH_ASKPASS 机制(主进程生成一次性 askpass 脚本喂入,
// 解决 Windows OpenSSH 无 sshpass/无 TTY 的密码交互);③ 退出时清理 askpass 残留脚本。
// host/user/keyPath 的混淆(obf1:)在渲染端做(app.js),本模块只见明文(经 IPC,本机可信)。
const fs = require('fs');
const os = require('os');
const path = require('path');

function safeStorageApi() {
  try {
    const e = require('electron');
    return e && typeof e === 'object' && e.safeStorage ? e.safeStorage : null;
  } catch (_) { return null; }
}

// 保存条目:密码 → DPAPI 密文(pwd:v1:<base64>);无密码原样。返回处理后的 entry(密码字段已移除)
function secureEntry(entry, password) {
  const out = { ...entry };
  delete out.password;
  delete out.passwordEnc;
  const pwd = String(password || '');
  if (pwd) {
    const ss = safeStorageApi();
    if (!ss || !ss.isEncryptionAvailable()) {
      throw new Error('此环境不支持系统级加密存储(safeStorage 不可用),密码无法安全保存;可改用密钥登录');
    }
    out.passwordEnc = 'pwd:v1:' + ss.encryptString(pwd).toString('base64');
  }
  return out;
}

function decryptEntryPwd(passwordEnc) {
  if (!passwordEnc || !String(passwordEnc).startsWith('pwd:v1:')) return '';
  const ss = safeStorageApi();
  if (!ss) return '';
  try {
    return ss.decryptString(Buffer.from(String(passwordEnc).slice(7), 'base64'));
  } catch (_) { return ''; }
}

// 一次性 askpass 脚本(%TEMP%\liteagent-askpass-<rand>.cmd):ssh 以 SSH_ASKPASS_REQUIRE=force 调它取密码
function writeAskpass(password) {
  const f = path.join(os.tmpdir(), `liteagent-askpass-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.cmd`);
  // .cmd 批处理转义:% → %%(否则 %x% 被当变量展开/吞字符);其余 cmd 元字符用 ^ 前缀
  const safe = String(password).replace(/%/g, '%%').replace(/["^&|<>]/g, (c) => '^' + c);
  fs.writeFileSync(f, `@echo ${safe}\r\n`, 'utf8');
  return f;
}

// 清理全部 askpass 残留(退出时)
function cleanupAskpass() {
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (/^liteagent-askpass-.*\.cmd$/i.test(f)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {} }
    }
  } catch (_) { /* ignore */ }
}

// 组装连接命令(给内置终端执行)。
// p = { host, port, user, keyPath, passwordEnc } —— host/user/keyPath 为明文(渲染端已解混淆)
// shellKind: 'powershell' | 'cmd'(内置终端 shell 类型,环境变量语法不同)
function buildConnectCommand(p, shellKind) {
  const host = String(p.host || '').trim();
  if (!host) throw new Error('缺少主机地址');
  const user = String(p.user || '').trim();
  const port = p.port && String(p.port) !== '22' ? ` -p ${parseInt(p.port, 10)}` : '';
  const keyPath = String(p.keyPath || '').trim();
  const target = user ? `${user}@${host}` : host;
  const pwd = decryptEntryPwd(p.passwordEnc);
  if (pwd) {
    // 密码登录:SSH_ASKPASS 机制(OpenSSH 8.4+,Windows 版 9.x 支持 SSH_ASKPASS_REQUIRE=force)
    const askpass = writeAskpass(pwd);
    if (shellKind === 'cmd') {
      return `set "SSH_ASKPASS=${askpass}" && set "SSH_ASKPASS_REQUIRE=force" && set "DISPLAY=1" && ssh${port} -o StrictHostKeyChecking=accept-new ${target}`;
    }
    return `$env:SSH_ASKPASS="${askpass}"; $env:SSH_ASKPASS_REQUIRE="force"; $env:DISPLAY="1"; ssh${port} -o StrictHostKeyChecking=accept-new ${target}`;
  }
  const key = keyPath ? ` -i "${keyPath}"` : '';
  return `ssh${key}${port} -o StrictHostKeyChecking=accept-new ${target}`;
}

module.exports = { secureEntry, decryptEntryPwd, buildConnectCommand, cleanupAskpass, writeAskpass };
