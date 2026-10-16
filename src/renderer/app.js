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
  return HAS_PURIFY ? DOMPurify.sanitize(raw, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'link'], FORBID_ATTR: ['style'] }) : raw;
}

function renderMd(el, text, streaming) {
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
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'style.css'; // 相对路径按宿主 base 解析到同一文件
    doc.head.appendChild(link);
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
  // 高度同步(内容/图片加载变化)
  const ro = new ResizeObserver(() => syncFrameHeight(frame));
  ro.observe(doc.body);
}

function syncFrameHeight(frame) {
  try {
    const doc = frame.contentDocument;
    if (doc && doc.documentElement) frame.style.height = doc.documentElement.scrollHeight + 'px';
  } catch (_) { /* ignore */ }
}

// enhanceCode 的框内版本:对 iframe 文档里的 pre/a 做与宿主一致的处理
function enhanceCodeInDoc(doc) {
  $$('pre', doc).forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-body')) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '代码';
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="code-lang">${escapeHtml(lang)}</span><button class="code-copy" type="button">${t('复制')}</button>`;
    const body = document.createElement('div');
    body.className = 'code-body';
    pre.replaceWith(wrap);
    body.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(body);
    const btn = head.querySelector('.code-copy');
    if (btn) btn.addEventListener('click', () => {
      try { navigator.clipboard.writeText(code.textContent); btn.textContent = '✓'; setTimeout(() => { btn.textContent = t('复制'); }, 1200); } catch (_) { /* ignore */ }
    });
  });
  $$('a[href^="http"]', doc).forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
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

// 代码块:高亮 + 语言标签 + 复制按钮;链接交给系统浏览器
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
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="code-lang">${escapeHtml(lang)}</span><button class="code-copy" type="button">复制</button>`;
    const body = document.createElement('div');
    body.className = 'code-body';
    pre.replaceWith(wrap);
    body.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(body);
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

function renderSidebar() {
  const list = $('#conv-list');
  const groups = [...(state.config.groups || [])].sort((a, b) => (a.id === 'default' ? -1 : 0) - (b.id === 'default' ? -1 : 0));
  let html = '';
  let total = 0;
  for (const g of groups) {
    const convs = state.convs.filter((c) => (c.groupId || 'default') === g.id);
    total += convs.length;
    const collapsed = state.collapsedGroups.has(g.id);
    html += `
      <div class="group-head" data-gid="${g.id}" title="${escapeHtml(g.workspace || '跟随全局工作目录')}">
        <span class="gh-arrow">${collapsed ? '▸' : '▾'}</span>
        <span class="gh-icon">${g.icon || '📁'}</span>
        <span class="gh-name">${escapeHtml(t(g.name))}</span>
        <span class="gh-count">${convs.length}</span>
        <span class="gh-actions">
          <button data-gact="rename" title="${t('重命名分组')}">✎</button>
          <button data-gact="folder" title="${t('设置工作文件夹')}">📂</button>
          ${g.id !== 'default' ? `<button data-gact="delete" class="act-del" title="${t('删除分组(会话移入默认分组)')}">✕</button>` : ''}
        </span>
      </div>`;
    if (!collapsed) {
      html += convs.map((c) => `
        <div class="conv-item in-group ${state.conv && state.conv.id === c.id ? 'active' : ''}" data-id="${c.id}">
          <div class="conv-title">${escapeHtml(c.title)}${state.streams.has(c.id) ? `<span class="conv-streaming" title="${t('正在回复…')}"></span>` : ''}</div>
          <div class="conv-actions">
            <button data-act="rename" title="${t('重命名')}">✎</button>
            <button data-act="delete" class="act-del" title="${t('删除')}">✕</button>
          </div>
        </div>`).join('');
    }
  }
  list.innerHTML = total || groups.length ? html : `<div class="side-empty">${t('暂无对话')}</div>`;
  updateTermStatus(); // 会话标题变化(如自动命名)时同步终端状态栏
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
  renderUsageBar(); // 新会话:清掉上一会话的会话级用量/上下文(v0.50.1 修复跨会话残留)
  $('#input').focus();
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
}

/* ================= 会话渲染 ================= */
function renderChatEmpty(subtitle) {
  closeSearch();
  if (term.active) { termClear(); termPrintBanner(); }
  const g = (state.config.groups || []).find((x) => x.id === (state.pendingGroupId || (state.conv && state.conv.groupId) || 'default'));
  chatEl.innerHTML = `
    <div class="chat-inner">
      <div class="empty-hero">
        <div class="hero-logo">L</div>
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
  msg.innerHTML = '<div class="who"><span class="dot"></span>LiteAgent<span class="who-model"></span></div>';
  const turn = document.createElement('div');
  turn.className = 'turn';
  msg.appendChild(turn);
  inner.appendChild(msg);
  S.turnEl = turn;
  S.whoModelEl = $('.who-model', msg);
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
      inner.appendChild(userBubble(m, i));
    } else if (m.role === 'assistant' && m.blocks && !m.blocks.length) {
      continue; // 空块消息(占位撤回残留):不渲染
    } else if (m.role === 'assistant' && m.blocks && m.blocks.length === 1 && m.blocks[0].type === 'model-switch') {
      inner.appendChild(savedBlockEl(m.blocks[0])); // 独立的模型切换提示行(无卡片)
    } else if (m.role === 'assistant') {
      const msg = document.createElement('div');
      msg.className = 'msg msg-assistant';
      msg.innerHTML = '<div class="who"><span class="dot"></span>LiteAgent' + (m.model ? '<span class="who-model">' + escapeHtml(m.model) + '</span>' : '') + '</div>';
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
    return det;
  }
  if (b.type === 'ask') {
    const card = document.createElement('div');
    card.className = 'ask-card answered';
    card.innerHTML = '<div class="ask-head">❓ ' + escapeHtml(b.question || '') + '</div>'
      + (b.context ? '<div class="ask-ctx">' + escapeHtml(b.context) + '</div>' : '')
      + '<div class="ask-opts">' + (b.options || []).map((o, i) =>
          '<div class="ask-opt' + (b.answerKind === 'opt' && b.answerIndex === i ? ' picked' : '') + '"><b>' + 'ABC'[i] + '. ' + escapeHtml(o.label || '') + '</b>'
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
            '<button class="ask-opt" data-i="' + i + '"><b>' + 'ABC'[i] + '. ' + escapeHtml(o.label || '') + '</b>'
            + (o.detail ? '<span class="ask-detail">' + escapeHtml(o.detail) + '</span>' : '') + '</button>').join('')
        + '</div>'
        + '<div class="ask-free"><input type="text" placeholder="或者自己输入你的答案…(第 4 项)"><button class="btn">提交</button></div>';
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
  for (const f of files) {
    if (state.pendingAttachments.length >= ATTACH_MAX_COUNT) {
      toast(`附件最多 ${ATTACH_MAX_COUNT} 个`);
      break;
    }
    const a = await readAttachment(f);
    if (a) state.pendingAttachments.push(a);
  }
  renderAttachBar();
}

function renderAttachBar() {
  const bar = $('#attach-bar');
  bar.innerHTML = '';
  if (!state.pendingAttachments.length) { bar.classList.add('hidden'); return; }
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

// 滑块放置:靠左 = 模型选择正下方(独立行);居中/靠右 = 上移到与模型选择并排的那一栏
function placeReasonSlider() {
  const ui = (state.config && state.config.ui) || {};
  const align = ['left', 'center', 'right'].includes(ui.sliderAlign) ? ui.sliderAlign : 'center';
  const row = $('#composer-reason');
  const full = $('#composer-full');
  const slider = $('#reason-slider');
  if (!row || !full || !slider) return;
  if (align === 'left') {
    if (slider.parentElement !== row) row.appendChild(slider); // 模型正下方
    row.style.marginLeft = '0';
    row.style.marginRight = 'auto';
  } else if (align === 'center') {
    const spacer = $('.spacer', full);
    if (slider.parentElement !== full || (spacer && slider.nextElementSibling !== spacer)) {
      full.insertBefore(slider, spacer); // 与模型并排,剩余空间居中
    }
    slider.style.margin = '0 auto';
    slider.style.flex = '0 1 440px';
  } else {
    if (slider.parentElement !== full || slider.nextElementSibling !== null) {
      full.appendChild(slider); // 与模型并排,靠右
    }
    slider.style.margin = '0 0 0 12px';
    slider.style.flex = '0 0 440px';
  }
}

function applyComposerFold() {
  const head = $('#composer-head');
  if (!head) return;
  const folded = !!state.config.ui.composerFold;
  head.classList.toggle('folded', folded);
  updateSkillBarVisibility(); // 技能栏可见性统一收敛(折叠或无 @ 都隐藏,v0.49.6)
  placeReasonSlider();
  const ui = (state.config && state.config.ui) || {};
  const inline = (ui.sliderAlign || 'center') !== 'left'; // 居中/靠右时滑块在模型那一栏,随折叠隐藏
  const reasonRow = $('#composer-reason');
  if (reasonRow) reasonRow.style.display = (folded || inline) ? 'none' : '';
  $('#composer-fold').textContent = folded ? '▸' : '▾';
  $('#composer-mini').textContent = folded ? composerMiniText() : '';
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

// 滑块位置与状态:idx 按档位序号;颜色随等级越来越粉,最高档加 at-max(闪粉特效)
function accentRgb() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  if (!m) return [99, 102, 241];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const RS_PINK = [255, 64, 158];
const mixRgb = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const rgbStr = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

function paintReasonSlider(box, idx) {
  const stops = $$('.rs-stop', box);
  if (!stops.length) return;
  const last = stops.length - 1;
  const pct = last > 0 ? (idx / last) * 100 : 100;
  const t = last > 0 ? idx / last : 1;
  const col = rgbStr(mixRgb(accentRgb(), RS_PINK, t));
  $('.rs-fill', box).style.width = pct + '%';
  $('.rs-fill', box).style.background = col;
  $('.rs-thumb', box).style.left = pct + '%';
  $('.rs-thumb', box).style.borderColor = col;
  stops.forEach((s, i) => s.classList.toggle('active', i === idx));
  box.classList.toggle('at-max', idx === last && stops.length > 1);
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
    box.innerHTML = `<span class="rs-plain">🧠 ${t('该模型不支持推理')}</span>`;
    box.dataset.ready = '0';
    state.reasonRenderKey = key + '|unsupported';
    state.reasonValue = null;
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
    return;
  }

  box.dataset.key = key;
  box.dataset.ready = '1';
  box.innerHTML = `
    <span class="rs-badge">🧠</span>
    <div class="rs-body">
      <div class="rs-labels">${levels.map((lv, i) => {
        const pct = levels.length > 1 ? (i / (levels.length - 1)) * 100 : 100;
        const edge = i === 0 ? ' edge-l' : (i === levels.length - 1 ? ' edge-r' : '');
        return `<span class="rs-stop${edge}" data-lv="${lv}" title="${t(REASON_LABEL[lv] || lv)}" style="left:${pct}%">${t(REASON_LABEL[lv] || lv)}</span>`;
      }).join('')}</div>
      <div class="rs-track"><div class="rs-fill"></div><div class="rs-thumb"></div></div>
      <span class="rs-spark s1">✦</span><span class="rs-spark s2">✦</span><span class="rs-spark s3">✦</span>
    </div>
    <span class="rs-flame">✨</span>`;

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
  const outMs = g.times && g.times.output;
  const tps = outMs > 0 ? Math.round((g.completion || 0) / (outMs / 1000)) : 0;
  let seg1 = `<span class="ub-seg">${SVG_CLOCK}<b>${turns}</b> ${t('轮')}${steps ? ` <b>${steps}</b> ${t('步')}` : ''}${tps > 0 ? ` · <b>${tps >= 10000 ? fmtBig(tps) : tps}</b> tok/s` : ''}</span>`;

  // 中段:全局累计 token + 缓存命中
  const totalTok = (g.prompt || 0) + (g.completion || 0);
  const cacheHit = g.prompt > 0 && g.cached > 0 ? Math.round((g.cached / g.prompt) * 100) : null;
  let seg2 = `<span class="ub-seg">${SVG_DB}<b>${fmtBig(totalTok)}</b> tok${cacheHit != null ? ` · ${t('缓存命中')} <b>${cacheHit}%</b>` : ''}</span>`;

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
  const tps = g.times && g.times.output > 0 ? Math.round((g.completion || 0) / (g.times.output / 1000)) : 0;
  const row = (name, val) => `<div class="cp-row"><span class="cp-name">${name}</span><span class="cp-val">${val}</span></div>`;
  const html = `
    <div class="cp-head"><span class="cp-title">${t('会话统计')}</span></div>
    ${row(t('模型用时'), fmtMinSec(modelMs))}
    ${row(t('工具调用用时'), fmtMinSec(toolMs))}
    ${row(t('首 token 平均(TTFT)'), g.requests > 0 ? (ttft / 1000).toFixed(1) + t('秒') : '—')}
    ${row(t('输出速度(TPS)'), tps > 0 ? tps + ' tok/s' : '—')}`;
  openUbPop(anchor, html, pinned, true);
}

// 🗄 Token 用量(全局,原始精确数字):缓存命中% / 未缓存输入 / 缓存读取 / 输出
function openTokensPop(anchor, pinned) {
  const g = state.config.usage || {};
  const row = (name, val) => `<div class="cp-row"><span class="cp-name">${name}</span><span class="cp-val">${val}</span></div>`;
  const cacheHit = g.prompt > 0 && g.cached > 0 ? Math.round((g.cached / g.prompt) * 100) : null;
  const uncached = Math.max(0, (g.prompt || 0) - (g.cached || 0));
  const head = `<div class="cp-head"><span class="cp-title">${t('Token 用量')}</span><span class="cp-frac">${fmtRaw((g.prompt || 0) + (g.completion || 0))} tok</span></div>`;
  const html = head
    + (cacheHit != null ? row(t('缓存命中'), cacheHit + '%') : '')
    + row(t('未缓存输入'), fmtRaw(uncached) + ' tok')
    + row(t('缓存读取'), fmtRaw(g.cached || 0) + ' tok')
    + row(t('输出'), fmtRaw(g.completion || 0) + ' tok');
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

function renderModelCombo() {
  const label = $('#mc-label');
  if (label) label.textContent = !state.config.lastModel ? t('未选择模型') : modelLabelText();
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
  const all = state.modelChoices || [];
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
  const pop = $('#mc-pop');
  if (!pop) return;
  const show = force !== undefined ? force : pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !show);
  if (show) {
    $('#mc-search').value = '';
    renderModelList();
    setTimeout(() => $('#mc-search').focus(), 0);
  }
}

function closeModelPop() {
  const pop = $('#mc-pop');
  if (pop) pop.classList.add('hidden');
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

function applyUiMode() {
  const ui = (state.config && state.config.ui) || {};
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

// 纯终端模式 = 整窗即终端形态的完整 Agent:聊天 UI 由 CSS 退场,Agent 控制台(#agent-term)接管。
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

/* ================= 纯终端模式:终端形态的完整 Agent 控制台 ================= */
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
  { cmd: '/settings', desc: '打开设置', scope: 'term' },
  { cmd: '/stop', desc: '停止当前回复', scope: 'both' },
  { cmd: '/clear', desc: '清屏', scope: 'term' },
  { cmd: '/exit', desc: '退出纯终端模式', scope: 'term' },
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
  '  /settings      打开设置抽屉',
  '  /stop          停止当前回复',
  '  /clear         清屏',
  '  /exit          退出纯终端模式,回到完整界面',
];
const term = {
  active: false,      // 控制台是否处于接管状态(= 纯终端模式开启)
  stick: true,        // 滚动跟随
  cur: null,          // 当前流式回复的终端渲染状态 {text, reasoning, tools:Map, asks:Map}
  shellBlock: null,   // 当前 ! 命令的 shell 输出块
};

function initTermConsole() {
  if ($('#agent-term')) return;
  const box = document.createElement('div');
  box.id = 'agent-term';
  box.className = 'hidden';
  box.innerHTML = `
    <div id="at-out"></div>
    <div id="at-input-row"><span id="at-prompt">❯</span><input id="at-input" type="text" spellcheck="false" placeholder="与 AI 对话;!cmd 执行 shell;/help 查看命令" autocomplete="off"></div>
    <div id="at-status"><span id="at-st-left">—</span><span class="at-grow"></span><span id="at-st-right"></span><button id="at-settings-btn" title="打开设置">⚙ 设置</button></div>`;
  $('#main').appendChild(box);
  term.out = $('#at-out', box);
  term.input = $('#at-input', box);
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
  term.input.addEventListener('input', () => { slashIdx = -1; renderSlashPop(); });
  term.input.addEventListener('blur', () => setTimeout(closeSlashPop, 120));

  term.input.addEventListener('keydown', (e) => {
    e.stopPropagation();
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
  $('#at-settings-btn', box).addEventListener('click', () => openSettings());
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

function termScroll(force) {
  if (!term.out) return;
  if (force || term.stick) term.out.scrollTop = term.out.scrollHeight;
}

function termClear() {
  term.out.innerHTML = '';
  term.cur = null;
  term.shellBlock = null;
}

function termPrintBanner() {
  termLine('at-meta', null, `LiteAgent v${state.appVersion || '?'} 纯终端模式 —— 这是一个完整的智能体:直接输入即与 AI 对话,可创建内容、执行任务`);
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

function termRenderMsgs(conv) {
  if (!conv || !conv.messages || !conv.messages.length) {
    updateTermStatus();
    return;
  }
  for (const m of conv.messages) {
    if (m.role === 'user') {
      termLine('at-user', '❯ ', m.content || '');
      if ((m.attachments || []).length) termLine('at-meta', null, `  📎 ${m.attachments.length} 个附件`);
      continue;
    }
    if (m.role !== 'assistant') continue;
    for (const b of m.blocks || []) {
      if (b.type === 'text') termLine('at-assistant', null, b.content || '');
      else if (b.type === 'reasoning') termLine('at-reasoning', null, b.content || '');
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
        termLine('at-ask-line', '❓ ', (b.question || '') + ' → ' + (b.answerDisplay || '(未回答)'));
      } else if (b.type === 'error') {
        termLine('at-error', null, '⚠ ' + (b.message || ''));
      }
    }
  }
  updateTermStatus();
}

// 流式事件 → 终端渲染(handleChatEvent 在 applyStreamEvent 之后调用;仅当前会话事件会到达这里)
function termApplyEvent(S, ev) {
  if (!term.active) return;
  switch (ev.type) {
    case 'text-delta': {
      if (term.cur && term.cur.reasoning) term.cur.reasoning = null; // 出正文即结束思考块(与聊天卡片行为一致)
      // 工具调用后的新文本段要另起一行(与聊天路径的 text.finalized 语义一致)
      if (!term.cur || !term.cur.text || term.cur.text.finalized) {
        term.cur = { text: termLine('at-assistant', null, ''), reasoning: null, tools: new Map(), asks: new Map() };
      }
      const span = term.cur.text.lastChild;
      span.textContent += ev.text;
      termScroll();
      break;
    }
    case 'text-end': {
      if (term.cur && term.cur.text) {
        term.cur.text.lastChild.textContent = ev.content || term.cur.text.lastChild.textContent;
        term.cur.text.finalized = true;
      }
      break;
    }
    case 'reasoning-delta': {
      if (!term.cur || !term.cur.reasoning) {
        if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map() };
        term.cur.reasoning = termLine('at-reasoning', null, '');
      }
      term.cur.reasoning.lastChild.textContent += ev.text;
      termScroll();
      break;
    }
    case 'tool-start': {
      if (ev.name === 'ask_user') break;
      const line = termLine('at-tool', '⚙ ', `${ev.name || ''} ${toolBrief(ev.name, ev.args)}`.trim() + ' ');
      const st = document.createElement('span');
      st.className = 'at-st';
      st.textContent = TOOL_STATE_TEXT[ev.status] || ev.status || '';
      line.appendChild(st);
      if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map() };
      term.cur.tools.set(ev.toolCallId, { line, st });
      if (ev.status === 'awaiting') termAppendApprove(S, line, ev.toolCallId);
      break;
    }
    case 'tool-end': {
      const entry = term.cur && term.cur.tools.get(ev.toolCallId);
      if (!entry) break;
      entry.st.textContent = TOOL_STATE_TEXT[ev.status] || ev.status || '';
      entry.line.className = `at-tool st-${ev.status}`;
      if (ev.status === 'error' && ev.result) termLine('at-tool-result', null, String(ev.result).slice(-400));
      break;
    }
    case 'ask-user': {
      termAskUser(S, ev);
      break;
    }
    case 'error': {
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
  };
  ok.addEventListener('click', () => decide(true));
  no.addEventListener('click', () => decide(false));
  row.appendChild(ok);
  row.appendChild(no);
  term.out.appendChild(row);
  termScroll();
}

function termAskUser(S, ev) {
  if (!term.cur) term.cur = { text: null, reasoning: null, tools: new Map(), asks: new Map() };
  const card = document.createElement('div');
  card.className = 'at-ask';
  const q = document.createElement('div');
  q.className = 'at-q';
  q.textContent = '❓ ' + (ev.question || '请做出选择');
  card.appendChild(q);
  if (ev.context) {
    const ctx = document.createElement('div');
    ctx.className = 'at-ctx';
    ctx.textContent = ev.context;
    card.appendChild(ctx);
  }
  const answer = (enc, display) => {
    if (card.dataset.answered) return;
    card.dataset.answered = '1';
    liteapi.invoke('ask:answer', { streamId: S.streamId, toolCallId: ev.toolCallId, answer: enc });
    $$('.at-opt', card).forEach((b) => b.remove());
    if (freeRow) freeRow.remove();
    termLine('at-answered', null, display);
  };
  (ev.options || []).forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'at-opt';
    b.textContent = `[${'ABCD'[i] || i + 1}] ${o.label || ''}${o.detail ? ' — ' + o.detail : ''}`;
    b.addEventListener('click', () => answer('opt:' + i, '✅ 选择:' + (o.label || '')));
    card.appendChild(b);
  });
  const freeRow = document.createElement('div');
  freeRow.className = 'at-free-row';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = '或自己输入答案(Enter 提交)';
  const btn = document.createElement('button');
  btn.className = 'at-opt at-inline';
  btn.textContent = '提交';
  const submitFree = () => {
    const v = inp.value.trim();
    if (v) answer('free:' + v, '✍️ 自填:' + v);
  };
  btn.addEventListener('click', submitFree);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitFree(); } e.stopPropagation(); });
  freeRow.appendChild(inp);
  freeRow.appendChild(btn);
  card.appendChild(freeRow);
  term.out.appendChild(card);
  termScroll();
  inp.focus();
}

// done/出错收尾:打印耗时与用量行(与聊天界面的 turn-meta 对应)
function termFinish(ev) {
  if (!term.active) return;
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
  if (state.conv && state.streams.has(state.conv.id)) bits.push(t('● 回复中'));
  left.textContent = bits.join(' · ');
  const cx = state.conv && state.conv.ctx;
  right.textContent = cx && cx.tokens ? `${t('上下文')} ~${fmtTok(cx.tokens)} tok/${cx.messages}${t('条')}` : '';
}

/* ---- 终端输入分发:! shell / / 元命令 / 其余=AI 对话 ---- */
function handleTermInput() {
  const sp = document.getElementById('at-slash-pop');
  if (sp) sp.classList.add('hidden'); // 执行前收起补全(v0.51.4)
  const raw = term.input.value;
  term.input.value = '';
  if (!raw.trim()) return;
  if (raw.startsWith('!')) { termRunShell(raw.slice(1)); return; }
  if (raw.startsWith('/')) { termRunMeta(raw.trim()); return; }
  termSend(raw.trim());
}

async function termSend(text) {
  termLine('at-user', '❯ ', text);
  await submit(text);
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
  termLine('at-user', '❯ ', raw);
  if (cmd === '/help') {
    for (const l of TERM_HELP_LINES) termLine('at-meta', null, l);
  } else if (cmd === '/new') {
    state.conv = null;
    state.pendingGroupId = 'default';
    renderSidebar();
    renderUsageBar(); // 新会话:清残留(v0.50.1)
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
      termLine('at-meta', null, `当前:${MODE_SHORT[state.config.ui.mode] || '对话'}模式`);
      termLine('at-meta', null, '可选:' + MODE_META.map((m) => m.label).join(' / ') + '(/mode 名称)');
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
    // /model(v0.51.2):无参列出可选模型;带参模糊匹配切换(applyModelChoice 正规路径)
    const choices = state.modelChoices || [];
    if (!arg) {
      const lm = state.config.lastModel || {};
      termLine('at-meta', null, `当前:${(choices.find((c) => c.providerId === lm.providerId && c.model === lm.model) || {}).model || lm.model || '(未选择)'}`);
      for (const c of choices.slice(0, 20)) termLine('at-meta', null, `  ${c.providerName}/${c.model}`);
      if (choices.length > 20) termLine('at-meta', null, `  …共 ${choices.length} 个`);
      termLine('at-meta', null, '切换:/model 名称(模糊匹配)');
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
  } else if (cmd === '/settings') {
    openSettings();
    termLine('at-meta', null, '已打开设置(完整界面侧)');
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
    toast('已退出纯终端模式');
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
const SETTINGS_NAV = [
  ['providers', '供应商', '🧩'],
  ['prompts', '提示词', '🧑'],
  ['extensions', '扩展', '🔌'],
  ['agent', 'Agent', '🤖'],
  ['subagents', '子智能体', '👥'],
  ['security', '安全', '🛡️'],
  ['usage', '用量', '📊'],
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
  $$('.sd-nav .modal-tab', drawer).forEach((t) => t.classList.toggle('active', t.dataset.tab === settingsTab));
  const body = $('#modal-body');
  body.scrollTop = 0;
  if (settingsTab === 'providers') renderProvidersPane();
  else if (settingsTab === 'prompts') renderPromptsPane();
  else if (settingsTab === 'extensions') renderExtensionsPane();
  else if (settingsTab === 'agent') renderAgentPane();
  else if (settingsTab === 'subagents') renderSubagentsPane();
  else if (settingsTab === 'security') renderSecurityPane();
  else if (settingsTab === 'usage') renderUsagePane();
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
function renderPromptsPane() {
  $('#modal-body').innerHTML = settingsSection('🧑 助手角色(顶栏切换的人设)', 'sec-assistants')
    + settingsSection('⚡ 技能(输入框上方的快捷任务)', 'sec-skills');
  renderAssistantsPane($('#sec-assistants'));
  renderSkillsPane($('#sec-skills'));
}

// 扩展 = 插件(MCP/DSH/LiteAgent)+ 技能专精
function renderExtensionsPane() {
  $('#modal-body').innerHTML = settingsSection('🔌 插件(MCP / DSH / LiteAgent 原生插件)', 'sec-plugins')
    + settingsSection('🎓 技能专精(领域知识包)', 'sec-specialty');
  renderPluginsPane($('#sec-plugins'));
  renderSpecialtyPane($('#sec-specialty'));
}

// Agent 设置 = 智能体行为 + 上下文压缩 + 联网搜索
function renderAgentPane() {
  $('#modal-body').innerHTML = settingsSection('🤖 智能体行为(工作目录 / 审批 / 迭代)', 'sec-agent')
    + settingsSection('📚 上下文压缩(长对话策略)', 'sec-context')
    + settingsSection('🌐 联网搜索(web_search 后端)', 'sec-search');
  renderAgentCorePane($('#sec-agent'));
  renderContextPane($('#sec-context'));
  renderSearchPane($('#sec-search'));
}

// 安全 = 安全审计 + 沙箱 + 网络代理
function renderSecurityPane() {
  $('#modal-body').innerHTML = settingsSection('🛡️ 安全审计(HTTPS 门槛 / 敏感信息 / 日志)', 'sec-audit')
    + settingsSection('📦 沙箱机制(文件锁定 / 命令拦截)', 'sec-sandbox')
    + settingsSection('🌐 网络代理(系统 / 手动 / 直连)', 'sec-proxy');
  renderSecurityCorePane($('#sec-audit'));
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

function renderProvItems() {
  const wrap = $('#prov-items');
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
    return ['none', 'qwen', 'zhipu', 'fixed'].includes(mc.style) ? mc.style : 'auto';
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
      const res = await liteapi.invoke('providers:fetchModels', p.id);
      state.config = res.config;
      p.models = state.config.providers.find((x) => x.id === p.id).models;
      renderModelRows();
      renderProvItems();
      fillModelSelect();
      state.reasonCapsCache.clear();
      toast(`获取到 ${res.models.length} 个模型${res.capsMerged ? `,识别 ${res.capsMerged} 个模型的推理能力` : ''}`);
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

function renderPluginsPane(root) {
  const R = root || $('#modal-body');
  const list = state.config.mcpServers || [];
  if (!settingsSelMcp || !list.some((s) => s.id === settingsSelMcp)) settingsSelMcp = list[0] ? list[0].id : null;
  R.innerHTML = `
    <div class="prov-layout" style="height:auto;min-height:300px">
      <div class="prov-list">
        <div id="mcp-items"></div>
        <div class="prov-add"><button class="btn" id="mcp-add" style="width:100%">＋ 添加 MCP 服务</button></div>
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
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;background:var(--bg-side);border:1px solid var(--border);border-radius:8px">
        <span style="font-size:12.5px" id="mdb-stats">模型能力库:读取中…</span>
        <span style="flex:1"></span>
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
    saveMcpServers();
    settingsSelMcp = cfg.id;
    rerenderSettings();
  });
  $('#dsh-import').addEventListener('click', runDshImport);
  $('#dsh-dir-import').addEventListener('click', runDshDirImport);
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
      <div class="field"><label>参数(每行一个)</label><textarea id="mc-args" class="mono" style="min-height:54px">${escapeHtml((s.args || []).join('\n'))}</textarea></div>
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
      if (id === 'mc-transport') { renderMcpEditor(); return; }
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
    saveMcpServers();
    settingsSelMcp = state.config.mcpServers[0] ? state.config.mcpServers[0].id : null;
    renderPluginsPane();
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
const SEARCH_BACKENDS = {
  duckduckgo: 'DuckDuckGo(免 Key,开箱即用)',
  tavily: 'Tavily(需 API Key,面向智能体优化)',
  brave: 'Brave Search(需 API Key)',
  searxng: 'SearXNG(自建/公共实例)',
  bocha: '博查 Bocha(中文搜索,需 Key)',
};

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
  const keyFieldLabels = { tavily: ['tavilyKey', 'Tavily API Key', '在 tavily.com 免费申请'], brave: ['braveKey', 'Brave Search API Key', '在 brave.com/search/api 申请'], searxng: ['searxUrl', 'SearXNG 实例地址', '例如 https://searx.example.org(实例需开启 JSON 输出 format=json)'], bocha: ['bochaKey', '博查 API Key', '在 bochaai.com 申请,中文搜索效果好'] };
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
    if (!kf) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <label style="font-size:12px;color:var(--text-2)">${kf[1]}</label>
      <input type="text" id="sc-key" value="${escapeHtml((state.config.search || {})[kf[0]] || '')}" placeholder="${kf[2]}" style="width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none">`;
    $('#sc-key').addEventListener('change', (e) => liteapi.invoke('config:set', { search: { [kf[0]]: e.target.value.trim() } }).then((c) => { state.config = c; }));
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
          <div><div class="label">滑块缩放后对齐</div><div class="desc">滑块行缩放后靠窗口左侧、居中还是右侧</div></div>
          <select id="dv-slideralign">
            ${[['center', '居中(默认)'], ['left', '靠左'], ['right', '靠右']].map(([v, l]) => `<option value="${v}" ${(ui.sliderAlign || 'center') === v ? 'selected' : ''}>${l}</option>`).join('')}
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
          <div><div class="label">纯终端模式</div><div class="desc">整个窗口变为一台终端形态的完整智能体(参考 Claude Code):直接输入即与 AI 对话,工具调用/审批/问询照常,可创建内容与执行任务;输入 !cmd 直通真实 shell。状态栏「⚙ 设置」或 /exit 返回完整界面,期间会话照常落盘</div></div>
          <input type="checkbox" id="dv-pure" ${ui.pureTerminal ? 'checked' : ''}>
        </div>
        <div class="hint">以上均为实验性功能:纯终端/低内存模式立即生效(纯终端即时接管整窗,聊天区在后台照常)。毛玻璃/背景图片/背景透明化已移至「外观」页。</div>
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
  $('#dv-slideralign').addEventListener('change', (e) => saveUi({ sliderAlign: e.target.value }).then(() => toast(`滑块对齐:${e.target.value === 'left' ? '靠左' : e.target.value === 'right' ? '靠右' : '居中'}`)));
  $('#dv-perf').addEventListener('change', (e) => saveUi({ perfLowMemory: e.target.checked }).then(() => toast(e.target.checked ? '低内存低占用模式已开启(即时生效)' : '低内存低占用模式已关闭')));
  // 记忆/学习开关(v0.41):工具与提示词注入在下一次发送时生效
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
  $('#dv-pure').addEventListener('change', (e) => saveUi({ pureTerminal: e.target.checked }).then(() => toast(e.target.checked ? '纯终端模式已开启' : '纯终端模式已关闭')));
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
  R.innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="field">
        <label>超限策略(会话超过「携带历史条数」时)</label>
        <select id="cx-strategy" style="width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;outline:none">
          <option value="trim" ${strategy === 'trim' ? 'selected' : ''}>截断:直接丢弃最旧消息(零成本,丢失上下文)</option>
          <option value="summarize" ${strategy === 'summarize' ? 'selected' : ''}>摘要压缩:调用当前模型把旧对话总结成摘要(滚动合并,推荐长任务)</option>
        </select>
        <div class="hint">摘要压缩在每次请求前自动进行:旧消息 → 要点摘要(保留目标/步骤/文件路径/决定/未完成事项),与新消息一起发送;摘要会随对话增长滚动合并,压缩请求本身也走安全审计。</div>
      </div>
      <div class="setting-row">
        <div><div class="label">携带历史条数</div><div class="desc">每次请求携带的最近消息数量上限,越大越费 token</div></div>
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

  $('#cx-strategy').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { strategy: e.target.value } }));
  $('#cx-history').addEventListener('change', (e) => liteapi.invoke('config:set', { chat: { maxHistory: Math.max(4, parseInt(e.target.value, 10) || 40) } }));
  $('#cx-keep').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { keepRecent: Math.max(2, parseInt(e.target.value, 10) || 8) } }));
  $('#cx-cap').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { toolResultCap: Math.min(100000, Math.max(1000, parseInt(e.target.value, 10) || 20000)) } }));
  $('#cx-prompt').addEventListener('change', (e) => liteapi.invoke('config:set', { context: { summaryPrompt: e.target.value } }));
  $('#cx-restore').addEventListener('click', () => { liteapi.invoke('config:set', { context: { summaryPrompt: DEFAULT_SUMMARY_PROMPT } }); $('#cx-prompt').value = DEFAULT_SUMMARY_PROMPT; });
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
  const acc = { requests: 0, prompt: 0, completion: 0, cached: 0, cost: 0, activeMs: 0, toolCount: 0, toolMs: 0, wait: 0, think: 0, output: 0, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 } };
  const add = (v) => {
    for (const k of ['requests', 'prompt', 'completion', 'cached', 'cost', 'activeMs', 'toolCount', 'toolMs', 'wait', 'think', 'output']) acc[k] += v[k] || 0;
    for (const k of Object.keys(acc.parts)) acc.parts[k] += (v.parts && v.parts[k]) || 0;
  };
  if (range === 'all') {
    add({ requests: g.requests, prompt: g.prompt, completion: g.completion, cached: g.cached, cost: g.cost, activeMs: g.activeMs, toolCount: (g.tools || {}).count, toolMs: (g.tools || {}).ms, wait: (g.times || {}).wait, think: (g.times || {}).think, output: (g.times || {}).output, parts: g.parts });
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

function renderUsagePane() {
  $('#modal-body').innerHTML = '<div class="hint" style="padding:24px">加载用量数据…</div>';
  liteapi.invoke('convs:list').then((list) => {
    state.convs = list;
    if (settingsTab === 'usage') drawUsageDashboard();
  }).catch(() => { if (settingsTab === 'usage') drawUsageDashboard(); });
}

function drawUsageDashboard() {
  const body = $('#modal-body');
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
  const speed = A.output > 0 ? Math.round(A.completion / (A.output / 1000)) : null;
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
    const listWrap = $('#ud-conv-cards');
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
    state.config = await liteapi.invoke('config:set', { usage: { prompt: 0, completion: 0, requests: 0, cached: 0, cost: 0, activeMs: 0, byModel: {}, tools: { count: 0, ms: 0 }, times: { wait: 0, think: 0, output: 0 }, parts: { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResult: 0, output: 0 }, daily: {} } });
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
  $('#modal-body').innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="setting-row">
        <div><div class="label">${t('语言')}</div><div class="desc">${t('界面语言(部分深层文案暂仍为简体中文,逐步补齐)')}</div></div>
        <select id="ge-lang">
          <option value="zh-CN" ${(g.language || 'zh-CN') === 'zh-CN' ? 'selected' : ''}>简体中文</option>
          <option value="zh-TW" ${g.language === 'zh-TW' ? 'selected' : ''}>繁體中文</option>
          <option value="en" ${g.language === 'en' ? 'selected' : ''}>English</option>
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
  $('#modal-body').innerHTML = `
    <div class="agent-settings" style="max-width:640px">
      <div class="setting-row">
        <div><div class="label">${t('主题')}</div><div class="desc">${t('浅色 / 深色')}</div></div>
        <select id="ap-theme">
          <option value="light" ${ui.theme !== 'dark' ? 'selected' : ''}>${t('浅色')}</option>
          <option value="dark" ${ui.theme === 'dark' ? 'selected' : ''}>${t('深色')}</option>
        </select>
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
const auxRuns = [];           // 子智能体运行:[{id, name, model, status, text, t}] 新的在前
const panelReview = { pending: new Map(), log: [] }; // 待审批(toolCallId → {streamId,name,brief,since}) / 工具调用记录

// 右侧面板:页面级分栏(主界面缩左半,面板占右半),打开先见「打开标签页」启动页
const PANEL_TABS = [['aux', '💬', '辅助对话'], ['review', '📋', '审查'], ['term', '⌨', '终端'], ['web', '🌐', '浏览器']];
const PANEL_VIEW_TITLE = { aux: '辅助对话', review: '审查', term: '终端', web: '浏览器' };

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
  if (panelState.tab === 'term') { drawPanelTerm(body); return; }
  if (panelState.tab === 'web') { drawPanelWeb(body); return; }
  drawPanelLauncher(body);
}

function drawPanelLauncher(body) {
  body.className = 'sp-body sp-launcher';
  body.innerHTML = `
    <div class="sp-launch-title">${t('打开标签页')}</div>
    <div class="sp-launch-sub">${t('选择要在侧边面板中打开的标签。')}</div>
    ${PANEL_TABS.map(([k, ico, label]) => `<button type="button" class="sp-launch-item" data-t="${k}"><span class="sp-launch-ico">${ico}</span>${t(label)}</button>`).join('')}`;
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

function setPanelTab(tab) {
  // 离开终端/浏览器标签时先收编(终端 DOM 退持有容器 / 浏览器视图隐藏)
  if (panelState.tab === 'term' && tab !== 'term') panelStashTerm();
  if (panelState.tab === 'web' && tab !== 'web') panelWebHide();
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
  if (isNew) {
    run = { id: ev.toolCallId, name: ev.name || '子智能体', model: ev.model || '', status: 'running', text: '', t: Date.now() };
    auxRuns.unshift(run);
    if (auxRuns.length > 30) auxRuns.pop();
    if (panelState.tab === 'aux') auxSelectedRunId = run.id; // 新派发自动切到新队员
  }
  run.name = ev.name || run.name;
  run.model = ev.model || run.model;
  run.status = ev.status || run.status;
  if (ev.text) run.text = ev.text;
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
  $('#sp-aux-clear', body).addEventListener('click', () => { auxRuns.length = 0; auxSelectedRunId = null; auxLive.clear(); drawPanelAux(body); });
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
liteapi.onPanelWebEvent((ev) => {
  const t = browserTabs.find((x) => x.id === ev.tabId);
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

  $('#btn-export').addEventListener('click', async () => {
    if (!state.conv) { toast('当前没有可导出的对话'); return; }
    const r = await liteapi.invoke('convs:export', state.conv.id);
    if (r && r.ok) toast('已导出到 ' + r.path);
  });

  // 右侧面板:辅助对话 / 审查 / 终端 / 浏览器
  $('#btn-panel').addEventListener('click', () => togglePanel());

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
      else if (actBtn.dataset.act === 'delete') {
        if (state.streams.has(id)) { toast('该会话正在回复中,请先停止再删除'); return; }
        if (!confirm('确定删除这个对话?')) return;
        state.convs = await liteapi.invoke('convs:delete', id);
        if (state.conv && state.conv.id === id) { state.conv = null; renderChatEmpty(); }
        renderSidebar();
      }
      return;
    }
    if (id !== (state.conv && state.conv.id)) openConv(id);
  });

  // 模型搜索下拉
  $('#mc-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleModelPop(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#model-combo')) closeModelPop(); });
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
      composerBox.classList.add('dragover');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) composerBox.classList.remove('dragover');
  });
  document.addEventListener('drop', (e) => {
    composerBox.classList.remove('dragover');
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      if (document.body.classList.contains('pure-terminal')) return; // 控制台接管时搜索条不可见
      e.preventDefault();
      if (searchState.open) { const i = $('#search-input'); i.focus(); i.select(); }
      else openSearch();
    }
    if (e.key === 'Escape') {
      if (searchState.open) closeSearch();
      else if (!$('#modal-root').classList.contains('hidden')) closeSettings();
      else closeConvMenu();
    }
  });

  $('#composer-fold').addEventListener('click', toggleComposerFold);
  $('#composer-mini').addEventListener('click', toggleComposerFold);
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
  $('#spec-import-zip').addEventListener('click', () => doImport('file'));
  $('#spec-import-dir').addEventListener('click', () => doImport('dir'));
  $('#spec-open').addEventListener('click', () => liteapi.invoke('specialty:openDir'));
  $$('#modal-body button[data-spec-act]').forEach((b) => b.addEventListener('click', async () => {
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
    rerenderSettings();
    updateStatusHint();
  }));
}
