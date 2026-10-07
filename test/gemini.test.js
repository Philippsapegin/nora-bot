const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiService, responseText, thinkingConfigFor } = require('../src/services/gemini');

function setup(generate) {
  const calls = [], exhausted = [], allExhausted = [];
  const service = new GeminiService({
    keys: ['project-one', 'project-two', 'project-three'],
    createClient: key => ({ models: { generateContent: request => generate(key, request) } }),
    onAttempt: (key, model) => calls.push([key, model]),
    onKeyExhausted: (key, model) => exhausted.push([key, model]),
    onAllExhausted: model => allExhausted.push(model),
  });
  return { service, calls, exhausted, allExhausted };
}

test('rotates project keys on quota errors and remembers the working key', async () => {
  const { service, calls } = setup(async key => {
    if (key === 'project-one') throw Object.assign(new Error('quota'), { status: 429 });
    return { text: 'ok' };
  });
  await service.generateContent({ model: 'gemini-3.8-flash', contents: 'one' });
  await service.generateContent({ model: 'gemini-3.8-flash', contents: 'two' });
  assert.deepEqual(calls, [[0, 'gemini-3.8-flash'], [1, 'gemini-3.8-flash'], [1, 'gemini-3.8-flash']]);
});

test('Lite quota exhaustion does not change the main or search key', async () => {
  const { service, calls } = setup(async (key, request) => {
    if (request.model.includes('lite') && key === 'project-one') throw new Error('429 RESOURCE_EXHAUSTED');
    return { text: 'ok' };
  });
  await service.generateContent({ model: 'gemini-3.5-flash-lite' });
  await service.generateContent({ model: 'gemini-3.8-flash' });
  await service.generateContent({ model: 'gemini-2.5-flash' });
  assert.deepEqual(calls.slice(-2), [[0, 'gemini-3.8-flash'], [0, 'gemini-2.5-flash']]);
});

test('tries every key once and retains the actual quota error', async () => {
  const failure = Object.assign(new Error('quota exhausted'), { status: 429 });
  const { service, calls, allExhausted } = setup(async () => { throw failure; });
  await assert.rejects(service.generateContent({ model: 'flash' }), error => error === failure);
  assert.equal(calls.length, 3);
  assert.deepEqual(allExhausted, ['flash']);
});

test('invalid API keys rotate, malformed requests do not', async () => {
  const { service, calls } = setup(async key => {
    if (key === 'project-one') throw new Error('API key not valid');
    throw Object.assign(new Error('Invalid thinking level'), { status: 400 });
  });
  await assert.rejects(service.generateContent({ model: 'flash' }), /Invalid thinking/);
  assert.equal(calls.length, 2);
});

test('temporary overload gets one extra project without marking quota exhaustion', async () => {
  const { service, calls, exhausted, allExhausted } = setup(async key => {
    if (key === 'project-one') throw Object.assign(new Error('high demand'), { status: 503 });
    return { text: 'ok' };
  });
  assert.equal((await service.generateContent({ model: 'flash' })).text, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(exhausted.length, 0);
  assert.equal(allExhausted.length, 0);
});

test('persistent overload is bounded and errors cannot disclose project keys', async () => {
  const { service, calls } = setup(async key => {
    throw Object.assign(new Error('503 key=' + key), { status: 503 });
  });
  await assert.rejects(service.generateContent({ model: 'flash' }), error => {
    assert.doesNotMatch(error.message, /project-one|project-two|project-three/);
    assert.match(error.message, /REDACTED/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('concurrent replies retain their own attempted key and model', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { service, calls } = setup(async (key, request) => {
    if (key === 'project-one' && request.contents === 'slow') { await waiting; return { text: 'slow' }; }
    if (key === 'project-one') throw new Error('429');
    return { text: 'fast' };
  });
  const slow = service.generateContent({ model: 'flash', contents: 'slow' });
  await service.generateContent({ model: 'flash', contents: 'fast' });
  release();
  await slow;
  await service.generateContent({ model: 'flash', contents: 'next' });
  assert.deepEqual(calls.map(call => call[0]), [0, 0, 1, 1]);
});

test('reset restores each model to the first project', async () => {
  const { service, calls } = setup(async key => {
    if (key === 'project-one') throw new Error('429');
    return { text: 'ok' };
  });
  await service.generateContent({ model: 'flash' });
  service.resetKeyIndices();
  await service.generateContent({ model: 'flash' });
  assert.deepEqual(calls.map(call => call[0]), [0, 1, 0, 1]);
});

test('rejects an empty key pool without calling the API', async () => {
  const service = new GeminiService({ keys: [] });
  await assert.rejects(service.generateContent({ model: 'flash' }), /No Google Gemini keys/);
});

test('never publishes thought parts, and rejects blocked or empty output', () => {
  assert.equal(responseText({ candidates: [{ content: { parts: [
    { text: 'private reasoning', thought: true }, { text: 'Привет!' }, { inlineData: {} },
  ] } }] }), 'Привет!');
  assert.throws(() => responseText({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  assert.throws(() => responseText({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), /MAX_TOKENS/);
});

test('uses supported thinking settings for each model family', () => {
  assert.deepEqual(thinkingConfigFor('gemini-3.8-flash'), { thinkingLevel: 'low' });
  assert.deepEqual(thinkingConfigFor('gemini-3.7-flash'), { thinkingLevel: 'low' });
  assert.deepEqual(thinkingConfigFor('gemini-3.5-flash-lite'), { thinkingLevel: 'minimal' });
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash-lite'), { thinkingBudget: 0 });
});
