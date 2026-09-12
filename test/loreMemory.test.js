const test = require('node:test');
const assert = require('node:assert/strict');
const loreMemory = require('../src/services/loreMemory');
const { prompts } = require('../src/core/personality');

function idsFor(query) {
  return loreMemory.findRelevant(query).map(memory => memory.id);
}

test('contains the complete cleaned chronology without interview transcripts', () => {
  assert.equal(loreMemory.events.length, 17);
  assert.match(loreMemory.coreLore, /Домике на вздохе/);
  assert.match(loreMemory.coreLore, /Утка-Профессор/);

  for (const event of loreMemory.events) {
    assert.match(event.memory, /(?:^|\s)(?:я|мне|мой|моя|моих|моего|мы)(?:\s|[.,])/i);
    assert.doesNotMatch(event.memory, /Интервьюер:\s|Нора:\s|представьтесь, пожалуйста/i);
  }
});

test('retrieves specific autobiographical memories', () => {
  assert.deepEqual(idsFor('Почему ты не пьёшь кофе?'), ['inventions-day-and-coffee']);
  assert.ok(idsFor('Что такое Покой-9000?').includes('peace-9000'));
  assert.ok(idsFor('Расскажи про СреДоШаг').includes('wednesday-step'));
  assert.ok(idsFor('Что случилось с разумной чашкой и как вы выбрались из неё?').includes('self-aware-teacup'));
  assert.ok(idsFor('Что случилось с разумной чашкой и как вы выбрались из неё?').includes('counterbrew-escape'));
  assert.ok(idsFor('Какое у тебя последнее изобретение?').includes('cathedral-of-wednesdays'));
});

test('does not inject lore into unrelated requests', () => {
  assert.deepEqual(idsFor('Расскажи про мои локальные модели'), []);
  assert.deepEqual(idsFor('Как отсортировать массив объектов в JavaScript?'), []);
  assert.deepEqual(idsFor('Привет, как дела?'), []);
});

test('formats no more than the selected memories as autobiographical context', () => {
  const memories = loreMemory.findRelevant('Расскажи про все твои дабстеп-пушки', { limit: 2 });
  const formatted = loreMemory.formatMemories(memories);

  assert.equal(memories.length, 2);
  assert.match(formatted, /^### /);
  assert.doesNotMatch(formatted, /Интервьюер:\s/);
});

test('activates strong Wednesday interference only on Wednesday', () => {
  const wednesday = prompts.system(new Date('2026-09-09T12:00:00Z'));
  const thursday = prompts.system(new Date('2026-09-10T12:00:00Z'));

  assert.match(wednesday, /близка к пределу/);
  assert.match(wednesday, /прекрасного инженерного безумия/);
  assert.doesNotMatch(thursday, /ИЗОБРЕТАТЕЛЬСКАЯ ИНТЕРФЕРЕНЦИЯ ПО СРЕДАМ/);
});

test('adds the Interviewer bond only for the configured user', () => {
  const commonParams = {
    time: 'сейчас',
    isSpontaneous: false,
    replyContext: '',
    history: '',
    loreMemories: '',
    personalInfo: '',
    senderName: 'Филипп',
    userMessage: 'Привет',
  };

  const interviewerPrompt = prompts.mainChat({ ...commonParams, isInterviewer: true, isConversationStart: true });
  const regularPrompt = prompts.mainChat({ ...commonParams, isInterviewer: false });

  assert.match(interviewerPrompt, /давний Интервьюер/);
  assert.match(interviewerPrompt, /в этой реплике естественно обратись/);
  assert.doesNotMatch(regularPrompt, /давний Интервьюер/);
});
