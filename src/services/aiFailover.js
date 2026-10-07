const fs = require('node:fs');
const path = require('node:path');

const HOUR = 60 * 60 * 1000;

// A shared conversational circuit breaker, independent of daily API statistics.
class AiFailover {
  constructor({ mainModel, fallbackModels, probe, stateFile = null,
    now = Date.now, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout,
    onEvent = () => {}, onError = error => console.error('[AI FAILOVER] ' + error.message) }) {
    this.mainModel = mainModel;
    this.fallbackModels = [...new Set(fallbackModels.filter(model => model && model !== mainModel))];
    this.probe = probe;
    this.stateFile = stateFile;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onEvent = onEvent;
    this.onError = onError;
    this.streak = 0;
    this.fallbackUntil = 0;
    this.activeFallbackModel = this.fallbackModels[0] || null;
    this.epoch = 0;
    this.timer = null;
    this.probePromise = null;
    this.stopped = false;
    this.restore();
    this.scheduleProbe();
  }

  get pinned() { return this.fallbackUntil > 0; }

  status() {
    return { mainModel: this.mainModel, fallbackModels: [...this.fallbackModels],
      streak: this.streak, fallbackUntil: this.fallbackUntil,
      activeFallbackModel: this.activeFallbackModel, pinned: this.pinned };
  }

  restore() {
    if (!this.stateFile) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      // Changing the configured chain starts a new circuit, not an obsolete pin.
      if (state.mainModel !== this.mainModel
        || JSON.stringify(state.fallbackModels) !== JSON.stringify(this.fallbackModels)) return;
      this.streak = Number.isInteger(state.streak) ? Math.max(0, Math.min(4, state.streak)) : 0;
      this.fallbackUntil = Number.isFinite(state.fallbackUntil) && state.fallbackUntil > 0
        && this.fallbackModels.length ? state.fallbackUntil : 0;
      if (this.fallbackModels.includes(state.activeFallbackModel)) {
        this.activeFallbackModel = state.activeFallbackModel;
      }
    } catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
  }

  persist() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.status(), null, 2), { mode: 0o600 });
      fs.renameSync(this.stateFile + '.tmp', this.stateFile);
    } catch (error) { this.onError(error); }
  }

  beginReply() {
    const fallbacks = this.pinned
      ? [this.activeFallbackModel, ...this.fallbackModels.filter(model => model !== this.activeFallbackModel)]
      : this.fallbackModels;
    return { epoch: this.epoch, direct: this.pinned, fallbackRecorded: false,
      fallbackEpoch: this.epoch,
      models: this.pinned ? fallbacks : [this.mainModel, ...fallbacks] };
  }

  primarySucceeded(route) {
    // A request already in flight cannot undo a pin or a subsequent recovery.
    if (route.direct || route.epoch !== this.epoch || this.pinned) return;
    if (this.streak) { this.streak = 0; this.persist(); }
  }

  routedToFallback(route) {
    if (route.fallbackRecorded) return;
    route.fallbackRecorded = true;
    if (route.direct || route.epoch !== this.epoch || this.pinned || !this.fallbackModels.length) return;
    this.streak++;
    if (this.streak >= 4) {
      this.fallbackUntil = this.now() + 4 * HOUR;
      this.epoch++;
      route.fallbackEpoch = this.epoch;
      this.persist();
      this.scheduleProbe();
      this.onEvent('pinned', this.status());
    } else this.persist();
  }

  fallbackSucceeded(route, model) {
    if (route.fallbackEpoch !== this.epoch || !this.fallbackModels.includes(model)) return;
    // Remember the working older model; when pinned, try it directly next time.
    if (this.activeFallbackModel !== model) {
      this.activeFallbackModel = model;
      this.persist();
    }
  }

  scheduleProbe() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (this.stopped || !this.pinned) return;
    const delay = Math.min(2147483647, Math.max(1, this.fallbackUntil - this.now()));
    this.timer = this.schedule(() => {
      this.timer = null;
      this.checkRecovery().catch(this.onError);
    }, delay);
    this.timer?.unref?.();
  }

  checkRecovery() {
    if (this.probePromise) return this.probePromise;
    if (this.stopped || !this.pinned) return Promise.resolve(false);
    if (this.now() < this.fallbackUntil) {
      this.scheduleProbe();
      return Promise.resolve(false);
    }
    const epoch = this.epoch;
    // Exactly one shared background probe, even while chats keep sending replies.
    this.probePromise = Promise.resolve().then(() => this.probe()).then(text => {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Main model probe returned no text.');
      return true;
    }).catch(error => { this.onError(error); return false; }).then(recovered => {
      if (this.stopped || epoch !== this.epoch) return false;
      if (recovered) {
        this.fallbackUntil = 0;
        this.streak = 0;
        this.epoch++;
      } else this.fallbackUntil = this.now() + HOUR;
      this.persist();
      this.scheduleProbe();
      this.onEvent(recovered ? 'recovered' : 'extended', this.status());
      return recovered;
    }).finally(() => { this.probePromise = null; });
    return this.probePromise;
  }

  stop() {
    this.stopped = true;
    this.epoch++;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}

module.exports = { AiFailover };
