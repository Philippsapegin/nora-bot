const packageInfo = require('../package.json');
require('dotenv').config();

// Собираем ключи для Native Google (Fallback или Search)
const geminiKeys = [];
if (process.env.GOOGLE_GEMINI_API_KEY) geminiKeys.push(process.env.GOOGLE_GEMINI_API_KEY);
let i = 2;
while (process.env[`GOOGLE_GEMINI_API_KEY_${i}`]) {
    geminiKeys.push(process.env[`GOOGLE_GEMINI_API_KEY_${i}`]);
    i++;
}

console.log(`[CONFIG] Загружено ключей Gemini (Native): ${geminiKeys.length}`);

const requiredModelVars = ['AI_MAIN_MODEL', 'AI_LOGIC_MODEL'];
if (geminiKeys.length > 0) {
  requiredModelVars.push('GOOGLE_NATIVE_MODEL', 'GOOGLE_FALLBACK_MODEL');
}
if ((process.env.SEARCH_PROVIDER || 'tavily') === 'perplexity') {
  requiredModelVars.push('PERPLEXITY_MODEL');
}

const missingModelVars = requiredModelVars.filter(name => !process.env[name]);
if (missingModelVars.length > 0) {
  throw new Error(`Не заданы модели в .env: ${missingModelVars.join(', ')}`);
}

module.exports = {
  // === TELEGRAM ===
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  version: packageInfo.version,
  botId: parseInt(process.env.TELEGRAM_BOT_TOKEN.split(':')[0], 10),
  adminId: parseInt(process.env.ADMIN_USER_ID, 10),
  
  // === OPENROUTER / API (Основной канал) ===
  aiBaseUrl: process.env.AI_BASE_URL || "https://openrouter.ai/api/v1",
  aiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY, 

  // === МОДЕЛИ ===
  mainModel: process.env.AI_MAIN_MODEL,
  logicModel: process.env.AI_LOGIC_MODEL,

  // === ПОИСК (RAG или NATIVE) ===
  // Варианты: 
  // 'tavily'     -> Использует Tavily API (RAG). Лучший вариант для сторонних моделей.
  // 'perplexity' -> Использует модель Sonar через OpenRouter (RAG).
  // 'google'     -> Переключается на нативный Google API с встроенным поиском (Tools).
  // Если в .env не задано, по умолчанию используем 'tavily'
  searchProvider: process.env.SEARCH_PROVIDER || 'tavily',  
  
  // Настройки провайдеров
  tavilyKey: process.env.TAVILY_API_KEY,
  perplexityModel: process.env.PERPLEXITY_MODEL,

  // === GEMINI NATIVE (FALLBACK / SEARCH) ===
  geminiKeys: geminiKeys,
  googleNativeModel: process.env.GOOGLE_NATIVE_MODEL,
  fallbackModelName: process.env.GOOGLE_FALLBACK_MODEL,
  contextSize: 30,
  triggerRegex: /(?<![а-яёa-z])(нора|норы|норе|нору|норой|норою)(?![а-яёa-z])/i,
};
