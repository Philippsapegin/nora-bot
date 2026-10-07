const packageInfo = require('../package.json');
require('dotenv').config();

// Каждый ключ Gemini может принадлежать отдельному проекту со своей квотой.
const geminiKeys = [];
if (process.env.GOOGLE_GEMINI_API_KEY) geminiKeys.push(process.env.GOOGLE_GEMINI_API_KEY);
let i = 2;
while (process.env[`GOOGLE_GEMINI_API_KEY_${i}`]) {
    geminiKeys.push(process.env[`GOOGLE_GEMINI_API_KEY_${i}`]);
    i++;
}

console.log(`[CONFIG] Загружено ключей Gemini (Native): ${geminiKeys.length}`);

const aiProvider = process.env.AI_PROVIDER || 'openai';
if (!['google', 'openai'].includes(aiProvider)) {
  throw new Error('AI_PROVIDER должен быть google или openai.');
}
if (aiProvider === 'google' && geminiKeys.length === 0) {
  throw new Error('Для AI_PROVIDER=google нужен GOOGLE_GEMINI_API_KEY.');
}

const requiredModelVars = ['AI_MAIN_MODEL', 'AI_LOGIC_MODEL'];
if (geminiKeys.length > 0) {
  requiredModelVars.push('GOOGLE_NATIVE_MODEL');
  if (!process.env.GOOGLE_FALLBACK_MODELS) requiredModelVars.push('GOOGLE_FALLBACK_MODEL');
}
if ((process.env.SEARCH_PROVIDER || 'tavily') === 'perplexity') {
  requiredModelVars.push('PERPLEXITY_MODEL');
}

const missingModelVars = requiredModelVars.filter(name => !process.env[name]);
if (missingModelVars.length > 0) {
  throw new Error(`Не заданы модели в .env: ${missingModelVars.join(', ')}`);
}

const aiBaseUrl = process.env.AI_BASE_URL || "https://api.openai.com/v1";
const usesOfficialOpenAI = /^https:\/\/api\.openai\.com(?:\/|$)/i.test(aiBaseUrl);
const aiKey = usesOfficialOpenAI
  ? process.env.OPENAI_API_KEY || process.env.AI_API_KEY
  : process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY;
// Ordered chain; the old single-model variable remains compatible.
const fallbackModels = [...new Set((process.env.GOOGLE_FALLBACK_MODELS || process.env.GOOGLE_FALLBACK_MODEL || '')
  .split(',').map(model => model.trim()).filter(Boolean))];
if (geminiKeys.length && !fallbackModels.some(model => model !==
  (aiProvider === 'google' ? process.env.AI_MAIN_MODEL : process.env.GOOGLE_NATIVE_MODEL))) {
  throw new Error('GOOGLE_FALLBACK_MODELS must include a model different from the primary.');
}

module.exports = {
  // === TELEGRAM ===
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  version: packageInfo.version,
  botId: parseInt(process.env.TELEGRAM_BOT_TOKEN.split(':')[0], 10),
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),
  interviewerUserId: parseInt(process.env.NORA_INTERVIEWER_USER_ID || process.env.ADMIN_USER_ID, 10),
  
  // === ОСНОВНОЙ OPENAI-CОВМЕСТИМЫЙ API ===
  aiProvider,
  aiBaseUrl,
  aiKey,
  usesOfficialOpenAI,

  // === МОДЕЛИ ===
  mainModel: process.env.AI_MAIN_MODEL,
  logicModel: process.env.AI_LOGIC_MODEL,

  // === ПОИСК (RAG или NATIVE) ===
  // Варианты: 
  // 'tavily'     -> Использует Tavily API (RAG). Лучший вариант для сторонних моделей.
  // 'perplexity' -> Использует модель Sonar через OpenRouter (RAG).
  // 'google'     -> Получает факты через Google Search, затем передаёт их основной модели.
  // Если в .env не задано, по умолчанию используем нативный поиск Google.
  searchProvider: process.env.SEARCH_PROVIDER || 'google',
  
  // Настройки провайдеров
  tavilyKey: process.env.TAVILY_API_KEY,
  perplexityModel: process.env.PERPLEXITY_MODEL,

  // === GEMINI NATIVE (FALLBACK / SEARCH) ===
  geminiKeys: geminiKeys,
  googleNativeModel: process.env.GOOGLE_NATIVE_MODEL,
  googleSearchModel: process.env.GOOGLE_SEARCH_MODEL || process.env.GOOGLE_NATIVE_MODEL,
  fallbackModelName: fallbackModels[0],
  fallbackModels,
  contextSize: Math.max(2, parseInt(process.env.CONTEXT_MAX_MESSAGES, 10) || 20),
  contextTtlMs: Math.max(1, parseInt(process.env.CONTEXT_TTL_MINUTES, 10) || 30) * 60 * 1000,
  triggerRegex: /(?<![а-яёa-z])(нора|норы|норе|нору|норой|норою)(?![а-яёa-z])/i,
};
