const { GoogleGenAI } = require('@google/genai');

function thinkingConfigFor(model) {
  if (/^gemini-3(?:\.\d+)?-/.test(model)) {
    return { thinkingLevel: /flash-lite/.test(model) ? 'minimal' : 'low' };
  }
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  return undefined;
}

function responseText(response) {
  const parts = response.candidates?.[0]?.content?.parts;
  const text = parts
    ? parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('')
    : response.text;
  if (typeof text !== 'string' || !text.trim()) {
    const reason = response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason || 'EMPTY';
    throw new Error(`Gemini returned no text (${reason}).`);
  }
  return text;
}

class GeminiService {
  constructor({ keys, createClient, onAttempt = () => {}, onKeyExhausted = () => {}, onAllExhausted = () => {} }) {
    this.keys = keys;
    this.clients = keys.map(key => createClient
      ? createClient(key)
      : new GoogleGenAI({ apiKey: key, httpOptions: { timeout: 60000, retryOptions: { attempts: 1 } } }));
    // Flash, Lite and Search have independent per-project/model quotas.
    this.modelKeyIndices = new Map();
    this.onAttempt = onAttempt;
    this.onKeyExhausted = onKeyExhausted;
    this.onAllExhausted = onAllExhausted;
  }

  resetKeyIndices() {
    this.modelKeyIndices.clear();
  }

  redactError(error) {
    let message = String(error.message || error);
    for (const key of this.keys) {
      if (key) message = message.split(key).join('[REDACTED]');
    }
    error.message = message;
    return error;
  }

  // Health checks must be ONE request: no project rotation or overload retries.
  async generateContentOnce(request) {
    if (!this.clients.length) throw new Error('No Google Gemini keys are configured.');
    const keyIndex = this.modelKeyIndices.get(request.model) || 0;
    this.onAttempt(keyIndex, request.model);
    try { return await this.clients[keyIndex].models.generateContent(request); }
    catch (error) { throw this.redactError(error); }
  }

  async generateContent(request) {
    if (!this.clients.length) throw new Error('No Google Gemini keys are configured.');
    const startIndex = this.modelKeyIndices.get(request.model) || 0;
    let lastError;
    let transientRetries = 0;
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      // Capture the key for this call; concurrent requests cannot change it.
      const keyIndex = (startIndex + attempt) % this.clients.length;
      this.onAttempt(keyIndex, request.model);
      try {
        const result = await this.clients[keyIndex].models.generateContent(request);
        // Do not move a cursor backwards when an older concurrent call finishes.
        const currentIndex = this.modelKeyIndices.get(request.model) || 0;
        if (currentIndex === startIndex) this.modelKeyIndices.set(request.model, keyIndex);
        return result;
      } catch (error) {
        this.redactError(error);
        const message = error.message;
        // One extra project for temporary overload; do not label it exhausted.
        const status = Number(error.status || error.code);
        if ([500, 502, 503, 504].includes(status) && !/deadline|timeout|timed out|aborted/i.test(message)
          && transientRetries++ < 1 && attempt + 1 < this.clients.length) continue;
        const retryable = [429, 403].includes(status)
          || /\b429\b|\b403\b|RESOURCE_EXHAUSTED|quota|API_KEY_INVALID|API key not valid/i.test(message);
        if (!retryable) throw error;
        lastError = error;
        this.onKeyExhausted(keyIndex, request.model);
        if ((this.modelKeyIndices.get(request.model) || 0) === keyIndex) {
          this.modelKeyIndices.set(request.model, (keyIndex + 1) % this.clients.length);
        }
      }
    }
    this.onAllExhausted(request.model);
    // Keep the actual 429/403 error for the user-facing error classifier.
    throw lastError;
  }
}

module.exports = { GeminiService, thinkingConfigFor, responseText };
