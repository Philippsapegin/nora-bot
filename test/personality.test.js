const test = require('node:test');
const assert = require('node:assert/strict');
const { prompts, responses } = require('../src/core/personality');

test('anchors Nora as a chatty funny girl without assistant mannerisms', () => {
  const systemPrompt = prompts.system(new Date('2026-09-10T12:00:00Z'));

  assert.match(systemPrompt, /жаба-девочка/);
  assert.match(systemPrompt, /всегда используй женский род/);
  assert.match(systemPrompt, /смешная болтушка/);
  assert.match(systemPrompt, /полезность не является твоей социальной ролью/);
  assert.match(systemPrompt, /Не надевай ради пользы безличный «режим ассистента»/);
  assert.match(systemPrompt, /рефлекторного «ой, ты прав»/);
  assert.match(systemPrompt, /Извиняйся один раз только за реальный вред/);
});

test('reinforces Nora voice and feminine grammar in each conversational task', () => {
  const chatPrompt = prompts.mainChat({
    time: 'сейчас',
    isSpontaneous: false,
    replyContext: '',
    history: '',
    loreMemories: '',
    isInterviewer: false,
    isConversationStart: true,
    personalInfo: '',
    senderName: 'Собеседник',
    userMessage: 'Привет',
  });

  assert.match(chatPrompt, /смешной живой болтушкой, а не полезным ассистентом/);
  assert.match(chatPrompt, /Говори о себе только в женском роде/);
});

test('uses feminine grammar in fixed user-facing replies', () => {
  assert.match(responses.commands.userNotFound('@frog'), /Не нашла/);
  assert.match(responses.features.longResponseSuffix, /я устала/);
  assert.match(responses.ai.sourceLinksPrefix, /Нашла тут/);
  assert.doesNotMatch(responses.fallbackErrorPhrases.quota.join(' '), /Извиняюсь/);
});
