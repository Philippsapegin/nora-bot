const fs = require('fs');
const path = require('path');

const coreLore = fs.readFileSync(path.join(__dirname, '../lore/core.md'), 'utf8').trim();
const events = require('../lore/events.json');

const STOP_WORDS = new Set([
  'а', 'без', 'бы', 'был', 'была', 'были', 'быть', 'в', 'вам', 'вас', 'вот', 'все', 'вы',
  'где', 'да', 'для', 'до', 'его', 'ее', 'если', 'есть', 'еще', 'же', 'за', 'и', 'из', 'или',
  'как', 'когда', 'кто', 'ли', 'мне', 'мой', 'моя', 'мы', 'на', 'не', 'но', 'ну', 'о', 'об',
  'она', 'они', 'от', 'по', 'про', 'расскажи', 'с', 'так', 'там', 'тебе', 'твой', 'ты', 'у',
  'что', 'это', 'я'
]);

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9ω-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemToken(token) {
  if (token.length < 5) return token;
  return token.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|ой|ам|ям|ах|ях|ов|ев|ом|ем|ы|и|а|я|у|ю|е|о)$/u, '');
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token))
    .map(stemToken);
}

const indexedEvents = events.map(event => {
  const aliases = event.aliases.map(normalizeText).filter(Boolean);
  const aliasTokens = new Set(aliases.flatMap(tokenize));
  const titleTokens = new Set(tokenize(event.title));
  const keywordTokens = new Set(event.keywords.flatMap(tokenize));

  return { event, aliases, aliasTokens, titleTokens, keywordTokens };
});

function scoreEvent(indexedEvent, normalizedQuery, queryTokens) {
  let score = 0;

  for (const alias of indexedEvent.aliases) {
    if (normalizedQuery.includes(alias)) {
      score += alias.includes(' ') ? 14 : 9;
    }
  }

  for (const token of queryTokens) {
    if (indexedEvent.titleTokens.has(token)) score += 4;
    if (indexedEvent.aliasTokens.has(token)) score += 3;
    if (indexedEvent.keywordTokens.has(token)) score += 2;
  }

  return score;
}

function findRelevant(text, { limit = 2, minScore = 7 } = {}) {
  const normalizedQuery = normalizeText(text);
  if (!normalizedQuery) return [];

  const queryTokens = new Set(tokenize(normalizedQuery));
  return indexedEvents
    .map(indexedEvent => ({
      event: indexedEvent.event,
      score: scoreEvent(indexedEvent, normalizedQuery, queryTokens),
    }))
    .filter(result => result.score >= minScore)
    .sort((a, b) => b.score - a.score || b.event.sourceWeeks[0] - a.event.sourceWeeks[0])
    .slice(0, limit)
    .map(result => result.event);
}

function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';

  return memories
    .map(memory => `### ${memory.title}\n${memory.memory}`)
    .join('\n\n');
}

module.exports = {
  coreLore,
  events,
  findRelevant,
  formatMemories,
  normalizeText,
  tokenize,
};
