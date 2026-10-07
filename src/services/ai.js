const config = require('../config');
const prompts = require('../core/prompts');
const { responses } = require('../core/personality');
const OpenAI = require('openai');
const { tavily } = require('@tavily/core');
const storage = require('./storage');
const loreMemory = require('./loreMemory');
const { GeminiService, thinkingConfigFor, responseText } = require('./gemini');

class AiService {
  constructor() {
    const openaiOptions = { baseURL: config.aiBaseUrl, apiKey: config.aiKey };
    if (config.aiBaseUrl.includes('openrouter.ai')) {
      openaiOptions.defaultHeaders = {
        'HTTP-Referer': 'https://github.com/Veta-one/sych-bot',
        'X-Title': responses.identity.botTitle,
      };
    }
    // A retained OpenAI key must not silently keep Luna as the main model.
    this.openai = config.aiKey && (config.aiProvider === 'openai' || config.searchProvider === 'perplexity')
      ? new OpenAI(openaiOptions) : null;
    this.tavilyClient = config.tavilyKey ? tavily({ apiKey: config.tavilyKey }) : null;
    this.keys = config.geminiKeys;
    this.usingFallback = false;
    this.bot = null;
    storage.initGoogleStats(this.keys.length);
    this.google = new GeminiService({
      keys: this.keys,
      onAttempt: (keyIndex, model) => {
        storage.incrementGoogleStat(keyIndex);
        console.log('[AI GOOGLE] model=' + model + ' key=#' + (keyIndex + 1));
      },
      onKeyExhausted: (keyIndex, model) => {
        storage.markGoogleKeyExhausted(keyIndex);
        console.warn('[AI GOOGLE] key #' + (keyIndex + 1) + ' unavailable for ' + model);
      },
      onAllExhausted: model => this.notifyAdmin(model + ': ' + responses.ai.allGoogleKeysExhausted),
    });
    console.log('[AI INIT] provider=' + config.aiProvider + ' main=' + config.mainModel
      + ' logic=' + config.logicModel + ' fallback=' + config.fallbackModelName
      + ' search=' + config.googleSearchModel + ' keys=' + this.keys.length);
  }

  setBot(botInstance) { this.bot = botInstance; }

  notifyAdmin(message) {
    if (this.bot && config.adminId) {
      this.bot.sendMessage(config.adminId, message).catch(() => {});
    }
  }

  resetStatsIfNeeded() {
    if (storage.resetStatsIfNeeded()) {
      this.google.resetKeyIndices();
      this.usingFallback = false;
    }
  }

  getStatsReport() {
    this.resetStatsIfNeeded();
    return responses.ai.formatStatsReport({
      ...storage.getFullStats(),
      usingFallback: this.usingFallback,
      formatNumber: value => this._formatNumber(value),
    });
  }

  _formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }

  getCurrentTime() {
    return new Date().toLocaleString('ru-RU', {
      timeZone: 'Asia/Yekaterinburg', weekday: 'short', year: 'numeric',
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' (UTC+5)';
  }

  appendSources(text, result) {
    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const links = chunks.filter(chunk => chunk.web?.uri)
      .map(chunk => '[' + (chunk.web.title || responses.ai.sourceLinkTitle) + '](' + chunk.web.uri + ')');
    const unique = [...new Set(links)].slice(0, 5);
    return unique.length ? text + responses.ai.sourceLinksPrefix + unique.join(responses.ai.sourceLinksJoiner) : text;
  }

  async performSearch(query) {
    this.resetStatsIfNeeded();
    if (config.searchProvider === 'tavily' && this.tavilyClient) {
      try {
        const result = await this.tavilyClient.search(query, {
          search_depth: 'advanced', max_results: 3, include_answer: true,
        });
        storage.incrementStat('search');
        let text = result.answer ? responses.ai.tavilyAnswerPrefix + result.answer + '\n\n' : '';
        result.results.forEach((item, index) => {
          text += '[' + (index + 1) + '] ' + item.title + ' (' + item.url + '):\n' + item.content + '\n\n';
        });
        return text;
      } catch (error) {
        console.error('[TAVILY FAIL] ' + error.message);
        return null;
      }
    }
    if (config.searchProvider === 'perplexity' && this.openai) {
      try {
        const completion = await this.openai.chat.completions.create({
          model: config.perplexityModel,
          messages: [
            { role: 'system', content: responses.ai.perplexitySearchSystemPrompt(this.getCurrentTime()) },
            { role: 'user', content: query },
          ],
          temperature: 0.1,
        });
        storage.incrementStat('search');
        return completion.choices[0].message.content;
      } catch (error) {
        console.error('[PERPLEXITY FAIL] ' + error.message);
        return null;
      }
    }
    return config.searchProvider === 'google' ? this.performGoogleSearch(query) : null;
  }

  async performGoogleSearch(query) {
    if (!this.keys.length) return null;
    try {
      const result = await this.google.generateContent({
        model: config.googleSearchModel,
        contents: responses.ai.googleSearchPrompt(this.getCurrentTime(), query),
        config: {
          tools: [{ googleSearch: {} }],
          maxOutputTokens: 2500,
          thinkingConfig: thinkingConfigFor(config.googleSearchModel),
        },
      });
      const text = this.appendSources(responseText(result), result);
      storage.incrementStat('search');
      return text;
    } catch (error) {
      console.error('[GOOGLE SEARCH FAIL] ' + error.message);
      return null;
    }
  }

  async generateGoogleReply(fullPromptText, imageBuffer = null, mimeType = 'image/jpeg') {
    const parts = [{ text: fullPromptText }];
    if (imageBuffer) parts.push({ inlineData: { mimeType, data: imageBuffer.toString('base64') } });
    const mainModel = config.aiProvider === 'google' ? config.mainModel : config.googleNativeModel;
    const models = [...new Set([mainModel, config.fallbackModelName].filter(Boolean))];
    let lastError;
    for (const [index, model] of models.entries()) {
      try {
        const result = await this.google.generateContent({
          model,
          contents: [{ role: 'user', parts }],
          config: {
            // Fresh on every call: picks up Wednesday and the local personality.
            systemInstruction: prompts.system(),
            maxOutputTokens: 4096,
            temperature: 1,
            thinkingConfig: thinkingConfigFor(model),
          },
        });
        const text = responseText(result);
        this.usingFallback = index > 0;
        storage.incrementStat('smart');
        console.log('[AI SMART] model=' + model + ' fallback=' + this.usingFallback);
        return text;
      } catch (error) {
        lastError = error;
        console.error('[AI GOOGLE FAIL] model=' + model + ' ' + error.message);
      }
    }
    throw lastError || new Error('No Google conversational model is configured.');
  }

  async getResponse(history, currentMessage, imageBuffer = null, mimeType = 'image/jpeg', userInstruction = '', userProfile = null, isSpontaneous = false) {
    this.resetStatsIfNeeded();
    const recentHistory = history.slice(-5).map(message => message.role + ': ' + message.text).join('\n');
    const loreQuery = [currentMessage.text, currentMessage.replyText, recentHistory].filter(Boolean).join('\n');
    const relevantLore = loreMemory.findRelevant(loreQuery);
    if (relevantLore.length) console.log('[LORE] matched=' + relevantLore.map(memory => memory.id).join(','));
    const searchDecision = await this.checkSearchNeeded(
      currentMessage.text, recentHistory, relevantLore.map(memory => memory.title).join(','),
    );
    let searchResultText = '';
    let searchProviderUsed = null;
    let searchUnavailable = false;
    if (searchDecision.needsSearch && searchDecision.searchQuery) {
      searchResultText = await this.performSearch(searchDecision.searchQuery);
      if (searchResultText) searchProviderUsed = config.searchProvider;
      if (!searchResultText && config.searchProvider !== 'google' && this.keys.length) {
        searchResultText = await this.performGoogleSearch(searchDecision.searchQuery);
        if (searchResultText) searchProviderUsed = 'google';
      }
      searchUnavailable = !searchResultText;
    }
    let personalInfo = userInstruction ? responses.ai.specialInstruction(userInstruction) : '';
    if (searchResultText) {
      personalInfo += responses.ai.searchData(searchProviderUsed || config.searchProvider, searchResultText);
    } else if (searchUnavailable) {
      personalInfo += responses.ai.searchUnavailable;
    }
    if (userProfile) {
      const score = userProfile.relationship || 50;
      const relation = score <= 20 ? 'enemy' : score >= 80 ? 'friend' : 'neutral';
      personalInfo += responses.ai.dossier.header + responses.ai.dossier.factsLabel
        + (userProfile.facts || responses.ai.dossier.noFacts) + '\n';
      if (userProfile.location) personalInfo += responses.ai.dossier.locationLabel + userProfile.location + '\n';
      personalInfo += responses.ai.relationStatus[relation] + '\n' + responses.ai.dossier.footer;
    }
    const fullPromptText = prompts.mainChat({
      time: this.getCurrentTime(), isSpontaneous,
      userMessage: currentMessage.text,
      replyContext: currentMessage.replyText ? responses.ai.replyContext(currentMessage.replyText) : '',
      history: history.slice(-config.contextSize).map(message => message.role + ': ' + message.text).join('\n'),
      loreMemories: loreMemory.formatMemories(relevantLore),
      isInterviewer: String(currentMessage.userId) === String(config.interviewerUserId),
      isConversationStart: !history.some(message => message.role === responses.identity.botName),
      personalInfo, senderName: currentMessage.sender,
    });
    if (config.aiProvider === 'google') {
      return this.generateGoogleReply(fullPromptText, imageBuffer, mimeType);
    }
    let primaryError;
    if (this.openai) {
      try {
        const content = [{ type: 'text', text: fullPromptText }];
        if (imageBuffer) content.push({
          type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + imageBuffer.toString('base64') },
        });
        const request = {
          model: config.mainModel,
          messages: [{ role: 'system', content: prompts.system() }, { role: 'user', content }],
          ...(config.usesOfficialOpenAI ? { max_completion_tokens: 2500 } : { max_tokens: 2500, temperature: 0.9 }),
        };
        const completion = await this.openai.chat.completions.create(request);
        storage.incrementStat('smart');
        this.usingFallback = false;
        console.log('[AI SMART] model=' + (completion.model || config.mainModel));
        return completion.choices[0].message.content.replace(/^thought[\s\S]*?\n\n/i, '');
      } catch (error) {
        primaryError = error;
        console.error('[API SMART FAIL] ' + error.message);
      }
    }
    if (this.keys.length) {
      // Reuse the exact prompt, including search facts, lore and personal context.
      return this.generateGoogleReply(fullPromptText, imageBuffer, mimeType);
    }
    throw primaryError || new Error('No AI provider is available.');
  }

  async runGoogleLogic(prompt, json = false) {
    const model = config.aiProvider === 'google' ? config.logicModel : config.googleNativeModel;
    const result = await this.google.generateContent({
      model, contents: prompt,
      config: {
        // No Nora persona here: routing and profile analysis are service tasks.
        ...(json ? { responseMimeType: 'application/json' } : {}),
        maxOutputTokens: json ? 8192 : 256,
        thinkingConfig: thinkingConfigFor(model),
      },
    });
    const text = responseText(result);
    const value = json ? JSON.parse(text) : text;
    storage.incrementStat('logic');
    return value;
  }

  async runLogicModel(promptJson) {
    this.resetStatsIfNeeded();
    if (config.aiProvider === 'openai' && this.openai) {
      try {
        const completion = await this.openai.chat.completions.create({
          model: config.logicModel, messages: [{ role: 'user', content: promptJson }],
          response_format: { type: 'json_object' },
        });
        const value = JSON.parse(completion.choices[0].message.content);
        storage.incrementStat('logic');
        return value;
      } catch (error) { console.error('[API LOGIC FAIL] ' + error.message); }
    }
    try { return await this.runGoogleLogic(promptJson, true); }
    catch (error) { console.error('[GOOGLE LOGIC FAIL] ' + error.message); return null; }
  }

  async runLogicText(promptText) {
    this.resetStatsIfNeeded();
    if (config.aiProvider === 'openai' && this.openai) {
      try {
        const completion = await this.openai.chat.completions.create({
          model: config.logicModel, messages: [{ role: 'user', content: promptText }],
        });
        storage.incrementStat('logic');
        return completion.choices[0].message.content;
      } catch (error) { console.error('[API LOGIC TEXT FAIL] ' + error.message); }
    }
    try { return await this.runGoogleLogic(promptText); }
    catch (error) { console.error('[GOOGLE LOGIC TEXT FAIL] ' + error.message); return null; }
  }

  async analyzeUserImmediate(lastMessages, currentProfile) {
    return this.runLogicModel(prompts.analyzeImmediate(currentProfile, lastMessages));
  }

  async checkSearchNeeded(userMessage, recentHistory, matchedLoreTitles = '') {
    const fallback = { needsSearch: false, searchQuery: null, reason: responses.ai.searchFallbackReason };
    try {
      const result = await this.runLogicModel(prompts.shouldSearch(
        this.getCurrentTime(), userMessage, recentHistory, matchedLoreTitles,
      ));
      if (!result || typeof result !== 'object' || typeof result.needsSearch !== 'boolean') return fallback;
      const searchQuery = typeof result.searchQuery === 'string' && result.searchQuery.trim()
        ? result.searchQuery.trim().slice(0, 500) : null;
      if (result.needsSearch && !searchQuery) return fallback;
      const normalized = {
        needsSearch: result.needsSearch, searchQuery: result.needsSearch ? searchQuery : null,
        reason: typeof result.reason === 'string' ? result.reason.slice(0, 100) : 'unspecified',
      };
      console.log('[SEARCH CHECK] needsSearch=' + normalized.needsSearch + ', reason=' + normalized.reason);
      return normalized;
    } catch (error) { console.error('[SEARCH CHECK ERROR] ' + error.message); return fallback; }
  }

  async analyzeBatch(messagesBatch, currentProfiles) {
    const chatLog = messagesBatch.map(message => '[ID:' + message.userId + '] ' + message.name + ': ' + message.text).join('\n');
    const knownInfo = Object.entries(currentProfiles)
      .map(([uid, profile]) => 'ID:' + uid + ' -> ' + profile.realName + ', ' + profile.facts + ', ' + profile.attitude).join('\n');
    return this.runLogicModel(prompts.analyzeBatch(knownInfo, chatLog));
  }

  async analyzeChatProfile(messagesBatch, currentProfile) {
    if (!Array.isArray(messagesBatch) || !messagesBatch.length) return null;
    const text = messagesBatch.map(message => message.name + ': ' + message.text).join('\n');
    const result = await this.runLogicModel(prompts.analyzeChatProfile(currentProfile, text));
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const normalized = {};
    for (const [field, limit] of Object.entries({ topic: 200, facts: 500 })) {
      if (result[field] === null) continue;
      if (typeof result[field] !== 'string') return null;
      const value = result[field].trim();
      if (value) normalized[field] = value.slice(0, limit);
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  async determineReaction(contextText) {
    const allowed = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡'];
    const text = await this.runLogicText(prompts.reaction(contextText, allowed.join(' ')));
    if (!text) return null;
    const match = text.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    return match && allowed.includes(match[0]) ? match[0] : null;
  }

  async generateProfileDescription(profileData, targetName) {
    const prompt = prompts.profileDescription(targetName, profileData);
    if (config.aiProvider === 'openai' && this.openai) {
      try {
        const completion = await this.openai.chat.completions.create({
          model: config.mainModel,
          messages: [{ role: 'system', content: prompts.system() }, { role: 'user', content: prompt }],
        });
        storage.incrementStat('smart');
        return completion.choices[0].message.content;
      } catch (error) { console.error('[API PROFILE FAIL] ' + error.message); }
    }
    try { return await this.generateGoogleReply(prompt); }
    catch (error) { console.error('[GOOGLE PROFILE FAIL] ' + error.message); return responses.ai.unknownProfile; }
  }
}

module.exports = new AiService();
