const test = require('node:test');
const assert = require('node:assert/strict');
const ConversationMemory = require('../src/services/conversationMemory');

function createMemory(options = {}) {
  let currentTime = 0;
  const memory = new ConversationMemory({
    ttlMs: 1000,
    maxMessages: 3,
    now: () => currentTime,
    ...options,
  });

  return {
    memory,
    setTime(value) {
      currentTime = value;
    },
  };
}

test('isolates conversations by user in the same chat and topic', () => {
  const { memory } = createMemory();

  memory.add(10, 20, 1, 'Аня', 'Я запускаю локальную модель');
  memory.add(10, 20, 2, 'Борис', 'Как твои дела?');
  memory.add(10, 20, 2, 'Нора', 'Неплохо, чай греется.');

  assert.deepEqual(memory.get(10, 20, 1), [
    { role: 'Аня', text: 'Я запускаю локальную модель' },
  ]);
  assert.deepEqual(memory.get(10, 20, 2), [
    { role: 'Борис', text: 'Как твои дела?' },
    { role: 'Нора', text: 'Неплохо, чай греется.' },
  ]);
});

test('isolates conversations by topic', () => {
  const { memory } = createMemory();

  memory.add(10, 20, 1, 'Аня', 'Контекст первого топика');
  memory.add(10, 30, 1, 'Аня', 'Контекст второго топика');

  assert.equal(memory.get(10, 20, 1)[0].text, 'Контекст первого топика');
  assert.equal(memory.get(10, 30, 1)[0].text, 'Контекст второго топика');
});

test('expires messages progressively and keeps newer context', () => {
  const { memory, setTime } = createMemory();

  memory.add(10, null, 1, 'Аня', 'Старое сообщение');
  setTime(600);
  memory.add(10, null, 1, 'Нора', 'Более свежий ответ');
  setTime(1100);

  assert.deepEqual(memory.get(10, null, 1), [
    { role: 'Нора', text: 'Более свежий ответ' },
  ]);
});

test('caps a conversation and resets only the selected user and topic', () => {
  const { memory } = createMemory();

  memory.add(10, 20, 1, 'Аня', 'один');
  memory.add(10, 20, 1, 'Нора', 'два');
  memory.add(10, 20, 1, 'Аня', 'три');
  memory.add(10, 20, 1, 'Нора', 'четыре');
  memory.add(10, 20, 2, 'Борис', 'не удалять');

  assert.deepEqual(memory.get(10, 20, 1).map(message => message.text), ['два', 'три', 'четыре']);

  memory.reset(10, 20, 1);

  assert.deepEqual(memory.get(10, 20, 1), []);
  assert.equal(memory.get(10, 20, 2)[0].text, 'не удалять');
});
