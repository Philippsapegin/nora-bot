const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { responseText, thinkingConfigFor } = require('../src/services/gemini');

// Load with isolated config/storage/clients: tests never touch .env, user data,
// Telegram polling or real API quotas.
function setup(generate, settings = {}) {
  const filename = path.resolve(__dirname, '../src/services/ai.js');
  const originalRequire = createRequire(filename);
  const calls = [], stats = { smart: 0, logic: 0, search: 0 };
  let openaiClients = 0;
  const config = {
    aiProvider: 'google', aiBaseUrl: 'https://api.openai.com/v1', aiKey: 'unused-test-key',
    mainModel: 'gemini-3.8-flash', logicModel: 'gemini-3.5-flash-lite',
    fallbackModelName: 'gemini-3.7-flash', googleNativeModel: 'gemini-3.8-flash',
    googleSearchModel: 'gemini-2.5-flash-lite', geminiKeys: ['test-project'],
    searchProvider: 'google', contextSize: 20, interviewerUserId: 86786370,
    ...settings,
  };
  const modules = {
    '../config': config,
    openai: class { constructor() { openaiClients++; } },
    './storage': {
      initGoogleStats() {}, resetStatsIfNeeded: () => false,
      incrementStat: type => { stats[type]++; }, incrementGoogleStat() {}, markGoogleKeyExhausted() {},
    },
    './gemini': {
      responseText, thinkingConfigFor,
      GeminiService: class {
        async generateContent(request) { calls.push(request); return generate(request); }
        resetKeyIndices() {}
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: name => modules[name] || originalRequire(name), Buffer,
    console: { log() {}, warn() {}, error() {} },
  }, { filename });
  return { ai: module.exports, calls, stats, openaiClients };
}

const message = { text: 'Привет, Нора!', sender: 'Филипп', userId: 86786370 };

test('selected 3.7 primary falls back only to 3.6, never attempts 3.8', async () => {
  const { ai, calls } = setup(async request => {
    if (request.model === 'gemini-3.7-flash') throw new Error('503 temporary');
    return { text: 'Жабка на месте.' };
  }, {
    mainModel: 'gemini-3.7-flash', googleNativeModel: 'gemini-3.7-flash',
    fallbackModelName: 'gemini-3.6-flash',
  });
  assert.equal(await ai.generateGoogleReply('Привет'), 'Жабка на месте.');
  assert.deepEqual(calls.map(request => request.model), ['gemini-3.7-flash', 'gemini-3.6-flash']);
});

test('Google is primary even when an OpenAI key is retained', async () => {
  const { ai, calls, stats, openaiClients } = setup(async request => ({ text:
    request.config.responseMimeType ? '{"needsSearch":false,"searchQuery":null}' : 'Я придумала носкоуловитель!',
  }));
  assert.equal(await ai.getResponse([], message), 'Я придумала носкоуловитель!');
  assert.equal(openaiClients, 0);
  assert.equal(calls[0].model, 'gemini-3.5-flash-lite');
  assert.equal(calls[0].config.responseMimeType, 'application/json');
  assert.equal(calls[0].config.systemInstruction, undefined);
  assert.equal(calls[1].model, 'gemini-3.8-flash');
  assert.equal(calls[1].config.httpOptions.timeout, 20000);
  assert.match(calls[1].config.systemInstruction, /жаба-девочка/);
  assert.match(calls[1].config.systemInstruction, /НИКОГДА Не начинай исправление/);
  assert.match(calls[1].contents[0].parts[0].text, /давний Интервьюер/);
  assert.equal(stats.smart, 1);
  assert.equal(stats.logic, 1);
});

test('fallback keeps the same personality, private dialogue, photo and search facts', async () => {
  const { ai, calls, stats } = setup(async request => {
    if (request.config.responseMimeType) return { text: '{"needsSearch":true,"searchQuery":"test"}' };
    if (request.config.tools) return { candidates: [{ content: { parts: [{ text: 'Проверенный факт: 42.' }] },
      groundingMetadata: { groundingChunks: [{ web: { title: 'Источник', uri: 'https://example.com/fact' } }] },
    }] };
    if (request.model === 'gemini-3.8-flash') throw new Error('503 temporary');
    return { text: 'Получилось!' };
  });
  const photo = Buffer.from('fake-image');
  assert.equal(await ai.getResponse([{ role: 'Филипп', text: 'Личный контекст' }], message, photo,
    'image/png', 'Особая заметка', { facts: 'Любит жаб', relationship: 85 }), 'Получилось!');
  const main = calls.find(request => request.model === 'gemini-3.8-flash');
  const fallback = calls.find(request => request.model === 'gemini-3.7-flash');
  assert.deepEqual(main.contents, fallback.contents);
  assert.equal(main.config.systemInstruction, fallback.config.systemInstruction);
  assert.equal(fallback.config.httpOptions.timeout, 30000);
  assert.match(fallback.contents[0].parts[0].text, /Проверенный факт: 42/);
  assert.match(fallback.contents[0].parts[0].text, /https:\/\/example.com\/fact/);
  assert.match(fallback.contents[0].parts[0].text, /Личный контекст/);
  assert.match(fallback.contents[0].parts[0].text, /Любит жаб/);
  assert.match(fallback.contents[0].parts[0].text, /Особая заметка/);
  assert.equal(fallback.contents[0].parts[1].inlineData.data, photo.toString('base64'));
  assert.equal(fallback.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(ai.usingFallback, true);
  assert.equal(stats.smart, 1);
  assert.equal(stats.search, 1);
});

test('text service tasks and reactions run on Lite without conversational persona', async () => {
  const { ai, calls, stats } = setup(async () => ({ text: '🔥' }));
  assert.equal(await ai.determineReaction('Интересный разговор'), '🔥');
  assert.equal(calls[0].model, 'gemini-3.5-flash-lite');
  assert.equal(calls[0].config.systemInstruction, undefined);
  assert.equal(calls[0].config.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(stats.logic, 1);
});

test('profile descriptions use the main Gemini and the current Nora persona', async () => {
  const { ai, calls, stats } = setup(async () => ({ text: 'Филипп — мой Интервьюер.' }));
  assert.equal(await ai.generateProfileDescription({ facts: 'Изобретатель' }, 'Филипп'), 'Филипп — мой Интервьюер.');
  assert.equal(calls[0].model, 'gemini-3.8-flash');
  assert.match(calls[0].config.systemInstruction, /жаба-девочка/);
  assert.match(calls[0].contents[0].parts[0].text, /Изобретатель/);
  assert.equal(stats.smart, 1);
});

test('malformed JSON fails safely and unavailable search does not invent facts', async () => {
  const { ai, calls, stats } = setup(async request => {
    if (request.config.responseMimeType) return { text: 'broken JSON' };
    if (request.config.tools) throw new Error('503');
    return { text: 'Без поиска.' };
  });
  const decision = await ai.checkSearchNeeded('Привет', '');
  assert.equal(decision.needsSearch, false);
  assert.equal(stats.logic, 0);
  ai.checkSearchNeeded = async () => ({ needsSearch: true, searchQuery: 'today' });
  assert.equal(await ai.getResponse([], message), 'Без поиска.');
  const main = calls.find(request => request.model === 'gemini-3.8-flash');
  assert.match(main.contents[0].parts[0].text, /(?:недоступен|не сработал|не удалось)/i);
});

test('empty main output tries the full Flash fallback, not Luna or Lite', async () => {
  const { ai, calls } = setup(async request => request.model === 'gemini-3.8-flash'
    ? { candidates: [{ finishReason: 'SAFETY' }] } : { text: 'Запасная жаба на месте.' });
  assert.equal(await ai.generateGoogleReply('Привет'), 'Запасная жаба на месте.');
  assert.equal(calls[1].model, 'gemini-3.7-flash');
});

test('all conversational failures propagate the real error', async () => {
  const { ai, calls } = setup(async () => { throw new Error('429 RESOURCE_EXHAUSTED'); });
  await assert.rejects(ai.generateGoogleReply('Привет'), /429/);
  assert.equal(calls.length, 2);
});
