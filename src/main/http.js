// 出站 HTTP 统一出口。
// 默认实现 = Node 全局 fetch(RUN_AS_NODE 测试环境用);应用启动时由 main.js 切换为
// Electron net.fetch(走 Chromium 网络栈)——这样 设置→网络 的代理配置(session.setProxy)
// 才能对全部出站请求生效:三协议适配器、web_fetch、MCP HTTP、models.dev 能力库更新。
// 注意:本模块禁止顶层 require('electron')(适配器会被测试在 RUN_AS_NODE 下加载)。
let impl = (url, opts) => fetch(url, opts);
let uaGetter = null; // () => string:用户自定义 UA(开发者选项;空 = 不覆盖)。getter 动态读配置,改完即时生效

module.exports = {
  setImpl(f) { if (typeof f === 'function') impl = f; },
  setUserAgentGetter(f) { if (typeof f === 'function') uaGetter = f; },
  fetch(url, opts) {
    const o = opts || {};
    try {
      const ua = uaGetter && uaGetter();
      if (ua) {
        // 用户自定义 UA 最高优先(伪装场景):覆盖调用方与默认
        o.headers = { ...(o.headers || {}), 'user-agent': ua };
      }
    } catch (_) { /* UA 注入失败不影响请求 */ }
    return impl(url, o);
  },
};
