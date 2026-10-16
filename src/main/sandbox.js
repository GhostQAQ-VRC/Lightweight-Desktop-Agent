// 沙箱安全系统:文件目录锁定 + 危险命令分级拦截。
// 这是同类智能体软件的通用安全机制:智能体的文件与命令操作被限制在沙箱内,
// 防止越权读写系统目录、执行破坏性命令。策略按模式强制:
//   受限/完全模式(非创造)→ 文件沙箱强制开启,命令拦截至少为宽松 —— 一切操作都在沙箱内;
//   创造模式 → 按用户设置执行(自我扩展的 manage_* 工具不经过文件工具,不受影响)。
// 本模块保持纯函数为主(不触 electron),可被测试直接加载。
const path = require('path');

// 无论设置如何都禁止文件工具触达的系统区域(防止把工作目录设到系统区后的误操作)
const SYSTEM_DIR_BLOCKLIST = [
  { re: /^[A-Za-z]:[\\/]Windows([\\/]|$)/i, name: 'Windows 系统目录' },
  { re: /^[A-Za-z]:[\\/]Program Files(\s*\(x86\))?([\\/]|$)/i, name: 'Program Files' },
  { re: /^[A-Za-z]:[\\/]ProgramData([\\/]|$)/i, name: 'ProgramData' },
  { re: /^[A-Za-z]:[\\/]\$Recycle\.Bin([\\/]|$)/i, name: '回收站' },
  { re: /System Volume Information([\\/]|$)/i, name: '系统卷信息' },
];

// 危险命令分级(Windows cmd / PowerShell / POSIX 都覆盖):
// 黑名单法理论上不可穷尽,这里锚定「AI 被提示注入诱导时的高频滥用面」:
// 编码执行 / LOLBins 下载执行 / 递归强删缩写变形 / 链接创建穿透文件沙箱 / 注册表持久化。
const CMD_RULES = {
  // 毁灭性/系统级 —— 宽松档也拦
  loose: [
    { name: '格式化磁盘', re: /\bformat(\.com)?\s+[a-z]:/i },
    { name: '磁盘分区工具', re: /\bdiskpart\b/i },
    { name: '关机/重启', re: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i },
    { name: '底层写盘', re: /\bdd\b\s+if=/i, posix: true },
    { name: 'mkfs 建文件系统', re: /\bmkfs(\.\w+)?\b/i, posix: true },
    { name: '引导配置修改', re: /\bbcdedit\b/i },
    { name: '卷影删除', re: /\bvssadmin\b.*delete/i },
    { name: '安全策略擦除', re: /\bcipher\b.*\/w/i },
    { name: '删除系统目录', re: /(\bdel\b|\b_rd_\b|\brmdir\b|\brm\b|Remove-Item|\brd\b)[^\n]{0,120}(C:\\Windows|C:\\Program Files|[A-Za-z]:\\(Users|Windows)|\/etc\b|\/usr\b|\/bin\b|\/sys\b)/i },
    { name: '注册表 HKLM 删除', re: /\breg(\.exe)?\s+delete\s+HKLM/i },
  ],
  // 严格档追加:提权/持久化/递归强删/下载执行/凭据操作/链接创建/编码执行
  strict: [
    // 递归即拦(rm/rd/del/Remove-Item 全形态:缩写 -r、分写 -r -f、反序 /q /s、前缀缩写 -re*)
    { name: '递归强删', re: /(\brm\b[^\n]{0,60}(-r\b|-rf\b|-fr\b|-re\w|--recursive\b))|(\bdel\b[^\n]{0,40}\/s\b)|(\brd\b|\brmdir\b)[^\n]{0,40}\/s\b|(\bRemove-Item\b[^\n]{0,80}-(r\b|re\w|fo\w))/i },
    { name: '提权执行', re: /(-Verb\s+RunAs)|(\bsudo\b)|(\bRunAs\b)|(\bStart-Process\b[^\n]{0,80}-Verb)/i },
    { name: '计划任务/服务持久化', re: /\b(schtasks|sc(\.exe)?\s+(create|delete|config)|New-Service|Register-ScheduledTask)\b/i },
    { name: '用户/用户组操作(含 net1 旁路)', re: /\bnet(1)?(\.exe)?\s+(user|localgroup)\b/i },
    { name: '注册表写入/删除(cmd)', re: /\breg(\.exe)?\s+(add|delete|import)\b/i },
    { name: '注册表写入(PowerShell)', re: /\b(New|Set|Remove)-ItemProperty\b[^\n]{0,80}HK(CU|LM|CR|U|CC|PD)?\b\s*[:\\]/i },
    { name: '执行策略放宽', re: /\bSet-ExecutionPolicy\b|(-ep\s+bypass|-ExecutionPolicy\s+Bypass)/i },
    { name: '下载并执行(管道形态)', re: /((curl|wget|Invoke-WebRequest|IWR|iwr)[^\n]{0,120}\|\s*(sh|bash|zsh|powershell|pwsh|cmd))|(\bInvoke-Expression\b|\biex\b)/i },
    { name: '下载并执行(LOLBins)', re: /\bNew-Object\b[^\n]{0,40}WebClient|DownloadString|DownloadFile|DownloadData|\bcertutil\b[^\n]{0,60}(-urlcache|-decode)|\bbitsadmin\b|\bmshta\b[^\n]{0,80}https?:\/\/|\bmsiexec\b[^\n]{0,60}https?:\/\/|\bregsvr32\b[^\n]{0,60}(https?:\/\/|scrobj)/i },
    { name: 'PowerShell 编码执行(-enc 族/-EncodedCommand)', re: /-enc\b|-encodedcommand/i },
    { name: '目录链接创建(junction/symlink 穿透文件沙箱)', re: /\bmklink\b|\bNew-Item\b[^\n]{0,80}-ItemType\s+(SymbolicLink|Junction|HardLink)|\bln\b[^\n]{0,20}(-s\b|--symbolic\b)/i },
    { name: 'wmic 远程进程创建', re: /\bwmic\b[^\n]{0,40}process\s+call\s+create/i },
    { name: 'forfiles 代理执行', re: /\bforfiles\b[^\n]{0,80}\/c\b/i },
    { name: '文件权限篡改', re: /\b(icacls|takeown|cacls)\b/i },
    { name: '强制结束进程树', re: /\btaskkill\b[^\n]{0,40}\/f/i },
    { name: '防火墙/网络配置', re: /\b(netsh\b[^\n]{0,40}(advfirewall|interface))/i },
    { name: '凭据转储', re: /\b(mimikatz|secretsdump)\b/i },
    { name: '环境变量级联删除', re: /\b(reg\.exe)?\s*delete\s+.*\/v/i },
  ],
};

function policyFor(mode, config) {
  const s = (config && config.sandbox) || {};
  const userFsLock = s.fsLock !== false;
  const userCmd = ['strict', 'loose', 'off'].includes(s.cmdScreen) ? s.cmdScreen : 'strict';
  if (mode === 'create') {
    // 创造模式:按用户设置(manage_* 自我扩展不经过文件工具,不受沙箱影响)
    return { fsLock: userFsLock, cmdScreen: userCmd, forced: false };
  }
  // 受限/完全模式:强制沙箱 —— 文件锁定必开,命令拦截最低宽松
  return { fsLock: true, cmdScreen: userCmd === 'off' ? 'loose' : userCmd, forced: true };
}

// 路径是否被允许触达:工作目录锁定 + 系统区黑名单;返回 { ok, path, reason }
function checkFsPath(absPath, workspace, fsLock) {
  const target = path.resolve(String(absPath || ''));
  for (const b of SYSTEM_DIR_BLOCKLIST) {
    if (b.re.test(target)) return { ok: false, path: target, reason: `沙箱禁止访问系统区域「${b.name}」: ${target}` };
  }
  if (fsLock) {
    const w = path.resolve(workspace);
    const rel = path.relative(w, target);
    if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
      return { ok: false, path: target, reason: `已按沙箱设置拦截:路径越出工作目录(工作目录: ${w})。如需读写其他位置,请更换工作目录或在创造模式调整沙箱设置。` };
    }
  }
  return { ok: true, path: target };
}

// 命令拦截:level = strict(严格)/ loose(宽松)/ off;返回 { ok, reason }
function screenCommand(command, level) {
  if (level === 'off') return { ok: true };
  const rules = level === 'loose' ? CMD_RULES.loose : [...CMD_RULES.loose, ...CMD_RULES.strict];
  const cmd = String(command || '');
  for (const r of rules) {
    if (r.re.test(cmd)) {
      return { ok: false, reason: `已按沙箱设置拦截危险命令:命中「${r.name}」。如确认需要执行,请调整沙箱设置或人工在终端执行。` };
    }
  }
  return { ok: true };
}

module.exports = { SYSTEM_DIR_BLOCKLIST, CMD_RULES, policyFor, checkFsPath, screenCommand };
