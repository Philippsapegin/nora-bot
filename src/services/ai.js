const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const config = require('../config');
const prompts = require('../core/prompts');
const { responses } = require('../core/personality');
const axios = require('axios');
const OpenAI = require('openai');
const { tavily } = require('@tavily/core'); // Р С™Р В»Р С‘Р ВµР Р…РЎвЂљ Tavily
const storage = require('./storage');
const loreMemory = require('./loreMemory');

class AiService {
  constructor() {
    // 1. Основной OpenAI-совместимый клиент
    const openaiOptions = {
        baseURL: config.aiBaseUrl,
        apiKey: config.aiKey
    };
    if (config.aiBaseUrl.includes('openrouter.ai')) {
        openaiOptions.defaultHeaders = {
            "HTTP-Referer": "https://github.com/Veta-one/sych-bot",
            "X-Title": responses.identity.botTitle
        };
    }
    this.openai = config.aiKey ? new OpenAI(openaiOptions) : null;

    // 2. Р ВР Р…Р С‘РЎвЂ Р С‘Р В°Р В»Р С‘Р В·Р В°РЎвЂ Р С‘РЎРЏ Tavily
    this.tavilyClient = config.tavilyKey ? tavily({ apiKey: config.tavilyKey }) : null;

    // 3. Google Native (Fallback)
    this.keyIndex = 0;
    this.keys = config.geminiKeys;
    this.usingFallback = false;
    this.nativeModel = null;
    this.nativeSearchModel = null;
    this.nativePromptDate = null;
    this.bot = null;

    // === Р РЋР СћР С’Р СћР ВР РЋР СћР ВР С™Р С’ (РЎвЂљР ВµР С—Р ВµРЎР‚РЎРЉ Р С—Р ВµРЎР‚РЎРѓР С‘РЎРѓРЎвЂљР ВµР Р…РЎвЂљР Р…Р В°РЎРЏ РЎвЂЎР ВµРЎР‚Р ВµР В· storage) ===
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

  // Р РЋР В±РЎР‚Р С•РЎРѓ РЎРѓРЎвЂљР В°РЎвЂљР С‘РЎРѓРЎвЂљР С‘Р С”Р С‘ Р Р† Р С—Р С•Р В»Р Р…Р С•РЎвЂЎРЎРЉ (Р С—РЎР‚Р С•Р Р†Р ВµРЎР‚Р С”Р В° РЎвЂЎР ВµРЎР‚Р ВµР В· storage)
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
    if (this.keys.length === 0) {
      this.nativeModel = null;
      this.nativeSearchModel = null;
      return;
    }
    const currentKey = this.keys[this.keyIndex];
    const genAI = new GoogleGenerativeAI(currentKey);
    
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    // Р ВРЎРѓР С—Р С•Р В»РЎРЉР В·РЎС“Р ВµР С Fallback Р СР С•Р Т‘Р ВµР В»РЎРЉ Р С‘Р В»Р С‘ РЎРѓРЎвЂљР В°Р Р…Р Т‘Р В°РЎР‚РЎвЂљР Р…РЎС“РЎР‹ Flash (Р С•Р Р…Р В° Р Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р Р…Р В° Р Р† Р Р…Р В°РЎвЂљР С‘Р Р†Р Вµ)
    const modelName = this.usingFallback ? config.fallbackModelName : config.googleNativeModel;
    console.log(`[AI INIT] Native Key #${this.keyIndex + 1} | Model: ${modelName}`);

    this.nativeModel = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: prompts.system(),
        safetySettings: safetySettings
    });
    this.nativePromptDate = this.getEkaterinburgDateKey();

    this.nativeSearchModel = genAI.getGenerativeModel({
        model: config.googleNativeModel,
        safetySettings: safetySettings,
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
    if (this.keys.length === 0) throw new Error("Google Native fallback is not configured.");
    const maxAttempts = this.keys.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            storage.incrementGoogleStat(this.keyIndex);
            return await apiCallFn();
        } catch (error) {
            const message = String(error.message || error);
            const isRetryableKeyError = message.includes('429')
                || message.includes('Quota')
                || message.includes('403')
                || message.includes('API_KEY_INVALID')
                || message.includes('API key not valid');
            if (isRetryableKeyError) {
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
      weekday: 'short', // Р РЋР С•Р С”РЎР‚Р В°РЎвЂљР С‘Р С Р Т‘Р С• Р СџРЎвЂљ, Р СџР Р… (РЎРЊР С”Р С•Р Р…Р С•Р СР С‘Р С РЎвЂљР С•Р С”Р ВµР Р…РЎвЂ№)
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    // Р Р‡Р Р†Р Р…Р С• РЎС“Р С”Р В°Р В·РЎвЂ№Р Р†Р В°Р ВµР С Р В±Р В°Р В·РЎС“ Р Т‘Р В»РЎРЏ РЎР‚Р В°РЎРѓРЎвЂЎР ВµРЎвЂљР С•Р Р†
    return `${time} (UTC+5)`;
  }

  getEkaterinburgDateKey() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Yekaterinburg',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  ensureNativePromptIsCurrent() {
    if (this.nativeModel && this.nativePromptDate !== this.getEkaterinburgDateKey()) {
      this.initNativeModel();
    }
  }

// === Р Р€Р СњР ВР вЂ™Р вЂўР В Р РЋР С’Р вЂєР В¬Р СњР В«Р в„ў Р СџР С›Р ВР РЋР С™ ===
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

  if (config.searchProvider === 'google') {
      return this.performGoogleSearch(query);
  }
  
  return null;
}

async performGoogleSearch(query) {
  if (!this.nativeSearchModel) return null;

  try {
      console.log(`[SEARCH] Google query: ${query}`);
      const result = await this.executeNativeWithRetry(() => this.nativeSearchModel.generateContent({
          contents: [{
              role: 'user',
              parts: [{ text: responses.ai.googleSearchPrompt(this.getCurrentTime(), query) }]
          }]
      }));

      let text = result.response.text();
      const groundingChunks = result.response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const links = groundingChunks
          .filter(chunk => chunk.web?.uri)
          .map(chunk => `[${chunk.web.title || responses.ai.sourceLinkTitle}](${chunk.web.uri})`);
      const uniqueLinks = [...new Set(links)].slice(0, 5);
      if (uniqueLinks.length > 0) text += responses.ai.sourceLinksPrefix + uniqueLinks.join(responses.ai.sourceLinksJoiner);

      storage.incrementStat('search');
      return text;
  } catch (error) {
      console.error(`[GOOGLE SEARCH FAIL] ${error.message}`);
      return null;
  }
}
  
// === Р С›Р РЋР СњР С›Р вЂ™Р СњР С›Р в„ў Р С›Р СћР вЂ™Р вЂўР Сћ ===
async getResponse(history, currentMessage, imageBuffer = null, mimeType = "image/jpeg", userInstruction = "", userProfile = null, isSpontaneous = false) {
  this.resetStatsIfNeeded();
  console.log(`[DEBUG AI] getResponse called.`);

  // 1. AI Р С›Р СџР В Р вЂўР вЂќР вЂўР вЂєР Р‡Р вЂўР Сћ Р СњР Р€Р вЂ“Р вЂўР Сњ Р вЂєР В Р СџР С›Р ВР РЋР С™
  const recentHistory = history.slice(-5).map(m => `${m.role}: ${m.text}`).join('\n');
  const loreQuery = [currentMessage.text, currentMessage.replyText, recentHistory].filter(Boolean).join('\n');
  const relevantLore = loreMemory.findRelevant(loreQuery);
  const loreContext = loreMemory.formatMemories(relevantLore);
  const matchedLoreTitles = relevantLore.map(memory => memory.title).join(', ');
  if (relevantLore.length > 0) {
      console.log(`[LORE] matched=${relevantLore.map(memory => memory.id).join(',')}`);
  }
  const searchDecision = await this.checkSearchNeeded(
      currentMessage.text,
      recentHistory,
      matchedLoreTitles
  );

  let searchResultText = "";
  let searchProviderUsed = null;
  let searchUnavailable = false;

  if (searchDecision.needsSearch && searchDecision.searchQuery) {
      // 2. Р СџР С›Р ВР РЋР С™ Р В§Р вЂўР В Р вЂўР вЂ” TAVILY / PERPLEXITY
      searchResultText = await this.performSearch(searchDecision.searchQuery);
      if (searchResultText) searchProviderUsed = config.searchProvider;

      // 3. FALLBACK Р СњР С’ GOOGLE NATIVE SEARCH
      // Р вЂўРЎРѓР В»Р С‘ Tavily/Perplexity Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р… Р С‘Р В»Р С‘ Р С—РЎР‚Р С•Р Р†Р В°Р в„–Р Т‘Р ВµРЎР‚ = google
      if (!searchResultText && config.searchProvider !== 'google' && this.nativeSearchModel) {
          console.log(`[SEARCH] ${config.searchProvider} unavailable, trying Google Search.`);
          searchResultText = await this.performGoogleSearch(searchDecision.searchQuery);
          if (searchResultText) searchProviderUsed = 'google';
      }

      searchUnavailable = !searchResultText;
  }

  // 2. Р РЋР вЂР С›Р В Р С™Р С’ Р СџР В Р С›Р СљР СџР СћР С’
  const relevantHistory = history.slice(-20); 
  const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
  let personalInfo = "";
  let replyContext = "";

  if (currentMessage.replyText) replyContext = responses.ai.replyContext(currentMessage.replyText);
  if (userInstruction) personalInfo += responses.ai.specialInstruction(userInstruction);
  
  if (searchResultText) {
      personalInfo += responses.ai.searchData(searchProviderUsed || config.searchProvider, searchResultText);
  } else if (searchUnavailable) {
      personalInfo += responses.ai.searchUnavailable;
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
      loreMemories: loreContext,
      isInterviewer: String(currentMessage.userId) === String(config.interviewerUserId),
      isConversationStart: !history.some(message => message.role === responses.identity.botName),
      personalInfo: personalInfo,
      senderName: currentMessage.sender
  });

  // 3. Р вЂ”Р С’Р СџР В Р С›Р РЋ Р С™ SMART Р СљР С›Р вЂќР вЂўР вЂєР В (API)
  let primaryError = null;
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

          const request = {
              model: config.mainModel,
              messages: messages
          };

          if (config.usesOfficialOpenAI) {
              request.max_completion_tokens = 2500;
          } else {
              request.max_tokens = 2500;
              request.temperature = 0.9;
          }

          const completion = await this.openai.chat.completions.create(request);
          
          storage.incrementStat('smart');
          console.log(`[AI SMART] model=${completion.model || config.mainModel}`);
          return completion.choices[0].message.content.replace(/^thought[\s\S]*?\n\n/i, ''); 
      } catch (e) {
          console.error(`[API SMART FAIL] ${e.message}. Fallback to Native...`);
          primaryError = e;
      }
  }

  if (this.nativeModel) {
      try {
          return await this.generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous);
      } catch (nativeError) {
          console.error(`[NATIVE FALLBACK FAIL] ${nativeError.message}`);
          if (!primaryError) primaryError = nativeError;
      }
  }

  throw primaryError || new Error("No AI provider is available.");
}

// Helper Р Т‘Р В»РЎРЏ Native Р Р†РЎвЂ№Р В·Р С•Р Р†Р В° (РЎвЂЎРЎвЂљР С•Р В±РЎвЂ№ Р Р…Р Вµ Р Т‘РЎС“Р В±Р В»Р С‘РЎР‚Р С•Р Р†Р В°РЎвЂљРЎРЉ Р С”Р С•Р Т‘)
async generateViaNative(history, currentMessage, imageBuffer, mimeType, userInstruction, userProfile, isSpontaneous) {
    this.ensureNativePromptIsCurrent();
    const relevantHistory = history.slice(-20);
    const contextStr = relevantHistory.map(m => `${m.role}: ${m.text}`).join('\n');
    const loreQuery = [currentMessage.text, currentMessage.replyText, contextStr].filter(Boolean).join('\n');
    const relevantLore = loreMemory.findRelevant(loreQuery);
    const loreContext = loreMemory.formatMemories(relevantLore);

    // Р РЋР С•Р В±Р С‘РЎР‚Р В°Р ВµР С Р С—Р С•Р В»Р Р…РЎС“РЎР‹ Р С‘Р Р…РЎвЂћР С•РЎР‚Р СР В°РЎвЂ Р С‘РЎР‹ Р С• Р С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°РЎвЂљР ВµР В»Р Вµ (Р С”Р В°Р С” Р Р† Р С•РЎРѓР Р…Р С•Р Р†Р Р…Р С•Р С Р СР ВµРЎвЂљР С•Р Т‘Р Вµ)
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
        loreMemories: loreContext,
        isInterviewer: String(currentMessage.userId) === String(config.interviewerUserId),
        isConversationStart: !history.some(message => message.role === responses.identity.botName),
        personalInfo: personalInfo,
        senderName: currentMessage.sender
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

// === Р вЂ™Р РЋР СџР С›Р СљР С›Р вЂњР С’Р СћР вЂўР вЂєР В¬Р СњР В«Р вЂў Р СљР вЂўР СћР С›Р вЂќР В« (LOGIC MODEL) ===
  
  // Р Р€Р Р…Р С‘Р Р†Р ВµРЎР‚РЎРѓР В°Р В»РЎРЉР Р…РЎвЂ№Р в„– Р СР ВµРЎвЂљР С•Р Т‘ Р Т‘Р В»РЎРЏ Р В»Р С•Р С–Р С‘Р С”Р С‘
  async runLogicModel(promptJson) {
    // 1. Р СџРЎР‚Р С•Р В±РЎС“Р ВµР С РЎвЂЎР ВµРЎР‚Р ВµР В· API (Logic Model)
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

// Р СџРЎР‚Р С•РЎРѓРЎвЂљР С•Р в„– РЎвЂљР ВµР С”РЎРѓРЎвЂљР С•Р Р†РЎвЂ№Р в„– Р С•РЎвЂљР Р†Р ВµРЎвЂљ (Р Т‘Р В»РЎРЏ РЎР‚Р ВµР В°Р С”РЎвЂ Р С‘Р в„– Р С‘ ShouldAnswer)
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

// Р С›Р С—РЎР‚Р ВµР Т‘Р ВµР В»Р ВµР Р…Р С‘Р Вµ Р Р…Р ВµР С•Р В±РЎвЂ¦Р С•Р Т‘Р С‘Р СР С•РЎРѓРЎвЂљР С‘ Р С—Р С•Р С‘РЎРѓР С”Р В° (AI-РЎР‚Р ВµРЎв‚¬Р ВµР Р…Р С‘Р Вµ Р Р†Р СР ВµРЎРѓРЎвЂљР С• regex)
async checkSearchNeeded(userMessage, recentHistory, matchedLoreTitles = '') {
    const fallback = { needsSearch: false, searchQuery: null, reason: responses.ai.searchFallbackReason };

    try {
        const prompt = prompts.shouldSearch(
            this.getCurrentTime(),
            userMessage,
            recentHistory,
            matchedLoreTitles
        );
        const result = await this.runLogicModel(prompt);
        if (!result || typeof result !== 'object' || typeof result.needsSearch !== 'boolean') return fallback;

        const searchQuery = typeof result.searchQuery === 'string' && result.searchQuery.trim()
            ? result.searchQuery.trim().slice(0, 500)
            : null;

        if (result.needsSearch && !searchQuery) return fallback;

        const normalized = {
            needsSearch: result.needsSearch,
            searchQuery: result.needsSearch ? searchQuery : null,
            reason: typeof result.reason === 'string' ? result.reason.slice(0, 100) : 'unspecified'
        };

        console.log(`[SEARCH CHECK] needsSearch=${normalized.needsSearch}, query="${normalized.searchQuery}", reason="${normalized.reason}"`);
        return normalized;
    } catch (e) {
        console.error(`[SEARCH CHECK ERROR] ${e.message}`);
    }

    // Fallback: Р Р…Р Вµ Р С‘РЎРѓР С”Р В°РЎвЂљРЎРЉ Р ВµРЎРѓР В»Р С‘ AI Р Р…Р Вµ Р С•РЎвЂљР Р†Р ВµРЎвЂљР С‘Р В»
    return fallback;
}

async analyzeBatch(messagesBatch, currentProfiles) {
    const chatLog = messagesBatch.map(m => `[ID:${m.userId}] ${m.name}: ${m.text}`).join('\n');
    const knownInfo = Object.entries(currentProfiles).map(([uid, p]) => `ID:${uid} -> ${p.realName}, ${p.facts}, ${p.attitude}`).join('\n');
    return this.runLogicModel(prompts.analyzeBatch(knownInfo, chatLog));
}

// Р С’Р Р…Р В°Р В»Р С‘Р В· Р С—РЎР‚Р С•РЎвЂћР С‘Р В»РЎРЏ РЎвЂЎР В°РЎвЂљР В° (Р С”Р В°Р В¶Р Т‘РЎвЂ№Р Вµ 50 РЎРѓР С•Р С•Р В±РЎвЂ°Р ВµР Р…Р С‘Р в„–)
async analyzeChatProfile(messagesBatch, currentProfile) {
    if (!Array.isArray(messagesBatch) || messagesBatch.length === 0) return null;

    const messagesText = messagesBatch.map(m => `${m.name}: ${m.text}`).join('\n');
    try {
        const result = await this.runLogicModel(prompts.analyzeChatProfile(currentProfile, messagesText));
        if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

        const normalized = {};
        const limits = { topic: 200, facts: 500 };

        for (const [field, limit] of Object.entries(limits)) {
            if (result[field] === null) continue;
            if (typeof result[field] !== 'string') return null;

            const value = result[field].trim();
            if (value) normalized[field] = value.slice(0, limit);
        }

        return Object.keys(normalized).length > 0 ? normalized : null;
    } catch (e) {
        console.error(`[CHAT PROFILE ANALYSIS ERROR] ${e.message}`);
        return null;
    }
}

// Р С›Р В±РЎР‚Р В°Р В±Р С•РЎвЂљР С”Р В° РЎР‚РЎС“РЎвЂЎР Р…Р С•Р С–Р С• Р С•Р С—Р С‘РЎРѓР В°Р Р…Р С‘РЎРЏ РЎвЂЎР В°РЎвЂљР В° (Р С”Р С•Р СР В°Р Р…Р Т‘Р В° "Р РЋРЎвЂ№РЎвЂЎ, РЎРЊРЎвЂљР С•РЎвЂљ РЎвЂЎР В°РЎвЂљ Р С—РЎР‚Р С•...")
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
          const completion = await this.openai.chat.completions.create({
              model: config.mainModel,
              messages: [
                  { role: "system", content: prompts.system() },
                  { role: "user", content: prompts.profileDescription(targetName, profileData) }
              ]
          });
          storage.incrementStat('smart'); return completion.choices[0].message.content;
      } catch(e) {}
    }
    return responses.ai.unknownProfile;
}

  // === Р СћР В Р С’Р СњР РЋР С™Р В Р ВР вЂР С’Р В¦Р ВР Р‡ ===
    // Р СћР С•Р В»РЎРЉР С”Р С• Native Р С—Р С•Р Т‘Р Т‘Р ВµРЎР‚Р В¶Р С‘Р Р†Р В°Р ВµРЎвЂљ Р В·Р В°Р С–РЎР‚РЎС“Р В·Р С”РЎС“ РЎвЂћР В°Р в„–Р В»Р С•Р Р† Р С‘Р В· Р В±РЎС“РЎвЂћР ВµРЎР‚Р В° РЎвЂљР В°Р С” Р В»Р ВµР С–Р С”Р С• Р С‘ Р В±Р ВµРЎРѓР С—Р В»Р В°РЎвЂљР Р…Р С•

  // === Р СџР С’Р В Р РЋР ВР СњР вЂњ Р СњР С’Р СџР С›Р СљР ВР СњР С’Р СњР ВР Р‡ (Р РЋ Р С™Р С›Р СњР СћР вЂўР С™Р РЋР СћР С›Р Сљ) ===
}

module.exports = new AiService();
