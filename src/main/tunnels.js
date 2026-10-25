// 隧道进程管理(v0.54.0):出门在外访问远程控制页的两条路 ——
// ① FRP:用户自有 frps 服务器,本应用生成标准 frpc.toml 并托管 frpc 进程;
// ② EasyTier 虚拟组网:托管 easytier-core(官方公共服务器打洞),本机获得虚拟 IP 后远程地址自动切换。
// 二进制不内置(体积/版权):优先用户指定路径,其次数据目录 tunnels/ 下,提供 GitHub release 下载辅助
// (走网络代理;GitHub 不通时引导手动下载放置)。
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const procs = { frp: null, easytier: null }; // { child, log: [] }
const LOG_MAX = 60;
let etVirtualIP = '';

function baseDirs(store) {
  const root = path.join(store.baseDir(), 'tunnels');
  return { root, frpDir: path.join(root, 'frp'), etDir: path.join(root, 'easytier') };
}

function defaultExe(store, which) {
  const d = baseDirs(store);
  return which === 'frp' ? path.join(d.frpDir, 'frpc.exe') : path.join(d.etDir, 'easytier-core.exe');
}

function resolveExe(store, which, conf) {
  const t = conf || {};
  const custom = which === 'frp' ? (t.frp && t.frp.path) : (t.et && t.et.path);
  const candidates = [];
  if (custom) candidates.push(custom);
  candidates.push(defaultExe(store, which));
  if (which === 'frp') candidates.push(path.join(baseDirs(store).root, 'frpc.exe'));
  else candidates.push(path.join(baseDirs(store).root, 'easytier-core.exe'));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return '';
}

// frpc 标准配置(v0.52+ TOML 格式,参考 frp 官方 full-example)
function buildFrpcConfig(tunnel, localPort) {
  const f = tunnel.frp || {};
  return [
    `serverAddr = "${String(f.serverAddr || '').replace(/"/g, '')}"`,
    `serverPort = ${parseInt(f.serverPort, 10) || 7000}`,
    f.authToken ? `auth.token = "${String(f.authToken).replace(/"/g, '')}"` : '',
    '',
    '[[proxies]]',
    'name = "liteagent-remote"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${parseInt(localPort, 10) || 8629}`,
    `remotePort = ${parseInt(f.remotePort, 10) || 18629}`,
  ].filter((l) => l !== '').join('\n') + '\n';
}

function log(which, line) {
  const p = procs[which];
  if (!p) return;
  p.log.push(String(line).slice(0, 300));
  if (p.log.length > LOG_MAX) p.log.shift();
}

function killProc(which) {
  const p = procs[which];
  if (!p) return;
  procs[which] = null;
  try {
    if (process.platform === 'win32' && p.child.pid) {
      spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true });
    } else p.child.kill('SIGKILL');
  } catch (_) { try { p.child.kill(); } catch (_) {} }
}

// 应用隧道配置:期望状态 = remote.enabled && tunnel.mode 对应分支 && 可执行文件就绪
async function apply(cfg, deps) {
  const remote = cfg.remote || {};
  const tunnel = remote.tunnel || {};
  const want = tunnel.mode || 'off';
  // FRP
  const frpWant = remote.enabled && want === 'frp' && !!resolveExe(deps.store, 'frp', tunnel);
  if (frpWant && (!procs.frp || procs.frp.sig !== frpSig(deps.store, tunnel, remote.port))) {
    killProc('frp');
    await startFrp(deps.store, tunnel, remote.port);
  } else if (!frpWant && procs.frp) {
    killProc('frp');
  }
  // EasyTier
  const etWant = remote.enabled && want === 'easytier' && !!resolveExe(deps.store, 'easytier', tunnel);
  if (etWant && (!procs.easytier || procs.easytier.sig !== etSig(deps.store, tunnel))) {
    killProc('easytier');
    startEasyTier(deps.store, tunnel);
  } else if (!etWant && procs.easytier) {
    killProc('easytier');
    etVirtualIP = '';
  }
}

function frpSig(store, tunnel, port) {
  const f = tunnel.frp || {};
  return [f.serverAddr, f.serverPort, f.authToken, f.remotePort, port, resolveExe(store, 'frp', tunnel)].join('|');
}
function etSig(store, tunnel) {
  const e = tunnel.et || {};
  return [e.name, e.secret, e.server, resolveExe(store, 'easytier', tunnel)].join('|');
}

async function startFrp(store, tunnel, localPort) {
  const exe = resolveExe(store, 'frp', tunnel);
  if (!exe) throw new Error('未找到 frpc.exe');
  const cfgText = buildFrpcConfig(tunnel, localPort);
  const dir = baseDirs(store);
  await fsp.mkdir(dir.frpDir, { recursive: true });
  const cfgPath = path.join(dir.frpDir, 'frpc.toml');
  await fsp.writeFile(cfgPath, cfgText, 'utf8');
  const child = spawn(`"${exe}" -c "${cfgPath}"`, { shell: true, cwd: dir.frpDir, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  procs.frp = { child, log: [], sig: frpSig(store, tunnel, localPort) };
  log('frp', `[启动] ${exe} -c ${cfgPath}`);
  child.stdout.on('data', (d) => log('frp', d.toString().trim()));
  child.stderr.on('data', (d) => log('frp', d.toString().trim()));
  child.on('exit', (code) => { log('frp', `[退出] code=${code}`); if (procs.frp && procs.frp.child === child) procs.frp.child.__exited = true; });
}

function startEasyTier(store, tunnel) {
  const exe = resolveExe(store, 'easytier', tunnel);
  if (!exe) throw new Error('未找到 easytier-core.exe');
  const e = tunnel.et || {};
  const args = [
    '--network-name', String(e.name || 'liteagent').replace(/"/g, ''),
    '--network-secret', String(e.secret || '').replace(/"/g, ''),
    '--dhcp',
    String(e.server || 'tcp://public.easytier.top:11010'),
  ];
  const dir = baseDirs(store);
  fs.mkdirSync(dir.etDir, { recursive: true });
  const child = spawn(`"${exe}" ${args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')}`, { shell: true, cwd: dir.etDir, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  procs.easytier = { child, log: [], sig: etSig(store, tunnel) };
  log('easytier', `[启动] ${exe} ${args.join(' ')}`);
  child.stdout.on('data', (d) => {
    const text = d.toString();
    log('easytier', text.trim());
    // 虚拟 IP 探测:EasyTier 输出含 10.126.x.x 形态
    const m = text.match(/10\.126\.\d+\.\d+/);
    if (m) etVirtualIP = m[0];
  });
  child.stderr.on('data', (d) => log('easytier', d.toString().trim()));
  child.on('exit', (code) => { log('easytier', `[退出] code=${code}`); });
}

// 状态:运行标志/最近日志/虚拟 IP(优先输出流探测,兜底扫 10.126.* 网卡)
function status() {
  const niScan = () => {
    const ni = require('os').networkInterfaces();
    for (const list of Object.values(ni)) {
      for (const x of list || []) {
        if (x.family === 'IPv4' && !x.internal && /^10\.126\./.test(x.address)) return x.address;
      }
    }
    return '';
  };
  return {
    frp: {
      running: !!procs.frp && !procs.frp.child.__exited,
      log: procs.frp ? procs.frp.log.slice(-8) : [],
    },
    easytier: {
      running: !!procs.easytier && !procs.easytier.child.__exited,
      log: procs.easytier ? procs.easytier.log.slice(-8) : [],
      virtualIP: etVirtualIP || niScan(),
    },
  };
}

function stopAll() {
  killProc('frp');
  killProc('easytier');
}
process.on('exit', () => { try { stopAll(); } catch (_) {} });

/* ---- 下载辅助:GitHub latest release → 走代理 fetch → PowerShell 解压 → 校验 exe ---- */
async function download(which, store) {
  const httpMod = require('./http');
  const security = require('./security');
  const repo = which === 'frp' ? 'fatedier/frp' : 'EasyTier/EasyTier';
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  security.auditAppend(store, { kind: 'download', url: api.slice(0, 200) });
  const res = await httpMod.fetch(api, { headers: { 'user-agent': 'LiteAgent', accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub API 请求失败: HTTP ${res.status}(可配置代理后重试,或手动下载后放到 tunnels 目录)`);
  const meta = await res.json();
  const assets = (meta.assets || []).map((a) => a.browser_download_url);
  const wantZip = which === 'frp' ? /windows_amd64\.zip$/i : /windows.*x86_64.*\.zip$/i;
  const asset = assets.find((u) => wantZip.test(u));
  if (!asset) throw new Error('未找到 Windows x64 发布包: ' + assets.slice(0, 5).join(', '));
  const d = baseDirs(store);
  const dir = which === 'frp' ? d.frpDir : d.etDir;
  await fsp.mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, path.basename(asset).split('?')[0]);
  security.auditAppend(store, { kind: 'download', url: asset.slice(0, 200) });
  const fileRes = await httpMod.fetch(asset, { headers: { 'user-agent': 'LiteAgent' } });
  if (!fileRes.ok) throw new Error(`下载失败: HTTP ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.length > 80 * 1024 * 1024) throw new Error('发布包超过 80MB,已中止');
  await fsp.writeFile(zipPath, buf);
  // PowerShell 解压(零依赖)
  const { execFile } = require('child_process');
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${dir}" -Force`], { windowsHide: true }, (e) => e ? reject(new Error('解压失败: ' + e.message)) : resolve());
  });
  // 递归找 exe 归位到目录根
  const exeName = which === 'frp' ? 'frpc.exe' : 'easytier-core.exe';
  const found = await findFile(dir, exeName);
  if (!found) throw new Error(`压缩包内未找到 ${exeName}`);
  if (path.resolve(found) !== path.resolve(path.join(dir, exeName))) {
    await fsp.rename(found, path.join(dir, exeName)).catch(async () => { await fsp.copyFile(found, path.join(dir, exeName)); });
  }
  return path.join(dir, exeName);
}

async function findFile(dir, name) {
  let found = '';
  const walk = async (d, depth) => {
    if (found || depth > 4) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.toLowerCase() === name) { found = p; return; }
    }
  };
  await walk(dir, 0);
  return found;
}

module.exports = { apply, status, download, stopAll, buildFrpcConfig, resolveExe, defaultExe, baseDirs };
