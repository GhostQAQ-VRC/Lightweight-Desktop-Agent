// 系统托盘(v0.40 常规设置「关闭窗口时隐藏到托盘」):closeToTray 开启时,点 ✕ 隐藏窗口并
// 建托盘图标;关闭该设置或退出时销毁。图标 = 内嵌 16x16 PNG(圆角方块 + 白色 L),免去资源文件。
const { Tray, Menu, nativeImage, BrowserWindow, app } = require('electron');

const TRAY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADMElEQVRYhcWXT0wUVxzHPzPzlrWhu+wWqJAGkARsCCaK7XqR9t6GNlaRKyo1sSNN1CZ2a3slJV44sTEpCRKUwyZN6rIlrUahIRUjf4K6hmp7cDEEjUi0g11lhh0PdMmyO0Vdp8P3NO/3fu/3/cx7mffmSaSpPTxWHvp2/+En2qOPlwz9XcCFPdIV4bqV7/ENqG3dncGm96dTHVLqoea9Dz6fjf8ZstH0P2FKK6rVqfHhLgAlzfyHVPt/lrLweP7Typq6mbnZ6QmpPTxW3q42/OXAm2dKD4aiVcrtyZETz57+86HD5gDK9csXdEXkuTvMZPLtdQDAMPQCyVdUspg5/XLxRtwNTUj5b9piZD5Z4Fk0TPLB/cwuXc40l4TA09GDXLbJFnMAuWwTno4eJCEyu1xZERGoB32RxfORZcQrv9kCUdAdQQTq0UeGVvtlJkqKjGSaLE1dX6Yv8NsCIJkmkiJnxbMAAMjLQy6vtMU4vaaVLAHMRALjxoSt/mYiYRnPnhOH9UKAHYEAf8RitKrq+gBcHR3lyLGvaNy9h+hP59heV+csAMAv53/lk8928fvICH29vQSPf+0sAICmaUT6IwwODdG4exfbtm11FqBVVfkxHEZRZJoPtDA5ec0WAOt9IE1+n49ToRBbamtp+76d3rNnAHC73dTv3Gk55uKlS/YBeL0F9Ed/Zl9LC4m0b3nvnka+O/GN5ZgvWr9kcGgwNwBzKQlph0Z8Ok68L5418EzfWc71RyyLappm4SSWa2dI8hWVmKsCQuA9HcW4fRNzfm5NernkHQCS92bWzJPeKkJsruXvfQ2YhrG6RmayaRhoR5tJ3r2zZlEA2V+I7C98YV7y7h20o81Z5ljNwKvojebDACR6OnMt8WoAUmExGxqaVtpiawAA49roSuxpNIz58MFLAwhAz/WPON04R+lSYUnZjSVD3/K6lXKRIlwxOd/jG1gPc4B8j29AVtu6O/9dBqelq23dnRKrr2aOqbSi+uDU+HCXAjA3Oz1RWVM3s/B4/iMH7od6aUX1odTldGUjmhof7gqGolVef/FJRbhiNi+LrghXzOsvPhkMRatS5gDPAXFLFfEaHDzoAAAAAElFTkSuQmCC'; // v0.54.0 应用图标(青色远程屏幕)32px,几何圆角抠图版 // v0.54.0 应用图标(青色远程屏幕)32px

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
