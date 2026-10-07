const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { responseText, thinkingConfigFor } = require('../src/services/gemini');
const { AiFailover } = require('../src/services/aiFailover');

// Load with isolated config/storage/clients: tests never touch .env, user data,
// Telegram polling or real API quotas.
function setup(generate, settings = {}, failoverOptions = {}) {
  const filename = path.resolve(__dirname, '../src/services/ai.js');
  const originalRequire = createRequire(filename);
  const calls = [], probes = [], stats = { smart: 0, logic: 0, search: 0 };
  let openaiClients = 0;
  let dailyReset = false;
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
    './aiFailover': {
      AiFailover: class extends AiFailover {
        constructor(options) {
          super({ ...options, stateFile: null, setTimeout: () => ({ unref() {} }), clearTimeout() {},
            onError() {}, ...failoverOptions });
        }
      },
    },
    './storage': {
      initGoogleStats() {}, resetStatsIfNeeded: () => { const reset = dailyReset; dailyReset = false; return reset; },
      incrementStat: type => { stats[type]++; }, incrementGoogleStat() {}, markGoogleKeyExhausted() {},
      getFullStats: () => ({
        today: { date: '2026-10-07', google: [], ...stats },
        week: { smart: 0, logic: 0, google: 0, search: 0 },
        month: { smart: 0, logic: 0, google: 0, search: 0 },
        allTime: { smart: 0, logic: 0, google: 0 },
      }),
    },
    './gemini': {
      responseText, thinkingConfigFor,
      GeminiService: class {
        async generateContent(request) { calls.push(request); return generate(request); }
        async generateContentOnce(request) { probes.push(request); return generate(request); }
        resetKeyIndices() {}
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: name => modules[name] || originalRequire(name), Buffer, __dirname: path.dirname(filename),
    console: { log() {}, warn() {}, error() {} },
  }, { filename });
  return { ai: module.exports, calls, probes, stats, openaiClients,
    markDailyReset: () => { dailyReset = true; } };
}

const message = { text: 'Привет, Нора!', sender: 'Филипп', userId: 86786370 };

test('selected 3.7 primary uses the older chain, never attempts 3.8 or 3.6', async () => {
  const { ai, calls } = setup(async request => {
    if (request.model === 'gemini-3.7-flash') throw new Error('503 temporary');
    return { text: 'Жабка на месте.' };
  }, {
    mainModel: 'gemini-3.7-flash', googleNativeModel: 'gemini-3.7-flash',
    fallbackModels: ['gemini-3.5-flash', 'gemini-2.5-flash'],
  });
  assert.equal(await ai.generateGoogleReply('Привет'), 'Жабка на месте.');
  assert.deepEqual(calls.map(request => request.model), ['gemini-3.7-flash', 'gemini-3.5-flash']);
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

test('four fallback messages pin to the actual working old model and skip main/failed reserve', async () => {
  const { ai, calls, stats } = setup(async request => {
    if (request.model !== 'gemini-2.5-flash') throw new Error('503');
    return { text: 'Запасная жабка!' };
  }, {
    mainModel: 'gemini-3.7-flash', fallbackModels: ['gemini-3.5-flash', 'gemini-2.5-flash'],
  });
  for (let i = 0; i < 4; i++) await ai.generateGoogleReply('Привет');
  assert.equal(ai.failover.pinned, true);
  calls.length = 0;
  const image = Buffer.from('photo');
  assert.equal(await ai.generateGoogleReply('Тот же контекст', image, 'image/png'), 'Запасная жабка!');
  assert.deepEqual(calls.map(request => request.model), ['gemini-2.5-flash']);
  assert.equal(calls[0].config.httpOptions.timeout, 30000);
  assert.equal(calls[0].config.thinkingConfig.thinkingBudget, 0);
  assert.match(calls[0].config.systemInstruction, /жаба-девочка/);
  assert.equal(calls[0].contents[0].parts[0].text, 'Тот же контекст');
  assert.equal(calls[0].contents[0].parts[1].inlineData.data, image.toString('base64'));
  assert.equal(stats.smart, 5);
});

test('all failing reserves still activate the pin, without counting each model twice', async () => {
  const { ai, calls } = setup(async () => { throw new Error('503'); }, {
    fallbackModels: ['gemini-3.5-flash', 'gemini-2.5-flash'],
  });
  for (let i = 0; i < 4; i++) await assert.rejects(ai.generateGoogleReply('Привет'), /503/);
  assert.equal(ai.failover.streak, 4);
  assert.equal(ai.failover.pinned, true);
  calls.length = 0;
  await assert.rejects(ai.generateGoogleReply('Привет'), /503/);
  assert.deepEqual(calls.map(request => request.model), ['gemini-3.5-flash', 'gemini-2.5-flash']);
});

test('logic, search and a daily stats reset cannot change a conversational pin', async () => {
  const { ai, markDailyReset } = setup(async request => {
    if (request.model === 'gemini-3.8-flash') throw new Error('503');
    return { text: request.config.responseMimeType ? '{"needsSearch":false}' : 'Ква' };
  });
  for (let i = 0; i < 4; i++) await ai.generateGoogleReply('Привет');
  const deadline = ai.failover.fallbackUntil;
  await ai.runLogicModel('{}');
  await ai.performGoogleSearch('test');
  markDailyReset();
  ai.resetStatsIfNeeded();
  assert.equal(ai.failover.fallbackUntil, deadline);
  assert.equal(ai.failover.pinned, true);
  assert.equal(ai.failover.streak, 4);
  assert.equal(ai.usingFallback, true);
});

test('one private primary probe recovers routing and never counts as a conversational answer', async () => {
  let time = 1000000, healthy = false;
  const { ai, calls, probes, stats } = setup(async request => {
    if (request.model === 'gemini-3.8-flash' && !healthy) throw new Error('503');
    return { text: 'Ква!' };
  }, {}, { now: () => time });
  for (let i = 0; i < 4; i++) await ai.generateGoogleReply('Пользовательское сообщение');
  time += 4 * 3600000;
  healthy = true;
  assert.equal(await ai.failover.checkRecovery(), true);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].model, 'gemini-3.8-flash');
  assert.match(probes[0].config.systemInstruction, /жаба-девочка/);
  assert.doesNotMatch(probes[0].contents, /Пользовательское сообщение/);
  assert.equal(stats.smart, 4);
  assert.equal(ai.failover.pinned, false);
  assert.equal(ai.usingFallback, false);
  calls.length = 0;
  await ai.generateGoogleReply('Следующее сообщение');
  assert.deepEqual(calls.map(request => request.model), ['gemini-3.8-flash']);
});

test('an empty primary probe extends reserve and does not trigger any fallback request', async () => {
  let time = 1000000;
  const { ai, calls, probes, stats } = setup(async request => {
    if (request.model === 'gemini-3.8-flash') return { candidates: [{ finishReason: 'SAFETY' }] };
    return { text: 'Ква' };
  }, {}, { now: () => time });
  for (let i = 0; i < 4; i++) await ai.generateGoogleReply('Привет');
  time += 4 * 3600000;
  calls.length = 0;
  assert.equal(await ai.failover.checkRecovery(), false);
  assert.equal(probes.length, 1);
  assert.equal(calls.length, 0);
  assert.equal(stats.smart, 4);
  assert.equal(ai.failover.fallbackUntil, time + 3600000);
});

test('stats expose the active reserve and the next recovery check in user timezone', async () => {
  const { ai } = setup(async request => {
    if (request.model === 'gemini-3.8-flash') throw new Error('503');
    return { text: 'Ква' };
  });
  for (let i = 0; i < 4; i++) await ai.generateGoogleReply('Привет');
  const report = ai.getStatsReport();
  assert.match(report, /FALLBACK/);
  assert.match(report, /Модель резерва: gemini-3.7-flash/);
  assert.match(report, /Проверка основной: .*UTC\+5/);
});
