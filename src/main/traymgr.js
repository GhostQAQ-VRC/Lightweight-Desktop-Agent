// 系统托盘(v0.40 常规设置「关闭窗口时隐藏到托盘」):closeToTray 开启时,点 ✕ 隐藏窗口并
// 建托盘图标;关闭该设置或退出时销毁。图标 = 内嵌 16x16 PNG(圆角方块 + 白色 L),免去资源文件。
const { Tray, Menu, nativeImage, BrowserWindow, app } = require('electron');

const TRAY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANklEQVR42mNgQAK+2f/+E4sZyNWI1RCKDCBXM9wQbIIwMGrAYDAAHdDPAIoTEt2SMwM6IEczANLUqHdMbMEHAAAAAElFTkSuQmCC';

let tray = null;
let quitting = false;

function markQuitting() { quitting = true; }
function isQuitting() { return quitting; }

function showWindow() {
  let win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.relaunch(); app.quit(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensure() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_PNG_B64, 'base64')));
  tray.setToolTip('LiteAgent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow); // Windows: 左键单击即打开
}

function destroy(showIfHidden) {
  if (tray) { try { tray.destroy(); } catch (_) { /* ignore */ } tray = null; }
  if (showIfHidden) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isVisible()) win.show();
  }
}

// config 变更后同步:开启→建托盘;关闭→销毁(窗口若被隐藏则唤回,避免用户找不到入口)
function sync(config) {
  const on = !!(config && config.general && config.general.closeToTray);
  if (on) ensure();
  else destroy(true);
  return on;
}

module.exports = { ensure, destroy, sync, markQuitting, isQuitting, showWindow };
