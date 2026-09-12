class ConversationMemory {
  constructor({ ttlMs, maxMessages, maxSessions = 2000, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
  }

  makeKey(chatId, threadId, userId) {
    return JSON.stringify([String(chatId), threadId ?? 'general', String(userId)]);
  }

  pruneSession(key, now) {
    const session = this.sessions.get(key);
    if (!session) return null;

    session.messages = session.messages.filter(message => now - message.createdAt < this.ttlMs);
    if (session.messages.length === 0) {
      this.sessions.delete(key);
      return null;
    }

    return session;
  }

  pruneExpired(now = this.now()) {
    for (const key of this.sessions.keys()) {
      this.pruneSession(key, now);
    }
  }

  evictOldestSession() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, session] of this.sessions.entries()) {
      if (session.lastTouched < oldestTime) {
        oldestKey = key;
        oldestTime = session.lastTouched;
      }
    }

    if (oldestKey !== null) this.sessions.delete(oldestKey);
  }

  add(chatId, threadId, userId, role, text) {
    if (text === null || text === undefined || String(text).trim() === '') return;

    const now = this.now();
    const key = this.makeKey(chatId, threadId, userId);
    let session = this.pruneSession(key, now);

    if (!session) {
      this.pruneExpired(now);
      while (this.sessions.size >= this.maxSessions) this.evictOldestSession();
      session = { messages: [], lastTouched: now };
      this.sessions.set(key, session);
    }

    session.messages.push({ role, text: String(text), createdAt: now });
    session.messages = session.messages.slice(-this.maxMessages);
    session.lastTouched = now;
  }

  get(chatId, threadId, userId) {
    const key = this.makeKey(chatId, threadId, userId);
    const session = this.pruneSession(key, this.now());
    if (!session) return [];

    return session.messages.map(({ role, text }) => ({ role, text }));
  }

  reset(chatId, threadId, userId) {
    this.sessions.delete(this.makeKey(chatId, threadId, userId));
  }
}

module.exports = ConversationMemory;
