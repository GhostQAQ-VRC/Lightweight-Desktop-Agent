// 保持电脑运行(v0.40 常规设置):powerSaveBlocker 阻止系统休眠与息屏。
// 独立模块:main.js 启动时与 ipc.js config:set(general)时都调用 apply。
const { powerSaveBlocker } = require('electron');

let blockerId = null;

// keepAwake = config.general.keepAwake
function apply(config) {
  const on = !!(config && config.general && config.general.keepAwake);
  if (on && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!on && blockerId !== null) {
    try { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId); } catch (_) { /* ignore */ }
    blockerId = null;
  }
  return !!on;
}

module.exports = { apply };
