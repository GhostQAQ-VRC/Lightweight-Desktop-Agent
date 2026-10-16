const openai = require('./openai');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const codex = require('./codex');
const PRESETS = require('./presets');

const ADAPTERS = { openai, anthropic, gemini, codex };

function getAdapter(type) {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`未知的协议类型「${type}」(支持 openai / anthropic / gemini / codex)`);
  return a;
}

module.exports = { getAdapter, PRESETS };
