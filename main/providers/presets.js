// 预置服务商(参考 Cherry Studio 的兼容覆盖面)
// baseUrl 拼接规则见 openai.js 的 normalizeBase:含 /v1、/v4 结尾或以 # 结尾时按原样使用
// consoleUrl = 控制台直达页(创建/查看 API Key);oauth = 账号登录类型(src/main/oauth.js)
module.exports = [
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', consoleUrl: 'https://platform.deepseek.com/api_keys', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'zhipu', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', consoleUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'] },
  { id: 'moonshot', name: 'Moonshot Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', consoleUrl: 'https://platform.moonshot.cn/console/api-keys', models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'] },
  { id: 'qwen', name: '通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', consoleUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key', models: ['qwen3-max', 'qwen-plus', 'qwen-max'] },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com', consoleUrl: 'https://platform.openai.com/api-keys', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', consoleUrl: 'https://console.anthropic.com/settings/keys', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', consoleUrl: 'https://aistudio.google.com/apikey', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  // 账号登录(OAuth 订阅直用,无需 API Key;凭据来自各家开源 CLI 的公开客户端)
  { id: 'qwen-oauth', name: '通义千问(账号登录)', type: 'openai', baseUrl: 'https://portal.qwen.ai/v1', oauth: 'qwen', models: ['qwen3-coder-plus', 'qwen3-max'] },
  { id: 'claude-oauth', name: 'Claude(账号登录)', type: 'anthropic', baseUrl: 'https://api.anthropic.com', oauth: 'claude', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'] },
  { id: 'gemini-oauth', name: 'Gemini(账号登录)', type: 'gemini', baseUrl: 'https://cloudcode-pa.googleapis.com', oauth: 'gemini', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'chatgpt-oauth', name: 'ChatGPT(账号登录)', type: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', oauth: 'codex', models: ['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1-codex-max'] },
  { id: 'copilot-oauth', name: 'GitHub Copilot(账号登录)', type: 'openai', baseUrl: 'https://api.githubcopilot.com', oauth: 'copilot', models: ['gpt-4.1', 'gpt-4o', 'claude-sonnet-4-5', 'gemini-2.5-pro'] },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', consoleUrl: 'https://openrouter.ai/keys', models: [] },
  { id: 'siliconflow', name: 'SiliconFlow 硅基流动', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', consoleUrl: 'https://cloud.siliconflow.cn/account/ak', models: ['deepseek-ai/DeepSeek-V3.1', 'Qwen/Qwen3-32B'] },
  { id: 'ollama', name: 'Ollama(本地)', type: 'openai', baseUrl: 'http://localhost:11434', local: true, models: [] },
  { id: 'lmstudio', name: 'LM Studio(本地)', type: 'openai', baseUrl: 'http://localhost:1234', local: true, models: [] },
  { id: 'groq', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', consoleUrl: 'https://console.groq.com/keys', models: [] },
  { id: 'xai', name: 'xAI Grok', type: 'openai', baseUrl: 'https://api.x.ai/v1', consoleUrl: 'https://console.x.ai', models: [] },
];
