// 视频工具(v0.54.4 工具链第三批):零依赖 —— 全部复用 Chromium 原生能力。
//   makeVideo:SVG 帧序列 → 隐藏窗口逐帧光栅化(canvas) → MediaRecorder 合成 .webm
//   videoInfo:<video> 元数据(时长/分辨率) —— 容器解析都不用写,解码器原生
//   extractFrames:video 逐时刻 seek → canvas 抓帧 → PNG 落盘 + base64 回灌(多模态模型可"看"视频)
// 光栅化/抓帧页面用 loadFile(file:// 同源,canvas 不被污染;data: 页面画 file:// 视频会 taint);
// 页面带 CSP(img-src blob: data:;script-src 'unsafe-inline' 仅为注入脚本,无外联面)。
// RUN_AS_NODE(测试环境)下 electron 是路径串 → 三个函数诚实报错(同 clipboard/open_external 惯例)。
const fs = require('fs');
const os = require('os');
const path = require('path');

function electron() {
  try {
    const e = require('electron');
    return e && typeof e === 'object' ? e : null;
  } catch (_) { return null; }
}

// 注入帧页面的公共外壳:返回 [win, cleanup]
async function hiddenFramePage() {
  const e = electron();
  if (!e || !e.BrowserWindow) throw new Error('视频工具仅在应用内可用');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data: file:; media-src file: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>html,body{margin:0;background:#000}canvas,video{display:block}</style></head><body></body></html>`;
  const tmp = path.join(os.tmpdir(), 'liteagent-video-page-' + Date.now().toString(36) + '.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const win = new e.BrowserWindow({
    show: false, width: 640, height: 360,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: false },
  });
  try {
    await win.loadFile(tmp);
    return { win, cleanup: () => { try { win.destroy(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} } };
  } catch (err) {
    try { win.destroy(); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 校验并归一化 SVG 帧:必须是 <svg 文档(光栅化要求完整 SVG;自动补 xmlns 提高容错)
function normalizeFrame(src, w, h) {
  let s = String(src || '').trim();
  if (!s) throw new Error('存在空帧');
  if (!/^<svg[\s>]/i.test(s)) throw new Error('每一帧必须是 <svg> 开头的完整 SVG 文档(含 xmlns 与 viewBox 更稳)');
  if (!/xmlns=/.test(s)) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/viewBox=/i.test(s)) s = s.replace(/^<svg/i, `<svg viewBox="0 0 ${w} ${h}"`);
  return s;
}

// SVG 帧序列 → webm。args: { frames, fps, width, height } → { buffer, durationMs }
async function makeVideo(args) {
  if (!electron()) throw new Error('视频工具仅在应用内可用'); // 环境检查先于参数校验(RUN_AS_NODE 测试锚定)
  const frames = Array.isArray(args && args.frames) ? args.frames : null;
  if (!frames || !frames.length) throw new Error('缺少 frames(SVG 帧数组)');
  if (frames.length > 300) throw new Error(`帧数超上限(${frames.length} > 300)`);
  const fps = Math.min(30, Math.max(1, parseInt(args.fps, 10) || 10));
  const width = Math.min(1280, Math.max(64, parseInt(args.width, 10) || 640));
  const height = Math.min(720, Math.max(64, parseInt(args.height, 10) || 360));
  const norm = frames.map((f) => normalizeFrame(f, width, height));
  const { win, cleanup } = await hiddenFramePage();
  try {
    const b64 = await win.webContents.executeJavaScript(`
      (async () => {
        const W = ${width}, H = ${height}, FPS = ${fps}, FRAMES = ${JSON.stringify(norm)};
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        const stream = canvas.captureStream(0); // 手动帧模式:requestFrame 逐帧驱动
        const track = stream.getVideoTracks()[0];
        const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
        if (!mime) throw new Error('此环境 MediaRecorder 不支持 webm');
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((res) => rec.onstop = res);
        const loadImg = (svg) => new Promise((res, rej) => {
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const img = new Image();
          img.onload = () => { res(img); };
          img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('SVG 帧解析失败(检查语法)')); };
          img.src = url;
        });
        rec.start();
        for (const svg of FRAMES) {
          const img = await loadImg(svg);
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          ctx.drawImage(img, 0, 0, W, H);
          track.requestFrame();
          await new Promise((r) => setTimeout(r, Math.max(8, Math.round(1000 / FPS))));
        }
        // 保证末帧进入时间轴后再停
        await new Promise((r) => setTimeout(r, 120));
        rec.stop();
        await stopped;
        const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      })()`, true);
    return { buffer: Buffer.from(b64, 'base64'), fps, width, height, frames: frames.length };
  } finally {
    cleanup();
  }
}

// 视频元信息:时长/分辨率(file:// video 由 Chromium 解码,无容器解析代码)
async function videoInfo(absPath) {
  if (!electron()) throw new Error('视频工具仅在应用内可用');
  const { win, cleanup } = await hiddenFramePage();
  try {
    const meta = await win.webContents.executeJavaScript(`
      (async () => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.src = ${JSON.stringify('file:///' + String(absPath).replace(/\\\\/g, '/'))};
        await new Promise((res, rej) => {
          v.onloadedmetadata = res;
          v.onerror = () => rej(new Error('无法解码该视频(格式不受支持或文件损坏)'));
          setTimeout(() => rej(new Error('读取视频元数据超时')), 15000);
        });
        let d = v.duration;
        if (!Number.isFinite(d)) {
          // MediaRecorder 生成的 webm 常缺 Duration 元数据:seek 到极大时刻,currentTime 会 clamp 到真实时长
          await new Promise((res) => {
            const on = () => { v.removeEventListener('timeupdate', on); res(); };
            v.addEventListener('timeupdate', on);
            v.currentTime = 1e9;
            setTimeout(res, 3000);
          });
          d = v.currentTime;
        }
        return { duration: d, width: v.videoWidth, height: v.videoHeight };
      })()`, true);
    return meta;
  } finally {
    cleanup();
  }
}

// 抽帧:times(秒数组,≤8)→ PNG 落盘 outPrefix-NNN.png + base64 列表(回灌给多模态模型)
async function extractFrames(absPath, times, outPrefixAbs) {
  if (!electron()) throw new Error('视频工具仅在应用内可用');
  const list = (times || []).map((t) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0).slice(0, 8);
  if (!list.length) throw new Error('缺少 times(抽帧时刻数组,单位秒)');
  const { win, cleanup } = await hiddenFramePage();
  try {
    const frames = await win.webContents.executeJavaScript(`
      (async () => {
        const v = document.createElement('video');
        v.preload = 'auto';
        v.src = ${JSON.stringify('file:///' + String(absPath).replace(/\\\\/g, '/'))};
        await new Promise((res, rej) => {
          v.onloadedmetadata = res;
          v.onerror = () => rej(new Error('无法解码该视频'));
          setTimeout(() => rej(new Error('读取视频超时')), 20000);
        });
        await new Promise((res) => { v.oncanplay = res; v.play().then(() => v.pause()).catch(() => {}); setTimeout(res, 4000); });
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth || 640; canvas.height = v.videoHeight || 360;
        const ctx = canvas.getContext('2d');
        const out = [];
        for (const t of ${JSON.stringify(list)}) {
          await new Promise((res) => {
            const done = () => { v.removeEventListener('seeked', done); res(); };
            v.addEventListener('seeked', done);
            v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || 0) - 0.05));
            setTimeout(res, 4000);
          });
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL('image/png');
          out.push(url.slice(url.indexOf(',') + 1));
        }
        return out;
      })()`, true);
    const saved = [];
    const images = [];
    for (let i = 0; i < frames.length; i++) {
      const p = `${outPrefixAbs}-${String(i + 1).padStart(3, '0')}.png`;
      fs.writeFileSync(p, Buffer.from(frames[i], 'base64'));
      saved.push(p);
      images.push({ mime: 'image/png', base64: frames[i] });
    }
    return { saved, images };
  } finally {
    cleanup();
  }
}

module.exports = { makeVideo, videoInfo, extractFrames };
