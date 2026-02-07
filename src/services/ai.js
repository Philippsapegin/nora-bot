const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const { responses } = require('../core/personality');
const axios = require('axios');
const OpenAI = require('openai');
const { tavily } = require('@tavily/core'); // Клиент Tavily
const storage = require('./storage');

class AiService {
  constructor() {
    // 1. Инициализация OpenAI-совместимого клиента (OpenRouter / Mistral / DeepSeek)
    this.openai = config.aiKey ? new OpenAI({
        baseURL: config.aiBaseUrl,
        apiKey: config.aiKey,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/Veta-one/sych-bot",
          "X-Title": responses.identity.botTitle
        }
    }) : null;

    // 2. Инициализация Tavily
    this.tavilyClient = config.tavilyKey ? tavily({ apiKey: config.tavilyKey }) : null;

    // 3. Google Native (Fallback)
    this.keyIndex = 0;
    this.keys = config.geminiKeys;
    this.usingFallback = false;
    this.bot = null;

    // === СТАТИСТИКА (теперь персистентная через storage) ===
    storage.initGoogleStats(this.keys.length);

    if (this.keys.length === 0) console.warn("WARNING: No Gemini keys found in .env. Fallback will not work.");
    this.initNativeModel();
  }

  setBot(botInstance) {
    this.bot = botInstance;
  }

  notifyAdmin(message) {
    if (this.bot && config.adminId) {
        this.bot.sendMessage(config.adminId, message, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  // Сброс статистики в полночь (проверка через storage)
  resetStatsIfNeeded() {
    const wasReset = storage.resetStatsIfNeeded();
    if (wasReset && this.usingFallback) {
      this.usingFallback = false;
      this.keyIndex = 0;
      this.initNativeModel();
      this.notifyAdmin(responses.ai.newDayResetNotice);
    }
  }

  getStatsReport() {
    this.resetStatsIfNeeded();
    const { today, week, month, allTime } = storage.getFullStats();
    return responses.ai.formatStatsReport({
      today,
      week,
      month,
      allTime,
      usingFallback: this.usingFallback,
      formatNumber: (value) => this._formatNumber(value),
    });
  }

  _formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }

  initNativeModel() {
    if (this.keys.length === 0) return;
    const currentKey = this.keys[this.keyIndex];
    const genAI = new GoogleGenerativeAI(currentKey);
    
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    // Используем Fallback модель или стандартную Flash (она доступна в нативе)
    const modelName = this.usingFallback ? config.fallbackModelName : config.googleNativeModel;
    console.log(`[AI INIT] Native Key #${this.keyIndex + 1} | Model: ${modelName}`);

    this.nativeModel = genAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: prompts.system(),
        safetySettings: safetySettings,
        // Включаем нативный поиск Google (Tools)
        tools: [{ googleSearch: {} }] 
    });
  }

  rotateNativeKey() {
    storage.markGoogleKeyExhausted(this.keyIndex);

    console.log(`[AI WARNING] Native key #${this.keyIndex + 1} exhausted.`);
    this.keyIndex++;

    if (this.keyIndex >= this.keys.length) {
        this.keyIndex = 0;
        console.error("All native Google keys are exhausted.");
        this.notifyAdmin(responses.ai.allGoogleKeysExhausted);
    }
    this.initNativeModel();
  }

  async executeNativeWithRetry(apiCallFn) {
    const maxAttempts = this.keys.length * 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            storage.incrementGoogleStat(this.keyIndex);
            return await apiCallFn();
        } catch (error) {
            const isQuotaError = error.message.includes('429') || error.message.includes('Quota') || error.message.includes('403');
            if (isQuotaError) {
                this.rotateNativeKey();
                continue;
            } else {
                throw error;
            }
        }
    }
    throw new Error("All Google Native keys are exhausted.");
  }

  getCurrentTime() {
    const time = new Date().toLocaleString("ru-RU", {
      timeZone: "Asia/Yekaterinburg",
      weekday: 'short', // Сократим до Пт, Пн (экономим токены)
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    // Явно указываем базу для расчетов
    return `${time} (UTC+5)`;
  }

// === УНИВЕРСАЛЬНЫЙ ПОИСК ===
async performSearch(query) {
  this.resetStatsIfNeeded();

  // 1. TAVILY
  if (config.searchProvider === 'tavily' && this.tavilyClient) {
      try {
          console.log(`[SEARCH] Tavily query: ${query}`);
          const response = await this.tavilyClient.search(query, {
              search_depth: "advanced",
              max_results: 3,
              include_answer: true 
          });
          storage.incrementStat('search');
          
          let resultText = "";
          if (response.answer) resultText += `${responses.ai.tavilyAnswerPrefix}${response.answer}\n\n`;
          response.results.forEach((res, i) => {
              resultText += `[${i+1}] ${res.title} (${res.url}):\n${res.content}\n\n`;
          });
          return resultText;
      } catch (e) {
          console.error(`[TAVILY FAIL] ${e.message}`);
          return null;
      }
  }

  // 2. PERPLEXITY
  if (config.searchProvider === 'perplexity' && this.openai) {
      try {
          console.log(`[SEARCH] Perplexity query: ${query}`);
          const completion = await this.openai.chat.completions.create({
              model: config.perplexityModel,
              messages: [
                  { role: "system", content: responses.ai.perplexitySearchSystemPrompt(this.getCurrentTime()) },
                  { role: "user", content: query }
              ],
              temperature: 0.1
          });
          storage.incrementStat('search');
          return completion.choices[0].message.content;
      } catch (e) {
          console.error(`[PERPLEXITY FAIL] ${e.message}`);
          return null;
      }
  }
  
  return null;
}
  
// === ОСНОВНОЙ ОТВЕТ ===
async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false, chatProfile = null) {
  this.resetStatsIfNeeded();
  console.log(`[DEBUG AI] getResponse called.`);

  // 1. AI ОПРЕДЕЛЯЕТ НУЖЕН ЛИ ПОИСК
  const recentHistory = history.slice(-5).map(m => `${m.role}: ${m.text}`).join('\n');
  const searchDecision = await this.checkSearchNeeded(
      currentMessage.text,
      recentHistory,
      chatProfile?.topic || null
  );

  let searchResultText = "";

  if (searchDecision.needsSearch && searchDecision.searchQuery) {
      // 2. ПОИСК ЧЕРЕЗ TAVILY / PERPLEXITY
      if (config.searchProvider !== 'google') {
          searchResultText = await this.performSearch(searchDecision.searchQuery);
      }

      // 3. FALLBACK НА GOOGLE NATIVE SEARCH
      // Если Tavily/Perplexity недоступен или провайдер = google
      if (!searchResultText && this.keys.length > 0) {
          console.log(`[ROUTER] Switching to Google Native Search.`);
          return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous, chatProfile);
      }
  }

  // 2. СБОРКА ПРОМПТА
  const relevantHistory = history.slice(-20); 
  const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
  let personalInfo = "";
  let replyContext = "";

  if (currentMessage.replyText) replyContext = responses.ai.replyContext(currentMessage.replyText);
  if (userInstruction) personalInfo += responses.ai.specialInstruction(userInstruction);
  
  if (searchResultText) {
      personalInfo += responses.ai.searchData(config.searchProvider, searchResultText);
  }

  if (userProfile) {
      const score = userProfile.relationship || 50;
      let relationText = score <= 20 ? responses.ai.relationStatus.enemy : score >= 80 ? responses.ai.relationStatus.friend : responses.ai.relationStatus.neutral;
      personalInfo += `${responses.ai.dossier.header}${responses.ai.dossier.factsLabel}${userProfile.facts || responses.ai.dossier.noFacts}\n`;
      if (userProfile.location) personalInfo += `${responses.ai.dossier.locationLabel}${userProfile.location}\n`;
      personalInfo += `${relationText}\n${responses.ai.dossier.footer}`;
  }

  const fullPromptText = prompts.mainChat({
      time: this.getCurrentTime(),
      isSpontaneous: isSpontaneous,
      userMessage: currentMessage.text,
      replyContext: replyContext,
      history: contextStr,
      personalInfo: personalInfo,
      senderName: currentMessage.sender,
      chatContext: chatProfile
  });

  // 3. ЗАПРОС К SMART МОДЕЛИ (API)
  if (this.openai) {
      try {
          const messages = [{ role: "system", content: prompts.system() }, { role: "user", content: [] }];
          messages[1].content.push({ type: "text", text: fullPromptText });
          if (imageBuffer) {
              messages[1].content.push({
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` }
              });
          }

          const completion = await this.openai.chat.completions.create({
              model: config.mainModel,
              messages: messages,
              max_tokens: 2500,
              temperature: 0.9,
          });
          
          storage.incrementStat('smart'); 
          return completion.choices[0].message.content.replace(/^thought[\s\S]*?\n\n/i, ''); 
      } catch (e) {
          console.error(`[API SMART FAIL] ${e.message}. Fallback to Native...`);
      }
  }

  // 4. FALLBACK (Если API упал или ключа нет)
  return this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous, chatProfile);
}

// Helper для Native вызова (чтобы не дублировать код)
async generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous, chatProfile = null) {
    const relevantHistory = history.slice(-20);
    const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');

    // Собираем полную информацию о пользователе (как в основном методе)
    let personalInfo = "";
    let replyContext = "";

    if (currentMessage.replyText) replyContext = responses.ai.replyContext(currentMessage.replyText);
    if (userInstruction) personalInfo += responses.ai.specialInstruction(userInstruction);

    if (userProfile) {
        const score = userProfile.relationship || 50;
        let relationText = score <= 20 ? responses.ai.relationStatus.enemy : score >= 80 ? responses.ai.relationStatus.friend : responses.ai.relationStatus.neutral;
        personalInfo += `${responses.ai.dossier.header}${responses.ai.dossier.factsLabel}${userProfile.facts || responses.ai.dossier.noFacts}\n`;
        if (userProfile.location) personalInfo += `${responses.ai.dossier.locationLabel}${userProfile.location}\n`;
        personalInfo += `${relationText}\n${responses.ai.dossier.footer}`;
    }

    const fullPromptText = prompts.mainChat({
        time: this.getCurrentTime(),
        isSpontaneous: isSpontaneous,
        userMessage: currentMessage.text,
        replyContext: replyContext,
        history: contextStr,
        personalInfo: personalInfo,
        senderName: currentMessage.sender,
        chatContext: chatProfile
    });

    return this.executeNativeWithRetry(async () => {
      let promptParts = [];
      if (imageBuffer) promptParts.push({ inlineData: { mimeType: mimeType, data: imageBuffer.toString("base64") } });
      promptParts.push({ text: fullPromptText });

      const result = await this.nativeModel.generateContent({
          contents: [{ role: 'user', parts: promptParts }],
          generationConfig: { maxOutputTokens: 2500, temperature: 0.9 }
      });
      
      let text = result.response.text();
      if (result.response.candidates[0].groundingMetadata?.groundingChunks) {
           const links = result.response.candidates[0].groundingMetadata.groundingChunks
              .filter(c => c.web?.uri).map(c => `[${c.web.title || responses.ai.sourceLinkTitle}](${c.web.uri})`);
           const unique = [...new Set(links)].slice(0, 3);
           if (unique.length > 0) text += responses.ai.sourceLinksPrefix + unique.join(responses.ai.sourceLinksJoiner);
      }
      return text;
    });
}

// === ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ (LOGIC MODEL) ===
  
  // Универсальный метод для логики
  async runLogicModel(promptJson) {
    // 1. Пробуем через API (Logic Model)
    if (this.openai) {
        try {
            const completion = await this.openai.chat.completions.create({
                model: config.logicModel,
                messages: [{ role: "user", content: promptJson }],
                response_format: { type: "json_object" }
            });
            storage.incrementStat('logic');
            return JSON.parse(completion.choices[0].message.content);
        } catch (e) {}
    }
    // 2. Fallback Native
    try {
        return await this.executeNativeWithRetry(async () => {
           const result = await this.nativeModel.generateContent(promptJson);
           let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
           const first = text.indexOf('{'), last = text.lastIndexOf('}');
           if (first !== -1 && last !== -1) text = text.substring(first, last + 1);
           return JSON.parse(text);
        });
    } catch (e) { return null; }
}

// Простой текстовый ответ (для реакций и ShouldAnswer)
async runLogicText(promptText) {
    if (this.openai) {
        try {
          const completion = await this.openai.chat.completions.create({
              model: config.logicModel,
              messages: [{ role: "user", content: promptText }]
          });
          storage.incrementStat('logic');
          return completion.choices[0].message.content;
        } catch (e) {}
    }
    return null; 
}

async analyzeUserImmediate(lastMessages, currentProfile) {
    return this.runLogicModel(prompts.analyzeImmediate(currentProfile, lastMessages));
}

// Определение необходимости поиска (AI-решение вместо regex)
async checkSearchNeeded(userMessage, recentHistory, chatTopic) {
    const prompt = prompts.shouldSearch(
        this.getCurrentTime(),
        userMessage,
        recentHistory,
        chatTopic
    );

    try {
        const result = await this.runLogicModel(prompt);
        if (result && typeof result.needsSearch === 'boolean') {
            console.log(`[SEARCH CHECK] needsSearch=${result.needsSearch}, query="${result.searchQuery}", reason="${result.reason}"`);
            return result;
        }
    } catch (e) {
        console.error(`[SEARCH CHECK ERROR] ${e.message}`);
    }

    // Fallback: не искать если AI не ответил
    return { needsSearch: false, searchQuery: null, reason: responses.ai.searchFallbackReason };
}

async analyzeBatch(messagesBatch, currentProfiles) {
    const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
    const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');
    return this.runLogicModel(prompts.analyzeBatch(knownInfo, chatLog));
}

// Анализ профиля чата (каждые 50 сообщений)
async analyzeChatProfile(messagesBatch, currentProfile) {
    const messagesText = messagesBatch.map(m => `${m.name}: ${m.text}`).join('\n');
    return this.runLogicModel(prompts.analyzeChatProfile(currentProfile, messagesText));
}

// Обработка ручного описания чата (команда "Сыч, этот чат про...")
async processManualChatDescription(description, currentProfile) {
    return this.runLogicModel(prompts.processManualChatDescription(description, currentProfile));
}

async determineReaction(contextText) {
  const allowed = ["👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
  const text = await this.runLogicText(prompts.reaction(contextText, allowed.join(" ")));
  if (!text) return null;
  const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
  return (match && allowed.includes(match[0])) ? match[0] : null;
}

async generateProfileDescription(profileData, targetName) {
    if (this.openai) {
      try {
          const completion = await this.openai.chat.completions.create({ model: config.mainModel, messages: [{ role: "user", content: prompts.profileDescription(targetName, profileData) }] });
          storage.incrementStat('smart'); return completion.choices[0].message.content;
      } catch(e) {}
    }
    return responses.ai.unknownProfile;
}

async generateFlavorText(task, result) {
  if (this.openai) {
      try {
          const completion = await this.openai.chat.completions.create({ model: config.mainModel, messages: [{ role: "user", content: prompts.flavor(task, result) }] });
          storage.incrementStat('smart'); return completion.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
      } catch(e) {}
  }
  return `${result}`;
}

  // === ТРАНСКРИБАЦИЯ ===
  async transcribeAudio(audioBuffer, userName, mimeType) {
    // Только Native поддерживает загрузку файлов из буфера так легко и бесплатно
    if (!this.keys || this.keys.length === 0) {
        console.warn("[AI WARN] Voice received, but there are no Google keys for transcription. Skipping.");
        return null;
    }

    try {
        return await this.executeNativeWithRetry(async () => {
          const parts = [ { inlineData: { mimeType: mimeType, data: audioBuffer.toString("base64") } }, { text: prompts.transcription(userName) }];
          const result = await this.nativeModel.generateContent(parts);
          let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
          const first = text.indexOf('{'), last = text.lastIndexOf('}');
          if (first !== -1 && last !== -1) text = text.substring(first, last + 1);
          return JSON.parse(text);
        });
    } catch (e) { 
        console.error(`[TRANSCRIPTION FAIL] ${e.message}`);
        return null; 
    }
  }

  // === ПАРСИНГ НАПОМИНАНИЯ (С КОНТЕКСТОМ) ===
  async parseReminder(userText, contextText = "") {
    const now = this.getCurrentTime();
    const prompt = prompts.parseReminder(now, userText, contextText);
    return this.runLogicModel(prompt);
  }
}

module.exports = new AiService();
