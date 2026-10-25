'use strict';

/* ================= 工具函数 ================= */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

// 界面语言(v0.40):i18n.js 提供 window.I18N;键 = 简体中文原文,未收录回退原文
const t = (zh) => (window.I18N ? window.I18N.t(zh) : zh);
const isZhLang = () => (window.I18N ? window.I18N.getLang() === 'zh-CN' : true);

// 把 HTML 骨架上的 data-i18n / data-i18n-ph / data-i18n-title 翻译为当前语言(语言切换与启动时调用)
function applyChromeLang() {
  const lang = window.I18N ? window.I18N.getLang() : 'zh-CN';
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

// 语言切换后的界面刷新:静态骨架 + 动态渲染区(不重建会话内容)
function applyLanguageEverywhere() {
  applyChromeLang();
  fillModeSelect();
  fillAssistantSelect();
  renderSidebar();
  renderModelCombo();
  renderSkillBar();
  renderUsageBar();
  updateStatusHint();
  if (panelState.open && $('#side-panel')) renderPanel();
  // 抽屉开着时整体重建(导航标签是外壳的一部分;语言切换是显式操作,重建闪烁可接受)
  if (!$('#modal-root').classList.contains('hidden')) {
    closeSettings();
    openSettings();
  }
}

const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtUsage = (u) => (u && (u.prompt_tokens != null || u.completion_tokens != null))
  ? `tokens ${u.prompt_tokens ?? '-'}↑/${u.completion_tokens ?? '-'}↓` : '';

/* ================= Markdown 渲染 ================= */
const HAS_MARKED = typeof window.marked !== 'undefined' && window.marked && window.marked.parse;
const HAS_PURIFY = typeof window.DOMPurify !== 'undefined' && window.DOMPurify;
const HAS_HLJS = typeof window.hljs !== 'undefined' && window.hljs && typeof window.hljs.highlightElement === 'function';

if (HAS_MARKED) marked.setOptions({ breaks: true, gfm: true });

// 实验性低内存模式/纯终端模式:跳过 Markdown 与代码高亮的渲染成本
function plainRender() {
  const ui = (state.config && state.config.ui) || {};
  return !!(ui.perfLowMemory || ui.pureTerminal);
}

function mdToHtml(text) {
  if (plainRender() || !HAS_MARKED) return `<div class="plain-md">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  const raw = marked.parse(text || '');
  // FORBID style/style 属性(v0.49):AI 回复可能带未包围栏的原始 HTML(如游戏页面),
  // DOMPurify 默认放行 <style> —— 其规则会污染整个应用文档(body 被涂黑等)。
  // ALLOWED_URI_REGEXP 加 Windows 盘符路径分支(v0.54.8):AI 写文件后常贴 G:\x\x.html 链接,
  // 默认协议白名单会把 href 整个剥掉 → 用户只看到死文本"只能选中文字";放行后由宿主点击
  // 监听拦截转内置浏览器打开(enhanceCodeInDoc 尾部),iframe 沙箱内本就无法导航本地文件。
  return HAS_PURIFY ? DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'link'],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|mailto|tel):|[a-z]:(?:[\\/]|%5c)|[a-z+.\-]+(?:[^a-z+.\-:]|\/)|[^a-z])/i,
  }) : raw;
}

function renderMd(el, text, streaming) {
  // 空白正文块(v0.57.5):模型偶尔只发一个空格/换行(工具轮之间常见),渲染成空 iframe 时
  // 它会保留浏览器默认高度 150px → 对话里出现上下中间一大片空白。空白内容直接隐掉整块。
  if (!String(text || '').replace(/\s+/g, '')) {
    el.classList.add('md-blank');
    el.textContent = '';
    return;
  }
  el.classList.remove('md-blank');
  if (plainRender()) { // 纯文本渲染:全转义,天然隔离
    el.innerHTML = mdToHtml(text);
    return;
  }
  // AI 生成的 HTML 渲染进同源沙箱 iframe(v0.49.1 结构隔离):
  // sandbox 无 allow-scripts → 内容里的脚本永不执行;样式与宿主文档物理隔离,
  // 消毒器漏放任何标签(style 等)也无法越出这层框。
  mdSandboxWrite(el, mdToHtml(text));
}

// 沙箱 iframe 管理:同一容器复用同一框;高度随内容同步;主题跟随
function mdSandboxWrite(el, html) {
  let frame = el.querySelector(':scope > iframe.md-frame');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'md-frame';
    frame.setAttribute('sandbox', 'allow-same-origin'); // 无 allow-scripts:AI 内容里的脚本永不执行
    el.textContent = '';
    el.appendChild(frame);
  }
  const doc = frame.contentDocument;
  if (!doc || !doc.body) {
    // 沙箱 iframe 刚插入时 contentDocument 短暂为 null → 异步重试
    if (!el.dataset.mdRetry) { el.dataset.mdRetry = '1'; setTimeout(() => { delete el.dataset.mdRetry; mdSandboxWrite(el, html); }, 0); }
    return;
  }
  if (!frame.dataset.booted) {
    // 沙箱 iframe 无 allow-scripts:document.write 被静默禁用 → 直接操作 about:blank 文档
    doc.documentElement.dataset.theme = state.config.ui.theme || 'light';
    doc.body.className = 'md';
    doc.body.style.background = 'transparent'; // 卡片化(v0.49.6):正文透出卡片半透底,不再是实色块
    // 注:html,body{height:100%} 的接管交给 style.css 的 `.md { height:auto }`(类选择器优先),
    // 不在这里写内联 style —— smoke-render-sec 会把沙箱文档里的 style 属性当注入哨兵误报。
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'style.css'; // 相对路径按宿主 base 解析到同一文件
    doc.head.appendChild(link);
    // 样式表异步加载:加载前 scrollHeight 可能量到 0/错值(竞态)→ syncFrameHeight 会把 0 写死,
    // 表现为「正文高 0 + turn 留下大片空白 + 内容被后续覆盖」。onload 后必须重测一次(ResizeObserver
    // 只看 body 尺寸变化,救不了这个窗口期);load 兜底 + 600ms 延迟再校验双保险。
    link.addEventListener('load', () => { syncFrameHeight(frame); setTimeout(() => syncFrameHeight(frame), 600); });
    bindMdFrame(frame);
    frame.dataset.booted = '1';
    if (!mdSandboxWrite.toggleBound) { // details 折叠展开时框高度重同步(toggle 不冒泡,用捕获)
      mdSandboxWrite.toggleBound = true;
      document.addEventListener('toggle', (e) => {
        if (e.target.tagName === 'DETAILS') e.target.querySelectorAll('iframe.md-frame').forEach((f) => syncFrameHeight(f));
      }, true);
    }
  }
  doc.body.innerHTML = html;
  enhanceCodeInDoc(doc);
  syncFrameHeight(frame);
  // 兜底:若量到 0(样式未就绪/文档收起),异步再校一次;若已正常则保持(不改高度避免抖动)
  if (frame.getBoundingClientRect().height < 2) setTimeout(() => { try { if (frame.isConnected) syncFrameHeight(frame); } catch (_) { /* ignore */ } }, 300);
  if (searchState.open && searchState.query.trim()) applySearch({ reset: false }); // 沙箱重写会清 mark:搜索开启时重建(含 renderConv 后的异步重试路径)
}

// 框内增强:代码块包裹/语言标签/复制 + 链接代理 + 图片灯箱代理(监听由宿主 JS 挂载,沙箱内可正常触发)
function bindMdFrame(frame) {
  const doc = frame.contentDocument;
  // 主题跟随
  document.addEventListener('lite-theme-change', () => {
    try { doc.documentElement.dataset.theme = state.config.ui.theme || 'light'; } catch (_) { /* ignore */ }
  });
  // 链接代理:交给系统浏览器(沙箱内导航被禁);图片代理:宿主灯箱
  doc.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (a) { e.preventDefault(); liteapi.invoke('app:openExternal', a.href).catch(() => {}); return; }
    const img = e.target.closest && e.target.closest('img');
    if (img && img.src) { e.preventDefault(); openImageLightbox(img.src); }
  });
  // 高度同步(内容/图片加载变化):延后到本轮观察结束后再写高度,避免触发
  // "ResizeObserver loop completed with undelivered notifications" 控制台警告
  const ro = new ResizeObserver(() => setTimeout(() => syncFrameHeight(frame), 0));
  ro.observe(doc.body);
}

// 真实内容高度:不能用 documentElement.scrollHeight —— 它受 html,body{height:100%} 影响,
// 永远等于 iframe 当前高度(高度被锁死,短消息也会留 150px 空白)。改成按 body 子元素的最低底边算。
function mdContentHeight(doc) {
  const body = doc && doc.body;
  if (!body) return 0;
  const top = body.getBoundingClientRect().top;
  let h = 0;
  for (const el of body.children) {
    const bottom = el.getBoundingClientRect().bottom - top;
    if (bottom > h) h = bottom;
  }
  if (!body.children.length) h = body.scrollHeight; // 无元素子节点(纯文本)兑底
  return Math.ceil(h);
}

function syncFrameHeight(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    const body = doc.body;
    // 空内容(只有空白/无元素):显式写 0 并隐藏,否则 iframe 保留浏览器默认 150px,
    // 在对话里就是一块上下空白(v0.57.5)
    const blank = !(body.textContent || '').replace(/\s+/g, '') && !body.children.length;
    const wrap = frame.parentElement;
    if (blank) {
      frame.style.height = '0px';
      if (wrap && wrap.classList.contains('md')) wrap.classList.add('md-blank');
      return;
    }
    if (wrap && wrap.classList.contains('md')) wrap.classList.remove('md-blank');
    const h = mdContentHeight(doc);
    const next = h + 'px';
    // 高度未变就不写:减少无谓的重排/ResizeObserver 回环(控制台会报 "ResizeObserver loop" 警告)
    if (h > 1 && frame.style.height !== next) frame.style.height = next;
  } catch (_) { /* ignore */ }
}

// enhanceCode 的框内版本:对 iframe 文档里的 pre/a 做与宿主一致的处理
function enhanceCodeInDoc(doc) {
  $$('pre', doc).forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-body')) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '代码';
    // HTML 代码块加「▶ 预览」:点击 → 内置浏览器直接渲染(同源 iframe 内由宿主绑定处理器,同复制按钮)
    const isHtml = /^(html|htm)$/i.test(lang);
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="code-lang">${escapeHtml(lang)}</span>${isHtml ? `<button class="code-preview" type="button" title="在内置浏览器中打开这个 HTML">▶ 预览</button>` : ''}<button class="code-copy" type="button">${t('复制')}</button>`;
    const body = document.createElement('div');
    body.className = 'code-body';
    pre.replaceWith(wrap);
    body.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(body);
    const pbtn = head.querySelector('.code-preview');
    if (pbtn) pbtn.addEventListener('click', () => {
      openInPanelBrowser('data:text/html;charset=utf-8,' + encodeURIComponent(code.textContent));
    });
    const btn = head.querySelector('.code-copy');
    if (btn) btn.addEventListener('click', () => {
      try { navigator.clipboard.writeText(code.textContent); btn.textContent = '✓'; setTimeout(() => { btn.textContent = t('复制'); }, 1200); } catch (_) { /* ignore */ }
    });
  });
  $$('a[href^="http"]', doc).forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // 本地 HTML 文件链接(AI 常写文件后在正文贴 G:\x\x.html 链接)→ 点击在内置浏览器打开。
  // 沙箱 iframe 内点击由宿主监听(同源 doc 绑定,处理器在宿主执行);dataset 防重复绑定(md 重写会重跑本函数)
  if (!doc.documentElement.dataset.localLinkBound) {
    doc.documentElement.dataset.localLinkBound = '1';
    doc.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      const rawHref = a.getAttribute('href') || '';
      let href = rawHref;
      try { href = decodeURIComponent(rawHref); } catch (_) { /* 保留原值 */ }
      let local = null;
      const abs = /^([A-Za-z]:[\\/][^?#]*)/.exec(href); // marked 会把 \ 编码成 %5C,先解码还原
      if (abs && /\.html?$/i.test(abs[1])) local = abs[1];
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /^[^?#]*\.html?$/i.test(href) && !href.includes('//')) {
        local = pathJoin((state.config.agent && state.config.agent.workspace) || '', href); // 相对 = 工作目录
      }
      if (local) {
        e.preventDefault();
        openInPanelBrowser(localFileUrl(local));
      }
    });
  }
}

// 代码高亮懒执行:进入视口附近才 highlight,长会话打开不再卡顿
const lazyHljs = HAS_HLJS && 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          try { hljs.highlightElement(en.target); } catch (_) { /* ignore */ }
          lazyHljs.unobserve(en.target);
        }
      });
    }, { rootMargin: '300px' })
  : null;

// 代码块:高亮 + 语言标签 + 复制按钮(HTML 加预览按钮);链接交给系统浏览器
function enhanceCode(container) {
  if (plainRender()) return; // 低内存/纯终端模式:不做高亮与包裹
  $$('pre', container).forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-body')) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '代码';
    if (HAS_HLJS && code.textContent.length <= 20000) {
      if (lazyHljs) lazyHljs.observe(code);
      else { try { hljs.highlightElement(code); } catch (_) { /* 忽略高亮失败 */ } }
    }
    const isHtml = /^(html|htm)$/i.test(lang);
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="code-lang">${escapeHtml(lang)}</span>${isHtml ? `<button class="code-preview" type="button" title="在内置浏览器中打开这个 HTML">▶ 预览</button>` : ''}<button class="code-copy" type="button">复制</button>`;
    const body = document.createElement('div');
    body.className = 'code-body';
    pre.replaceWith(wrap);
    body.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(body);
    const pbtn = head.querySelector('.code-preview');
    if (pbtn) pbtn.addEventListener('click', () => {
      openInPanelBrowser('data:text/html;charset=utf-8,' + encodeURIComponent(code.textContent));
    });
  });
  $$('a[href^="http"]', container).forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}

// 生图模型名启发式(与主进程 imagegen.HEURISTIC 同步;渲染端无 require)
const IMAGE_MODEL_RE = /(dall-?e|gpt-image|flux|sd[3x]?|stable-?diffusion|midjourney|mj-|cogview|wanx|seedream|irag|qwen-image|kolors)/i;
const imagegen = { isImageModel: (name) => IMAGE_MODEL_RE.test(String(name || '')) };

/* ================= 状态 ================= */
const state = {
  config: null,
  convs: [],
  conv: null,          // {id, groupId, messages:[...]} 当前显示会话的本地镜像
  streams: new Map(),  // convId → 该会话进行中的流(多会话并发;后台会话的事件进 buffer,切回时重放)
  stickBottom: true,
  pendingGroupId: null, // 新对话待归属的分组
  pendingAttachments: [], // 待发送附件 {id,name,mime,kind,size,dataUrl|text}
  reasonGen: 0, reasonRenderKey: null, reasonCapsCache: new Map(), reasonValue: null,
  mpProvider: null, mpProvView: false, // 模型弹层:当前展示的供应商 / 供应商清单视图开关(v0.54.2)
  collapsedGroups: new Set(),
  termOpen: false, // 内置终端面板是否展开
};

const chatEl = $('#chat');

/* ================= 滚动 ================= */
chatEl.addEventListener('scroll', () => {
  state.stickBottom = chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 90;
});
function maybeScroll(force) {
  if (force || state.stickBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

/* ================= 侧边栏 ================= */
async function refreshConvs() {
  state.convs = await liteapi.invoke('convs:list');
  renderSidebar();
}

// 会话列表分类(v0.52.0):project = 按项目(工作分组树,默认)/ flat = 按分组(平铺全部)/ recent = 最近更新(按时间段分节)
let convFilterText = ''; // 🔍 列表头过滤词(仅内存,不持久化)

// 侧栏状态耗时短格式(38s / 2m14s;与对话条 fmtDurZh 中文格式区分,勿混用)
function convFmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '');
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}
// 侧栏状态色:🔵进行中(实时计时)/🟢完成(定格耗时)/🔴异常 —— conv-streaming 蓝点保留(smoke 依赖)
function convStatusHtml(c) {
  if (state.streams.has(c.id)) {
    const S = state.streams.get(c.id);
    const el = Math.max(0, Date.now() - (S.turnT0 || Date.now()));
    return `<span class="conv-status st-run" title="${t('正在进行')}"><span class="conv-timer" data-conv="${c.id}">${convFmtDur(el)}</span></span>`;
  }
  if (c.lastStatus === 'error') return `<span class="conv-status st-err" title="${t('上次运行异常')}">✕ ${c.lastMs != null ? convFmtDur(c.lastMs) : ''}</span>`;
  if (c.lastStatus === 'done' && c.lastMs != null) return `<span class="conv-status st-ok" title="${t('已完成')}">✓ ${convFmtDur(c.lastMs)}</span>`;
  return '';
}
// 进行中会话的实时计时 ticker(单例;streams 清空自动停,不常驻)
let convTimerHandle = null;
function ensureConvTicker() {
  if (convTimerHandle || state.streams.size === 0) return;
  convTimerHandle = setInterval(() => {
    const timers = $$('.conv-timer[data-conv]');
    if (!state.streams.size || !timers.length) { clearInterval(convTimerHandle); convTimerHandle = null; return; }
    for (const el of timers) {
      const S = state.streams.get(el.dataset.conv);
      if (S) el.textContent = convFmtDur(Date.now() - (S.turnT0 || Date.now()));
    }
  }, 1000);
}

function convItemHtml(c, inGroup) {
  return `
    <div class="conv-item ${inGroup ? 'in-group ' : ''}${state.conv && state.conv.id === c.id ? 'active' : ''}" data-id="${c.id}" draggable="true" title="${t('对话 ID')}: ${escapeHtml(c.id)}${t('(可复制或拖拽到输入框,把该对话上下文交付给新对话)')}">
      <div class="conv-title">${escapeHtml(c.title)}${state.streams.has(c.id) ? `<span class="conv-streaming" title="${t('正在回复…')}"></span>` : ''}${convStatusHtml(c)}</div>
      <div class="conv-actions">
        <button data-act="copyid" title="${t('复制对话 ID')}">⧉</button>
        <button data-act="rename" title="${t('重命名')}">✎</button>
        <button data-act="delete" class="act-del" title="${t('删除')}">✕</button>
      </div>
    </div>`;
}

function recentBucketOf(c) {
  const dt = Date.now() - (c.updatedAt || 0);
  if (dt < 86400000) return 'today';
  if (dt < 7 * 86400000) return 'week';
  return 'older';
}

/* —— 对话交接(v0.52.0):UID 复制 / 拖拽 /handover,把旧对话上下文交付给新对话(修复卡死或续跑任务) —— */
// 接手消息只带轻量指针(ID + 标题 + 最近内容预览),完整上下文由智能体用 read_conversation 工具分段读取
// (用户裁定:不把全文塞进消息,避免上下文压力;对话模式无工具则按模式加大预览量兜底)
const HANDOVER_PREVIEW = 140;   // 工具模式预览单条截断
const HANDOVER_PREVIEW_CHAT = 300; // 对话模式(无工具)预览单条截断
const clipText = (s, n) => (String(s || '').length > n ? String(s || '').slice(0, n) + '…' : String(s || ''));

function handoverText(c) {
  const msgs = c.messages || [];
  const mode = (state.config.ui || {}).mode || 'chat';
  const hasTool = mode !== 'chat'; // read_conversation 在 restricted/full/create/team 注入
  const previewN = hasTool ? 2 : 8;
  const clipN = hasTool ? HANDOVER_PREVIEW : HANDOVER_PREVIEW_CHAT;
  const picked = [];
  for (let i = msgs.length - 1; i >= 0 && picked.length < previewN; i--) {
    const m = msgs[i];
    let line = null;
    if (m.role === 'user') {
      const body = typeof m.content === 'string' && m.content ? m.content : (m.attachments ? '[附件消息]' : '');
      if (body) line = '【用户】' + clipText(body, clipN);
    } else if (m.role === 'assistant') {
      const body = assistantTextOf(m);
      if (body) line = '【助手】' + clipText(body, clipN);
    }
    if (line) picked.unshift(line);
  }
  const guide = hasTool
    ? `请用 read_conversation 工具分段读取该对话的全部内容(convId="${c.id}",从 offset=0 开始、每次 limit=10,读到达标 done:true 为止),再总结该对话的目标与进展;若存在未完成或出错的任务,分析原因并继续修复。`
    : `当前为对话模式(无工具可调),请基于以上预览简短回应;需要完整上下文修复任务时,请用户切换到受限/完全模式后重新接手。`;
  return `〖接手对话 ${c.id}〗目标:接手另一个对话(该对话可能因卡死/中断无法继续)。\n`
    + `── 「${c.title || '未命名'}」共 ${msgs.length} 条消息,以下为最近内容预览 ──\n`
    + (picked.join('\n') || '(无文本预览)')
    + `\n━━━━━━\n${guide}\n额外说明见我随后的消息。`;
}

async function prefillHandover(convId) {
  if (state.conv && state.conv.id === convId) { toast(t('这就是当前对话')); return; }
  try {
    const old = await liteapi.invoke('convs:get', convId);
    if (!old) { toast(t('找不到该对话') + ': ' + convId); return; }
    const input = $('#input');
    input.value = handoverText(old);
    autosize(input);
    input.focus();
    toast(t('已生成接手消息:仅含摘要与指针,AI 将分段读取完整上下文'));
  } catch (e) {
    toast(String(e && e.message || e).slice(0, 160));
  }
}

function renderSidebar() {
  const list = $('#conv-list');
  const groups = [...(state.config.groups || [])].sort((a, b) => (a.id === 'default' ? -1 : 0) - (b.id === 'default' ? -1 : 0));
  const q = convFilterText.toLowerCase();
  const all = state.convs.filter((c) => !q || String(c.title || '').toLowerCase().includes(q));
  const view = (state.config.ui || {}).convView || 'project';
  let html = '';
  let total = 0;
  if (view === 'project') {
    for (const g of groups) {
      const convs = all.filter((c) => (c.groupId || 'default') === g.id);
      total += convs.length;
      const collapsed = state.collapsedGroups.has(g.id);
      html += `
        <div class="group-head" data-gid="${g.id}" title="${escapeHtml(g.workspace || '跟随全局工作目录')}">
          <span class="gh-arrow">${collapsed ? '▸' : '▾'}</span>
          <span class="gh-icon">${g.icon || '📁'}</span>
          <span class="gh-name">${escapeHtml(t(g.name))}</span>
          <span class="gh-count">${convs.length}</span>
          <span class="gh-actions">
            <button data-gact="new" title="${t('在此分组新建任务')}">＋</button>
            <button data-gact="rename" title="${t('重命名分组')}">✎</button>
            <button data-gact="folder" title="${t('设置工作文件夹')}">📂</button>
            ${g.id !== 'default' ? `<button data-gact="delete" class="act-del" title="${t('删除分组(会话移入默认分组)')}">✕</button>` : ''}
          </span>
        </div>`;
      if (!collapsed) html += convs.map((c) => convItemHtml(c, true)).join('');
    }
  } else if (view === 'flat') {
    // 按分组(平铺):忽略项目归属,全部会话单列(state.convs 已按 updatedAt 倒序)
    html += all.map(convItemHtml).join('');
    total = all.length;
  } else {
    // 最近更新:平铺 + 按时间段分节(今天 / 最近 7 天 / 更早)
    const buckets = { today: [], week: [], older: [] };
    for (const c of all) buckets[recentBucketOf(c)].push(c);
    const secs = [['today', '今天'], ['week', '最近 7 天'], ['older', '更早']];
    for (const [k, label] of secs) {
      if (!buckets[k].length) continue;
      total += buckets[k].length;
      html += `<div class="conv-sechead">${t(label)}</div>` + buckets[k].map(convItemHtml).join('');
    }
  }
  // 过滤无匹配时直接给空态(分组头也遮住);未过滤时保持原行为(空分组仍显示组头)
  const hasRows = total || (view === 'project' && groups.length && !q);
  list.innerHTML = hasRows ? html : `<div class="side-empty">${q ? t('无匹配会话') : t('暂无对话')}</div>`;
  ensureConvTicker(); // 有进行中会话时启动实时计时(streams 清空自动停)
  updateTermStatus(); // 会话标题变化(如自动命名)时同步终端状态栏
}

/* —— 列表头:🔍 过滤 + ☰ 分类菜单(v0.52.0) —— */
function closeConvViewMenu() {
  const p = $('#conv-view-menu');
  if (p) p.remove();
  document.removeEventListener('mousedown', convViewOutside);
}

function convViewOutside(e) {
  const p = $('#conv-view-menu');
  if (p && !p.contains(e.target) && !e.target.closest('#btn-conv-view')) closeConvViewMenu();
}

function openConvViewMenu() {
  if ($('#conv-view-menu')) { closeConvViewMenu(); return; }
  const view = (state.config.ui || {}).convView || 'project';
  const items = [['project', '按项目', '⌂'], ['flat', '按分组', '#'], ['recent', '最近更新', '🕐']];
  const pop = document.createElement('div');
  pop.id = 'conv-view-menu';
  pop.innerHTML = `
    <div class="menu-title">${t('分类方式')}</div>
    ${items.map(([v, label, ico]) => `
      <div class="menu-item" data-view="${v}">
        <span class="mi-icon">${ico}</span>
        <span class="mi-name">${t(label)}</span>
        <span class="mi-meta mi-check">${view === v ? '✓' : ''}</span>
      </div>`).join('')}`;
  document.body.appendChild(pop);
  const rect = $('#btn-conv-view').getBoundingClientRect();
  pop.style.left = Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12) + 'px';
  pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - pop.offsetHeight - 12) + 'px';
  $$('.menu-item', pop).forEach((item) => item.addEventListener('click', async () => {
    closeConvViewMenu();
    state.config = await liteapi.invoke('config:set', { ui: { convView: item.dataset.view } });
    renderSidebar();
  }));
  setTimeout(() => document.addEventListener('mousedown', convViewOutside), 0);
}

async function beginGroupRename(headEl, groupId, oldName) {
  const nameEl = $('.gh-name', headEl);
  nameEl.innerHTML = `<input type="text" value="${escapeHtml(oldName)}">`;
  const input = $('input', nameEl);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    const g = (state.config.groups || []).find((x) => x.id === groupId);
    if (g && v && v !== oldName) {
      state.config = await liteapi.invoke('groups:upsert', { ...g, name: v });
    }
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { done = true; renderSidebar(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

function beginRename(item, convId, oldTitle) {
  const titleEl = $('.conv-title', item);
  titleEl.innerHTML = `<input type="text" value="${escapeHtml(oldTitle)}">`;
  const input = $('input', titleEl);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== oldTitle) {
      state.convs = await liteapi.invoke('convs:rename', { id: convId, title: v });
    }
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { done = true; renderSidebar(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

/* ================= 分组弹层(新对话) ================= */
function menuOutside(e) {
  if (!e.target.closest('#conv-menu')) closeConvMenu();
}

function closeConvMenu() {
  const p = $('#conv-menu');
  if (p) p.remove();
  document.removeEventListener('mousedown', menuOutside);
}

function openConvMenu() {
  closeConvMenu();
  const groups = [...(state.config.groups || [])].sort((a) => (a.id === 'default' ? -1 : 0));
  const counts = {};
  state.convs.forEach((c) => { counts[c.groupId || 'default'] = (counts[c.groupId || 'default'] || 0) + 1; });
  const pop = document.createElement('div');
  pop.id = 'conv-menu';
  pop.innerHTML = `
    <div class="menu-title">开始新对话 —— 选择工作分组</div>
    ${groups.map((g) => `
      <div class="menu-item" data-id="${g.id}" title="${escapeHtml(g.workspace || '跟随全局工作目录')}">
        <span class="mi-icon">${g.icon || '📁'}</span>
        <span class="mi-name">${escapeHtml(g.name)}</span>
        <span class="mi-meta">${counts[g.id] || 0} 会话</span>
      </div>`).join('')}
    <div class="menu-sep"></div>
    <div class="menu-item" data-new="1"><span class="mi-icon">＋</span><span class="mi-name">新建工作分组…</span></div>`;
  document.body.appendChild(pop);
  const rect = $('#btn-new').getBoundingClientRect();
  pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 320) + 'px';
  pop.style.left = rect.left + 'px';
  $$('.menu-item', pop).forEach((item) => item.addEventListener('click', () => {
    if (item.dataset.new) renderNewGroupForm(pop);
    else startConvInGroup(item.dataset.id);
  }));
  setTimeout(() => document.addEventListener('mousedown', menuOutside), 0);
}

function startConvInGroup(groupId) {
  closeConvMenu();
  const g = (state.config.groups || []).find((x) => x.id === groupId);
  state.conv = null;
  state.pendingGroupId = groupId;
  renderSidebar();
  renderChatEmpty(g ? `工作分组「${g.name}」已就绪,发送第一条消息开始` : null);
  renderSubagentPill(true);
  renderUsageBar(); // 新会话:清掉上一会话的会话级用量/上下文(v0.50.1 修复跨会话残留)
  $('#input').focus();
}

/* ================= 连接桥(v0.52.0):MCP / SSH / Windows 连接管理中心 ================= */
// SSH 连接走内置终端(系统 ssh.exe,密钥登录);Windows 连接 = 远程桌面(mstsc /v:主机)。
// 终端无 TTY:SSH 密码交互不可用,条目须配密钥路径或已就绪的 ~/.ssh/config 别名(desc 已注明)。
// 管理页 = 设置抽屉「连接桥」pane(renderBridgesPane);侧栏「连接桥」直接落该页。
function bridgeHostOk(s) { return /^[\w.:-]+$/.test(s || ''); }
function bridgeUserOk(s) { return /^[\w.@-]*$/.test(s || ''); }
function bridgeKeyOk(s) { return !s || /^[\w\\:\/ .()-]+$/.test(s); }

// —— SSH/Windows 连接凭据混淆(2026-10-25):host/user/keyPath 落盘前 XOR+Base64 混淆(obf1: 前缀),
//    防 config.json 被直接翻看/全文搜索泄露服务器地址与账号;密码走主进程 safeStorage 真加密(bridge:saveEntry)。
//    旧明文条目天然兼容(无前缀原样读出,下次保存自动升级为混淆)。
const OBF_KEY = 'LiteAgent-Bridge-Obf-v1';
function obfStr(s) {
  const v = String(s || '');
  if (!v || v.startsWith('obf1:')) return v;
  let x = '';
  for (let i = 0; i < v.length; i++) x += String.fromCharCode(v.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  return 'obf1:' + btoa(unescape(encodeURIComponent(x)));
}
function deobfStr(s) {
  const v = String(s || '');
  if (!v.startsWith('obf1:')) return v; // 旧明文条目:原样
  try {
    const x = decodeURIComponent(escape(atob(v.slice(5))));
    let o = '';
    for (let i = 0; i < x.length; i++) o += String.fromCharCode(x.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
    return o;
  } catch (_) { return v; }
}

function sshCommand(s) {
  let cmd = 'ssh';
  if (s.port && String(s.port) !== '22') cmd += ` -p ${parseInt(s.port, 10)}`;
  const key = deobfStr(s.keyPath);
  if (key) cmd += ` -i "${key}"`;
  const host = deobfStr(s.host), user = deobfStr(s.user);
  cmd += ' ' + (user ? `${user}@${host}` : host);
  return cmd;
}

// 连接动作统一落右侧面板终端标签(持久 shell 自动唤起,term:write 自动补换行)
function openPanelRun(cmd) {
  togglePanel(true);
  setPanelTab('term');
  liteapi.invoke('term:write', cmd);
}

/* ================= 精简模式(v0.52.0,原「纯终端模式」改名;config 键 pureTerminal 不变) ================= */
async function enterLiteMode() {
  state.config = await liteapi.invoke('config:set', { ui: { pureTerminal: true } });
  applyUiMode(); // applyUiMode 末尾 syncPureTerminal → openTermConsole 接管整窗
  toast(t('已进入精简模式'));
}

/* 侧栏隐藏开关(v0.52.0):顶栏按钮切换整条侧栏,config.ui.sidebarHidden 持久化 */
function syncSidebarToggleBtn() {
  const b = document.getElementById('btn-sidebar-toggle');
  if (!b) return;
  const hidden = !!(state.config && state.config.ui && state.config.ui.sidebarHidden);
  b.classList.toggle('on', hidden); // 隐藏态按钮点亮,提示当前侧栏已收起、点此还原
  b.title = t(hidden ? '显示侧栏' : '隐藏侧栏');
}

async function toggleSidebar() {
  const hidden = !((state.config.ui || {}).sidebarHidden);
  state.config = await liteapi.invoke('config:set', { ui: { sidebarHidden: hidden } });
  applyUiMode(); // applyUiMode 末尾 syncSidebarToggleBtn 同步按钮态
}

/* ================= 远程控制快捷弹层(v0.54.0):侧栏「远程」按钮 = 开关/地址/审批授权一键直达 ================= */
function closeRemotePop() {
  const p = $('#remote-menu');
  if (p) p.remove();
  document.removeEventListener('mousedown', remoteOutside);
}

function remoteOutside(e) {
  const p = $('#remote-menu');
  if (p && !p.contains(e.target) && !e.target.closest('#btn-remote')) closeRemotePop();
}

function remoteUrlOf() {
  const r = (state.config.remote || {});
  // accessHost 由主进程派生(局域网 IP / frp 公网地址 / EasyTier 虚拟 IP),隧道模式下自动切换
  return r.enabled && r.token && r.accessHost ? `http://${r.accessHost}/?t=${r.token}` : '';
}

function openRemotePop() {
  if ($('#remote-menu')) { closeRemotePop(); return; }
  const pop = document.createElement('div');
  pop.id = 'remote-menu';
  document.body.appendChild(pop);
  renderRemotePop(pop);
  const rect = $('#btn-remote').getBoundingClientRect();
  pop.style.left = Math.max(8, rect.left) + 'px';
  pop.style.top = Math.max(8, Math.min(rect.top - pop.offsetHeight - 8, window.innerHeight - pop.offsetHeight - 12)) + 'px'; // 朝视口内:按钮上方
  setTimeout(() => document.addEventListener('mousedown', remoteOutside), 0);
}

function renderRemotePop(pop) {
  const r = state.config.remote || {};
  const url = remoteUrlOf();
  pop.innerHTML = `
    <div class="menu-title">${t('远程控制(手机 / 平板)')}</div>
    ${!r.enabled ? `
      <div class="menu-item" data-ract="enable">
        <span class="mi-icon">🔓</span>
        <span class="mi-name">${t('开启远程控制')}</span>
      </div>
      <div class="bm-empty">${t('同一局域网的手机浏览器打开地址即可操控 Agent;默认生成访问令牌')}</div>
    ` : `
      <div class="menu-item" style="cursor:default">
        <span class="mi-icon"><span class="at-tab-live"></span></span>
        <span class="mi-name">${t('运行中')} · ${t('端口')} ${r.port}</span>
      </div>
      <div class="bm-empty" style="word-break:break-all">${escapeHtml(url)}</div>
      ${(r.tunnel && r.tunnel.mode && r.tunnel.mode !== 'off') ? `<div class="bm-empty">${t('出网隧道')}: ${r.tunnel.mode === 'frp' ? 'FRP' : 'EasyTier'}${r.accessHost && r.accessHost !== r.lanIP + ':' + r.port ? ' · ' + r.accessHost : ''}</div>` : ''}
      <div class="menu-item" data-ract="copy">
        <span class="mi-icon">⧉</span>
        <span class="mi-name">${t('复制访问地址')}</span>
      </div>
      <div class="menu-item" data-ract="approval">
        <span class="mi-icon">${r.allowApproval ? '☑' : '☐'}</span>
        <span class="mi-name">${t('允许远程审批')}</span>
      </div>
      <div class="menu-item" data-ract="disable">
        <span class="mi-icon">🔒</span>
        <span class="mi-name">${t('关闭远程控制')}</span>
      </div>
    `}`;
  $$('.menu-item', pop).forEach((item) => item.addEventListener('click', async () => {
    const act = item.dataset.ract;
    if (act === 'enable' || act === 'disable') {
      state.config = await liteapi.invoke('config:set', { remote: { enabled: act === 'enable' } });
      renderRemotePop(pop);
      toast(act === 'enable' ? t('远程控制已开启:用手机浏览器打开地址(需同一局域网)') : t('远程控制已关闭'));
    } else if (act === 'copy') {
      navigator.clipboard.writeText(url).then(() => toast(t('已复制访问地址'))).catch(() => {});
    } else if (act === 'approval') {
      state.config = await liteapi.invoke('config:set', { remote: { allowApproval: !r.allowApproval } });
      renderRemotePop(pop);
      toast(state.config.remote.allowApproval ? t('远程审批已开启:手机上可批准工具执行') : t('远程审批已关闭(仅主界面批准)'));
    }
  }));
}

function renderNewGroupForm(pop) {
  pop.innerHTML = `
    <div class="menu-title">新建工作分组</div>
    <div class="menu-form">
      <label>分组名称</label>
      <input type="text" id="ng-name" placeholder="例如:项目A / 客户演示">
      <label>工作文件夹(该分组下的智能体默认在此读写)</label>
      <div style="display:flex;gap:6px">
        <input type="text" id="ng-ws" readonly placeholder="留空则跟随全局工作目录">
        <button class="btn" id="ng-pick">浏览</button>
      </div>
      <div class="hint" id="ng-hint">提示:留空时使用全局工作目录;也可先填好名称,会自动建议同名子文件夹</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn primary" id="ng-create" disabled>创建并开始对话</button>
        <button class="btn" id="ng-back">返回</button>
      </div>
    </div>`;
  const nameI = $('#ng-name');
  const wsI = $('#ng-ws');
  const hint = $('#ng-hint');
  const createB = $('#ng-create');
  nameI.addEventListener('input', () => {
    createB.disabled = !nameI.value.trim();
    if (nameI.value.trim() && !wsI.value) {
      const base = (state.config.agent.workspace || '').replace(/[\\/]+$/, '');
      if (base) hint.textContent = `将使用:${base}\\${nameI.value.trim()}`;
    }
  });
  $('#ng-pick').addEventListener('click', async () => {
    const dir = await liteapi.invoke('dialog:pickWorkspace', '选择分组工作文件夹');
    if (dir) {
      wsI.value = dir;
      hint.textContent = `已选择:${dir}`;
    }
  });
  $('#ng-back').addEventListener('click', () => openConvMenu());
  createB.addEventListener('click', async () => {
    const name = nameI.value.trim();
    if (!name) return;
    let ws = wsI.value.trim();
    // 未选文件夹且填了名称 → 自动建同名子文件夹,项目一目了然
    if (!ws) {
      const base = (state.config.agent.workspace || '').replace(/[\\/]+$/, '');
      if (base) ws = pathJoin(base, name);
    }
    const res = await liteapi.invoke('groups:upsert', { name, workspace: ws });
    state.config = res;
    const g = state.config.groups[state.config.groups.length - 1];
    toast(`已创建分组「${g.name}」${g.workspace ? ',工作文件夹:' + g.workspace : ''}`);
    startConvInGroup(g.id);
  });
  nameI.focus();
}

function pathJoin(base, name) {
  const sep = /[\\/]$/.test(base) ? '' : (base.includes('\\') ? '\\' : '/');
  return base + sep + name.replace(/[\\/:*?"<>|]/g, '_');
}

async function openConv(id) {
  // 多会话并发:回复进行中也允许切换;后台会话由 streams.map 继续跟踪
  const prevId = state.conv && state.conv.id;
  const conv = await liteapi.invoke('convs:get', id);
  if (!conv) { await refreshConvs(); return; }
  // 切走的会话若仍在回复:复位其 DOM 累加器(旧 DOM 即将销毁),后续事件进缓冲
  if (prevId && prevId !== id) {
    const PS = state.streams.get(prevId);
    if (PS) { PS.turnEl = null; PS.text = null; PS.reasoning = null; PS.tools.clear(); PS.asks.clear(); }
  }
  state.conv = conv;
  state.stickBottom = true;
  renderSidebar();
  renderConv(conv);
  renderUsageBar();
  const S = state.streams.get(id);
  if (S) {
    // 该会话有进行中的流:重放缓冲的事件,无缝接上进行中的回复
    S.turnEl = null; S.text = null; S.reasoning = null;
    S.tools.clear(); S.asks.clear();
    const buf = S.buffer; S.buffer = [];
    for (const ev of buf) applyStreamEvent(S, ev);
    flushStreaming();
    setSendMode('stop');
  } else {
    setSendMode('send');
  }
  renderSubagentPill(true);
}

/* ================= 会话渲染 ================= */
function renderChatEmpty(subtitle) {
  closeSearch();
  if (term.active) { termClear(); termPrintBanner(); }
  const g = (state.config.groups || []).find((x) => x.id === (state.pendingGroupId || (state.conv && state.conv.groupId) || 'default'));
  chatEl.innerHTML = `
    <div class="chat-inner">
      <div class="empty-hero">
        <div class="hero-logo"><svg viewBox="0 0 512 512" width="52" height="52" aria-label="LiteAgent"><rect width="512" height="512" rx="112" fill="#101418"/><rect x="84" y="112" width="344" height="240" rx="28" fill="none" stroke="#22d3ee" stroke-width="18"/><line x1="84" y1="164" x2="428" y2="164" stroke="#22d3ee" stroke-width="10" opacity=".5"/><circle cx="112" cy="138" r="7" fill="#22d3ee" opacity=".7"/><polyline points="150,216 218,260 150,304" fill="none" stroke="#e8e8ec" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/><line x1="244" y1="310" x2="330" y2="310" stroke="#e8e8ec" stroke-width="22" stroke-linecap="round"/><line x1="256" y1="352" x2="256" y2="392" stroke="#22d3ee" stroke-width="16" stroke-linecap="round"/><line x1="196" y1="400" x2="316" y2="400" stroke="#22d3ee" stroke-width="16" stroke-linecap="round"/></svg></div>
        <h2>${g && g.id !== 'default' ? escapeHtml(g.icon || '📁') + ' ' + escapeHtml(g.name) : 'LiteAgent 桌面智能体'}</h2>
        <p>${escapeHtml(subtitle || '多模型接入 · 流式对话 · 智能体工具调用')}</p>
        ${g && g.workspace ? `<div class="steps">工作文件夹:${escapeHtml(g.workspace)}</div>` : ''}
        <div class="steps">① 右下角「设置」配置模型服务并填写 API Key<br>② 新对话时选择工作分组(可绑定专属文件夹)<br>③ 顶栏切换四档模式:对话 / 受限 / 完全 / 创造</div>
      </div>
    </div>`;
}

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + 'MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + 'KB';
  return v + 'B';
};

// 附件消息块:图片缩略图(可点开灯箱)/ 文本文件 chip
function attachEl(a) {
  if (a.kind === 'image' && a.dataUrl) {
    const img = document.createElement('img');
    img.className = 'attach-img';
    img.src = a.dataUrl;
    img.alt = a.name;
    img.title = `${a.name}(${fmtBytes(a.size)})`;
    return img;
  }
  const chip = document.createElement('div');
  chip.className = 'attach-file';
  chip.textContent = `📄 ${a.name}(${fmtBytes(a.size)})`;
  return chip;
}

function userBubble(m, msgIndex) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  const b = document.createElement('div');
  b.className = 'bubble';
  const text = String(m.content || '');
  if (text) b.textContent = text;
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    b.appendChild(attachEl(a));
  }
  if (!text && (m.attachments || []).length) b.style.whiteSpace = 'normal';
  div.appendChild(b);
  // 用户消息复制钮(悬停浮现,与 AI 卡片操作条同风格)
  if (typeof msgIndex === 'number') {
    const row = document.createElement('div');
    row.className = 'turn-actions user-actions';
    const copy = document.createElement('button');
    copy.className = 'ta-btn ta-ico';
    copy.title = '复制';
    copy.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => { copy.classList.add('done'); toast('已复制'); setTimeout(() => copy.classList.remove('done'), 1200); }).catch(() => toast('复制失败'));
    });
    row.appendChild(copy);
    div.appendChild(row);
  }
  return div;
}

function appendUserBubble(m) {
  $('.empty-hero', chatEl) && (chatEl.innerHTML = '');
  let inner = $('.chat-inner', chatEl);
  if (!inner) { inner = document.createElement('div'); inner.className = 'chat-inner'; chatEl.appendChild(inner); }
  inner.appendChild(userBubble(typeof m === 'string' ? { content: m } : m));
  maybeScroll(true);
}

function ensureTurn(S) {
  if (S.turnEl) return;
  $('.empty-hero', chatEl) && (chatEl.innerHTML = '');
  let inner = $('.chat-inner', chatEl);
  if (!inner) { inner = document.createElement('div'); inner.className = 'chat-inner'; chatEl.appendChild(inner); }
  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant';
  msg.innerHTML = '<div class="who"><span class="dot"></span>LiteAgent<span class="who-model"></span><span class="turn-duration live"></span></div>';
  const turn = document.createElement('div');
  turn.className = 'turn';
  msg.appendChild(turn);
  inner.appendChild(msg);
  S.turnEl = turn;
  S.whoModelEl = $('.who-model', msg);
  // 用时徽章:蓝○ + 实时跳动(完成/中止/出错时定格换色)
  S.turnT0 = Date.now();
  S.durEl = $('.turn-duration', msg);
  if (S.durEl) {
    S.durEl.textContent = '○ ' + fmtDurZh(0);
    S.durTimer = setInterval(() => { if (S.durEl) S.durEl.textContent = '○ ' + fmtDurZh(Date.now() - S.turnT0); }, 1000);
  }
}

function toolBrief(name, args) {
  const a = args || {};
  if (name === 'run_command') return a.command || '';
  if (name === 'web_fetch') return a.url || '';
  if (name === 'read_file' || name === 'write_file' || name === 'list_dir') return a.path || '';
  try { return JSON.stringify(a).slice(0, 60); } catch (_) { return ''; }
}

const TOOL_STATE_TEXT = {
  awaiting: '待批准', running: '执行中', done: '已完成',
  error: '出错', denied: '已拒绝', aborted: '已中止',
};

// 问询选项字母(支持 >3 项 —— 旧代码 'ABC'[i] 第 4 项起变 undefined,v0.54.19 修)
function askLetter(i) { return 'ABCDEFG'[i] || String(i + 1); }
function askIsRecommended(label) { return /(\(推荐\)|(推荐))/.test(String(label || '')); }

function toolCardEl(ev) {
  const card = document.createElement('div');
  card.className = `tool-card st-${ev.status}`;
  card.dataset.toolCallId = ev.toolCallId;
  const brief = escapeHtml(toolBrief(ev.name, ev.args));
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-ico"></span>
      <span class="tool-name">${escapeHtml(ev.name)}</span>
      <span class="tool-brief">${brief}</span>
      <span class="tool-state">${t(TOOL_STATE_TEXT[ev.status] || ev.status)}</span>
    </div>
    <div class="tool-detail">
      <h5>参数</h5><pre class="tool-args-pre"></pre>
      <div class="tool-result-wrap"></div>
    </div>`;
  $('.tool-args-pre', card).textContent = JSON.stringify(ev.args || {}, null, 2);
  return card;
}

function setToolCardStatus(card, status, result) {
  card.classList.remove('st-awaiting', 'st-running', 'st-done', 'st-error', 'st-denied', 'st-aborted');
  card.classList.add(`st-${status}`);
  $('.tool-state', card).textContent = t(TOOL_STATE_TEXT[status] || status);
  const ico = $('.tool-ico', card);
  ico.innerHTML = '';
  if (status === 'running') ico.innerHTML = '<span class="spinner"></span>';
  else if (status === 'done') ico.textContent = '✓';
  else if (status === 'error' || status === 'denied') ico.textContent = '✕';
  else if (status === 'aborted') ico.textContent = '■';
  else ico.textContent = '…';
  if (result != null) {
    let wrap = $('.tool-result-wrap', card);
    if (!wrap) { wrap = document.createElement('div'); card.appendChild(wrap); }
    if (String(result).length) {
      wrap.innerHTML = '<h5>结果</h5><pre class="tool-result-pre"></pre>';
      $('.tool-result-pre', wrap).textContent = String(result);
    }
  }
  const approve = $('.tool-approve', card);
  if (approve && status !== 'awaiting') approve.remove();
}

function appendApprovalButtons(S, card, toolCallId) {
  const div = document.createElement('div');
  div.className = 'tool-approve';
  div.innerHTML = '<button class="btn-approve">批准执行</button><button class="btn-reject">拒绝</button>';
  $('.btn-approve', div).addEventListener('click', () => decide(toolCallId, true));
  $('.btn-reject', div).addEventListener('click', () => decide(toolCallId, false));
  const decide = (approved) => {
    $$('button', div).forEach((b) => { b.disabled = true; });
    liteapi.invoke('tool:decision', { streamId: S.streamId, toolCallId, approved });
    toast(approved ? '已批准' : '已拒绝');
  };
  card.appendChild(div);
}

function reasoningEl() {
  const det = document.createElement('details');
  det.className = 'reasoning';
  det.open = true;
  det.innerHTML = '<summary>思考过程</summary><div class="reasoning-body"></div>';
  return det;
}

/* --- 渲染已保存的会话 --- */
function renderConv(conv) {
  chatEl.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'chat-inner';
  chatEl.appendChild(inner);

  if (!conv.messages || !conv.messages.length) { renderChatEmpty(); return; }

  // 该会话有进行中的流时,最后一条 assistant 消息就是尚未完成的回复轮:
  // 不在这里渲染(否则与流式重放重复),由 openConv 重放事件完整重建
  const skipInflight = state.streams.has(conv.id)
    && conv.messages.length > 0
    && conv.messages[conv.messages.length - 1].role === 'assistant';

  const msgs = conv.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (skipInflight && i === msgs.length - 1) continue;
    if (m.role === 'user') {
      const ub = userBubble(m, i);
      ub.dataset.idx = i;
      inner.appendChild(ub);
    } else if (m.role === 'assistant' && m.blocks && !m.blocks.length) {
      continue; // 空块消息(占位撤回残留):不渲染
    } else if (m.role === 'assistant' && m.blocks && m.blocks.length === 1 && m.blocks[0].type === 'model-switch') {
      inner.appendChild(savedBlockEl(m.blocks[0])); // 独立的模型切换提示行(无卡片)
    } else if (m.role === 'assistant') {
      const msg = document.createElement('div');
      msg.className = 'msg msg-assistant';
      msg.dataset.idx = i;
      msg.innerHTML = '<div class="who"><span class="dot"></span>LiteAgent' + (m.model ? '<span class="who-model">' + escapeHtml(m.model) + '</span>' : '') + (m.durationMs ? '<span class="turn-duration done">✓ ' + fmtDurZh(m.durationMs) + '</span>' : '') + '</div>';
      const turn = document.createElement('div');
      turn.className = 'turn';
      for (const b of m.blocks || []) {
        turn.appendChild(savedBlockEl(b));
      }
      msg.appendChild(turn);
      inner.appendChild(msg);
      // 最后一条回复挂操作行于卡片正下方(msg 内);流式进行中那轮不挂
      if (i === msgs.length - 1 && !skipInflight) {
        const actions = turnActionsEl(conv, i);
        if (actions) msg.appendChild(actions);
      }
    }
  }
  renderSidebar();
  maybeScroll(true);
  refreshSearch();
  renderTermConv(conv); // 纯终端模式:控制台跟随会话重放(openConv/分支切换共用)
}

function savedBlockEl(b) {
  if (b.type === 'image-pending') {
    const div = document.createElement('div');
    div.className = 'image-pending';
    div.innerHTML = `<span class="spinner"></span> ${escapeHtml(t('图片生成中…'))} <span style="color:var(--text-3)">(${escapeHtml(b.model || '')})</span>`;
    return div;
  }
  if (b.type === 'image') {
    const wrap = document.createElement('div');
    wrap.className = 'gen-image';
    const img = document.createElement('img');
    img.src = `data:${b.mime || 'image/png'};base64,${b.base64}`;
    img.alt = '生成图片';
    img.addEventListener('click', () => openImageLightbox(img.src));
    wrap.appendChild(img);
    return wrap;
  }
  if (b.type === 'model-switch') {
    const div = document.createElement('div');
    div.className = 'model-switch-line';
    div.innerHTML = `<span>${escapeHtml(t('已切换到'))} ${escapeHtml(b.model || '')}</span>`;
    return div;
  }
  if (b.type === 'text') {
    const div = document.createElement('div');
    div.className = 'md';
    renderMd(div, b.content);
    return div;
  }
  if (b.type === 'reasoning') {
    const det = reasoningEl();
    det.removeAttribute('open');
    renderMd($('.reasoning-body', det), b.content);
    // 纯空白思考块(旧数据):不展示空「思考过程」行(v0.57.5)
    if (!String(b.content || '').replace(/\s+/g, '')) det.classList.add('reasoning-blank');
    return det;
  }
  if (b.type === 'ask') {
    const card = document.createElement('div');
    card.className = 'ask-card answered';
    card.innerHTML = '<div class="ask-head">❓ ' + escapeHtml(b.question || '') + '</div>'
      + (b.context ? '<div class="ask-ctx">' + escapeHtml(b.context) + '</div>' : '')
      + '<div class="ask-opts">' + (b.options || []).map((o, i) =>
          '<div class="ask-opt' + (b.answerKind === 'opt' && b.answerIndex === i ? ' picked' : '') + (askIsRecommended(o.label) ? ' ask-rec' : '') + '"><b>' + askLetter(i) + '. ' + escapeHtml(o.label || '') + '</b>'
          + (o.detail ? '<span class="ask-detail">' + escapeHtml(o.detail) + '</span>' : '') + '</div>').join('')
      + '</div>'
      + '<div class="ask-answered">' + escapeHtml(b.answerDisplay || '') + '</div>';
    return card;
  }
  if (b.type === 'tool') {
    const card = toolCardEl({ toolCallId: b.id, name: b.name, args: b.args, status: b.status });
    setToolCardStatus(card, b.status, b.result);
    return card;
  }
  if (b.type === 'error') {
    return errorCardEl(b.message);
  }
  return document.createElement('div');
}

function errorCardEl(message) {
  const div = document.createElement('div');
  div.className = 'error-card';
  div.innerHTML = `<span class="err-msg">⚠ ${escapeHtml(message)}</span><button class="btn-retry">重试</button>`;
  $('.btn-retry', div).addEventListener('click', () => retryLast());
  return div;
}

/* ================= 流式处理 ================= */
// 渲染节流:流式重渲染有成本,80ms 自适应节流 + 尾帧兜底(比每帧重渲流畅得多)
let flushTimer = null;
let lastFlushAt = 0;
function scheduleFlush() {
  if (flushTimer) return;
  const step = plainRender() ? 250 : 80; // 低内存/纯终端模式降低刷新频率
  const wait = Math.max(0, step - (performance.now() - lastFlushAt));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    lastFlushAt = performance.now();
    flushStreaming();
  }, wait);
}

function flushStreaming() {
  const S = state.conv ? state.streams.get(state.conv.id) : null;
  if (!S) return;
  // 纯终端模式:隐藏聊天区不重渲 Markdown(省 CPU/GPU),退出时 openConv 会从落盘数据完整重放
  if (S.text && !S.text.finalized) { if (!term.active) renderMd(S.text.el, S.text.raw, true); maybeScroll(); }
  if (S.reasoning && !S.reasoning.finalized) {
    $('.reasoning-body', S.reasoning.el).textContent = S.reasoning.raw;
    maybeScroll();
  }
}

function handleChatEvent(ev) {
  if (ev.type === 'user-saved') { refreshConvs(); return; }
  if (ev.type === 'convs-changed') { refreshConvs(); return; } // 远程控制发起了消息(v0.54.0):主界面侧栏同步
  if (ev.type === 'internal-preview') { // AI 生成的 HTML → 面板浏览器直接打开(open_external 内部预览)
    const target = localFileUrl(ev.path);
    // 精简模式没有右侧面板(全屏终端遮住),看不到页面 —— 先退出精简再打开,符合「打开页面」意图
    if (document.body.classList.contains('pure-terminal')) {
      liteapi.invoke('config:set', { ui: { pureTerminal: false } }).then((cfg) => {
        state.config = cfg;
        applyUiMode();
        openInPanelBrowser(target);
        toast('已退出精简模式,在内置浏览器打开页面');
      }).catch(() => {
        openInPanelBrowser(target);
      });
    } else {
      openInPanelBrowser(target);
    }
    return;
  }
  if (ev.type === 'usage') {
    if (state.conv && ev.convId === state.conv.id) {
      state.conv.usage = ev.convUsage;
      state.conv.ctx = ev.ctx;
    }
    state.config.usage = ev.global;
    renderUsageBar();
    return;
  }
  // 右侧面板馈线:子智能体流(辅助对话)与工具事件(审查)不依赖当前会话,后台会话同样入面板
  if (ev.type === 'sub-agent') { panelAuxEvent(ev); }
  if (ev.type === 'tool-start' || ev.type === 'tool-end') { panelReviewEvent(ev); }
  const S = state.streams.get(ev.convId);
  if (!S || ev.streamId !== S.streamId) return; // streamId 隔离:被接管/已本地停止的旧流的迟到事件一律忽略
  if (!state.conv || state.conv.id !== ev.convId) {
    // 后台会话:事件进缓冲,切回时重放;完成/出错即时收尾并提示
    if (ev.type === 'done') { finishStreaming(ev); return; }
    if (ev.type === 'error') {
      finishStreaming(ev);
      const meta = state.convs.find((c) => c.id === ev.convId);
      toast(`会话「${(meta && meta.title) || '…'}」出错:${ev.message || '未知错误'}`);
      return;
    }
    if (ev.type === 'ask-user') {
      const meta = state.convs.find((c) => c.id === ev.convId);
      toast(`会话「${(meta && meta.title) || '…'}」正在等待你的选择`);
    }
    S.buffer.push(ev);
    return;
  }
  applyStreamEvent(S, ev);
  termApplyEvent(S, ev); // 纯终端模式接管时,同一事件流以终端样式再渲染一份
}

function applyStreamEvent(S, ev) {
  switch (ev.type) {
    case 'text-delta': {
      ensureTurn(S);
      if (S.reasoning && !S.reasoning.finalized) {
        S.reasoning.finalized = true;
        S.reasoning.el.removeAttribute('open');
      }
      if (!S.text || S.text.finalized) {
        const div = document.createElement('div');
        div.className = 'md';
        S.turnEl.appendChild(div);
        S.text = { el: div, raw: '', finalized: false };
      }
      S.text.raw += ev.text;
      scheduleFlush();
      break;
    }
    case 'text-end': {
      if (S.text && !S.text.finalized) {
        S.text.raw = ev.content || S.text.raw;
        if (!term.active) renderMd(S.text.el, S.text.raw, false); // 终端模式:隐藏区不渲染,退出时重放
        S.text.finalized = true;
        if (state.conv && state.conv.id === S.convId) refreshSearch();
      }
      break;
    }
    case 'reasoning-delta': {
      ensureTurn(S);
      if (!S.reasoning || S.reasoning.finalized) {
        const det = reasoningEl();
        S.turnEl.appendChild(det);
        S.reasoning = { el: det, raw: '', finalized: false };
      }
      S.reasoning.raw += ev.text;
      scheduleFlush();
      break;
    }
    case 'tool-start': {
      ensureTurn(S);
      if (ev.name === 'ask_user') break; // ask_user 用专用问询卡片,不走工具卡
      let entry = S.tools.get(ev.toolCallId);
      if (!entry) {
        const card = toolCardEl(ev);
        S.turnEl.appendChild(card);
        entry = { card };
        S.tools.set(ev.toolCallId, entry);
        maybeScroll();
      }
      setToolCardStatus(entry.card, ev.status);
      if (ev.status === 'awaiting') appendApprovalButtons(S, entry.card, ev.toolCallId);
      break;
    }
    case 'tool-end': {
      const entry = S.tools.get(ev.toolCallId);
      if (ev.name === 'ask_user') {
        const askCard = S.asks.get(ev.toolCallId);
        if (askCard && !askCard.classList.contains('answered') && ev.status === 'aborted') {
          askCard.classList.add('answered');
          const opts = $('.ask-opts', askCard);
          if (opts) opts.outerHTML = '<div class="ask-answered">■ 用户已停止</div>';
          const free = $('.ask-free', askCard);
          if (free) free.remove();
          S.asks.delete(ev.toolCallId);
        }
        maybeScroll();
        break;
      }
      if (entry) setToolCardStatus(entry.card, ev.status, ev.result);
      maybeScroll();
      break;
    }
    case 'mcp-note': {
      toast(ev.message);
      break;
    }
    case 'attach-note': {
      toast(`📎 ${ev.message}`);
      break;
    }
    case 'security-note': {
      toast(`⚠ 检测到敏感信息:${(ev.types || []).join('、')}(已按设置继续发送,可改为脱敏/拦截)`);
      break;
    }
    case 'compress-note': {
      if (ev.stage === 'done') toast('已自动压缩上下文:旧对话已生成摘要');
      else if (ev.stage === 'start') toast('正在压缩上下文…');
      else if (ev.stage === 'error') toast('上下文摘要失败,已退回截断模式');
      break;
    }
    case 'config-changed': {
      toast('智能体已更新你的助手/技能配置');
      state.reasonCapsCache.clear();
      liteapi.invoke('config:get').then((c) => {
        state.config = c;
        fillAssistantSelect();
        fillModeSelect();
        renderSkillBar();
        updateStatusHint();
      });
      break;
    }
    case 'ask-user': {
      ensureTurn(S);
      const card = document.createElement('div');
      card.className = 'ask-card';
      card.dataset.toolCallId = ev.toolCallId;
      card.innerHTML = '<div class="ask-head">❓ ' + escapeHtml(ev.question || '请做出选择') + '</div>'
        + (ev.context ? '<div class="ask-ctx">' + escapeHtml(ev.context) + '</div>' : '')
        + '<div class="ask-opts">' + (ev.options || []).map((o, i) =>
            '<button class="ask-opt' + (askIsRecommended(o.label) ? ' ask-rec' : '') + '" data-i="' + i + '"><b>' + askLetter(i) + '. ' + escapeHtml(o.label || '') + '</b>'
            + (o.detail ? '<span class="ask-detail">' + escapeHtml(o.detail) + '</span>' : '') + '</button>').join('')
        + '</div>'
        + '<div class="ask-free"><input type="text" placeholder="或输入你自己的答案(自定义选项)"><button class="btn">提交</button></div>';
      S.turnEl.appendChild(card);
      S.asks.set(ev.toolCallId, card);
      const answer = (enc, displayHtml) => {
        liteapi.invoke('ask:answer', { streamId: S.streamId, toolCallId: ev.toolCallId, answer: enc });
        card.classList.add('answered');
        $('.ask-opts', card).outerHTML = '<div class="ask-answered">' + displayHtml + '</div>';
        $('.ask-free', card).remove();
      };
      $$('.ask-opt', card).forEach((b) => b.addEventListener('click', () => {
        if (card.classList.contains('answered')) return;
        const i = Number(b.dataset.i);
        const o = (ev.options || [])[i] || {};
        answer('opt:' + i, '✅ 用户选择了选项 ' + (i + 1) + ':' + escapeHtml(o.label || ''));
      }));
      const inp = $('input', card);
      const submitFree = () => {
        const v = inp.value.trim();
        if (!v || card.classList.contains('answered')) return;
        answer('free:' + v, '✍️ 用户自己输入:' + escapeHtml(v));
      };
      $('button', $('.ask-free', card)).addEventListener('click', submitFree);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitFree(); } e.stopPropagation(); });
      maybeScroll(true);
      break;
    }
    case 'sub-agent': {
      // 多智能体:把子智能体实时状态渲染进 dispatch 工具卡片
      const entry = S.tools.get(ev.toolCallId);
      if (!entry) break;
      entry.card.classList.add('open');
      const det = $('.tool-detail', entry.card);
      let list = $('.sub-list', entry.card);
      if (!list) {
        list = document.createElement('div');
        list.className = 'sub-list';
        det.insertBefore(list, $('.tool-result-wrap', det));
      }
      let item = $('.sub-agent[data-i="' + ev.index + '"]', list);
      if (!item) {
        item = document.createElement('div');
        item.className = 'sub-agent';
        item.dataset.i = ev.index;
        item.innerHTML = '<div class="sub-head"><span class="sub-ico"></span><b class="sub-name">' + escapeHtml(ev.name || '子智能体') + '</b><span class="sub-model">' + escapeHtml(ev.model || '') + '</span></div><pre class="sub-text"></pre>';
        list.appendChild(item);
      }
      $('.sub-ico', item).textContent = ev.status === 'done' ? '✓' : ev.status === 'error' ? '✕' : '';
      item.className = 'sub-agent st-' + ev.status;
      if (ev.text) $('.sub-text', item).textContent = ev.text;
      maybeScroll();
      break;
    }
    case 'error': {
      ensureTurn(S);
      S.turnEl.appendChild(errorCardEl(ev.message));
      maybeScroll(true);
      // 出错即结束本流(主进程已清理,不会再有 done;不收尾会卡住发送按钮)
      finishStreaming(ev, 'error');
      break;
    }
    case 'images': {
      ensureTurn(S);
      for (const im of ev.images || []) {
        const wrap = document.createElement('div');
        wrap.className = 'gen-image';
        const img = document.createElement('img');
        img.src = `data:${im.mime || 'image/png'};base64,${im.base64}`;
        img.alt = '生成图片';
        img.addEventListener('click', () => openImageLightbox(img.src));
        wrap.appendChild(img);
        S.turnEl.appendChild(wrap);
      }
      maybeScroll();
      break;
    }
    case 'done': {
      finishStreaming(ev);
      break;
    }
    default:
      break;
  }
}

// 任务通知(常规设置):回复完成/出错且窗口不在前台 → 系统通知(声音由主进程按配置决定)
function notifyTaskDone(convId, ev, kind) {
  const g = (state.config && state.config.general) || {};
  if (g.taskNotify === false) return;
  if (ev.aborted || document.hasFocus()) return; // 用户手动停止、或窗口在前台(应用内已可见)时不打扰
  const cv = (state.convs || []).find((x) => x.id === convId);
  const title = 'LiteAgent · ' + ((cv && cv.title) || t('新对话'));
  const body = kind === 'error' ? String(ev.message || (isZhLang() ? '回复出错' : 'Reply failed')).slice(0, 160) : (isZhLang() ? '回复已完成' : 'Reply finished');
  liteapi.invoke('app:notify', { title, body }).catch(() => {});
}

async function finishStreaming(ev, kind) {
  const S = state.streams.get(ev.convId);
  if (!S) return;
  termSpinStop(); // 流结束(done/error)统一收掉精简模式 spinner
  // 流结束:刷新侧栏(状态色从 进行中 落到 完成/异常 定格;conv-streaming 指示收掉)
  state.streams.delete(ev.convId);
  refreshConvs().then(() => { renderSidebar(); if (term.active) renderTermTabs(); }).catch(() => {});
  // 重拉会话:工具步数等由 messages 统计的量在 done 后即时正确(不必切走切回)
  liteapi.invoke('convs:get', ev.convId).then((c) => {
    if (c && state.conv && state.conv.id === c.id) { state.conv = c; renderUsageBar(); }
  }).catch(() => {});
  if (ev.model && S.whoModelEl) { S.whoModelEl.textContent = ev.model; S.whoModelEl = null; }
  // 后台会话:turnEl/text 均已复位为 null,这里只做收尾;可见会话才需要 DOM 收尾
  if (S.reasoning && !S.reasoning.finalized) {
    S.reasoning.finalized = true;
    S.reasoning.el.removeAttribute('open');
    $('.reasoning-body', S.reasoning.el).textContent = S.reasoning.raw || '(空)';
  }
  if (S.text && !S.text.finalized) {
    if (!term.active) renderMd(S.text.el, S.text.raw, false);
    S.text.finalized = true;
  }
  if (state.conv && state.conv.id === S.convId) {
    refreshSearch(); // 流式重渲会清掉 mark,收尾后重建
    termFinish(ev);
  }
  if (S.durTimer) { clearInterval(S.durTimer); S.durTimer = null; }
  if (S.durEl) {
    S.durEl.classList.remove('live');
    S.durEl.classList.add(ev.aborted ? 'aborted' : 'done');
    S.durEl.textContent = (ev.aborted ? '○ ' : '✓ ') + fmtDurZh(ev.ms);
    S.durEl = null;
  }
  // 回写内存中的当前会话消息(重绘时徽章由 durationMs 驱动)
  if (ev.ms && state.conv && state.conv.id === S.convId) {
    const msgs = state.conv.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { msgs[i].durationMs = msgs[i].durationMs || ev.ms; break; }
    }
  }
  if (S.turnEl) {
    const meta = document.createElement('div');
    meta.className = 'turn-meta';
    const bits = [];
    if (ev.aborted) bits.push('已停止');
    if (ev.ms) bits.push(fmtMs(ev.ms));
    const u = fmtUsage(ev.usage);
    if (u) bits.push(u);
    meta.textContent = bits.join(' · ');
    S.turnEl.appendChild(meta);
    // 回复完成:立即挂"重新生成"操作行(分支切换器在重绘后出现)
    const actions = turnActionsEl({ id: S.convId, messages: [{ role: 'assistant' }] }, 0);
    if (actions) S.turnEl.appendChild(actions);
  }
  if (S.durTimer) { clearInterval(S.durTimer); S.durTimer = null; }
  if (S.durEl) { S.durEl.classList.remove('live'); S.durEl.classList.add('aborted'); S.durEl = null; }
  state.streams.delete(S.convId);
  if (state.conv && state.conv.id === S.convId) setSendMode('send');
  notifyTaskDone(S.convId, ev, kind);
  renderSidebar();
  refreshConvs();
  // 与落盘数据同步;分支重试完成后旧回复已收进变体,需重绘为"当前分支 + 切换器"
  liteapi.invoke('convs:get', S.convId).then((c) => {
    if (c && state.conv && state.conv.id === c.id) {
      state.conv = c;
      if (S.branchRetry) renderConv(c);
    }
  });
  maybeScroll();
}

/* ================= 发送 ================= */
function currentModel() {
  const lm = state.config.lastModel;
  if (lm && lm.providerId && lm.model) return lm;
  return null;
}

async function ensureConvMirror() {
  if (!state.conv) {
    state.conv = {
      id: uid(),
      groupId: state.pendingGroupId || 'default',
      title: '新对话',
      messages: [],
    };
    renderUsageBar(); // 新会话首条消息:用量条立即归零重画(不留上一会话残留,v0.50.1)
  }
  return state.conv;
}

/* ================= 附件(图片/文件)采集 =================
   渲染端用 FileReader 读取(沙箱内、不碰文件路径),主进程 normalizeIncoming 做权威校验;
   这里的预检只决定 UX 提示,与主进程白名单保持一致(改动需同步 src/main/attachments.js)。 */
const ATTACH_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ATTACH_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const ATTACH_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'ini', 'toml',
  'cfg', 'conf', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs',
  'go', 'rs', 'sql', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'psm1', 'vue', 'svelte', 'astro',
  'dart', 'lua', 'pl', 'r', 'gitignore', 'editorconfig', 'env',
  'shader', 'cginc', 'hlsl', 'glsl', 'asmdef', 'unity', 'prefab', 'asset', 'meta', 'uxml', 'uss',
]);
const ATTACH_MAX_IMAGE = 10 * 1024 * 1024;
const ATTACH_MAX_TEXT = 1024 * 1024;
const ATTACH_MAX_COUNT = 8;
const ATTACH_ACCEPT = [...ATTACH_IMAGE_MIMES, ...ATTACH_IMAGE_EXTS, ...ATTACH_TEXT_EXTS]
  .map((x) => (x.includes('/') ? x : '.' + x)).join(',');

function attachKindOf(name, mime) {
  const m = String(mime || '').toLowerCase();
  const base = String(name || '').split('.').pop().toLowerCase();
  if (ATTACH_IMAGE_MIMES.includes(m) || ATTACH_IMAGE_EXTS.includes(base)) return 'image';
  if (base && ATTACH_TEXT_EXTS.has(base)) return 'text';
  if (m.startsWith('text/')) return 'text';
  return null;
}

function readAttachment(file) {
  return new Promise((resolve) => {
    const kind = attachKindOf(file.name, file.type);
    if (!kind) { toast(`「${file.name}」不是支持的类型(仅图片与文本文件)`); return resolve(null); }
    if (kind === 'image' && file.size > ATTACH_MAX_IMAGE) { toast(`「${file.name}」超过图片大小上限(10MB)`); return resolve(null); }
    if (kind === 'text' && file.size > ATTACH_MAX_TEXT) { toast(`「${file.name}」超过文件大小上限(1MB)`); return resolve(null); }
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: uid(),
      name: file.name || (kind === 'image' ? '图片.png' : '文件.txt'),
      mime: file.type || (kind === 'image' ? 'image/png' : 'text/plain'),
      kind,
      size: file.size,
      ...(kind === 'image' ? { dataUrl: String(reader.result) } : { text: String(reader.result) }),
    });
    reader.onerror = () => { toast(`「${file.name}」读取失败`); resolve(null); };
    if (kind === 'image') reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

async function addAttachFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  let added = 0;
  for (const f of files) {
    if (state.pendingAttachments.length >= ATTACH_MAX_COUNT) {
      toast(`附件最多 ${ATTACH_MAX_COUNT} 个`);
      break;
    }
    const a = await readAttachment(f);
    if (a) { state.pendingAttachments.push(a); added++; }
  }
  renderAttachBar();
  // 精简模式没有输入区附件条,给一行终端反馈(否则拖拽看起来没反应)
  if (added && document.body.classList.contains('pure-terminal')) {
    termLine('at-meta', null, `📎 已添加 ${added} 个附件(发送消息时一并发出,可在输入框上方移除)`);
  }
}

function renderAttachBar() {
  const bar = $('#attach-bar');
  bar.innerHTML = '';
  if (!state.pendingAttachments.length) { bar.classList.add('hidden'); renderTermAttachBar(); return; }
  bar.classList.remove('hidden');
  state.pendingAttachments.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'attach-pending';
    if (a.kind === 'image' && a.dataUrl) {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      item.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.className = 'attach-pending-name';
      span.textContent = `📄 ${a.name}`;
      span.title = a.name;
      item.appendChild(span);
    }
    const size = document.createElement('span');
    size.className = 'attach-pending-size';
    size.textContent = fmtBytes(a.size);
    item.appendChild(size);
    const x = document.createElement('button');
    x.className = 'attach-remove';
    x.type = 'button';
    x.textContent = '×';
    x.title = '移除附件';
    x.dataset.idx = String(i);
    item.appendChild(x);
    bar.appendChild(item);
  });
  renderTermAttachBar();
}

// 精简模式附件条(输入框上方):与标准输入区共用 state.pendingAttachments
function renderTermAttachBar() {
  const bar = $('#at-attach-bar');
  if (!bar) return;
  if (!state.pendingAttachments.length) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  let html = '';
  for (let i = 0; i < state.pendingAttachments.length; i++) {
    const a = state.pendingAttachments[i];
    const thumb = a.kind === 'image' && a.dataUrl
      ? `<img src="${a.dataUrl}" alt="">`
      : '<span class="at-attach-ico">📄</span>';
    html += `<div class="at-attach" title="${escapeHtml(a.name)}">${thumb}<span class="at-attach-name">${escapeHtml(a.name)}</span><button type="button" class="at-attach-x" data-idx="${i}" title="移除附件">✕</button></div>`;
  }
  bar.innerHTML = html;
  for (const b of $$('.at-attach-x', bar)) {
    b.addEventListener('click', () => {
      state.pendingAttachments.splice(parseInt(b.dataset.idx, 10), 1);
      renderAttachBar();
    });
  }
}

// /img 直连生图(v0.50.0):绕过文字模型,结果直接以 AI 消息卡片落会话
async function submitImageGen(prompt) {
  const ig = (state.config && state.config.imageGen) || {};
  if (!ig.enabled || !ig.providerId || !ig.model) { toast(t('图片生成未启用:设置 → 模型 → 图片生成')); return; }
  const conv = await ensureConvMirror();
  const userMsg = { role: 'user', content: `/img ${prompt}` };
  conv.messages.push(userMsg);
  appendUserBubble(userMsg);
  const turn = { role: 'assistant', blocks: [{ type: 'model-switch', model: `${t('图片生成')}/${ig.model}` }], model: `${t('图片生成')}/${ig.model}` };
  conv.messages.push(turn);
  // 「图片生成中…」占位(v0.50.1):生图可能要几十秒,先给状态再替换
  const pending = { role: 'assistant', blocks: [{ type: 'image-pending', model: ig.model }] };
  conv.messages.push(pending);
  if (state.conv && state.conv.id === conv.id) renderConv(conv);
  maybeScroll(true);
  try {
    const imgs = await liteapi.invoke('imagegen:generate', { prompt });
    for (const im of imgs) turn.blocks.push({ type: 'image', mime: im.mime, base64: im.base64 });
    conv.messages.pop(); // 移除占位
    await liteapi.invoke('chat:saveNote', { convId: conv.id, note: turn }); // 生图结果落盘(重开不丢)
    renderUsageBar(); // 会话用量变化,即时重画(v0.51.7)
    await liteapi.invoke('chat:saveNote', { convId: conv.id, note: { role: 'assistant', blocks: [] } }); // 占位撤回同步到盘(空块消息清理由重绘自然忽略)
    await refreshConvs();
    if (state.conv && state.conv.id === conv.id) { state.conv = conv; renderConv(conv); }
    maybeScroll(true);
    toast(`${t('已生成')} ${imgs.length} ${t('张图片')}`);
  } catch (e) {
    conv.messages.splice(conv.messages.indexOf(pending), 1);
    conv.messages.pop(); // 失败:占位与空 turn 都撤回
    await liteapi.invoke('chat:saveNote', { convId: conv.id, note: { role: 'assistant', blocks: [{ type: 'text', content: `⚠ ${t('图片生成失败')}: ${String(e && e.message || e).slice(0, 100)}` }] } }); // 失败也留痕
    await refreshConvs();
    if (state.conv && state.conv.id === conv.id) { state.conv = conv; renderConv(conv); }
    toast(String(e && e.message || e).slice(0, 160));
  }
}

async function submit(overrideText) {
  const input = $('#input');
  const _sp = document.getElementById('input-slash-pop');
  if (_sp) _sp.classList.add('hidden'); // 提交即收起命令弹层(v0.51.4)
  const rawText = (overrideText != null ? overrideText : input.value).trim();
  if (/^\/img\s+/i.test(rawText)) {
    const prompt = rawText.replace(/^\/img\s+/i, '').trim();
    if (overrideText == null) { input.value = ''; autosize(input); }
    await submitImageGen(prompt);
    return;
  }
  // /handover 对话ID(v0.52.0):把旧对话上下文直接发给当前对话(接手/修复)
  const hoMatch = rawText.match(/^\/handover\s+(\S+)/i);
  if (hoMatch) {
    if (overrideText == null) { input.value = ''; autosize(input); }
    const old = await liteapi.invoke('convs:get', hoMatch[1]).catch(() => null);
    if (!old) { toast(t('找不到该对话') + ': ' + hoMatch[1]); return; }
    await submit(handoverText(old));
    return;
  }
  const text = rawText;
  if (!text && !state.pendingAttachments.length) return;
  if (!currentModel()) {
    toast('请先在设置中配置模型服务并选择模型');
    openSettings();
    return;
  }
  const conv = await ensureConvMirror();
  if (state.streams.has(conv.id)) { toast('本会话正在回复中,可先停止或稍候'); return; }
  if (overrideText == null) { input.value = ''; autosize(input); updateSkillBarVisibility(); }
  const atts = state.pendingAttachments.slice();
  state.pendingAttachments = [];
  renderAttachBar();
  const userMsg = { role: 'user', content: text, ...(atts.length ? { attachments: atts } : {}) };
  conv.messages.push(userMsg);
  appendUserBubble(userMsg);
  state.pendingGroupId = null;
  startStreaming(conv.id, { userText: text, attachments: atts });
}

function retryLast() {
  if (!state.conv || !currentModel()) return;
  if (state.streams.has(state.conv.id)) { toast('本会话正在回复中'); return; }
  // 重试 = 生成新分支:旧回复保留为变体,完成后可用回复下方的 ‹ n/n › 切换
  startStreaming(state.conv.id, { retry: true, branch: true });
}

// 回复下方操作行:重新生成(新分支)+ 分支切换器(该消息存在多个变体时)
// 复制整条回复的纯文本(跨 blocks 拼接,markdown 源文)
function assistantTextOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string' && m.content) return m.content;
  return (m.blocks || []).map((b) => (b.type === 'text' ? b.content : b.type === 'reasoning' ? '' : '')).filter(Boolean).join('\n\n');
}

function turnActionsEl(conv, idx) {
  const m = conv.messages[idx];
  if (!m || m.role !== 'assistant') return null;
  const row = document.createElement('div');
  row.className = 'turn-actions';
  // 复制(参考图:Claude 式双小方框图标)
  const copy = document.createElement('button');
  copy.className = 'ta-btn ta-ico';
  copy.title = '复制';
  copy.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copy.addEventListener('click', () => {
    const txt = assistantTextOf(m);
    navigator.clipboard.writeText(txt).then(() => {
      copy.classList.add('done');
      toast('已复制');
      setTimeout(() => copy.classList.remove('done'), 1200);
    }).catch(() => toast('复制失败'));
  });
  row.appendChild(copy);
  // 分支为新对话(参考图:方框+斜箭头图标)
  const fork = document.createElement('button');
  fork.className = 'ta-btn ta-ico';
  fork.title = '以当前分支开启新对话';
  fork.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  fork.addEventListener('click', async () => {
    const forked = await liteapi.invoke('conv:fork', { convId: conv.id, index: idx }).catch(() => null);
    if (!forked) { toast('分支创建失败'); return; }
    await refreshConvs();
    await openConv(forked.id);
    toast('已在新对话中打开该分支');
  });
  row.appendChild(fork);
  const regen = document.createElement('button');
  regen.className = 'ta-btn';
  regen.textContent = '🔄 重新生成';
  regen.title = '生成新分支(当前回复保留,可切换回看)';
  regen.addEventListener('click', () => retryLast());
  row.appendChild(regen);
  if (Array.isArray(m.variants) && m.variants.length) {
    const total = m.variants.length + 1;
    let pos = Number.isInteger(m.pos) ? m.pos : m.variants.length;
    if (pos < 0 || pos >= total) pos = total - 1;
    const prev = document.createElement('button');
    prev.className = 'ta-btn ta-nav';
    prev.textContent = '‹';
    prev.title = '上一个分支';
    const label = document.createElement('span');
    label.className = 'ta-label';
    label.textContent = `${pos + 1}/${total}`;
    const next = document.createElement('button');
    next.className = 'ta-btn ta-nav';
    next.textContent = '›';
    next.title = '下一个分支';
    const sw = (d) => liteapi.invoke('conv:switchBranch', { convId: conv.id, index: idx, dir: d }).then((c) => {
      if (c) { state.conv = c; renderConv(c); }
    });
    prev.addEventListener('click', () => sw(-1));
    next.addEventListener('click', () => sw(1));
    row.appendChild(prev);
    row.appendChild(label);
    row.appendChild(next);
  }
  return row;
}

function startStreaming(convId, extra) {
  const streamId = uid();
  const sel = currentModel();
  const S = {
    streamId, convId,
    turnEl: null, text: null, reasoning: null,
    tools: new Map(),
    asks: new Map(),
    buffer: [], // 后台期间的事件缓冲,切回时重放
    branchRetry: !!(extra && extra.branch && extra.retry), // 分支重试:完成后旧回复收进变体,需重绘
  };
  state.streams.set(convId, S);
  if (state.conv && state.conv.id === convId) setSendMode('stop');
  $('#status-hint').textContent = `${MODE_DESC[state.config.ui.mode] || ''}`;
  renderSidebar(); // 会话列表加"进行中"指示
  liteapi.invoke('chat:send', {
    streamId,
    convId,
    providerId: sel.providerId,
    model: sel.model,
    mode: state.config.ui.mode || 'chat',
    agentMode: (state.config.ui.mode || 'chat') !== 'chat',
    reasonLevel: (state.config.ui.mode || 'chat') === 'chat' ? null : (state.reasonValue ?? null),
    assistantId: state.config.ui.activeAssistantId || 'default',
    skillId: state.config.ui.activeSkillId,
    groupId: (state.conv && state.conv.id === convId ? state.conv.groupId : (extra && extra.groupId)) || 'default',
    ...extra,
  }).catch((e) => {
    toast(e.message || '发送失败');
    if (S.durTimer) { clearInterval(S.durTimer); S.durTimer = null; }
    if (state.streams.get(convId) === S) state.streams.delete(convId);
    if (state.conv && state.conv.id === convId) setSendMode('send');
    renderSidebar();
  });
}

function abortStreaming() {
  const S = state.conv ? state.streams.get(state.conv.id) : null;
  if (!S) return;
  liteapi.invoke('chat:abort', S.streamId);
  // 本地立即停止:不等主进程回执,按钮和界面马上恢复可用
  // (主进程随后会中止请求、按轮落盘,其迟到事件因 streamId 隔离不会串入)
  finishStreaming({ convId: S.convId, ms: 0, usage: null, aborted: true });
}

/* ================= 发送/停止按钮 ================= */
const SVG_SEND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const SVG_STOP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function setSendMode(mode) {
  const btn = $('#btn-send');
  if (mode === 'stop') {
    btn.innerHTML = SVG_STOP;
    btn.classList.add('stop-mode');
    btn.title = t('停止生成');
  } else {
    btn.innerHTML = SVG_SEND;
    btn.classList.remove('stop-mode');
    btn.title = t('发送 (Enter)');
  }
}

/* ================= 助手与技能 ================= */
function currentAssistant() {
  const id = state.config.ui.activeAssistantId || 'default';
  return (state.config.assistants || []).find((a) => a.id === id) || { id: 'default', name: '默认助手', icon: '🤖', prompt: '' };
}

function currentSkill() {
  const id = state.config.ui.activeSkillId;
  if (!id) return null;
  return (state.config.skills || []).find((s) => s.id === id) || null;
}

function fillAssistantSelect() {
  const sel = $('#assistant-select');
  sel.innerHTML = '';
  const list = state.config.assistants || [];
  if (!list.length) { sel.appendChild(new Option(t('默认助手'), 'default')); }
  for (const a of list) sel.appendChild(new Option(`${a.icon || '🤖'} ${t(a.name)}`, a.id));
  const activeId = list.some((a) => a.id === state.config.ui.activeAssistantId)
    ? state.config.ui.activeAssistantId : 'default';
  state.config.ui.activeAssistantId = activeId;
  sel.value = activeId;
}

// 技能栏可见性(v0.49.6):默认隐藏,输入含 @ 时呼出;提交/清空后收回
let skillBarPinned = false; // 点选技能后短暂钉住,避免抹掉 @ 时立即消失打断点击
function updateSkillBarVisibility() {
  const bar = $('#skill-bar');
  if (!bar) return;
  const input = $('#input');
  const folded = !!(state.config.ui && state.config.ui.composerFold);
  const show = !folded && (skillBarPinned || (!!input && /(^|\s)@/.test(input.value)));
  bar.style.display = show ? '' : 'none';
  if (state.config.ui.composerFold) applyComposerFold();
}

function renderSkillBar() {
  const bar = $('#skill-bar');
  const skills = state.config.skills || [];
  if (!skills.length) { bar.innerHTML = ''; bar.style.display = 'none'; if (state.config.ui.composerFold) applyComposerFold(); return; }
  bar.style.display = 'none'; // 默认隐藏,@ 呼出(updateSkillBarVisibility)
  bar.innerHTML = skills.map((s) => {
    const active = state.config.ui.activeSkillId === s.id;
    return `<button class="skill-chip ${active ? 'active' : ''}" data-id="${s.id}" title="${s.agent ? '建议配合智能体模式使用\n' : ''}${escapeHtml(s.prompt || '')}">${s.icon || '⚡'} ${escapeHtml(t(s.name))}${s.agent ? ' <span class="skill-agent-badge">⚙</span>' : ''}</button>`;
  }).join('');
  if (state.config.ui.composerFold) applyComposerFold();
}

function toggleSkill(id) {
  skillBarPinned = true;
  setTimeout(() => { skillBarPinned = false; updateSkillBarVisibility(); }, 1500);
  const s = (state.config.skills || []).find((x) => x.id === id);
  if (!s) return;
  const activating = state.config.ui.activeSkillId !== id;
  state.config.ui.activeSkillId = activating ? id : null;
  liteapi.invoke('config:set', { ui: { activeSkillId: state.config.ui.activeSkillId } });
  renderSkillBar();
  if (activating) {
    if (s.agent && state.config.ui.mode === 'chat') toast('该技能需要调用工具,建议切换到 受限/完全 模式');
    if (s.insert && !$('#input').value) {
      const input = $('#input');
      input.value = s.insert;
      autosize(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    toast(`技能「${s.name}」已启用(再次点击关闭)`);
  }
}

/* ================= 输入框上排折叠 ================= */
function composerMiniText() {
  const lm = state.config.lastModel;
  const model = lm ? lm.model : '';
  const box = $('#reason-slider');
  let reason = '';
  if (box && box.dataset.none !== '1' && state.reasonValue != null) {
    reason = '🧠' + (typeof state.reasonValue === 'number' ? t('自定义') + '(' + state.reasonValue + ')' : t(REASON_LABEL[state.reasonValue] || state.reasonValue));
  }
  const skills = (state.config.skills || []).length ? `· 技能${state.config.skills.length}` : '';
  return `🎛 ${model} ${reason} ${skills}`.replace(/\s+/g, ' ').trim();
}

// 滑块放置(v0.54.2 起滑块内嵌模型弹层,历史"靠左/居中/靠右"对齐设置不再有布局效果;保留函数兼容调用点)
function placeReasonSlider() { /* 滑块已内嵌 #mc-pop,无自由放置面 */ }

function applyComposerFold() {
  // v0.54.2:composer 头行移除(模型胶囊进底部栏),折叠仅剩技能栏可见性收敛
  updateSkillBarVisibility();
}

function toggleComposerFold() {
  state.config.ui.composerFold = !state.config.ui.composerFold;
  liteapi.invoke('config:set', { ui: { composerFold: state.config.ui.composerFold } });
  applyComposerFold();
}

/* ================= 推理强度(滑块) ================= */
const REASON_LABEL = {
  minimal: '极简', none: '关闭', off: '关闭', low: '低', medium: '中',
  high: '高', xhigh: '超高', max: '最大', dynamic: '动态', on: '深度推理', custom: '自定义预算…',
};

// 滑块位置与状态:idx 按档位序号;填充语义(参考 Z.ai 三态):低=空槽,中/高=绿色实心推进,最高=整条渐变铺满+星光
function paintReasonSlider(box, idx) {
  const stops = $$('.rs-stop', box);
  if (!stops.length) return;
  const last = stops.length - 1;
  const pct = last > 0 ? (idx / last) * 100 : 100;
  const fill = $('.rs-fill', box);
  if (fill) fill.style.width = pct + '%';
  $('.rs-thumb', box).style.left = pct + '%';
  const flame = $('.rs-flame', box);
  if (flame) flame.style.left = pct + '%';
  stops.forEach((s, i) => s.classList.toggle('active', i === idx));
  box.classList.toggle('at-max', idx === last && stops.length > 1);
  // 弹层头部 + 胶囊上的实时档位文本(拖动时预览,松手提交后一致)
  const lv = Array.isArray(box._rsLevels) ? box._rsLevels[Math.min(idx, last)] : null;
  const txt = lv == null ? '—' : (typeof lv === 'number' ? t('自定义预算') : t(REASON_LABEL[lv] || lv));
  const head = $('#mc-rlevel');
  if (head) head.textContent = txt;
  const head2 = $('#mp2-rlevel');
  if (head2) head2.textContent = txt;
  updateModelPill(txt);
}

async function fillReasonSelect() {
  const box = $('#reason-slider');
  if (!box) return;
  const gen = ++state.reasonGen; // 代际守卫:并发调用只让最新一次生效
  const lm = state.config.lastModel;
  if (!lm) {
    box.innerHTML = '';
    box.dataset.none = '1';
    box.dataset.ready = '0';
    state.reasonRenderKey = null;
    state.reasonValue = null;
    updateModelPill('—');
    return;
  }
  const key = lm.providerId + '::' + lm.model;
  const saved = state.config.reasonChoice && state.config.reasonChoice[key];
  // 能力查询缓存:同一模型不重复跨进程查询
  let caps = state.reasonCapsCache.get(key);
  if (caps === undefined) {
    caps = await liteapi.invoke('reason:caps', { model: lm.model, providerId: lm.providerId }).catch(() => null);
    if (state.reasonGen !== gen) return; // 已有更新的调用,丢弃过期结果
    if (caps) state.reasonCapsCache.set(key, caps);
  }
  box.dataset.none = '0';
  if (!caps || !caps.levels || !caps.levels.length) {
    // 常显:让用户知道该模型没有推理档位,而不是神秘消失
    // unknown = 内置规则与官方库都查无此模型(≠确认不支持);提示可手动指定
    const msg = caps && caps.unknown ? t('未识别该模型的推理能力(按默认方式发送,可在 供应商编辑器 手动指定)') : t('该模型不支持推理');
    box.innerHTML = `<span class="rs-plain">🧠 ${msg}</span>`;
    box.dataset.ready = '0';
    state.reasonRenderKey = key + '|unsupported';
    state.reasonValue = null;
    updateModelPill('—');
    return;
  }
  state.reasonCaps = caps;
  const levels = caps.levels.filter((lv) => lv !== 'custom'); // custom = 预算模式,在设置 → 模型 的模型行配置
  // 自定义预算:对话框只读展示状态章,输入在 设置 → 模型 的模型行预算输入框
  if (typeof saved === 'number') {
    const budgetKey = key + '|budget|' + saved;
    state.reasonValue = saved;
    if (!(state.reasonRenderKey === budgetKey && box.dataset.ready === 'budget')) {
      state.reasonRenderKey = budgetKey;
      box.dataset.ready = 'budget';
      box.dataset.none = '0';
      box.innerHTML = `<span class="rs-plain" title="${t('在 设置 → 模型 对应模型行的「预算」输入框修改;清空后跟随档位滑块')}">🧠 ${t('自定义预算')} ${saved} tokens</span>`;
      updateModelPill(t('自定义预算'));
    }
    return;
  }
  if (box.dataset.ready === 'budget') { box.dataset.ready = '0'; } // 从预算章切回滑块需强制重建
  state.reasonValue = levels.includes(saved)
    ? saved
    : (levels.includes(caps.defaultLevel) ? caps.defaultLevel : levels[0]);

  const savedStr = String(saved || '');
  const renderKey = key + '|' + savedStr + '|' + caps.style + '|' + caps.levels.join(',');
  const domOk = box.dataset.ready === '1'
    && box.dataset.key === key
    && box.querySelectorAll('.rs-stop').length === levels.length;
  if (renderKey === state.reasonRenderKey && domOk) {
    // 无变化且 DOM 完好则只重定位(重复触发不再闪烁);DOM 异常时走下方重建自愈
    paintReasonSlider(box, levels.indexOf(typeof state.reasonValue === 'number' ? levels[levels.length - 1] : state.reasonValue));
    return;
  }
  state.reasonRenderKey = renderKey;

  if (levels.length < 2) {
    // 单档:状态章即可,滑块无意义;逐模型手动配置的单档 = 已锁定
    const locked = caps.source === 'manual' ? '(已锁定)' : '';
    box.dataset.ready = '0';
    box.innerHTML = `<span class="rs-plain" title="${caps.source === 'manual' ? t('档位已由 设置 → 模型 的逐模型配置锁定') : ''}">🧠 ${t(REASON_LABEL[levels[0]] || '深度推理')}${locked}</span>`;
    updateModelPill(t(REASON_LABEL[levels[0]] || levels[0]));
    return;
  }

  box.dataset.key = key;
  box.dataset.ready = '1';
  box._rsLevels = levels;
  box.innerHTML = `
    <div class="rs-track">
      <div class="rs-fill"></div>
      ${levels.map((lv, i) => {
        const pct = levels.length > 1 ? (i / (levels.length - 1)) * 100 : 100;
        return `<span class="rs-stop" data-lv="${lv}" title="${t(REASON_LABEL[lv] || lv)}" style="left:${pct}%"></span>`;
      }).join('')}
      <span class="rs-spark s1">✦</span><span class="rs-spark s2">✦</span><span class="rs-spark s3">✦</span><span class="rs-spark s4">✦</span><span class="rs-spark s5">✦</span>
      <div class="rs-thumb"></div>
      <span class="rs-flame">✦</span>
    </div>`;

  const commit = async (lv) => {
    state.reasonValue = lv;
    const rc = { ...(state.config.reasonChoice || {}), [key]: lv };
    state.config = await liteapi.invoke('config:set', { reasonChoice: rc });
    paintReasonSlider(box, levels.indexOf(lv));
    applyComposerFold();
    toast(`${t('推理强度已设为:')}${t(REASON_LABEL[lv] || lv)}${t('(按模型记忆)')}`);
  };
  box._rsCommit = commit; // 供 /reason 元命令复用(v0.51.2)
  $$('.rs-stop', box).forEach((s) => s.addEventListener('click', () => commit(s.dataset.lv)));
  // 拖拽:吸附最近档位,松手提交
  const track = $('.rs-track', box);
  const idxFrom = (ev) => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    return Math.round(ratio * (levels.length - 1));
  };
  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { track.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    paintReasonSlider(box, idxFrom(e));
  });
  track.addEventListener('pointermove', (e) => { if (dragging) paintReasonSlider(box, idxFrom(e)); });
  track.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    commit(levels[Math.min(levels.length - 1, Math.max(0, idxFrom(e)))]);
  });
  track.addEventListener('pointercancel', () => {
    dragging = false;
    paintReasonSlider(box, levels.indexOf(typeof state.reasonValue === 'number' ? levels[levels.length - 1] : state.reasonValue));
  });
  paintReasonSlider(box, levels.indexOf(typeof state.reasonValue === 'number' ? levels[levels.length - 1] : state.reasonValue));
  if (!box.querySelectorAll('.rs-stop').length) {
    box.dataset.none = '1'; // 自愈:DOM 异常时隐藏并允许下次重建
    box.dataset.ready = '0';
    state.reasonRenderKey = null;
  }
}

/* ================= 用量条 ================= */
// 对话条用时:38秒 / 1分48秒 / 1时2分03秒(中文格式;用量面板的 fmtDur 为英文短格式,互不影响)
function fmtDurZh(ms) {
  const sec = Math.max(0, Math.round((ms || 0) / 1000));
  if (sec < 60) return sec + '秒';
  if (sec < 3600) return Math.floor(sec / 60) + '分' + String(sec % 60).padStart(2, '0') + '秒';
  return Math.floor(sec / 3600) + '时' + Math.floor((sec % 3600) / 60) + '分';
}

const fmtTok = (n) => {
  n = n || 0;
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
};

const SVG_CLOCK = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6" cy="6" r="4.6"/><path d="M6 3.4V6l1.8 1.2" stroke-linecap="round"/></svg>';
const SVG_DB = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><ellipse cx="6" cy="2.8" rx="4.2" ry="1.6"/><path d="M1.8 2.8v6.4c0 .9 1.9 1.6 4.2 1.6s4.2-.7 4.2-1.6V2.8"/><path d="M1.8 6c0 .9 1.9 1.6 4.2 1.6s4.2-.7 4.2-1.6"/></svg>';

// 大数格式化:2.4K / 353M(截图样式,一位小数去掉 .0)
const fmtBig = (n) => {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1e6) { const v = (n / 1e6).toFixed(1); return (v.endsWith('.0') ? v.slice(0, -2) : v) + 'M'; }
  if (n >= 1000) { const v = (n / 1000).toFixed(1); return (v.endsWith('.0') ? v.slice(0, -2) : v) + 'K'; }
  return String(n);
};

// 中文数量级:51.8万 / 100万 / 3.2亿(zh 界面用;en/tw 走 fmtBig)
function fmtWan(n) {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1e8) { const v = n / 1e8; return (Number.isInteger(v) ? v : v.toFixed(1)) + '亿'; }
  if (n >= 1e4) { const v = n / 1e4; return (v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1)))) + '万'; }
  return String(n);
}
const isZhUi = () => (window.I18N ? window.I18N.getLang() === 'zh-CN' : true);

// 底部用量条:恒为紧凑一行;usageBarStyle(外观设置)决定悬停/点击圆环时弹出的明细样式
function renderUsageBar() {
  const bar = $('#usage-bar');
  if (!bar) return;
  const g = state.config.usage || {};
  if (!state.conv && !g.requests) { bar.innerHTML = ''; return; }
  renderUsageCompact(bar);
}

function renderUsageCompact(bar) {
  const g = state.config.usage || {};
  const cu = (state.conv && state.conv.usage) || null;
  const cx = (state.conv && state.conv.ctx) || null;

  // 左段:轮(会话 LLM 轮次)/ 步(工具调用步数)/ tok/s(全局输出速度)
  const turns = (cu && cu.requests) || 0;
  const steps = state.conv && Array.isArray(state.conv.messages)
    ? state.conv.messages.reduce((a, m) => a + ((m.blocks || []).filter((b) => b.type === 'tool').length), 0) : 0;
  // v0.57.6:输出速度只用「正文口径」(g.tps: 已剔除思考 tokens、只算有正文的轮次)
  const tps = g.tps && g.tps.ms > 0 ? Math.round((g.tps.tokens || 0) / (g.tps.ms / 1000)) : 0;
  let seg1 = `<span class="ub-seg">${SVG_CLOCK}<b>${turns}</b> ${t('轮')}${steps ? ` <b>${steps}</b> ${t('步')}` : ''}${tps > 0 ? ` · <b>${tps >= 10000 ? fmtBig(tps) : tps}</b> tok/s` : ''}</span>`;

  // 中段:本会话累计 token + 会话缓存命中(新会话从 0 起;全局累计在悬停/点击弹层明细里,防"新会话显示大数字"误导)
  const sessTok = ((cu && cu.prompt) || 0) + ((cu && cu.completion) || 0);
  const sessHit = cu && cu.prompt > 0 && cu.cached > 0 ? Math.round((cu.cached / cu.prompt) * 100) : null;
  let seg2 = `<span class="ub-seg">${SVG_DB}<b>${fmtBig(sessTok)}</b> tok${sessHit != null ? ` · ${t('缓存命中')} <b>${sessHit}%</b>` : ''}</span>`;

  // 右段:上下文圆环(点击弹构成明细)
  const used = (cx && cx.tokens) || 0;
  const ring = ctxRingSvg(0);
  let seg3 = `<button id="ctx-ring-btn" title="${t('上下文已用')}">${ring}<span id="ctx-ring-label">${used ? fmtBig(used) : '0%'}</span></button>`;

  bar.innerHTML = seg1 + `<span class="ub-sep"></span>` + seg2 + `<span class="ub-sep"></span>` + seg3;
  const segEls = bar.querySelectorAll('.ub-seg');
  if (segEls[0]) bindUbPop(segEls[0], openStatsPop);   // 🕐 会话统计
  if (segEls[1]) bindUbPop(segEls[1], openTokensPop);  // 🗄 Token 用量
  const btn = $('#ctx-ring-btn');
  if (btn) bindUbPop(btn, openRingPop);                // ◎ 上下文(按外观样式)
  updateTermStatus(); // 用量事件到达时同步终端状态栏(上下文占用)
}

/* ---- 用量条弹出层(v0.47:悬停/点击三处通用,点击 = 置顶,悬停离开即关) ---- */
let ubPopState = null; // { el, anchor, pinned, closer }

function closeUbPop() {
  if (!ubPopState) return;
  try { document.removeEventListener('click', ubPopState.closer); } catch (_) { /* ignore */ }
  ubPopState.el.remove();
  ubPopState.anchor.classList.remove('open');
  ubPopState = null;
}

function openUbPop(anchor, html, pinned, left) {
  closeUbPop();
  const pop = document.createElement('div');
  pop.className = 'ub-pop' + (left ? ' ub-pop-left' : '');
  pop.innerHTML = html;
  anchor.appendChild(pop);
  anchor.classList.add('open');
  if (pinned) anchor.dataset.pinned = '1';
  // 定位微调(v0.49.4):弹层现在锚定在点击段上,但仍可能越出窗口 ——
  // 超出右缘 → 改为右对齐段;超出左缘 → 改回左对齐。居中条两端段都会触发。
  const r = pop.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  if (r.right > vw - 8 && left) { pop.classList.remove('ub-pop-left'); }
  else if (r.left < 8 && !left) { pop.classList.add('ub-pop-left'); }
  if (pop.getBoundingClientRect().bottom < 0) pop.style.bottom = 'auto', pop.style.top = 'calc(100% + 8px)';
  const closer = (e) => {
    if (ubPopState && (pop.contains(e.target) || anchor.contains(e.target))) return;
    closeUbPop();
    document.removeEventListener('click', closer);
  };
  setTimeout(() => document.addEventListener('click', closer), 0);
  ubPopState = { el: pop, anchor, pinned: !!pinned, closer };
  return pop;
}

function bindUbPop(el, openFn) {
  if (el.dataset.popBound) return;
  el.dataset.popBound = '1';
  el.classList.add('ub-pop-anchor');
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ubPopState && ubPopState.anchor === el && ubPopState.pinned) { closeUbPop(); return; } // 点击已置顶 → 关
    openFn(el, true); // 点击 = 置顶弹出
  });
  el.addEventListener('mouseenter', () => {
    if (ubPopState && ubPopState.anchor === el) return; // 已开不动(含置顶)
    openFn(el, false); // 悬停 = 临时弹出
  });
  el.addEventListener('mouseleave', () => {
    if (ubPopState && ubPopState.anchor === el && !ubPopState.pinned) closeUbPop();
  });
}

// 时长中文格式:322分47秒(分可超 60;不足 1 分只显示秒)
const fmtMinSec = (ms) => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60), sec = total % 60;
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
};
const fmtRaw = (n) => (n || 0).toLocaleString('en-US');

// 🕐 会话统计(全局):模型用时 / 工具调用用时 / 首 token 平均(TTFT) / 输出速度(TPS)
function openStatsPop(anchor, pinned) {
  const g = state.config.usage || {};
  const modelMs = ((g.times && g.times.think) || 0) + ((g.times && g.times.output) || 0);
  const toolMs = (g.tools && g.tools.ms) || 0;
  const ttft = g.requests > 0 && g.times ? (g.times.wait || 0) / g.requests : 0;
  // 输出速度(v0.57.6 修正):只用「有正文轮次」的 (completion - 思考 tokens) / 那段时长。
  // 旧口径 completion/outputMs 把思考 tokens 也算入分子、思考时间却不在分母 → 思考越多显得越快。
  const tps = g.tps && g.tps.ms > 0 ? Math.round((g.tps.tokens || 0) / (g.tps.ms / 1000)) : 0;
  const row = (name, val) => `<div class="cp-row"><span class="cp-name">${name}</span><span class="cp-val">${val}</span></div>`;
  const html = `
    <div class="cp-head"><span class="cp-title">${t('会话统计')}</span></div>
    ${row(t('模型用时'), fmtMinSec(modelMs))}
    ${row(t('工具调用用时'), fmtMinSec(toolMs))}
    ${row(t('首 token 平均(TTFT)'), g.requests > 0 ? (ttft / 1000).toFixed(1) + t('秒') : '—')}
    ${row(t('输出速度(TPS)'), tps > 0 ? tps + ' tok/s' : (g.completion > 0 && !g.tps ? t('—(旧数据不计,新回复按正文统计)') : '—'))}`;
  openUbPop(anchor, html, pinned, true);
}
// 🗄 Token 用量:主行 = 本会话,弹层含「本会话 + 全部会话累计」两段(原始精确数字)
function openTokensPop(anchor, pinned) {
  const g = state.config.usage || {};
  const cu = (state.conv && state.conv.usage) || {};
  const row = (name, val) => `<div class="cp-row"><span class="cp-name">${name}</span><span class="cp-val">${val}</span></div>`;
  const seg = (title, u) => {
    const total = (u.prompt || 0) + (u.completion || 0);
    const hit = u.prompt > 0 && u.cached > 0 ? Math.round((u.cached / u.prompt) * 100) : null;
    const uncached = Math.max(0, (u.prompt || 0) - (u.cached || 0));
    return `<div class="cp-head" style="margin-top:6px"><span class="cp-title">${title}</span><span class="cp-frac">${fmtRaw(total)} tok</span></div>`
      + (hit != null ? row(t('缓存命中'), hit + '%') : '')
      + row(t('未缓存输入'), fmtRaw(uncached) + ' tok')
      + row(t('缓存读取'), fmtRaw(u.cached || 0) + ' tok')
      + row(t('输出'), fmtRaw(u.completion || 0) + ' tok');
  };
  const html = seg(t('本会话'), cu) + seg(t('全部会话累计'), g);
  openUbPop(anchor, html, pinned, true);
}

// ◎ 上下文(按外观设置的样式)
async function openRingPop(anchor, pinned) {
  const pop = openUbPop(anchor, `<div class="cp-head"><span class="cp-title">${t('上下文已用')}</span><span class="cp-frac">…</span></div><div class="cp-empty">${t('加载中…')}</div>`, pinned);
  const cx = (state.conv && state.conv.ctx) || null;
  const used = (cx && cx.tokens) || 0;
  let limit = 0;
  try {
    const lm = state.config.lastModel;
    if (lm) {
      const key = lm.providerId + '::' + lm.model;
      let caps = state.reasonCapsCache.get(key);
      if (!caps || !caps.contextLimit) { caps = await liteapi.invoke('reason:caps', { model: lm.model, providerId: lm.providerId }); state.reasonCapsCache.set(key, caps); }
      limit = Number(caps && caps.contextLimit) || 0;
    }
  } catch (_) { /* 无限制数据则只显示已用 */ }
  if (!ubPopState || ubPopState.el !== pop || !pop.isConnected) return;
  const detailStyle = (state.config.ui && state.config.ui.usageBarStyle) === 'detail';
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const parts = (cx && cx.parts) || null;
  const units = isZhUi() ? fmtWan : fmtBig;
  const row = (color, name, val) => `<div class="cp-row"><span class="cp-dot" style="background:${color}"></span><span class="cp-name">${name}</span><span class="cp-val">~${fmtBig(val)}</span></div>`;
  if (detailStyle) {
    // 容量大卡:容量头 + 分段彩条 + 分类占比 + 平均缓存命中率
    const cats = parts && used > 0 ? [
      ['msgs', t('消息'), (parts.user || 0) + (parts.assistant || 0)],
      ['tools', t('系统工具'), (parts.tools || 0)],
      ['results', t('工具结果'), (parts.toolResult || 0)],
      ['injected', t('技能与专精'), (parts.injected || 0)],
      ['system', t('系统提示词'), (parts.system || 0)],
    ].map(([k, name, v]) => ({ k, name, v: Math.max(0, v) })).filter((r) => r.v > 0) : [];
    const sum = cats.reduce((a, r) => a + r.v, 0);
    const other = parts && used > 0 ? Math.max(0, used - sum) : 0;
    if (other > used * 0.002) cats.push({ k: 'other', name: t('其他'), v: other });
    cats.sort((a, b) => b.v - a.v);
    const segs = cats.length ? cats.map((r) => `<div class="cp-seg" style="width:${((r.v / used) * 100).toFixed(2)}%;background:${CP_COLORS[r.k]}"></div>`).join('') : (used ? '<div class="cp-seg" style="width:100%;background:var(--accent)"></div>' : '');
    const g = state.config.usage || {};
    const cacheHit = g.prompt > 0 && g.cached > 0 ? (g.cached / g.prompt) * 100 : null;
    pop.innerHTML = `
      <div class="cp-head"><span class="cp-title">${t('上下文容量')}</span><span class="cp-frac">${units(used)}${limit ? '/' + units(limit) : ''}${pct != null ? ` (${pct}%)` : ''}</span></div>
      <div class="cp-track">${segs}</div>
      ${cats.length ? cats.map((r) => `<div class="cp-row"><span class="cp-dot" style="background:${CP_COLORS[r.k]}"></span><span class="cp-name">${r.name}</span><span class="cp-val">${used ? ((r.v / used) * 100).toFixed(1) : '0.0'}%</span></div>`).join('')
                    : `<div class="cp-empty">${t('发送消息后显示上下文构成')}</div>`}
      <div class="cp-foot"><span class="cp-name">${t('平均缓存命中率')}</span><span class="cp-val">${cacheHit != null ? cacheHit.toFixed(1) + '%' : '—'}</span></div>`;
  } else {
    const frac = `~${fmtBig(used)} / ${limit ? '~' + fmtBig(limit) : '?'}`;
    const sys = parts ? (parts.system || 0) + (parts.injected || 0) : 0;
    const tools = parts ? (parts.tools || 0) : 0;
    const msgs = parts ? (parts.user || 0) + (parts.assistant || 0) + (parts.toolResult || 0) : 0;
    pop.innerHTML = `
      <div class="cp-head"><span class="cp-title">${t('上下文已用')} ${pct != null ? pct + '%' : ''}</span><span class="cp-frac">${frac}</span></div>
      ${parts ? row('#8a8f98', t('系统提示词'), sys) + row('#a855f7', t('工具定义'), tools) + row('#3b82f6', t('对话消息'), msgs)
              : `<div class="cp-empty">${t('发送消息后显示上下文构成')}</div>`}
      <div style="height:6px"></div>`;
  }
  if (pct != null) {
    const ringOld = anchor.querySelector('svg');
    if (ringOld) ringOld.outerHTML = ctxRingSvg(pct);
    const label = $('#ctx-ring-label');
    if (label) label.textContent = pct + '%';
  }
}

function ctxRingSvg(pct) {
  // 14px 圆环:按百分比填充(pct 0-100;未知传 0)
  const r = 5.5, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="${r}" fill="none" stroke="var(--border)" stroke-width="2.4"/><circle cx="7" cy="7" r="${r}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(c * p / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 7 7)"/></svg>`;
}

const CP_COLORS = { msgs: '#3b82f6', tools: '#a855f7', results: '#f59e0b', injected: '#10b981', system: '#8a8f98', other: '#64748b' };

/* ================= 智能体模式 ================= */
const MODE_META = [
  { id: 'chat', label: '💬 对话模式' },
  { id: 'restricted', label: '🔒 受限模式' },
  { id: 'full', label: '⚡ 完全模式' },
  { id: 'create', label: '🎨 创造模式' },
  { id: 'team', label: '🤝 团队协同' },
];
const MODE_DESC = {
  chat: '纯对话模式:不调用任何工具,只聊天',
  restricted: '受限模式:仅只读工具(浏览/读文件/抓网页),不改系统',
  full: '完全模式:全部工具 + MCP/DSH 插件,完全授权自动执行',
  create: '创造模式:完全授权 + 可创建/修改自己的助手角色与技能',
  team: '团队协同模式:主模型担任指挥官,按团队模板把任务派发给队员(各配模型与推理强度),权限与完全模式一致',
};
const MODE_SHORT = { chat: '对话', restricted: '受限', full: '完全', create: '创造', team: '团队' };

function fillModeSelect() {
  const sel = $('#mode-select');
  sel.innerHTML = MODE_META.map((m) => `<option value="${m.id}">${t(m.label)}</option>`).join('');
  const cur = MODE_META.some((m) => m.id === state.config.ui.mode) ? state.config.ui.mode : 'chat';
  state.config.ui.mode = cur;
  sel.value = cur;
}

/* ================= 权限档位(对话框左下角,v0.54.2) ================= */
const PERM_LEVELS = [
  { v: 'plan', ico: '💡', name: '计划模式', desc: '先出计划,变更类操作逐项确认。' },
  { v: 'writes', ico: '✋', name: '变更前确认', desc: '写文件/执行命令前先询问。' },
  { v: 'risk', ico: '🛡️', name: '自主模式', desc: '仅高危操作询问(默认)。' },
  { v: 'full', ico: '⚡', name: '完全访问', desc: '全部自动执行,不再询问。' },
];
function permMeta(v) { return PERM_LEVELS.find((x) => x.v === v) || PERM_LEVELS[2]; }
function updatePermPill() {
  const meta = permMeta((state.config.agent || {}).permLevel);
  const ico = $('#perm-ico');
  const label = $('#perm-label');
  if (ico) ico.textContent = meta.ico;
  if (label) label.textContent = t(meta.name);
}
function renderPermMenu() {
  const pop = $('#perm-pop');
  if (!pop) return;
  const cur = (state.config.agent || {}).permLevel || 'risk';
  pop.innerHTML = PERM_LEVELS.map((m) => `
    <button class="perm-item ${cur === m.v ? 'active' : ''}" data-v="${m.v}">
      <span class="perm-ico2">${m.ico}</span>
      <span class="perm-txt"><b>${t(m.name)}</b><span class="perm-desc">${t(m.desc)}</span></span>
      ${cur === m.v ? '<span class="mc-check">✓</span>' : ''}
    </button>`).join('');
  $$('.perm-item', pop).forEach((b) => b.addEventListener('click', async () => {
    state.config = await liteapi.invoke('config:set', { agent: { ...(state.config.agent || {}), permLevel: b.dataset.v } });
    updatePermPill();
    togglePermPop(false);
    toast(`${t('权限档位:')}${t(permMeta(b.dataset.v).name)}`);
  }));
}
function togglePermPop(force) {
  const pop = $('#perm-pop');
  if (!pop) return;
  const show = force !== undefined ? force : pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !show);
  if (show) renderPermMenu();
}

/* ================= 跨会话全局搜索(v0.54.3) ================= */
const gsState = { open: false, timer: 0, hits: [], query: '' };

function ensureGsearchPanel() {
  let root = $('#gsearch-root');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'gsearch-root';
  root.className = 'hidden';
  root.innerHTML = `
    <div id="gsearch-card">
      <div id="gsearch-head">
        <span id="gsearch-title">🌐 ${t('全局搜索')}</span>
        <span class="mc-count">${t('全部对话 · 标题 / 消息 / 工具结果')}</span>
        <button type="button" class="sb-btn" id="gsearch-close" title="关闭 (Esc)">✕</button>
      </div>
      <input id="gsearch-input" type="text" placeholder="${t('搜索全部对话(标题 / 消息内容 / 工具结果)…')}" spellcheck="false">
      <div id="gsearch-results"></div>
    </div>`;
  $('#main').appendChild(root);
  const inp = $('#gsearch-input', root);
  inp.addEventListener('input', () => {
    gsState.query = inp.value;
    clearTimeout(gsState.timer);
    gsState.timer = setTimeout(runGsearch, 220);
  });
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeGsearch(); }
  });
  $('#gsearch-close', root).addEventListener('click', closeGsearch);
  root.addEventListener('click', (e) => { if (e.target === root) closeGsearch(); });
  return root;
}

function openGsearch() {
  const root = ensureGsearchPanel();
  root.classList.remove('hidden');
  gsState.open = true;
  const inp = $('#gsearch-input', root);
  inp.value = gsState.query;
  if (gsState.query.trim()) runGsearch(); else $('#gsearch-results', root).innerHTML = '';
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

function closeGsearch() {
  const root = $('#gsearch-root');
  if (root) root.classList.add('hidden');
  gsState.open = false;
}

async function runGsearch() {
  const q = gsState.query.trim();
  const box = $('#gsearch-results');
  if (!box) return;
  if (!q) { box.innerHTML = ''; gsState.hits = []; return; }
  box.innerHTML = '<div class="gs-empty">搜索中…</div>';
  let res = null;
  try { res = await liteapi.invoke('search:global', { q, limit: 40 }); } catch (e) { box.innerHTML = '<div class="gs-empty">搜索失败: ' + escapeHtml(String(e.message || e)) + '</div>'; return; }
  gsState.hits = (res && res.hits) || [];
  gsState.query = q;
  if (!gsState.hits.length) { box.innerHTML = '<div class="gs-empty">' + t('没有匹配的对话') + '</div>'; return; }
  box.innerHTML = gsState.hits.map((h, i) => {
    const roleTag = h.role === 'title' ? t('标题') : h.role === 'user' ? t('问') : h.role === 'tool' ? t('工具') : t('答');
    const d = h.updatedAt ? new Date(h.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    return `<button class="gs-hit" data-i="${i}">
      <span class="gs-hit-top"><span class="gs-hit-title">${escapeHtml(h.title)}</span><span class="gs-hit-role">${roleTag}</span><span class="gs-hit-date">${d}</span></span>
      <span class="gs-hit-snippet">${h.snippet ? markSnippet(h.snippet, q) : '<span class="gs-hit-note">' + escapeHtml(t('仅标题命中')) + '</span>'}</span>
    </button>`;
  }).join('');
  $$('.gs-hit', box).forEach((b) => b.addEventListener('click', () => jumpGsearchHit(gsState.hits[Number(b.dataset.i)])));
}

function markSnippet(snip, q) {
  const esc = escapeHtml(snip);
  try {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return esc.replace(re, (m2) => '<mark>' + m2 + '</mark>');
  } catch (_) { return esc; }
}

async function jumpGsearchHit(hit) {
  if (!hit) return;
  closeGsearch();
  await openConv(hit.convId);
  if (hit.idx < 0) return; // 仅标题命中:打开会话即可
  setTimeout(() => {
    const el = $('#chat .msg[data-idx="' + hit.idx + '"]');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('gsearch-flash');
    setTimeout(() => el.classList.remove('gsearch-flash'), 1800);
  }, 160);
}

/* ================= 模型选择(可搜索下拉) ================= */
// state.modelChoices = [{providerId, providerName, model}] 当前可选模型清单
function fillModelSelect() {
  const enabled = state.config.providers.filter((p) => ((p.apiKeys && p.apiKeys.length) || p.apiKey || p.local) && (p.models || []).length);
  state.modelChoices = enabled.flatMap((p) => p.models.map((m) => ({ providerId: p.id, providerName: p.name, model: m })));
  if (!enabled.length) {
    state.modelChoices = [];
    const rs0 = $('#reason-slider');
    if (rs0) { rs0.innerHTML = ''; rs0.dataset.none = '1'; rs0.dataset.ready = '0'; }
    state.reasonValue = null;
    state.reasonRenderKey = null;
    renderModelCombo();
    return;
  }
  const lm = state.config.lastModel;
  const valid = lm && enabled.some((p) => p.id === lm.providerId && (p.models || []).includes(lm.model));
  if (!valid) {
    state.config.lastModel = { providerId: enabled[0].id, model: enabled[0].models[0] };
    liteapi.invoke('config:set', { lastModel: state.config.lastModel });
  }
  renderModelCombo();
  fillReasonSelect();
}

function modelLabelText() {
  const lm = state.config.lastModel;
  if (!lm) return t('请先在设置中配置模型');
  const p = state.config.providers.find((x) => x.id === lm.providerId);
  return (p && p.name ? t(p.name) + ' · ' : '') + lm.model;
}

// 胶囊(底部栏)与弹层头部的档位/圆点状态同步
function updateModelPill(levelText) {
  const lv = levelText !== undefined ? levelText
    : (state.reasonValue == null ? '—' : (typeof state.reasonValue === 'number' ? t('自定义预算') : t(REASON_LABEL[state.reasonValue] || state.reasonValue)));
  const lm = state.config.lastModel;
  const pillLv = $('#mc-level');
  if (pillLv) pillLv.textContent = lm ? lv : '';
  const head = $('#mc-rlevel');
  if (head && levelText === undefined) head.textContent = lv;
  const dot = $('#mc-dot');
  if (dot) dot.classList.toggle('on', !!lm && state.reasonValue != null && state.reasonValue !== 'off' && state.reasonValue !== 'none');
}

function renderModelCombo() {
  const label = $('#mc-label');
  if (label) label.textContent = !state.config.lastModel ? t('未选择模型') : modelLabelText();
  updateModelPill();
  updateStatusHint();
}

function applyModelChoice(providerId, model) {
  const prev = state.config.lastModel;
  state.config.lastModel = { providerId, model };
  liteapi.invoke('config:set', { lastModel: state.config.lastModel });
  renderModelCombo();
  fillReasonSelect();
  applyComposerFold();
  // 切换提示线(v0.50.0):同一会话内切换了模型 → 聊天区插一条分隔线(本地展示 + 落盘随会话重绘恢复)
  const choice = state.modelChoices.find((c) => c.providerId === providerId && c.model === model);
  const label = choice ? `${choice.providerName || providerId}/${model}` : `${providerId}/${model}`;
  insertModelSwitchLine(label, prev && (prev.providerId !== providerId || prev.model !== model));
}

// 模型切换分隔线:视觉为一条居中细线 + 文案;写入会话 systemNote 块,重绘时恢复
function insertModelSwitchLine(label, really) {
  if (!really) return; // 首次选择/未变化不提示
  if (!state.conv) return;
  const m = state.conv.messages[state.conv.messages.length - 1];
  const note = { role: 'assistant', blocks: [{ type: 'model-switch', model: label }] };
  // 只在最后一条不是刚插的同类提示时追加(防连点重复刷屏)
  const lastBlocks = m && m.blocks;
  if (lastBlocks && lastBlocks.length && lastBlocks[lastBlocks.length - 1].type === 'model-switch' && lastBlocks[lastBlocks.length - 1].model === label) return;
  state.conv.messages.push(note);
  appendModelSwitchLine(label);
  liteapi.invoke('chat:saveNote', { convId: state.conv.id, note }).catch(() => {});
}

function appendModelSwitchLine(label) {
  let inner = $('.chat-inner', chatEl);
  if (!inner) { inner = document.createElement('div'); inner.className = 'chat-inner'; chatEl.appendChild(inner); }
  const div = document.createElement('div');
  div.className = 'model-switch-line';
  div.innerHTML = `<span>${escapeHtml(t('已切换到'))} ${escapeHtml(label)}</span>`;
  inner.appendChild(div);
  maybeScroll(true);
}

// 搜索下拉弹层:按关键词过滤(模型 ID / 供应商名),按供应商分组展示
function renderModelList() {
  const list = $('#mc-list');
  if (!list) return;
  const q = ($('#mc-search').value || '').trim().toLowerCase();
  const all = (state.modelChoices || []).filter((c) => !state.mpProvider || c.providerId === state.mpProvider); // 顶部选定供应商 → 只列该供应商的模型
  const hits = all.filter((c) => !q || c.model.toLowerCase().includes(q) || c.providerName.toLowerCase().includes(q));
  const count = $('#mc-count');
  if (count) count.textContent = `${hits.length}/${all.length}`;
  if (!hits.length) { list.innerHTML = '<div class="mc-empty">没有匹配的模型</div>'; return; }
  let html = '';
  let lastProv = null;
  for (const c of hits) {
    if (c.providerName !== lastProv) {
      html += `<div class="mc-group">${escapeHtml(t(c.providerName))}</div>`;
      lastProv = c.providerName;
    }
    const active = state.config.lastModel && state.config.lastModel.providerId === c.providerId && state.config.lastModel.model === c.model;
    html += `<button class="mc-item ${active ? 'active' : ''}" data-p="${escapeHtml(c.providerId)}" data-m="${escapeHtml(c.model)}"><span class="mc-model">${escapeHtml(c.model)}</span>${active ? '<span class="mc-check">✓</span>' : ''}</button>`;
  }
  list.innerHTML = html;
  $$('.mc-item', list).forEach((b) => b.addEventListener('click', () => {
    applyModelChoice(b.dataset.p, b.dataset.m);
    closeModelPop();
  }));
}

function toggleModelPop(force) {
  const style = modelPopStyle();
  const pop = style === 'split' ? $('#mp-pop2') : $('#mc-pop');
  const other = style === 'split' ? $('#mc-pop') : $('#mp-pop2');
  if (!pop) return;
  const show = force !== undefined ? force : pop.classList.contains('hidden');
  if (other) other.classList.add('hidden');
  pop.classList.toggle('hidden', !show);
  if (!show) return;
  const lm = state.config.lastModel;
  state.mpProvider = (lm && lm.providerId) || (state.modelChoices[0] && state.modelChoices[0].providerId) || null;
  state.mpProvView = false;
  if (style === 'classic') {
    $('#mc-search').value = '';
    renderProviderRow();
    renderProviderList();
    renderModelList();
    const slider = $('#reason-slider');
    const host = $('#mc-pop');
    if (slider && slider.parentElement !== host) host.appendChild(slider); // 经典样式滑块归位
    setTimeout(() => $('#mc-search').focus(), 0);
  } else {
    renderSplitProvs();
    renderSplitModels(state.mpProvider);
    const slider = $('#reason-slider');
    const host = $('#mp2-slider-host');
    if (slider && host && slider.parentElement !== host) host.appendChild(slider); // 分栏样式滑块移入右栏
  }
}

// 分栏样式(v0.54.2 第二形态):左栏 = 供应商清单(悬停预览);右栏 = 供应商模型 + 思考强度滑块
// 注:#mp2-right / #mp2-left 是历史命名(实际渲染顺序由 index.html 中的先后决定,供应商列在前 = 左侧)
function renderSplitProvs() {
  const wrap = $('#mp2-provs');
  if (!wrap) return;
  const cur = (state.config.lastModel || {}).providerId;
  const provs = [];
  for (const c of (state.modelChoices || [])) if (!provs.some((p) => p.id === c.providerId)) provs.push({ id: c.providerId, name: c.providerName });
  wrap.innerHTML = provs.map((p) => {
    const prov = (state.config.providers || []).find((x) => x.id === p.id);
    const tag = prov && prov.local ? t('本地') : t('API');
    const active = cur === p.id;
    return `<button class="mp-prov-item ${active ? 'active' : ''}" data-p="${escapeHtml(p.id)}"><span class="mp-prov-item-name">${escapeHtml(t(p.name) || p.name)}</span><span class="mp-tag">${tag}</span>${active ? '<span class="mc-check">✓</span>' : ''}</button>`;
  }).join('') || '<div class="mc-empty">没有可用供应商</div>';
  $$('.mp-prov-item', wrap).forEach((b) => {
    b.addEventListener('mouseenter', () => renderSplitModels(b.dataset.p)); // 悬停预览该供应商全部模型
    b.addEventListener('click', () => {
      state.mpProvider = b.dataset.p;
      const lm = state.config.lastModel;
      if (!lm || lm.providerId !== state.mpProvider) {
        const first = (state.modelChoices || []).find((c) => c.providerId === state.mpProvider);
        if (first) applyModelChoice(first.providerId, first.model);
      }
      renderSplitProvs();
      renderSplitModels(state.mpProvider);
    });
  });
}
function renderSplitModels(pid) {
  const list = $('#mp2-models');
  if (!list) return;
  const all = (state.modelChoices || []).filter((c) => c.providerId === pid);
  const lm = state.config.lastModel || {};
  list.innerHTML = all.map((c) => {
    const active = lm.providerId === c.providerId && lm.model === c.model;
    return `<button class="mc-item ${active ? 'active' : ''}" data-p="${escapeHtml(c.providerId)}" data-m="${escapeHtml(c.model)}"><span class="mc-model">${escapeHtml(c.model)}</span>${active ? '<span class="mc-check">✓</span>' : ''}</button>`;
  }).join('') || '<div class="mc-empty">该供应商暂无模型</div>';
  $$('.mc-item', list).forEach((b) => b.addEventListener('click', () => {
    applyModelChoice(b.dataset.p, b.dataset.m);
    renderSplitModels(b.dataset.p);
  }));
}

// 弹层顶部供应商行:名称 + [API/本地] 标签;点击展开供应商清单
function renderProviderRow() {
  const p = (state.config.providers || []).find((x) => x.id === state.mpProvider);
  $('#mp-prov-name').textContent = p ? (t(p.name) || p.name) : t('未选择供应商');
  $('#mp-prov-tag').textContent = p ? (p.local ? t('本地') : t('API')) : '';
}

// 供应商清单视图:全部可用供应商 + 管理模型入口
function renderProviderList() {
  const wrap = $('#mp-prov-list');
  const area = $('#mp-model-area');
  if (!wrap || !area) return;
  wrap.classList.toggle('hidden', !state.mpProvView);
  area.classList.toggle('hidden', state.mpProvView);
  if (!state.mpProvView) return;
  const items = (state.modelChoices || []);
  const provs = [];
  for (const c of items) if (!provs.some((p) => p.id === c.providerId)) provs.push({ id: c.providerId, name: c.providerName });
  $('#mp-prov-items').innerHTML = provs.map((p) => {
    const prov = (state.config.providers || []).find((x) => x.id === p.id);
    const tag = prov && prov.local ? t('本地') : t('API');
    const active = state.mpProvider === p.id;
    return `<button class="mp-prov-item ${active ? 'active' : ''}" data-p="${escapeHtml(p.id)}"><span class="mp-prov-item-name">${escapeHtml(t(p.name) || p.name)}</span><span class="mp-tag">${tag}</span>${active ? '<span class="mc-check">✓</span>' : ''}</button>`;
  }).join('') || '<div class="mc-empty">没有可用供应商</div>';
  $$('.mp-prov-item', wrap).forEach((b) => b.addEventListener('click', () => {
    state.mpProvider = b.dataset.p;
    state.mpProvView = false;
    // 切供应商:当前模型不属于该供应商时自动选它的第一个模型(pill 与对话即时跟随)
    const lm = state.config.lastModel;
    const owns = lm && lm.providerId === state.mpProvider;
    if (!owns) {
      const first = (state.modelChoices || []).find((c) => c.providerId === state.mpProvider);
      if (first) applyModelChoice(first.providerId, first.model);
    }
    renderProviderRow();
    renderProviderList();
    renderModelList();
  }));
}

function modelPopStyle() { return (state.config.ui || {}).modelPopStyle === 'split' ? 'split' : 'classic'; }
function closeModelPop() {
  const p1 = $('#mc-pop');
  if (p1) p1.classList.add('hidden');
  const p2 = $('#mp-pop2');
  if (p2) p2.classList.add('hidden');
}

function currentGroup() {
  const gid = (state.conv && state.conv.groupId) || state.pendingGroupId || 'default';
  return (state.config.groups || []).find((g) => g.id === gid) || null;
}

function updateStatusHint() {
  const el = $('#status-hint');
  const lm = state.config.lastModel;
  if (!lm) { el.textContent = ''; return; }
  const p = state.config.providers.find((x) => x.id === lm.providerId);
  const a = currentAssistant();
  const s = currentSkill();
  const g = currentGroup();
  const spec = state.config.ui.activeSpecialtyId;
  const bits = [
    lm.model,
    a.name !== '默认助手' ? t(a.name) : '',
    s ? `技能:${s.name}` : '',
    g && g.id !== 'default' ? `${g.icon || '📁'}${g.name}` : '',
    spec ? '🎓专精' : '',
    p && p.local ? '本地' : '',
    MODE_SHORT[state.config.ui.mode] ? (isZhLang() ? `${t(MODE_SHORT[state.config.ui.mode])}模式` : t(MODE_SHORT[state.config.ui.mode])) : '',
  ].filter(Boolean);
  el.textContent = bits.join(' · ');
}

/* ================= 主题 ================= */
function applyTheme() {
  document.documentElement.dataset.theme = state.config.ui.theme || 'light';
  document.dispatchEvent(new CustomEvent('lite-theme-change')); // md 沙箱 iframe 跟随主题
}

// 图片灯箱打开助手(宿主与沙箱 iframe 共用)
function openImageLightbox(src) {
  const lb = $('#lightbox');
  if (!lb) return;
  $('img', lb).src = src;
  lb.classList.remove('hidden');
}

// 应用实验性 UI 模式(低内存/纯终端/毛玻璃/背景图/透明化)到 body 类与背景
/* ================= 拖拽分隔条(v0.44:侧栏右缘 / 面板左缘,宽度持久化) ================= */
const SIDEBAR_W = { min: 200, max: 440 };
const PANEL_W = { min: 320, max: 720 };
const VIEW_GUTTER = 7; // 面板浏览器视图左侧留槽,避免原生层盖住拖拽条

function applySplitterWidths() {
  const ui = (state.config && state.config.ui) || {};
  const sw = Math.max(SIDEBAR_W.min, Math.min(SIDEBAR_W.max, Number(ui.sidebarWidth) || 264));
  const pw = Math.max(PANEL_W.min, Math.min(PANEL_W.max, Number(ui.panelWidth) || 400));
  document.documentElement.style.setProperty('--sidebar-w', sw + 'px');
  document.documentElement.style.setProperty('--panel-w', pw + 'px');
}

function makeVDrag(handle, opts) {
  // opts: { getW, apply(w), save(w), live(), min, max, dir }(dir=1 侧栏往右变宽;dir=-1 面板往左变宽)
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = opts.getW();
    document.body.classList.add('dragging-splitter');
    handle.classList.add('dragging');
    const widthAt = (ev) => Math.max(opts.min, Math.min(opts.max, Math.round(startW + (ev.clientX - startX) * opts.dir)));
    const move = (ev) => {
      opts.apply(widthAt(ev));
      if (opts.live) opts.live();
    };
    const up = (ev) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging-splitter');
      handle.classList.remove('dragging');
      opts.save(widthAt(ev));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  handle.dataset.splitterBound = '1';
}

function mountSplitters() {
  // 侧栏右缘
  const sidebar = $('#sidebar');
  if (sidebar && !document.getElementById('sidebar-splitter')) {
    const h = document.createElement('div');
    h.className = 'v-splitter';
    h.id = 'sidebar-splitter';
    h.title = '拖拽调整侧栏宽度';
    sidebar.appendChild(h);
    makeVDrag(h, {
      min: SIDEBAR_W.min, max: SIDEBAR_W.max, dir: 1,
      getW: () => sidebar.getBoundingClientRect().width,
      apply: (w) => document.documentElement.style.setProperty('--sidebar-w', w + 'px'),
      save: (w) => { state.config.ui.sidebarWidth = w; liteapi.invoke('config:set', { ui: { sidebarWidth: w } }); },
    });
  }
  // 面板左缘(面板由 ensurePanel 动态创建,创建时挂元素并在那里绑定)
  const panel = $('#side-panel');
  if (panel && !document.getElementById('panel-splitter')) {
    const h = document.createElement('div');
    h.className = 'v-splitter';
    h.id = 'panel-splitter';
    h.title = '拖拽调整面板宽度';
    panel.appendChild(h);
    makeVDrag(h, {
      min: PANEL_W.min, max: PANEL_W.max, dir: -1,
      getW: () => panel.getBoundingClientRect().width,
      apply: (w) => document.documentElement.style.setProperty('--panel-w', w + 'px'),
      live: () => syncPanelWebBounds(), // 拖拽中浏览器视图边界实时跟随
      save: (w) => { state.config.ui.panelWidth = w; liteapi.invoke('config:set', { ui: { panelWidth: w } }); syncPanelWebBounds(); },
    });
  }
}

// 背景图 URL:Blink 单条 CSS 声明上限 2^22 字符,4MB 级 data URL 会被 setProperty 静默丢弃
// (图保存成功但 --bg-image 恒为空)—— 统一转 blob URL(约 30 字符)再进 CSS 变量
let bgBlobCache = { data: '', url: '' };
function bgImageUrl() {
  const d = (state.config && state.config.ui && state.config.ui.bgImage) || '';
  if (!d) { if (bgBlobCache.url) { URL.revokeObjectURL(bgBlobCache.url); bgBlobCache = { data: '', url: '' }; } return ''; }
  if (bgBlobCache.data === d && bgBlobCache.url) return bgBlobCache.url;
  if (bgBlobCache.url) URL.revokeObjectURL(bgBlobCache.url); // 图已更换,释放旧 blob
  bgBlobCache = { data: d, url: '' };
  if (d.startsWith('blob:')) { bgBlobCache.url = d; return d; }
  const m = d.match(/^data:(image\/[\w.+-]+);base64,/);
  if (!m) return ''; // 非 base64 图片数据无法安全入 CSS,视为未设图
  try {
    const bin = atob(d.slice(d.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    bgBlobCache.url = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
  } catch (_) { return ''; }
  return bgBlobCache.url;
}

// —— 终端代码高亮配色(v0.56.6):默认当前效果,预设或逐项自定义 ——
const DEFAULT_CODE_COLORS = { tag: '#5b9bff', attr: '#d9a441', str: '#4fb96a', com: '#8b949e' };
const CODE_COLOR_PRESETS = [
  { id: 'default', name: '默认(当前)', colors: { ...DEFAULT_CODE_COLORS } },
  { id: 'one-dark', name: 'One Dark', colors: { tag: '#e06c75', attr: '#d19a66', str: '#98c379', com: '#5c6370' } },
  { id: 'github-light', name: 'GitHub 浅色', colors: { tag: '#22863a', attr: '#6f42c1', str: '#032f62', com: '#6a737d' } },
  { id: 'neon', name: '霓虹', colors: { tag: '#22d3ee', attr: '#f472b6', str: '#a3e635', com: '#64748b' } },
  { id: 'sunset', name: '日落', colors: { tag: '#fb7185', attr: '#fbbf24', str: '#facc15', com: '#78716c' } },
];
function currentCodeColors() {
  const c = ((state.config && state.config.ui && state.config.ui.codeColors) || {});
  return {
    tag: /^#[0-9a-f]{6}$/i.test(c.tag || '') ? c.tag : DEFAULT_CODE_COLORS.tag,
    attr: /^#[0-9a-f]{6}$/i.test(c.attr || '') ? c.attr : DEFAULT_CODE_COLORS.attr,
    str: /^#[0-9a-f]{6}$/i.test(c.str || '') ? c.str : DEFAULT_CODE_COLORS.str,
    com: /^#[0-9a-f]{6}$/i.test(c.com || '') ? c.com : DEFAULT_CODE_COLORS.com,
  };
}
function codeThemeOf(colors) {
  for (const p of CODE_COLOR_PRESETS) {
    if (p.colors.tag === colors.tag && p.colors.attr === colors.attr
      && p.colors.str === colors.str && p.colors.com === colors.com) return p.id;
  }
  return 'custom';
}
function applyCodeColors() {
  const c = currentCodeColors();
  const r = document.documentElement;
  r.style.setProperty('--code-tag', c.tag);
  r.style.setProperty('--code-attr', c.attr);
  r.style.setProperty('--code-str', c.str);
  r.style.setProperty('--code-com', c.com);
}

function applyUiMode() {
  const ui = (state.config && state.config.ui) || {};
  applyCodeColors(); // 终端代码高亮配色(全局 CSS 变量)
  applySplitterWidths(); // 侧栏/面板拖拽宽度(v0.44,收敛点与显示模式一致)
  // 思考滑块缩放(只缩滑块,CSS zoom 真·等比例,布局同步收缩);<1 时加粗字重保证缩放后清晰
  const slider = $('#reason-slider');
  if (slider) {
    const z = Number(ui.sliderZoom) || 1;
    slider.style.zoom = z;
    slider.classList.toggle('rs-zoomed', z < 1);
  }
  applyComposerFold(); // 滑块位置(按对齐)与折叠显示统一在此收敛
  // 省电渲染:毛玻璃/背景图让位(窗口材质在主进程按同一规则显式 'none');纯终端模式同样关闭重特效
  const ps = !!ui.powerSave;
  document.body.classList.toggle('powersave', ps);
  document.body.classList.toggle('perf-mode', !!ui.perfLowMemory);
  document.body.classList.toggle('pure-terminal', !!ui.pureTerminal);
  document.body.classList.toggle('sidebar-hidden', !!ui.sidebarHidden); // v0.52.0 侧栏隐藏开关
  syncSidebarToggleBtn();
  // v0.49.4 收敛:UI 只暴露两个连续滑杆,勾选开关由滑杆值派生(向后兼容老配置的布尔字段):
  //   毛玻璃 = glassLevel ≥ 10;不透明度 bgOpacity 0~100(0=全透,100=全实)。
  // 注意 0 是合法值:未设置(undefined/null)才落默认,glassLevel 老用户回退 glass 布尔。
  const hasGl = ui.glassLevel !== undefined && ui.glassLevel !== null && ui.glassLevel !== '';
  const gl = hasGl ? Math.max(0, Math.min(100, Number(ui.glassLevel) || 0)) : (ui.glass ? 62 : 0);
  const hasOp = ui.bgOpacity !== undefined && ui.bgOpacity !== null && ui.bgOpacity !== '';
  const op = hasOp ? Math.max(0, Math.min(100, Number(ui.bgOpacity) || 0)) : 100;
  const bgUrl = (!!ui.bgImage && !ps && !ui.pureTerminal) ? bgImageUrl() : '';
  // 滑杆语义分流(v0.49.6 用户裁定):设了背景图 → bgOpacity = 图浓度,界面本体保持实色,
  // 窗口透明不被牵连;没设图 → bgOpacity = 窗口不透明度(原语义)。
  const withBg = !!bgUrl;
  const winOp = withBg ? 100 : op;          // 窗口/界面底面不透明度:有图恒 100(实色)
  const imgDim = withBg ? op : 0;           // 图浓度:有图 = 滑杆值;无图无意义
  document.body.classList.toggle('glass', gl >= 10 && !ps && !ui.pureTerminal);
  document.body.classList.toggle('ui-transparent', winOp <= 99 && !ps);
  document.body.classList.toggle('has-bg', !!bgUrl);
  document.body.style.setProperty('--bg-image', bgUrl ? `url("${bgUrl}")` : 'none');
  // 外观强度变量:毛玻璃 10~100(底色不透明度%,模糊 4~20px 线性)
  document.body.style.setProperty('--glass-a', String(Math.max(10, gl)));
  document.body.style.setProperty('--glass-blur', (4 + (Math.max(10, gl) - 10) / 90 * 16).toFixed(1) + 'px');
  document.body.style.setProperty('--bg-dim', String(imgDim));
  // color-mix 不支持 calc 百分比运算,底面/侧栏/顶栏不透明度在 JS 预算:
  // 底面 = winOp%;无玻璃侧栏/顶栏 = bg-side 基线 76% × (winOp/100);玻璃侧栏 = 玻璃a% × (winOp/100)
  document.body.style.setProperty('--app-a', winOp.toFixed(1) + '%');
  document.body.style.setProperty('--side-b', (76 * winOp / 100).toFixed(1) + '%');
  document.body.style.setProperty('--side-a', (Math.max(10, gl) * (winOp / 100)).toFixed(1) + '%');
  // 背景图面板浓度:图越浓面板越透(无玻璃面板保底 40% + 富余*0.6);玻璃叠加取淡者,图至少透出一部分
  const dimBase = 40 + (100 - imgDim) * 0.6;
  document.body.style.setProperty('--side-bg', Math.min(100, dimBase).toFixed(1) + '%');
  document.body.style.setProperty('--panel-bg', Math.min(Math.max(10, gl), Math.min(100, dimBase)).toFixed(1) + '%');
  // 背景图模糊度(v0.49.6):ui.blurLevel 0~100 → 0~30px,朦胧感;>0 时按比例轻微放大补偿边缘发虚
  const bl = Math.max(0, Math.min(100, Number(ui.blurLevel) || 0));
  document.body.style.setProperty('--bg-blur', (bl / 100 * 30).toFixed(1) + 'px');
  document.body.style.setProperty('--bg-blur-px', String(bl));
  // 消息卡片浓度(v0.49.6 调优):有背景图/玻璃时 45%(融合为主,靠文字阴影保可读),
  // 无背景时 30% 极淡融入;纯终端/低内存走实色。
  const hasBgNow = !!ui.bgImage;
  const cardA = hasBgNow || gl >= 10 ? 28 : 18; // 融合为主:极淡底 + blur + 文字光晕承担可读性
  document.body.style.setProperty('--msg-card-a', cardA + '%'); // color-mix 百分比必须带单位(教训同 --ai-card-a)
  // 字体增强(v0.49.6):两个作用域独立开关
  document.body.classList.toggle('font-chat', !!ui.fontChat);
  document.body.classList.toggle('font-ui', !!ui.fontUi);
  positionTerminal();
  syncPureTerminal();
}

/* ================= 内置终端(四角停靠 / 纯终端模式全屏接管) ================= */
function openTermPanel() {
  state.termOpen = true;
  const panel = document.getElementById('term-panel');
  if (panel) panel.classList.remove('hidden');
  liteapi.invoke('term:write', ''); // 唤起持久 shell(会打印提示符)
  const inp = $('#term-input');
  if (inp) inp.focus();
}

function closeTermPanel() {
  state.termOpen = false;
  const panel = document.getElementById('term-panel');
  if (panel) panel.classList.add('hidden');
}

// 精简模式(旧称纯终端模式)= 整窗即终端形态的完整 Agent:聊天 UI 由 CSS 退场,Agent 控制台(#agent-term)接管。
// 四角终端面板与 ⌨ 钮在纯终端下隐藏(shell 走控制台内的 ! 命令),开合状态不改动。
let bodyWasPureTerminal = false; // 上一次 applyUiMode 时是否处于纯终端(检测切换时刻)
function syncPureTerminal() {
  const box = document.getElementById('agent-term');
  if (!box) return; // boot 早期 DOM 还没建,initTerminalUI 末尾会再调一次
  const now = !!(state.config && state.config.ui && state.config.ui.pureTerminal);
  if (now === bodyWasPureTerminal) return;
  bodyWasPureTerminal = now;
  if (now) {
    openTermConsole();
  } else {
    closeTermConsole();
    // 退出接管:接管期间聊天 UI 不可见,后台可能有刚完成的回复 —— 走 openConv 规范路径重放/重绘
    // v0.51.7:state.conv 为 null(终端里没发过消息)→ 恢复最近会话,别停在空屏
    if (state.conv) openConv(state.conv.id);
    else liteapi.invoke('convs:list').then((list) => { if (list.length) openConv(list[0].id); }).catch(() => {});
  }
}
function positionTerminal() {
  // v0.36:终端永久住在右侧面板,这里只负责 ⌨ 入口按钮的四角停靠
  const dev = (state.config && state.config.dev) || {};
  const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(dev.terminalCorner) ? dev.terminalCorner : 'bottom-right';
  const toggle = document.getElementById('term-toggle');
  if (!toggle) return;
  for (const c of ['corner-top-left', 'corner-top-right', 'corner-bottom-left', 'corner-bottom-right']) {
    toggle.classList.remove(c);
  }
  toggle.classList.add('corner-' + corner);
}

// 终端 DOM 的常驻持有处(终端标签未激活时停在这里,避免被其它标签页的 innerHTML 清掉)
const termHolder = document.createElement('div');
termHolder.className = 'sp-term-holder';
const termOutBuf = { s: '' }; // 终端 DOM 脱离文档期间的输出缓冲,重挂时回放

/* ================= 自绘标题栏(v0.38:无边框窗口) ================= */
function initTitlebar() {
  const bar = $('#titlebar');
  if (!bar) return;
  $('#tb-min', bar).addEventListener('click', () => liteapi.invoke('appwin:minimize').catch(() => {}));
  $('#tb-max', bar).addEventListener('click', () => liteapi.invoke('appwin:maximize').catch(() => {}));
  $('#tb-close', bar).addEventListener('click', () => liteapi.invoke('appwin:close').catch(() => {}));
  // 双击标题栏空白区 = 最大化/还原
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-controls')) return;
    liteapi.invoke('appwin:maximize').catch(() => {});
  });
  // 最大化状态 → 图标 □/❐ 切换(与最小化/关闭同款 1px SVG 笔画)
  const maxBtn = $('#tb-max', bar);
  const GLYPH_MAX = '<svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  const GLYPH_RESTORE = '<svg viewBox="0 0 10 10"><path d="M2.5 0.5h7v7" fill="none" stroke="currentColor" stroke-width="1"/><rect x="0.5" y="2.5" width="7" height="7" fill="var(--bg-side)" stroke="currentColor" stroke-width="1"/></svg>';
  const setIcon = (maxed) => { maxBtn.innerHTML = maxed ? GLYPH_RESTORE : GLYPH_MAX; maxBtn.title = maxed ? '还原' : '最大化'; };
  liteapi.onAppWinState(setIcon);
  // 双击拖拽区外的拖动由 -webkit-app-region 处理;这里仅图标初始化
}

function initTerminalUI() {
  const mainEl = $('#main');
  const toggle = document.createElement('button');
  toggle.id = 'term-toggle';
  toggle.title = '终端(在右侧面板中打开)';
  toggle.textContent = '⌨';
  const panel = document.createElement('div');
  panel.id = 'term-panel';
  panel.innerHTML = `
    <div class="term-head">
      <span class="term-title">终端(持久会话:cd 与环境变量保持)</span>
      <span class="term-actions">
        <button class="term-act" data-act="clear">清屏</button>
        <button class="term-act" data-act="reset">${t('重置')}</button>
      </span>
    </div>
    <pre class="term-out" id="term-out"></pre>
    <div class="term-input-row"><span class="term-prompt">&gt;</span><input id="term-input" type="text" spellcheck="false" placeholder="输入命令,Enter 执行…"></div>`;
  mainEl.appendChild(toggle);
  // 终端 DOM 常驻在右侧面板的持有容器里(v0.36 起不再有四角悬浮终端)
  termHolder.appendChild(panel);
  toggle.addEventListener('click', () => {
    togglePanel(true);
    setPanelTab('term');
  });
  $$('.term-act', panel).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.act === 'clear') $('#term-out').textContent = '';
    else if (b.dataset.act === 'reset') await liteapi.invoke('term:reset');
  }));
  // 面板创建时终端处于脱离文档的持有容器中:事件绑定必须以 panel 为作用域查询
  const input = $('#term-input', panel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      const line = input.value;
      input.value = '';
      const out = $('#term-out');
      if (out) {
        out.textContent += (out.textContent && !out.textContent.endsWith('\n') ? '\n' : '') + '> ' + line + '\n';
      } else {
        termOutBuf.s += '> ' + line + '\n'; // 分离期:回显进缓冲,重挂时一并显示
      }
      liteapi.invoke('term:write', line);
      maybeScrollTerm();
    }
    e.stopPropagation();
  });
  liteapi.onTermEvent((ev) => {
    // 终端 DOM 可能处于脱离文档的持有容器:分离期输出进缓冲,重挂时回放
    const out = $('#term-out');
    if (ev.type === 'data') {
      if (out) {
        out.textContent += ev.text;
        if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000); // 防止无限膨胀
      } else {
        termOutBuf.s += ev.text;
        if (termOutBuf.s.length > 200000) termOutBuf.s = termOutBuf.s.slice(-150000);
      }
      if (state.termOpen) maybeScrollTerm();
      if (term.active) termShellAppend(ev.text); // 纯终端模式:! 命令的 shell 输出进控制台
    } else if (ev.type === 'exit') {
      const line = `\n[shell 已退出(code ${ev.code === null ? '-' : ev.code}),发送任意命令将重新启动]\n`;
      if (out) out.textContent += line;
      else termOutBuf.s += line;
      if (term.active) termShellAppend(line);
    }
  });
  positionTerminal();
  initTermConsole();
  syncPureTerminal(); // 启动时已开启纯终端模式:这里控制台才存在,补一次进入判定
}

function maybeScrollTerm() {
  const o = $('#term-out');
  if (o) o.scrollTop = o.scrollHeight;
}

/* ================= 精简模式(v0.52.0 由「纯终端模式」改名;config 键 pureTerminal 与 body.pure-terminal 类名不变):终端形态的完整 Agent 控制台 ================= */
// 参考 Claude Code / aider:整窗是一个终端,输入直接与 AI 对话(复用 chat:send 全链路:
// 工具/审批/问询/用量/落盘与聊天界面完全一致);!cmd 直通真实持久 shell;/cmd 为元命令。
// 聊天 DOM 仍在后台照常构建(隐藏),退出纯终端模式后无缝衔接。
// 斜杠命令统一表(v0.51.2):普通输入框与终端模式共用;/ 呼出补全,↑↓选择回车执行。
// scope: both = 两边都有;term = 仅终端;input = 仅普通输入框。
const SLASH_COMMANDS = [
  { cmd: '/help', desc: '显示帮助', scope: 'term' },
  { cmd: '/new', desc: '开始新对话', scope: 'both' },
  { cmd: '/conv', desc: '切换会话', scope: 'term' },
  { cmd: '/model', desc: '查看或切换模型(/model 名称)', scope: 'term' },
  { cmd: '/reason', desc: '查看或切换思考强度(/reason 低|中|高)', scope: 'term' },
  { cmd: '/mode', desc: '切换模式:对话/受限/完全/创造', scope: 'term' },
  { cmd: '/img', desc: '生成图片(/img 描述)', scope: 'both' },
  { cmd: '/handover', desc: '接手另一个对话(/handover 对话ID,读取其上下文继续)', scope: 'both' },
  { cmd: '/id', desc: '显示当前对话 UID(交付/接手用的 ID)', scope: 'term' },
  { cmd: '/pet', desc: '切换看板娘形态(机器人 / 点阵)', scope: 'term' },
  { cmd: '/spin', desc: '等待动画颜色(HDR 调色盘,实时预览)', scope: 'term' },
  { cmd: '/think', desc: '思考显示:思考链 / 纯状态(不输出思考链)', scope: 'term' },
  { cmd: '/sel', desc: '选择高亮颜色(默认琥珀黄,HDR 调色盘)', scope: 'term' },
  { cmd: '/settings', desc: '打开设置', scope: 'term' },
  { cmd: '/stop', desc: '停止当前回复', scope: 'both' },
  { cmd: '/clear', desc: '清屏', scope: 'term' },
  { cmd: '/exit', desc: '退出精简模式', scope: 'term' },
];

const TERM_HELP_LINES = [
  '直接输入内容 = 与 AI 对话(智能体可调用工具完成任务);输入以 ! 开头 = 执行真实 shell 命令',
  '  /help          显示本帮助',
  '  /new           开始新对话',
  '  /conv [n]      列出最近会话;/conv <序号> 切换到对应会话',
  '  /model [名称]  查看或切换模型(模糊匹配)',
  '  /reason [档位] 查看或切换思考强度(极简/低/中/高/超高/最大)',
  '  /mode [模式]   查看或切换模式:对话 / 受限 / 完全 / 创造',
  '  /img [描述]    生成图片',
  '  /handover [ID] 接手另一个对话:读取其上下文继续(ID 可在对话条目复制/悬停查看)',
  '  /id            显示当前对话 UID(接手/交付用,拖选复制)',
  '  /pet           切换看板娘形态(机器人 / 点阵)',
  '  /spin [颜色]   等待动画颜色:无参打开 HDR 调色盘实时预览;可按名称/十六进制直达(/spin 品红 | /spin #ff2fd6)',
  '  /think [模式]  思考显示切换:chain=输出思考链(默认) / status=纯状态行 [* 思考中] (Ns) 不输出思考链',
  '  /sel [颜色]    选择高亮颜色(默认琥珀黄):无参打开 HDR 调色盘,高亮行即实时预览;/sel 霓虹青 | /sel #ff2fd6 直达',
  '  /settings      打开设置抽屉',
  '  /stop          停止当前回复',
  '  /clear         清屏',
  '  /exit          退出精简模式,回到完整界面',
];
const term = {
  active: false,      // 控制台是否处于接管状态(= 纯终端模式开启)
  stick: true,        // 滚动跟随
  cur: null,          // 当前流式回复的终端渲染状态 {text, reasoning, tools:Map, asks:Map}
  shellBlock: null,   // 当前 ! 命令的 shell 输出块
};

// —— 终端 TUI 选择器(/model /mode 无参呼出):列表直接渲染在终端输出流里(fzf/Claude Code 式,
//    非浮层)—— ❯ 前缀 + 整行反色高亮指示当前项,↑↓ 移动、回车确认、输入即过滤、Esc 取消、鼠标点击可选 ——
const TERM_PICK_VIEW = 9; // 可视行数(TUI 视口:长列表滚动,高亮行居中)
let termPick = null; // { title, items:[{label, sub, active, ...}], hits, idx, onPick }
function termPickRender() {
  if (!termPick) return;
  let block = $('#at-pick-block');
  if (!block) {
    block = document.createElement('div');
    block.id = 'at-pick-block';
    term.out.appendChild(block); // 终端流内:就是终端内容,不是弹窗
  }
  const flt = String(term.input.value || '').trim().toLowerCase();
  termPick.hits = termPick.items.filter((it) => !flt || ((it.label + ' ' + (it.sub || ''))).toLowerCase().includes(flt));
  if (termPick.idx >= termPick.hits.length) termPick.idx = Math.max(0, termPick.hits.length - 1);
  const n = termPick.hits.length;
  let start = 0;
  if (n > TERM_PICK_VIEW) start = Math.min(Math.max(0, termPick.idx - Math.floor(TERM_PICK_VIEW / 2)), n - TERM_PICK_VIEW);
  const vis = termPick.hits.slice(start, start + TERM_PICK_VIEW);
  const parts = ['<div class="at-pick-tui-title"></div>'];
  if (termPick.preview) parts.push('<div class="at-pick-preview"></div>'); // 大号实时预览区(/spin 调色盘)
  if (start > 0) parts.push(`<div class="at-pick-tui-more">↑ 还有 ${start} 项(输入可过滤)</div>`);
  vis.forEach((it, i) => {
    const gi = start + i;
    const on = gi === termPick.idx;
    parts.push(`<div class="at-pick-tui-line${on ? ' on' : ''}" data-i="${gi}">`
      + `<span class="at-pick-tui-arrow">${on ? '❯' : ' '}</span>`
      + (it.swatch ? `<span class="at-pick-sw" style="background:${it.swatch}"></span>` : '')
      + `<b>${escapeHtml(it.label)}</b>`
      + (it.sub ? `  <span class="at-pick-tui-sub">${escapeHtml(it.sub)}</span>` : '')
      + (it.active ? '  <span class="at-pick-tui-cur">✓</span>' : '')
      + '</div>');
  });
  if (n && start + vis.length < n) parts.push(`<div class="at-pick-tui-more">↓ 还有 ${n - start - vis.length} 项</div>`);
  if (!n) parts.push(`<div class="at-pick-tui-more">无匹配「${escapeHtml(flt)}」</div>`);
  block.innerHTML = parts.join('');
  $('.at-pick-tui-title', block).textContent = `── ${termPick.title} · ${t('↑↓ 选择 回车确认 Esc 取消(输入即过滤)')} ──`;
  $$('.at-pick-tui-line', block).forEach((el) => {
    el.addEventListener('mousedown', (e) => { // mousedown+preventDefault:抢在输入框失焦前完成选择
      e.preventDefault();
      termPick.idx = parseInt(el.dataset.i, 10);
      termPickCommit();
    });
  });
  if (termPick.preview) refreshSpinPreviewRow();
  if (termPick.onPreview && termPick.hits[termPick.idx]) termPick.onPreview(termPick.hits[termPick.idx]); // 高亮即预览(↑↓/过滤都走这)
  term.out.scrollTop = term.out.scrollHeight; // 终端滚动跟随
}
function termPickMove(d) {
  if (!termPick || !termPick.hits.length) return;
  termPick.idx = (termPick.idx + d + termPick.hits.length) % termPick.hits.length;
  termPickRender();
}
async function termPickCommit() {
  if (!termPick) return;
  const pick = termPick.hits[termPick.idx];
  const cb = termPick.onPick;
  termPick._done = true; // 已确认:关闭不再触发 onCancel
  termPickClose();
  term.input.value = '';
  if (pick) await cb(pick);
  term.input.focus();
}
function termPickClose() {
  const p = termPick;
  termPick = null;
  const block = $('#at-pick-block');
  if (block) block.remove();
  if (p && p.onCancel && !p._done) p.onCancel(); // Esc/失焦收起 → 级联上一级(供应商列表)
}
function termPickCancel() { termPickClose(); term.input.value = ''; term.input.focus(); }
function termOpenPicker(opts) {
  const activeIdx = opts.items.findIndex((it) => it.active);
  termPick = {
    title: opts.title, items: opts.items, hits: opts.items, idx: Math.max(0, activeIdx),
    onPick: opts.onPick, onCancel: opts.onCancel || null,
    preview: !!opts.preview, onPreview: opts.onPreview || null,
  };
  term.input.value = '';
  termPickRender();
  term.input.focus();
}

// /model 两步级联 TUI:第 1 步选供应商 → 第 2 步选该供应商的模型(Esc 返回上一步;再 Esc 退出)
function openModelPicker() {
  const lm = state.config.lastModel || {};
  const choices = state.modelChoices || [];
  // 供应商列表 = 模型选择集去重(保持 fillModelSelect 的顺序:有 Key/本地且有模型)
  const seen = new Set();
  const provs = [];
  for (const c of choices) {
    if (seen.has(c.providerId)) continue;
    seen.add(c.providerId);
    provs.push({ providerId: c.providerId, name: c.providerName, count: choices.filter((x) => x.providerId === c.providerId).length });
  }
  termOpenPicker({
    title: t('选择模型 1/2 · 供应商(共 N 家,回车进入模型列表)').replace('N', String(provs.length)),
    items: provs.map((p) => ({ label: p.name, sub: `${p.count} 个模型`, active: p.providerId === lm.providerId, pid: p.providerId, pname: p.name })),
    onPick: (prov) => {
      const models = choices.filter((c) => c.providerId === prov.pid);
      termOpenPicker({
        title: `${t('选择模型 2/2')} · ${prov.pname} ${t('的模型(Esc 返回供应商)')}`,
        items: models.map((c) => ({
          label: c.model, sub: prov.pname,
          active: c.providerId === lm.providerId && c.model === lm.model,
          providerId: c.providerId, model: c.model,
        })),
        onPick: (m) => {
          applyModelChoice(m.providerId, m.model);
          termLine('at-meta', null, `${t('已切换到')} ${m.sub}/${m.label}`);
        },
        onCancel: openModelPicker, // Esc → 回到供应商列表
      });
    },
  });
}

function initTermConsole() {
  if ($('#agent-term')) { applyTermSelColor(); return; } // 已存在:只收敛选择高亮色
  applyTermSelColor();
  const box = document.createElement('div');
  box.id = 'agent-term';
  box.className = 'hidden';
  box.innerHTML = `
    <div id="at-out"></div>
    <div id="at-attach-bar" class="hidden"></div>
    <div id="at-drop-hint" class="hidden">📎 松开以添加附件(图片 / 文本文件)</div>
    <div id="at-input-row"><span id="at-prompt">❯</span><input id="at-input" type="text" spellcheck="false" placeholder="与 AI 对话;!cmd 执行 shell;/help 查看命令" autocomplete="off"></div>
    <div id="at-status"><span id="at-st-left">—</span><span class="at-grow"></span><span id="at-st-right"></span><button id="at-exit-btn" title="${t('退出精简模式,回到完整界面')}">↩ ${t('退出')}</button></div>`;
  $('#main').appendChild(box);
  term.out = $('#at-out', box);
  term.input = $('#at-input', box);
  // 精简模式附件:输入框粘贴文件(截图等)→ 走同一附件队列
  term.input.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addAttachFiles(files); }
  });
  // 对话标签栏(v0.52.0):嵌入标题栏本体(浏览器式,标签与窗口三键同行)。
  // 挂 #titlebar 内、三键之前;非精简模式 display:none,body.pure-terminal 才显示(CSS 收敛)。
  // 空白处保留 app-region:drag 可拖窗口,标签本体 no-drag 可点。
  const tb = $('#titlebar');
  const atTabs = document.createElement('div');
  atTabs.id = 'at-tabs';
  atTabs.innerHTML = '<div id="at-tabs-scroll"></div><button id="at-tab-new" data-i18n-title="新建标签(新任务)" title="新建标签(新任务)">＋</button>';
  tb.insertBefore(atTabs, $('.tb-controls', tb));
  // 对话标签栏(v0.52.0):浏览器式多标签,每标签 = 一个对话;点击切换(openConv → 控制台重放,后台流继续),× 删除
  $('#at-tabs').addEventListener('click', async (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      e.stopPropagation();
      const id = close.dataset.close;
      if (state.streams.has(id)) { toast('该会话正在回复中,请先停止再删除'); return; }
      const meta = state.convs.find((c) => c.id === id);
      if (!confirm(`删除对话「${(meta && meta.title) || id}」?不可恢复。`)) return;
      state.convs = await liteapi.invoke('convs:delete', id);
      if (state.conv && state.conv.id === id) {
        state.conv = null;
        termClear();
        termPrintBanner();
        renderSubagentPill(true);
        if (state.convs[0]) openConv(state.convs[0].id); // 自动切到最近会话
      }
      renderSidebar();
      renderTermTabs();
      return;
    }
    const tab = e.target.closest('.at-tab');
    if (tab && tab.dataset.convId && tab.dataset.convId !== (state.conv && state.conv.id)) openConv(tab.dataset.convId);
  });
  $('#at-tab-new').addEventListener('click', () => termRunMeta('/new'));
  term.out.addEventListener('scroll', () => {
    term.stick = term.out.scrollTop + term.out.clientHeight >= term.out.scrollHeight - 40;
  });
  // 斜杠命令补全(v0.51.2):输入 / 时呼出候选,↑↓选择,回车执行/Tab补全
  const slashPop = document.createElement('div');
  slashPop.id = 'at-slash-pop';
  slashPop.className = 'at-slash-pop hidden';
  $('#at-input-row', box).appendChild(slashPop); // 挂进行内(row 是 relative 锚,offsetParent 稳定)
  let slashIdx = -1;
  const slashMatches = () => {
    const v = term.input.value;
    if (!v.startsWith('/') || v.includes(' ') || v.length > 24) return [];
    return SLASH_COMMANDS.filter((c) => c.scope !== 'input' && c.cmd.startsWith(v.toLowerCase()));
  };
  const renderSlashPop = () => {
    const hits = slashMatches();
    if (!hits.length) { slashPop.classList.add('hidden'); slashIdx = -1; return; }
    slashPop.classList.remove('hidden');
    slashPop.innerHTML = hits.map((c, i) => `<div class="at-slash-item ${i === slashIdx ? 'on' : ''}" data-cmd="${c.cmd}"><b>${c.cmd}</b><span>${escapeHtml(c.desc)}</span></div>`).join('');
    $$('.at-slash-item', slashPop).forEach((el) => el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      term.input.value = el.dataset.cmd + ' ';
      closeSlashPop();
      term.input.focus();
    }));
  };
  const closeSlashPop = () => { slashPop.classList.add('hidden'); slashIdx = -1; };
  term.input.addEventListener('input', () => {
    if (termPick) { termPick.idx = 0; termPickRender(); return; } // 选择器激活:输入即过滤
    slashIdx = -1;
    renderSlashPop();
  });
  term.input.addEventListener('blur', () => setTimeout(() => { closeSlashPop(); if (termPick) termPickClose(); }, 120));

  term.input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // 交互式选择器激活时优先接管方向键/回车/Esc(模型·模式选择)
    if (termPick) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); termPickMove(e.key === 'ArrowUp' ? -1 : 1); return; }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); termPickCommit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); termPickCancel(); return; }
    }
    // 待答问询 TUI 接管(v0.54.19 条目②③):↑↓ 移动 / 回车确认 / 数字直达 / 直接键入即自定义 / Esc 收起
    if (termAsk && !termAsk.answered && !termAsk.folded) {
      const n = termAsk.opts.length + 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); termAskMove(e.key === 'ArrowUp' ? -1 : 1); return; }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); termAskCommit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); termAskFold(); return; }
      if (/^[1-9]$/.test(e.key) && parseInt(e.key, 10) <= n) { e.preventDefault(); termAsk.idx = parseInt(e.key, 10) - 1; termAskCommit(); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const inp = document.querySelector('.at-ask-input', termAsk.block); // 开始打字 → 焦点导入自定义输入框(focus 先于默认动作,字符落进框里)
        if (inp) inp.focus();
        return;
      }
    }
    const hits = slashMatches();
    if (hits.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      slashIdx = e.key === 'ArrowUp' ? (slashIdx <= 0 ? hits.length - 1 : slashIdx - 1) : (slashIdx >= hits.length - 1 ? 0 : slashIdx + 1);
      renderSlashPop();
      return;
    }
    if (hits.length && e.key === 'Tab') {
      e.preventDefault();
      const pick = hits[slashIdx >= 0 ? slashIdx : 0];
      term.input.value = pick.cmd + ' ';
      closeSlashPop();
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      closeSlashPop();
      handleTermInput();
    }
  });
  // ⚙ 设置 = 精简模式出口(v0.52.0):先退出精简回到完整界面再开抽屉。
  // 旧行为把抽屉叠加在精简控制台上 —— 抽屉滑入动画触发 GPU 脏区,已隐藏的 #titlebar 旧帧透出(0.51.6 残影同族,用户实测)。
  // ↩ 退出按钮(v0.54.15,用户裁定:右下角原「⚙ 设置」改「退出」)= 直接退出精简模式回到完整界面;
  // /settings 元命令仍保留「退出 + 打开设置」语义(legacy 出口不动)
  $('#at-exit-btn', box).addEventListener('click', async () => {
    state.config = await liteapi.invoke('config:set', { ui: { pureTerminal: false } });
    applyUiMode();
    toast('已退出精简模式');
  });
}

async function exitLiteAndOpenSettings() {
  if ((state.config.ui || {}).pureTerminal) {
    state.config = await liteapi.invoke('config:set', { ui: { pureTerminal: false } });
    applyUiMode(); // syncPureTerminal 收掉控制台并恢复聊天界面,抽屉此后永远开在正常界面上
    toast('已退出精简模式');
  }
  openSettings();
}

function termLine(cls, prefix, text) {
  const div = document.createElement('div');
  div.className = cls;
  if (prefix) {
    const p = document.createElement('span');
    p.className = 'at-prefix';
    p.textContent = prefix;
    div.appendChild(p);
  }
  const t = document.createElement('span');
  t.textContent = text == null ? '' : String(text);
  div.appendChild(t);
  term.out.appendChild(div);
  termScroll();
  return div;
}

// —— 终端里的代码/HTML 展示(v0.56.5):整份 HTML 不再当纯文本倾泻 ——
// 围栏代码块或整段 HTML 文档 → 折叠卡片(语言/行数/复制/预览);普通文字仍用文本节点。
function termLooksLikeHtmlDoc(text) {
  const s = String(text || '');
  if (/<!doctype|<html[\s>]/i.test(s)) return true;
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return false;
  let tagLines = 0;
  for (const l of lines) if (/^\s*<\/?[a-z]/i.test(l)) tagLines++;
  return tagLines / lines.length > 0.4 && /<\/(body|html|head|div|section|main)>/i.test(s);
}

function termProseEl(text) {
  const d = document.createElement('div');
  d.className = 'at-prose';
  d.textContent = text.replace(/^\n+|\n+$/g, '');
  return d;
}

function termAppendHighlightedCode(el, code, lang) {
  const isHtml = /^(html?|xml|svg)$/i.test(lang || '') || termLooksLikeHtmlDoc(code);
  if (!isHtml) { el.textContent = code; return; }
  // HTML 词法高亮:标签/属性/字符串/注释分别上色(全部 textContent,不拼 innerHTML)
  const re = /(<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*|\/?>|[a-zA-Z][\w:-]*(?=\s*=)|"[^"]*"|'[^']*')/g;
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m.index > last) el.appendChild(document.createTextNode(code.slice(last, m.index)));
    const tok = m[0];
    const span = document.createElement('span');
    if (tok.startsWith('<!--')) span.className = 'c-com';
    else if (/^<\/?[a-zA-Z]/.test(tok) || tok === '>' || tok === '/>') span.className = 'c-tag';
    else if (tok.startsWith('"') || tok.startsWith("'")) span.className = 'c-str';
    else span.className = 'c-attr';
    span.textContent = tok;
    el.appendChild(span);
    last = m.index + tok.length;
  }
  if (last < code.length) el.appendChild(document.createTextNode(code.slice(last)));
}

function termCodeCard(lang, code) {
  const card = document.createElement('div');
  card.className = 'at-code';
  const lines = code.split('\n');
  const folded = lines.length > 14;
  if (folded) card.classList.add('folded');

  const head = document.createElement('div');
  head.className = 'at-code-head';
  const langEl = document.createElement('span');
  langEl.className = 'at-code-lang';
  langEl.textContent = (lang || (termLooksLikeHtmlDoc(code) ? 'html' : '代码')).toLowerCase();
  const meta = document.createElement('span');
  meta.className = 'at-code-meta';
  meta.textContent = `${lines.length} 行 · ${code.length} 字符`;
  head.appendChild(langEl);
  head.appendChild(meta);

  const mkBtn = (label, act) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'at-code-act';
    b.textContent = label;
    b.addEventListener('click', () => act(b));
    head.appendChild(b);
    return b;
  };
  mkBtn('复制', (b) => {
    navigator.clipboard.writeText(code).then(() => {
      b.textContent = '已复制';
      setTimeout(() => { b.textContent = '复制'; }, 1200);
    }).catch(() => toast('复制失败'));
  });
  const isHtml = /^(html?|xml|svg)$/i.test(lang || '') || termLooksLikeHtmlDoc(code);
  if (isHtml) mkBtn('▶ 预览', () => termPreviewHtml(code));
  if (folded) {
    mkBtn('展开', (b) => {
      const on = card.classList.toggle('folded');
      b.textContent = on ? '展开' : '收起';
    });
  }

  const body = document.createElement('pre');
  body.className = 'at-code-body';
  const codeEl = document.createElement('code');
  termAppendHighlightedCode(codeEl, code, lang);
  body.appendChild(codeEl);
  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function termPreviewHtml(code) {
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(code);
  if (document.body.classList.contains('pure-terminal')) {
    liteapi.invoke('config:set', { ui: { pureTerminal: false } }).then((cfg) => {
      state.config = cfg;
      applyUiMode();
      openInPanelBrowser(url);
      toast('已退出精简模式,在内置浏览器预览');
    }).catch(() => openInPanelBrowser(url));
  } else {
    openInPanelBrowser(url);
  }
}

// 把一条助手消息渲染成文字 + 代码卡片(流式结束后调用;历史重放同用)
function termRenderAssistantMarkup(line, text) {
  if (!line) return;
  const raw = String(text || '');
  line.innerHTML = '';
  line.classList.add('at-markup');
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  let found = false;
  while ((m = re.exec(raw))) {
    found = true;
    const before = raw.slice(last, m.index);
    if (before.trim()) line.appendChild(termProseEl(before));
    line.appendChild(termCodeCard((m[1] || '').trim(), m[2].replace(/\n$/, '')));
    last = m.index + m[0].length;
  }
  const tail = raw.slice(last);
  if (found) {
    if (tail.trim()) line.appendChild(termProseEl(tail));
  } else if (termLooksLikeHtmlDoc(raw)) {
    line.appendChild(termCodeCard('html', raw));
  } else {
    line.appendChild(termProseEl(raw));
  }
  termScroll();
}

function termScroll(force) {
  if (!term.out) return;
  if (force || term.stick) term.out.scrollTop = term.out.scrollHeight;
}

// 用户消息气泡(v0.54.19,条目①:OpenCode 风格)—— 左侧 accent 竖线 + 深底圆角框,替代裸 "❯ 文本" 行
function termUserLine(text) {
  const box = document.createElement('div');
  box.className = 'at-user';
  const bar = document.createElement('span');
  bar.className = 'at-user-bar';
  const body = document.createElement('div');
  body.className = 'at-user-body';
  body.textContent = text == null ? '' : String(text);
  box.appendChild(bar);
  box.appendChild(body);
  term.out.appendChild(box);
  termScroll();
  return box;
}

function termClear() {
  term.out.innerHTML = '';
  term.cur = null;
  term.shellBlock = null;
  termWaitClear(); // 流内等待行/计时一并收掉(v0.57.4)
  if (term.think) termThinkFreeze(); // 清屏时思考指示行一并定格清理
  termAsk = null;
}

// 看板娘「litey」(v0.54.0):精简模式的专属小生物 —— 小屏幕机器人,与图标同源设计。
// SVG 内嵌 + CSS 动画(眨眼/悬浮);perf-mode 关动画。每次清屏/进入时随横幅一起出现,输出多了自然滚走。
// 看板娘「litey」(v0.54.0):精简模式的专属小生物,双形态 ——
// ① svg = 小屏幕机器人(与图标同源);② pixel = 纯字符点阵(█ ░ ▐▌ 符号画,眼睛为独立字符格)。
// 眼神跟随:鼠标左右移动,两形态的眼睛都会看向鼠标方向(rAF 节流)。点击宠物或 /pet 切换,持久化 config.ui.petStyle。
const LITEY_SVG = `<svg viewBox="0 0 320 280" aria-label="litey">
  <rect x="58" y="58" width="204" height="172" rx="46" fill="#17171f" stroke="#22d3ee" stroke-width="12"/>
  <line x1="160" y1="58" x2="160" y2="28" stroke="#22d3ee" stroke-width="10" stroke-linecap="round"/>
  <circle cx="160" cy="20" r="11" fill="#22d3ee"/>
  <g class="pet-eyes">
    <rect class="pet-eye" x="110" y="118" width="32" height="46" rx="15" fill="#22d3ee"/>
    <rect class="pet-eye" x="178" y="118" width="32" height="46" rx="15" fill="#22d3ee"/>
  </g>
  <path d="M136 188 Q160 204 184 188" stroke="#22d3ee" stroke-width="9" fill="none" stroke-linecap="round"/>
  <rect x="102" y="230" width="28" height="32" rx="11" fill="#22d3ee"/>
  <rect x="190" y="230" width="28" height="32" rx="11" fill="#22d3ee"/>
  <rect x="98" y="262" width="36" height="12" rx="6" fill="#0e7490"/>
  <rect x="186" y="262" width="36" height="12" rx="6" fill="#0e7490"/>
</svg>`;

// 字符点阵形态:身体 = 块元素字符画(█ 实/░ 暗/▀▄ 圆角),眼睛 = 两个独立字符格(■),跟随鼠标左右换列
// 每行严格 12 字符宽(等宽字体对齐)
const PET_PIXEL_ROWS = [
  '  ▄▄▄▄▄▄▄▄  ',
  ' ██████████ ',
  ' █░░░░░░░░█ ',
  ' █░░░░░░░░█ ',
  ' █░░░░░░░░█ ',
  ' ██████████ ',
  '  ▀▀▀▀▀▀▀▀  ',
  '  ▄██▄▄██▄  ',
  '  ▀██▀▀██▀  ',
];
const PET_EYE_ROW = 2;          // 眼睛所在行(index)
const PET_EYE_BASE = [3, 7];    // 两眼基础列(脸区 2..9 内)
function pixelPetHTML() {
  return `<pre class="pet-pixel">${PET_PIXEL_ROWS.join('\n')}<span class="pp-eye" data-eye="0">■</span><span class="pp-eye" data-eye="1">■</span></pre><div class="at-pet-name">litey · ${t('点阵形态')}</div>`;
}

function termRenderPetInto(wrap) {
  const style = (state.config.ui || {}).petStyle || 'svg';
  wrap.classList.toggle('at-pet-pixel', style === 'pixel');
  wrap.innerHTML = style === 'pixel' ? pixelPetHTML() : `${LITEY_SVG}<div class="at-pet-name">litey · ${t('你的终端小助手')}</div>`;
  applyPetGaze(); // 按当前鼠标位置立即对焦
}

function termPrintPet() {
  if (!term.out) return;
  const wrap = document.createElement('div');
  wrap.className = 'at-pet';
  wrap.title = t('点击切换看板娘形态');
  wrap.addEventListener('click', togglePetStyle);
  termRenderPetInto(wrap);
  term.out.appendChild(wrap);
}

function togglePetStyle() {
  const cur = (state.config.ui || {}).petStyle || 'svg';
  liteapi.invoke('config:set', { ui: { petStyle: cur === 'svg' ? 'pixel' : 'svg' } }).then((c) => {
    state.config = c;
    const wrap = $('#at-out .at-pet');
    if (wrap) termRenderPetInto(wrap);
    toast(t(c.ui.petStyle === 'pixel' ? '看板娘已切换:点阵形态' : '看板娘已切换:机器人形态'));
  });
}

// 眼神跟随:鼠标相对宠物中心水平偏移 → 眼睛偏移(SVG 平移 px;点阵换列,clamp ±2 格)
// 直接在 mousemove 同步执行(计算轻量);不走 rAF —— 被遮挡窗口的 rAF 会被节流,眼神就"死"了(冒烟 flaky 锚定)
function applyPetGaze(clientX) {
  const wrap = $('#at-out .at-pet');
  if (!wrap || !wrap.isConnected) return;
  const rect = wrap.getBoundingClientRect();
  const dx = ((clientX != null ? clientX : (window.innerWidth / 2)) - (rect.left + rect.width / 2)) / window.innerWidth; // 约 -0.5..0.5
  const shift = Math.max(-1, Math.min(1, dx * 3)); // -1..1
  const pixel = wrap.classList.contains('at-pet-pixel');
  if (pixel) {
    const col = Math.round(shift * 2); // -2..2 格
    wrap.querySelectorAll('.pp-eye').forEach((eye, i) => {
      eye.style.left = (PET_EYE_BASE[i] + col) + 'ch';
    });
  } else {
    const px = Math.round(shift * 9); // -9..9 px
    wrap.querySelectorAll('.pet-eye').forEach((eye) => {
      eye.style.transform = `translateX(${px}px)`;
    });
  }
}
document.addEventListener('mousemove', (e) => {
  if (!term.active) return;
  applyPetGaze(e.clientX);
});

function termPrintBanner() {
  termPrintPet();
  termLine('at-meta', null, `LiteAgent v${state.appVersion || '?'} 精简模式 —— 这是一个完整的智能体:直接输入即与 AI 对话,可创建内容、执行任务`);
  termLine('at-meta', null, '输入 /help 查看全部命令;!cmd 执行 shell 命令;⚙ 设置 或 /exit 返回完整界面');
}

async function openTermConsole() {
  term.active = true;
  $('#agent-term').classList.remove('hidden');
  termClear();
  termPrintBanner();
  // v0.51.7:进入终端无当前会话 → 自动恢复最近会话(否则任务记录"消失"在侧栏里)
  if (!state.conv) {
    try {
      const list = await liteapi.invoke('convs:list');
      if (list.length) await openConv(list[0].id);
    } catch (_) { /* 无历史则空屏 */ }
  }
  termRenderMsgs(state.conv);
  termScroll(true);
  term.input.focus();
  updateTermStatus(); // 标签栏与状态栏初值(无会话恢复路径不会经过 renderSidebar/renderUsageBar)
}

function closeTermConsole() {
  term.active = false;
  $('#agent-term').classList.add('hidden');
}

// 把已落盘会话重放进控制台(openConv/分支切换/退出重放共用;会先清屏)
function renderTermConv(conv) {
  if (!term.active) return;
  termClear();
  termRenderMsgs(conv);
}

// 历史重放的块归一化(v0.57.3,仅纯状态模式):把相邻的 text/reasoning 连续段合并成
// 「一段思考 + 一段正文」。否则「正文 → 思考 → 正文」的交错形态重放时会把答案劈成两半、
// 思考完成跑到中间(与在线渲染不一致)。
function termGroupBlocks(blocks) {
  const out = [];
  let texts = null;
  let reasons = null;
  const flush = () => {
    if (reasons && (reasons.content || '').trim()) out.push(reasons);
    if (texts && (texts.content || '').trim()) out.push(texts);
    texts = null;
    reasons = null;
  };
  for (const b of blocks || []) {
    if (b.type === 'text' || b.type === 'reasoning') {
      if (b.type === 'text') {
        if (!texts) texts = { type: 'text', content: '' };
        texts.content += b.content || '';
      } else {
        if (!reasons) reasons = { type: 'reasoning', content: '' };
        reasons.content += b.content || '';
      }
    } else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

function termRenderMsgs(conv) {
  if (!conv || !conv.messages || !conv.messages.length) {
    updateTermStatus();
    return;
  }
  for (const m of conv.messages) {
    if (m.role === 'user') {
      termUserLine(m.content || '');
      if ((m.attachments || []).length) termLine('at-meta', null, `  📎 ${m.attachments.length} 个附件`);
      continue;
    }
    if (m.role !== 'assistant') continue;
    const blocks = termReasonView() === 'status' ? termGroupBlocks(m.blocks || []) : (m.blocks || []);
    for (const b of blocks) {
      if (b.type === 'text') {
        const line = termLine('at-assistant', null, '');
        termRenderAssistantMarkup(line, b.content || '');
      }
      else if (b.type === 'reasoning') {
        // 纯状态模式下历史思考链也折叠成「+ 思考完成」开关(点开即看);思考链模式照常直出
        if (termReasonView() === 'status' && (b.content || '').trim()) term.out.appendChild(termThoughtToggle(b.content, ''));
        else termLine('at-reasoning', null, b.content || '');
      }
      else if (b.type === 'tool') {
        const line = termLine('at-tool', '⚙ ', `${b.name || ''} ${toolBrief(b.name, b.args)}`.trim() + ' ');
        const st = document.createElement('span');
        st.className = 'at-st';
        st.textContent = TOOL_STATE_TEXT[b.status] || b.status || '';
        line.appendChild(st);
        if ((b.status === 'error' || b.status === 'denied') && b.result) {
          termLine('at-tool-result', null, String(b.result).slice(-400));
        }
      } else if (b.type === 'ask') {
        // 历史问询:折叠问答摘要(条目④同款形态)
        const el = document.createElement('div');
        el.className = 'at-ask done';
        const ans = b.answerKind === 'opt' && (b.options || [])[b.answerIndex]
          ? `选择:${b.options[b.answerIndex].label}`
          : (b.answerKind === 'free' && b.answerText ? `${t('自填')}:${b.answerText}` : (b.answerDisplay || t('未回答')));
        el.innerHTML = `<div class="at-q">❓ ${escapeHtml(b.question || '')}</div><div class="at-a">→ ${escapeHtml(ans)}</div>`;
        term.out.appendChild(el);
      } else if (b.type === 'error') {
        termLine('at-error', null, '⚠ ' + (b.message || ''));
      }
    }
  }
  updateTermStatus();
}

// 终端流的当前行上下文:统一补齐字段(旧代码路径如 termAskUser/tool-start 创建的 cur 没有新字段,
// 直接 .lines.push 会抛 —— v0.57.3)
function termCurEnsure() {
  if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map(), roundText: '', lines: [], thinkRow: null };
  if (!term.cur.tools) term.cur.tools = new Map();
  if (!term.cur.asks) term.cur.asks = new Map();
  if (!term.cur.lines) term.cur.lines = [];
  if (typeof term.cur.roundText !== 'string') term.cur.roundText = '';
  return term.cur;
}

// —— 流内等待行(v0.57.4):等待响应/工具执行/等待审批期间,在输出流尾显示动画行 ——
// 旧行为只在底部状态栏有方块波浪,长任务(如 dispatch_agents 跑了 159s)时用户看着输出区
// 以为卡死;现在流内也有「[ * 等待响应 ] (12s)」,并随时间跳秒。
const termWait = { el: null, timer: 0, label: '', t0: 0, frame: 0 };
function termWaitPaint() {
  if (!termWait.el) return;
  const secs = Math.floor((Date.now() - termWait.t0) / 1000);
  termWait.el.textContent = `[ ${SPIN_THINK_FRAMES[termWait.frame % SPIN_THINK_FRAMES.length]} ${termWait.label} ] (${secs}s)`;
}
function termWaitSet(label) {
  if (!term.active || !label) return;
  if (!termWait.el) {
    const el = document.createElement('div');
    el.className = 'at-wait';
    term.out.appendChild(el);
    termWait.el = el;
    termWait.frame = 0;
    termWait.timer = setInterval(() => {
      if (!termWait.el || !termWait.el.isConnected) { termWaitClear(); return; }
      termWait.frame += 1;
      termWaitPaint();
      termScroll();
    }, 420);
  }
  // 文案变了(等待响应 → 执行 xxx)重置计时;同一文案持续跳秒
  if (termWait.label && termWait.label !== label) termWait.t0 = Date.now();
  termWait.label = label;
  if (!termWait.t0) termWait.t0 = Date.now();
  termWait.el.style.display = '';
  if (term.out.lastElementChild !== termWait.el) term.out.appendChild(termWait.el); // 永远跟到流尾
  termWaitPaint();
  termScroll();
}
function termWaitClear() {
  if (termWait.timer) clearInterval(termWait.timer);
  termWait.timer = 0;
  termWait.t0 = 0;
  termWait.label = '';
  if (termWait.el) { try { termWait.el.remove(); } catch (_) {} }
  termWait.el = null;
}

// 流式事件 → 终端渲染(handleChatEvent 在 applyStreamEvent 之后调用;仅当前会话事件会到达这里)
function termApplyEvent(S, ev) {
  if (!term.active) return;
  switch (ev.type) {
    case 'text-delta': {
      if (term.cur && term.cur.reasoning) term.cur.reasoning = null; // 出正文即结束思考块(与聊天卡片行为一致)
      termThinkFreeze(); // 思考指示行定格(条目⑤)
      termSpinStop(); // 思考/等待动画结束:正文流式滚动本身就是可见反馈
      termWaitClear(); // 流内等待行让位给正文(否则它会被顶到正文下面)
      // 工具调用后的新文本段要另起一行(与聊天路径的 text.finalized 语义一致);
      // v0.57.3 修正:正文必须永远写在「流尾」—— 若当前正文行后面又追加了内容
      // (思考完成行/工具行/问询块/命令回显),就不能再往里写,否则新文本会回到上面旧行,
      // 表现为「思考完成在下面、结果却输出在上面」。同时保留 tools/asks 映射(不再整块重建 term.cur)。
      if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map(), roundText: '', lines: [], thinkRow: null };
      termCurEnsure();
      const prev = term.cur.text;
      const atTail = prev && prev === term.out.lastElementChild;
      const lastIsSpan = atTail && prev.lastChild && prev.lastChild.tagName === 'SPAN';
      if (!prev || prev.finalized || !lastIsSpan) {
        // 上一行已定格 = 新一轮(从头计,思考行链接也重置);
        // 否则是同轮内流尾被其他内容占据(思考/工具/问询插入) → 续起一行,思考行保持同轮归属
        if (prev && prev.finalized) {
          term.cur.roundText = '';
          term.cur.lines = [];
          term.cur.thinkRow = null;
        }
        term.cur.text = termLine('at-assistant', null, '');
        term.cur.lines.push({ el: term.cur.text, from: (term.cur.roundText || '').length, to: (term.cur.roundText || '').length });
      }
      term.cur.roundText = (term.cur.roundText || '') + ev.text;
      const tailSeg = term.cur.lines[term.cur.lines.length - 1];
      if (tailSeg) tailSeg.to = term.cur.roundText.length;
      term.cur.text.lastChild.textContent += ev.text;
      termScroll();
      break;
    }
    case 'text-end': {
      if (term.cur && term.cur.text) {
        // 整轮全文可能被拆到多行(思考/工具插在中间):每行只重渲染自己那段切片,避免重复。
        // 容错:若事件里的全文比本地累计短(中止/异常),以本地累计为准,否则切片会错位。
        const acc = String(term.cur.roundText || '');
        const evText = String(ev.content == null ? '' : ev.content);
        const full = evText.length >= acc.length ? evText : acc;
        const lines = term.cur.lines || [];
        if (lines.length > 1) {
          for (const seg of lines) {
            const a = Math.max(0, Math.min(seg.from, full.length));
            const b = Math.max(a, Math.min(seg.to, full.length));
            const segText = full.slice(a, b);
            if (segText.trim()) termRenderAssistantMarkup(seg.el, segText);
            else if (seg.el !== term.cur.text && seg.el.isConnected) seg.el.remove(); // 空段清掉,不留空行
          }
        } else {
          termRenderAssistantMarkup(term.cur.text, full);
        }
        term.cur.text.finalized = true;
      }
      break;
    }
    case 'reasoning-delta': {
      termSpinStart(t('思考中')); // 思考动画(状态栏方块波浪),出正文即停
      termWaitClear(); // 流内等待行让位给思考行(思考行自带计时动画)
      if (termReasonView() === 'status') {
        // 纯状态模式:只滚动 [* 思考中] (Ns) 动画行,不直接输出思考链(条目⑤/两模式设置);
        // 同一轮内若已有折叠行(思考晚到/分多段),把链并入那一行,不再新开一行把答案劈开。
        // 先建好 term.cur:否则首个思考行定格时无处挂 thinkRow,下一段思考会另开一行。
        if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map(), roundText: '', lines: [], thinkRow: null };
        termCurEnsure();
        // 上一行已定格 = 新的一轮(工具轮之间):清空本轮正文切片与思考行归属,
        // 新思考行重新落到流尾(即新轮正文之上),不合并到上一轮的折叠行里
        if (term.cur.text && term.cur.text.finalized) {
          term.cur.roundText = '';
          term.cur.lines = [];
          term.cur.thinkRow = null;
        }
        const sameRoundStreaming = !!(term.cur.text && !term.cur.text.finalized);
        if (term.cur.thinkRow && sameRoundStreaming && !term.think && term.cur.thinkRow.isConnected) {
          term.cur.thinkRow.appendChain(ev.text);
        } else {
          const th = termThinkEnsure();
          th.buf = (th.buf || '') + ev.text; // 链内容仍累积 —— 点「+ 思考完成」可展开查看(用户裁定 2026-10-25)
        }
      } else {
        if (!term.cur || !term.cur.reasoning) {
          if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map() };
          term.cur.reasoning = termLine('at-reasoning', null, '');
        }
        term.cur.reasoning.lastChild.textContent += ev.text;
      }
      termScroll();
      break;
    }
    case 'tool-start': {
      termThinkFreeze(); // 进入工具执行,思考期结束
      if (ev.name === 'ask_user') break;
      const line = termLine('at-tool', '⚙ ', `${ev.name || ''} ${toolBrief(ev.name, ev.args)}`.trim() + ' ');
      const st = document.createElement('span');
      st.className = 'at-st';
      st.textContent = TOOL_STATE_TEXT[ev.status] || ev.status || '';
      line.appendChild(st);
      // 工具执行期间必须持续有「在动」的提示(v0.57.4):以前这里 termSpinStop,长工具(dispatch 159s)
      // 就变成一块不动的静态文字,用户以为卡死。现在状态栏 + 流内等待行都保持
      termSpinStart(ev.status === 'awaiting' ? t('等待审批') : `${t('执行')} ${ev.name || ''}`.trim());
      termWaitSet(ev.status === 'awaiting' ? t('等待审批') : `${t('执行')} ${ev.name || ''}`.trim());
      if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map() };
      term.cur.tools.set(ev.toolCallId, { line, st });
      if (ev.status === 'awaiting') termAppendApprove(S, line, ev.toolCallId);
      break;
    }
    case 'tool-end': {
      if (ev.name === 'ask_user') {
        // 问询被中止(用户停止任务):未回答的问询块收敛为「已停止」摘要
        if (termAsk && termAsk.toolCallId === ev.toolCallId && !termAsk.answered) {
          const a = termAsk;
          termAsk = null;
          a.answered = true;
          a.block.classList.add('done');
          a.block.innerHTML = `<div class="at-q">${escapeHtml(a.q.question || '')}</div><div class="at-a">${escapeHtml(t('已停止'))}</div>`;
        }
        break;
      }
      const entry = term.cur && term.cur.tools.get(ev.toolCallId);
      if (!entry) break;
      entry.st.textContent = TOOL_STATE_TEXT[ev.status] || ev.status || '';
      entry.line.className = `at-tool st-${ev.status}`;
      if (ev.status === 'error' && ev.result) termLine('at-tool-result', null, String(ev.result).slice(-400));
      // 工具结束后模型还要跑下一轮(v0.57.4):继续给等待提示,别让屏幕“静止”
      if (ev.status === 'error' || ev.status === 'denied' || ev.status === 'aborted') {
        termSpinStop();
        termWaitClear();
      } else {
        termSpinStart(t('等待响应'));
        termWaitSet(t('等待响应'));
      }
      break;
    }
    case 'ask-user': {
      termAskUser(S, ev);
      termWaitClear(); // 问询块自带交互(选项 + 自填行),不再叠等待行
      termSpinStart(t('等待你的选择'));
      break;
    }
    case 'error': {
      termWaitClear();
      termSpinStop();
      termLine('at-error', null, '⚠ ' + (ev.message || '未知错误'));
      break;
    }
    case 'mcp-note': {
      termLine('at-meta', null, ev.message || '');
      break;
    }
    case 'compress-note': {
      if (ev.stage === 'done') termLine('at-meta', null, '已自动压缩上下文:旧对话已生成摘要');
      break;
    }
    default:
      break;
  }
}

function termAppendApprove(S, line, toolCallId) {
  const row = document.createElement('div');
  row.className = 'at-approve';
  const ok = document.createElement('button');
  ok.className = 'at-opt at-inline';
  ok.textContent = '[ 批准执行 ]';
  const no = document.createElement('button');
  no.className = 'at-opt at-inline';
  no.textContent = '[ 拒绝 ]';
  const decide = (approved) => {
    ok.disabled = no.disabled = true;
    liteapi.invoke('tool:decision', { streamId: S.streamId, toolCallId, approved });
    termLine('at-meta', null, approved ? '已批准' : '已拒绝');
    // 审批后继续给等待提示(v0.57.4):批准 = 执行中;拒绝 = 回模型继续
    if (approved) { termSpinStart(t('执行')); termWaitSet(t('执行')); }
    else { termSpinStart(t('等待响应')); termWaitSet(t('等待响应')); }
  };
  ok.addEventListener('click', () => decide(true));
  no.addEventListener('click', () => decide(false));
  row.appendChild(ok);
  row.appendChild(no);
  term.out.appendChild(row);
  termScroll();
}

// —— 终端问询 TUI(v0.54.19 条目②③④,OpenCode 风格)——
// 纵向选项行(数字标号+副标题+推荐徽章),末尾固定「自定义输入」行(内嵌输入框);
// ↑↓ 移动 / 回车确认 / 数字直达 / 鼠标点选 / Esc 收起(点问题重开);
// 回答后整块折叠为「问题 → 已选答案」摘要永久留在终端流里,未选选项消失。
let termAsk = null; // { block, q, opts, idx, streamId, toolCallId, answered, folded }

function termAskRender() {
  const a = termAsk;
  if (!a) return;
  const rows = a.opts.map((o, i) =>
    `<div class="at-ask-opt${askIsRecommended(o.label) ? ' rec' : ''}" data-i="${i}">`
    + `<span class="at-ask-arrow"> </span><span class="at-ask-num">${i + 1}.</span>`
    + `<span class="at-ask-main"><b>${escapeHtml(o.label || '')}</b>${o.detail ? `<span class="at-ask-sub">${escapeHtml(o.detail)}</span>` : ''}</span>`
    + `</div>`).join('');
  const ci = a.opts.length;
  a.block.classList.remove('done', 'folded');
  a.block.innerHTML = `<div class="at-q">❓ ${escapeHtml(a.q.question || t('请做出选择'))}</div>`
    + (a.q.context ? `<div class="at-ctx">${escapeHtml(a.q.context)}</div>` : '')
    + `<div class="at-ask-opts">${rows}`
    + `<div class="at-ask-opt at-ask-custom" data-i="${ci}">`
    + `<span class="at-ask-arrow"> </span><span class="at-ask-num">✍</span>`
    + `<span class="at-ask-main at-ask-freewrap"><input type="text" class="at-ask-input" placeholder="${escapeHtml(t('输入你自己的答案,回车提交'))}"></span>`
    + `</div></div>`
    + `<div class="at-ask-hint">${escapeHtml(t('↑↓ 选择 · 回车确认 · 数字直达 · 直接输入即自定义 · Esc 收起'))}</div>`;
  $$('.at-ask-opt', a.block).forEach((el) => {
    const i = parseInt(el.dataset.i, 10);
    el.addEventListener('mouseenter', () => { a.idx = i; termAskHighlight(); });
    if (i < a.opts.length) {
      el.addEventListener('mousedown', (e) => e.preventDefault()); // 抢在输入框失焦前(选择点击)
      el.addEventListener('click', () => { a.idx = i; termAskCommit(); });
    }
  });
  const inp = $('.at-ask-input', a.block);
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = inp.value.trim();
      if (v) termAskAnswer('free:' + v, `${t('自填')}:${v}`);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      inp.blur();
      term.input.focus();
    }
  });
  inp.addEventListener('focus', () => { a.idx = a.opts.length; termAskHighlight(); });
  termAskHighlight();
  termScroll();
}

function termAskHighlight() { // 只切换高亮类,不重建 DOM(保住自定义输入框的焦点与已输入内容)
  const a = termAsk;
  if (!a) return;
  $$('.at-ask-opt', a.block).forEach((el) => {
    const on = parseInt(el.dataset.i, 10) === a.idx;
    el.classList.toggle('on', on);
    const arrow = $('.at-ask-arrow', el);
    if (arrow) arrow.textContent = on ? '❯' : ' ';
  });
}

function termAskMove(d) {
  const a = termAsk;
  if (!a) return;
  const n = a.opts.length + 1;
  a.idx = (a.idx + d + n) % n;
  termAskHighlight();
}

async function termAskCommit() {
  const a = termAsk;
  if (!a) return;
  if (a.idx < a.opts.length) {
    const o = a.opts[a.idx] || {};
    termAskAnswer('opt:' + a.idx, `选择:${o.label || ''}`);
  } else {
    const inp = $('.at-ask-input', a.block);
    if (inp) inp.focus(); // 自定义行回车 → 聚焦输入框继续输入
  }
}

function termAskAnswer(enc, display) {
  const a = termAsk;
  if (!a || a.answered) return;
  a.answered = true;
  liteapi.invoke('ask:answer', { streamId: a.streamId, toolCallId: a.toolCallId, answer: enc }).catch(() => {}); // 流已不存在(中止/探针)时静默
  termAsk = null;
  // 条目④:折叠为问答摘要(未选选项消失,答案以暗色留在问题下方)
  a.block.classList.add('done');
  a.block.innerHTML = `<div class="at-q">❓ ${escapeHtml(a.q.question || '')}</div><div class="at-a">→ ${escapeHtml(display)}</div>`;
  termScroll();
  term.input.focus();
  // 回答后模型继续跑(v0.57.4):恢复等待提示
  termSpinStart(t('等待响应'));
  termWaitSet(t('等待响应'));
}

function termAskFold() { // Esc:收起选项(问询仍挂起,点击问题块重开)
  const a = termAsk;
  if (!a || a.answered) return;
  a.folded = true;
  termAsk = null; // 挂起态不占键盘(重开时在点击处理器里再挂回)
  a.block.classList.add('folded');
  a.block.innerHTML = `<div class="at-q">❓ ${escapeHtml(a.q.question || '')}</div><div class="at-a pending">${escapeHtml(t('未回答 — 点击此处重新选择'))}</div>`;
  a.block.addEventListener('click', () => {
    if (termAsk || a.answered) return;
    termAsk = a;
    a.folded = false;
    termAskRender();
    term.input.focus();
  });
  termScroll();
}

function termAskUser(S, ev) {
  if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map() };
  if (termAsk) termAskFold(); // 上一问未答又来新问(少见):先收起旧的
  const block = document.createElement('div');
  block.className = 'at-ask';
  term.out.appendChild(block);
  termAsk = {
    block, q: ev, opts: ev.options || [], idx: 0,
    streamId: S.streamId, toolCallId: ev.toolCallId,
    answered: false, folded: false,
  };
  term.input.value = ''; // 等待回答期间主输入行清空(字符会自动导入自定义输入框)
  termAskRender();
  term.input.focus();
}

// —— 终端流内思考指示器(条目⑤):[ * 思考中 ] (Ns) —— 符号按 * → ... → .. → . 循环,右侧秒数实时跳;
//    结束定格为「+ 思考完成 · Ns」折叠开关,点击展开思考链(用户裁定:想看链仅需点一下 Thought)
const SPIN_THINK_FRAMES = ['*', '...', '..', '.'];
function termReasonView() { return (state.config.ui || {}).termReasonView || 'chain'; } // chain=思考链(默认) / status=纯状态
function termThinkEnsure() {
  if (term.think) return term.think;
  const el = document.createElement('div');
  el.className = 'at-think-live';
  // 思考晚于正文(v0.57.3):插到本轮正文第一行之前 —— 否则「思考完成」会跑到已输出的答案下面
  const firstLine = term.cur && term.cur.lines && term.cur.lines[0] && term.cur.lines[0].el;
  if (firstLine && firstLine.isConnected) term.out.insertBefore(el, firstLine);
  else term.out.appendChild(el);
  const th = { el, t0: Date.now(), frame: 0, timer: 0, buf: '' };
  const paint = () => {
    el.textContent = `[ ${SPIN_THINK_FRAMES[th.frame % SPIN_THINK_FRAMES.length]} ${t('思考中')} ] (${Math.floor((Date.now() - th.t0) / 1000)}s)`;
  };
  paint();
  th.timer = setInterval(() => { th.frame += 1; paint(); }, 420);
  term.think = th;
  termScroll();
  return th;
}
// 折叠开关:「+ 思考完成 · Ns」↔「- 思考完成 · Ns」,点开显示思考链(暗色缩进,OpenCode 的 Thought 折叠)
function termThoughtToggle(buf, secs) {
  const wrap = document.createElement('div');
  wrap.className = 'at-think-done at-think-toggle';
  const head = document.createElement('div');
  head.className = 'at-think-head';
  const body = document.createElement('div');
  body.className = 'at-think-chain hidden';
  body.textContent = buf || '';
  const label = () => `${body.classList.contains('hidden') ? '+' : '-'} ${t('思考完成')}${secs ? ' · ' + secs + 's' : ''}`;
  head.textContent = label();
  head.addEventListener('click', () => {
    body.classList.toggle('hidden');
    head.textContent = label();
    termScroll();
  });
  wrap.appendChild(head);
  if (buf) wrap.appendChild(body);
  // 同轮后续思考并入本行(不新开一行,否则会把答案从中间劈开)
  wrap.appendChain = (txt) => {
    body.textContent = (body.textContent || '') + txt;
    if (!body.isConnected) wrap.appendChild(body);
  };
  return wrap;
}
function termThinkFreeze() { // 思考结束:定格为可展开的「+ 思考完成 · Ns」留在流里
  if (!term.think) return;
  const th = term.think;
  term.think = null;
  clearInterval(th.timer);
  const secs = Math.max(1, Math.round((Date.now() - th.t0) / 1000));
  const toggle = termThoughtToggle(th.buf || '', secs);
  th.el.replaceWith(toggle);
  if (term.cur) term.cur.thinkRow = toggle; // 本轮折叠行(后续思考并入这里)
  termScroll();
}

// done/出错收尾:打印耗时与用量行(与聊天界面的 turn-meta 对应)
function termFinish(ev) {
  if (!term.active) return;
  termThinkFreeze(); // 收尾兜底:思考指示行定格(条目⑤)
  termWaitClear(); // 流内等待行收尾(v0.57.4)
  const bits = [];
  if (ev.aborted) bits.push('已停止');
  if (ev.ms) bits.push(fmtMs(ev.ms));
  const u = fmtUsage(ev.usage);
  if (u) bits.push(u);
  if (bits.length) termLine('at-meta', null, bits.join(' · '));
  updateTermStatus();
}

function updateTermStatus() {
  if (!term.active) return;
  const left = $('#at-st-left');
  const right = $('#at-st-right');
  if (!left) return;
  const title = (state.conv && (state.conv.title || t('未命名对话'))) || t('新对话');
  const mode = t(MODE_SHORT[state.config.ui.mode] || '对话');
  const lm = currentModel();
  const model = lm ? lm.model : '未选择模型';
  const bits = [`${title} · ${isZhLang() ? mode + '模式' : mode} · ${model}`];
  if (state.conv) bits.push(`#${String(state.conv.id).slice(0, 8)}`); // 当前对话 UID 短码(完整 ID 用 /id 查看)
  if (termSpin.label) {
    // 等待动画(v0.54.17 方块波浪;v0.54.18 /spin 可调色):innerHTML 中除自产 span 外全部 escapeHtml
    // v0.57.4:动画与文案放最前 —— 长会话标题会把尾巴挤出去,造成「等待提示被吞掉」的错觉
    left.innerHTML = `${termSpinHtml()}${escapeHtml(' ' + termSpin.label)}${escapeHtml(' · ' + bits.join(' · '))}`;
  } else {
    if (state.conv && state.streams.has(state.conv.id)) bits.push(t('● 回复中'));
    left.textContent = bits.join(' · ');
  }
  const cx = state.conv && state.conv.ctx;
  right.textContent = cx && cx.tokens ? `${t('上下文')} ~${fmtTok(cx.tokens)} tok/${cx.messages}${t('条')}` : '';
  renderTermTabs(); // 标签栏跟随会话列表/切换/流式状态刷新(updateTermStatus 已挂在所有变化点)
}

/* —— 精简模式对话标签栏(v0.52.0):浏览器式多标签 = 多对话窗口并行操作 —— */
function renderTermTabs() {
  if (!term.active) return;
  const holder = $('#at-tabs-scroll');
  if (!holder) return;
  const cur = state.conv && state.conv.id;
  holder.innerHTML = state.convs.slice(0, 12).map((c) => `
    <div class="at-tab ${cur === c.id ? 'active' : ''}" data-conv-id="${c.id}" title="${escapeHtml(c.title || t('未命名对话'))}">
      <span class="at-tab-title">${escapeHtml(c.title || t('未命名对话'))}</span>
      ${state.streams.has(c.id) ? '<span class="at-tab-live"></span>' : ''}
      <span class="at-tab-close" data-close="${c.id}" title="${t('删除')}">×</span>
    </div>`).join('');
}

/* —— 精简模式状态栏 spinner(v0.54.17 六方块波浪;v0.54.18 拉长至 8 块 + /spin HDR 调色盘)——
   一排圆角小方块,亮点(head)每 120ms 右移一格循环,身后尾迹亮度逐格衰减,head 微放大+光晕;
   颜色默认跟随主题 accent,终端内 /spin 打开调色盘实时预览(存 config.ui.termSpinColor)。 */
const SPIN_BLOCKS = 8;
const SPIN_TRAIL = [1, 0.76, 0.6, 0.5, 0.42, 0.36, 0.31, 0.27]; // d=0(head) 最亮,尾迹逐格衰减(下限 0.27 保底可见)
const SPIN_COLORS = [ // HDR 高饱和调色盘(c 进内联 style 前必须过 HEX 白名单,见 spinColorOk)
  { label: '默认 · 主题蓝', c: '' },
  { label: '霓虹青', c: '#22d3ee' },
  { label: '冰蓝', c: '#7dd3fc' },
  { label: '电光紫', c: '#8b5cf6' },
  { label: '品红', c: '#ff2fd6' },
  { label: '熔岩红', c: '#ff3b4e' },
  { label: '炽焰橙', c: '#ff6b1a' },
  { label: '琥珀金', c: '#ffb020' },
  { label: '荧光柠檬', c: '#d4ff3f' },
  { label: '翠绿', c: '#22e08a' },
  { label: '冰白', c: '#eef6ff' },
];
let spinPreview = null; // 调色盘浏览中的实时预览色(null=未预览,用已存配置)
function spinColorOk(c) { return !c || /^#[0-9a-f]{3,8}$/i.test(c); } // ''=默认;否则合法 hex 才进 style 内联(防属性逃逸)
function currentSpinColor() { return spinPreview !== null ? spinPreview : ((state.config.ui && state.config.ui.termSpinColor) || ''); }
const termSpin = { timer: 0, label: '', frame: 0 };
function termSpinHtml(color) {
  const c = color === undefined ? currentSpinColor() : color;
  let html = '';
  for (let i = 0; i < SPIN_BLOCKS; i++) {
    const d = (termSpin.frame - i + SPIN_BLOCKS) % SPIN_BLOCKS; // 距 head 的步数(frame 已限 0..N-1)
    const op = SPIN_TRAIL[d] !== undefined ? SPIN_TRAIL[d] : SPIN_TRAIL[SPIN_TRAIL.length - 1];
    html += `<span class="atsb${d === 0 ? ' atsb-h' : ''}" style="opacity:${op}"></span>`;
  }
  return `<span class="atsb-row"${c && spinColorOk(c) ? ` style="--spin-c:${c}"` : ''}>${html}</span>`;
}
function refreshSpinPreviewRow() { // 调色盘内的大号实时预览,挂在动画 tick 上随波浪刷新
  const pv = document.querySelector('#at-pick-block .at-pick-preview');
  if (pv) pv.innerHTML = termSpinHtml();
}
function termSpinStart(label) {
  if (!term.active || !label) return;
  termSpin.label = label; // 同一动画期内可换文案(等待响应 → 思考中),计时器不重启
  if (termSpin.timer) return;
  termSpin.timer = setInterval(() => {
    termSpin.frame = (termSpin.frame + 1) % SPIN_BLOCKS;
    updateTermStatus();
    refreshSpinPreviewRow();
  }, 120);
  updateTermStatus();
}
function termSpinStop() {
  if (!termSpin.timer && !termSpin.label) return;
  if (termSpin.timer) clearInterval(termSpin.timer);
  termSpin.timer = 0;
  termSpin.label = '';
  updateTermStatus();
}

/* —— /spin 调色盘(v0.54.18):终端内调等待动画颜色,HDR 高饱和预设 + 实时预览 —— */
async function applySpinColor(item) {
  if (!spinColorOk(item.c)) { termLine('at-error', null, t('未知颜色,输入 /spin 打开调色盘')); return; }
  spinPreview = null;
  state.config = await liteapi.invoke('config:set', { ui: { termSpinColor: item.c } });
  updateTermStatus();
  termLine('at-meta', null, `${t('等待动画颜色已切换')}:${item.label}${item.c ? ` (${item.c.toUpperCase()})` : ` (${t('主题色')})`}`);
}

/* —— 终端选择高亮色(v0.54.20):默认琥珀黄(OpenCode 风,非主题蓝);/sel 独立调色,高亮行自身即实时预览 —— */
const TERM_SEL_DEFAULT = '#fbbf24';
const SEL_COLORS = [{ label: '默认 · 琥珀黄', c: '' }, ...SPIN_COLORS.slice(1)]; // 其余预设与 /spin 共用
let termSelPreview = null; // 调色盘浏览中的实时预览色(null=未预览)
function termSelColor() { return ((state.config.ui || {}).termSelColor) || TERM_SEL_DEFAULT; }
function textOnColor(hex) { // 亮底配深字,暗底配白字(用户自选深色时保可读)
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#1f1600';
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const lum = (0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16)) / 255;
  return lum > 0.56 ? '#1f1600' : '#f5f5f5';
}
function applyTermSelColor() {
  const host = document.getElementById('agent-term');
  if (!host) return;
  let c = termSelPreview !== null ? (termSelPreview || TERM_SEL_DEFAULT) : termSelColor();
  if (!spinColorOk(c)) c = TERM_SEL_DEFAULT;
  host.style.setProperty('--sel-c', c);
  host.style.setProperty('--sel-tc', textOnColor(c)); // 随底色明暗自动翻文字色
}
async function applySelColor(item) {
  if (!spinColorOk(item.c)) { termLine('at-error', null, t('未知颜色,输入 /sel 打开调色盘')); return; }
  termSelPreview = null;
  state.config = await liteapi.invoke('config:set', { ui: { termSelColor: item.c } });
  applyTermSelColor();
  termLine('at-meta', null, `${t('选择高亮颜色已切换')}:${item.label}${item.c ? ` (${item.c.toUpperCase()})` : ` (${t('默认')})`}`);
}
function openSelPicker() {
  const cur = (state.config.ui || {}).termSelColor || '';
  termOpenPicker({
    title: t('选择高亮颜色 · HDR 调色盘'),
    items: SEL_COLORS.map((x) => ({
      label: x.label, c: x.c,
      sub: x.c ? x.c.toUpperCase() : t('默认'),
      swatch: x.c || TERM_SEL_DEFAULT,
      active: x.c === cur,
    })),
    onPreview: (it) => { termSelPreview = it.c || TERM_SEL_DEFAULT; applyTermSelColor(); }, // 调色盘自己的高亮行实时变色
    onPick: async (it) => applySelColor(it),
    onCancel: () => { termSelPreview = null; applyTermSelColor(); },
  });
}
function openSpinPicker() {
  const cur = (state.config.ui && state.config.ui.termSpinColor) || '';
  const wasRunning = !!termSpin.timer; // 调色盘结束时不误停本来就在跑的等待动画
  if (!wasRunning) termSpinStart(t('预览'));
  termOpenPicker({
    title: t('等待动画颜色 · HDR 调色盘'),
    preview: true,
    items: SPIN_COLORS.map((x) => ({
      label: x.label, c: x.c,
      sub: x.c ? x.c.toUpperCase() : t('主题色'),
      swatch: x.c || 'var(--accent)',
      active: x.c === cur,
    })),
    onPreview: (it) => { spinPreview = it.c; updateTermStatus(); refreshSpinPreviewRow(); },
    onPick: async (it) => { await applySpinColor(it); if (!wasRunning) termSpinStop(); },
    onCancel: () => { spinPreview = null; if (!wasRunning) termSpinStop(); else updateTermStatus(); },
  });
}

/* ---- 终端输入分发:! shell / / 元命令 / 其余=AI 对话 ---- */
function handleTermInput() {
  const sp = document.getElementById('at-slash-pop');
  if (sp) sp.classList.add('hidden'); // 执行前收起补全(v0.51.4)
  const raw = term.input.value;
  term.input.value = '';
  if (!raw.trim()) {
    // 只拖了附件、没输入文字:也允许直接发送(与标准模式一致)
    if (state.pendingAttachments.length) termSend('');
    return;
  }
  if (raw.startsWith('!')) { termRunShell(raw.slice(1)); return; }
  if (raw.startsWith('/')) { termRunMeta(raw.trim()); return; }
  termSend(raw.trim());
}

async function termSend(text) {
  const label = text || (state.pendingAttachments.length ? `📎 ${state.pendingAttachments.length} 个附件` : '');
  termUserLine(label); // 用户消息气泡(条目①)
  termSpinStart(t('等待响应')); // 首增量到达前的空窗(reasoning/text/tool 任一事件都会接管或停止)
  termWaitSet(t('等待响应')); // 流内也提示(v0.57.4):否则首 token 前几十秒屏幕一片静止
  try {
    await submit(text);
  } catch (e) {
    // 发送直接失败(未选模型/校验不过):必须收掉等待提示,否则会永远转下去
    termWaitClear();
    termSpinStop();
    termLine('at-error', null, '⚠ ' + ((e && e.message) || e));
    return;
  }
  // submit 内部报错只弹 toast 的情况下(未开流),同样收掉等待提示
  if (!(state.conv && state.streams.has(state.conv.id))) {
    termWaitClear();
    termSpinStop();
  }
}

function termRunShell(cmd) {
  termLine('at-shell-cmd', '$ ', cmd);
  term.shellBlock = termLine('at-shell', null, '');
  liteapi.invoke('term:write', cmd);
}

// onTermEvent 路由:控制台激活时 shell 输出打进当前 ! 命令块
function termShellAppend(text) {
  if (!term.shellBlock || !term.shellBlock.isConnected) {
    term.shellBlock = termLine('at-shell', null, '');
  }
  term.shellBlock.lastChild.textContent += text;
  termScroll();
}

async function termRunMeta(raw) {
  const sp = raw.indexOf(' ');
  const cmd = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? '' : raw.slice(sp + 1).trim();
  termUserLine(raw); // 用户输入气泡(命令回显同款形态)
  if (cmd === '/help') {
    for (const l of TERM_HELP_LINES) termLine('at-meta', null, l);
  } else if (cmd === '/new') {
    state.conv = null;
    state.pendingGroupId = 'default';
    renderSidebar();
    renderUsageBar(); // 新会话:清残留(v0.50.1)
    renderSubagentPill(true);
    termClear();
    termPrintBanner();
    termLine('at-meta', null, '已开始新对话(发送第一条消息即创建)');
  } else if (cmd === '/conv') {
    if (!arg) {
      const list = state.convs.slice(0, 20);
      if (!list.length) termLine('at-meta', null, '(暂无历史会话)');
      else {
        termLine('at-meta', null, '最近会话(/conv 序号 切换):');
        list.forEach((c, i) => termLine('at-meta', null, `  ${i + 1}. ${c.title || '未命名'}`));
      }
    } else {
      const c = state.convs[parseInt(arg, 10) - 1];
      if (!c) termLine('at-error', null, `找不到第 ${arg} 个会话(/conv 先查看列表)`);
      else await openConv(c.id);
    }
  } else if (cmd === '/mode') {
    if (!arg) {
      // 交互式选择器:↑↓ 高亮(❯ 箭头)+ 回车确认 + 鼠标点击;带参直达用法保留(/mode 完全)
      termOpenPicker({
        title: t('选择模式'),
        items: MODE_META.map((m) => ({ label: m.label, sub: MODE_DESC[m.id], active: m.id === state.config.ui.mode, id: m.id })),
        onPick: async (it) => {
          state.config = await liteapi.invoke('config:set', { ui: { mode: it.id } });
          fillModeSelect();
          updateStatusHint();
          termLine('at-meta', null, `已切换:${MODE_DESC[it.id]}`);
        },
      });
    } else {
      const m = MODE_META.find((x) => x.id === arg || MODE_SHORT[x.id] === arg || x.label.includes(arg));
      if (!m) termLine('at-error', null, `未知模式「${arg}」:/mode 对话|受限|完全|创造`);
      else {
        state.config = await liteapi.invoke('config:set', { ui: { mode: m.id } });
        fillModeSelect();
        updateStatusHint();
        termLine('at-meta', null, `已切换:${MODE_DESC[m.id]}`);
      }
    }
  } else if (cmd === '/model') {
    // /model(v0.51.2):无参呼出两步级联 TUI(先供应商 → 再模型);带参模糊匹配直达(applyModelChoice 正规路径)
    const choices = state.modelChoices || [];
    if (!arg) {
      if (!choices.length) { termLine('at-error', null, '尚未配置模型,请到 设置 → 模型 添加'); return; }
      openModelPicker();
    } else {
      const hits = choices.filter((c) => (c.providerName + '/' + c.model).toLowerCase().includes(arg.toLowerCase()));
      if (!hits.length) termLine('at-error', null, `没有匹配「${arg}」的模型`);
      else if (hits.length > 1) {
        termLine('at-meta', null, `匹配到 ${hits.length} 个,请用更完整的名称:`);
        for (const c of hits.slice(0, 10)) termLine('at-meta', null, `  ${c.providerName}/${c.model}`);
      } else {
        const c = hits[0];
        applyModelChoice(c.providerId, c.model);
        termLine('at-meta', null, `${t('已切换到')} ${c.providerName}/${c.model}`);
      }
    }
  } else if (cmd === '/reason') {
    // /reason(v0.51.2):无参显示当前;带参按档位名切换(走滑块 commit 同款按模型记忆)
    const box = $('#reason-slider');
    const lm = state.config.lastModel || {};
    if (!arg) {
      const cur = state.reasonValue;
      termLine('at-meta', null, `当前思考强度:${typeof cur === 'number' ? t('自定义预算') + cur : (t(REASON_LABEL[cur] || cur) || '(未配置)')}`);
      termLine('at-meta', null, '切换:/reason 极简|低|中|高|超高|最大');
    } else if (!box || box.dataset.none === '1' || box.dataset.ready === '0') {
      termLine('at-error', null, '当前模型不支持思考强度调节');
    } else {
      const lvKey = Object.keys(REASON_LABEL).find((k) => REASON_LABEL[k] === arg || k === arg);
      const levels = (box.dataset.key ? (state.reasonCapsCache.get(box.dataset.key) || {}).levels : null) || [];
      const numeric = /^\d+$/.test(arg) ? parseInt(arg, 10) : null;
      if (numeric != null && box.dataset.ready === 'budget') {
        // 预算模式:数字 → 按模型记忆写预算
        const key = box.dataset.key;
        const rc = { ...(state.config.reasonChoice || {}), [key]: numeric };
        state.config = await liteapi.invoke('config:set', { reasonChoice: rc });
        state.reasonValue = numeric;
        termLine('at-meta', null, `${t('推理强度已设为:')}${t('自定义预算')} ${numeric} ${t('(按模型记忆)')}`);
      } else if (lvKey && levels.includes(lvKey)) {
        const commit = box && box._rsCommit;
        if (typeof commit === 'function') await commit(lvKey);
        else {
          const rc = { ...(state.config.reasonChoice || {}), [box.dataset.key]: lvKey };
          state.config = await liteapi.invoke('config:set', { reasonChoice: rc });
          state.reasonValue = lvKey;
        }
        termLine('at-meta', null, `${t('推理强度已设为:')}${t(REASON_LABEL[lvKey])}${t('(按模型记忆)')}`);
      } else {
        termLine('at-error', null, `档位「${arg}」不可用;可用:${levels.map((l) => REASON_LABEL[l] || l).join(' / ')}`);
      }
    }
  } else if (cmd === '/pet') {
    togglePetStyle();
    termLine('at-meta', null, t('看板娘已切换形态'));
  } else if (cmd === '/spin') {
    // /spin(v0.54.18):等待动画颜色 —— 无参开 HDR 调色盘(高亮即实时预览);带参按名称/十六进制直达
    if (!arg) { openSpinPicker(); return; }
    const a = arg.toLowerCase();
    if (/^#[0-9a-f]{3,8}$/i.test(arg)) { await applySpinColor({ label: arg, c: a }); return; }
    const hit = SPIN_COLORS.find((x) => x.label.toLowerCase().includes(a) || x.c.toLowerCase() === a);
    if (!hit) termLine('at-error', null, t('未知颜色,输入 /spin 打开调色盘'));
    else await applySpinColor(hit);
  } else if (cmd === '/think') {
    // /think(v0.54.19):终端思考显示两模式 —— chain=输出思考链(默认)/ status=纯状态行不输出思考链
    let v = '';
    if (!arg) v = termReasonView() === 'chain' ? 'status' : 'chain'; // 无参 = 在两模式间切换
    else if (arg === 'chain' || /链/.test(arg)) v = 'chain';
    else if (arg === 'status' || /状态/.test(arg)) v = 'status';
    if (!v) {
      termLine('at-meta', null, `${t('当前思考显示')}:${termReasonView() === 'chain' ? t('思考链(完整输出)') : t('纯状态(不输出思考链)')}`);
      termLine('at-meta', null, '切换:/think chain(思考链)| /think status(纯状态)| /think 无参切换');
    } else {
      state.config = await liteapi.invoke('config:set', { ui: { termReasonView: v } });
      termLine('at-meta', null, `${t('思考显示已切换')}:${v === 'chain' ? t('思考链(完整输出)') : t('纯状态(不输出思考链)')}`);
    }
  } else if (cmd === '/sel') {
    // /sel(v0.54.20):终端选择高亮色(问询选项/TUI 选择器的反色高亮行)—— 默认琥珀黄,独立于等待动画色
    if (!arg) { openSelPicker(); return; }
    const a = arg.toLowerCase();
    if (/^#[0-9a-f]{3,8}$/i.test(arg)) { await applySelColor({ label: arg, c: a }); return; }
    const hit = SEL_COLORS.find((x) => x.label.toLowerCase().includes(a) || x.c.toLowerCase() === a);
    if (!hit) termLine('at-error', null, t('未知颜色,输入 /sel 打开调色盘'));
    else await applySelColor(hit);
  } else if (cmd === '/id') {
    termLine('at-meta', null, state.conv
      ? `${t('对话 UID')}: ${state.conv.id}(${t('在控制台按住拖选即可复制')})`
      : t('还没有当前对话'));
  } else if (cmd === '/handover') {
    if (!arg) {
      termLine('at-error', null, '用法:/handover 对话ID(ID 可在对话条目上悬停查看或 ⧉ 复制,也可把对话直接拖入输入框)');
    } else {
      const old = await liteapi.invoke('convs:get', arg).catch(() => null);
      if (!old) termLine('at-error', null, `找不到该对话: ${arg}`);
      else await termSend(handoverText(old)); // 直接发送接手消息,完整链路落盘
    }
  } else if (cmd === '/settings') {
    // 同 ⚙ 按钮:先退出精简再开抽屉(设置不再叠加在精简控制台上,残影场景封死)
    termLine('at-meta', null, '正在退出精简模式并打开设置…');
    await exitLiteAndOpenSettings();
  } else if (cmd === '/img') {
    if (!arg) { termLine('at-meta', null, '用法:/img 画面描述'); }
    else {
      termLine('at-meta', null, `${t('生成图片中')}:${arg}`);
      try {
        const imgs = await liteapi.invoke('imagegen:generate', { prompt: arg });
        termLine('at-meta', null, `${t('已生成')} ${imgs.length} ${t('张图片')}(完整界面中查看)`);
        // 会话内落一份(终端模式双渲染:切回完整界面时可见)
        const conv = await ensureConvMirror();
        const turn = { role: 'assistant', blocks: [{ type: 'model-switch', model: `${t('图片生成')}/${(state.config.imageGen || {}).model || ''}` }] };
        for (const im of imgs) turn.blocks.push({ type: 'image', mime: im.mime, base64: im.base64 });
        conv.messages.push(turn);
        await liteapi.invoke('chat:saveNote', { convId: conv.id, note: turn });
      } catch (e) { termLine('at-error', null, String(e && e.message || e).slice(0, 160)); }
    }
  } else if (cmd === '/stop') {
    abortStreaming();
  } else if (cmd === '/clear') {
    termClear();
    termPrintBanner();
  } else if (cmd === '/exit') {
    state.config = await liteapi.invoke('config:set', { ui: { pureTerminal: false } });
    applyUiMode();
    toast('已退出精简模式');
  } else {
    termLine('at-error', null, `未知命令 ${cmd}(输入 /help 查看帮助)`);
  }
  updateTermStatus();
}


/* ================= 设置弹窗 ================= */
let settingsTab = 'providers';
let settingsSelProvider = null;
const oauthBusyMap = {}; // 供应商 OAuth 登录进行中(按 kind),登录卡据此禁用按钮并轮询进度
let presetsCache = null;
let saveTimer = null;

function openSettings() {
  panelWebHide(); // 设置抽屉是 DOM 覆盖层,而面板浏览器画在窗口原生层 —— 必须先隐藏
  settingsSelProvider = state.config.providers[0] ? state.config.providers[0].id : null;
  $('#modal-root').classList.remove('hidden');
  renderSettings();
  liteapi.invoke('app:presets').then((ps) => {
    presetsCache = ps;
    if (settingsTab === 'providers') renderProviderAddBox();
  });
}

function closeSettings() {
  $('#modal-root').classList.add('hidden');
  $('#modal-root').innerHTML = '';
}

// 设置分类(竖排导航,顺序对应主界面左侧"新建对话/分组/会话"一栏的纵向布局)
// v0.52.0:「扩展」页拆除 —— 插件挪入独立「连接桥」页(openBridges),专精并入「提示词」页
const SETTINGS_NAV = [
  ['providers', '供应商', '🧩'],
  ['prompts', '提示词', '🧑'],
  ['agentmd', 'Agent 规约', '📜'],
  ['agent', 'Agent', '🤖'],
  ['subagents', '子智能体', '👥'],
  ['security', '安全', '🛡️'],
  ['context', '上下文管理', '🧠'],
  ['debug', '诊断', '🩺'],
  ['dev', '开发者', '⌨️'],
  ['appearance', '外观', '🎨'],
  ['general', '常规', '⚙️'],
];

function renderSettings() {
  // 抽屉外壳只在此刻构建一次;点导航/pane 自重绘都走 renderSettingsContent(只换内容区,不闪烁)
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal settings-drawer">
      <div class="sd-head">
        <span class="sd-title">${t('设置')}</span>
        <span id="settings-version" class="sd-ver"></span>
        <button class="modal-close" title="关闭">✕</button>
      </div>
      <div class="sd-body">
        <div class="modal-tabs sd-nav">
          ${SETTINGS_NAV.map(([id, label, ico]) => `<button class="modal-tab ${settingsTab === id ? 'active' : ''}" data-tab="${id}"><span class="nav-ico">${ico}</span>${t(label)}</button>`).join('')}
        </div>
        <div class="modal-body" id="modal-body"></div>
      </div>
    </div>`;
  const verEl = $('#settings-version', root);
  if (verEl) verEl.textContent = 'LiteAgent v' + (state.appVersion || '?');
  $('.modal-close', root).addEventListener('click', closeSettings);
  root.addEventListener('click', (e) => { if (e.target === root) closeSettings(); });
  // 导航点击:事件委托,只切换内容区
  $('.sd-nav', root).addEventListener('click', (e) => {
    const t = e.target.closest('.modal-tab');
    if (!t || t.dataset.tab === settingsTab) return;
    settingsTab = t.dataset.tab;
    renderSettingsContent();
  });
  renderSettingsContent();
}

// 只重绘内容区 + 导航高亮(不重建抽屉外壳 —— 否则每次点击整屏闪烁)
function renderSettingsContent() {
  const root = $('#modal-root');
  const drawer = $('.settings-drawer', root);
  if (!drawer) { renderSettings(); return; }
  if (settingsTab === 'usage') settingsTab = 'context'; // 兼容旧入口:用量已并入上下文管理
  $$('.sd-nav .modal-tab', drawer).forEach((t) => t.classList.toggle('active', t.dataset.tab === settingsTab));
  const body = $('#modal-body');
  body.scrollTop = 0;
  if (settingsTab === 'providers') renderProvidersPane();
  else if (settingsTab === 'prompts') renderPromptsPane();
  else if (settingsTab === 'agentmd') renderAgentMdPane();
  else if (settingsTab === 'agent') renderAgentPane();
  else if (settingsTab === 'subagents') renderSubagentsPane();
  else if (settingsTab === 'security') renderSecurityPane();
  else if (settingsTab === 'context') renderContextManagementPane();
  else if (settingsTab === 'debug') renderDebugPane();
  else if (settingsTab === 'dev') renderDevPane();
  else if (settingsTab === 'appearance') renderAppearancePane();
  else renderGeneralPane();
}

function rerenderSettings() { renderSettingsContent(); }

/* ---- 组合 tab:一个标签内分节渲染相关设置 ---- */
function settingsSection(title, id) {
  return `<div class="settings-group"><div class="sg-title">${title}</div><div id="${id}"></div></div>`;
}

// 提示词 = 助手角色 + 技能
// 提示词 = 助手 + 技能 + 技能专精(专精自「扩展」页并入,扩展页由「连接桥」取代)
function renderPromptsPane() {
  $('#modal-body').innerHTML = settingsSection('🧑 助手角色(顶栏切换的人设)', 'sec-assistants')
    + settingsSection('⚡ 技能(输入框上方的快捷任务)', 'sec-skills')
    + settingsSection('🎓 技能专精(领域知识包)', 'sec-specialty');
  renderAssistantsPane($('#sec-assistants'));
  renderSkillsPane($('#sec-skills'));
  renderSpecialtyPane($('#sec-specialty'));
}

// 连接桥(v0.52.0):独立页(左侧停靠抽屉形态,与设置抽屉同视觉语言但独立容器/标题栏)。
// 三分区 = 插件(MCP / DSH / LiteAgent 原生,自「扩展」页整体挪入)+ SSH 连接 + Windows 连接。
function openBridges() {
  panelWebHide(); // 同设置抽屉:面板浏览器画在原生层会盖住 DOM 覆盖层
  const root = $('#bridge-root');
  root.innerHTML = `
    <div class="modal settings-drawer">
      <div class="sd-head">
        <span class="sd-title">${t('🔗 连接桥')}</span>
        <span class="sd-ver">${t('MCP 插件 / SSH / Windows / 技能知识库管理中心')}</span>
        <button class="modal-close" title="${t('关闭')}">✕</button>
      </div>
      <div class="sd-body">
        <div class="modal-body" id="bridge-body"></div>
      </div>
    </div>`;
  root.classList.remove('hidden');
  $('.modal-close', root).addEventListener('click', closeBridges);
  root.addEventListener('click', (e) => { if (e.target === root) closeBridges(); });
  renderBridgesPane();
}

function closeBridges() {
  const root = $('#bridge-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

// 技能知识库独立页(连接桥正下方的侧栏入口;复用 #bridge-root 左停靠外壳)
function openSpecPage() {
  panelWebHide(); // 同设置抽屉/连接桥:原生层面板浏览器会盖住 DOM 覆盖层
  const root = $('#bridge-root');
  root.innerHTML = `
    <div class="modal settings-drawer">
      <div class="sd-head">
        <span class="sd-title">${t('📚 技能知识库')}</span>
        <span class="sd-ver">${t('专精包:领域知识 + 人设路由,同一时间启用一个')}</span>
        <button class="modal-close" title="${t('关闭')}">✕</button>
      </div>
      <div class="sd-body">
        <div class="modal-body" id="bridge-body"></div>
      </div>
    </div>`;
  root.classList.remove('hidden');
  $('.modal-close', root).addEventListener('click', closeSpecPage);
  root.addEventListener('click', (e) => { if (e.target === root) closeSpecPage(); });
  renderSpecialtyPane($('#bridge-body'));
}

function closeSpecPage() {
  const root = $('#bridge-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

// —— 自动任务独立页(cron 定时执行;任务到点自动发起对话,专属 auto- 会话历史可查) ——
function openAutoTasks() {
  panelWebHide();
  const root = $('#bridge-root');
  root.innerHTML = `
    <div class="modal settings-drawer">
      <div class="sd-head">
        <span class="sd-title">${t('⏰ 自动任务')}</span>
        <span class="sd-ver">${t('定时让 AI 执行任务;到点自动发起对话(专属会话,历史可查);应用运行期间调度')}</span>
        <button class="modal-close" title="${t('关闭')}">✕</button>
      </div>
      <div class="sd-body">
        <div class="modal-body" id="bridge-body"></div>
      </div>
    </div>`;
  root.classList.remove('hidden');
  $('.modal-close', root).addEventListener('click', closeAutoTasks);
  root.addEventListener('click', (e) => { if (e.target === root) closeAutoTasks(); });
  renderCronPane($('#bridge-body'));
}

function closeAutoTasks() {
  const root = $('#bridge-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

let cronShowForm = false;
function cronPlanToCron(kind, hm, everyN, weekD) {
  const [h, m] = String(hm || '09:00').split(':').map((x) => String(parseInt(x, 10) || 0));
  if (kind === 'daily') return `${m} ${h} * * *`;
  if (kind === 'interval') return `*/${Math.max(1, parseInt(everyN, 10) || 30)} * * * *`;
  if (kind === 'weekly') return `${m} ${h} * * ${Math.max(0, Math.min(6, parseInt(weekD, 10) || 1))}`;
  return null;
}
function cronStatusText(s) {
  if (s === 'running') return '🟢 ' + t('运行中');
  if (s === 'done') return '✓ ' + t('完成');
  if (s === 'interrupted') return '⚠ ' + t('中断(重启)');
  if (s && String(s).startsWith('error')) return '✕ ' + String(s).slice(0, 40);
  return '—';
}
async function renderCronPane(R) {
  if (!R) return;
  let tasks = [];
  try { tasks = await liteapi.invoke('cron:list'); } catch (_) {}
  const fmtT = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const card = (x) => `
    <div class="sub-agent ${x.enabled === false ? '' : 'st-done'}" style="margin-bottom:10px">
      <div class="sub-head">
        <span class="sub-ico">${x.enabled === false ? '⚪' : '⏰'}</span>
        <b>${escapeHtml(x.name)}</b>
        <span class="sub-model">${escapeHtml(cronDescribeLocal(x.cron))}</span>
        <span class="sub-model">${t('模式')}:${MODE_SHORT[x.mode] || x.mode}</span>
        <span class="sub-model">${t('上次')}:${fmtT(x.lastRun)} ${cronStatusText(x.lastStatus)}</span>
        <span class="sub-model">${t('下次')}:${fmtT(x.nextAt)}</span>
        <span style="flex:1"></span>
        <button class="btn" data-cron-act="run" data-id="${x.id}" title="${t('立即执行一次')}">${t('▶ 立即运行')}</button>
        <button class="btn" data-cron-act="toggle" data-id="${x.id}">${x.enabled === false ? t('启用') : t('停用')}</button>
        <button class="btn" data-cron-act="del" data-id="${x.id}" class="act-del">${t('删除')}</button>
      </div>
      <div class="sub-text">${escapeHtml(String(x.prompt || '').slice(0, 120))}</div>
    </div>`;
  R.innerHTML = `
    <div class="agent-settings" style="max-width:720px">
      <div class="hint" style="font-size:12px;line-height:1.7;margin-bottom:10px">
        自动任务 = 定时把一段提示词发给 AI 执行(用当前选中的模型;模式默认「对话」最安全,选「完全」将允许工具,请确认提示词可靠)。
        到点自动创建/复用专属会话(auto- 前缀),在任务列表可查看历史;仅应用运行期间调度,重启后错过的周期自动顺延。
      </div>
      <div id="cron-list">${tasks.map(card).join('') || `<div class="hint">${t('还没有自动任务')}</div>`}</div>
      ${cronShowForm ? '<div id="cron-form"></div>' : ''}
      <div style="margin-top:8px"><button class="btn" id="cron-add">＋ ${t('新建自动任务')}</button></div>
    </div>`;
  $('#cron-add', R).addEventListener('click', () => { cronShowForm = !cronShowForm; renderCronPane(R); });
  if (cronShowForm) renderCronForm($('#cron-form', R), R);
  $$('[data-cron-act]', R).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    const act = b.dataset.cronAct;
    if (act === 'run') {
      b.disabled = true; b.textContent = '…';
      try { await liteapi.invoke('cron:runNow', id); toast(t('已触发,结果见专属会话')); }
      catch (e) { toast(e.message); }
      renderCronPane(R);
      return;
    }
    if (act === 'del') {
      const task = tasks.find((x) => x.id === id);
      if (!confirm(`删除自动任务「${task ? task.name : id}」?`)) return;
      await liteapi.invoke('cron:delete', id);
    } else if (act === 'toggle') {
      const task = tasks.find((x) => x.id === id);
      if (task) await liteapi.invoke('cron:upsert', { ...task, enabled: task.enabled === false });
    }
    renderCronPane(R);
  }));
}
function cronDescribeLocal(expr) {
  // 主进程有 describe,但渲染端无 require —— 常用形态本地判断,否则显示原文
  const parts = String(expr).split(/\s+/);
  if (parts.length !== 5) return String(expr);
  const [m, h, dom, mon, dow] = parts;
  if (mon !== '*') return expr;
  const ev = /^\*\/(\d+)$/.exec(m);
  if (ev && h === '*' && dom === '*' && dow === '*') return `${t('每')} ${ev[1]} ${t('分钟')}`;
  if (h !== '*' && m !== '*' && dom === '*' && dow === '*') return `${t('每天')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const D7 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((x) => t(x));
  if (h !== '*' && m !== '*' && dom === '*' && dow !== '*') return `每${D7[parseInt(dow, 10) % 7] || dow} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return expr;
}
function renderCronForm(holder, R) {
  holder.innerHTML = `
    <div class="menu-form" style="margin-top:8px">
      <label>${t('任务名称')}</label>
      <input type="text" id="cf-name" placeholder="${t('例如:每天早报')}">
      <label>${t('计划')}</label>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select id="cf-kind" style="width:110px;height:32px">
          <option value="daily">${t('每天')}</option>
          <option value="weekly">${t('每周')}</option>
          <option value="interval">${t('每隔')}</option>
        </select>
        <span id="cf-daily-wrap"><input type="time" id="cf-hm" value="09:00" style="width:110px;height:32px"></span>
        <span id="cf-week-wrap" style="display:none"><select id="cf-week" style="width:90px;height:32px"><option value="1">周一</option><option value="2">周二</option><option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option></select> <input type="time" id="cf-hm2" value="09:00" style="width:110px;height:32px"></span>
        <span id="cf-int-wrap" style="display:none"><input type="number" id="cf-every" value="30" min="1" max="1440" style="width:80px;height:32px"> ${t('分钟')}</span>
      </div>
      <label>${t('任务提示词(到点发给 AI 执行的内容)')}</label>
      <textarea id="cf-prompt" class="mono" style="min-height:64px;width:100%" placeholder="${t('例如:联网搜索今日 AI 领域重要新闻,给我一份 5 条以内的早报摘要')}"></textarea>
      <label>${t('执行模式')}</label>
      <select id="cf-mode" style="width:160px;height:32px">
        <option value="chat">${t('对话(无工具,最安全)')}</option>
        <option value="restricted">${t('受限(只读工具)')}</option>
        <option value="full">${t('完全(全部工具,注意审批会无人值守超时)')}</option>
      </select>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn primary" id="cf-save" disabled>${t('保存任务')}</button>
        <button class="btn" id="cf-cancel">${t('取消')}</button>
      </div>
    </div>`;
  const valid = () => {
    const ok = $('#cf-name', holder).value.trim() && $('#cf-prompt', holder).value.trim();
    $('#cf-save', holder).disabled = !ok;
  };
  $('#cf-name', holder).addEventListener('input', valid);
  $('#cf-prompt', holder).addEventListener('input', valid);
  $('#cf-kind', holder).addEventListener('change', (e) => {
    const k = e.target.value;
    $('#cf-daily-wrap', holder).style.display = k === 'daily' ? '' : 'none';
    $('#cf-week-wrap', holder).style.display = k === 'weekly' ? '' : 'none';
    $('#cf-int-wrap', holder).style.display = k === 'interval' ? '' : 'none';
  });
  $('#cf-cancel', holder).addEventListener('click', () => { cronShowForm = false; renderCronPane(R); });
  $('#cf-save', holder).addEventListener('click', async () => {
    const kind = $('#cf-kind', holder).value;
    const cron = cronPlanToCron(kind, $('#cf-hm', holder).value || $('#cf-hm2', holder).value, $('#cf-every', holder).value, $('#cf-week', holder).value);
    if (!cron) { toast(t('计划参数无效')); return; }
    try {
      await liteapi.invoke('cron:upsert', {
        name: $('#cf-name', holder).value.trim(),
        cron,
        prompt: $('#cf-prompt', holder).value.trim(),
        mode: $('#cf-mode', holder).value,
        enabled: true,
      });
      cronShowForm = false;
      renderCronPane(R);
      toast(t('自动任务已保存'));
    } catch (e) { toast(e.message); }
  });
}

function renderBridgesPane(root) {
  const R = root || $('#bridge-body') || $('#modal-body'); // 独立页优先;设置抽屉语境(如冒烟直调 renderSettingsContent)回落 modal-body
  if (!R) return; // 两处容器都不存在(页未打开)时静默跳过
  R.innerHTML = settingsSection('🔌 插件(MCP / DSH / LiteAgent 原生插件)', 'sec-plugins')
    + settingsSection('🖥️ SSH 连接(内置终端发起 ssh 登录)', 'sec-ssh')
    + settingsSection('🪟 Windows 连接(远程桌面 mstsc 直连)', 'sec-win')
    + settingsSection('📚 技能知识库(专精包:知识文件 + 人设路由,AI 按需检索)', 'sec-specialty');
  renderPluginsPane($('#sec-plugins', R));
  renderBridgeConnections($('#sec-ssh', R), $('#sec-win', R));
  renderSpecialtyPane($('#sec-specialty', R));
}

// SSH / Windows 连接条目管理:列表 + 内联添加表单(v0.52.0 三次迭代:弹出卡片 → 设置页签 → 独立页,用户裁定)
let bridgeFormKind = null; // 当前展开的添加表单:'ssh' | 'win' | null

function renderBridgeConnections(sshRoot, winRoot) {
  const bridges = state.config.bridges || {};
  const ssh = bridges.ssh || [];
  const win = bridges.win || [];
  const authBadge = (s) => s.passwordEnc ? '🔑密码' : (deobfStr(s.keyPath) ? '🗝密钥' : '默认');
  const rowHtml = (s, kind) => `
    <div class="bridge-item">
      <span class="bi-ico">${kind === 'ssh' ? '🖥️' : '🪟'}</span>
      <span class="bi-name">${escapeHtml(s.name)}</span>
      <span class="bi-host">${escapeHtml(kind === 'ssh' ? `${deobfStr(s.user) ? deobfStr(s.user) + '@' : ''}${deobfStr(s.host)}${s.port && String(s.port) !== '22' ? ':' + s.port : ''} [${authBadge(s)}]` : deobfStr(s.host))}</span>
      <span class="spacer"></span>
      <button class="btn" data-bconn="${kind}:${s.id}">${t('连接')}</button>
      <button class="btn" data-bdel="${kind}:${s.id}">${t('删除')}</button>
    </div>`;
  sshRoot.innerHTML = `
    <div class="hint">${t('凭据已加密混淆保存:密码走系统级加密(DPAPI),主机/账号混淆存储。支持密码登录(自动喂入)或密钥登录;密钥路径留空则用系统默认(~/.ssh)')}</div>
    <div class="bridge-list">${ssh.map((s) => rowHtml(s, 'ssh')).join('') || `<div class="hint">${t('还没有 SSH 连接')}</div>`}</div>
    ${bridgeFormKind === 'ssh' ? '<div id="bridge-form"></div>' : ''}
    <div style="margin-top:8px"><button class="btn" id="bridge-add-ssh">＋ ${t('添加 SSH 连接')}</button></div>`;
  winRoot.innerHTML = `
    <div class="hint">${t('连接时通过远程桌面(mstsc)打开该计算机;计算机地址混淆保存;凭据在系统弹窗中输入,请确保目标机已允许远程桌面')}</div>
    <div class="bridge-list">${win.map((s) => rowHtml(s, 'win')).join('') || `<div class="hint">${t('还没有 Windows 连接')}</div>`}</div>
    ${bridgeFormKind === 'win' ? '<div id="bridge-form"></div>' : ''}
    <div style="margin-top:8px"><button class="btn" id="bridge-add-win">＋ ${t('添加 Windows 连接')}</button></div>`;
  const addBtn = (id, kind) => {
    const b = $(id);
    if (b) b.addEventListener('click', () => { bridgeFormKind = bridgeFormKind === kind ? null : kind; renderBridgesPane(); });
  };
  addBtn('#bridge-add-ssh', 'ssh');
  addBtn('#bridge-add-win', 'win');
  $$('[data-bconn]', sshRoot).concat($$('[data-bconn]', winRoot)).forEach((b) => b.addEventListener('click', async () => {
    const [kind, id] = b.dataset.bconn.split(':');
    const s = ((state.config.bridges || {})[kind] || []).find((x) => x.id === id);
    if (!s) return;
    if (kind === 'ssh') {
      // SSH:主进程组装(解密密码 → askpass 喂入 / 密钥直连),返回完整命令行
      try {
        const cmd = await liteapi.invoke('bridge:connect', {
          host: deobfStr(s.host), port: s.port, user: deobfStr(s.user),
          keyPath: deobfStr(s.keyPath), passwordEnc: s.passwordEnc || '',
        });
        openPanelRun(cmd);
        toast(t('已在内置终端发起连接'));
      } catch (err) { toast(t('连接失败') + ': ' + err.message); }
    } else {
      openPanelRun(`mstsc /v:${deobfStr(s.host)}`);
      toast(t('已发起远程桌面'));
    }
  }));
  $$('[data-bdel]', sshRoot).concat($$('[data-bdel]', winRoot)).forEach((b) => b.addEventListener('click', async () => {
    const [kind, id] = b.dataset.bdel.split(':');
    const cur = (state.config.bridges || {})[kind] || [];
    state.config = await liteapi.invoke('config:set', { bridges: { [kind]: cur.filter((x) => x.id !== id) } });
    renderBridgesPane();
  }));
  if (bridgeFormKind) renderBridgeForm($('#bridge-form'), bridgeFormKind);
}

function renderBridgeForm(holder, kind) {
  const isSsh = kind === 'ssh';
  holder.innerHTML = `
    <div class="menu-form" style="margin-top:8px">
      <label>${t('连接名称')} / ${isSsh ? t('主机') : t('计算机')}</label>
      <div style="display:flex;gap:6px">
        <input type="text" id="bf-name" placeholder="${t('名称,例如:开发服务器')}">
        <input type="text" id="bf-host" placeholder="${isSsh ? t('主机名或 IP') : t('计算机名或 IP')}" style="flex:1.4">
      </div>
      ${isSsh ? `
      <label>${t('端口 / 用户名 / 密钥路径(可选)')}</label>
      <div style="display:flex;gap:6px">
        <input type="text" id="bf-port" placeholder="22" style="width:64px;flex-shrink:0">
        <input type="text" id="bf-user" placeholder="${t('用户名')}">
        <input type="text" id="bf-key" placeholder="${t('密钥路径')}">
      </div>
      <label>${t('密码(可选,系统级加密保存;与密钥二选一)')}</label>
      <input type="password" id="bf-pwd" placeholder="${t('留空 = 不使用密码登录')}" autocomplete="new-password">` : ''}
      <div style="display:flex;gap:6px;margin-top:4px">
        <button class="btn primary" id="bf-save" disabled>${t('保存')}</button>
        <button class="btn" id="bf-cancel">${t('取消')}</button>
      </div>
    </div>`;
  const nameI = $('#bf-name', holder), hostI = $('#bf-host', holder);
  const saveB = $('#bf-save', holder);
  const valid = () => {
    const portV = isSsh ? $('#bf-port', holder).value.trim() : '';
    const ok = nameI.value.trim() && bridgeHostOk(hostI.value.trim())
      && (!isSsh || bridgeUserOk($('#bf-user', holder).value.trim()))
      && (!isSsh || bridgeKeyOk($('#bf-key', holder).value.trim()))
      && (!portV || /^\d{1,5}$/.test(portV));
    saveB.disabled = !ok;
  };
  [nameI, hostI].forEach((i) => i.addEventListener('input', valid));
  if (isSsh) ['bf-user', 'bf-key', 'bf-port'].forEach((id) => $('#' + id, holder).addEventListener('input', valid));
  $('#bf-cancel', holder).addEventListener('click', () => { bridgeFormKind = null; renderBridgesPane(); });
  saveB.addEventListener('click', async () => {
    const cur = state.config.bridges || {};
    if (isSsh) {
      const entry = {
        id: 'ssh-' + Date.now().toString(36), name: nameI.value.trim(),
        host: obfStr(hostI.value.trim()), // 落盘混淆
        port: parseInt($('#bf-port', holder).value.trim(), 10) || '',
        user: obfStr($('#bf-user', holder).value.trim()),
        keyPath: obfStr($('#bf-key', holder).value.trim()),
      };
      // 密码走主进程 safeStorage 加密(bridge:saveEntry);无密码时也走同一路径保持一致
      const saved = await liteapi.invoke('bridge:saveEntry', { kind: 'ssh', entry, password: $('#bf-pwd', holder).value || '' });
      state.config = saved;
    } else {
      const entry = { id: 'win-' + Date.now().toString(36), name: nameI.value.trim(), host: obfStr(hostI.value.trim()) };
      state.config = await liteapi.invoke('bridge:saveEntry', { kind: 'win', entry, password: '' });
    }
    bridgeFormKind = null;
    renderBridgesPane();
    toast(t('已保存连接(凭据已加密混淆)'));
  });
}

// Agent 设置 = 智能体行为 + 联网搜索 + Blender 建模
// 上下文压缩已并入「上下文管理」页(与用量同屏)
function renderAgentPane() {
  $('#modal-body').innerHTML = settingsSection('🤖 智能体行为(工作目录 / 审批 / 迭代)', 'sec-agent')
    + settingsSection('🌐 联网搜索(web_search 后端)', 'sec-search')
    + settingsSection('🎬 Blender 建模(15 个工具 · 直连 Blender)', 'sec-blender');
  renderAgentCorePane($('#sec-agent'));
  renderSearchPane($('#sec-search'));
  renderBlenderPane($('#sec-blender'));
}

// Blender 建模工具链(v0.55.0):开关/状态/一键拉起/端口与路径配置
// GUI 适配说明:原 DSH 插件 3 开关(port/autoStart/tui)在此重组 —— tui 舍弃(本应用有自己的 UI),
// autoStart 并入「开关打开即自动拉起后端」;Blender N 面板的 5 个集成开关是场景属性(随 .blend 变),不在此持久化。
function renderBlenderPane(root) {
  if (!root) return;
  const bl = state.config.blender || {};
  root.innerHTML = `
    <div class="hint" style="margin-bottom:10px">${t('启用后 AI 拥有 15 个 blender_rt_* 建模工具(看视口/跑 Python/参数搜索/装配体检/交付导出等),配套「Blender 建模专精」知识包。Blender 未启动时可一键拉起或让 AI 自行拉起(自动装插件并连接)。')}</div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="bl-enabled" ${bl.enabled ? 'checked' : ''} style="width:auto"><b>${t('启用 Blender 工具链')}</b></label>
      <div class="desc">${t('开启即自动拉起本地后端(127.0.0.1:9877);Blender 侧需装 DSH Blender Bridge 插件 —— 「一键拉起」会自动安装并启用。')}</div></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input type="checkbox" id="bl-viewport" ${(bl.viewportPanel ? 'checked' : '')} style="width:auto"><b>${t('显示「Blender 视口」面板标签(默认关)')}</b></label>
      <div class="desc">${t('右侧面板新增「Blender 视口」标签:实时视口画面(1.5 秒自动刷新)/ 点击画面直接选中物体 / 一键把选中对象加入对话输入框。')}</div></div>
    <div class="field"><label>${t('连接状态')}</label>
      <div class="desc" style="word-break:break-all"><span id="bl-status" style="font-family:Consolas,monospace;font-size:11.5px;white-space:pre-wrap"></span></div></div>
    <div class="btns" style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
      <button class="btn" id="bl-test">${t('🩺 测试连接')}</button>
      <button class="btn" id="bl-launch">${t('🚀 一键拉起 Blender')}</button>
      <button class="btn" id="bl-stop">${t('⏹ 停止后端')}</button>
    </div>
    <div class="field"><label>${t('blender.exe 路径(留空自动探测)')}</label>
      <input type="text" id="bl-exe" placeholder="${t('自动探测:Program Files / Steam 库等常见位置')}" value="${escapeHtml(bl.blenderExe || '')}"></div>
    <div class="field"><label>${t('工作目录(无头产物/快照/台账)')}</label>
      <input type="text" id="bl-workdir" placeholder="%LOCALAPPDATA%/dsh-blender-rt" value="${escapeHtml(bl.workDir || '')}"></div>
    <div style="display:flex;gap:8px">
      <div class="field" style="flex:1"><label>${t('后端端口')}</label><input type="number" id="bl-http" min="1024" max="65535" value="${Number(bl.httpPort) || 9877}"></div>
      <div class="field" style="flex:1"><label>${t('Blender 插件端口')}</label><input type="number" id="bl-addon" min="1024" max="65535" value="${Number(bl.addonPort) || 9876}"></div>
    </div>
    <div class="hint" style="margin-top:8px">⚠ ${t('本插件与 MCP for Blender 互斥(同抢 9876 端口),使用前请在 Blender 里禁用后者。选中桥:Blender 里点「发送选中到 DSH」会自动把对象名插入本应用输入框。')}</div>
  `;
  const save = (patch) => liteapi.invoke('config:set', { blender: { ...(state.config.blender || {}), ...patch } }).then((c) => { state.config = c; });
  $('#bl-enabled', root).addEventListener('change', async (e) => {
    await save({ enabled: e.target.checked });
    toast(e.target.checked ? t('Blender 工具链已启用(后端启动中)') : t('Blender 工具链已关闭'));
    blStatusTick(true);
  });
  $('#bl-viewport', root).addEventListener('change', async (e) => {
    await save({ viewportPanel: e.target.checked });
    toast(e.target.checked ? t('已开启「Blender 视口」面板标签(右侧面板)') : t('已关闭「Blender 视口」面板标签'));
    if (!e.target.checked && panelState.tab === 'blender') { setPanelTab(null); if (window.__pvTimer) { clearInterval(window.__pvTimer); window.__pvTimer = null; } }
    else renderPanel();
  });
  $('#bl-exe', root).addEventListener('change', (e) => save({ blenderExe: e.target.value.trim() }));
  $('#bl-workdir', root).addEventListener('change', (e) => save({ workDir: e.target.value.trim() }));
  $('#bl-http', root).addEventListener('change', (e) => save({ httpPort: Number(e.target.value) || 9877 }));
  $('#bl-addon', root).addEventListener('change', (e) => save({ addonPort: Number(e.target.value) || 9876 }));
  $('#bl-test', root).addEventListener('click', async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = t('检测中…');
    try { const r = await liteapi.invoke('blender:test'); toast((r.ok ? '✅ ' : '⚠️ ') + (r.text || '')); }
    catch (err) { toast('⚠️ ' + String(err.message || err)); }
    finally { btn.disabled = false; btn.textContent = t('🩺 测试连接'); }
  });
  $('#bl-launch', root).addEventListener('click', async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = t('拉起中…(约 10 秒)');
    try { const r = await liteapi.invoke('blender:launch', {}); toast((r.ok ? '✅ ' : '⚠️ ') + (r.text || '')); }
    catch (err) { toast('⚠️ ' + String(err.message || err)); }
    finally { btn.disabled = false; btn.textContent = t('🚀 一键拉起 Blender'); }
    blStatusTick(true);
  });
  $('#bl-stop', root).addEventListener('click', async () => {
    try { const r = await liteapi.invoke('blender:stop'); toast(r.text || t('已停止')); } catch (err) { toast('⚠️ ' + String(err.message || err)); }
    blStatusTick(true);
  });
  // 状态轮询(pane 活跃期间,3s;仿隧道状态先例)
  const blStatusTick = async (force) => {
    const elx = $('#bl-status');
    if (!elx) { if (window.__blStatusTimer) { clearInterval(window.__blStatusTimer); window.__blStatusTimer = null; } return; }
    try {
      const st = await liteapi.invoke('blender:status');
      const lines = [];
      if (!st.enabled) lines.push(t('未启用'));
      else {
        lines.push(`${t('后端')}: ${st.backendRunning ? t('运行中') : t('未运行')}${st.pid ? '(pid ' + st.pid + ')' : ''} · ${st.httpPort}`);
        lines.push(`${t('Blender')}: ${st.addonConnected ? t('已连接') : t('未连接')}${st.lastCmd ? ' · ' + st.lastCmd : ''}`);
        if (st.renderBusy) lines.push('🔴 ' + t('渲染中'));
        if (st.jobs) lines.push(`🧵 ${t('作业')} x${st.jobs}`);
        lines.push(`${t('blender.exe')}: ${st.exe || t('未探测到(拉起/无头将不可用)')}`);
      }
      elx.textContent = lines.join('\n');
    } catch (_) { /* 后端未运行 */ }
  };
  if (window.__blStatusTimer) clearInterval(window.__blStatusTimer);
  blStatusTick();
  window.__blStatusTimer = setInterval(blStatusTick, 3000);
}

// 安全 = 安全审计 + 沙箱 + 网络代理
function renderSecurityPane() {
  $('#modal-body').innerHTML = settingsSection('🛡️ 安全审计(HTTPS 门槛 / 敏感信息 / 日志)', 'sec-audit')
    + settingsSection('🖼️ 图片隐私(工作目录之外的图片禁止访问)', 'sec-privacy')
    + settingsSection('📦 沙箱机制(文件锁定 / 命令拦截)', 'sec-sandbox')
    + settingsSection('🌐 网络代理(系统 / 手动 / 直连)', 'sec-proxy');
  renderSecurityCorePane($('#sec-audit'));
  renderPrivacyCorePane($('#sec-privacy'));
  renderSandboxCorePane($('#sec-sandbox'));
  renderProxyPane($('#sec-proxy'));
}

/* ---- 子智能体 tab(v0.27) ---- */
let subagentEditId = null; // 正在编辑的子智能体 id;'new' = 创建中

function renderSubagentsPane() {
  const body = $('#modal-body');
  body.innerHTML = `
    <div class="settings-group">
      <div class="sg-title">👥 子智能体库(主智能体按职责自动派发)</div>
      <div class="hint" style="margin-bottom:8px">主智能体规划任务时会看到这份清单:任务与谁职责匹配就派谁执行(工具与审批规则与主智能体一致)。每个子智能体可指定<b>其他服务商的模型</b>实现多模型协作 —— 例如让便宜的模型跑调研、主力模型写代码。</div>
      <div id="subagent-list"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" id="subagent-add">＋ 创建子智能体</button>
        <button class="btn" id="subagent-restore">恢复预设(含团队模板)</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="sg-title">🧑‍🤝‍🧑 团队协同模板(团队协同模式:主模型担任指挥官 + 队员编队)</div>
      <div id="team-pane"></div>
    </div>`;
  $('#subagent-add').addEventListener('click', () => { subagentEditId = 'new'; renderSubagentList(); });
  $('#subagent-restore').addEventListener('click', async () => {
    state.config = await liteapi.invoke('subagents:restoreDefaults');
    renderSubagentsPane();
    toast('已恢复缺失的预设(子智能体与团队模板)');
  });
  renderSubagentList();
  renderTeamsPane($('#team-pane'));
}

function subagentModelLabel(s) {
  if (!s.providerId || !s.model) return '跟随主智能体';
  const p = (state.config.providers || []).find((x) => x.id === s.providerId);
  return `${p ? p.name : s.providerId} · ${s.model}`;
}

function subagentCardHtml(s) {
  return `
    <div class="sa-card ${s.enabled === false ? 'sa-off' : ''}" data-id="${s.id}">
      <div class="sa-head">
        <label class="switch" title="启用后才会出现在主智能体的派发清单里"><input type="checkbox" class="sa-en" ${s.enabled !== false ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label>
        <b class="sa-name">${escapeHtml(s.name)}</b>
        <span class="sa-badge ${s.builtin ? '' : 'sa-badge-self'}">${s.builtin ? '预设' : '自建'}</span>
        <span class="sa-model" title="该子智能体使用的模型">${escapeHtml(subagentModelLabel(s))}</span>
        <span class="sa-acts">
          <button class="sa-edit-btn" title="编辑">✎</button>
          <button class="sa-del-btn act-del" title="删除">✕</button>
        </span>
      </div>
      <div class="sa-desc">${escapeHtml(s.description || '')}</div>
    </div>`;
}

function subagentFormHtml(s) {
  return `
    <div class="sa-card sa-form" data-id="${s ? s.id : ''}">
      <div class="sa-form-row"><label>名称</label><input id="sa-name" type="text" value="${escapeHtml(s ? s.name : '')}" placeholder="如:翻译官"></div>
      <div class="sa-form-row"><label>职责描述(主智能体据此决定何时派发,写清楚“什么任务交给它”)</label><textarea id="sa-desc" rows="2" placeholder="如:把中文内容翻译成地道英文,或把英文资料摘要成中文要点">${escapeHtml(s ? (s.description || '') : '')}</textarea></div>
      <div class="sa-form-row"><label>角色提示词(子智能体的专属人设,留空则用默认执行者)</label><textarea id="sa-prompt" rows="3" placeholder="如:你是专业译者:只输出译文,保留原文的格式与代码块;拿不准的句子给出两种译法">${escapeHtml(s ? (s.prompt || '') : '')}</textarea></div>
      <div class="sa-form-row"><label>模型(可跨服务商,实现多模型协作)</label><select id="sa-model">
        <option value="">跟随主智能体</option>
        ${(state.modelChoices || []).map((mc) => `<option value="${mc.providerId}||${escapeHtml(mc.model)}" ${s && s.providerId === mc.providerId && s.model === mc.model ? 'selected' : ''}>${escapeHtml(mc.providerName)} · ${escapeHtml(mc.model)}</option>`).join('')}
      </select></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn primary" id="sa-save">保存</button>
        <button class="btn" id="sa-cancel">取消</button>
      </div>
    </div>`;
}

function renderSubagentList() {
  const wrap = $('#subagent-list');
  if (!wrap) return; // 保存回调返回时设置弹窗可能已关闭(DOM 已拆),静默跳过
  const list = state.config.subagents || [];
  const newForm = subagentEditId === 'new' ? subagentFormHtml(null) : '';
  const cards = list.map((s) => (subagentEditId === s.id ? subagentFormHtml(s) : subagentCardHtml(s))).join('');
  wrap.innerHTML = newForm + cards + (list.length ? '' : '<div class="hint" style="color:var(--text-3)">还没有子智能体:点「创建子智能体」或「恢复预设」开始。</div>');
  $$('.sa-card', wrap).forEach((card) => {
    const id = card.dataset.id;
    if (card.classList.contains('sa-form')) return;
    const s = list.find((x) => x.id === id);
    if (!s) return;
    $('.sa-edit-btn', card).addEventListener('click', () => { subagentEditId = id; renderSubagentList(); });
    $('.sa-del-btn', card).addEventListener('click', async () => {
      if (!confirm(`删除子智能体「${s.name}」?`)) return;
      state.config = await liteapi.invoke('config:set', { subagents: (state.config.subagents || []).filter((x) => x.id !== id) });
      renderSubagentList();
      toast('已删除');
    });
    $('.sa-en', card).addEventListener('change', async (e) => {
      const arr = (state.config.subagents || []).map((x) => (x.id === id ? { ...x, enabled: e.target.checked } : x));
      state.config = await liteapi.invoke('config:set', { subagents: arr });
      renderSubagentList();
    });
  });
  const form = $('.sa-form', wrap);
  if (form) bindSubagentForm(form);
}

function bindSubagentForm(form) {
  $('#sa-cancel', form).addEventListener('click', () => { subagentEditId = null; renderSubagentList(); });
  $('#sa-save', form).addEventListener('click', async () => {
    const name = $('#sa-name', form).value.trim();
    if (!name) { toast('请填写名称'); return; }
    const description = $('#sa-desc', form).value.trim();
    const prompt = $('#sa-prompt', form).value.trim();
    const mv = $('#sa-model', form).value;
    const [providerId, model] = mv ? mv.split('||') : [null, null];
    let arr = (state.config.subagents || []).slice();
    if (subagentEditId === 'new') {
      arr.push({ id: 'sub-' + uid().slice(0, 8), name, description, prompt, providerId, model, enabled: true });
    } else {
      arr = arr.map((x) => (x.id === subagentEditId ? { ...x, name, description, prompt, providerId, model } : x));
    }
    state.config = await liteapi.invoke('config:set', { subagents: arr });
    subagentEditId = null;
    renderSubagentList();
    toast('子智能体已保存');
  });
}

/* ---- 团队协同模板(v0.28):团队协同模式的编队,主模型 = 指挥官 ---- */
const TEAM_TIER_LABEL = { off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
const TEAM_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let teamEditId = null;

function renderTeamsPane(root) {
  if (!root) return;
  const teams = state.config.teams || [];
  const active = state.config.ui.activeTeamId || '';
  root.innerHTML = `
    <div class="hint" style="margin-bottom:8px">切到<b>🤝 团队协同</b>模式后,主模型担任指挥官:拆解任务 → 按队员职责派发(可并行)→ 审校汇总交付。每名队员可指定不同供应商的模型;推理强度请逐个显式设置(不同模型的档位与上限不同),留空则跟随主对话当前档位。</div>
    ${teams.length ? `<div class="tf-row"><label>团队协同模式使用的模板</label><select id="team-active">${teams.map((t) => `<option value="${t.id}" ${t.id === active ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select></div>` : ''}
    <div id="team-list"></div>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="team-add">＋ 创建模板</button></div>`;
  const activeSel = $('#team-active', root);
  if (activeSel) {
    activeSel.addEventListener('change', async (e) => {
      state.config = await liteapi.invoke('config:set', { ui: { activeTeamId: e.target.value } });
      const t = (state.config.teams || []).find((x) => x.id === e.target.value);
      toast('团队协同模式将使用:' + ((t && t.name) || '—'));
    });
  }
  $('#team-add', root).addEventListener('click', () => { teamEditId = 'new'; renderTeamList(root); });
  renderTeamList(root);
}

function teamMemberLabel(w) {
  const model = (w.providerId && w.model)
    ? `${((state.config.providers || []).find((p) => p.id === w.providerId) || {}).name || w.providerId} · ${w.model}`
    : (w.model || '跟随主模型');
  return `${model}(强度:${w.strength ? (TEAM_TIER_LABEL[w.strength] || w.strength) : '跟随主对话'})`;
}

function teamCardHtml(t) {
  const members = (t.workers || []).map((w, i) => `${escapeHtml(w.name || '队员' + (i + 1))} = ${escapeHtml(teamMemberLabel(w))}`).join(' · ');
  return `
    <div class="tm-card" data-id="${t.id}">
      <div class="sa-head">
        <b class="sa-name">${escapeHtml(t.name)}</b>
        <span class="sa-badge ${t.builtin ? '' : 'sa-badge-self'}">${t.builtin ? '预设' : '自建'}</span>
        <span class="sa-model">${(t.workers || []).length} 名队员</span>
        <span class="sa-acts">
          <button class="tm-edit-btn" title="编辑">✎</button>
          <button class="tm-del-btn act-del" title="删除">✕</button>
        </span>
      </div>
      <div class="sa-desc">指挥:主模型 · ${members}</div>
    </div>`;
}

function teamWorkerRowHtml(w, i) {
  const sel = (w && w.providerId && w.model) ? `${w.providerId}||${w.model}` : '';
  return `
    <div class="tm-worker" data-i="${i}">
      <input class="tw-name" type="text" placeholder="队员名" value="${escapeHtml((w && w.name) || '')}">
      <select class="tw-model">
        <option value="">跟随主模型</option>
        ${(state.modelChoices || []).map((mc) => `<option value="${mc.providerId}||${escapeHtml(mc.model)}" ${sel === mc.providerId + '||' + mc.model ? 'selected' : ''}>${escapeHtml(mc.providerName)} · ${escapeHtml(mc.model)}</option>`).join('')}
      </select>
      <select class="tw-strength" data-saved="${escapeHtml(w && w.strength != null ? String(w.strength) : '')}"><option value="">跟随默认档</option></select>
      <button class="tw-del act-del" type="button" title="移除队员">✕</button>
    </div>`;
}

function teamFormHtml(t) {
  const workers = t ? (t.workers || []).slice(0, 6) : [{}, {}, {}, {}];
  return `
    <div class="tm-card tm-form" data-id="${t ? t.id : ''}">
      <div class="sa-form-row"><label>模板名称</label><input id="tf-name" type="text" value="${escapeHtml(t ? t.name : '')}" placeholder="如:三路编队(调研/写码/审校)"></div>
      <div class="sa-form-row"><label>队员(每人可选不同供应商的模型;强度请逐个显式设置 —— 不同模型的档位与上限不同,GPT 全阶可选,模型不支持的档位 API 会报错属自选;留空 = 跟随主对话当前档位)</label>
        <div id="tf-workers">${workers.map((w, i) => teamWorkerRowHtml(w, i)).join('')}</div>
        <button class="btn" id="tf-add-worker" type="button" style="margin-top:6px">＋ 添加队员(最多 6 名)</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" id="tf-save">保存</button><button class="btn" id="tf-cancel">取消</button></div>
    </div>`;
}

function bindTeamWorkerRow(row) {
  const modelSel = $('.tw-model', row);
  const strengthSel = $('.tw-strength', row);
  const saved = strengthSel.dataset.saved || '';
  const load = async () => {
    strengthSel.innerHTML = '<option value="">跟随主对话</option>';
    const v = modelSel.value;
    if (v) {
      const [providerId, model] = v.split('||');
      const caps = await liteapi.invoke('reason:caps', { model, providerId }).catch(() => null);
      if (caps) {
        // 档位清单:openai_effort 族放开 GPT 全阶(与逐模型档位编辑器同一哲学:不支持该档 API 会报错,属自选);其他样式只列已识别档位
        const levels = caps.style === 'openai_effort'
          ? TEAM_EFFORT_LADDER.slice()
          : (caps.levels || []).slice();
        for (const lv of levels) {
          const o = document.createElement('option');
          o.value = lv;
          o.textContent = (TEAM_TIER_LABEL[lv] || lv) + (lv === caps.defaultLevel ? '(默认)' : '');
          strengthSel.appendChild(o);
        }
        // 显式选定:用户没动过强度时,选该模型的默认档(不同模型默认档不同,必须逐个确认)
        if (strengthSel.dataset.touched) {
          if (!$$('option', strengthSel).some((o) => o.value === strengthSel.value)) strengthSel.value = caps.defaultLevel || '';
        } else {
          strengthSel.value = saved && $$('option', strengthSel).some((o) => o.value === saved) ? saved : (caps.defaultLevel || '');
        }
      }
    }
  };
  modelSel.addEventListener('change', load);
  strengthSel.addEventListener('change', () => { strengthSel.dataset.touched = '1'; });
  if (modelSel.value) load();
  $('.tw-del', row).addEventListener('click', () => row.remove());
}

function renderTeamList(root) {
  const wrap = $('#team-list', root);
  if (!wrap) return;
  const teams = state.config.teams || [];
  const newForm = teamEditId === 'new' ? teamFormHtml(null) : '';
  const cards = teams.map((t) => (teamEditId === t.id ? teamFormHtml(t) : teamCardHtml(t))).join('');
  wrap.innerHTML = newForm + cards;
  $$('.tm-card', wrap).forEach((card) => {
    if (card.classList.contains('tm-form')) { bindTeamForm(card, root); return; }
    const id = card.dataset.id;
    const t = teams.find((x) => x.id === id);
    if (!t) return;
    $('.tm-edit-btn', card).addEventListener('click', () => { teamEditId = id; renderTeamList(root); });
    $('.tm-del-btn', card).addEventListener('click', async () => {
      if (!confirm(`删除模板「${t.name}」?`)) return;
      const arr = (state.config.teams || []).filter((x) => x.id !== id);
      const patch = { teams: arr };
      if (state.config.ui.activeTeamId === id) patch.ui = { activeTeamId: arr.length ? arr[0].id : '' };
      state.config = await liteapi.invoke('config:set', patch);
      renderTeamsPane(root);
      toast('已删除');
    });
  });
}

function bindTeamForm(card, root) {
  $$('.tm-worker', card).forEach(bindTeamWorkerRow);
  $('#tf-add-worker', card).addEventListener('click', () => {
    const list = $('#tf-workers', card);
    if (list.children.length >= 6) { toast('队员最多 6 名'); return; }
    list.insertAdjacentHTML('beforeend', teamWorkerRowHtml({}, list.children.length));
    bindTeamWorkerRow(list.lastElementChild);
  });
  $('#tf-cancel', card).addEventListener('click', () => { teamEditId = null; renderTeamList(root); });
  $('#tf-save', card).addEventListener('click', async () => {
    const name = $('#tf-name', card).value.trim();
    if (!name) { toast('请填写模板名称'); return; }
    const workers = $$('.tm-worker', card).map((row) => {
      const mv = $('.tw-model', row).value;
      const [providerId, model] = mv ? mv.split('||') : [null, null];
      const sv = $('.tw-strength', row).value;
      return { name: $('.tw-name', row).value.trim() || '队员', providerId, model, strength: sv || null };
    });
    if (!workers.length) { toast('至少需要一名队员'); return; }
    let arr = (state.config.teams || []).slice();
    if (teamEditId === 'new') arr.push({ id: 'team-' + uid().slice(0, 8), name, workers, enabled: true });
    else arr = arr.map((x) => (x.id === teamEditId ? { ...x, name, workers } : x));
    state.config = await liteapi.invoke('config:set', { teams: arr });
    teamEditId = null;
    renderTeamsPane(root);
    toast('团队模板已保存');
  });
}

/* ---- 供应商 tab(v0.33:子选项 = 模型 / 登录账号) ---- */
const TYPE_LABEL = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini', codex: 'ChatGPT 账号(Responses)' };
let providersPageTab = 'model'; // 供应商页子选项

function renderProvidersPane() {
  const body = $('#modal-body');
  body.innerHTML = `
    <div class="pft-tabs" style="margin-bottom:10px">
      <button type="button" class="pft-tab ${providersPageTab === 'auth' ? '' : 'on'}" data-t="model">模型</button>
      <button type="button" class="pft-tab ${providersPageTab === 'auth' ? 'on' : ''}" data-t="auth">登录账号</button>
      <button type="button" class="pft-tab ${providersPageTab === 'img' ? 'on' : ''}" data-t="img">图片生成</button>
    </div>
    <div id="pp-body"></div>`;
  $$('.pft-tab', body).forEach((b) => b.addEventListener('click', () => {
    providersPageTab = b.dataset.t;
    renderProvidersPane();
  }));
  if (providersPageTab === 'auth') {
    renderProviderAccounts($('#pp-body'));
    return;
  }
  if (providersPageTab === 'img') {
    renderImageGenPane($('#pp-body'));
    return;
  }
  $('#pp-body').innerHTML = `
    <div class="prov-layout">
      <div class="prov-list">
        <div id="prov-clean-row" class="hidden"><button type="button" class="btn" id="prov-clean-btn"></button></div>
        <div id="prov-items"></div>
        <div class="prov-add">
          <label style="font-size:12px;color:var(--text-2)">添加服务商</label>
          <div id="prov-add-box"></div>
        </div>
      </div>
      <div class="prov-editor" id="prov-editor"></div>
    </div>`;
  renderProvItems();
  renderProviderEditor();
  renderProviderAddBox();
  renderProviderCleanRow();
}

// 图片生成子页(v0.50.0):生图系统统一入口 —— 总开关/供应商/模型/尺寸/张数/自动桥接。
// 总开关关闭时,任何路径(工具桥接//img 命令/关键词)都无法触达生图模型。
let igSelProvider = null; // 图片生成子页:右侧编辑器当前显示的生图服务商
let igKeysState = [];
let igKeysVisible = false;

// 图片生成子页(v0.50.1 重做):与「模型」子页完全同构 —— 左列表常驻 + 右编辑器,多 Key 同款。
// 生图服务商体系与对话供应商完全独立(config.imageGen.providers)。
function renderImageGenPane(root) {
  const ig = state.config.imageGen || {};
  const list = ig.providers || [];
  if (!igSelProvider || !list.some((p) => p.id === igSelProvider)) igSelProvider = list.length ? list[0].id : null;
  root.innerHTML = `
    <div class="prov-layout">
      <div class="prov-list">
        <div class="setting-row" style="padding:0 0 8px">
          <div><div class="label">${t('图片生成')}</div><div class="desc">${t('独立的生图服务商,与对话模型分开。文字模型自动桥接;或 /img 直连。')}</div></div>
          <input type="checkbox" id="ig-enabled" ${ig.enabled ? 'checked' : ''}>
        </div>
        <div id="ig-items"></div>
        <div class="prov-add">
          <label style="font-size:12px;color:var(--text-2)">${t('添加生图服务商')}</label>
          <div style="display:flex;gap:6px">
            <select id="ig-add-type" style="flex:1">
              <option value="openai">OpenAI 兼容</option>
              <option value="gemini">Gemini</option>
            </select>
            <button class="btn" id="ig-add-btn">${t('添加')}</button>
          </div>
        </div>
        <div class="setting-row" style="margin-top:10px;padding:0">
          <div><div class="label">${t('默认生成尺寸')}</div><div class="desc">${t('提示词未指定分辨率时使用;提示词里写了则以提示词为准')}</div></div>
          <select id="ig-size">
            ${['1024x1024', '1024x1792', '1792x1024', '512x512', 'auto'].map((sz) => `<option value="${sz}" ${sz === (ig.size || '1024x1024') ? 'selected' : ''}>${sz}</option>`).join('')}
          </select>
        </div>
        <div class="setting-row" style="padding:0">
          <div><div class="label">${t('自动桥接')}</div><div class="desc">${t('对话中识别到画图意图时文字模型自动调用生图;关闭后仅 /img 可用')}</div></div>
          <input type="checkbox" id="ig-autob" ${ig.autoBridge !== false ? 'checked' : ''}>
        </div>
      </div>
      <div class="prov-editor" id="ig-editor"></div>
    </div>`;
  const save = (patch) => liteapi.invoke('config:set', { imageGen: { ...state.config.imageGen, ...patch } }).then((c) => { state.config = c; });
  $('#ig-enabled', root).addEventListener('change', (e) => save({ enabled: e.target.checked }).then(() => toast(e.target.checked ? t('已开启') : t('已关闭'))));
  $('#ig-size', root).addEventListener('change', (e) => save({ size: e.target.value }));
  $('#ig-autob', root).addEventListener('change', (e) => save({ autoBridge: e.target.checked }));
  $('#ig-add-btn', root).addEventListener('click', () => {
    const id = 'ig' + Date.now().toString(36);
    const type = $('#ig-add-type', root).value;
    liteapi.invoke('imagegen:upsert', { id, name: type === 'gemini' ? 'Gemini 生图' : '新生图服务商', type, baseUrl: '', apiKey: '', local: false, models: [] })
      .then((c) => { state.config = c; igSelProvider = id; renderImageGenPane(root); });
  });
  renderIgItems(root);
  renderIgEditor(root);
}

function renderIgItems(root) {
  const ig = state.config.imageGen || {};
  const list = ig.providers || [];
  const wrap = $('#ig-items', root);
  if (!wrap) return;
  wrap.innerHTML = list.map((p) => {
    const isDef = p.id === ig.providerId;
    const status = p.local ? '● 本地' : ((p.apiKeys || []).length ? `● ${p.apiKeys.length} Key` : '○ 未配置');
    return `
    <div class="prov-item ${p.id === igSelProvider ? 'active' : ''}" data-id="${p.id}">
      <div class="prov-name">${escapeHtml(p.name)}${isDef ? ' <span style="color:var(--accent);font-size:11px">· 默认</span>' : ''}</div>
      <div class="prov-meta">${p.type === 'gemini' ? 'Gemini' : 'OpenAI 兼容'} · ${status} · ${(p.models || []).length} 模型</div>
    </div>`;
  }).join('') || '<div class="side-empty">暂无生图服务商</div>';
  $$('.prov-item', wrap).forEach((item) => item.addEventListener('click', () => {
    igSelProvider = item.dataset.id;
    renderIgItems(root);
    renderIgEditor(root);
  }));
}

function renderIgEditor(root) {
  const ig = state.config.imageGen || {};
  const list = ig.providers || [];
  const p = list.find((x) => x.id === igSelProvider);
  const ed = $('#ig-editor', root);
  if (!ed) return;
  if (!p) { ed.innerHTML = `<div class="side-empty" style="padding:40px 0">${t('左侧选择或添加生图服务商')}</div>`; return; }
  const isDef = p.id === ig.providerId;
  ed.innerHTML = `
    <div class="field">
      <label>${t('名称')}</label>
      <input type="text" id="igf-name" value="${escapeHtml(p.name)}">
    </div>
    <div class="field">
      <label>${t('协议')}</label>
      <select id="igf-type">
        <option value="openai" ${p.type === 'openai' ? 'selected' : ''}>OpenAI 兼容(/v1/images/generations)</option>
        <option value="gemini" ${p.type === 'gemini' ? 'selected' : ''}>Gemini</option>
      </select>
    </div>
    <div class="field">
      <label>BaseURL</label>
      <input type="text" id="igf-base" value="${escapeHtml(p.baseUrl)}" placeholder="https://...">
    </div>
    <div class="field">
      <label>API Keys(${t('可配置多个:请求自动轮换')})${p.local ? ' — 本地服务可留空' : ''}</label>
      <div id="igf-keys"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn" id="igf-key-add">＋ ${t('添加 Key')}</button>
        <button class="btn" id="igf-key-toggle">${t('显示 / 隐藏')}</button>
      </div>
    </div>
    <div class="field">
      <label>${t('生图模型')}</label>
      <select id="igf-model" ${(p.models || []).length ? '' : 'disabled'}>
        ${(p.models || []).map((m) => `<option value="${escapeHtml(m)}" ${m === ig.model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
      </select>
      <label style="margin-top:10px">${t('模型(由「获取模型列表」拉取)')}</label>
      <div id="igf-models" style="display:flex;flex-wrap:wrap;gap:6px;min-height:30px">
        ${(p.models || []).length
          ? p.models.map((m) => `<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);border-radius:8px;padding:2px 8px;font-size:12px">${escapeHtml(m)}<button class="igf-mdel" data-m="${escapeHtml(m)}" style="border:none;background:none;color:var(--text-3);cursor:pointer">✕</button></span>`).join('')
          : `<span class="hint">${t('尚未获取 —— 填好 BaseURL/Key 后点下方按钮')}</span>`}
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn primary" id="igf-fetch">获取模型列表</button>
        ${isDef ? `<span class="hint" style="align-self:center">✓ ${t('当前默认生图服务商')}</span>` : `<button class="btn" id="igf-def">${t('设为默认')}</button>`}
        <button class="btn danger" id="igf-del" style="margin-left:auto">${t('删除此服务商')}</button>
      </div>
    </div>`;
  igKeysState = Array.isArray(p.apiKeys) && p.apiKeys.length ? [...p.apiKeys] : (p.apiKey ? [p.apiKey] : (p.local ? [] : ['']));
  igKeysVisible = false;
  const saveP = (patch) => liteapi.invoke('imagegen:upsert', { ...p, ...patch }).then((c) => { state.config = c; });
  const renderKeys = () => {
    $('#igf-keys', ed).innerHTML = igKeysState.map((k, i) => `
      <div class="key-row" style="margin-bottom:6px">
        <input type="${igKeysVisible ? 'text' : 'password'}" class="igf-key-input" data-i="${i}" value="${escapeHtml(k)}" placeholder="sk-…(第 ${i + 1} 个)">
        <button class="btn" data-keydel="${i}" title="${t('移除此 Key')}" ${igKeysState.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    $$('#igf-keys .igf-key-input', ed).forEach((inp) => {
      inp.addEventListener('input', () => { igKeysState[Number(inp.dataset.i)] = inp.value; });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
    });
    $$('#igf-keys [data-keydel]', ed).forEach((b) => b.addEventListener('click', () => {
      igKeysState.splice(Number(b.dataset.keydel), 1);
      renderKeys();
    }));
  };
  renderKeys();
  $('#igf-model', ed).addEventListener('change', async () => { await liteapi.invoke('config:set', { imageGen: { ...state.config.imageGen, model: $('#igf-model', ed).value } }).then((c) => { state.config = c; }); toast(t('已切换生图模型')); });
  $('#igf-key-add', ed).addEventListener('click', () => { igKeysState.push(''); renderKeys(); });
  $('#igf-key-toggle', ed).addEventListener('click', () => { igKeysVisible = !igKeysVisible; renderKeys(); });
  const saveAll = async () => {
    await saveP({
      name: $('#igf-name', ed).value.trim() || t('未命名'),
      type: $('#igf-type', ed).value,
      baseUrl: $('#igf-base', ed).value.trim(),
      apiKey: igKeysState.map((x) => x.trim()).filter(Boolean)[0] || '',
      apiKeys: igKeysState.map((x) => x.trim()).filter(Boolean),
      local: false,
    });
  };
  ['igf-name', 'igf-base'].forEach((id) => $('#' + id, ed).addEventListener('change', saveAll));
  $('#igf-type', ed).addEventListener('change', async () => { await saveAll(); safeRerender(); });
  const safeRerender = () => {
    // 异步回调返回时设置弹窗可能已被关闭(教训 #11 同族):DOM 不在则静默放弃
    if (!document.getElementById('ig-editor')) return;
    renderIgItems(root);
    renderIgEditor(root);
  };
  $('#igf-fetch', ed).addEventListener('click', async () => {
    await saveAll();
    try {
      const r = await liteapi.invoke('imagegen:fetchModels', p.id);
      toast(`${t('获取到')} ${(r.models || []).length} ${t('个模型')}`);
    } catch (e) { toast(String(e && e.message || e).slice(0, 120)); }
    safeRerender();
  });
  $('#igf-def', ed).addEventListener('click', async () => {
    await saveAll();
    await liteapi.invoke('config:set', { imageGen: { ...state.config.imageGen, providerId: p.id, model: (p.models || [])[0] || '' } }).then((c) => { state.config = c; });
    if (document.getElementById('ig-editor')) renderImageGenPane(root);
    toast(t('已设为默认生图服务商'));
  });
  $('#igf-del', ed).addEventListener('click', async () => {
    if (!confirm(t('删除该生图服务商?'))) return;
    state.config = await liteapi.invoke('imagegen:delete', p.id);
    if ((state.config.imageGen || {}).providerId === p.id) await liteapi.invoke('config:set', { imageGen: { ...state.config.imageGen, providerId: '', model: '' } }).then((c) => { state.config = c; });
    igSelProvider = null;
    if (document.getElementById('ig-editor')) renderImageGenPane(root);
  });
  $$('.igf-mdel', ed).forEach((b) => b.addEventListener('click', async () => {
    const models = (p.models || []).filter((m) => m !== b.dataset.m);
    await saveP({ models });
    safeRerender();
  }));
}

// 登录账号子页:全部支持账号登录的供应商,登录卡集中管理
function renderProviderAccounts(root) {
  const oauths = state.config.providers.filter((p) => p.oauth);
  root.innerHTML = `
    <div class="hint" style="margin-bottom:10px">用订阅账号登录对应供应商(授权窗口跟随 设置 → 网络 的应用代理,无需 API Key);令牌到期会在发送前自动刷新。DeepSeek / 智谱等仅提供 API Key 的供应商不走账号登录 —— 在「模型」子页的编辑器里用控制台直达创建 Key。</div>
    ${oauths.length ? `<div class="ud-conv-cards" style="max-height:none;grid-template-columns:repeat(auto-fill, minmax(330px, 1fr));">${oauths.map((p) => `
      <div class="ud-panel" style="margin:0">
        <div class="ud-card-title">🔑 ${escapeHtml(p.name)}</div>
        <div id="po-${p.oauth}" style="min-height:52px"><div class="hint">读取账号状态中…</div></div>
      </div>`).join('')}</div>` : '<div class="hint">暂无支持账号登录的供应商 —— 在「模型」子页添加「账号登录」类服务商。</div>'}`;
  for (const p of oauths) {
    const card = document.getElementById('po-' + p.oauth);
    if (card) renderOauthCardInto(card, p);
  }
}

// OAuth 登录卡(渲染进任意容器):状态/到期/按钮;登录期间按 kind 轮询进度
async function renderOauthCardInto(card, p) {
  if (!card) return;
  let st;
  try { st = await liteapi.invoke('oauth:status', { kind: p.oauth }); } catch (e) {
    card.innerHTML = `<div class="hint">状态读取失败:${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!card.isConnected) return; // 容器已被重建/拆除
  const acc = st.account;
  const expired = acc && acc.expiresAt && acc.expiresAt < Date.now();
  const busy = !!oauthBusyMap[p.oauth];
  let phaseHtml = '';
  if (busy) {
    if (st.phase === 'device' && st.userCode) {
      phaseHtml = `<div class="hint" style="margin:6px 0">在打开的页面输入确认码:<b style="font-size:15px;user-select:all">${escapeHtml(st.userCode)}</b>;若页面未自动打开,点 <span class="oauth-link" data-url="${escapeHtml(st.verificationUriComplete || st.verificationUri)}">打开授权页</span></div>`;
    } else if (st.phase === 'browser') {
      phaseHtml = '<div class="hint" style="margin:6px 0">已打开授权窗口等待登录…完成后本页自动继续。</div>';
    } else if (st.phase === 'error') {
      phaseHtml = `<div class="hint" style="margin:6px 0;color:var(--danger)">登录失败:${escapeHtml(st.error)}</div>`;
    } else if (st.phase === 'exchanging') {
      phaseHtml = '<div class="hint" style="margin:6px 0">授权成功,正在换取令牌与拉取模型…</div>';
    } else {
      phaseHtml = '<div class="hint" style="margin:6px 0">登录进行中…</div>';
    }
  } else if (st.phase === 'error') {
    phaseHtml = `<div class="hint" style="margin:6px 0;color:var(--danger)">上次登录失败:${escapeHtml(st.error)}</div>`;
  }
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>${acc ? (expired ? '<b style="color:var(--warn)">令牌已过期</b>' : '<b style="color:var(--ok)">✓ 已登录</b>') : '未登录'}</span>
      ${acc ? `<span class="hint" style="font-size:11.5px">${expired ? '发送消息前会尝试自动刷新' : `令牌有效期至 ${new Date(acc.expiresAt).toLocaleString('zh-CN')}`}</span>` : ''}
    </div>
    ${phaseHtml}
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn primary po-login" ${busy ? 'disabled' : ''}>${acc && !expired ? '重新登录' : '登录账号'}</button>
      ${acc ? `<button class="btn po-refresh" ${busy ? 'disabled' : ''}>刷新令牌</button>
      <button class="btn danger po-logout" ${busy ? 'disabled' : ''}>退出登录</button>` : ''}
    </div>
    <div class="hint" style="margin-top:6px">登录成功后自动拉取该账号可用的模型;令牌到期会在发送前自动刷新。授权基于各家开源 CLI 的公开客户端凭据。</div>`;
  $$('.oauth-link', card).forEach((el) => el.addEventListener('click', () => {
    liteapi.invoke('app:openExternal', el.dataset.url).catch(() => {});
  }));
  $('.po-login', card).addEventListener('click', async () => {
    oauthBusyMap[p.oauth] = true;
    renderOauthCardInto(card, p);
    const poll = setInterval(async () => {
      if (!oauthBusyMap[p.oauth] || !card.isConnected) { clearInterval(poll); return; }
      renderOauthCardInto(card, p); // 登录期间轮询进度(设备码/授权窗口状态)
    }, 1500);
    const r = await liteapi.invoke('oauth:login', { kind: p.oauth, providerId: p.id }).catch((e) => ({ ok: false, error: e.message }));
    oauthBusyMap[p.oauth] = false;
    if (card.isConnected) renderOauthCardInto(card, p);
    if (settingsTab === 'providers') renderProvItems(); // 列表登录态徽标同步
    if (r && r.ok) toast(`登录成功,已拉取 ${r.models} 个模型`);
    else toast(`登录失败:${(r && r.error) || '未知错误'}`);
  });
  const rf = $('.po-refresh', card);
  if (rf) rf.addEventListener('click', async () => {
    const r = await liteapi.invoke('oauth:refresh', { kind: p.oauth, providerId: p.id }).catch(() => ({ ok: false }));
    toast(r && r.ok ? '令牌已刷新' : '刷新失败(将在发送前自动重试)');
    renderOauthCardInto(card, p);
  });
  const lg = $('.po-logout', card);
  if (lg) lg.addEventListener('click', async () => {
    await liteapi.invoke('oauth:logout', { kind: p.oauth, providerId: p.id });
    renderOauthCardInto(card, p);
    if (settingsTab === 'providers') renderProvItems();
    toast('已退出登录');
  });
}

function renderProvItems() {  const wrap = $('#prov-items');
  if (!wrap) return; // 异步保存完成时设置弹窗可能已关闭(DOM 已拆),静默跳过
  wrap.innerHTML = state.config.providers.map((p) => {
    const acc = p.oauth && state.config.oauthAccounts && state.config.oauthAccounts[p.oauth];
    const statusTxt = p.oauth
      ? (acc && acc.accessToken ? (acc.expiresAt && acc.expiresAt < Date.now() ? '● 已登录(过期)' : '● 已登录') : '○ 未登录')
      : (p.local ? '● 本地' : ((p.apiKeys && p.apiKeys.length) ? `● ${p.apiKeys.length} Key` : '○ 未配置'));
    return `
    <div class="prov-item ${p.id === settingsSelProvider ? 'active' : ''}" data-id="${p.id}">
      <div class="prov-name">${p.oauth ? '🔑 ' : ''}${escapeHtml(p.name)}</div>
      <div class="prov-meta">${TYPE_LABEL[p.type] || p.type} · ${statusTxt} · ${(p.models || []).length} 模型</div>
    </div>`;
  }).join('') || '<div class="side-empty">暂无服务商</div>';
  $$('.prov-item', wrap).forEach((item) => item.addEventListener('click', () => {
    settingsSelProvider = item.dataset.id;
    renderProvItems();
    renderProviderEditor();
  }));
}

// —— 模型选择二级窗口(v0.57.8)——
// 「获取模型列表」不再一键全入:弹出二级卡片,顶部搜索框、全选/全部取消,勾选后再添加。
// 已存在的模型勾上并置灰,不重复添加。
let modelPickCtx = null;
function closeModelPickDialog() {
  const root = $('#mpick-root');
  if (root) root.remove();
  modelPickCtx = null;
}
function openModelPickDialog({ title, models, existing, onConfirm }) {
  closeModelPickDialog();
  const added = new Set(existing || []);
  const all = [...new Set((models || []).map(String))]; // 保持上游原始顺序(族/版本分组更有意义)
  const sel = new Set(all.filter((m) => !added.has(m))); // 默认勾选未添加的
  const root = document.createElement('div');
  root.id = 'mpick-root';
  root.innerHTML = `
    <div id="mpick-card">
      <div class="mpick-head"><b>${escapeHtml(title || t('选择要添加的模型'))}</b><span class="mpick-total"></span><button type="button" class="mpick-x" title="${t('关闭')}">✕</button></div>
      <input id="mpick-search" type="text" placeholder="${t('搜索模型（名称包含…）')}" autocomplete="off" spellcheck="false">
      <div class="mpick-tools">
        <button type="button" class="btn" id="mpick-all">${t('全选')}</button>
        <button type="button" class="btn" id="mpick-none">${t('全部取消')}</button>
        <span class="mpick-sel"></span>
      </div>
      <div id="mpick-list"></div>
      <div class="mpick-foot">
        <button type="button" class="btn" id="mpick-cancel">${t('取消')}</button>
        <button type="button" class="btn primary" id="mpick-ok"></button>
      </div>
    </div>`;
  document.body.appendChild(root);
  modelPickCtx = { all, added, sel, q: '' };

  const listEl = $('#mpick-list', root);
  const searchEl = $('#mpick-search', root);
  const okBtn = $('#mpick-ok', root);

  const render = () => {
    const ctx = modelPickCtx;
    if (!ctx) return;
    const q = ctx.q.trim().toLowerCase();
    const rows = ctx.all.filter((m) => !q || m.toLowerCase().includes(q));
    listEl.innerHTML = rows.length ? rows.map((m) => {
      const isAdded = ctx.added.has(m);
      const checked = isAdded || ctx.sel.has(m);
      return `<label class="mpick-row${isAdded ? ' added' : ''}">
        <input type="checkbox" data-m="${escapeHtml(m)}" ${checked ? 'checked' : ''} ${isAdded ? 'disabled' : ''}>
        <span class="mpick-name" title="${escapeHtml(m)}">${escapeHtml(m)}</span>
        ${isAdded ? `<span class="mpick-tag">${t('已添加')}</span>` : ''}
      </label>`;
    }).join('') : `<div class="mpick-empty">${t('没有匹配的模型')}</div>`;
    // 只统计可添加(未入库)的选中数
    const newSel = [...ctx.sel].filter((m) => !ctx.added.has(m)).length;
    $('.mpick-total', root).textContent = `${ctx.all.length} ${t('个模型')} · ${ctx.all.filter((m) => ctx.added.has(m)).length} ${t('已添加')}`;
    $('.mpick-sel', root).textContent = `${t('已选')} ${newSel}`;
    okBtn.textContent = `${t('添加')} ${newSel} ${t('个')}`;
    okBtn.disabled = newSel === 0;
  };

  listEl.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb || !modelPickCtx) return;
    const m = cb.dataset.m;
    if (cb.checked) modelPickCtx.sel.add(m);
    else modelPickCtx.sel.delete(m);
    render();
  });
  searchEl.addEventListener('input', () => {
    if (!modelPickCtx) return;
    modelPickCtx.q = searchEl.value;
    render();
  });
  searchEl.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 不触发全局快捷键
    if (e.key === 'Escape') { e.preventDefault(); closeModelPickDialog(); }
    if (e.key === 'Enter') { e.preventDefault(); if (!okBtn.disabled) okBtn.click(); }
  });
  $('#mpick-all', root).addEventListener('click', () => {
    if (!modelPickCtx) return;
    const q = modelPickCtx.q.trim().toLowerCase();
    for (const m of modelPickCtx.all) {
      if (modelPickCtx.added.has(m)) continue;
      if (q && !m.toLowerCase().includes(q)) continue; // 只选当前可见的
      modelPickCtx.sel.add(m);
    }
    render();
  });
  $('#mpick-none', root).addEventListener('click', () => {
    if (!modelPickCtx) return;
    modelPickCtx.sel.clear();
    render();
  });
  $('#mpick-cancel', root).addEventListener('click', () => closeModelPickDialog());
  $('.mpick-x', root).addEventListener('click', () => closeModelPickDialog());
  root.addEventListener('click', (e) => { if (e.target === root) closeModelPickDialog(); });
  okBtn.addEventListener('click', async () => {
    const ctx = modelPickCtx;
    if (!ctx) return;
    const picked = [...ctx.sel].filter((m) => !ctx.added.has(m));
    if (!picked.length) return;
    okBtn.disabled = true;
    try { await onConfirm(picked); } finally { closeModelPickDialog(); }
  });
  render();
  searchEl.focus();
}

// —— 一键清理未使用的服务商模板(v0.57.7)——
// 用户现场:预设带进来的模板(OpenRouter/Ollama/LM Studio/Groq/xAI 等)未配置也无模型,
// 堆在供应商列表里只能逐个删。这里给出批量入口:主进程判定(无 Key/未登录/无引用),
// 先 dryRun 预览名字 → confirm → 一次删除;按钮只在有候选时出现。
async function renderProviderCleanRow() {
  const row = $('#prov-clean-row');
  const btn = $('#prov-clean-btn');
  if (!row || !btn) return; // 异步回调时弹窗可能已关闭
  let info = null;
  try { info = await liteapi.invoke('providers:cleanupUnused', { dryRun: true }); } catch (_) { return; }
  if (!row.isConnected) return;
  const names = (info && info.names) || [];
  if (!names.length) { row.classList.add('hidden'); btn.onclick = null; return; }
  row.classList.remove('hidden');
  btn.textContent = `${t('清理未使用的模板')} (${names.length})`;
  btn.title = names.join('、');
  btn.onclick = async () => {
    let preview = null;
    try { preview = await liteapi.invoke('providers:cleanupUnused', { dryRun: true }); } catch (_) { return; }
    const list = (preview && preview.names) || [];
    if (!list.length) return;
    const ok = confirm(`${t('将删除以下未配置的服务商')}(${list.length}):\n\n${list.join('、')}\n\n${t('删除后可从「添加服务商」随时重新添加')}`);
    if (!ok) return;
    const res = await liteapi.invoke('providers:cleanupUnused', {});
    state.config = res.config;
    if (!(state.config.providers || []).some((p) => p.id === settingsSelProvider)) {
      settingsSelProvider = state.config.providers[0] ? state.config.providers[0].id : null;
    }
    renderProvItems();
    renderProviderEditor();
    renderProviderAddBox();
    renderProviderCleanRow();
    fillModelSelect();
    toast(`${t('已清理')} ${res.removed.length} ${t('个未使用的服务商')}`);
  };
}

function renderProviderAddBox() {
  const box = $('#prov-add-box');
  if (!box) return;
  if (!presetsCache) { box.innerHTML = '<div class="hint" style="font-size:11px;color:var(--text-3)">加载中…</div>'; return; }
  const existing = new Set(state.config.providers.map((p) => p.id));
  const available = presetsCache.filter((p) => !existing.has(p.id));
  box.innerHTML = `
    <select id="add-preset-sel">
      <option value="__custom">自定义…</option>
      ${available.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
    </select>
    <button class="btn" id="add-preset-btn">添加</button>
    <div class="hint" style="margin-top:6px">带「账号登录」的服务商 = 用订阅账号 OAuth 授权直用,无需 API Key(登录卡在添加后的编辑器里)。</div>`;
  $('#add-preset-btn', box).addEventListener('click', async () => {
    const v = $('#add-preset-sel', box).value;
    if (v === '__custom') {
      const res = await liteapi.invoke('providers:upsert', {
        id: 'custom-' + uid().slice(0, 8),
        name: '自定义服务', type: 'openai', baseUrl: '', apiKey: '', models: [],
      });
      state.config = res;
      settingsSelProvider = state.config.providers[state.config.providers.length - 1].id;
    } else {
      const res = await liteapi.invoke('providers:addPreset', v);
      state.config = res;
      settingsSelProvider = v;
    }
    renderProvItems();
    renderProviderEditor();
    renderProviderAddBox();
    fillModelSelect();
  });
}

function scheduleProviderSave(provider) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state.reasonCapsCache.clear();
    state.config = await liteapi.invoke('providers:upsert', provider);
    renderProvItems();
    fillModelSelect();
  }, 350);
}

function renderProviderEditor() {
  const ed = $('#prov-editor');
  if (!ed) return; // 弹窗已关闭时跳过(异步保存回调可能晚于 DOM 拆除)
  const p = state.config.providers.find((x) => x.id === settingsSelProvider);
  if (!p) { ed.innerHTML = '<div class="side-empty">左侧选择或添加服务商</div>'; return; }

  ed.innerHTML = `
    <div class="field-row">
      <div class="field"><label>名称</label><input type="text" id="pf-name" value="${escapeHtml(p.name)}"></div>
      <div class="field"><label>协议类型</label>
        <select id="pf-type">
          <option value="openai" ${p.type === 'openai' ? 'selected' : ''}>OpenAI 兼容(覆盖面最广)</option>
          <option value="anthropic" ${p.type === 'anthropic' ? 'selected' : ''}>Anthropic(Claude)</option>
          <option value="gemini" ${p.type === 'gemini' ? 'selected' : ''}>Google Gemini</option>
          <option value="codex" ${p.type === 'codex' ? 'selected' : ''}>ChatGPT 账号(Responses)</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label>API 地址 BaseURL</label>
      <input type="text" id="pf-baseurl" value="${escapeHtml(p.baseUrl)}" placeholder="https://api.example.com">
      <div class="hint">默认自动补 /v1;地址已含 /v1、/v4 等版本号则原样使用;结尾加 # 表示完全按原样请求。</div>
    </div>
    ${p.oauth ? `
    <div class="field">
      <label>账号登录</label>
      <div class="hint">此供应商使用账号登录(OAuth)—— 登录与令牌管理在页面上方的<b>「登录账号」子页</b>集中进行,此处无需 API Key。</div>
    </div>` : `
    <div class="field">
      <label>API Keys(可配置多个:请求自动轮换;遇 401/403/429 自动切换下一个)${p.local ? ' — 本地服务可留空' : ''}</label>
      <div id="pf-keys"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn" id="pf-key-add">＋ 添加 Key</button>
        <button class="btn" id="pf-key-toggle">显示 / 隐藏</button>
      </div>
      ${p.consoleUrl ? `<div class="hint" style="margin-top:6px">该服务商无账号登录:在控制台创建 API Key 后填入。 <span class="oauth-link" data-url="${escapeHtml(p.consoleUrl)}">登录控制台获取密钥 ↗</span></div>` : ''}
    </div>`}
    <div class="field">
      <label>模型与推理档位(每行一个模型,选择即固定该模型的默认推理档;档位含 GPT 官方全阶:minimal/low/medium/high/xhigh/max)</label>
      <div id="pf-model-rows"></div>
      <div class="model-add-row">
        <input type="text" id="pf-model-input" placeholder="手动输入模型 ID,如 deepseek-chat">
        <button class="btn" id="pf-model-add">添加</button>
        <button class="btn primary" id="pf-fetch">获取模型列表</button>
      </div>
      <div class="hint">「获取模型列表」自动拉取;本地 Ollama / LM Studio 无需 API Key。选「GPT 档位(手动)」后点 ⚙ 勾选该模型可用的档位(可单选=锁定单档,可多选)并指定默认档 —— 输入框上方的滑块只会显示这里勾选的档位;「自动」= 按内置库 + 上游识别。选「自定义预算」后直接在行内输入预算 tokens(留空跟随滑块档位)。手动档位模型不支持时请求会报错,换回低档即可。</div>
    </div>
    <div style="padding-top:12px">
      <button class="btn danger" id="pf-delete">删除此服务商</button>
    </div>`;

  $$('#prov-editor .oauth-link').forEach((el) => el.addEventListener('click', () => liteapi.invoke('app:openExternal', el.dataset.url).catch(() => {}))); // 控制台直达

  // 多 Key 输入:本地状态数组驱动,输入不重渲染(保住焦点)
  let keysState = Array.isArray(p.apiKeys) && p.apiKeys.length
    ? [...p.apiKeys]
    : (p.apiKey ? [p.apiKey] : (p.local ? [] : ['']));
  let keysVisible = false;

  const renderKeys = () => {
    $('#pf-keys').innerHTML = keysState.map((k, i) => `
      <div class="key-row" style="margin-bottom:6px">
        <input type="${keysVisible ? 'text' : 'password'}" class="pf-key-input" data-i="${i}" value="${escapeHtml(k)}" placeholder="sk-…(第 ${i + 1} 个)">
        <button class="btn" data-keydel="${i}" title="移除此 Key" ${keysState.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>`).join('');
    $$('#pf-keys .pf-key-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        keysState[Number(inp.dataset.i)] = inp.value;
        scheduleProviderSave(collect());
      });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
    });
    $$('#pf-keys [data-keydel]').forEach((b) => b.addEventListener('click', () => {
      keysState.splice(Number(b.dataset.keydel), 1);
      renderKeys();
      scheduleProviderSave(collect());
    }));
  };
  if (!p.oauth) renderKeys(); // OAuth 供应商用账号登录卡,无 Key 输入区

  const collect = () => {
    const keys = keysState.map((s) => s.trim()).filter(Boolean);
    return {
      id: p.id,
      name: $('#pf-name').value,
      type: $('#pf-type').value,
      baseUrl: $('#pf-baseurl').value.trim(),
      apiKey: keys[0] || '',
      apiKeys: keys,
      models: p.models || [],
      local: p.local,
      oauth: p.oauth || null,
      modelCaps: p.modelCaps || {},
    };
  };

  $('#pf-name').addEventListener('input', () => scheduleProviderSave(collect()));
  $('#pf-type').addEventListener('change', () => scheduleProviderSave(collect()));
  $('#pf-baseurl').addEventListener('input', () => scheduleProviderSave(collect()));

  if (!p.oauth) {
    $('#pf-key-add').addEventListener('click', () => {
      keysState.push('');
      renderKeys();
      const inputs = $$('#pf-keys .pf-key-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $('#pf-key-toggle').addEventListener('click', () => {
      keysVisible = !keysVisible;
      renderKeys();
    });
  }

  // 逐模型推理档位(铺开成行):manual 配置写入 p.modelCaps。
  // v0.22 语义修正:行内配置的档位集合 = 滑块可用档位(选几个显示几个,单选即锁定单档),
  // 不再"选一个默认档但滑块全阶可调"。GPT 档位模式点 ⚙ 展开编辑:多选档位 + 指定默认档。
  const EFFORT_MODE_OPTS = [
    ['auto', '自动(内置库)'],
    ['none', '不支持推理'],
    ['cn', '国产通用(低/中/高)'],
    ['effort', 'GPT 档位(手动)'],
    ['thinking_effort', '思考开关 + effort 档位(DeepSeek V4 式)'],
    ['qwen', '自定义预算(enable_thinking)'],
    ['zhipu', '思考开关(GLM)'],
    ['fixed', '始终深度推理'],
  ];
  const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const TIER_LABEL = { off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
  const modeValueFor = (m) => {
    const mc = p.modelCaps && p.modelCaps[m];
    if (!mc || mc.source !== 'manual') return 'auto';
    if (mc.style === 'openai_effort') return mc.preset === 'cn' ? 'cn' : 'effort';
    return ['none', 'qwen', 'zhipu', 'fixed', 'thinking_effort'].includes(mc.style) ? mc.style : 'auto';
  };
  const manualOf = (m) => {
    const mc = p.modelCaps && p.modelCaps[m];
    return (mc && mc.source === 'manual') ? mc : null;
  };
  const effortLevelsOf = (m) => {
    const mc = manualOf(m);
    const lv = (mc && mc.style === 'openai_effort' && Array.isArray(mc.levels)) ? mc.levels.filter((x) => EFFORT_LADDER.includes(x)) : [];
    return lv.length ? lv : ['medium'];
  };
  const effortDefaultOf = (m) => {
    const mc = manualOf(m);
    const lv = effortLevelsOf(m);
    const d = mc && mc.defaultLevel;
    return lv.includes(d) ? d : lv[lv.length - 1];
  };
  const summaryFor = (m) => {
    const mc = manualOf(m);
    if (!mc) return '自动(内置库)';
    if (mc.style === 'none') return '已禁用推理';
    if (mc.style === 'qwen') {
      const key = `${p.id}::${m}`;
      const b = (state.config.reasonChoice || {})[key];
      return Number.isInteger(b) ? `预算模式 · 当前 ${b} tokens` : '预算模式 · 未设预算';
    }
    if (mc.style === 'zhipu') return '开关模式';
    if (mc.style === 'thinking_effort') {
      const d = TIER_LABEL[mc.defaultLevel] || mc.defaultLevel || '高';
      return `开关 + effort · 默认 ${d}`;
    }
    if (mc.style === 'fixed') return '始终推理';
    if (mc.style === 'openai_effort') {
      const lv = effortLevelsOf(m);
      const d = effortDefaultOf(m);
      const pre = mc.preset === 'cn' ? '国产通用 · ' : '';
      return lv.length === 1 ? `${pre}仅 ${TIER_LABEL[d] || d}` : `${pre}默认 ${TIER_LABEL[d] || d} · 可调 ${lv.map((x) => TIER_LABEL[x] || x).join('/')}`;
    }
    return '自动(内置库)';
  };
  const expandedTiers = new Set(); // 展开档位编辑器的模型

  const saveModelCaps = (m) => {
    scheduleProviderSave(collect());
    state.reasonCapsCache.clear(); // composer 立即按新档位集合重新解析
    state.reasonRenderKey = null;
    fillReasonSelect();
  };

  const renderModelRows = () => {
    const rows = $('#pf-model-rows');
    if (!rows) return; // 弹窗已关闭时跳过
    rows.innerHTML = (p.models || []).map((m) => {
      const isEffort = ['effort', 'cn'].includes(modeValueFor(m)); // 国产通用预设也属于手动档位模式
      const expanded = expandedTiers.has(m) && isEffort;
      let editor = '';
      if (expanded) {
        const lv = effortLevelsOf(m);
        const d = effortDefaultOf(m);
        editor = `
        <div class="mr-editor" data-editor="${escapeHtml(m)}">
          <div class="mr-presets">
            <button class="mr-preset" data-preset="cn" title="一键设为 低/中/高 三档,默认中">国产通用:低/中/高</button>
            <button class="mr-preset" data-preset="gpt" title="GPT 官方全阶(关/极简/低/中/高/超高/最大)">GPT 全阶</button>
          </div>
          <div class="mr-tiers">${EFFORT_LADDER.map((t) => `<button class="mr-tier ${lv.includes(t) ? 'on' : ''}" data-tier="${t}" title="${lv.includes(t) ? '点击移除' : '点击加入'}">${TIER_LABEL[t]}</button>`).join('')}</div>
          <label class="mr-default-label">默认档位
            <select class="mr-default" data-m="${escapeHtml(m)}">${lv.map((t) => `<option value="${t}" ${t === d ? 'selected' : ''}>${TIER_LABEL[t] || t}</option>`).join('')}</select>
          </label>
          <span class="hint">滑块只会显示这里勾选的档位;默认档 = 打开对话时的初始位置</span>
        </div>`;
      }
      const mcRow = p.modelCaps && p.modelCaps[m];
      const ctxVal = mcRow && Number.isInteger(mcRow.ctxLimit) ? mcRow.ctxLimit : '';
      return `
      <div class="model-row ${expanded ? 'expanded' : ''}" data-m="${escapeHtml(m)}">
        <span class="mr-name" title="${escapeHtml(m)}">${escapeHtml(m)}</span>
        <span class="mr-summary" title="${escapeHtml(summaryFor(m))}">${escapeHtml(summaryFor(m))}</span>
        <input type="number" class="mr-ctx" data-m="${escapeHtml(m)}" min="1000" step="1000" placeholder="最大上下文" title="该模型的最大上下文 tokens(手动指定后,底部用量条的「上下文已用」以此为准,优先于内置库)" value="${ctxVal}">
        <select class="mr-mode" data-m="${escapeHtml(m)}" title="推理模式与档位配置">
          ${EFFORT_MODE_OPTS.map(([v, l]) => `<option value="${v}" ${modeValueFor(m) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${modeValueFor(m) === 'qwen' ? `<input type="number" class="mr-budget" data-m="${escapeHtml(m)}" min="256" step="256" placeholder="预算 tokens,如 8192" title="自定义推理预算;留空 = 跟随滑块档位" value="${Number.isInteger((state.config.reasonChoice || {})[`${p.id}::${m}`]) ? (state.config.reasonChoice || {})[`${p.id}::${m}`] : ''}">` : ''}
        <button class="mr-gear ${isEffort ? '' : 'hidden'}" type="button" data-m="${escapeHtml(m)}" title="配置该模型可用的档位与默认档">档位配置</button>
        <button class="mr-del" type="button" title="移除模型">✕</button>
      </div>${editor}`;
    }).join('')
      || '<div class="hint" style="padding:6px 2px">暂无模型:手动输入添加,或点击「获取模型列表」。</div>';

    $$('#pf-model-rows .mr-ctx').forEach((inp) => inp.addEventListener('change', () => {
      const m = inp.dataset.m;
      p.modelCaps = p.modelCaps || {};
      const v = parseInt(inp.value, 10);
      if (Number.isInteger(v) && v >= 1000) {
        p.modelCaps[m] = { ...(p.modelCaps[m] || { style: 'auto', levels: [], source: 'manual' }), ctxLimit: v };
      } else {
        if (p.modelCaps[m]) delete p.modelCaps[m].ctxLimit;
        if (p.modelCaps[m] && !Object.keys(p.modelCaps[m]).some((k) => k !== 'ctxLimit' && k !== 'source')) delete p.modelCaps[m];
      }
      saveModelCaps(m);
      renderUsageBar(); // 分母变化,用量条即时重画
      toast(`${m}:${inp.value ? t('最大上下文') + ' ' + inp.value : t('已清除手动上下文')}`);
    }));
    // 自动上下文:模型行留空时,用占位符展示解析值(GPT 272K / 上游 context_length / 模型库)
    liteapi.invoke('reason:capsBatch', { models: p.models || [], providerId: p.id }).then((batch) => {
      if (!ed.isConnected) return;
      for (const inp of $$('#pf-model-rows .mr-ctx')) {
        if (inp.value) continue; // 手动值优先
        const lim = Number(batch && batch[inp.dataset.m] && batch[inp.dataset.m].contextLimit) || 0;
        if (lim > 0) {
          inp.placeholder = '自动 ' + lim;
          inp.title = `${t('最大上下文')}:自动 ${lim}(来自模型库 / GPT 规则,手动填写可覆盖)`;
        }
      }
    }).catch(() => {});
    $$('#pf-model-rows .mr-mode').forEach((sel) => sel.addEventListener('change', () => {
      const m = sel.dataset.m;
      const v = sel.value;
      p.modelCaps = p.modelCaps || {};
      if (v === 'auto') delete p.modelCaps[m];
      else if (v === 'none') p.modelCaps[m] = { style: 'none', levels: [], source: 'manual' };
      else if (v === 'cn') {
        // 国产通用预设:低/中/高,默认中 —— 应用后编辑器自动展开,可继续微调
        p.modelCaps[m] = { style: 'openai_effort', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', source: 'manual', preset: 'cn' };
        expandedTiers.add(m);
      } else if (v === 'effort') {
        const prev = manualOf(m);
        if (!(prev && prev.style === 'openai_effort')) {
          p.modelCaps[m] = { style: 'openai_effort', levels: ['medium'], defaultLevel: 'medium', source: 'manual' };
        }
        expandedTiers.add(m);
      } else if (v === 'qwen') p.modelCaps[m] = { style: 'qwen', levels: ['off', 'low', 'medium', 'high', 'custom'], source: 'manual' };
      else if (v === 'thinking_effort') p.modelCaps[m] = { style: 'thinking_effort', levels: ['off', 'low', 'high', 'max'], defaultLevel: 'high', source: 'manual' };
      else if (v === 'zhipu') p.modelCaps[m] = { style: 'zhipu', levels: ['off', 'on'], source: 'manual' };
      else if (v === 'fixed') p.modelCaps[m] = { style: 'fixed', levels: ['on'], source: 'manual' };
      saveModelCaps(m);
      renderModelRows();
      toast(`${m}:${summaryFor(m)}`);
    }));
    $$('#pf-model-rows .mr-budget').forEach((inp) => inp.addEventListener('change', () => {
      const m = inp.dataset.m;
      const key = `${p.id}::${m}`;
      const v = Math.round(Number(inp.value));
      const rc = { ...(state.config.reasonChoice || {}) };
      if (v > 0) rc[key] = v;
      else delete rc[key];
      liteapi.invoke('config:set', { reasonChoice: rc }).then((c) => {
        state.config = c;
        state.reasonCapsCache.clear();
        state.reasonRenderKey = null;
        fillReasonSelect();
        renderModelRows();
        toast(v > 0 ? `${m} 推理预算:${v} tokens` : `${m} 预算已清除,跟随滑块档位`);
      });
    }));
    $$('#pf-model-rows .mr-gear').forEach((b) => b.addEventListener('click', () => {
      const m = b.dataset.m;
      if (expandedTiers.has(m)) expandedTiers.delete(m);
      else expandedTiers.add(m);
      renderModelRows();
    }));
    $$('#pf-model-rows .mr-tier').forEach((chip) => chip.addEventListener('click', () => {
      const m = chip.closest('.mr-editor').dataset.editor;
      const t = chip.dataset.tier;
      const mc = manualOf(m);
      if (!mc) return;
      const lv = effortLevelsOf(m);
      let next;
      if (lv.includes(t)) {
        if (lv.length <= 1) { toast('至少保留一个档位'); return; }
        next = lv.filter((x) => x !== t);
      } else {
        next = EFFORT_LADDER.filter((x) => lv.includes(x) || x === t); // 按 GPT 官方档位顺序排列
      }
      let d = effortDefaultOf(m);
      if (!next.includes(d)) d = next[next.length - 1];
      mc.levels = next;
      mc.defaultLevel = d;
      delete mc.preset; // 手动微调后不再是命名预设
      saveModelCaps(m);
      renderModelRows();
    }));
    $$('#pf-model-rows .mr-preset').forEach((b) => b.addEventListener('click', () => {
      const m = b.closest('.mr-editor').dataset.editor;
      const mc = manualOf(m);
      if (!mc) return;
      const presets = {
        cn: { levels: ['low', 'medium', 'high'], def: 'medium' },
        gpt: { levels: EFFORT_LADDER.slice(), def: 'medium' },
      };
      const pr = presets[b.dataset.preset];
      if (!pr) return;
      mc.levels = pr.levels.slice();
      mc.defaultLevel = pr.def;
      mc.preset = b.dataset.preset === 'cn' ? 'cn' : undefined;
      if (!mc.preset) delete mc.preset;
      saveModelCaps(m);
      renderModelRows();
      toast(`已应用预设:${b.textContent}`);
    }));
    $$('#pf-model-rows .mr-default').forEach((sel) => sel.addEventListener('change', () => {
      const m = sel.dataset.m;
      const mc = manualOf(m);
      if (!mc) return;
      mc.defaultLevel = sel.value;
      delete mc.preset;
      saveModelCaps(m);
      renderModelRows();
    }));
    $$('#pf-model-rows .mr-del').forEach((b) => b.addEventListener('click', async () => {
      const m = b.closest('.model-row').dataset.m;
      state.config = await liteapi.invoke('providers:removeModel', { id: p.id, model: m });
      p.models = state.config.providers.find((x) => x.id === p.id).models;
      renderModelRows();
      renderProvItems();
      fillModelSelect();
    }));
  };
  renderModelRows();

  $('#pf-model-add').addEventListener('click', async () => {
    const inp = $('#pf-model-input');
    const m = inp.value.trim();
    if (!m) return;
    state.config = await liteapi.invoke('providers:addModel', { id: p.id, model: m });
    p.models = state.config.providers.find((x) => x.id === p.id).models;
    inp.value = '';
    renderModelRows();
    renderProvItems();
    fillModelSelect();
  });
  $('#pf-model-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#pf-model-add').click(); }
    e.stopPropagation();
  });

  $('#pf-fetch').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '获取中…';
    try {
      // preview:只拉取不入库 → 开二级窗口勾选后再添加(v0.57.8)
      const res = await liteapi.invoke('providers:fetchModels', { id: p.id, preview: true });
      state.config = res.config;
      const cur = state.config.providers.find((x) => x.id === p.id) || p;
      const existing = (cur.models || []).slice();
      const fresh = (res.models || []).filter((m) => !existing.includes(m));
      if (!(res.models || []).length) {
        toast('上游没有返回模型列表');
      } else if (!fresh.length) {
        toast(`上游 ${res.models.length} 个模型都已添加`);
      } else {
        openModelPickDialog({
          title: `${t('选择要添加的模型')} · ${p.name}`,
          models: res.models || [],
          existing,
          onConfirm: async (picked) => {
            const cfg = await liteapi.invoke('providers:addModels', { id: p.id, models: picked });
            state.config = cfg;
            const np = state.config.providers.find((x) => x.id === p.id);
            if (np) p.models = np.models;
            renderModelRows();
            renderProvItems();
            fillModelSelect();
            state.reasonCapsCache.clear();
            toast(`${t('已添加')} ${picked.length} ${t('个模型')}${res.capsMerged ? `,${t('识别')} ${res.capsMerged} ${t('个模型的推理能力')}` : ''}`);
          },
        });
      }
    } catch (err) {
      toast(err.message || '获取失败');
    }
    btn.disabled = false;
    btn.textContent = '获取模型列表';
  });

  $('#pf-delete').addEventListener('click', async () => {
    if (!confirm(`确定删除服务商「${p.name}」?`)) return;
    state.config = await liteapi.invoke('providers:delete', p.id);
    settingsSelProvider = state.config.providers[0] ? state.config.providers[0].id : null;
    renderProvItems();
    renderProviderEditor();
    renderProviderAddBox();
    fillModelSelect();
  });
}

/* ---- Agent 规约(Agent.md)tab(v0.57.9)----
   用户全局规则:写在这里的内容会拼进每次请求的 system(含子智能体),
   位置在身份声明之后 —— 优先级高于默认风格设定,但不凌驾于安全/沙箱约束。 */
let agentMdDraft = null; // 未保存草稿(切页不丢;保存后清空)
function renderAgentMdPane() {
  const body = $('#modal-body');
  if (!body) return;
  const saved = String(state.config.agentMd || '');
  if (agentMdDraft == null) agentMdDraft = saved;
  body.innerHTML = `
    ${settingsSection('📜 Agent 规约(Agent.md)', 'amd-box')}
    <div id="amd-holder"></div>`;
  const holder = $('#amd-holder', body);
  holder.innerHTML = `
      <div class="hint" style="margin-bottom:8px">写在这里的规则是<b>全局</b>的:所有对话、所有模式(含子智能体)每次都生效。<br>适合放:回答风格、代码规范、必须/禁止事项、常用上下文。不建议放密钥或会频繁变化的内容(每条请求都会带上,计入上下文消耗)。</div>
      <textarea id="amd-text" class="amd-text" spellcheck="false" placeholder="例如:\n- 回答先给结论,再给理由,不超过 3 段。\n- 代码一律使用 TypeScript,缩进 2 空格。\n- 涉及删除/覆盖文件前,先用 ask_user 确认。">${escapeHtml(agentMdDraft)}</textarea>
      <div class="amd-foot">
        <span class="amd-count" id="amd-count"></span>
        <button class="btn" id="amd-clear" type="button">${t('清空')}</button>
        <button class="btn primary" id="amd-save" type="button">${t('保存规约')}</button>
      </div>
      <div class="hint" id="amd-state" style="margin-top:6px"></div>`;
  const ta = $('#amd-text', body);
  const count = $('#amd-count', body);
  const stateEl = $('#amd-state', body);
  const refresh = () => {
    const n = (ta.value || '').length;
    count.textContent = `${n} ${t('字符')}`;
    const dirty = ta.value !== String(state.config.agentMd || '');
    stateEl.textContent = dirty ? t('有未保存的修改(Ctrl+S 保存)') : t('已保存');
    stateEl.style.color = dirty ? 'var(--warn)' : 'var(--text-3)';
  };
  const save = async () => {
    const v = ta.value;
    state.config = await liteapi.invoke('config:set', { agentMd: v });
    agentMdDraft = null;
    refresh();
    toast(v.trim() ? t('已保存 Agent 规约') : t('已清空 Agent 规约'));
  };
  ta.addEventListener('input', () => { agentMdDraft = ta.value; refresh(); });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  $('#amd-save', body).addEventListener('click', save);
  $('#amd-clear', body).addEventListener('click', () => {
    if (!confirm(t('确定清空 Agent 规约?'))) return;
    ta.value = '';
    agentMdDraft = '';
    refresh();
    ta.focus();
  });
  refresh();
}

/* ---- 提示词(助手角色)tab ---- */
let settingsSelAssistant = 'default';

function renderAssistantsPane(root) {
  const R = root || $('#modal-body');
  const list = state.config.assistants || [];
  if (!list.some((a) => a.id === settingsSelAssistant)) settingsSelAssistant = list[0] ? list[0].id : 'default';
  R.innerHTML = `
    <div class="prov-layout">
      <div class="prov-list">
        <div id="ast-items"></div>
        <div class="prov-add">
          <button class="btn" id="ast-add">＋ 添加助手</button>
        </div>
      </div>
      <div class="prov-editor" id="ast-editor"></div>
    </div>`;
  renderAstItems();
  renderAstEditor();
}

function renderAstItems() {
  const wrap = $('#ast-items');
  const activeId = state.config.ui.activeAssistantId;
  wrap.innerHTML = (state.config.assistants || []).map((a) => `
    <div class="prov-item ${a.id === settingsSelAssistant ? 'active' : ''}" data-id="${a.id}">
      <div class="prov-name">${escapeHtml(a.icon || '🤖')} ${escapeHtml(a.name)} ${a.id === activeId ? '<span style="color:var(--accent);font-size:10.5px">· 使用中</span>' : ''}</div>
      <div class="prov-meta">${a.prompt ? escapeHtml(a.prompt.slice(0, 24)) + '…' : '无自定义提示词'}</div>
    </div>`).join('');
  $$('.prov-item', wrap).forEach((item) => item.addEventListener('click', () => {
    settingsSelAssistant = item.dataset.id;
    renderAstItems();
    renderAstEditor();
  }));
  $('#ast-add').onclick = async () => {
    const res = await liteapi.invoke('assistants:upsert', {
      id: 'ast-' + uid().slice(0, 8),
      name: '新助手', icon: '🧩', prompt: '',
    });
    state.config = res;
    settingsSelAssistant = state.config.assistants[state.config.assistants.length - 1].id;
    renderAssistantsPane();
  };
}

function renderAstEditor() {
  const ed = $('#ast-editor');
  const a = (state.config.assistants || []).find((x) => x.id === settingsSelAssistant);
  if (!a) { ed.innerHTML = '<div class="side-empty">左侧选择或添加助手</div>'; return; }
  ed.innerHTML = `
    <div class="field-row">
      <div class="field" style="flex:0 0 90px"><label>图标</label><input type="text" id="af-icon" value="${escapeHtml(a.icon || '')}" maxlength="4" style="text-align:center;font-size:16px"></div>
      <div class="field"><label>名称</label><input type="text" id="af-name" value="${escapeHtml(a.name)}"></div>
    </div>
    <div class="field" style="flex:1;display:flex;flex-direction:column">
      <label>角色提示词(System Prompt)</label>
      <textarea id="af-prompt" class="mono" style="flex:1;min-height:220px" placeholder="例如:你是一位资深前端工程师,回答时先给结论再给代码……&#10;留空则为通用助手。切换助手后,对之后的回复生效。">${escapeHtml(a.prompt || '')}</textarea>
      <div class="hint">提示词会作为系统设定发给模型;在智能体模式下,它会叠加在工具能力说明之前。</div>
    </div>
    <div style="display:flex;gap:8px;padding-top:4px">
      <button class="btn primary" id="af-use" ${state.config.ui.activeAssistantId === a.id ? 'disabled' : ''}>${state.config.ui.activeAssistantId === a.id ? '✓ 当前使用中' : '设为当前使用'}</button>
      <button class="btn danger" id="af-del" ${a.id === 'default' ? 'disabled title="默认助手不可删除"' : ''}>删除</button>
    </div>`;

  const collect = () => ({
    id: a.id,
    icon: $('#af-icon').value || '🤖',
    name: $('#af-name').value,
    prompt: $('#af-prompt').value,
  });
  let t = null;
  const save = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      state.config = await liteapi.invoke('assistants:upsert', collect());
      fillAssistantSelect();
      renderAstItems();
      updateStatusHint();
    }, 350);
  };
  $('#af-icon').addEventListener('input', save);
  $('#af-name').addEventListener('input', save);
  $('#af-prompt').addEventListener('input', save);

  $('#af-use').addEventListener('click', async () => {
    state.config = await liteapi.invoke('assistants:upsert', collect());
    state.config = await liteapi.invoke('config:set', { ui: { activeAssistantId: a.id } });
    fillAssistantSelect();
    renderAstItems();
    renderAstEditor();
    updateStatusHint();
    toast(`已切换助手:${a.name}`);
  });
  $('#af-del').addEventListener('click', async () => {
    if (a.id === 'default') return;
    if (!confirm(`确定删除助手「${a.name}」?`)) return;
    state.config = await liteapi.invoke('assistants:delete', a.id);
    if (state.config.ui.activeAssistantId === a.id) {
      state.config = await liteapi.invoke('config:set', { ui: { activeAssistantId: 'default' } });
      fillAssistantSelect();
    }
    settingsSelAssistant = 'default';
    renderAssistantsPane();
  });
}

/* ---- 技能 tab ---- */
let settingsSelSkill = null;

function renderSkillsPane(root) {
  const R = root || $('#modal-body');
  const list = state.config.skills || [];
  if (!settingsSelSkill || !list.some((s) => s.id === settingsSelSkill)) settingsSelSkill = list[0] ? list[0].id : null;
  R.innerHTML = `
    <div class="prov-layout">
      <div class="prov-list">
        <div id="skill-items"></div>
        <div class="prov-add">
          <button class="btn" id="skill-add" style="width:100%">＋ 添加技能</button>
          <button class="btn" id="skill-restore" style="width:100%;margin-top:6px">恢复默认技能</button>
        </div>
      </div>
      <div class="prov-editor" id="skill-editor"></div>
    </div>`;
  renderSkillItems();
  renderSkillEditor();
}

function renderSkillItems() {
  const wrap = $('#skill-items');
  wrap.innerHTML = (state.config.skills || []).map((s) => `
    <div class="prov-item ${s.id === settingsSelSkill ? 'active' : ''}" data-id="${s.id}">
      <div class="prov-name">${escapeHtml(s.icon || '⚡')} ${escapeHtml(s.name)} ${state.config.ui.activeSkillId === s.id ? '<span style="color:var(--accent);font-size:10.5px">· 已激活</span>' : ''}</div>
      <div class="prov-meta">${s.agent ? '需要工具' : '纯对话'} · ${s.prompt ? escapeHtml(s.prompt.slice(0, 18)) + '…' : '无附加指令'}</div>
    </div>`).join('');
  $$('.prov-item', wrap).forEach((item) => item.addEventListener('click', () => {
    settingsSelSkill = item.dataset.id;
    renderSkillItems();
    renderSkillEditor();
  }));
  $('#skill-add').onclick = async () => {
    const res = await liteapi.invoke('skills:upsert', {
      id: 'skill-' + uid().slice(0, 8),
      name: '新技能', icon: '⚡', prompt: '', insert: '', agent: false,
    });
    state.config = res;
    settingsSelSkill = state.config.skills[state.config.skills.length - 1].id;
    renderSkillsPane();
    renderSkillBar();
  };
  $('#skill-restore').onclick = async () => {
    state.config = await liteapi.invoke('skills:restoreDefaults');
    settingsSelSkill = state.config.skills[0] ? state.config.skills[0].id : null;
    renderSkillsPane();
    renderSkillBar();
    toast('已恢复默认技能(保留自定义技能)');
  };
}

function renderSkillEditor() {
  const ed = $('#skill-editor');
  const s = (state.config.skills || []).find((x) => x.id === settingsSelSkill);
  if (!s) { ed.innerHTML = '<div class="side-empty">左侧选择或添加技能</div>'; return; }
  ed.innerHTML = `
    <div class="field-row">
      <div class="field" style="flex:0 0 90px"><label>图标</label><input type="text" id="sf-icon" value="${escapeHtml(s.icon || '')}" maxlength="4" style="text-align:center;font-size:16px"></div>
      <div class="field"><label>名称(显示在输入框上方)</label><input type="text" id="sf-name" value="${escapeHtml(s.name)}"></div>
    </div>
    <div class="field">
      <label>附加指令(激活技能后追加到系统提示词)</label>
      <textarea id="sf-prompt" class="mono" style="min-height:110px" placeholder="例如:本次对话专注翻译:中文译英文,英文译中文,只输出译文。">${escapeHtml(s.prompt || '')}</textarea>
    </div>
    <div class="field">
      <label>插入模板(点击技能时预填到输入框,可留空)</label>
      <textarea id="sf-insert" class="mono" style="min-height:70px" placeholder="例如:请翻译以下内容:&#10;">${escapeHtml(s.insert || '')}</textarea>
    </div>
    <div class="setting-row">
      <div>
        <div class="label">建议配合智能体模式</div>
        <div class="desc">技能需要调用工具(如抓网页、读写文件)时勾选;激活时会提醒用户</div>
      </div>
      <input type="checkbox" id="sf-agent" ${s.agent ? 'checked' : ''}>
    </div>
    <div style="margin-top:auto;padding-top:8px">
      <button class="btn danger" id="sf-del">删除此技能</button>
    </div>`;

  const collect = () => ({
    id: s.id,
    icon: $('#sf-icon').value || '⚡',
    name: $('#sf-name').value,
    prompt: $('#sf-prompt').value,
    insert: $('#sf-insert').value,
    agent: $('#sf-agent').checked,
  });
  let t = null;
  const save = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      state.config = await liteapi.invoke('skills:upsert', collect());
      renderSkillItems();
      renderSkillBar();
      updateStatusHint();
    }, 350);
  };
  $('#sf-icon').addEventListener('input', save);
  $('#sf-name').addEventListener('input', save);
  $('#sf-prompt').addEventListener('input', save);
  $('#sf-insert').addEventListener('input', save);
  $('#sf-agent').addEventListener('change', save);

  $('#sf-del').addEventListener('click', async () => {
    if (!confirm(`确定删除技能「${s.name}」?`)) return;
    state.config = await liteapi.invoke('skills:delete', s.id);
    if (state.config.ui.activeSkillId === s.id) {
      state.config = await liteapi.invoke('config:set', { ui: { activeSkillId: null } });
      renderSkillBar();
    }
    settingsSelSkill = state.config.skills[0] ? state.config.skills[0].id : null;
    renderSkillsPane();
    renderSkillBar();
  });
}

/* ---- 插件(MCP / DSH)tab ---- */
let settingsSelMcp = null;

function saveMcpServers() {
  liteapi.invoke('config:set', { mcpServers: state.config.mcpServers });
}

const objToLines = (o, sep) => Object.entries(o || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const linesToObj = (t, sep) => {
  const o = {};
  String(t || '').split(/\r?\n/).forEach((l) => {
    const i = l.indexOf(sep);
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + sep.length).trim();
  });
  return o;
};

// 常用 MCP 模板(一键添加;npx 首次运行会联网下载包,之后走缓存)—— 2026-10-25 内置
const MCP_TEMPLATES = [
  { name: '文件系统', desc: '读写指定目录(MCP 官方 filesystem)', command: 'npx -y @modelcontextprotocol/server-filesystem', args: ['(填:允许访问的目录绝对路径)'] },
  { name: '网页抓取 Fetch', desc: '抓取网页转 Markdown(MCP 官方 fetch)', command: 'npx -y @modelcontextprotocol/server-fetch', args: [] },
  { name: '记忆图谱 Memory', desc: '跨会话知识图谱记忆(MCP 官方 memory)', command: 'npx -y @modelcontextprotocol/server-memory', args: [] },
  { name: 'Sequential Thinking', desc: '结构化分步思考(MCP 官方)', command: 'npx -y @modelcontextprotocol/server-sequential-thinking', args: [] },
  { name: 'Windows 桌面控制', desc: 'desktop-commander:系统命令/进程/终端会话', command: 'npx -y @wonderwhy-cc/desktop-commander@latest', args: [] },
  { name: 'Chrome DevTools', desc: 'Google 官方:控制 Chrome 调试/性能分析/DOM/网络/截图(需本机装有 Chrome)', command: 'npx -y chrome-devtools-mcp@latest', args: [] },
  { name: 'Git', desc: '仓库操作(log/diff/status)', command: 'npx -y @modelcontextprotocol/server-git', args: ['(填:git 仓库绝对路径)'] },
];

function renderPluginsPane(root) {
  const R = root || $('#modal-body');
  const list = state.config.mcpServers || [];
  if (!settingsSelMcp || !list.some((s) => s.id === settingsSelMcp)) settingsSelMcp = list[0] ? list[0].id : null;
  R.innerHTML = `
    <div class="prov-layout" style="height:auto;min-height:300px">
      <div class="prov-list">
        <div id="mcp-items"></div>
        <div class="prov-add" style="display:flex;gap:6px">
          <button class="btn" id="mcp-add" style="flex:1">＋ 添加 MCP 服务</button>
          <button class="btn" id="mcp-tpl" title="从常用 MCP 模板一键添加(npx 首次运行需联网下载)">📦 模板</button>
        </div>
        <div id="mcp-tpl-list" class="hidden" style="margin-top:6px"></div>
      </div>
      <div class="prov-editor" id="mcp-editor"></div>
    </div>
    <div style="border-top:1px dashed var(--border);margin-top:16px;padding-top:14px">
      <div class="label" style="font-weight:700;margin-bottom:4px">DeepSeek Harness(DSH)插件兼容</div>
      <div class="desc" style="font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:8px">
        输入 DSH 插件的 npm 包名或 GitHub 仓库(user/repo),自动安装并提取其中可挂载的部分:MCP 工具配置 → 加入上方列表;技能 Markdown → 导入为技能。
        纯 Cordis 代码插件需要完整 DSH 运行时,会安装但标注不可加载。
      </div>
      <div style="display:flex;gap:8px;max-width:640px">
        <input type="text" id="dsh-source" class="mcp-inp" style="flex:1;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none" placeholder="例如:@deepseek-ai/dsh-skill 或 user/dsh-plugin-xxx">
        <button class="btn primary" id="dsh-import">安装并导入</button>
      </div>
      <pre id="dsh-result" style="display:none;margin-top:10px;background:var(--code-bg);border:1px solid var(--code-border);border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;max-height:180px;overflow-y:auto"></pre>
      <div id="dsh-installed" style="margin-top:10px"></div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button class="btn" id="dsh-dir-import">从本地文件夹导入 DSH 技能(.md)</button>
        <span style="font-size:11.5px;color:var(--text-3)">兼容 dsh-skill-filesystem 的技能 Markdown(frontmatter 含 name/description)</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;background:var(--bg-side);border:1px solid var(--border);border-radius:8px;flex-wrap:wrap">
        <span style="font-size:12.5px" id="mdb-stats">模型能力库:读取中…</span>
        <span style="flex:1"></span>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-2);cursor:pointer" title="开启后每次启动检查,超过 7 天自动静默更新(走网络代理,失败不打扰)">
          <input type="checkbox" id="mdb-auto" ${state.config.dev && state.config.dev.autoModelDb === false ? '' : 'checked'} style="cursor:pointer">
          启动时自动更新
        </label>
        <button class="btn" id="mdb-update">更新能力库</button>
      </div>
      <div id="lite-section" style="margin-top:14px;border-top:1px dashed var(--border);padding-top:6px"></div>
    </div>`;
  renderMcpItems();
  renderMcpEditor();
  renderDshInstalled();
  $('#mcp-add').addEventListener('click', () => {
    const cfg = { id: 'mcp-' + uid().slice(0, 8), name: '新服务', transport: 'stdio', command: '', args: [], env: {}, enabled: true, autoApprove: false };
    state.config.mcpServers.push(cfg);
    settingsSelMcp = cfg.id;
    // 乐观更新:只重绘 MCP 列表与编辑器(全 pane 重绘会连带读 4MB model-db + DSH 目录 + 插件扫描,肉眼可感卡顿)
    renderMcpItems();
    renderMcpEditor();
    saveMcpServers(); // config 原子写盘异步进行,不阻塞 UI
  });
  // 常用 MCP 模板:展开列表,点击创建预填配置(走 mcp-add 同款乐观更新路径)
  const tplList = $('#mcp-tpl-list');
  if (tplList) {
    tplList.innerHTML = MCP_TEMPLATES.map((t, i) => `
      <div class="mcp-tpl-item" data-i="${i}" style="padding:7px 9px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:12px">
        <b>${escapeHtml(t.name)}</b>
        <div style="color:var(--text-3);font-size:11.5px;margin-top:2px">${escapeHtml(t.desc)} · <code style="font-size:11px">${escapeHtml(t.command)}</code></div>
      </div>`).join('');
    $$('.mcp-tpl-item', tplList).forEach((el) => el.addEventListener('click', () => {
      const t = MCP_TEMPLATES[parseInt(el.dataset.i, 10)];
      const cfg = { id: 'mcp-' + uid().slice(0, 8), name: t.name, transport: 'stdio', command: t.command, args: [...t.args], env: {}, enabled: true, autoApprove: false };
      state.config.mcpServers.push(cfg);
      settingsSelMcp = cfg.id;
      tplList.classList.add('hidden');
      renderMcpItems();
      renderMcpEditor();
      saveMcpServers();
    }));
  }
  $('#mcp-tpl').addEventListener('click', () => { $('#mcp-tpl-list').classList.toggle('hidden'); });
  $('#dsh-import').addEventListener('click', runDshImport);
  $('#dsh-dir-import').addEventListener('click', runDshDirImport);
  $('#mdb-auto').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const dev = { ...(state.config.dev || {}), autoModelDb: on };
    state.config = await liteapi.invoke('config:set', { dev });
    toast(on ? '已开启:启动时自动更新模型能力库(每 7 天)' : '已关闭:仅手动更新模型能力库');
  });
  $('#mdb-update').addEventListener('click', async () => {
    const btn = $('#mdb-update');
    btn.disabled = true;
    btn.textContent = '更新中…';
    try {
      const r = await liteapi.invoke('modeldb:update');
      toast(`模型能力库已更新:${r.count} 个模型`);
      state.reasonCapsCache.clear();
      renderMdbStats();
      fillReasonSelect();
    } catch (err) {
      toast('更新失败: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = '更新能力库';
  });
  renderMdbStats();
  renderLiteSection();
}

async function renderMdbStats() {
  const el = $('#mdb-stats');
  if (!el) return;
  try {
    const st = await liteapi.invoke('modeldb:stats');
    const d = st.updatedAt ? new Date(st.updatedAt).toLocaleDateString('zh-CN') : '—';
    el.innerHTML = `模型能力库:${st.count || 0} 个模型 · 数据源 ${st.source === 'https://models.dev' ? 'models.dev' : (st.source || '内置')} · 更新于 ${d}`;
  } catch (_) {
    el.textContent = '模型能力库:—';
  }
}

function renderMcpItems() {
  const wrap = $('#mcp-items');
  const list = state.config.mcpServers || [];
  wrap.innerHTML = list.map((s) => `
    <div class="prov-item ${s.id === settingsSelMcp ? 'active' : ''}" data-id="${s.id}">
      <div class="prov-name">${s.enabled === false ? '⚪' : '🟢'} ${escapeHtml(s.name)} ${s.autoApprove ? '<span style="color:var(--warn);font-size:10.5px">· 自动批准</span>' : ''}</div>
      <div class="prov-meta">${s.transport === 'http' ? 'HTTP' : 'stdio'} · ${escapeHtml(s.transport === 'http' ? (s.url || '') : (s.command || ''))}</div>
    </div>`).join('') || '<div class="side-empty">暂无 MCP 服务</div>';
  $$('.prov-item', wrap).forEach((item) => item.addEventListener('click', () => {
    settingsSelMcp = item.dataset.id;
    renderMcpItems();
    renderMcpEditor();
  }));
}

function renderMcpEditor() {
  const ed = $('#mcp-editor');
  const s = (state.config.mcpServers || []).find((x) => x.id === settingsSelMcp);
  if (!s) { ed.innerHTML = '<div class="side-empty">左侧选择或添加 MCP 服务</div>'; return; }

  ed.innerHTML = `
    <div class="field-row">
      <div class="field"><label>名称(工具将命名为 mcp__名称__工具)</label><input type="text" id="mc-name" value="${escapeHtml(s.name)}"></div>
      <div class="field" style="flex:0 0 130px"><label>传输方式</label>
        <select id="mc-transport">
          <option value="stdio" ${s.transport !== 'http' ? 'selected' : ''}>stdio(本地进程)</option>
          <option value="http" ${s.transport === 'http' ? 'selected' : ''}>HTTP(Streamable)</option>
        </select>
      </div>
    </div>
    <div id="mc-stdio-fields" style="display:${s.transport === 'http' ? 'none' : 'block'}">
      <div class="field"><label>启动命令</label><input type="text" id="mc-command" value="${escapeHtml(s.command || '')}" placeholder="npx -y @some/mcp-server 或 C:\\path\\server.exe"></div>
      <div class="field"><label>参数(每行一个;也可整条写在启动命令里,自动拆分)</label><textarea id="mc-args" class="mono" style="min-height:54px">${escapeHtml((s.args || []).join('\n'))}</textarea></div>
      <div class="field"><label>环境变量(每行 KEY=VALUE)</label><textarea id="mc-env" class="mono" style="min-height:54px">${escapeHtml(objToLines(s.env, '='))}</textarea></div>
    </div>
    <div id="mc-http-fields" style="display:${s.transport === 'http' ? 'block' : 'none'}">
      <div class="field"><label>服务 URL</label><input type="text" id="mc-url" value="${escapeHtml(s.url || '')}" placeholder="https://example.com/mcp"></div>
      <div class="field"><label>请求头(每行 Key: Value)</label><textarea id="mc-headers" class="mono" style="min-height:54px">${escapeHtml(objToLines(s.headers, ': '))}</textarea></div>
    </div>
    <div class="setting-row">
      <div><div class="label">启用</div><div class="desc">关闭后不连接、不提供工具</div></div>
      <input type="checkbox" id="mc-enabled" ${s.enabled !== false ? 'checked' : ''}>
    </div>
    <div class="setting-row">
      <div><div class="label">自动批准该服务的工具调用</div><div class="desc">关闭时每次调用都会询问;第三方工具请谨慎开启</div></div>
      <input type="checkbox" id="mc-approve" ${s.autoApprove ? 'checked' : ''}>
    </div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn primary" id="mc-test">测试连接</button>
      <button class="btn danger" id="mc-del">删除</button>
    </div>
    <div class="hint" id="mc-test-result" style="margin-top:8px"></div>`;

  const collect = () => ({
    ...s,
    name: $('#mc-name').value || '未命名',
    transport: $('#mc-transport').value,
    command: $('#mc-command') ? $('#mc-command').value.trim() : '',
    args: $('#mc-args') ? $('#mc-args').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [],
    env: $('#mc-env') ? linesToObj($('#mc-env').value, '=') : {},
    url: $('#mc-url') ? $('#mc-url').value.trim() : '',
    headers: $('#mc-headers') ? linesToObj($('#mc-headers').value, ':') : {},
    enabled: $('#mc-enabled').checked,
    autoApprove: $('#mc-approve').checked,
  });

  let t = null;
  const save = () => {
    clearTimeout(t);
    t = setTimeout(() => { Object.assign(s, collect()); saveMcpServers(); renderMcpItems(); }, 350);
  };
  ['mc-name', 'mc-transport', 'mc-command', 'mc-args', 'mc-env', 'mc-url', 'mc-headers', 'mc-enabled', 'mc-approve'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      if (id === 'mc-transport') {
        // 先把新传输方式写回配置对象再重绘 —— 不采集就重绘会按旧值恢复下拉,表现为「HTTP 选不上」
        Object.assign(s, collect());
        renderMcpEditor();
        saveMcpServers();
        renderMcpItems();
        return;
      }
      save();
    });
  });

  $('#mc-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    Object.assign(s, collect());
    saveMcpServers();
    btn.disabled = true;
    btn.textContent = '连接中…';
    $('#mc-test-result').textContent = '';
    try {
      const r = await liteapi.invoke('mcp:test', JSON.parse(JSON.stringify(s)));
      $('#mc-test-result').textContent = `✓ 连接成功,发现 ${r.toolCount} 个工具:${(r.tools || []).slice(0, 8).join(', ')}${r.toolCount > 8 ? ' …' : ''}`;
      toast(`MCP「${s.name}」连接成功(${r.toolCount} 个工具)`);
    } catch (err) {
      $('#mc-test-result').textContent = `✕ ${err.message}`;
    }
    btn.disabled = false;
    btn.textContent = '测试连接';
  });

  $('#mc-del').addEventListener('click', () => {
    if (!confirm(`删除 MCP 服务「${s.name}」?`)) return;
    state.config.mcpServers = state.config.mcpServers.filter((x) => x.id !== s.id);
    settingsSelMcp = state.config.mcpServers[0] ? state.config.mcpServers[0].id : null;
    renderMcpItems();   // 局部重绘即时反馈,落盘异步(同 mcp-add)
    renderMcpEditor();
    saveMcpServers();
  });
}

async function runDshImport() {
  const source = $('#dsh-source').value.trim();
  if (!source) { toast('请输入 npm 包名或 GitHub 仓库'); return; }
  const btn = $('#dsh-import');
  btn.disabled = true;
  btn.textContent = '安装中…(可能需要几分钟)';
  const res = $('#dsh-result');
  res.style.display = 'block';
  res.textContent = '正在从 npm 安装,请稍候…';
  try {
    const r = await liteapi.invoke('dsh:import', source);
    if (!r.ok) {
      res.textContent = r.message;
    } else {
      res.textContent = [
        `✓ 已安装${r.targets && r.targets.length ? ':' + r.targets.join(', ') : ''}`,
        `MCP 服务:导入 ${r.mcp} 个`,
        `技能:导入 ${r.skills} 个`,
        r.notes && r.notes.length ? '\n说明:\n' + r.notes.map((n) => '- ' + n).join('\n') : '',
      ].filter(Boolean).join('\n');
      toast(`导入完成:MCP ${r.mcp} 个,技能 ${r.skills} 个`);
      renderMcpItems();
      renderSkillBar();
    }
    renderDshInstalled();
  } catch (err) {
    res.textContent = '失败: ' + (err.message || err);
  }
  btn.disabled = false;
  btn.textContent = '安装并导入';
}

// 插件兼容管理框(开发者选项,总开关开启后出现)
function renderDshCompatBox() {
  const box = $('#dsh-compat-box');
  if (!box) return;
  box.innerHTML = `
    <div class="field">
      <label>插件兼容 · DSH 代码插件</label>
      <div class="hint" style="margin-bottom:8px">对已安装的 DSH 插件包逐个「载入」:工具型插件注册的工具会注入智能体(完全/创造/团队模式);客户端 UI 扩展型(桌面宠物/小组件等)依赖 DSH 客户端环境,载入时会明确提示缺少哪些服务。导入新包在 设置 → 扩展。</div>
      <div id="dsh-compat-list"></div>
    </div>`;
  renderDshCompatList();
}

// 兼容管理清单(带 载入 开关与运行状态)
async function renderDshCompatList() {
  const wrap = $('#dsh-compat-list');
  if (!wrap) return;
  wrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-3)">读取已安装插件…</div>';
  try {
    const list = await liteapi.invoke('dsh:list');
    if (!list.length) { wrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-3)">尚未安装任何 DSH 插件(在 设置 → 扩展 导入 npm 包或 GitHub 仓库)</div>'; return; }
    let st = null;
    try { st = await liteapi.invoke('dsh:hostStatus'); } catch (_) { /* ignore */ }
    const capOf = {};
    if (st && st.ready) for (const c of st.caps) capOf[c.plugin] = c;
    wrap.innerHTML = list.map((p) => {
      const code = !!p.hasMain;
      const cap = capOf[p.name];
      const statusText = code
        ? (cap ? (cap.kind === 'tools' ? `🟢 运行中 · ${cap.tools.length} 个工具` : cap.kind === 'error' ? `🔴 载入失败:${escapeHtml(cap.error || '')}` : '🟡 已载入(无可桥接工具)') : '⚪ 未载入')
        : '— 非代码插件(技能/MCP 配置)';
      const enabledNow = !!(st && (st.plugins || []).find((x) => x.name === p.name && x.enabled));
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;flex-wrap:wrap">
        <span>${p.isDsh ? '🧩' : '📦'}</span>
        <span style="font-family:Consolas,monospace">${escapeHtml(p.name)}</span>
        <span style="color:var(--text-3)">@${escapeHtml(p.version)}</span>
        <span style="flex:1"></span>
        ${statusText ? `<span style="font-size:11px;color:var(--text-2)">${statusText}</span>` : ''}
        ${code ? `<label style="font-size:11.5px;color:var(--text-2);display:flex;align-items:center;gap:4px">载入 <input type="checkbox" data-dsh-on="${escapeHtml(p.name)}" ${enabledNow ? 'checked' : ''}></label>` : ''}
        <button class="btn" style="padding:2px 10px;font-size:11.5px" data-un="${escapeHtml(p.name)}">卸载</button>
      </div>`;
    }).join('');
    $$('button[data-un]', wrap).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`卸载插件 ${b.dataset.un}?`)) return;
      await liteapi.invoke('dsh:remove', b.dataset.un);
      renderDshCompatList();
    }));
    $$('input[data-dsh-on]', wrap).forEach((cb) => cb.addEventListener('change', async () => {
      const on = cb.checked;
      if (on && !confirm(`载入代码插件「${cb.dataset.dshOn}」?\n\n它的代码将在独立子进程中运行并可以把工具注册给智能体。第三方插件代码不受 LiteAgent 沙箱审计,请只载入你信任的来源。`)) { cb.checked = false; return; }
      try {
        await liteapi.invoke('dsh:setPluginEnabled', { name: cb.dataset.dshOn, enabled: on });
        toast(on ? `已载入「${cb.dataset.dshOn}」(空闲 5 分钟自动休眠)` : '已停用');
      } catch (e) {
        toast('操作失败: ' + e.message);
      }
      renderDshCompatList();
    }));
  } catch (e) {
    wrap.innerHTML = `<div style="font-size:11.5px;color:var(--text-3)">读取失败: ${escapeHtml(e.message)}</div>`;
  }
}

// 扩展页 DSH 已装列表(简洁:无载入管理,管理集中在开发者选项的插件兼容框)
async function renderDshInstalled() {
  const wrap = $('#dsh-installed');
  if (!wrap) return;
  wrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-3)">读取已安装插件…</div>';
  try {
    const list = await liteapi.invoke('dsh:list');
    if (!list.length) { wrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-3)">尚未安装任何 DSH 插件</div>'; return; }
    wrap.innerHTML = list.map((p) => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px">
        <span>${p.isDsh ? '🧩' : '📦'}</span>
        <span style="font-family:Consolas,monospace">${escapeHtml(p.name)}</span>
        <span style="color:var(--text-3)">@${escapeHtml(p.version)}</span>
        ${p.isDsh ? '<span style="color:var(--accent);font-size:10.5px">dsh-plugin</span>' : ''}
        <span style="flex:1"></span>
        <button class="btn" style="padding:2px 10px;font-size:11.5px" data-un="${escapeHtml(p.name)}">卸载</button>
      </div>`).join('');
    $$('button[data-un]', wrap).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`卸载插件 ${b.dataset.un}?`)) return;
      await liteapi.invoke('dsh:remove', b.dataset.un);
      renderDshInstalled();
    }));
  } catch (e) {
    wrap.innerHTML = `<div style="font-size:11.5px;color:var(--text-3)">读取失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function runDshDirImport() {
  const dir = await liteapi.invoke('dialog:pickDir', '选择包含 DSH 技能 Markdown 的文件夹');
  if (!dir) return;
  try {
    const r = await liteapi.invoke('dsh:importSkillsDir', dir);
    toast(`从文件夹导入 ${r.skills} 个技能`);
    renderSkillBar();
    if (r.notes && r.notes.length) toast(r.notes[0]);
  } catch (e) {
    toast('导入失败: ' + e.message);
  }
}

/* ---- 安全审计 tab ---- */
function renderSecurityCorePane(root) {
  const R = root || $('#modal-body');
  const s = state.config.security || {};
  R.innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>中转站风险须知</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          中转站(one-api / new-api 等代理)能看到你与模型的<b>全部明文对话</b>。建议:只用可信渠道、开启 HTTPS 强制与白名单、对敏感信息选择脱敏;本应用的审计日志会把每个出站请求的目标与规模记录在本地,供你事后核对。
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">审计日志</div><div class="desc">在本地记录每个模型请求与工具调用的目标、模型、规模(默认不含对话正文)</div></div>
        <input type="checkbox" id="se-audit" ${s.auditLog !== false ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">记录完整请求内容</div><div class="desc">把发往服务商的完整消息也写进审计日志(敏感!仅排查时开启)</div></div>
        <input type="checkbox" id="se-full" ${s.logFullContent ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">审计日志</div><div class="desc" id="se-stats">读取中…</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn" id="se-open">打开文件夹</button>
          <button class="btn danger" id="se-clear">清空</button>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">仅允许 HTTPS</div><div class="desc">拦截明文 http 的 API 地址(localhost 等本地地址不受限)</div></div>
        <input type="checkbox" id="se-https" ${s.httpsOnly !== false ? 'checked' : ''}>
      </div>
      <div class="field">
        <label>域名白名单(逗号或空格分隔,留空不限制)</label>
        <input type="text" id="se-hosts" value="${escapeHtml(s.allowedHosts || '')}" placeholder="例如:api.deepseek.com, open.bigmodel.cn">
        <div class="hint">命中列表(含子域名)才放行;localhost 始终放行。适合锁死可信中转站。</div>
      </div>
      <div class="setting-row">
        <div><div class="label">敏感信息扫描</div><div class="desc">出站前扫描:API密钥 / 令牌 / 私钥 / 身份证 / 手机号 / 邮箱 / 内网地址</div></div>
        <input type="checkbox" id="se-scan" ${s.sensitiveScan ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">发现敏感信息后</div><div class="desc" id="se-action-desc"></div></div>
        <select id="se-action">
          <option value="warn" ${(s.sensitiveAction || 'warn') === 'warn' ? 'selected' : ''}>提醒后继续发送</option>
          <option value="block" ${s.sensitiveAction === 'block' ? 'selected' : ''}>阻止发送</option>
          <option value="redact" ${s.sensitiveAction === 'redact' ? 'selected' : ''}>自动脱敏后发送</option>
        </select>
      </div>
    </div>`;

  const save = (patch) => liteapi.invoke('config:set', { security: patch }).then((c) => { state.config = c; });
  $('#se-audit').addEventListener('change', (e) => save({ auditLog: e.target.checked }));
  $('#se-full').addEventListener('change', (e) => save({ logFullContent: e.target.checked }));
  $('#se-https').addEventListener('change', (e) => save({ httpsOnly: e.target.checked }));
  $('#se-hosts').addEventListener('change', (e) => save({ allowedHosts: e.target.value }));
  $('#se-scan').addEventListener('change', (e) => save({ sensitiveScan: e.target.checked }));
  $('#se-action').addEventListener('change', (e) => save({ sensitiveAction: e.target.value }));

  const refreshStats = () => liteapi.invoke('audit:stats').then((st) => {
    const kb = (st.bytes / 1024).toFixed(1);
    $('#se-stats').textContent = `${st.files} 个月度文件 · 共 ${kb} KB · 本月 ${st.entries} 条`;
  });
  refreshStats();
  $('#se-open').addEventListener('click', () => liteapi.invoke('audit:open'));
  $('#se-clear').addEventListener('click', async () => {
    if (!confirm('清空全部审计日志?')) return;
    const n = await liteapi.invoke('audit:clear');
    toast(`已清空 ${n} 个审计文件`);
    refreshStats();
  });
}

/* ---- 网络代理 tab ---- */
const PX_MODE_LABEL = {
  system: '使用系统代理',
  manual: '手动配置代理',
  direct: '不使用任何代理',
};

function renderProxyPane(root) {
  const R = root || $('#modal-body');
  const p = state.config.proxy || {};
  const mode = PX_MODE_LABEL[p.mode] ? p.mode : 'system';
  const rules = (Array.isArray(p.rules) ? p.rules : []).map((r) => ({
    scheme: ['http', 'https', 'socks5'].includes(r && r.scheme) ? r.scheme : 'http',
    host: String((r && r.host) || ''),
    port: String((r && r.port) || ''),
  }));
  R.innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>代理模式</label>
        <div id="px-modes">
          ${Object.keys(PX_MODE_LABEL).map((m) => `
          <label class="px-mode ${m === mode ? 'active' : ''}">
            <input type="radio" name="px-mode" value="${m}" ${m === mode ? 'checked' : ''}>
            <span class="px-mode-body"><b>${PX_MODE_LABEL[m]}</b>
            <span class="desc">${
              m === 'system' ? '跟随操作系统的代理配置 —— Clash / v2rayN 等代理软件开启「系统代理」后自动生效(默认)'
              : m === 'manual' ? '自行添加代理条目,支持 HTTP / HTTPS / SOCKS5 各种协议,按顺序生效'
              : '强制直连,忽略系统代理与代理软件,适合本地网络即可直连服务'
            }</span></span>
          </label>`).join('')}
        </div>
      </div>
      <div id="px-manual" class="${mode === 'manual' ? '' : 'hidden'}">
        <div class="field">
          <label>代理条目(协议 · 地址 · 端口)</label>
          <div id="px-rules"></div>
          <button class="btn" id="px-add">+ 添加条目</button>
          <div class="hint">多协议条目按顺序拼装;同类协议取第一条。常见用法:HTTP 127.0.0.1 7890(Clash 默认混合端口)。</div>
        </div>
        <div class="field">
          <label>例外规则(不走代理的主机,用 ; 或逗号分隔)</label>
          <input type="text" id="px-bypass" value="${escapeHtml(p.bypass || '')}" placeholder="例如:internal.company.com;*.corp.local;10.*">
          <div class="hint">localhost / 127.0.0.1 / ::1 与局域网主机名始终直连,保证 Ollama / LM Studio 等本地服务不受代理影响。</div>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">当前生效</div><div class="desc" id="px-resolved">点「检测」查看 API 请求当前的实际出口</div></div>
        <button class="btn" id="px-detect">检测</button>
      </div>
      <div class="field">
        <label>生效范围</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          修改立即保存并对<b>新请求</b>生效:模型对话、网页抓取、MCP HTTP、模型能力库更新、DSH 插件安装(npm)。<br>
          手动模式一条条目都没填时按直连处理;连接代理失败会直接报错,不会静默回落直连。
        </div>
      </div>
    </div>`;

  let draft = rules;

  const save = (patch) => liteapi.invoke('config:set', { proxy: patch }).then((c) => {
    state.config = c;
  });

  const saveRules = () => {
    const valid = draft.filter((r) => r.host.trim() && parseInt(r.port, 10) > 0);
    return save({ rules: valid, bypass: $('#px-bypass') ? $('#px-bypass').value : (p.bypass || '') });
  };

  const renderRules = () => {
    const box = $('#px-rules');
    box.innerHTML = draft.map((r, i) => `
      <div class="px-rule-row" data-i="${i}">
        <select class="px-scheme">${['http', 'https', 'socks5'].map((s) => `<option value="${s}" ${r.scheme === s ? 'selected' : ''}>${s === 'socks5' ? 'SOCKS5' : s.toUpperCase()}</option>`).join('')}</select>
        <input type="text" class="px-host" placeholder="代理地址,如 127.0.0.1" value="${escapeHtml(r.host)}">
        <input type="number" class="px-port" placeholder="端口" min="1" max="65535" value="${escapeHtml(r.port)}">
        <button class="px-del" title="删除条目">✕</button>
      </div>`).join('') || '<div class="hint" style="padding:4px 0">暂无条目,点击下方按钮添加。</div>';
    $$('.px-rule-row', box).forEach((row) => {
      const i = parseInt(row.dataset.i, 10);
      $('.px-scheme', row).addEventListener('change', (e) => { draft[i].scheme = e.target.value; saveRules(); });
      $('.px-host', row).addEventListener('change', (e) => { draft[i].host = e.target.value; saveRules(); });
      $('.px-port', row).addEventListener('change', (e) => { draft[i].port = e.target.value; saveRules(); });
      $('.px-del', row).addEventListener('click', () => { draft.splice(i, 1); renderRules(); saveRules(); });
    });
  };

  $$('#px-modes input[name="px-mode"]').forEach((input) => {
    input.addEventListener('change', () => save({ mode: input.value }).then(() => rerenderSettings()));
  });
  $('#px-add').addEventListener('click', () => {
    if (draft.length >= 8) { toast('最多 8 个条目'); return; }
    draft.push({ scheme: 'http', host: '', port: '' });
    renderRules();
  });
  const bypassEl = $('#px-bypass');
  if (bypassEl) bypassEl.addEventListener('change', saveRules);
  renderRules();

  const refreshResolved = () => liteapi.invoke('proxy:resolve', 'https://api.deepseek.com').then((v) => {
    const el = $('#px-resolved');
    if (!el) return;
    const s = String(v || '').trim();
    el.textContent = !s ? '未知'
      : s === 'DIRECT' ? '直连(未经过代理)'
      : s.startsWith('PROXY ') ? `经由代理 ${s.slice(6)}`
      : s.startsWith('SOCKS') ? `经由 ${s.split(' ')[0]} 代理 ${s.split(' ')[1] || ''}`
      : s;
  });
  $('#px-detect').addEventListener('click', refreshResolved);
  refreshResolved();
}

/* ---- 沙箱与搜索 tab ---- */
const SEARCH_BACKENDS = {  duckduckgo: 'DuckDuckGo(免 Key,开箱即用)',
  tavily: 'Tavily(需 API Key,面向智能体优化)',
  brave: 'Brave Search(需 API Key)',
  searxng: 'SearXNG(自建/公共实例)',
  bocha: '博查 Bocha(中文搜索,需 Key)',
  zhipu: '智谱搜索(中文,需 Key)',
  serper: 'Serper.dev(Google 系,需 Key)',
  serpapi: 'SerpAPI(Google 系,需 Key)',
  google: 'Google 可编程搜索(需 Key + cx)',
  jina: 'Jina AI(免 Key,限流)',
  exa: 'Exa(面向智能体,需 Key)',
};

function renderPrivacyCorePane(root) {
  const R = root || $('#modal-body');
  const sec = state.config.security || {};
  const on = sec.imagePrivacy !== false; // 默认开
  R.innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>图片隐私保护</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          开启后,无论沙箱模式如何,AI 都<b>只能访问当前工作目录内的图片</b>:<br>
          ① 打开/查看工作目录之外的图片文件(自动打开图片查看器)→ 强制拦截;<br>
          ② 读取工作目录之外的图片内容(读文件、run_code 的 Node 进程内读取)→ 强制拦截;<br>
          ③ <b>你手动发到聊天窗口的图片不受影响</b>(附件通道不经过文件路径);<br>
          ④ 拦截行为记入安全审计日志(类别「privacy」)。
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">仅允许访问已设定目录内的图片</div><div class="desc">工作目录之外的图片一律强制禁止访问,除非是你手动发送的;关闭后回退到沙箱模式的普通文件规则</div></div>
        <input type="checkbox" id="sec-imgpriv" ${on ? 'checked' : ''}>
      </div>
    </div>`;
  $('#sec-imgpriv').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { security: { ...(state.config.security || {}), imagePrivacy: e.target.checked } });
    toast(e.target.checked ? '图片隐私已开启:AI 仅能访问工作目录内的图片' : '图片隐私已关闭(回退到沙箱模式的普通文件规则)');
  });
}

function renderSandboxCorePane(root) {
  const R = root || $('#modal-body');
  const sb = state.config.sandbox || {};
  R.innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>沙箱机制(智能体安全边界)</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          与同类智能体软件一致的沙箱机制,约束智能体的文件与命令操作:<br>
          ① <b>文件沙箱</b>:文件读写/目录浏览被锁定在当前工作目录内,越界路径(绝对路径、.. 穿越、系统目录)一律拦截;<br>
          ② <b>命令拦截</b>:Shell 命令按规则分级拦截(格式化磁盘、递归强删、提权、持久化、下载执行等);<br>
          ③ 沙箱拦截会记入安全审计日志。MCP/插件工具不经过文件沙箱,请用其自带审批。
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">文件沙箱(锁定在工作目录)</div><div class="desc">read_file / write_file / list_dir 只能触达工作目录及其子目录;系统目录始终禁止</div></div>
        <input type="checkbox" id="sb-fslock" ${sb.fsLock !== false ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">命令拦截级别</div><div class="desc" id="sb-cmd-desc"></div></div>
        <select id="sb-cmd">
          <option value="strict" ${(sb.cmdScreen || 'strict') === 'strict' ? 'selected' : ''}>严格(推荐:追加拦截提权/持久化/递归强删/下载执行)</option>
          <option value="loose" ${sb.cmdScreen === 'loose' ? 'selected' : ''}>宽松(只拦格式化磁盘/关机/删系统目录等毁灭性命令)</option>
          <option value="off" ${sb.cmdScreen === 'off' ? 'selected' : ''}>关闭(不拦截,仍受工作目录与人工批准约束)</option>
        </select>
      </div>
      <div class="field">
        <div class="hint" style="font-size:12px;line-height:1.8">
          <b>强制策略</b>:受限 / 完全模式下(非创造模式)沙箱强制生效 —— 文件沙箱必开、命令拦截至少为宽松,此处设置无法解除;创造模式下按上面对设置执行(自我扩展的 manage 工具不经过文件沙箱,不受影响)。另:命令默认需要人工批准(设置 → Agent),配合沙箱形成双重防线。
        </div>
      </div>
    </div>`;

  const saveSandbox = (patch) => liteapi.invoke('config:set', { sandbox: patch }).then((c) => { state.config = c; });
  $('#sb-fslock').addEventListener('change', (e) => saveSandbox({ fsLock: e.target.checked }));
  $('#sb-cmd').addEventListener('change', (e) => saveSandbox({ cmdScreen: e.target.value }));
  const cmdDesc = { strict: '拦截:毁灭性命令 + 提权/持久化/递归强删/下载执行/凭据操作', loose: '只拦毁灭性命令(格式化磁盘/关机/删系统目录/底层写盘等)', off: '不拦截(受限/完全模式下仍会自动提升为宽松)' };
  $('#sb-cmd-desc').textContent = cmdDesc[$('#sb-cmd').value] || '';
}

function renderSearchPane(root) {
  const R = root || $('#modal-body');
  const sc = state.config.search || {};
  const backend = SEARCH_BACKENDS[sc.backend] ? sc.backend : 'duckduckgo';
  // 每后端可带多个配置字段(Google = Key + cx 两项);免 Key 后端无配置项
  const keyFieldLabels = {
    tavily: [['tavilyKey', 'Tavily API Key', '在 tavily.com 免费申请']],
    brave: [['braveKey', 'Brave Search API Key', '在 brave.com/search/api 申请']],
    searxng: [['searxUrl', 'SearXNG 实例地址', '例如 https://searx.example.org(实例需开启 JSON 输出 format=json)']],
    bocha: [['bochaKey', '博查 API Key', '在 bochaai.com 申请,中文搜索效果好']],
    zhipu: [['zhipuKey', '智谱 API Key', 'open.bigmodel.cn 的 API Key(web-search 计费)']],
    serper: [['serperKey', 'Serper API Key', 'serper.dev 申请,免费 2500 次/月,Google 系结果']],
    serpapi: [['serpapiKey', 'SerpAPI Key', 'serpapi.com 申请,免费 100 次/月,Google 系结果']],
    google: [['googleKey', 'Google API Key', 'console.developers.google.com 创建(启用 Custom Search API)'], ['googleCx', '搜索引擎 ID(cx)', 'programmablesearchengine.google.com 创建引擎获得,勾选「搜索整个网络」']],
    jina: [['jinaKey', 'Jina API Key(可选)', '免 Key 可直接用(限流);填 Key 提升速率,jina.ai 申请']],
    exa: [['exaKey', 'Exa API Key', 'exa.ai 申请,面向智能体的语义搜索']],
  };
  const kf = keyFieldLabels[backend];
  R.innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>联网搜索(模型的 web_search 工具)</label>
        <select id="sc-backend" style="width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none">
          ${Object.keys(SEARCH_BACKENDS).map((k) => `<option value="${k}" ${k === backend ? 'selected' : ''}>${SEARCH_BACKENDS[k]}</option>`).join('')}
        </select>
        <div id="sc-key-field" style="margin-top:8px"></div>
        <div class="hint">智能体在 受限/完全 模式下可用 web_search 联网搜索;搜索请求走 设置 → 安全 → 网络代理 的代理,并受安全审计记录。若启用了域名白名单,请同时放行对应搜索站点。</div>
      </div>
    </div>`;
  const renderKeyField = () => {
    const box = $('#sc-key-field');
    if (!box) return;
    if (!kf) { box.innerHTML = ''; return; }
    box.innerHTML = kf.map(([field, label, ph]) => `
      <div style="margin-bottom:8px">
        <label style="font-size:12px;color:var(--text-2)">${label}</label>
        <input type="text" class="sc-key-input" data-field="${field}" value="${escapeHtml((state.config.search || {})[field] || '')}" placeholder="${ph}" style="width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none">
      </div>`).join('');
    $$('.sc-key-input', box).forEach((inp) => inp.addEventListener('change', (e) => {
      liteapi.invoke('config:set', { search: { [e.target.dataset.field]: e.target.value.trim() } }).then((c) => { state.config = c; });
    }));
  };
  renderKeyField();
  $('#sc-backend').addEventListener('change', (e) => {
    liteapi.invoke('config:set', { search: { backend: e.target.value } }).then((c) => {
      state.config = c;
      rerenderSettings();
      toast(`联网搜索已切换:${SEARCH_BACKENDS[e.target.value]}`);
    });
  });
}

/* ---- 开发者选项 tab ---- */
const TERM_CORNERS = {
  'top-left': '左上角', 'top-right': '右上角',
  'bottom-left': '左下角', 'bottom-right': '右下角',
};

// 开发者选项:记忆清单(AI 沉淀的长期记忆,最新在前)
function renderDevMemoryList() {
  const list = (state.config.memories || []).slice().reverse();
  const rows = list.map((m) => `
    <div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:12px;border-bottom:1px dashed var(--border)">
      <span style="flex:1;word-break:break-all">${escapeHtml(m.text)}</span>
      <button class="btn" style="padding:0 8px;font-size:11px;flex-shrink:0" data-mem-del="${escapeHtml(m.id)}">✕</button>
    </div>`).join('');
  return `
    <div class="setting-row" style="align-items:flex-start">
      <div style="flex:1;min-width:0"><div class="label">已积累记忆(${list.length}/200)</div><div class="desc">AI 保存的长期记忆,开启记忆功能的所有新对话自动继承</div>
        <div style="margin-top:6px;max-height:180px;overflow-y:auto">${rows || '<div style="font-size:12px;color:var(--text-3)">暂无记忆:AI 在对话中认为值得长期记住时会自动保存</div>'}</div>
      </div>
      <button class="btn" id="dv-memory-clear" style="flex-shrink:0">清空</button>
    </div>`;
}

// 开发者选项:学习成果清单(用户提示词 + 学习技能)
function renderDevLearnedList() {
  const lps = (state.config.learnedPrompts || []).slice().reverse();
  const learnedSkills = (state.config.skills || []).filter((s) => s.learned);
  const lpRows = lps.map((l) => `
    <div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:12px;border-bottom:1px dashed var(--border)">
      <span style="flex:1;word-break:break-all"><b>${escapeHtml(l.title)}</b>:${escapeHtml(l.text)}</span>
      <button class="btn" style="padding:0 8px;font-size:11px;flex-shrink:0" data-lp-del="${escapeHtml(l.id)}">✕</button>
    </div>`).join('');
  const skRows = learnedSkills.map((s) => `
    <div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">
      <span>📖</span><span style="font-weight:600">${escapeHtml(s.name)}</span>
      <span style="color:var(--text-3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((s.prompt || '').slice(0, 60))}</span>
      <button class="btn" style="padding:0 8px;font-size:11px;flex-shrink:0" data-ls-del="${escapeHtml(s.id)}">删除</button>
    </div>`).join('');
  return `
    <div class="setting-row" style="align-items:flex-start">
      <div style="flex:1;min-width:0"><div class="label">用户提示词(${lps.length}/100)</div><div class="desc">学习功能沉淀的规矩与偏好,每次对话自动注入生效</div>
        <div style="margin-top:6px;max-height:160px;overflow-y:auto">${lpRows || '<div style="font-size:12px;color:var(--text-3)">暂无:AI 被你纠正并选择沉淀为提示词后会出现在这里</div>'}</div>
      </div>
      <button class="btn" id="dv-lp-clear" style="flex-shrink:0">清空</button>
    </div>
    <div class="setting-row" style="align-items:flex-start">
      <div style="flex:1;min-width:0"><div class="label">用户技能(${learnedSkills.length})</div><div class="desc">学习功能沉淀的技能,出现在输入框上方技能栏(📖),点击启用</div>
        <div style="margin-top:6px">${skRows || '<div style="font-size:12px;color:var(--text-3)">暂无:AI 被你纠正并选择沉淀为技能后会出现在这里</div>'}</div>
      </div>
    </div>`;
}

function renderDevPane() {
  const ui = (state.config && state.config.ui) || {};
  const dev = (state.config && state.config.dev) || {};
  const sliderZoom = Number(ui.sliderZoom) || 1;
  const corner = TERM_CORNERS[dev.terminalCorner] ? dev.terminalCorner : 'bottom-right';
  const winShell = /Windows/.test(navigator.userAgent); // 沙箱渲染进程无 process 全局,用 UA 判平台
  $('#modal-body').innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>内置终端</label>
        <div class="setting-row">
          <div><div class="label">停靠位置</div><div class="desc">终端入口按钮与面板停靠的角落</div></div>
          <select id="dv-corner">
            ${Object.keys(TERM_CORNERS).map((k) => `<option value="${k}" ${k === corner ? 'selected' : ''}>${TERM_CORNERS[k]}</option>`).join('')}
          </select>
        </div>
        ${winShell ? `
        <div class="setting-row">
          <div><div class="label">Shell</div><div class="desc">终端使用的命令解释器(Linux/macOS 恒为系统默认 Shell)</div></div>
          <select id="dv-shell">
            <option value="powershell" ${(dev.terminalShell || 'powershell') === 'powershell' ? 'selected' : ''}>PowerShell</option>
            <option value="cmd" ${dev.terminalShell === 'cmd' ? 'selected' : ''}>cmd.exe</option>
          </select>
        </div>` : ''}
        <div class="hint">入口:主界面 ⌨ 按钮。持久会话(cd 与环境变量在命令间保持);非 PTY 伪终端 —— 不支持交互式全屏程序(vim/htop)与密码输入。Shell 切换后点「重置」生效。</div>
      </div>
      <div class="field">
        <label>User-Agent(出站请求标识,即时生效)</label>
        <div class="hint">应用默认 UA:<code id="dv-ua-current" style="word-break:break-all">${escapeHtml(navigator.userAgent)}</code>${(state.config.dev && state.config.dev.userAgent) ? '<br><b style="color:var(--accent)">当前覆盖:</b><code style="word-break:break-all">' + escapeHtml(state.config.dev.userAgent) + '</code>' : '<br>选择预设或自定义后,全部出站请求(模型 API/联网搜索/网页抓取/MCP HTTP)统一改用该 UA —— 中转站按 UA 识别客户端时可伪装为常见客户端。'}</div>
        <select id="dv-ua-preset" style="width:100%;height:34px">
          <option value="">默认(应用自身 UA)</option>
          <option value="__codex">OpenAI Codex CLI</option>
          <option value="__chatgpt">ChatGPT 桌面端</option>
          <option value="__claude">Claude 桌面端</option>
          <option value="__chrome">Chrome 浏览器(Windows)</option>
          <option value="__cherry">Cherry Studio</option>
          <option value="__custom">自定义…</option>
        </select>
        <input type="text" id="dv-ua-custom" placeholder="自定义 UA 字符串" style="display:none;width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none">
      </div>
      <div class="field">
        <label>插件兼容(DSH 代码插件)</label>
        <div class="setting-row">
          <div><div class="label">开启插件兼容</div><div class="desc">允许 DSH 代码插件在独立隔离子进程中载入运行并把工具注册给智能体(默认关;开启后下方出现插件兼容管理框,空闲 5 分钟自动休眠;将执行第三方代码,请只载入信任的来源)</div></div>
          <input type="checkbox" id="dv-dshhost" ${(dev.dshHost) ? 'checked' : ''}>
        </div>
        ${dev.dshHost ? '<div id="dsh-compat-box"></div>' : ''}
      </div>
      <div class="field">
        <label>实验性功能(可能不稳定,随时调整或移除)</label>
        <div class="setting-row">
          <div><div class="label">思考滑块缩放(完全等比例)</div><div class="desc">只缩放输入框上方的思考滑块这一行(文字/布局同步等比收缩);觉得滑块行太长时调低</div></div>
          <select id="dv-sliderzoom">
            ${[[1, '100%(默认)'], [0.9, '90%'], [0.8, '80%'], [0.7, '70%'], [0.6, '60%'], [0.5, '50%'], [0.25, '25%']].map(([v, l]) => `<option value="${v}" ${Math.abs(sliderZoom - v) < 0.001 ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="setting-row">
          <div><div class="label">记忆</div><div class="desc">开启之后会大量增加上下文消耗,但是会继承你所有的记忆 —— AI 会把值得长期记住的信息(偏好/约定/项目背景等)沉淀下来,之后的对话自动继承;默认关闭</div></div>
          <input type="checkbox" id="dv-memory" ${(dev.memory) ? 'checked' : ''}>
        </div>
        <div class="setting-row">
          <div><div class="label">学习功能</div><div class="desc">AI 做错、你教它正确方法后,会把纠正沉淀为<b>专属的用户提示词</b>(每次对话自动生效)或<b>用户技能</b>(技能栏卡片,按需启用);默认关闭</div></div>
          <input type="checkbox" id="dv-learn" ${(dev.learning) ? 'checked' : ''}>
        </div>
        ${dev.memory ? renderDevMemoryList() : ''}
        ${dev.learning ? renderDevLearnedList() : ''}
        <div class="setting-row">
          <div><div class="label">低内存低占用模式</div><div class="desc">关闭 Markdown 渲染/代码高亮/动画与阴影,流式刷新降频 —— 低配机与超长会话更流畅</div></div>
          <input type="checkbox" id="dv-perf" ${ui.perfLowMemory ? 'checked' : ''}>
        </div>
        <div class="setting-row">
          <div><div class="label">省电渲染(压 GPU 占用)</div><div class="desc">关闭毛玻璃/背景图等窗口特效与全部动画、流式刷新降频(纯 CSS 降级,所有显卡安全;特效部分即时生效)。GPU 占用仍高时,可另开下方「强制核显合成」</div></div>
        <div class="setting-row">
          <div><div class="label">强制核显合成(实验性)</div><div class="desc" style="color:var(--warn)">强制 Chromium 用核显合成(双显卡笔记本上可避开独显驱动问题)。⚠ 按机器而定可能反而导致发黑/糊边;开启后若画面异常请关闭并重启(启动时自动检测关闭)</div></div>
          <input type="checkbox" id="dv-igpu" ${ui.forceLowPowerGpu ? 'checked' : ''}>
        </div>
        <div class="setting-row">
          <div><div class="label">软件渲染(兼容模式)</div><div class="desc" style="color:var(--warn)">完全绕开显卡驱动的硬件合成(CPU 渲染)—— 显卡驱动兼容性问题(黑块/字体糊边)的确定性退路;更耗 CPU,仅在遇到渲染损坏时使用(重启生效)</div></div>
          <input type="checkbox" id="dv-swrender" ${ui.softwareRender ? 'checked' : ''}>
        </div>
          <input type="checkbox" id="dv-power" ${ui.powerSave ? 'checked' : ''}>
        </div>
        <div class="setting-row">
          <div><div class="label">精简模式</div><div class="desc">整个窗口变为一台精简的终端形态智能体(参考 Claude Code):直接输入即与 AI 对话,工具调用/审批/问询照常,可创建内容与执行任务;输入 !cmd 直通真实 shell。状态栏「⚙ 设置」或 /exit 返回完整界面,期间会话照常落盘</div></div>
          <input type="checkbox" id="dv-pure" ${ui.pureTerminal ? 'checked' : ''}>
        </div>
        <div class="setting-row">
          <div><div class="label">终端思考显示</div><div class="desc">精简模式下 AI 思考过程的展示方式(标准模式的思考折叠不受影响);终端内也可用 /think 快速切换</div></div>
          <select id="dv-thinkview">
            <option value="chain" ${(ui.termReasonView || 'chain') === 'chain' ? 'selected' : ''}>思考链(完整输出)</option>
            <option value="status" ${ui.termReasonView === 'status' ? 'selected' : ''}>纯状态(只显示动画与耗时)</option>
          </select>
        </div>
        <div class="hint">以上均为实验性功能:精简/低内存模式立即生效(精简模式即时接管整窗,聊天区在后台照常)。毛玻璃/背景图片/背景透明化已移至「外观」页。</div>
      </div>
    </div>`;

  const saveDev = (patch) => liteapi.invoke('config:set', { dev: patch }).then((c) => { state.config = c; positionTerminal(); });
  const saveUi = (patch) => liteapi.invoke('config:set', { ui: patch }).then((c) => { state.config = c; applyUiMode(); });
  if (dev.dshHost) renderDshCompatBox(); // 插件兼容管理框(总开关开启后出现)
  $('#dv-corner').addEventListener('change', (e) => saveDev({ terminalCorner: e.target.value }));
  if ($('#dv-shell')) {
    $('#dv-shell').addEventListener('change', (e) => { saveDev({ terminalShell: e.target.value }); toast('Shell 已切换,在终端面板点「重置」生效'); });
  }
  $('#dv-sliderzoom').addEventListener('change', (e) => saveUi({ sliderZoom: Number(e.target.value) || 1 }).then(() => toast(`思考滑块缩放:${Math.round((Number(e.target.value) || 1) * 100)}%`)));
  $('#dv-perf').addEventListener('change', (e) => saveUi({ perfLowMemory: e.target.checked }).then(() => toast(e.target.checked ? '低内存低占用模式已开启(即时生效)' : '低内存低占用模式已关闭')));
  // 记忆/学习开关(v0.41):工具与提示词注入在下一次发送时生效
  // User-Agent 覆盖(v0.54.14):预设映射 + 自定义;写 config.dev.userAgent,http.js getter 动态读即时生效
  const UA_PRESETS = {
    __codex: 'codex_cli_rs/0.21.0 (Windows 11.0.26200; x86_64) Codex/1.0.48',
    __chatgpt: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ChatGPT/1.2025.146.0 Chrome/130.0.6723.59 Electron/33.0.0 Safari/537.36',
    __claude: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) claude-ai-desktop/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36',
    __chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    __cherry: 'Cherry Studio/1.6.0',
  };
  const uaSel = $('#dv-ua-preset');
  const uaInput = $('#dv-ua-custom');
  if (uaSel && uaInput) {
    const cur = (dev && dev.userAgent) || '';
    const hitKey = Object.keys(UA_PRESETS).find((k) => UA_PRESETS[k] === cur);
    if (hitKey) uaSel.value = hitKey;
    else if (cur) { uaSel.value = '__custom'; uaInput.style.display = ''; uaInput.value = cur; }
    const applyUa = async (val) => {
      state.config = await liteapi.invoke('config:set', { dev: { userAgent: val } });
      rerenderSettings();
      toast(val ? 'User-Agent 已覆盖(即时生效):' + val.slice(0, 40) + '…' : '已恢复默认 User-Agent');
    };
    uaSel.addEventListener('change', async (e) => {
      const k = e.target.value;
      if (!k) { await applyUa(''); return; }
      if (k === '__custom') { uaInput.style.display = ''; uaInput.focus(); return; }
      uaInput.style.display = 'none';
      await applyUa(UA_PRESETS[k]);
    });
    uaInput.addEventListener('change', async (e) => {
      const v = e.target.value.trim();
      if (v) await applyUa(v);
    });
  }
  $('#dv-memory').addEventListener('change', (e) => saveDev({ memory: e.target.checked }).then(() => { rerenderSettings(); toast(e.target.checked ? '记忆已开启:AI 可沉淀长期记忆,新对话继承(下一句生效)' : '记忆已关闭:不再注入与保存记忆') }));
  $('#dv-learn').addEventListener('change', (e) => saveDev({ learning: e.target.checked }).then(() => { rerenderSettings(); toast(e.target.checked ? '学习功能已开启:AI 被纠正后会沉淀提示词/技能(下一句生效)' : '学习功能已关闭') }));
  $('#dv-dshhost').addEventListener('change', (e) => {
    const on = e.target.checked;
    if (on && !confirm('开启插件兼容(DSH 运行时层)?\n\n开启后,下方会出现插件兼容管理框 —— 对已安装的 DSH 插件包逐个「载入」。它们的代码将在独立隔离子进程中运行(空闲 5 分钟自动休眠),并可以把工具注册给智能体。将执行第三方代码,请只载入你信任的来源。')) { e.target.checked = false; return; }
    saveDev({ dshHost: on }).then(() => { rerenderSettings(); toast(on ? '插件兼容已开启:管理框见下方' : '插件兼容已关闭(宿主子进程已退出)'); });
  });
  $$('#modal-body [data-mem-del]').forEach((b) => b.addEventListener('click', async () => {
    state.config = await liteapi.invoke('config:set', { memories: (state.config.memories || []).filter((m) => m.id !== b.dataset.memDel) });
    rerenderSettings();
  }));
  const memClear = $('#dv-memory-clear');
  if (memClear) memClear.addEventListener('click', async () => {
    if (!confirm('清空全部长期记忆?不可恢复。')) return;
    state.config = await liteapi.invoke('config:set', { memories: [] });
    rerenderSettings();
    toast('记忆已清空');
  });
  $$('#modal-body [data-lp-del]').forEach((b) => b.addEventListener('click', async () => {
    state.config = await liteapi.invoke('config:set', { learnedPrompts: (state.config.learnedPrompts || []).filter((l) => l.id !== b.dataset.lpDel) });
    rerenderSettings();
  }));
  $$('#modal-body [data-ls-del]').forEach((b) => b.addEventListener('click', async () => {
    state.config = await liteapi.invoke('config:set', { skills: (state.config.skills || []).filter((s) => s.id !== b.dataset.lsDel) });
    renderSkillBar();
    rerenderSettings();
  }));
  const lpClear = $('#dv-lp-clear');
  if (lpClear) lpClear.addEventListener('click', async () => {
    if (!confirm('清空全部用户提示词(学习积累)?不可恢复。')) return;
    state.config = await liteapi.invoke('config:set', { learnedPrompts: [] });
    rerenderSettings();
    toast('用户提示词已清空');
  });
  $('#dv-pure').addEventListener('change', (e) => saveUi({ pureTerminal: e.target.checked }).then(() => toast(e.target.checked ? '精简模式已开启' : '精简模式已关闭')));
  const dvThink = $('#dv-thinkview');
  if (dvThink) dvThink.addEventListener('change', (e) => saveUi({ termReasonView: e.target.value }).then(() => toast(`终端思考显示:${e.target.value === 'chain' ? '思考链(完整输出)' : '纯状态(不输出思考链)'}`)));
  $('#dv-power').addEventListener('change', (e) => saveUi({ powerSave: e.target.checked }).then(() => toast(e.target.checked ? '省电渲染已开启(特效已即时关闭)' : '省电渲染已关闭')));
  $('#dv-igpu').addEventListener('change', (e) => saveDev({ forceLowPowerGpu: e.target.checked }).then(() => toast(t('重启应用后生效') + (e.target.checked ? '(如出现画面发黑,启动时会自动关闭本项)' : ''))));
  $('#dv-swrender').addEventListener('change', (e) => saveDev({ softwareRender: e.target.checked }).then(() => toast(t('重启应用后生效') + (e.target.checked ? '(兼容模式:CPU 渲染,可修复发黑/糊边)' : ''))));
}

/* ---- 上下文压缩 tab ---- */
const DEFAULT_SUMMARY_PROMPT = '你是对话压缩器。请把用户发来的对话历史压缩成一份要点摘要(不超过500字),必须保留:用户的目标与约束、已完成的步骤、关键文件路径与名称、重要决定、未完成的事项。不要寒暄,直接输出摘要正文。';

function renderContextPane(root) {
  const R = root || $('#modal-body');
  const c = state.config.context || {};
  const strategy = c.strategy || 'trim';
  const comp = c.compress || {};
  const gpt = comp.gpt || {};
  const models = Array.isArray(comp.models) ? comp.models : [];
  const compCfg = {
    enabled: comp.enabled !== false,
    mode: ['standard', 'cache', 'extreme'].includes(comp.mode) ? comp.mode : 'standard',
    defaultPercent: Math.min(99, Math.max(10, Number(comp.defaultPercent) || 80)),
    gpt: {
      enabled: gpt.enabled !== false,
      window: Number(gpt.window) > 0 ? Math.round(Number(gpt.window)) : 272000,
      percent: Math.min(99, Math.max(10, Number(gpt.percent) || 90)),
    },
    models,
  };
  const gptThreshold = Math.floor((compCfg.gpt.window * compCfg.gpt.percent) / 100);
  const mode = compCfg.mode;

  // 百分比下拉(50~99);当前值不在列表时补进去
  const pctOptions = (cur) => {
    const base = [50, 60, 70, 75, 80, 85, 90, 95, 99];
    const v = Math.min(99, Math.max(10, Number(cur) || 80));
    if (!base.includes(v)) base.push(v);
    base.sort((a, b) => a - b);
    let out = '';
    for (const p of base) out += `<option value="${p}" ${p === v ? 'selected' : ''}>${p}%</option>`;
    return out;
  };

  // 可添加的模型(去重;来自当前已配置 Key 的供应商)
  const choices = [];
  const seen = new Set();
  for (const mc of (state.modelChoices || [])) {
    const key = mc.providerId + '||' + mc.model;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(mc);
  }
  let modelOpts = '';
  for (const mc of choices) {
    modelOpts += `<option value="${escapeHtml(mc.providerId)}||${escapeHtml(mc.model)}">${escapeHtml(mc.providerName)} · ${escapeHtml(mc.model)}</option>`;
  }

  let rows = '';
  for (const m of models) {
    const prov = (state.config.providers || []).find((p) => p.id === m.providerId);
    const label = (prov ? prov.name + ' · ' : '') + m.model;
    rows += `<div class="cx-row" data-p="${escapeHtml(m.providerId || '')}" data-m="${escapeHtml(m.model)}">
      <span class="cx-model" title="${escapeHtml(label)}">${escapeHtml(m.model)}</span>
      <input type="number" class="cx-window" min="1000" step="1000" placeholder="自动" value="${Number(m.window) > 0 ? Number(m.window) : ''}">
      <select class="cx-percent">${pctOptions(Number(m.percent) || compCfg.defaultPercent)}</select>
      <button type="button" class="cx-del" title="删除该模型预设">✕</button>
    </div>`;
  }
  if (!rows) rows = '<div class="cx-empty">还没有按模型配置 —— 未单独配置的模型走下方默认规则。</div>';

  R.innerHTML = `
    <div class="agent-settings" style="max-width:700px">
      <div class="field">
        <label>超限策略</label>
        <select id="cx-strategy" style="width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none">
          <option value="trim" ${strategy === 'trim' ? 'selected' : ''}>截断:直接丢弃最旧消息(零成本,丢失上下文)</option>
          <option value="summarize" ${strategy === 'summarize' ? 'selected' : ''}>摘要压缩:调用当前模型把旧对话总结成摘要(滚动合并,推荐长任务)</option>
        </select>
        <div class="hint">摘要压缩在每次请求前按<b>下方 token 阈值</b>判断:超限才压缩,旧消息 → 要点摘要(保留目标/步骤/文件路径/决定/未完成事项);阈值未知的模型退回按「携带历史条数」。</div>
      </div>

      <div class="field">
        <label>压缩核心模式</label>
        <div class="cx-modes" id="cx-modes">
          <label class="cx-mode ${mode === 'standard' ? 'on' : ''}" data-mode="standard">
            <input type="radio" name="cx-mode" value="standard" ${mode === 'standard' ? 'checked' : ''}>
            <b>标准压缩</b><span>到阈值就摘要,保留最近原文;省心均衡</span>
          </label>
          <label class="cx-mode ${mode === 'cache' ? 'on' : ''}" data-mode="cache">
            <input type="radio" name="cx-mode" value="cache" ${mode === 'cache' ? 'checked' : ''}>
            <b>保缓存命中率</b><span>压缩后冷却(再涨 3% 窗口才再压),多留原文;减少缓存失效</span>
          </label>
          <label class="cx-mode ${mode === 'extreme' ? 'on' : ''}" data-mode="extreme">
            <input type="radio" name="cx-mode" value="extreme" ${mode === 'extreme' ? 'checked' : ''}>
            <b>极致压缩</b><span>只留最近 3 条 + 200 字摘要 + 工具结果 4K;最省 token</span>
          </label>
        </div>
        <div class="hint">当前模式:${mode === 'cache' ? '保缓存命中率(压缩后需再涨约 3% 窗口才会再次压缩)' : mode === 'extreme' ? '极致压缩(保留 3 条 / 摘要 200 字 / 工具结果 4K)' : '标准压缩(按阈值摘要 + 保留用户设定的原文条数)'}</div>
      </div>

      <div class="setting-row">
        <div><div class="label">启用按 Token 阈值自动压缩</div><div class="desc">关闭后回到按「携带历史条数」的旧逻辑</div></div>
        <label class="switch"><input type="checkbox" id="cx-compress-enabled" ${compCfg.enabled ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label>
      </div>

      <div class="field">
        <label>系统默认压缩阈值(全局)</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="number" id="cx-default-percent" min="10" max="99" value="${compCfg.defaultPercent}" style="width:96px">
          <span style="color:var(--text-2);font-size:12.5px">% 的上下文窗口</span>
        </div>
        <div class="hint">未单独配置的模型按「上下文窗口 × 该百分比」触发压缩。窗口优先取供应商手动 ctxLimit,其次 models.dev 快照。</div>
      </div>

      <div class="settings-group" style="margin-top:14px">
        <div class="sg-title">⚡ GPT 专属压缩(全局,仅模型名含 GPT)</div>
        <div class="setting-row">
          <div><div class="label">启用 GPT 专属规则</div><div class="desc">模型名称包含 GPT(不分大小写)时直接按此规则;按模型预设优先于它</div></div>
          <label class="switch"><input type="checkbox" id="cx-gpt-enabled" ${compCfg.gpt.enabled ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label>
        </div>
        <div class="setting-row">
          <div><div class="label">GPT 上下文窗口</div><div class="desc">默认 272000 tokens</div></div>
          <input type="number" id="cx-gpt-window" min="1000" step="1000" value="${compCfg.gpt.window}">
        </div>
        <div class="setting-row">
          <div><div class="label">GPT 自动压缩阈值</div><div class="desc">当前 = ${compCfg.gpt.window} × ${compCfg.gpt.percent}% = <b>${gptThreshold}</b> tokens</div></div>
          <select id="cx-gpt-percent" style="width:110px">${pctOptions(compCfg.gpt.percent)}</select>
        </div>
      </div>

      <div class="settings-group" style="margin-top:14px">
        <div class="sg-title">🎯 按模型预设(优先于 GPT 规则与系统默认)</div>
        <div class="cx-table">
          <div class="cx-thead"><span>模型名称</span><span>上下文窗口</span><span>自动压缩</span><span></span></div>
          ${rows}
        </div>
        <div class="cx-add">
          <select id="cx-model-pick" ${choices.length ? '' : 'disabled'}>${modelOpts || '<option value="">(先在供应商页配置模型)</option>'}</select>
          <button type="button" class="btn" id="cx-model-add" ${choices.length ? '' : 'disabled'}>＋ 添加模型</button>
        </div>
        <div class="hint">窗口留空 = 自动(GPT 用上方规则,其他按供应商/模型库);百分比是该模型自己的触发点,例:1M 窗口选 90% = 900000 tokens 时压缩。</div>
      </div>

      <div class="setting-row" style="margin-top:14px">
        <div><div class="label">携带历史条数</div><div class="desc">仅「截断」策略或阈值未知时生效</div></div>
        <input type="number" id="cx-history" min="4" max="200" value="${state.config.chat.maxHistory}">
      </div>
      <div class="setting-row">
        <div><div class="label">压缩时保留最近原文条数</div><div class="desc">摘要策略下,最近这些消息保持原文不压缩</div></div>
        <input type="number" id="cx-keep" min="2" max="50" value="${c.keepRecent || 8}">
      </div>
      <div class="field">
        <label>工具结果截断(字符数)</label>
        <input type="number" id="cx-cap" min="1000" max="100000" step="1000" value="${c.toolResultCap || 20000}">
        <div class="hint">工具返回的长文本(文件内容/网页/命令输出)送入模型前的截断上限,防止单条工具结果撑爆上下文。</div>
      </div>
      <div class="field">
        <label>摘要提示词</label>
        <textarea id="cx-prompt" class="mono" style="min-height:100px">${escapeHtml(c.summaryPrompt || DEFAULT_SUMMARY_PROMPT)}</textarea>
        <div class="hint">调用当前所选模型执行;修改后立即生效。</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="cx-restore">恢复默认摘要提示词</button>
      </div>
    </div>`;

  // 保存压缩配置:config:set 对 context 是浅合并,必须带完整 context 对象
  const saveCompress = async (next) => {
    const ctx = { ...(state.config.context || {}) };
    ctx.compress = next;
    state.config = await liteapi.invoke('config:set', { context: ctx });
  };
  const currentComp = () => {
    const x = (state.config.context && state.config.context.compress) || {};
    return {
      enabled: x.enabled !== false,
      mode: ['standard', 'cache', 'extreme'].includes(x.mode) ? x.mode : 'standard',
      defaultPercent: Math.min(99, Math.max(10, Number(x.defaultPercent) || 80)),
      gpt: {
        enabled: !x.gpt || x.gpt.enabled !== false,
        window: Number(x.gpt && x.gpt.window) > 0 ? Math.round(Number(x.gpt.window)) : 272000,
        percent: Math.min(99, Math.max(10, Number(x.gpt && x.gpt.percent) || 90)),
      },
      models: Array.isArray(x.models) ? x.models.slice() : [],
    };
  };

  $('#cx-strategy').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { strategy: e.target.value } }));
  $('#cx-history').addEventListener('change', (e) => liteapi.invoke('config:set', { chat: { maxHistory: Math.max(4, parseInt(e.target.value, 10) || 40) } }));
  $('#cx-keep').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { keepRecent: Math.max(2, parseInt(e.target.value, 10) || 8) } }));
  $('#cx-cap').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { toolResultCap: Math.min(100000, Math.max(1000, parseInt(e.target.value, 10) || 20000)) } }));
  $('#cx-prompt').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { summaryPrompt: e.target.value } }));
  $('#cx-restore').addEventListener('click', () => { liteapi.invoke('config:set', { context: { summaryPrompt: DEFAULT_SUMMARY_PROMPT } }); $('#cx-prompt').value = DEFAULT_SUMMARY_PROMPT; });

  // 压缩核心模式:标准 / 保缓存 / 极致
  for (const input of $$('#cx-modes input[name="cx-mode"]', R)) {
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      const next = currentComp();
      next.mode = input.value;
      await saveCompress(next);
      renderContextPane(R);
      toast('压缩模式:' + (next.mode === 'cache' ? '保缓存命中率' : next.mode === 'extreme' ? '极致压缩' : '标准压缩'));
    });
  }
  $('#cx-compress-enabled').addEventListener('change', async (e) => {
    const next = currentComp();
    next.enabled = e.target.checked;
    await saveCompress(next);
    toast(next.enabled ? '已启用按 Token 阈值压缩' : '已关闭,回到按条数压缩');
  });
  $('#cx-default-percent').addEventListener('change', async (e) => {
    const next = currentComp();
    next.defaultPercent = Math.min(99, Math.max(10, parseInt(e.target.value, 10) || 80));
    e.target.value = next.defaultPercent;
    await saveCompress(next);
  });
  $('#cx-gpt-enabled').addEventListener('change', async (e) => {
    const next = currentComp();
    next.gpt.enabled = e.target.checked;
    await saveCompress(next);
  });
  $('#cx-gpt-window').addEventListener('change', async (e) => {
    const next = currentComp();
    next.gpt.window = Math.max(1000, parseInt(e.target.value, 10) || 272000);
    e.target.value = next.gpt.window;
    await saveCompress(next);
    renderContextPane(R); // 阈值摘要文字需要刷新
  });
  $('#cx-gpt-percent').addEventListener('change', async (e) => {
    const next = currentComp();
    next.gpt.percent = Math.min(99, Math.max(10, parseInt(e.target.value, 10) || 90));
    await saveCompress(next);
    renderContextPane(R);
  });

  // 按模型预设表:窗口/百分比编辑 + 删除
  for (const row of $$('.cx-row', R)) {
    const p = row.dataset.p;
    const m = row.dataset.m;
    const win = $('.cx-window', row);
    const pct = $('.cx-percent', row);
    win.addEventListener('change', async () => {
      const next = currentComp();
      const hit = next.models.find((x) => x.model === m && (x.providerId || '') === (p || ''));
      if (!hit) return;
      hit.window = Math.max(0, parseInt(win.value, 10) || 0);
      await saveCompress(next);
    });
    pct.addEventListener('change', async () => {
      const next = currentComp();
      const hit = next.models.find((x) => x.model === m && (x.providerId || '') === (p || ''));
      if (!hit) return;
      hit.percent = parseInt(pct.value, 10) || 90;
      await saveCompress(next);
    });
    $('.cx-del', row).addEventListener('click', async () => {
      const next = currentComp();
      next.models = next.models.filter((x) => !(x.model === m && (x.providerId || '') === (p || '')));
      await saveCompress(next);
      renderContextPane(R);
      toast('已删除该模型预设');
    });
  }

  // 添加模型:自动带出该模型的上下文窗口(models.dev / 供应商 ctxLimit)
  $('#cx-model-add').addEventListener('click', async () => {
    const pick = $('#cx-model-pick');
    const val = pick && pick.value;
    if (!val) return;
    const parts = val.split('||');
    const providerId = parts[0];
    const model = parts.slice(1).join('||');
    const next = currentComp();
    if (next.models.some((x) => x.model === model && (x.providerId || '') === providerId)) { toast('该模型已配置'); return; }
    // GPT 模型默认带 GPT 规则(272000 / 90%),不被模型库窗口覆盖;其他模型自动取模型窗口
    const isGpt = /gpt/i.test(model);
    let win = 0;
    let pct = next.defaultPercent;
    if (isGpt && next.gpt.enabled) {
      win = next.gpt.window;
      pct = next.gpt.percent;
    } else {
      try {
        const caps = await liteapi.invoke('reason:caps', { providerId, model });
        win = Number(caps && caps.contextLimit) || 0;
      } catch (_) { /* ignore */ }
    }
    next.models.push({ providerId, model, window: win, percent: pct });
    await saveCompress(next);
    renderContextPane(R);
    toast('已添加模型预设');
  });
}

/* ---- 诊断 tab ---- */
function renderDebugPane() {
  const d = state.config.debug || {};
  $('#modal-body').innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>诊断接入口</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          应用运行中的模型请求、工具调用、Key 轮换、错误堆栈都会记入本地调试日志(与安全审计分开)。<br>
          <b>遇到问题时:点「导出诊断信息」生成一个 JSON 文件,把它发给开发者即可远程定位。</b>导出内容含环境版本、脱敏配置(所有 Key 已隐藏)、会话列表与最近日志,不含 API Key 与对话正文。
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">渲染自检(排查 GPU 占用)</div><div class="desc">列出当前页面所有运行中的动画/过渡 —— 空闲时若有常驻动画,就是持续产生渲染帧(GPU 占用)的来源</div></div>
        <button class="btn" id="db-render-probe">自检</button>
      </div>
      <div id="db-render-out"></div>
      <div class="setting-row">
        <div><div class="label">启用调试日志</div><div class="desc">关闭后仅记录 error 级别</div></div>
        <input type="checkbox" id="db-enabled" ${d.enabled !== false ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">日志级别</div><div class="desc">详细模式额外记录请求规模等细节,排查完建议调回常规</div></div>
        <select id="db-level">
          <option value="info" ${(d.level || 'info') === 'info' ? 'selected' : ''}>常规</option>
          <option value="verbose" ${d.level === 'verbose' ? 'selected' : ''}>详细</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="label">调试日志</div><div class="desc" id="db-stats">读取中…</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn" id="db-open">打开文件夹</button>
          <button class="btn danger" id="db-clear">清空</button>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">渲染修复</div><div class="desc">清除 GPU 着色器缓存并重启 —— 修复「画面发黑/字体糊边」类渲染污染(缓存自动重建,不影响数据)</div></div>
        <button class="btn" id="db-gpucache">清除 GPU 缓存并重启…</button>
      </div>
      <div class="setting-row">
        <div><div class="label">导出诊断信息</div><div class="desc">生成诊断包文件(发给开发者定位问题用)</div></div>
        <button class="btn primary" id="db-export">导出诊断信息…</button>
      </div>
    </div>`;

  $('#db-gpucache').addEventListener('click', async () => {
    if (!confirm('清除 GPU 着色器缓存并重启应用?\n\n用于修复「画面发黑/字体糊边」类渲染污染(缓存会自动重建,不影响任何数据)。')) return;
    toast('正在清除并重启…');
    await liteapi.invoke('diag:clearGpuCache');
  });

  $('#db-render-probe').addEventListener('click', () => {
    const out = $('#db-render-out');
    if (!out) return;
    const anims = (document.getAnimations ? document.getAnimations() : []).map((a) => ({
      name: a.animationName || ('transition:' + (a.transitionProperty || '?')),
      target: a.effect && a.effect.target ? String(a.effect.target.className || a.effect.target.tagName).slice(0, 60) : '?',
    }));
    out.innerHTML = `<div class="hint" style="font-size:12px;line-height:1.8;margin:8px 0">
      运行中的动画/过渡:<b>${anims.length}</b> 个${anims.length ? '<br>' + anims.slice(0, 12).map((x) => `・${escapeHtml(x.name)} → ${escapeHtml(x.target)}`).join('<br>') + (anims.length > 12 ? '<br>…' : '') : '(空闲:无常驻帧源,GPU 占用应接近 0)'}
      <br>页面可见性:${document.visibilityState}(隐藏时 Chromium 自动节流)
      <br>若自检为 0 但 GPU 仍高:关掉毛玻璃/背景透明化后重启,或在 设置 → 开发者 开启「省电渲染」(核显合成)。
    </div>`;
  });
  $('#db-enabled').addEventListener('change', (e) => liteapi.invoke('config:set', { debug: { enabled: e.target.checked } }));
  $('#db-level').addEventListener('change', (e) => liteapi.invoke('config:set', { debug: { level: e.target.value } }));
  const refresh = () => liteapi.invoke('debug:stats').then((st) => {
    const kb = (st.bytes / 1024).toFixed(1);
    $('#db-stats').textContent = `${st.files} 个文件 · ${kb} KB · 今日 ${st.lines} 条`;
  });
  refresh();
  $('#db-open').addEventListener('click', () => liteapi.invoke('debug:openDir'));
  $('#db-clear').addEventListener('click', async () => {
    if (!confirm('清空调试日志?')) return;
    const n = await liteapi.invoke('debug:clear');
    toast(`已清空 ${n} 个日志文件`);
    refresh();
  });
  $('#db-export').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await liteapi.invoke('debug:export');
      if (r.ok) toast('诊断包已导出:' + r.path);
    } catch (err) {
      toast('导出失败: ' + err.message);
    }
    btn.disabled = false;
  });
}

/* ---- 用量统计 tab(v0.29 仪表盘:布局照用户截图) ---- */
const USAGE_PALETTE = ['#4d6bfe', '#16a34a', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4', '#ef4444', '#94a3b8'];
let usageRange = '30d'; // 近24小时 / 近7天 / 近30天 / 全部
let usageConvQ = '';
let usageSort = 'updated';
let usageGroup = 'all';

const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDur = (ms) => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.round(total / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const fmtMoney = (v) => '¥' + (v >= 100 ? v.toFixed(1) : v >= 0.01 ? v.toFixed(2) : v.toFixed(4));
const timeAgo = (ts) => {
  const s = (Date.now() - (ts || 0)) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  const d = Math.floor(s / 86400);
  return d <= 30 ? d + ' 天前' : new Date(ts).toLocaleDateString('zh-CN');
};
// 最近 n 天的每日桶(含空日);n=1 即今天
function usageRangeRows(g, n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const k = dayKeyOf(d);
    out.push({ key: k, date: d, v: (g.daily && g.daily[k]) || null });
  }
  return out;
}
// 范围聚合(近 n 天);all 用全局累计
function usageAgg(g, range) {
  const acc = { requests: 0, prompt: 0, completion: 0, cached: 0, cost: 0, activeMs: 0, toolCount: 0, toolMs: 0, wait: 0, think: 0, output: 0, tps: { tokens: 0, ms: 0 }, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 } };
  const add = (v) => {
    for (const k of ['requests', 'prompt', 'completion', 'cached', 'cost', 'activeMs', 'toolCount', 'toolMs', 'wait', 'think', 'output']) acc[k] += v[k] || 0;
    if (v.tps) { acc.tps.tokens += v.tps.tokens || 0; acc.tps.ms += v.tps.ms || 0; }
    for (const k of Object.keys(acc.parts)) acc.parts[k] += (v.parts && v.parts[k]) || 0;
  };
  if (range === 'all') {
    add({ requests: g.requests, prompt: g.prompt, completion: g.completion, cached: g.cached, cost: g.cost, activeMs: g.activeMs, toolCount: (g.tools || {}).count, toolMs: (g.tools || {}).ms, wait: (g.times || {}).wait, think: (g.times || {}).think, output: (g.times || {}).output, tps: g.tps, parts: g.parts });
    return acc;
  }
  const n = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  for (const { v } of usageRangeRows(g, n)) if (v) add(v);
  return acc;
}
function donutSvg(items, centerTop, centerSub) {
  const total = items.reduce((s, x) => s + x.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let off = 0;
  const segs = total > 0 ? items.map((x) => {
    const frac = x.value / total;
    const len = Math.max(0.5, frac * C - 1.5);
    const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${x.color}" stroke-width="20" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
    off += frac * C;
    return seg;
  }).join('') : `<circle r="${R}" cx="70" cy="70" fill="none" stroke="var(--bg-hover)" stroke-width="20"/>`;
  return `<svg viewBox="0 0 140 140" class="ud-donut">${segs}<text x="70" y="63" text-anchor="middle" class="ud-donut-num">${escapeHtml(centerTop)}</text><text x="70" y="82" text-anchor="middle" class="ud-donut-sub">${escapeHtml(centerSub)}</text></svg>`;
}
function usageLegend(items, fmtVal, fmtSub) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (!items.length) return '<div class="hint" style="font-size:12px">暂无数据 —— 数据自 v0.29 起开始积累</div>';
  return items.map((x) => `
    <div class="ud-leg">
      <span class="ud-dot" style="background:${x.color}"></span>
      <span class="ud-leg-name">${escapeHtml(x.label)}<span class="ud-leg-sub">${escapeHtml(fmtVal(x) + (fmtSub ? ' · ' + fmtSub(x) : ''))}</span></span>
      <span class="ud-leg-pct">${total > 0 ? ((x.value / total) * 100).toFixed(1) + '%' : '—'}</span>
    </div>`).join('');
}

/* ---- 上下文管理 tab(v0.56.2):一个入口,用量 / 压缩两个子页签 ---- */
let usageRootEl = null;
let contextSubTab = 'usage';
function renderContextManagementPane() {
  const body = $('#modal-body');
  body.innerHTML = `
    <div class="cm-pane">
      <div class="cm-tabs" id="cm-tabs">
        <button type="button" class="cm-tab ${contextSubTab === 'usage' ? 'on' : ''}" data-cm="usage">📊 用量与成本</button>
        <button type="button" class="cm-tab ${contextSubTab === 'compress' ? 'on' : ''}" data-cm="compress">🧠 压缩策略</button>
      </div>
      <div id="cm-usage-wrap" class="${contextSubTab === 'usage' ? '' : 'hidden'}"><div id="cm-usage"></div></div>
      <div id="cm-compress-wrap" class="${contextSubTab === 'compress' ? '' : 'hidden'}"><div id="sec-context"></div></div>
    </div>`;
  const apply = (tab) => {
    contextSubTab = tab;
    $('#cm-usage-wrap').classList.toggle('hidden', tab !== 'usage');
    $('#cm-compress-wrap').classList.toggle('hidden', tab !== 'compress');
    for (const b of $$('#cm-tabs .cm-tab')) b.classList.toggle('on', b.dataset.cm === tab);
    if (tab === 'usage') renderUsagePane($('#cm-usage'));
    else renderContextPane($('#sec-context'));
  };
  for (const b of $$('#cm-tabs .cm-tab')) b.addEventListener('click', () => apply(b.dataset.cm));
  renderUsagePane($('#cm-usage'));
  renderContextPane($('#sec-context'));
}

function renderUsagePane(root) {
  usageRootEl = root || $('#modal-body');
  if (!usageRootEl) return;
  usageRootEl.innerHTML = '<div class="hint" style="padding:24px">加载用量数据…</div>';
  liteapi.invoke('convs:list').then((list) => {
    state.convs = list;
    if (settingsTab === 'context' || settingsTab === 'usage') drawUsageDashboard();
  }).catch(() => { if (settingsTab === 'context' || settingsTab === 'usage') drawUsageDashboard(); });
}

function drawUsageDashboard() {
  const body = usageRootEl || $('#modal-body');
  if (!body) return;
  const g = state.config.usage || {};
  const convs = state.convs || [];
  const RANGES = [['24h', '近24小时'], ['7d', '近7天'], ['30d', '近30天'], ['all', '全部']];
  const A = usageAgg(g, usageRange);

  // —— 统计卡 ——
  const activeConvs = convs.filter((c) => c.usage && c.usage.requests > 0).length;
  const hitPct = A.prompt > 0 && A.cached ? (A.cached / A.prompt * 100).toFixed(2) + '%' : '—';
  const cards = [
    { num: String(activeConvs), label: '活跃会话', sub: `共 ${convs.length} 个` },
    { num: fmtTok(A.prompt + A.completion), label: '累计消耗', sub: `轮次 ${A.requests}` },
    { num: fmtMoney(A.cost), label: '费用(估算)', sub: 'models.dev 价目' },
    { num: hitPct, label: '缓存命中', sub: `缓存 ${fmtTok(A.cached)} tokens` },
    { num: fmtTok(A.toolCount), label: '工具调用', sub: `工具执行 ${fmtDur(A.toolMs)}` },
    { num: fmtDur(A.activeMs), label: '活跃时长', sub: `模型调用 ${A.requests}` },
  ].map((c) => `<div class="usage-card"><div class="uc-num">${escapeHtml(c.num)}</div><div class="uc-label">${c.label}</div><div class="uc-sub">${escapeHtml(c.sub)}</div></div>`).join('');

  // —— 近 7 天双轴柱图(Token / 费用) ——
  const rows7 = usageRangeRows(g, 7);
  const dayTok = (v) => v ? (v.prompt || 0) + (v.completion || 0) : 0;
  const maxTok = Math.max(1, ...rows7.map((r) => dayTok(r.v)));
  const maxCost = Math.max(0.0001, ...rows7.map((r) => (r.v && r.v.cost) || 0));
  const cols = rows7.map((r) => {
    const tok = dayTok(r.v);
    const cost = (r.v && r.v.cost) || 0;
    const th = tok > 0 ? Math.max(2, (tok / maxTok) * 100) : 0;
    const ch = cost > 0 ? Math.max(2, (cost / maxCost) * 100) : 0;
    return `<div class="ud-col" title="${r.key}: ${fmtTok(tok)} tokens${cost > 0 ? ' / ' + fmtMoney(cost) : ''}">
      <div class="ud-bars"><div class="ud-bar tok" style="height:${th}%"></div><div class="ud-bar cost" style="height:${ch}%"></div></div>
      <div class="ud-col-date">${String(r.date.getMonth() + 1).padStart(2, '0')}-${String(r.date.getDate()).padStart(2, '0')}</div>
    </div>`;
  }).join('');
  const chart = `
    <div class="ud-chart-card">
      <div class="ud-card-title">近 7 天用量</div>
      <div class="ud-chart">
        <div class="ud-axis">${fmtTok(maxTok)}</div>
        <div class="ud-cols">${cols}</div>
        <div class="ud-axis">${maxCost >= 0.01 ? '¥' + maxCost.toFixed(2) : '¥' + maxCost.toFixed(4)}</div>
      </div>
      <div class="ud-chart-legend"><span><i class="ud-dot" style="background:#4d6bfe"></i>Token</span><span><i class="ud-dot" style="background:#16a34a"></i>费用(仅含可计价模型)</span></div>
    </div>`;

  // —— Token 构成环形图 ——
  const P = A.parts || {};
  const partItems = [
    ['system', '系统提示词'], ['tools', '工具定义'], ['user', '用户消息'], ['injected', '注入内容'],
    ['assistant', '助手消息'], ['toolResult', '工具结果'], ['output', '输出'],
  ].map(([k, label], i) => ({ label, value: P[k] || 0, color: USAGE_PALETTE[i] })).filter((x) => x.value > 0);
  const totalParts = partItems.reduce((s, x) => s + x.value, 0);
  const tokenCard = `
    <div class="ud-panel">
      <div class="ud-card-title">Token 统计</div>
      <div class="ud-donut-row">
        ${donutSvg(partItems, fmtTok(totalParts), '总用量')}
        <div class="ud-legend">${usageLegend(partItems, (x) => '≥' + fmtTok(x.value), null)}</div>
      </div>
    </div>`;

  // —— 耗时构成环形图 ——
  const T = A;
  const otherMs = Math.max(0, A.activeMs - (A.wait + A.think + A.output + A.toolMs));
  const timeItems = [
    { label: '模型等待', value: A.wait, color: '#4d6bfe', sub: `${fmtDur(A.wait)}` },
    { label: '模型思考', value: A.think, color: '#a855f7', sub: `${fmtDur(A.think)}` },
    { label: '模型输出', value: A.output, color: '#ec4899', sub: `${fmtDur(A.output)}` },
    { label: '工具执行', value: A.toolMs, color: '#f59e0b', sub: `${fmtDur(A.toolMs)} · ${A.toolCount}次` },
    { label: '其他开销', value: otherMs, color: '#94a3b8', sub: fmtDur(otherMs) },
  ].filter((x) => x.value > 0);
  const speed = A.tps && A.tps.ms > 0 ? Math.round(A.tps.tokens / (A.tps.ms / 1000)) : null;
  const timeCard = `
    <div class="ud-panel">
      <div class="ud-card-title">耗时统计<span class="ud-title-extra">输出速度 ${speed != null ? speed + ' tok/s' : '—'}</span></div>
      <div class="ud-donut-row">
        ${donutSvg(timeItems, fmtDur(A.activeMs), '活跃时长')}
        <div class="ud-legend">${usageLegend(timeItems, (x) => x.sub, null)}</div>
      </div>
    </div>`;

  // —— 活跃度热力图(近 15 周,按每日轮次) ——
  const weeks = 15;
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一=0
  const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (6 - dow));
  let maxReq = 1;
  const cellsData = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - (w * 7 + (6 - r)));
      const k = dayKeyOf(d);
      const v = (g.daily && g.daily[k] && g.daily[k].requests) || 0;
      maxReq = Math.max(maxReq, v);
      col.push({ d, k, v, future: d > today });
    }
    cellsData.push(col);
  }
  const heatLevel = (v) => v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / maxReq) * 4));
  const heatCols = cellsData.map((col) => `<div class="ud-heat-col">${col.map((c) => `<div class="ud-heat-cell lv${heatLevel(c.v)}${c.future ? ' future' : ''}" title="${c.k}${c.v ? ': ' + c.v + ' 轮' : ''}"></div>`).join('')}</div>`).join('');
  const monthLabels = (() => {
    let out = '';
    let lastM = -1;
    for (let w = 0; w < weeks; w++) {
      const m = cellsData[w][0].d.getMonth();
      if (m !== lastM) { out += `<span class="ud-heat-month">${m + 1}月</span>`; lastM = m; }
      else out += '<span class="ud-heat-month"></span>';
    }
    return out;
  })();
  const heatCard = `
    <div class="ud-panel">
      <div class="ud-card-title">活跃度<span class="ud-title-extra">按每日轮次</span></div>
      <div class="ud-heat">
        <div class="ud-heat-months">${monthLabels}</div>
        <div class="ud-heat-grid">
          <div class="ud-heat-days"><span>一</span><span>三</span><span>五</span></div>
          <div class="ud-heat-cols">${heatCols}</div>
        </div>
        <div class="ud-heat-legend">少 <i class="ud-heat-cell lv0"></i><i class="ud-heat-cell lv1"></i><i class="ud-heat-cell lv2"></i><i class="ud-heat-cell lv3"></i><i class="ud-heat-cell lv4"></i> 多</div>
      </div>
    </div>`;

  // —— 会话检索卡 ——
  const groups = (state.config.groups || []);
  const groupName = (gid) => (groups.find((x) => x.id === gid) || {}).name || '默认分组';
  const chips = [['all', `全部 ${convs.length}`]].concat(groups.map((gr) => {
    const n = convs.filter((c) => (c.groupId || 'default') === gr.id).length;
    return [gr.id, `${gr.name} ${n}`];
  }));
  drawUsageDashboard.renderConvList = () => {
    const listWrap = $('#ud-conv-cards', body);
    if (!listWrap) return;
    const q = usageConvQ.trim().toLowerCase();
    let rows = convs.filter((c) => (usageGroup === 'all' || (c.groupId || 'default') === usageGroup)
      && (!q || String(c.title || '').toLowerCase().includes(q)));
    const tokOf = (c) => (c.usage ? (c.usage.prompt || 0) + (c.usage.completion || 0) : 0);
    rows.sort((a, b) => usageSort === 'tokens' ? tokOf(b) - tokOf(a)
      : usageSort === 'requests' ? ((b.usage && b.usage.requests) || 0) - ((a.usage && a.usage.requests) || 0)
      : (b.updatedAt || 0) - (a.updatedAt || 0));
    listWrap.innerHTML = rows.slice(0, 60).map((c) => `
      <div class="ud-conv" data-id="${c.id}">
        <div class="ud-conv-top"><span class="ud-conv-title">${escapeHtml(c.title || '未命名对话')}</span><span class="ud-conv-time">${timeAgo(c.updatedAt)}<i>${new Date(c.updatedAt || Date.now()).toLocaleDateString('zh-CN')}</i></span></div>
        <div class="ud-conv-meta"><span class="ud-conv-group">${escapeHtml(groupName(c.groupId))}</span>${c.usage && c.usage.requests ? `<span>${c.usage.requests} 轮 · ${fmtTok(c.usage.prompt)}↑/${fmtTok(c.usage.completion)}↓</span>` : '<span>无用量记录</span>'}${c.ctx && c.ctx.tokens ? `<span>ctx ~${fmtTok(c.ctx.tokens)}</span>` : ''}</div>
      </div>`).join('') || '<div class="hint" style="padding:10px">没有匹配的会话</div>';
    $$('.ud-conv', listWrap).forEach((el) => el.addEventListener('click', () => {
      closeSettings();
      openConv(el.dataset.id);
    }));
  };
  const convCard = `
    <div class="ud-panel ud-conv-panel">
      <div class="ud-card-title">会话 ${convs.length}<span class="ud-title-extra"><input id="ud-conv-q" type="text" placeholder="搜索标题…" value="${escapeHtml(usageConvQ)}"></span></div>
      <div class="ud-sort">
        ${[['updated', '最近更新'], ['tokens', 'Token'], ['requests', '用量']].map(([k, l]) => `<button class="ud-tab ${usageSort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}
      </div>
      <div class="ud-chips">${chips.map(([id, label]) => `<button class="ud-chip ${usageGroup === id ? 'on' : ''}" data-g="${id}">${escapeHtml(label)}</button>`).join('')}</div>
      <div id="ud-conv-cards" class="ud-conv-cards"></div>
    </div>`;

  body.innerHTML = `
    <div class="ud-wrap">
      <div class="ud-head">
        <div class="ud-title">用量洞察</div>
        <div class="ud-ranges">${RANGES.map(([k, l]) => `<button class="ud-range ${usageRange === k ? 'on' : ''}" data-r="${k}">${l}</button>`).join('')}</div>
      </div>
      <div class="ud-row ud-row-cards">
        <div class="ud-cards">${cards}</div>
        ${chart}
      </div>
      <div class="ud-row ud-row-2">
        ${tokenCard}
        ${timeCard}
      </div>
      <div class="ud-row ud-row-3">
        ${heatCard}
        ${convCard}
      </div>
      <div class="ud-foot">
        <button class="btn" id="us-conv-reset" ${state.conv && state.conv.usage ? '' : 'disabled'}>重置当前会话</button>
        <button class="btn danger" id="us-reset">重置全部用量</button>
        <span class="hint" style="font-size:11.5px">优先使用服务商返回的真实 token 数,部分本地模型按字符估算(~ 前缀);费用按 models.dev 价目估算(能力库→在线更新可刷新价目),无价模型不计入;每日分布/耗时分解/费用自 v0.29 起积累。</span>
      </div>
    </div>`;

  // —— 事件 ——
  $$('.ud-range', body).forEach((b) => b.addEventListener('click', () => { usageRange = b.dataset.r; drawUsageDashboard(); }));
  drawUsageDashboard.renderConvList();
  const q = $('#ud-conv-q', body);
  if (q) {
    q.addEventListener('input', () => { usageConvQ = q.value; drawUsageDashboard.renderConvList(); });
    q.addEventListener('keydown', (e) => e.stopPropagation());
  }
  $$('.ud-tab', body).forEach((b) => b.addEventListener('click', () => { usageSort = b.dataset.sort; drawUsageDashboard(); }));
  $$('.ud-chip', body).forEach((b) => b.addEventListener('click', () => { usageGroup = b.dataset.g; drawUsageDashboard(); }));

  $('#us-reset', body).addEventListener('click', async () => {
    if (!confirm('清零全部用量统计(含每日分布与洞察数据)?')) return;
    state.config = await liteapi.invoke('config:set', { usage: { prompt: 0, completion: 0, requests: 0, cached: 0, cost: 0, activeMs: 0, byModel: {}, tools: { count: 0, ms: 0 }, times: { wait: 0, think: 0, output: 0 }, tps: { tokens: 0, ms: 0 }, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 }, daily: {} } });
    rerenderSettings();
    renderUsageBar();
    toast('全部用量已重置');
  });
  $('#us-conv-reset', body).addEventListener('click', async () => {
    if (!state.conv) return;
    if (!confirm('重置当前会话的用量统计?')) return;
    await liteapi.invoke('convs:resetUsage', state.conv.id);
    state.conv.usage = { prompt: 0, completion: 0, requests: 0 };
    rerenderSettings();
    renderUsageBar();
    toast('当前会话用量已重置');
  });
}

/* ---- 智能体 tab ---- */
function renderAgentCorePane(root) {
  const R = root || $('#modal-body');
  const a = state.config.agent;
  R.innerHTML = `
    <div class="agent-settings">
      <div class="field" style="margin-bottom:4px">
        <label>模式说明(顶栏可切换)</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          💬 <b>对话模式</b>:纯聊天,不调用任何工具<br>
          🔒 <b>受限模式</b>:只读工具(浏览/读文件/抓网页),不能改系统<br>
          ⚡ <b>完全模式</b>:全部工具 + MCP/DSH 插件,完全授权自动执行<br>
          🎨 <b>创造模式</b>:完全授权 + 可创建/修改自己的助手角色与技能
        </div>
      </div>
      <div class="setting-row">
        <div>
          <div class="label">全局工作目录</div>
          <div class="desc">未绑定文件夹的分组使用它;工具的相对路径基于当前分组或此目录解析</div>
        </div>
        <div class="ws-row">
          <input type="text" id="ag-ws" value="${escapeHtml(a.workspace)}" readonly>
          <button class="btn" id="ag-ws-pick">浏览</button>
        </div>
      </div>
      <div class="setting-row">
        <div>
          <div class="label">工具循环上限</div>
          <div class="desc">一次任务中最多连续调用工具的次数</div>
        </div>
        <input type="number" id="ag-iters" min="1" max="50" value="${a.maxIters}">
      </div>
      <div class="setting-row">
        <div>
          <div class="label">命令超时(秒)</div>
          <div class="desc">超时后强制结束命令进程(完全/创造模式)</div>
        </div>
        <input type="number" id="ag-timeout" min="5" max="1800" value="${a.shellTimeout}">
      </div>
    </div>`;

  $('#ag-ws-pick').addEventListener('click', async () => {
    const dir = await liteapi.invoke('dialog:pickWorkspace');
    if (dir) {
      state.config = await liteapi.invoke('config:set', { agent: { workspace: dir } });
      $('#ag-ws').value = dir;
    }
  });
  $('#ag-iters').addEventListener('change', (e) => liteapi.invoke('config:set', { agent: { maxIters: Math.max(1, parseInt(e.target.value, 10) || 20) } }));
  $('#ag-timeout').addEventListener('change', (e) => liteapi.invoke('config:set', { agent: { shellTimeout: Math.max(5, parseInt(e.target.value, 10) || 120) } }));
}

/* ---- 常规 tab(v0.40:语言 / 硬件加速 / 通知 / 托盘 / 保持唤醒 / 数据与缓存路径) ---- */
function renderGeneralPane() {
  const c = state.config.chat;
  const g = state.config.general || {};
  const zh = isZhLang();
  const tun = JSON.parse(JSON.stringify((state.config.remote || {}).tunnel || { mode: 'off', frp: {}, et: {} }));
  const frp = tun.frp || {};
  const et = tun.et || {};
  const tunPath = tun.mode === 'easytier' ? (et.path || t('默认:数据目录 tunnels/easytier/easytier-core.exe')) : (frp.path || t('默认:数据目录 tunnels/frp/frpc.exe'));
  $('#modal-body').innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="setting-row">
        <div><div class="label">${t('语言')}</div><div class="desc">${t('界面语言(部分深层文案暂仍为简体中文,逐步补齐)')}</div></div>
        <select id="ge-lang">
          <option value="zh-CN" ${(g.language || 'zh-CN') === 'zh-CN' ? 'selected' : ''}>简体中文</option>
          <option value="zh-TW" ${g.language === 'zh-TW' ? 'selected' : ''}>繁體中文</option>
          <option value="en" ${g.language === 'en' ? 'selected' : ''}>English</option>
          <option value="ja" ${g.language === 'ja' ? 'selected' : ''}>日本語</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('硬件加速')}</div><div class="desc">${t('使用 GPU 渲染界面;遇到花屏/渲染异常或省电时可关闭(重启应用生效)')}</div></div>
        <input type="checkbox" id="ge-hwaccel" ${g.hardwareAccel !== false ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('任务通知')}</div><div class="desc">${t('回复完成或出错、且窗口不在前台时弹系统通知')}</div></div>
        <input type="checkbox" id="ge-notify" ${g.taskNotify !== false ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('声音通知')}</div><div class="desc">${t('系统通知附带提示音')}</div></div>
        <input type="checkbox" id="ge-sound" ${g.soundNotify !== false ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('关闭窗口时隐藏到托盘')}</div><div class="desc">${t('点击 ✕ 不退出应用,最小化到系统托盘;托盘图标右键可退出')}</div></div>
        <input type="checkbox" id="ge-tray" ${g.closeToTray ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('保持电脑运行')}</div><div class="desc">${t('阻止系统休眠与息屏(长任务挂机时使用;会增加耗电)')}</div></div>
        <input type="checkbox" id="ge-awake" ${g.keepAwake ? 'checked' : ''}>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('温度 temperature')}</div><div class="desc">${t('越高越发散,0.7 适合日常对话')}</div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" id="ge-temp" min="0" max="2" step="0.1" value="${c.temperature}">
          <span class="temp-val" id="ge-temp-val">${c.temperature}</span>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('携带历史条数与上下文压缩')}</div><div class="desc">${t('已移至「上下文」页签(含摘要压缩策略)')}</div></div>
        <span style="font-size:12px;color:var(--text-3)">${t('→ 上下文')}</span>
      </div>
      <div class="setting-row" style="align-items:flex-start">
        <div style="flex:1;min-width:0"><div class="label">${t('数据存储')}</div><div class="desc">${t('配置、会话与插件等全部数据的存放目录')}<br><span id="ge-datapath" style="font-family:Consolas,monospace;word-break:break-all"></span></div></div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn" id="ge-data-open">${t('打开')}</button>
          <button class="btn" id="ge-data-change">${t('更改…')}</button>
          <button class="btn hidden" id="ge-data-reset"></button>
        </div>
      </div>
      <div class="setting-row" style="align-items:flex-start">
        <div style="flex:1;min-width:0"><div class="label">${t('缓存存储')}</div><div class="desc">${t('浏览器引擎缓存(图片/脚本等),可安全清除')}<br><span id="ge-cachepath" style="font-family:Consolas,monospace;word-break:break-all"></span></div></div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn" id="ge-cache-open">${t('打开')}</button>
          <button class="btn" id="ge-cache-clear">${t('清除缓存')}</button>
        </div>
      </div>
      <div class="setting-row" style="align-items:flex-start">
        <div style="flex:1;min-width:0"><div class="label">${t('远程控制(手机 / 平板)')}</div><div class="desc">${t('在局域网开放一个网页控制台:手机浏览器打开地址即可查看会话、发送消息、实时看到回复;仅限可信网络使用。令牌在开启时自动生成,泄露后可关闭再重新开启以重置')}</div></div>
        <input type="checkbox" id="ge-remote" ${(state.config.remote || {}).enabled ? 'checked' : ''}>
      </div>
      <div id="ge-remote-box" class="${(state.config.remote || {}).enabled ? '' : 'hidden'}" style="padding:0 0 6px">
        <div class="setting-row">
          <div><div class="label">${t('端口')}</div><div class="desc">${t('1024-65535;修改后立即重启服务')}</div></div>
          <input type="text" id="ge-remote-port" value="${(state.config.remote || {}).port || 8629}" style="width:110px">
        </div>
        <div class="setting-row">
          <div><div class="label">${t('允许远程审批')}</div><div class="desc">${t('开启后可在手机上批准 Agent 的工具执行请求;默认关闭(仅在主界面批准)')}</div></div>
          <input type="checkbox" id="ge-remote-approval" ${(state.config.remote || {}).allowApproval ? 'checked' : ''}>
        </div>
        <div class="setting-row" style="align-items:flex-start">
          <div style="flex:1;min-width:0"><div class="label">${t('访问地址(含令牌)')}</div><div class="desc" style="word-break:break-all"><span id="ge-remote-url" style="font-family:Consolas,monospace;font-size:12px"></span></div></div>
          <button class="btn" id="ge-remote-copy" style="flex-shrink:0">${t('复制')}</button>
        </div>
        <div class="setting-row">
          <div><div class="label">${t('出网隧道')}</div><div class="desc">${t('出门在外也能访问:FRP = 用你自己的 frps 服务器做端口映射;EasyTier = 虚拟组网(托管官方公共服务器打洞,无需公网 IP)')}</div></div>
          <select id="ge-tunnel-mode">
            <option value="off" ${tun.mode === 'off' ? 'selected' : ''}>${t('不开隧道(仅局域网)')}</option>
            <option value="frp" ${tun.mode === 'frp' ? 'selected' : ''}>FRP(自有服务器)</option>
            <option value="easytier" ${tun.mode === 'easytier' ? 'selected' : ''}>EasyTier 虚拟组网</option>
          </select>
        </div>
        <div id="ge-tunnel-frp" class="${tun.mode === 'frp' ? '' : 'hidden'}" style="padding:0 0 6px">
          <div class="setting-row"><div><div class="label">frps 服务器地址</div><div class="desc">${t('你自己的 frps 所在 IP 或域名')}</div></div><input type="text" id="ge-tp-frp-addr" value="${escapeHtml(frp.serverAddr || '')}" style="width:220px"></div>
          <div class="setting-row"><div><div class="label">${t('frps 端口 / 鉴权令牌')}</div><div class="desc">${t('与 frps 服务端配置一致(bindPort / auth.token)')}</div></div><div style="display:flex;gap:6px"><input type="text" id="ge-tp-frp-sport" value="${frp.serverPort || 7000}" style="width:90px"><input type="text" id="ge-tp-frp-token" value="${escapeHtml(frp.authToken || '')}" style="width:120px" placeholder="token"></div></div>
          <div class="setting-row"><div><div class="label">${t('公网访问端口(remotePort)')}</div><div class="desc">${t('手机通过 服务器地址:此端口 访问')}</div></div><input type="text" id="ge-tp-frp-rport" value="${frp.remotePort || 18629}" style="width:110px"></div>
        </div>
        <div id="ge-tunnel-et" class="${tun.mode === 'easytier' ? '' : 'hidden'}" style="padding:0 0 6px">
          <div class="setting-row"><div><div class="label">${t('网络名称 / 密钥')}</div><div class="desc">${t('手机端 EasyTier 也加入同一名称与密钥的网络,才能互相访问')}</div></div><div style="display:flex;gap:6px"><input type="text" id="ge-tp-et-name" value="${escapeHtml(et.name || '')}" placeholder="network-name" style="width:110px"><input type="text" id="ge-tp-et-secret" value="${escapeHtml(et.secret || '')}" placeholder="secret" style="width:110px"></div></div>
          <div class="setting-row"><div><div class="label">${t('公共服务器')}</div><div class="desc">${t('默认官方公共服务器;也可填自建节点(如 tcp://ip:11010)')}</div></div><input type="text" id="ge-tp-et-server" value="${escapeHtml(et.server || 'tcp://public.easytier.top:11010')}" style="width:220px"></div>
        </div>
        <div class="setting-row" style="align-items:flex-start">
          <div style="flex:1;min-width:0"><div class="label">${t('隧道程序')}</div><div class="desc" style="word-break:break-all"><span id="ge-tunnel-path" style="font-family:Consolas,monospace;font-size:11.5px"></span></div></div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-direction:column">
            <button class="btn" id="ge-tunnel-dl">${tun.mode === 'easytier' ? t('下载 easytier-core') : t('下载 frpc')}</button>
            <button class="btn" id="ge-tunnel-apply">${t('保存并应用')}</button>
          </div>
        </div>
        <div class="setting-row" style="align-items:flex-start">
          <div style="flex:1;min-width:0"><div class="label">${t('隧道状态')}</div><div class="desc" style="word-break:break-all"><span id="ge-tunnel-status" style="font-family:Consolas,monospace;font-size:11.5px;white-space:pre-wrap"></span></div></div>
        </div>
      </div>
    </div>`;

  liteapi.invoke('general:paths').then((p) => {
    const d = $('#ge-datapath'); const k = $('#ge-cachepath');
    if (d) d.textContent = p.dataDir + (p.usingCustom ? (zh ? '(自定义)' : ' (custom)') : '');
    if (k) k.textContent = p.cacheDir;
    const reset = $('#ge-data-reset');
    if (reset && p.usingCustom) {
      reset.textContent = t('恢复默认');
      reset.classList.remove('hidden');
    }
  });

  $('#ge-lang').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { general: { language: e.target.value } });
    window.I18N.setLang(e.target.value);
    applyLanguageEverywhere();
  });

  const saveGeneral = (patch) => liteapi.invoke('config:set', { general: patch }).then((cfg) => { state.config = cfg; return cfg; });
  $('#ge-hwaccel').addEventListener('change', (e) => {
    saveGeneral({ hardwareAccel: e.target.checked });
    toast(t('重启应用后生效') + (e.target.checked ? '' : zh ? '(关闭后改用软件渲染)' : ' (software rendering)'));
  });
  $('#ge-notify').addEventListener('change', (e) => saveGeneral({ taskNotify: e.target.checked }));
  $('#ge-sound').addEventListener('change', (e) => saveGeneral({ soundNotify: e.target.checked }));
  $('#ge-tray').addEventListener('change', (e) => saveGeneral({ closeToTray: e.target.checked }).then(() => toast(e.target.checked ? t('已开启') : t('已关闭'))));
  $('#ge-awake').addEventListener('change', (e) => saveGeneral({ keepAwake: e.target.checked }));

  // 远程控制(v0.54.0):开关/端口/远程审批 → config:set { remote }(主进程实时启停服务,token 在开启时生成)
  const refreshRemoteBox = () => {
    const box = $('#ge-remote-box');
    if (box) box.classList.toggle('hidden', !((state.config.remote || {}).enabled));
    const u = $('#ge-remote-url');
    if (u) u.textContent = remoteUrlOf();
  };
  refreshRemoteBox();
  $('#ge-remote').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { remote: { enabled: e.target.checked } });
    refreshRemoteBox();
    if (e.target.checked) {
      const url = remoteUrlOf();
      toast(t('远程控制已开启:用手机浏览器打开地址(需同一局域网)'));
      refreshRemoteBox();
    } else toast(t('远程控制已关闭'));
  });
  $('#ge-remote-port').addEventListener('change', async (e) => {
    const port = Math.min(65535, Math.max(1024, parseInt(e.target.value, 10) || 8629));
    e.target.value = port;
    state.config = await liteapi.invoke('config:set', { remote: { port } });
    refreshRemoteBox();
    toast(t('端口已更新,服务已重启'));
  });
  $('#ge-remote-approval').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { remote: { allowApproval: e.target.checked } });
    toast(e.target.checked ? t('远程审批已开启:手机上可批准工具执行') : t('远程审批已关闭(仅主界面批准)'));
  });
  $('#ge-remote-copy').addEventListener('click', () => {
    const url = remoteUrlOf();
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => toast(t('已复制访问地址'))).catch(() => {});
  });

  // 出网隧道(v0.54.0):FRP(自有 frps)/ EasyTier(虚拟组网);字段保存即应用(config:set 钩子启停)
  const saveTunnel = async (patch) => {
    const cur = JSON.parse(JSON.stringify((state.config.remote || {}).tunnel || { mode: 'off', frp: {}, et: {} }));
    for (const k of Object.keys(patch)) {
      if (k === 'mode') cur.mode = patch.mode;
      else cur[k] = { ...(cur[k] || {}), ...patch[k] };
    }
    state.config = await liteapi.invoke('config:set', { remote: { tunnel: cur } });
  };
  $('#ge-tunnel-mode').addEventListener('change', async (e) => {
    await saveTunnel({ mode: e.target.value });
    rerenderSettings();
  });
  const bindTunnelField = (id, build) => {
    const elx = $(id);
    if (elx) elx.addEventListener('change', () => saveTunnel(build(elx.value.trim())));
  };
  bindTunnelField('#ge-tp-frp-addr', (v) => ({ frp: { serverAddr: v } }));
  bindTunnelField('#ge-tp-frp-sport', (v) => ({ frp: { serverPort: parseInt(v, 10) || 7000 } }));
  bindTunnelField('#ge-tp-frp-token', (v) => ({ frp: { authToken: v } }));
  bindTunnelField('#ge-tp-frp-rport', (v) => ({ frp: { remotePort: parseInt(v, 10) || 18629 } }));
  bindTunnelField('#ge-tp-et-name', (v) => ({ et: { name: v } }));
  bindTunnelField('#ge-tp-et-secret', (v) => ({ et: { secret: v } }));
  bindTunnelField('#ge-tp-et-server', (v) => ({ et: { server: v } }));
  $('#ge-tunnel-dl').addEventListener('click', async () => {
    const btn = $('#ge-tunnel-dl');
    btn.disabled = true;
    btn.textContent = t('下载中…(走代理,GitHub 不通时请手动下载)');
    try {
      const r = await liteapi.invoke('remote:tunnel-action', { action: 'download', mode: tun.mode === 'easytier' ? 'easytier' : 'frp' });
      if (r && r.ok) { toast(t('下载完成,已放置到数据目录 tunnels 子目录')); await liteapi.invoke('remote:tunnel-action', { action: 'restart' }); }
      else toast((r && r.error) || t('下载失败'));
    } catch (e) { toast(String(e.message || e).slice(0, 160)); }
    rerenderSettings();
  });
  $('#ge-tunnel-apply').addEventListener('click', async () => {
    await saveTunnel({
      frp: { serverAddr: $('#ge-tp-frp-addr').value.trim(), serverPort: parseInt($('#ge-tp-frp-sport').value, 10) || 7000, authToken: $('#ge-tp-frp-token').value.trim(), remotePort: parseInt($('#ge-tp-frp-rport').value, 10) || 18629 },
      et: { name: $('#ge-tp-et-name').value.trim(), secret: $('#ge-tp-et-secret').value.trim(), server: $('#ge-tp-et-server').value.trim() },
    });
    await liteapi.invoke('remote:tunnel-action', { action: 'restart' });
    toast(t('隧道配置已应用'));
    refreshRemoteBox();
  });
  // 隧道状态轮询(pane 活跃期间)
  const tunnelStatusTick = async () => {
    const elx = $('#ge-tunnel-status');
    if (!elx) return;
    try {
      const st = await liteapi.invoke('remote:tunnel-status');
      const lines = [];
      lines.push(`FRP: ${st.frp.running ? t('运行中') : t('未运行')}`);
      if (st.frp.log.length) lines.push('  ' + st.frp.log.slice(-2).join('\n  '));
      lines.push(`EasyTier: ${st.easytier.running ? t('运行中') : t('未运行')}${st.easytier.virtualIP ? ' · ' + st.easytier.virtualIP : ''}`);
      if (st.easytier.log.length) lines.push('  ' + st.easytier.log.slice(-2).join('\n  '));
      elx.textContent = lines.join('\n');
    } catch (_) { /* 忽略 */ }
  };
  if (window.__geTunnelTimer) clearInterval(window.__geTunnelTimer);
  tunnelStatusTick();
  window.__geTunnelTimer = setInterval(tunnelStatusTick, 3000);

  $('#ge-temp').addEventListener('input', (e) => { $('#ge-temp-val').textContent = e.target.value; });
  $('#ge-temp').addEventListener('change', (e) => liteapi.invoke('config:set', { chat: { temperature: parseFloat(e.target.value) } }));

  $('#ge-data-open').addEventListener('click', () => liteapi.invoke('general:openDataDir'));
  $('#ge-data-change').addEventListener('click', async () => {
    const dir = await liteapi.invoke('dialog:pickDir', zh ? '选择新的数据存储目录(重启后生效,现有数据会自动复制过去)' : 'Pick new data folder (restart required; data will be copied)');
    if (!dir) return;
    const r = await liteapi.invoke('general:setDataDir', dir);
    if (!r.ok) { toast(r.message || (zh ? '设置失败' : 'Failed')); return; }
    const relaunch = confirm((zh ? '数据目录已设置为:\n' : 'Data folder set to:\n') + r.dir + (zh ? '\n\n立即重启应用?' : '\n\nRestart now?'));
    if (relaunch) liteapi.invoke('app:relaunch');
    else toast(t('重启应用后生效'));
  });
  $('#ge-cache-open').addEventListener('click', () => liteapi.invoke('general:openCacheDir'));
  $('#ge-cache-clear').addEventListener('click', async () => {
    await liteapi.invoke('general:clearCache');
    toast(zh ? '缓存已清除' : 'Cache cleared');
  });
  $('#ge-data-reset').addEventListener('click', async () => {
    if (!confirm(zh ? '恢复默认数据目录?自定义目录中的数据会保留,重启应用后生效。' : 'Reset to default data folder? Data in the custom folder stays; restart required.')) return;
    await liteapi.invoke('general:resetDataDir');
    toast(t('重启应用后生效'));
  });
}

/* ---- 外观 tab(v0.40:主题 / 毛玻璃 / 背景图 / 透明化,自开发者页迁入) ---- */
function renderAppearancePane() {
  const ui = (state.config && state.config.ui) || {};
  const zh = isZhLang();
  const opVal = (ui.bgOpacity !== undefined && ui.bgOpacity !== null && ui.bgOpacity !== '') ? Math.max(0, Math.min(100, Number(ui.bgOpacity) || 0)) : 100; // 不透明度滑杆值(0 是合法值,未设置才默认 100)
  const codeColors = currentCodeColors();
  const codeTheme = codeThemeOf(codeColors);
  let codeThemeOpts = '';
  for (const p of CODE_COLOR_PRESETS) codeThemeOpts += `<option value="${p.id}" ${codeTheme === p.id ? 'selected' : ''}>${t(p.name)}</option>`;
  codeThemeOpts += `<option value="custom" ${codeTheme === 'custom' ? 'selected' : ''}>${t('自定义')}</option>`;
  $('#modal-body').innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="setting-row">
        <div><div class="label">${t('界面选择')}</div><div class="desc">${t('启动时默认进入的界面:精简 = 终端形态控制台(标题栏标签页多对话);两种形态随时可切换,此项只决定启动默认')}</div></div>
        <select id="ap-interface">
          <option value="regular" ${(ui.defaultInterface || 'regular') !== 'lite' ? 'selected' : ''}>${t('常规(完整界面)')}</option>
          <option value="lite" ${ui.defaultInterface === 'lite' ? 'selected' : ''}>${t('精简(终端控制台)')}</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('模型弹层样式')}</div><div class="desc">${t('点开模型选择时的布局:经典 = 供应商行 + 该供应商模型列表;分栏 = 左侧供应商清单(悬停预览模型)+ 右侧模型与思考强度')}</div></div>
        <select id="ap-popstyle">
          <option value="classic" ${(ui.modelPopStyle || 'classic') !== 'split' ? 'selected' : ''}>${t('经典')}</option>
          <option value="split" ${ui.modelPopStyle === 'split' ? 'selected' : ''}>${t('分栏(供应商在左,悬停预览)')}</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('主题')}</div><div class="desc">${t('浅色 / 深色')}</div></div>
        <select id="ap-theme">
          <option value="light" ${ui.theme !== 'dark' ? 'selected' : ''}>${t('浅色')}</option>
          <option value="dark" ${ui.theme === 'dark' ? 'selected' : ''}>${t('深色')}</option>
        </select>
      </div>
      <div class="setting-row" style="align-items:flex-start">
        <div><div class="label">${t('终端代码高亮配色')}</div><div class="desc">${t('代码卡片里标签 / 属性 / 字符串 / 注释的颜色;选预设或逐项自定义,即时生效')}</div></div>
        <div class="ap-code-box">
          <select id="ap-code-theme">${codeThemeOpts}</select>
          <div class="ap-code-grid" id="ap-code-grid">
            <label>${t('标签')} <input type="color" data-ck="tag" value="${codeColors.tag}"></label>
            <label>${t('属性')} <input type="color" data-ck="attr" value="${codeColors.attr}"></label>
            <label>${t('字符串')} <input type="color" data-ck="str" value="${codeColors.str}"></label>
            <label>${t('注释')} <input type="color" data-ck="com" value="${codeColors.com}"></label>
          </div>
          <button class="btn" id="ap-code-reset">${t('恢复默认')}</button>
        </div>
      </div>
      <div class="setting-row" style="display:block;padding-top:0">
        <pre class="at-code-body ap-code-preview" id="ap-code-preview"><code><span class="c-com">&lt;!-- 示例 --&gt;</span>
<span class="c-tag">&lt;div</span> <span class="c-attr">class</span>=<span class="c-str">"hero"</span><span class="c-tag">&gt;</span>Hello<span class="c-tag">&lt;/div&gt;</span></code></pre>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('毛玻璃效果')}</div><div class="desc">${t('0% 关闭;拉高即开启并调面板浓度与模糊')}(<b id="ap-glass-level-v">${Number(ui.glassLevel) || 0}%</b>)</div><div class="desc" style="color:var(--danger)">⚠ ${zh ? '拉高后会显著增加 GPU/CPU 占用(Windows 11 亚克力材质 + 界面模糊)' : 'Significantly increases GPU/CPU usage (Win11 acrylic material + blur)'}</div></div>
        <input type="range" id="ap-glass-level" min="0" max="100" step="1" value="${Number(ui.glassLevel) || 0}" style="width:180px">
      </div>
      <div class="setting-row">
        <div><div class="label">${t('背景图片')}</div><div class="desc" id="ap-bg-desc">${t('以自定义图片作为整个界面的背景')}(${ui.bgImage ? t('已设置') : t('未设置')})</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn" id="ap-bg-pick">${t('上传图片')}</button>
          <button class="btn" id="ap-bg-clear">${t('清除')}</button>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">${ui.bgImage ? t('背景图浓度') : t('不透明度')}</div><div class="desc" id="ap-op-desc">${ui.bgImage ? t('背景图显示浓度:0% 几乎看不见图,100% 最浓;界面本体保持正常(与透明度无关)') : t('100% 正常界面;往下拉渐透出桌面,0% 全透(需重启让窗口支持透明,浓度即时生效)')}(<b id="ap-bg-opacity-v">${opVal}%</b>)</div></div>
        <input type="range" id="ap-bg-opacity" min="0" max="100" step="1" value="${opVal}" style="width:180px">
      </div>
      ${ui.bgImage ? '' : (opVal <= 99 && !state.winTransCapable ? `<div class="hint" id="ap-trans-restart-hint" style="color:var(--warn);margin:-6px 0 8px">⚠ ${zh ? '本窗口启动时未开启透明,当前拖动只改变界面浓度;重启应用后窗口底层才真正透明' : 'Window was started without transparency; restart to make the window truly transparent'}</div>` : '')}
      <div class="setting-row">
        <div><div class="label">${t('背景图模糊度')}</div><div class="desc">${t('0% 清晰,100% 最朦胧;专用于模糊背景图片,不影响界面文字')}(<b id="ap-blur-level-v">${Number(ui.blurLevel) || 0}%</b>)</div></div>
        <input type="range" id="ap-blur-level" min="0" max="100" step="1" value="${Number(ui.blurLevel) || 0}" style="width:180px" ${ui.bgImage ? '' : 'disabled'}>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('字体增强')}</div><div class="desc">${t('浅色背景下加深并加重文字,避免浅色字看不见;两个作用域可独立开启')}</div></div>
        <div style="display:flex;gap:14px;align-items:center">
          <label class="switch"><input type="checkbox" id="ap-font-chat" ${ui.fontChat ? 'checked' : ''}><span class="switch-track"></span><span class="switch-label">${t('对话字体')}</span></label>
          <label class="switch"><input type="checkbox" id="ap-font-ui" ${ui.fontUi ? 'checked' : ''}><span class="switch-track"></span><span class="switch-label">${t('设置字体')}</span></label>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">${t('底部用量条样式')}</div><div class="desc">悬停或点击右侧圆环时弹出的明细样式:紧凑(已用/上限 + 三类构成)或 容量卡(上下文容量 + 分类占比 + 缓存命中率)</div></div>
        <select id="ap-ubstyle">
          <option value="compact" ${(ui.usageBarStyle || 'compact') === 'compact' ? 'selected' : ''}>${t('紧凑')}</option>
          <option value="detail" ${ui.usageBarStyle === 'detail' ? 'selected' : ''}>${t('详细(容量卡)')}</option>
        </select>
      </div>
      <div class="hint">${zh ? '毛玻璃立即生效(Windows 11);背景透明化在下次启动时生效。更多实验性外观选项见「开发者」页。' : 'Blur applies immediately (Win11); transparency applies after restart. See Developer tab for experimental options.'}</div>
    </div>`;

  const saveUi = (patch) => liteapi.invoke('config:set', { ui: patch }).then((cfg) => { state.config = cfg; applyUiMode(); });
  // 终端代码高亮配色:预设 / 逐项自定义 / 恢复默认
  const saveCodeColors = async (colors, themeId) => {
    state.config = await liteapi.invoke('config:set', { ui: { codeColors: colors } });
    applyCodeColors();
    const sel = $('#ap-code-theme');
    if (sel) sel.value = themeId || codeThemeOf(colors);
    for (const inp of $$('#ap-code-grid input[type=color]')) {
      if (colors[inp.dataset.ck]) inp.value = colors[inp.dataset.ck];
    }
  };
  $('#ap-code-theme').addEventListener('change', async (e) => {
    if (e.target.value === 'custom') return;
    const p = CODE_COLOR_PRESETS.find((x) => x.id === e.target.value);
    if (!p) return;
    await saveCodeColors({ ...p.colors }, p.id);
    toast('代码高亮配色:' + t(p.name));
  });
  for (const inp of $$('#ap-code-grid input[type=color]')) {
    inp.addEventListener('input', () => {
      const c = currentCodeColors();
      c[inp.dataset.ck] = inp.value;
      state.config.ui = state.config.ui || {};
      state.config.ui.codeColors = c; // 即时预览(change 时落盘)
      applyCodeColors();
      const sel = $('#ap-code-theme');
      if (sel) sel.value = 'custom';
    });
    inp.addEventListener('change', async () => {
      const c = currentCodeColors();
      c[inp.dataset.ck] = inp.value;
      await saveCodeColors(c, 'custom');
    });
  }
  $('#ap-code-reset').addEventListener('click', async () => {
    await saveCodeColors({ ...DEFAULT_CODE_COLORS }, 'default');
    toast('已恢复默认代码高亮配色');
  });
  $('#ap-interface').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { ui: { defaultInterface: e.target.value } });
    toast(e.target.value === 'lite' ? t('已保存:下次启动进入精简界面') : t('已保存:下次启动进入常规界面'));
  });
  $('#ap-popstyle').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { ui: { modelPopStyle: e.target.value } });
    toast(e.target.value === 'split' ? t('已保存:模型弹层分栏样式') : t('已保存:模型弹层经典样式'));
  });
  $('#ap-theme').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { ui: { theme: e.target.value } });
    applyTheme();
  });
  // 毛玻璃滑杆(v0.49.4 收敛):0=关;≥10 开。拖动即时预览,松手落盘(glassLevel + 派生 glass 标志)
  $('#ap-glass-level').addEventListener('input', (e) => {
    $('#ap-glass-level-v').textContent = e.target.value + '%';
    const gl = Number(e.target.value);
    state.config.ui.glassLevel = gl; // 预览:applyUiMode 读派生值
    applyUiMode();
    document.body.style.setProperty('--glass-a', String(Math.max(10, gl)));
    document.body.style.setProperty('--glass-blur', (4 + (Math.max(10, gl) - 10) / 90 * 16).toFixed(1) + 'px');
  });
  $('#ap-glass-level').addEventListener('change', (e) => saveUi({ glassLevel: Number(e.target.value), glass: Number(e.target.value) >= 10 }));
  // 背景图模糊度滑杆(v0.49.6):0~100 → 0~30px,拖动即时预览
  $('#ap-blur-level').addEventListener('input', (e) => {
    $('#ap-blur-level-v').textContent = e.target.value + '%';
    const bl = Number(e.target.value);
    document.body.style.setProperty('--bg-blur', (bl / 100 * 30).toFixed(1) + 'px');
    document.body.style.setProperty('--bg-blur-px', String(bl));
  });
  $('#ap-blur-level').addEventListener('change', (e) => saveUi({ blurLevel: Number(e.target.value) }));
  // 字体增强两作用域
  $('#ap-font-chat').addEventListener('change', (e) => saveUi({ fontChat: e.target.checked }).then(() => toast(e.target.checked ? t('已开启') : t('已关闭'))));
  $('#ap-font-ui').addEventListener('change', (e) => saveUi({ fontUi: e.target.checked }).then(() => toast(e.target.checked ? t('已开启') : t('已关闭'))));
  // 滑杆语义分流(v0.49.6 用户裁定):设了背景图 = 背景图浓度(界面本体保持实色);
  // 没设图 = 窗口不透明度(原语义)。一个滑杆两副面孔,按 ui.bgImage 是否存在切换。
  $('#ap-bg-opacity').addEventListener('input', (e) => {
    $('#ap-bg-opacity-v').textContent = e.target.value + '%';
    state.config.ui.bgOpacity = Number(e.target.value);
    applyUiMode();
  });
  $('#ap-bg-opacity').addEventListener('change', (e) => {
    const op = Number(e.target.value);
    const withBg = !!(state.config.ui && state.config.ui.bgImage);
    // 语义分流:有图 = 只调图浓度,不碰窗口透明;无图 = 原透明语义
    saveUi(withBg ? { bgOpacity: op } : { bgOpacity: op, transparent: op <= 99 }).then(() => {
      if (withBg) return;
      // 本窗口不支持透明时,首次拖进透明区间给常驻提示(重启后真透)
      if (op <= 99 && !state.winTransCapable && !$('#ap-trans-restart-hint')) {
        rerenderSettings();
      }
      if (op <= 99 && op > 0) toast(t('100% 恢复正常;拖动已即时生效,窗口全透效果需重启'));
    });
  });
  $('#ap-ubstyle').addEventListener('change', (e) => saveUi({ usageBarStyle: e.target.value }).then(() => { renderUsageBar(); toast(e.target.value === 'detail' ? t('已开启') : t('已关闭')) }));
  $('#ap-bg-pick').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (!file) return;
      if (file.size > 6 * 1024 * 1024) { toast(zh ? '背景图片最大 6MB' : 'Background image max 6MB'); return; }
      const reader = new FileReader();
      reader.onload = () => saveUi({ bgImage: String(reader.result) }).then(() => { rerenderSettings(); toast(zh ? '背景图片已应用' : 'Background applied'); });
      reader.onerror = () => toast(zh ? '图片读取失败' : 'Failed to read image');
      reader.readAsDataURL(file);
    });
    inp.click();
  });
  $('#ap-bg-clear').addEventListener('click', () => saveUi({ bgImage: '' }).then(() => { rerenderSettings(); toast(zh ? '背景图片已清除' : 'Background cleared'); }));
}

/* ================= 右侧面板(v0.35:辅助对话 / 审查 / 终端 / 浏览器) ================= */
const panelState = { open: false, tab: null }; // tab=null = 启动页「打开标签页」
const auxRuns = [];           // 子智能体运行:[{id, convId, name, model, status, text, ms, t}] 新的在前
const panelReview = { pending: new Map(), log: [] }; // 待审批(toolCallId → {streamId,name,brief,since}) / 工具调用记录

// 右侧面板:页面级分栏(主界面缩左半,面板占右半),打开先见「打开标签页」启动页
const PANEL_TABS = [['aux', '💬', '辅助对话'], ['review', '📋', '审查'], ['branch', '🌳', '分支管理'], ['term', '⌨', '终端'], ['web', '🌐', '浏览器'], ['blender', '🎬', 'Blender 视口']];
const PANEL_VIEW_TITLE = { aux: '辅助对话', review: '审查', branch: '分支管理', term: '终端', web: '浏览器', blender: 'Blender 视口' };
// Blender 视口标签按需显示(config.blender.viewportPanel,默认关)
function panelTabsVisible() {
  const on = !!(state.config.blender && state.config.blender.viewportPanel);
  return PANEL_TABS.filter(([k]) => k !== 'blender' || on);
}

function ensurePanel() {
  if ($('#side-panel')) return;
  const el = document.createElement('div');
  el.id = 'side-panel';
  el.className = 'hidden';
  el.innerHTML = `
    <div class="sp-head">
      <button type="button" class="sp-back hidden" data-i18n-title="返回标签页" title="返回标签页">‹</button>
      <span class="sp-title" id="sp-title">打开标签页</span>
      <button type="button" class="sp-close" data-i18n-title="收起面板" title="收起面板">✕</button>
    </div>
    <div id="sp-body" class="sp-body"></div>`;
  $('#app').appendChild(el); // #app 的第三个 flex 子项:打开时主界面自动缩到左半
  $('.sp-back', el).addEventListener('click', () => setPanelTab(null));
  $('.sp-close', el).addEventListener('click', () => togglePanel(false));
  mountSplitters(); // 面板左缘拖拽条(面板刚创建,这里补挂)
  renderPanel();
}

function panelWebHide() { liteapi.invoke('panelweb:hide').catch(() => {}); }

function renderPanel() {
  const el = $('#side-panel');
  if (!el) return;
  const back = $('.sp-back', el);
  back.classList.toggle('hidden', !panelState.tab);
  $('#sp-title', el).textContent = panelState.tab ? t(PANEL_VIEW_TITLE[panelState.tab]) : t('打开标签页');
  const body = $('#sp-body');
  body.className = 'sp-body'; // 各视图自加修饰类
  if (panelState.tab === 'aux') { drawPanelAux(body); return; }
  if (panelState.tab === 'review') { drawPanelReview(body); return; }
  if (panelState.tab === 'branch') { drawPanelBranch(body); return; }
  if (panelState.tab === 'term') { drawPanelTerm(body); return; }
  if (panelState.tab === 'web') { drawPanelWeb(body); return; }
  if (panelState.tab === 'blender' && state.config.blender && state.config.blender.viewportPanel) { drawPanelBlender(body); return; }
  drawPanelLauncher(body);
}

function drawPanelLauncher(body) {
  body.className = 'sp-body sp-launcher';
  body.innerHTML = `
    <div class="sp-launch-title">${t('打开标签页')}</div>
    <div class="sp-launch-sub">${t('选择要在侧边面板中打开的标签。')}</div>
    ${panelTabsVisible().map(([k, ico, label]) => `<button type="button" class="sp-launch-item" data-t="${k}"><span class="sp-launch-ico">${ico}</span>${t(label)}</button>`).join('')}`;
  $$('.sp-launch-item', body).forEach((b) => b.addEventListener('click', () => setPanelTab(b.dataset.t)));
}

function togglePanel(force) {
  const target = force != null ? !!force : !panelState.open;
  if (target === panelState.open && $('#side-panel')) return;
  panelState.open = target;
  document.getElementById('app').classList.toggle('panel-open', target); // 面板打开:收起左侧会话栏,主界面与面板各占一半
  ensurePanel();
  const el = $('#side-panel');
  el.classList.toggle('hidden', !target);
  $('#btn-panel').classList.toggle('on', target);
  if (target) {
    panelState.tab = null; // 每次打开回到「打开标签页」启动页(⌨ 入口随后直落终端)
    renderPanel();
    syncPanelWebBounds();
  } else {
    if (panelState.tab === 'term') panelStashTerm();
    panelWebHide();
  }
}

/* —— 分支管理:当前对话的全部分支节点纵向树(Git graph 式;点击变体直达切换) —— */
function branchNodeSummary(m) {
  const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.content).join(' ').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 42 ? text.slice(0, 42) + '…' : text) : '(无文本回复)';
}
function drawPanelBranch(body) {
  body.className = 'sp-body sp-branch';
  const conv = state.conv;
  if (!conv || !(conv.messages || []).length) {
    body.innerHTML = `<div class="sp-launch-title">${t('分支管理')}</div><div class="sp-launch-sub">${t('当前还没有对话;发送第一条消息后,每轮 AI 回复的分支(重新生成/变体)都会在这里成树展示。')}</div>`;
    return;
  }
  let round = 0;
  let branchRounds = 0;
  let variantTotal = 0;
  let currentPos = 0; // nodeCard 闭包读取:当前渲染的卡片是否为激活分支
  const rows = [];
  (conv.messages || []).forEach((m, idx) => {
    if (m.role === 'user') {
      round += 1;
      const q = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '(附件消息)';
      rows.push(`
        <div class="br-round">
          <span class="br-round-badge">R${round}</span>
          <div class="br-round-q">${escapeHtml(q.length > 64 ? q.slice(0, 64) + '…' : q)}</div>
        </div>`);
    } else if (m.role === 'assistant') {
      const variants = Array.isArray(m.variants) ? m.variants : [];
      const nodeMeta = (v) => [
        v.model ? `<span class="br-model">${escapeHtml(String(v.model).split('/').pop())}</span>` : '',
        Number.isFinite(v.durationMs) ? `<span>${fmtDurZh(v.durationMs)}</span>` : '',
      ].filter(Boolean).join('<span class="br-meta-sep">·</span>');
      const nodeCard = (v, i, total) => `
        <div class="br-node-top">
          <span class="br-dot"></span>
          <span class="br-text">${escapeHtml(branchNodeSummary(v))}</span>
          ${total > 1 ? `<span class="br-badge">${i + 1}/${total}</span>` : ''}
          ${i === currentPos ? '<span class="br-badge cur">✓ ' + t('当前') + '</span>' : '<span class="br-badge go">' + t('切换') + '</span>'}
        </div>
        ${nodeMeta(v) ? `<div class="br-node-meta">${nodeMeta(v)}</div>` : ''}`;
      if (variants.length) {
        branchRounds += 1;
        variantTotal += variants.length + 1;
        const pos = Number.isInteger(m.pos) ? m.pos : variants.length;
        const seq = variants.slice();
        seq.splice(Math.min(pos, seq.length), 0, m);
        rows.push(`<div class="br-group">` + seq.map((v, i) => {
          currentPos = i;
          return `<div class="br-node${i === pos ? ' on' : ''}" data-idx="${idx}" data-to="${i}">${nodeCard(v, i, seq.length)}</div>`;
        }).join('') + '</div>');
      } else {
        currentPos = 0;
        rows.push(`<div class="br-node single">${nodeCard(m, 0, 1)}</div>`);
      }
    }
  });
  body.innerHTML = `
    <div class="br-head">
      <b>${t('分支地图')}</b>
      <span class="br-stat">${round} ${t('轮')} · ${branchRounds} ${t('个分支点')} · ${variantTotal} ${t('个变体')}</span>
    </div>
    <div class="br-tree">${rows.join('')}</div>`;
  $$('.br-node[data-to]', body).forEach((el) => el.addEventListener('click', async () => {
    if (el.classList.contains('on')) return;
    const c = await liteapi.invoke('conv:switchBranch', {
      convId: conv.id,
      index: parseInt(el.dataset.idx, 10),
      dir: 1,
      to: parseInt(el.dataset.to, 10),
    });
    if (c) {
      state.conv = c;
      renderConv(c);
      drawPanelBranch(body);
    }
  }));
}

/* —— Blender 视口(1.1.0 视口面板等价物):实时帧轮询 + 点击画面选物体 + 加入对话 —— */
let pvPickObj = null;
function drawPanelBlender(body) {
  body.className = 'sp-body sp-blender';
  const bl = state.config.blender || {};
  const port = Number(bl.httpPort) || 9877;
  body.innerHTML = `
    <div class="pv-frame" id="pv-frame">
      <img id="pv-img" alt="Blender viewport" draggable="false">
      <div class="pv-placeholder" id="pv-ph">…</div>
    </div>
    <div class="pv-status" id="pv-status"></div>
    <div class="pv-tools">
      <span class="pv-picked" id="pv-picked"></span>
      <span style="flex:1"></span>
      <button type="button" class="btn" id="pv-reshoot">${t('重拍')}</button>
      <button type="button" class="btn pv-join" id="pv-join" disabled>${t('加入对话')}</button>
    </div>
    <div class="pv-hint">${t('点击画面选中物体(需要 Blender 已连接);画面每 1.5 秒自动刷新。')}</div>`;
  const img = $('#pv-img', body);
  const ph = $('#pv-ph', body);
  const statusEl = $('#pv-status', body);
  const pickedEl = $('#pv-picked', body);
  const joinBtn = $('#pv-join', body);
  // 双缓冲拉帧:预载完成才换 src(不闪);img 标签不受 CORS 限制,直连后端
  const pull = () => {
    if (!document.getElementById('pv-img')) { clearInterval(window.__pvTimer); window.__pvTimer = null; return; }
    if (!(state.config.blender || {}).enabled) { ph.textContent = t('Blender 工具链未启用(设置 → Agent → Blender)'); ph.classList.remove('hidden'); return; }
    const im = new Image();
    im.onload = () => {
      if (!document.getElementById('pv-img')) return;
      img.src = im.src;
      ph.classList.add('hidden');
      statusEl.textContent = '';
    };
    im.onerror = () => {
      if (!document.getElementById('pv-img')) return;
      ph.textContent = t('取帧失败:后端未运行或 Blender 未连接');
      ph.classList.remove('hidden');
    };
    im.src = `http://127.0.0.1:${port}/frame.png?size=760&t=${Date.now()}`;
  };
  if (window.__pvTimer) clearInterval(window.__pvTimer);
  pull();
  window.__pvTimer = setInterval(pull, 1500);
  // 点击选物:归一化坐标 → blender:pick(raycast)→ 选中并显示
  img.addEventListener('click', async (e) => {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    pickedEl.textContent = t('选取中…');
    try {
      const res = await liteapi.invoke('blender:pick', { x, y });
      if (res && res.ok) {
        pvPickObj = res.object;
        pickedEl.textContent = '🎯 ' + String(res.object);
        joinBtn.disabled = false;
      } else {
        pvPickObj = null;
        joinBtn.disabled = true;
        pickedEl.textContent = res && res.error ? String(res.error) : t('未命中');
      }
    } catch (err) {
      pickedEl.textContent = String(err.message || err);
    }
  });
  $('#pv-reshoot', body).addEventListener('click', () => { pull(); });
  joinBtn.addEventListener('click', () => {
    if (!pvPickObj) return;
    liteapi.invoke('blender:insert', { text: `(Blender 选中:${pvPickObj}) ` });
    toast(t('已加入对话输入框(未发送)'));
  });
}

function setPanelTab(tab) {
  // 离开终端/浏览器/Blender 视口标签时先收编(终端 DOM 退持有容器 / 浏览器视图隐藏 / 视口轮询停)
  if (panelState.tab === 'term' && tab !== 'term') panelStashTerm();
  if (panelState.tab === 'web' && tab !== 'web') panelWebHide();
  if (panelState.tab === 'blender' && tab !== 'blender' && window.__pvTimer) { clearInterval(window.__pvTimer); window.__pvTimer = null; }
  panelState.tab = tab;
  renderPanel();
  syncPanelWebBounds();
}

/* —— 辅助对话:子智能体运行流(每个子智能体一个子标签,逐个查看) —— */
const auxLive = new Map(); // toolCallId → {statusEl, textEl} 当前选中视图的实时元素
let auxSelectedRunId = null;
function panelAuxStatusText(st) {
  return st === 'running' ? t('● 运行中') : st === 'done' ? t('✓ 完成') : st === 'error' ? t('✕ 出错') : t('■ 已停止');
}
function panelAuxEvent(ev) {
  if (ev.index == null) return; // 只收子智能体事件
  let run = auxRuns.find((r) => r.id === ev.toolCallId);
  const isNew = !run;
  const prevStatus = run && run.status;
  if (isNew) {
    run = { id: ev.toolCallId, convId: ev.convId || '', name: ev.name || '子智能体', model: ev.model || '', status: 'running', text: '', ms: 0, t: Date.now() };
    auxRuns.unshift(run);
    if (auxRuns.length > 30) auxRuns.pop();
    if (panelState.tab === 'aux') auxSelectedRunId = run.id; // 新派发自动切到新队员
  }
  run.name = ev.name || run.name;
  run.model = ev.model || run.model;
  run.status = ev.status || run.status;
  if (ev.convId) run.convId = ev.convId;
  if (ev.ms) run.ms = ev.ms;
  if (ev.text) run.text = ev.text;
  // 顶栏子智能体入口:新派发/状态变化时重绘列表(文字增量不重建 DOM,避免闪烁)
  renderSubagentPill(isNew || run.status !== prevStatus);
  if (panelState.open && panelState.tab === 'aux') {
    if (isNew) { drawPanelAux($('#sp-body')); return; }
    const live = auxLive.get(run.id);
    if (run.id === auxSelectedRunId && live) {
      if (live.statusEl) {
        live.statusEl.textContent = panelAuxStatusText(run.status);
        live.statusEl.className = `sp-aux-status st-${run.status}`;
      }
      if (ev.text && live.textEl) live.textEl.textContent = ev.text;
      if (live.tabDot) live.tabDot.className = run.status === 'running' ? 'sp-dot-run' : 'sp-dot-idle';
    }
  }
}

function drawPanelAux(body) {
  if (!auxRuns.find((r) => r.id === auxSelectedRunId)) {
    auxSelectedRunId = auxRuns.length ? auxRuns[0].id : null;
  }
  const sel = auxRuns.find((r) => r.id === auxSelectedRunId) || null;
  body.innerHTML = `
    <div class="sp-toolbar"><span class="sp-hint">${t('子智能体运行(独立上下文 · 新→旧)')}</span><button class="sp-act" id="sp-aux-clear">${t('清空')}</button></div>
    ${auxRuns.length > 1 ? `<div class="sp-subtabs" id="sp-aux-tabs">${auxRuns.map((r) => `<button type="button" class="sp-subtab ${r.id === auxSelectedRunId ? 'on' : ''}" data-id="${r.id}"><span>${escapeHtml(r.name)}</span><i class="${r.status === 'running' ? 'sp-dot-run' : 'sp-dot-idle'}"></i></button>`).join('')}</div>` : ''}
    <div class="sp-scroll" id="sp-aux-list">${sel ? '' : `<div class="hint" style="padding:12px">${t('暂无子智能体运行 —— 主智能体派发任务后会实时显示在这里。')}</div>`}</div>`;
  $('#sp-aux-clear', body).addEventListener('click', () => { auxRuns.length = 0; auxSelectedRunId = null; auxLive.clear(); drawPanelAux(body); renderSubagentPill(true); });
  $$('.sp-subtab', body).forEach((b) => b.addEventListener('click', () => { auxSelectedRunId = b.dataset.id; drawPanelAux(body); }));
  auxLive.clear();
  if (!sel) return;
  const list = $('#sp-aux-list', body);
  const sec = document.createElement('div');
  sec.className = 'sp-aux-run';
  sec.innerHTML = `<div class="sp-aux-div"><span class="sp-aux-name">🔀 ${escapeHtml(sel.name)}</span><span class="sp-aux-meta">${escapeHtml(sel.model || '')}</span><span class="sp-aux-status st-${sel.status}">${panelAuxStatusText(sel.status)}</span></div>`;
  const pre = document.createElement('pre');
  pre.className = 'sp-aux-text';
  pre.textContent = sel.text || t('(等待输出…)');
  sec.appendChild(pre);
  list.appendChild(sec);
  auxLive.set(sel.id, {
    statusEl: sec.querySelector('.sp-aux-status'),
    textEl: pre,
    tabDot: auxRuns.length > 1 ? document.querySelector(`#sp-aux-tabs .sp-subtab[data-id="${sel.id}"] i`) : null,
  });
}

/* —— 顶栏中部子智能体入口(v0.55.4):本对话派发的子智能体 + 状态,点条目直达面板运行流 —— */
function subagentRunsForConv() {
  const cid = state.conv && state.conv.id;
  return cid ? auxRuns.filter((r) => r.convId === cid) : [];
}
function subagentStatusText(st) {
  return st === 'running' ? t('运行中') : st === 'done' ? t('完成') : st === 'error' ? t('出错') : t('已停止');
}
function renderSubagentPill(structural) {
  const pill = $('#subagent-pill');
  if (!pill) return;
  const runs = subagentRunsForConv();
  const running = runs.filter((r) => r.status === 'running').length;
  pill.classList.toggle('on', runs.length > 0);
  pill.dataset.count = String(runs.length);
  const cnt = $('#subagent-count');
  if (cnt) { cnt.textContent = String(runs.length); cnt.classList.toggle('hidden', runs.length === 0); }
  const dot = $('#subagent-dot');
  if (dot) { dot.classList.toggle('hidden', running === 0); dot.classList.toggle('run', running > 0); }
  pill.title = runs.length
    ? `${t('子智能体')} ${runs.length}${running ? ' · ' + running + ' ' + t('运行中') : ''}`
    : t('子智能体(本对话派发的运行状态)');
  const pop = $('#subagent-pop');
  if (pop && !pop.classList.contains('hidden') && structural) renderSubagentPop();
}
function renderSubagentPop() {
  const list = $('#subagent-run-list');
  if (!list) return;
  const runs = subagentRunsForConv();
  const running = runs.filter((r) => r.status === 'running').length;
  const sum = $('#subagent-sum');
  if (sum) sum.textContent = runs.length ? `${runs.length} ${t('个子智能体')}${running ? ' · ' + running + ' ' + t('运行中') : ''}` : '';
  if (!runs.length) {
    list.innerHTML = `<div class="sa-empty"><b>${t('没有子智能体')}</b>${t('主智能体派发任务后会出现在这里')}</div>`;
    return;
  }
  list.innerHTML = runs.map((r) => {
    const ico = r.status === 'running' ? '⏳' : r.status === 'done' ? '✓' : r.status === 'error' ? '✕' : '■';
    const dur = r.ms ? ' · ' + fmtDurZh(r.ms) : '';
    return `<button type="button" class="sa-row" data-id="${escapeHtml(r.id)}"><span class="sa-ico">${ico}</span><span class="sa-name">${escapeHtml(r.name || '子智能体')}</span><span class="sa-model">${escapeHtml(r.model || '')}</span><span class="sa-st ${r.status}">${subagentStatusText(r.status)}${dur}</span></button>`;
  }).join('');
  $$('.sa-row', list).forEach((b) => b.addEventListener('click', () => openSubagentRun(b.dataset.id)));
}
function toggleSubagentPop(force) {
  const pop = $('#subagent-pop');
  if (!pop) return;
  const show = force != null ? !!force : pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !show);
  if (show) renderSubagentPop();
}
function openSubagentRun(id) {
  if (!auxRuns.some((r) => r.id === id)) return;
  auxSelectedRunId = id;
  togglePanel(true);
  setPanelTab('aux');
  toggleSubagentPop(false);
  toast(t('已跳转到子智能体运行窗口'));
}

/* —— 审查:待审批 + 工具调用记录 —— */
function panelReviewEvent(ev) {
  if (ev.type === 'tool-start') {
    if (ev.status === 'awaiting') {
      const S = state.streams.get(ev.convId);
      panelReview.pending.set(ev.toolCallId, {
        streamId: (S && S.streamId) || '', name: ev.name || '', brief: toolBrief(ev.name, ev.args), since: Date.now(),
      });
    } else if (!panelReview.pending.has(ev.toolCallId)) {
      panelReview.log.unshift({ t: Date.now(), name: ev.name || '', brief: toolBrief(ev.name, ev.args), status: ev.status || 'running' });
      if (panelReview.log.length > 200) panelReview.log.pop();
    }
  } else if (ev.type === 'tool-end') {
    if (panelReview.pending.has(ev.toolCallId)) panelReview.pending.delete(ev.toolCallId);
    panelReview.log.unshift({ t: Date.now(), name: ev.name || '', brief: toolBrief(ev.name, ev.args), status: ev.status || 'done' });
    if (panelReview.log.length > 200) panelReview.log.pop();
  }
  if (panelState.open && panelState.tab === 'review') drawPanelReview($('#sp-body'));
}

function drawPanelReview(body) {
  const pending = [...panelReview.pending.values()];
  const timeStr = (t) => new Date(t).toLocaleTimeString('zh-CN');
  body.innerHTML = `
    <div class="sp-toolbar"><span class="sp-hint">${t('待批准')} ${pending.length} · ${t('记录')} ${panelReview.log.length}</span></div>
    <div class="sp-scroll">
      ${pending.length ? `<div class="sp-hint" style="padding:0 12px 6px">${t('等待你批准的工具调用:')}</div>` : ''}
      ${pending.map((p, i) => `
        <div class="sp-aux-card" data-pi="${i}">
          <div class="sp-aux-head"><b>${escapeHtml(p.name)}</b></div>
          <pre class="sp-aux-text" style="max-height:80px">${escapeHtml(p.brief || t('(无参数摘要)'))}</pre>
          <div style="display:flex;gap:6px;padding:0 10px 8px">
            <button class="btn primary sp-approve" data-pi="${i}">${t('批准')}</button>
            <button class="btn sp-reject" data-pi="${i}">${t('拒绝')}</button>
          </div>
        </div>`).join('')}
      <div class="sp-hint" style="padding:10px 12px 4px">${t('工具调用记录(新→旧):')}</div>
      ${panelReview.log.length ? panelReview.log.map((e) => `
        <div class="sp-log-row"><span class="sp-log-time">${timeStr(e.t)}</span><b>${escapeHtml(e.name)}</b><span class="sp-log-status st-${e.status}">${t(TOOL_STATE_TEXT[e.status] || e.status)}</span><span class="sp-log-brief">${escapeHtml(String(e.brief).slice(0, 60))}</span></div>`).join('') : `<div class="hint" style="padding:0 12px 10px">${t('暂无记录')}</div>`}
    </div>`;
  $$('.sp-approve', body).forEach((b) => b.addEventListener('click', () => {
    const p = pending[Number(b.dataset.pi)];
    if (!p) return;
    liteapi.invoke('tool:decision', { streamId: p.streamId, toolCallId: [...panelReview.pending.keys()][Number(b.dataset.pi)], approved: true });
    panelReview.pending.delete([...panelReview.pending.keys()][Number(b.dataset.pi)]);
    drawPanelReview(body);
    toast(t('已批准'));
  }));
  $$('.sp-reject', body).forEach((b) => b.addEventListener('click', () => {
    const keys = [...panelReview.pending.keys()];
    const p = pending[Number(b.dataset.pi)];
    if (!p) return;
    liteapi.invoke('tool:decision', { streamId: p.streamId, toolCallId: keys[Number(b.dataset.pi)], approved: false });
    panelReview.pending.delete(keys[Number(b.dataset.pi)]);
    drawPanelReview(body);
    toast(t('已拒绝'));
  }));
}

/* —— 终端:DOM 永久住在面板(termHolder ↔ #sp-body 之间移动)—— */
function drawPanelTerm(body) {
  const tp = termHolder.querySelector('#term-panel');
  if (!tp) return;
  body.classList.add('sp-term-host');
  body.innerHTML = '';
  body.appendChild(termHolder); // termHolder 里装着 #term-panel
  tp.classList.add('in-panel');
  tp.classList.remove('hidden');
  if (termOutBuf.s) { // 分离期间的输出回放
    const out = $('#term-out');
    if (out) out.textContent += termOutBuf.s;
    termOutBuf.s = '';
  }
  if (!state.termOpen) {
    state.termOpen = true;
    liteapi.invoke('term:write', '');
  }
  const inp = $('#term-input');
  if (inp) inp.focus();
}

// 终端 DOM 退回持有容器(脱离文档,shell 常驻不受影响)
function panelStashTerm() {
  const tp = termHolder.querySelector('#term-panel');
  if (tp) termHolder.appendChild(tp);
}

/* —— 浏览器:主进程 WebContentsView,多标签页管理(全关回到空态)—— */
const browserTabs = []; // {id, title, url}
let activeWebId = null;

function drawPanelWeb(body) {
  body.classList.add('sp-web-host');
  if (!browserTabs.length) {
    body.innerHTML = `
      <div class="sp-web-empty">
        <div class="sp-web-empty-t">所有标签页已关闭</div>
        <button class="btn" id="spw-new">打开新标签</button>
      </div>`;
    $('#spw-new', body).addEventListener('click', () => { newWebTab(); });
    panelWebHide();
    return;
  }
  if (!browserTabs.find((t) => t.id === activeWebId)) activeWebId = browserTabs[0].id;
  const at = browserTabs.find((t) => t.id === activeWebId);
  body.innerHTML = `
    <div class="sp-web-tabs" id="spw-tabs">
      ${browserTabs.map((t) => `
        <div class="sp-web-tab ${t.id === activeWebId ? 'on' : ''}" data-id="${t.id}" title="${escapeHtml(t.url || t.title || '')}">
          <span class="sp-web-tab-title">${escapeHtml(t.title || '新标签页')}</span>
          <span class="sp-web-tab-x" data-x="${t.id}" title="关闭标签页">×</span>
        </div>`).join('')}
      <button type="button" class="sp-web-new" id="spw-newtab" title="新建标签页">＋</button>
    </div>
    <div class="sp-web-bar">
      <button class="sp-btn" id="spw-back" title="后退">←</button>
      <button class="sp-btn" id="spw-fwd" title="前进">→</button>
      <button class="sp-btn" id="spw-reload" title="重新加载">⟳</button>
      <input id="spw-url" type="text" placeholder="输入网址,Enter 打开" spellcheck="false" value="${escapeHtml(at.url || '')}">
      <button class="sp-btn" id="spw-go" title="打开">前往</button>
      <span class="sp-hint" id="spw-status"></span>
    </div>
    ${at.ptrLock ? `<div class="spw-ptrbar" id="spw-ptrbar">🎮 ${escapeHtml(t('该页面会锁定鼠标(游戏视角):按 Esc 释放;被反复重新锁定时,快速连按两次 Esc 强制解除'))}</div>` : ''}
    <div id="sp-web-host"></div>`;
  const go = () => {
    let v = $('#spw-url', body).value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v) && /\./.test(v)) v = 'https://' + v;
    $('#spw-status', body).textContent = '加载中…';
    at.url = v;
    liteapi.invoke('panelweb:navigate', { tabId: at.id, url: v }).then((r) => {
      if (r && r.ok === false) toast(`打开失败:${r.error || '未知错误'}`);
    }).catch(() => {});
  };
  $('#spw-go', body).addEventListener('click', go);
  $('#spw-url', body).addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
  $('#spw-back', body).addEventListener('click', () => liteapi.invoke('panelweb:back', { tabId: at.id }).catch(() => {}));
  $('#spw-fwd', body).addEventListener('click', () => liteapi.invoke('panelweb:fwd', { tabId: at.id }).catch(() => {}));
  $('#spw-reload', body).addEventListener('click', () => liteapi.invoke('panelweb:reload', { tabId: at.id }).catch(() => {}));
  $$('.sp-web-tab', body).forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.classList.contains('sp-web-tab-x')) return;
    activeWebId = el.dataset.id;
    drawPanelWeb(body); // 切换:重渲标签条 + 挂载对应视图
  }));
  $$('.sp-web-tab-x', body).forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    closeWebTab(el.dataset.x);
  }));
  $('#spw-newtab', body).addEventListener('click', () => { newWebTab(); });
  syncPanelWebBounds();
}

function newWebTab() {
  const id = 'w' + Date.now().toString(36);
  browserTabs.push({ id, title: '新标签页', url: '' });
  activeWebId = id;
  drawPanelWeb($('#sp-body'));
  $('#spw-url').focus();
}

// 在面板浏览器打开 URL(AI 生成的 HTML 内部预览入口;自动开面板并落 web 标签)
// v0.54.21:打开前先过 panelweb:precheck —— 含 Pointer Lock 的页面挂黄色提示条(Esc 释放/双击 Esc 强制解除)
function openInPanelBrowser(url) {
  const id = 'w' + Date.now().toString(36);
  browserTabs.push({ id, title: '', url });
  activeWebId = id;
  togglePanel(true);
  setPanelTab('web');
  liteapi.invoke('panelweb:precheck', { url }).then((r) => {
    if (r && r.lock) {
      const tab = browserTabs.find((x) => x.id === id);
      if (tab) tab.ptrLock = true;
      if (panelState.tab === 'web') drawPanelWeb($('#sp-body'));
      toast(t('该页面会锁定鼠标(FPS 游戏视角):按 Esc 释放;若被反复重新锁定,快速连按两次 Esc 强制解除'));
    }
  }).catch(() => {});
  liteapi.invoke('panelweb:navigate', { tabId: id, url }).then((r) => {
    if (r && r.ok === false) toast(t('打开失败') + ': ' + (r.error || ''));
  }).catch((e) => toast(t('打开失败') + ': ' + (e && e.message)));
}
function localFileUrl(p) {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function closeWebTab(id) {
  liteapi.invoke('panelweb:closeTab', { tabId: id }).catch(() => {});
  const i = browserTabs.findIndex((t) => t.id === id);
  if (i !== -1) browserTabs.splice(i, 1);
  if (activeWebId === id) activeWebId = browserTabs.length ? browserTabs[Math.max(0, i - 1)].id : null;
  drawPanelWeb($('#sp-body'));
}

function syncPanelWebBounds() {
  if (panelState.tab !== 'web' || panelState.open !== true || !browserTabs.length) return;
  const host = $('#sp-web-host');
  if (!host) return;
  const r = host.getBoundingClientRect();
  // 左侧留出拖拽条槽位(原生 View 会盖住 DOM,不留槽拖拽条抓不到)
  liteapi.invoke('panelweb:setBounds', { tabId: activeWebId, rect: { x: r.left + VIEW_GUTTER, y: r.top, width: Math.max(0, r.width - VIEW_GUTTER), height: r.height } }).catch(() => {});
}

// 面板浏览器事件:按 tabId 路由(标题/地址入数据,活动标签同步状态条)
// Blender 选中桥(v0.55.0):Blender N 面板「发送选中到 DSH」→ 主进程轮询 → 插入输入框(不自动发送)
// insert-text = 控制台窗口的搜索/选中「插入到输入框」按钮(同一路径)
liteapi.onBlenderEvent((ev) => {
  if (ev.type === 'insert-text' && ev.text) {
    const target = document.body.classList.contains('pure-terminal') ? $('#at-input') : $('#input');
    if (target) { target.value += ev.text; target.focus(); }
    return;
  }
  if (ev.type !== 'selection' || !Array.isArray(ev.names) || !ev.names.length) return;
  const head = `(选中${ev.total > ev.names.length ? ' ' + ev.total + ' 个对象,前 ' + ev.names.length + ' 个' : ''}: ${ev.names.join(', ')}) `;
  const target = document.body.classList.contains('pure-terminal') ? $('#at-input') : $('#input');
  if (!target) return;
  target.value = head + target.value;
  target.focus();
  toast(t('Blender 选中已同步到输入框(未发送)'));
});

// 面板浏览器事件:按 tabId 路由(标题/地址入数据,活动标签同步状态条)
liteapi.onPanelWebEvent((ev) => {
  const t = browserTabs.find((x) => x.id === ev.tabId);
  if (ev.type === 'ptr-unlocked') { // 双击 Esc 强制解除成功(v0.54.21)
    toast(t('已强制解除鼠标锁定(该页面本次不再锁定)'));
    return;
  }
  if (ev.type === 'did-navigate' && t) t.url = ev.url;
  if (ev.type === 'title' && t && ev.title && t.title !== ev.title) {
    t.title = ev.title;
    if (panelState.tab === 'web' && panelState.open) drawPanelWeb($('#sp-body'));
  }
  if (ev.tabId === activeWebId && panelState.tab === 'web' && panelState.open) {
    if (ev.type === 'did-navigate') {
      const u = $('#spw-url');
      if (u && document.activeElement !== u) u.value = ev.url;
    }
    const st = $('#spw-status');
    if (st) st.textContent = ev.type === 'did-fail-load' ? `加载失败(${ev.code})` : (ev.type === 'did-finish-load' || ev.type === 'did-navigate') ? '完成' : st.textContent;
  }
});

/* ================= 对话内搜索 ================= */
// 浮动搜索条:在当前会话的消息文本里查找并高亮,Enter/Shift+Enter 在命中间跳转。
// 高亮直接包 <mark> 到渲染后的 DOM 文本节点上;任何重绘(renderConv/流式收尾)后由钩子重建。
const searchState = { open: false, query: '', marks: [], cur: 0, timer: 0, capped: false };
const SEARCH_MAX = 500;

function ensureSearchBar() {
  let bar = $('#search-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'search-bar';
  bar.className = 'hidden';
  bar.innerHTML = `
    <input id="search-input" type="text" placeholder="在当前对话中搜索…" spellcheck="false">
    <span id="search-count"></span>
    <button type="button" class="sb-btn" id="search-prev" title="上一个 (Shift+Enter)">↑</button>
    <button type="button" class="sb-btn" id="search-next" title="下一个 (Enter)">↓</button>
    <button type="button" class="sb-btn" id="search-close" title="关闭 (Esc)">✕</button>`;
  $('#main').appendChild(bar);
  const inp = $('#search-input', bar);
  inp.addEventListener('input', () => {
    searchState.query = inp.value;
    clearTimeout(searchState.timer);
    searchState.timer = setTimeout(() => applySearch({ reset: true }), 160);
  });
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); gotoSearchMatch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  $('#search-prev', bar).addEventListener('click', () => gotoSearchMatch(-1));
  $('#search-next', bar).addEventListener('click', () => gotoSearchMatch(1));
  $('#search-close', bar).addEventListener('click', () => closeSearch());
  return bar;
}

function openSearch() {
  if (!state.conv) { toast('当前没有可搜索的对话'); return; }
  const bar = ensureSearchBar();
  bar.classList.remove('hidden');
  searchState.open = true;
  const inp = $('#search-input', bar);
  inp.focus();
  inp.select();
  applySearch({ reset: true });
}

function closeSearch() {
  searchState.open = false;
  searchState.query = '';
  clearTimeout(searchState.timer);
  clearSearchMarks();
  const bar = $('#search-bar');
  if (bar) bar.classList.add('hidden');
}

function clearSearchMarks() {
  for (const m of searchState.marks) {
    const p = m.parentNode;
    if (!p) continue;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  }
  searchState.marks = [];
}

// 只搜消息正文:排除按钮/代码头/工具卡片/用量行,以及上一次留下的 mark
function searchScopeAccept(node) {
  const p = node.parentElement;
  if (!p || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
  if (p.closest('mark.search-hit, button, .code-head, .tool-card, .turn-meta, #search-bar')) return NodeFilter.FILTER_REJECT;
  if (!p.closest('.msg') && !p.closest('body.md')) return NodeFilter.FILTER_REJECT; // body.md = 沙箱 iframe 文档
  return NodeFilter.FILTER_ACCEPT;
}

function updateSearchCount() {
  const el = $('#search-count');
  if (!el) return;
  if (!searchState.open || !searchState.query.trim()) { el.textContent = ''; return; }
  const n = searchState.marks.length;
  el.textContent = n === 0 ? '无结果' : `${searchState.cur + 1}/${n}${searchState.capped ? '+' : ''}`;
}

function applySearch(opts) {
  const reset = !!(opts && opts.reset);
  const keepCur = searchState.cur;
  clearSearchMarks();
  searchState.capped = false;
  const q = searchState.query.trim().toLowerCase();
  if (!searchState.open || !q) { searchState.cur = 0; updateSearchCount(); return; }

  const roots = [chatEl].concat($$('iframe.md-frame', chatEl)
    .map((f) => { try { return f.contentDocument && f.contentDocument.body; } catch (_) { return null; } })
    .filter(Boolean));
  const hits = [];
  for (const root of roots) {
    if (searchState.capped) break;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: searchScopeAccept });
    while (walker.nextNode()) {
      const lv = walker.currentNode.nodeValue.toLowerCase();
      let i = lv.indexOf(q);
      while (i !== -1) {
        hits.push({ node: walker.currentNode, start: i, len: q.length });
        if (hits.length >= SEARCH_MAX) { searchState.capped = true; break; }
        i = lv.indexOf(q, i + q.length);
      }
      if (searchState.capped) break;
    }
  }

  // 同一文本节点内的多个命中要倒序切割,否则后面的偏移会失效
  const marks = hits.map((h) => {
    const m = h.node.ownerDocument.createElement('mark'); // mark 须建于命中节点所属文档(沙箱 iframe)
    m.className = 'search-hit';
    return m;
  });
  for (let h = hits.length - 1; h >= 0; h--) {
    const { node, start, len } = hits[h];
    if (start + len < node.nodeValue.length) node.splitText(start + len);
    const mid = node.splitText(start);
    mid.parentNode.insertBefore(marks[h], mid);
    marks[h].appendChild(mid);
  }
  searchState.marks = marks.filter((m) => m.parentNode);
  searchState.cur = reset ? 0 : Math.min(keepCur, Math.max(0, searchState.marks.length - 1));
  updateSearchCount();
  revealSearchMatch(false);
}

function gotoSearchMatch(delta) {
  const n = searchState.marks.length;
  if (!n) return;
  searchState.cur = (searchState.cur + delta + n) % n;
  revealSearchMatch(true);
}

function revealSearchMatch(scroll) {
  const allHits = [chatEl].concat($$('iframe.md-frame', chatEl)
    .map((f) => { try { return f.contentDocument; } catch (_) { return null; } }).filter(Boolean));
  $$('.search-hit.cur', chatEl).forEach((m) => m.classList.remove('cur'));
  for (const doc of allHits) $$('.search-hit.cur', doc).forEach((m) => m.classList.remove('cur'));
  const m = searchState.marks[searchState.cur];
  if (m) {
    m.classList.add('cur');
    const det = m.closest('details');
    if (det && !det.open) det.open = true; // 命中在折叠的思考过程里:展开让用户看见
    if (scroll) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  updateSearchCount();
}

// 重绘后重建高亮(不改查询、不滚动、保持当前命中序号)
function refreshSearch() {
  if (!searchState.open || !searchState.query.trim()) return;
  applySearch({ reset: false });
}

/* ================= 输入框 ================= */
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

/* ================= 事件绑定 ================= */
function bindEvents() {
  $('#btn-new').addEventListener('click', openConvMenu);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-remote').addEventListener('click', openRemotePop); // v0.54.0 远程控制快捷入口(高频:开/关/复制地址一键直达)
  // v0.52.0 侧栏快捷菜单:搜索 / 连接桥 / 进入精简模式(新建任务沿用 #btn-new)
  $('#sm-search').addEventListener('click', () => {
    if (searchState.open) closeSearch();
    else openSearch();
  });
  $('#sm-bridge').addEventListener('click', openBridges); // v0.52.0 连接桥 = 独立页(设置抽屉之外)
  $('#sm-spec').addEventListener('click', openSpecPage); // 技能知识库 = 独立页(连接桥同款外壳,入口在其正下方)
  $('#sm-cron').addEventListener('click', openAutoTasks); // 自动任务 = 独立页(cron 定时执行)
  $('#sm-lite').addEventListener('click', enterLiteMode);
  $('#btn-sidebar-toggle').addEventListener('click', toggleSidebar); // v0.52.0 隐藏/还原侧栏
  // 会话列表头:🔍 过滤 + ☰ 分类方式(v0.52.0)
  $('#btn-gsearch').addEventListener('click', openGsearch);
  $('#btn-conv-filter').addEventListener('click', () => {
    const row = $('#conv-filter-row');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) $('#conv-filter').focus();
    else {
      convFilterText = '';
      $('#conv-filter').value = '';
      renderSidebar();
    }
  });
  $('#conv-filter').addEventListener('input', (e) => {
    convFilterText = e.target.value.trim();
    renderSidebar();
  });
  $('#btn-conv-view').addEventListener('click', openConvViewMenu);

  $('#btn-export').addEventListener('click', async () => {
    if (!state.conv) { toast('当前没有可导出的对话'); return; }
    const r = await liteapi.invoke('convs:export', state.conv.id);
    if (r && r.ok) toast('已导出到 ' + r.path);
  });

  // 右侧面板:辅助对话 / 审查 / 终端 / 浏览器
  $('#btn-panel').addEventListener('click', () => togglePanel());
  // 顶栏中部:子智能体入口(点外部/Esc 关闭弹层)
  const saPill = $('#subagent-pill');
  if (saPill) saPill.addEventListener('click', (e) => { e.stopPropagation(); toggleSubagentPop(); });
  document.addEventListener('click', (e) => {
    const combo = $('#subagent-combo');
    if (combo && !combo.contains(e.target)) toggleSubagentPop(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSubagentPop(false); });
  renderSubagentPill(true);

  // 对话内搜索:顶栏按钮开关 + Ctrl+F 聚焦
  $('#btn-search').addEventListener('click', () => {
    if (searchState.open) closeSearch();
    else openSearch();
  });

  // 侧边栏:分组头(折叠/重命名/文件夹/删除)+ 会话(选择/重命名/删除)
  $('#conv-list').addEventListener('click', async (e) => {
    const head = e.target.closest('.group-head');
    if (head) {
      const gid = head.dataset.gid;
      const gBtn = e.target.closest('button[data-gact]');
      const g = (state.config.groups || []).find((x) => x.id === gid);
      if (gBtn) {
        e.stopPropagation();
        if (gBtn.dataset.gact === 'new') { startConvInGroup(gid); return; } // 分组旁＋:直接在该分组新建任务
        if (gBtn.dataset.gact === 'rename') beginGroupRename(head, gid, g ? g.name : '');
        else if (gBtn.dataset.gact === 'folder') {
          const dir = await liteapi.invoke('dialog:pickWorkspace', `设置「${g ? g.name : gid}」的工作文件夹`);
          if (dir && g) {
            state.config = await liteapi.invoke('groups:upsert', { ...g, workspace: dir });
            toast(`「${g.name}」工作文件夹:${dir}`);
            updateStatusHint();
          }
        } else if (gBtn.dataset.gact === 'delete') {
          const n = state.convs.filter((c) => (c.groupId || 'default') === gid).length;
          if (!confirm(`删除分组「${g ? g.name : gid}」?其中 ${n} 个会话将移入「默认分组」。`)) return;
          state.config = await liteapi.invoke('groups:delete', gid);
          renderSidebar();
          toast('分组已删除,会话已移入默认分组');
        }
        return;
      }
      // 折叠/展开
      if (state.collapsedGroups.has(gid)) state.collapsedGroups.delete(gid);
      else state.collapsedGroups.add(gid);
      renderSidebar();
      return;
    }

    const item = e.target.closest('.conv-item');
    if (!item) return;
    const id = item.dataset.id;
    const actBtn = e.target.closest('button[data-act]');
    if (actBtn) {
      e.stopPropagation();
      const convMeta = state.convs.find((c) => c.id === id);
      if (actBtn.dataset.act === 'rename') beginRename(item, id, convMeta ? convMeta.title : '');
      else if (actBtn.dataset.act === 'copyid') {
        navigator.clipboard.writeText(id).then(() => toast(t('已复制对话 ID') + ': ' + id)).catch(() => toast(t('复制失败')));
      }
      else if (actBtn.dataset.act === 'delete') {
        if (state.streams.has(id)) { toast('该会话正在回复中,请先停止再删除'); return; }
        if (!confirm('确定删除这个对话?')) return;
        state.convs = await liteapi.invoke('convs:delete', id);
        if (state.conv && state.conv.id === id) { state.conv = null; renderChatEmpty(); renderSubagentPill(true); }
        renderSidebar();
      }
      return;
    }
    if (id !== (state.conv && state.conv.id)) openConv(id);
  });

  // 对话交接拖拽(v0.52.0):热区 = 聊天区 + 整个输入区(#chat + #composer)—— 提示条浮在对话框正上方,
  // 其覆盖位置在 #chat 内,若热区只有 composer,提示条处松手不触发(用户实测反馈),故全文档监听 + closest 判断
  // 分段读取设计:预填只有指针+预览,全文由 AI 用 read_conversation 工具按需分段读取,不塞全文
  $('#conv-list').addEventListener('dragstart', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item || e.target.closest('button')) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-liteagent-conv', item.dataset.id);
    const meta = state.convs.find((c) => c.id === item.dataset.id);
    e.dataTransfer.setData('text/plain', (meta ? meta.title : '') + ' #' + item.dataset.id);
  });
  // 放置提示条:拖拽会话期间浮在对话框正上方(挂 #composer 内,AGENTS 教训 #7 定位锚;pointer-events:none 不挡 drop)
  const handoverHint = document.createElement('div');
  handoverHint.id = 'handover-drop';
  handoverHint.className = 'hidden';
  handoverHint.textContent = t('松开,分段接手该对话(只传摘要,AI 按需读取全文)');
  $('#composer').appendChild(handoverHint);
  const hasConvDrag = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('application/x-liteagent-conv'));
  document.addEventListener('dragover', (e) => {
    if (!hasConvDrag(e)) return;
    const inZone = !!(e.target.closest && e.target.closest('#composer, #chat'));
    const hoBox = $('.composer-box');
    if (inZone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      handoverHint.textContent = t('松开,分段接手该对话(只传摘要,AI 按需读取全文)');
      handoverHint.classList.add('active');
      if (e.target.closest('#composer')) hoBox.classList.add('drag-conv');
      else hoBox.classList.remove('drag-conv');
    } else {
      handoverHint.classList.remove('active');
      hoBox.classList.remove('drag-conv');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) { // 拖出窗口
      handoverHint.classList.remove('active');
      const b = $('.composer-box');
      if (b) b.classList.remove('drag-conv');
    }
  });
  document.addEventListener('drop', (e) => {
    handoverHint.classList.remove('active');
    const hoBox = $('.composer-box');
    if (hoBox) hoBox.classList.remove('drag-conv');
    const hid = e.dataTransfer && e.dataTransfer.getData('application/x-liteagent-conv');
    if (!hid) return; // 文件拖拽走全局 drop(附件)
    if (!(e.target.closest && e.target.closest('#composer, #chat'))) return; // 热区外松手:不接手
    e.preventDefault();
    e.stopPropagation();
    prefillHandover(hid);
  });
  document.addEventListener('dragend', () => {
    handoverHint.classList.remove('active');
    const b = $('.composer-box');
    if (b) b.classList.remove('drag-conv');
  });

  // 模型搜索下拉
  $('#mc-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleModelPop(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#model-combo')) closeModelPop(); });
  // 供应商选择行(v0.54.2):点击展开清单;清单内选供应商 / 管理模型入口
  const provBtn = $('#mp-prov-btn');
  if (provBtn) provBtn.addEventListener('click', () => {
    state.mpProvView = !state.mpProvView;
    renderProviderList();
    if (state.mpProvView) renderModelList();
  });
  const manageBtn = $('#mp-manage');
  if (manageBtn) manageBtn.addEventListener('click', () => {
    closeModelPop();
    openSettings();
    settingsTab = 'providers';
    renderSettingsContent();
  });
  $('#mc-search').addEventListener('input', renderModelList);
  $('#mc-search').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const first = $('#mc-list .mc-item');
      if (first) { applyModelChoice(first.dataset.p, first.dataset.m); closeModelPop(); }
    } else if (e.key === 'Escape') {
      closeModelPop();
    }
  });
  // 助手 / 模式 / 技能
  $('#assistant-select').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { ui: { activeAssistantId: e.target.value } });
    const a = currentAssistant();
    updateStatusHint();
    toast(`已切换助手:${a.name}(对之后的回复生效)`);
  });
  $('#mode-select').addEventListener('change', async (e) => {
    state.config = await liteapi.invoke('config:set', { ui: { mode: e.target.value } });
    toast(MODE_DESC[e.target.value] || '已切换模式');
    updateStatusHint();
  });
  // 推理强度滑块的事件在 fillReasonSelect 渲染组件时自行绑定
  $('#skill-bar').addEventListener('click', (e) => {
    const chip = e.target.closest('.skill-chip');
    if (chip) toggleSkill(chip.dataset.id);
  });

  // 输入框
  const input = $('#input');
  // 斜杠命令弹层(v0.51.2):输入 / 呼出,↑↓选择,回车执行;/img 等命令在普通输入框也可用
  const slashPop = document.createElement('div');
  slashPop.id = 'input-slash-pop';
  slashPop.className = 'input-slash-pop hidden';
  const slashComposerBox = input.closest('.composer-box') || input.parentElement;
  slashComposerBox.appendChild(slashPop);
  let slashIdx = -1;
  const slashMatches = () => {
    const v = input.value;
    if (!v.startsWith('/') || v.includes(' ') || v.length > 24) return [];
    return SLASH_COMMANDS.filter((c) => c.scope !== 'term' && c.cmd.startsWith(v.toLowerCase()));
  };
  const renderSlashPop = () => {
    const hits = slashMatches();
    if (!hits.length) { slashPop.classList.add('hidden'); slashIdx = -1; return; }
    slashPop.classList.remove('hidden');
    slashPop.innerHTML = hits.map((c, i) => `<div class="at-slash-item ${i === slashIdx ? 'on' : ''}" data-cmd="${c.cmd}"><b>${c.cmd}</b><span>${escapeHtml(c.desc)}</span></div>`).join('');
    $$('.at-slash-item', slashPop).forEach((el) => el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = el.dataset.cmd + ' ';
      input.focus();
      closeInputSlashPop();
    }));
  };
  const closeInputSlashPop = () => { slashPop.classList.add('hidden'); slashIdx = -1; };
  input.addEventListener('input', () => {
    autosize(input);
    updateSkillBarVisibility(); // @ 呼出技能栏(v0.49.6:默认隐藏)
    slashIdx = -1;
    renderSlashPop();
  });
  input.addEventListener('keydown', (e) => {
    const hits = slashMatches();
    if (hits.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      slashIdx = e.key === 'ArrowUp' ? (slashIdx <= 0 ? hits.length - 1 : slashIdx - 1) : (slashIdx >= hits.length - 1 ? 0 : slashIdx + 1);
      renderSlashPop();
      return;
    }
    if (hits.length && e.key === 'Tab') {
      e.preventDefault();
      const pick = hits[slashIdx >= 0 ? slashIdx : 0];
      input.value = pick.cmd + ' ';
      closeInputSlashPop();
      return;
    }
    if (e.key === 'Escape' && hits.length) { closeInputSlashPop(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      closeInputSlashPop();
      submit();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!slashComposerBox.contains(document.activeElement)) closeInputSlashPop(); }, 120)); // 点击外部关闭
  window.addEventListener('resize', closeInputSlashPop);
  input.addEventListener('paste', (e) => {
    // 剪贴板里有文件(如截图)时加为附件;纯文本仍走默认插入
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) addAttachFiles(files);
    // 稍等插入完成后自适应高度
    setTimeout(() => autosize(input), 0);
  });

  // 附件:📎 按钮 + 隐藏 file input + 拖拽 + 预览条移除
  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.accept = ATTACH_ACCEPT;
  attachInput.style.display = 'none';
  document.body.appendChild(attachInput);
  $('#btn-attach').addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', () => {
    addAttachFiles(attachInput.files);
    attachInput.value = '';
  });
  $('#attach-bar').addEventListener('click', (e) => {
    const x = e.target.closest('.attach-remove');
    if (!x) return;
    state.pendingAttachments.splice(parseInt(x.dataset.idx, 10), 1);
    renderAttachBar();
  });
  const composerBox = $('.composer-box');
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
      e.preventDefault();
      if (document.body.classList.contains('pure-terminal')) {
        const hint = $('#at-drop-hint');
        if (hint) hint.classList.remove('hidden');
      } else {
        composerBox.classList.add('dragover');
      }
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) {
      composerBox.classList.remove('dragover');
      const hint = $('#at-drop-hint');
      if (hint) hint.classList.add('hidden');
    }
  });
  document.addEventListener('drop', (e) => {
    composerBox.classList.remove('dragover');
    const hint = $('#at-drop-hint');
    if (hint) hint.classList.add('hidden');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      e.preventDefault();
      addAttachFiles(files);
    }
  });

  // 图片灯箱:点击用户气泡里的缩略图全屏查看(openImageLightbox 为全局助手,沙箱 iframe 亦复用)
  const lightbox = document.createElement('div');
  lightbox.id = 'lightbox';
  lightbox.className = 'hidden';
  lightbox.innerHTML = '<img alt="">';
  document.body.appendChild(lightbox);
  lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

  $('#btn-send').addEventListener('click', () => {
    if (state.conv && state.streams.has(state.conv.id)) abortStreaming();
    else submit();
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openConvMenu(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      if (document.body.classList.contains('pure-terminal')) return;
      e.preventDefault();
      openGsearch(); // Ctrl+Shift+F:跨会话全局搜索
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      if (document.body.classList.contains('pure-terminal')) return; // 控制台接管时搜索条不可见
      e.preventDefault();
      if (searchState.open) { const i = $('#search-input'); i.focus(); i.select(); }
      else openSearch();
    }
    if (e.key === 'Escape') {
      if (gsState.open) { closeGsearch(); return; }
      if (searchState.open) closeSearch();
      else if (!$('#modal-root').classList.contains('hidden')) closeSettings();
      else closeConvMenu();
    }
  });

  const mp2Manage = $('#mp2-manage');
  if (mp2Manage) mp2Manage.addEventListener('click', () => {
    closeModelPop();
    openSettings();
    settingsTab = 'providers';
    renderSettingsContent();
  });
  const permPill = $('#perm-pill');
  if (permPill) permPill.addEventListener('click', () => togglePermPop());
  document.addEventListener('click', (e) => {
    const pop = $('#perm-pop');
    if (pop && !pop.classList.contains('hidden') && !e.target.closest('#perm-combo')) togglePermPop(false);
  });
  updatePermPill();
  const foldBtn = $('#composer-fold'); // v0.54.2 头行移除,元素不存在时守卫
  if (foldBtn) foldBtn.addEventListener('click', toggleComposerFold);
  const miniBtn = $('#composer-mini');
  if (miniBtn) miniBtn.addEventListener('click', toggleComposerFold);
  // 模型/推理/技能变化时刷新折叠摘要(模型选择在 applyModelChoice 内处理)

  // 聊天区事件委托:复制代码 / 链接 / 工具卡片展开收起
  chatEl.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.code-copy');
    if (copyBtn) {
      const pre = copyBtn.closest('.code-wrap').querySelector('pre');
      navigator.clipboard.writeText(pre.innerText).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
      });
      return;
    }
    const link = e.target.closest('a[href^="http"]');
    if (link) {
      e.preventDefault();
      liteapi.invoke('app:openExternal', link.href);
      return;
    }
    const toolHead = e.target.closest('.tool-head');
    if (toolHead) {
      toolHead.parentElement.classList.toggle('open');
      return;
    }
    const img = e.target.closest('img.attach-img');
    if (img) { openImageLightbox(img.src); return; }
  });
}

/* ================= 启动 ================= */
// 渲染端错误自动上报到调试日志(诊断接入口的一部分)
window.addEventListener('error', (e) => {
  liteapi.invoke('debug:report', {
    message: e.message || '未知错误',
    stack: e.error && e.error.stack,
    source: `${e.filename || ''}:${e.lineno || ''}`,
  }).catch(() => {});
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  liteapi.invoke('debug:report', {
    message: String((r && (r.message || r)) || '未处理的 Promise 拒绝'),
    stack: r && r.stack,
    source: 'unhandledrejection',
  }).catch(() => {});
});

async function boot() {
  state.config = await liteapi.invoke('config:get');
  state.appVersion = await liteapi.invoke('app:version').catch(() => '?');
  // 窗口透明支持快照(v0.49.5):启动时透明已开 = 本窗口支持真透明;没开 = 本会话内拖透明浓度只有
  // 界面层变化,窗口底层不透 —— 外观页据此提示「重启后完全生效」
  state.winTransCapable = !!((state.config.ui || {}).transparent) && !((state.config.ui || {}).powerSave);
  window.I18N.setLang((state.config.general || {}).language || 'zh-CN'); // 语言先于一切渲染
  console.error('[BOOT] 1 lang');
  applyChromeLang();
  applyTheme();
  console.error('[BOOT] 2 theme');
  applyUiMode();
  console.error('[BOOT] 3 uiMode');
  fillModeSelect();
  setSendMode('send');
  console.error('[BOOT] 4 mode');
  fillModelSelect();
  console.error('[BOOT] 5 model');
  fillAssistantSelect();
  renderSkillBar();
  console.error('[BOOT] 6 skills');
  applyComposerFold();
  await refreshConvs();
  console.error('[BOOT] 7 convs');
  bindEvents();
  console.error('[BOOT] 8 bind');
  mountSplitters(); // 侧栏/面板拖拽条(v0.44;面板未创建时面板条由 ensurePanel 补挂)
  initTerminalUI();
  console.error('[BOOT] 9 term');
  initTitlebar();
  console.error('[BOOT] 10 titlebar');
  console.error('[BOOT] 11 openConv begin');
  if (state.convs.length) await openConv(state.convs[0].id);
  else renderChatEmpty();
  console.error('[BOOT] 12 openConv done');
  $('#input').focus();
  console.error('[BOOT] 13 done');
  // 界面选择(v0.54.0):默认精简 —— 启动即进入终端控制台;用户 /exit 退出后本次会话保持完整界面,下次启动再进
  if (((state.config.ui || {}).defaultInterface) === 'lite' && !((state.config.ui || {}).pureTerminal)) {
    liteapi.invoke('config:set', { ui: { pureTerminal: true } })
      .then((c) => { state.config = c; applyUiMode(); })
      .catch(() => {});
  }
  window.__reasonDbg = () => ({ lm: state.config.lastModel, renderKey: state.reasonRenderKey, value: state.reasonValue, reasonChoice: state.config.reasonChoice, fold: !!state.config.ui.composerFold });
  guardGpuRender(); // 渲染自愈:强制核显合成在部分 Intel 核显驱动上会把窗口表面清成纯黑(字体糊边),检出即自动关闭
}

// 渲染自愈(v0.48.1):两种情况都会让 body 背景变纯黑(#chat 透明透出它)——
// ① 强制核显合成开启:检出 → 自动关闭该开关;② 其他来源(GPU 着色器缓存污染等):提示用诊断页「渲染修复」。
function guardGpuRender() {
  const ui = state.config.ui || {};
  if (ui.pureTerminal || ui.bgImage) return; // 纯终端/有背景图时黑系正常,跳过
  setTimeout(() => {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const expected = ui.theme === 'dark' ? 'rgb(33, 33, 33)' : 'rgb(255, 255, 255)';
      if (bg !== 'rgb(0, 0, 0)' || expected === 'rgb(0, 0, 0)') return;
      if (ui.forceLowPowerGpu) {
        liteapi.invoke('config:set', { ui: { forceLowPowerGpu: false } }).then((c) => {
          state.config = c;
          applyUiMode();
          toast('检测到「强制核显合成」与当前显卡驱动不兼容(画面发黑/字体发糊),已自动关闭 —— 重启应用后完全恢复');
        });
        liteapi.invoke('debug:report', { message: 'gpu-black-fallback: 自动关闭强制核显合成', stack: 'bg=' + bg }).catch(() => {});
      } else if (!ui.softwareRender) {
        // 阶梯兜底:核显开关未开仍黑 → 显卡驱动合成损坏(如 Intel B580 等新架构驱动),自动切软件渲染
        liteapi.invoke('config:set', { ui: { softwareRender: true } }).then((c) => {
          state.config = c;
          toast('检测到显卡驱动渲染异常(画面发黑/字体发糊),已自动切换「软件渲染(兼容模式)」—— 重启应用后生效;若想关闭请到 设置 → 开发者选项');
        });
        liteapi.invoke('debug:report', { message: 'gpu-black-fallback: 自动切换软件渲染', stack: 'bg=' + bg }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }, 1200);
}

liteapi.onChatEvent(handleChatEvent);
boot();

/* ---- LiteAgent 原生插件(SDK)区 ---- */
async function renderLiteSection() {
  const wrap = $('#lite-section');
  if (!wrap) return;
  let list = [];
  try { list = await liteapi.invoke('lite:list'); } catch (_) { /* ignore */ }
  const rows = list.map((p) => {
    const statusLine = p.error
      ? '<div class="sub-text" style="color:var(--danger)">' + escapeHtml(p.error) + '</div>'
      : '<div class="sub-text">' + escapeHtml((p.tools || []).join(', ') || '(无工具)') + '</div>';
    return '<div class="sub-agent st-' + (p.error ? 'error' : 'done') + '" style="margin-bottom:6px">'
      + '<div class="sub-head"><span class="sub-ico">' + (p.error ? '✕' : '✓') + '</span>'
      + '<b>' + escapeHtml(p.name) + '</b>'
      + '<span class="sub-model">v' + escapeHtml(p.version) + ' · ' + p.toolCount + ' 工具</span>'
      + '<span style="flex:1"></span>'
      + '<label style="font-size:11.5px;color:var(--text-2);display:flex;align-items:center;gap:4px">启用 '
      + '<input type="checkbox" data-lite="' + p.id + '" ' + (p.enabled ? 'checked' : '') + '></label></div>'
      + statusLine + '</div>';
  }).join('');
  wrap.innerHTML = '<div class="label" style="font-weight:700;margin:14px 0 4px">LiteAgent 原生插件(SDK)</div>'
    + '<div class="desc" style="font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:8px">'
    + '为本客户端专属开发的插件:把 <b>xxx.liteagent.js</b>(或含 package.json 且带 "liteagent" 字段的文件夹)放进插件目录,'
    + '导出 { name, tools: [{ name, description, parameters, execute(args, ctx) }] } 即可注入智能体(完全/创造模式)。兼容层插件(MCP / DSH)不受影响。'
    + '</div>'
    + '<div style="display:flex;gap:8px;margin-bottom:8px"><button class="btn" id="lite-open">打开插件目录</button>'
    + '<button class="btn" id="lite-reload">重新加载</button></div>'
    + (list.length ? rows : '<div style="font-size:12px;color:var(--text-3)">尚未安装原生插件(目录为空,点「打开插件目录」放入后重新加载)</div>');
  $('#lite-open').addEventListener('click', () => liteapi.invoke('lite:openDir'));
  $('#lite-reload').addEventListener('click', async () => { await liteapi.invoke('lite:reload'); renderLiteSection(); toast('插件已重新加载'); });
  $$('#lite-section input[data-lite]').forEach((cb) => cb.addEventListener('change', async () => {
    await liteapi.invoke('lite:setEnabled', { id: cb.dataset.lite, enabled: cb.checked });
    toast('插件已' + (cb.checked ? '启用' : '停用'));
    renderLiteSection();
  }));
}

/* ---- 技能专精 tab ---- */
async function renderSpecialtyPane(root) {
  const active = state.config.ui.activeSpecialtyId || null;
  let packs = [];
  try { packs = await liteapi.invoke('specialty:list'); } catch (_) { /* ignore */ }
  const modalBody = root || $('#modal-body');
  modalBody.innerHTML = '<div style="font-size:12px;color:var(--text-3)">读取专精包…</div>';

  const rows = packs.map((p) => {
    const isActive = p.id === active;
    return '<div class="sub-agent ' + (isActive ? 'st-done' : '') + '" style="margin-bottom:8px">'
      + '<div class="sub-head"><span class="sub-ico">' + (p.icon || '🎓') + '</span>'
      + '<b>' + escapeHtml(p.name) + (p.builtin ? ' <span class="sub-model">内置</span>' : '') + '</b>'
      + '<span class="sub-model">v' + p.version + ' · ' + p.fileCount + ' 篇知识</span>'
      + '<span style="flex:1"></span>'
      + '<button class="btn ' + (isActive ? '' : 'primary') + '" data-spec-act="toggle" data-id="' + p.id + '">' + (isActive ? '✓ 使用中' : '启用') + '</button>'
      + '<button class="btn" data-spec-act="del" data-id="' + p.id + '"' + (p.builtin ? ' title="内置包删除后下次启动会重新同步"' : '') + '>删除</button>'
      + '</div>'
      + '<div class="sub-text">' + escapeHtml(p.description) + '</div>'
      + '</div>';
  }).join('');

  modalBody.innerHTML = `
    <div class="agent-settings" style="max-width:680px">
      <div class="field">
        <label>什么是「技能专精」</label>
        <div class="hint" style="font-size:12px;line-height:1.8">
          专精 = 一整套领域知识包:激活后,专精人设 + 核心约束 + 知识路由地图会注入系统提示词,智能体获得
          <b>read_specialty</b> 工具按需查阅知识文件(受限/完全/创造模式;纯对话模式仅注入索引)。同一时间只启用一个专精。
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="btn primary" id="spec-import-zip">导入 zip / .md</button>
        <button class="btn primary" id="spec-import-dir">导入文件夹</button>
        <button class="btn" id="spec-open">打开专精目录</button>
        <span style="flex:1"></span>
        <span style="font-size:11.5px;color:var(--text-3);align-self:center">当前:${active ? escapeHtml((packs.find((x) => x.id === active) || {}).name || active) : '未启用'}</span>
      </div>
      ${rows || '<div class="side-empty">暂无专精包</div>'}
      <div class="field" style="margin-top:6px">
        <div class="hint" style="font-size:11.5px">内置包:VRChat 专精(🥽,414 篇 LLM 友好维基)。导入的 zip 建议包含 index.md / _always-load.md(路由地图 + 核心速查),没有也会自动生成索引。</div>
      </div>
    </div>`;

  const doImport = async (mode) => {
    const src = await liteapi.invoke('specialty:pick', mode);
    if (!src) return;
    toast('正在导入专精包…');
    try {
      const pack = await liteapi.invoke('specialty:import', src);
      toast(`已导入专精「${pack.name}」(${pack.fileCount} 篇知识)`);
      state.config = await liteapi.invoke('config:get');
      rerenderSettings();
    } catch (err) {
      toast('导入失败: ' + err.message);
    }
  };
  (modalBody.querySelector('#spec-import-zip') || {}).addEventListener?.('click', () => doImport('file'));
  (modalBody.querySelector('#spec-import-dir') || {}).addEventListener?.('click', () => doImport('dir'));
  (modalBody.querySelector('#spec-open') || {}).addEventListener?.('click', () => liteapi.invoke('specialty:openDir'));
  $$('button[data-spec-act]', modalBody).forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    if (b.dataset.specAct === 'toggle') {
      state.config = await liteapi.invoke('specialty:setActive', active === id ? null : id);
      toast(active === id ? '已停用专精' : '已启用专精(对新回复生效)');
    } else if (b.dataset.specAct === 'del') {
      const pack = packs.find((x) => x.id === id);
      if (!confirm(`删除专精「${pack ? pack.name : id}」?${pack && pack.builtin ? '(内置包:删除后下次启动会重新同步)' : ''}`)) return;
      state.config = (await liteapi.invoke('specialty:delete', id)).config;
      toast('已删除');
    }
    renderSpecialtyPane(modalBody); // 容器参数化自重绘(设置抽屉与连接桥语境通用)
    updateStatusHint();
  }));
}
