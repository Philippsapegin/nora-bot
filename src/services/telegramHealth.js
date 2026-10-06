const { performance } = require('node:perf_hooks');

const TELEGRAM_OPTIONS = {
  polling: { autoStart: false, interval: 1000, params: { timeout: 10 } },
  request: { timeout: 45000 },
};

function createAdminNotifier(token, adminId, fetchImpl = fetch) {
  return async (text) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.description || `Telegram HTTP ${response.status}`);
    }
  };
}

class TelegramHealth {
  constructor(bot, {
    token,
    adminId,
    notify = createAdminNotifier(token, adminId),
    now = () => performance.now(),
    logger = console,
    checkIntervalMs = 10000,
    stallTimeoutMs = 60000,
    alertIntervalMs = 300000,
    notificationRetryMs = 30000,
    heartbeatIntervalMs = 300000,
  } = {}) {
    this.bot = bot;
    this.token = token;
    this.notify = notify;
    this.now = now;
    this.logger = logger;
    this.checkIntervalMs = checkIntervalMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.alertIntervalMs = alertIntervalMs;
    this.notificationRetryMs = notificationRetryMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.originalGetUpdates = bot.getUpdates;
    this.errorHandler = error => this.onPollingError(error);
    this.timer = null;
    this.restarting = false;
    this.notifying = false;
    this.pendingNotice = null;
    this.nextNotificationAttemptAt = 0;
    this.startedAt = this.now();
    this.lastPollCompletedAt = this.startedAt;
    this.lastSuccessfulPollAt = null;
    this.lastHeartbeatAt = null;
    this.lastRestartAttemptAt = null;
    this.lastAlertAt = null;
    this.lastError = null;
    this.outage = false;
  }

  safeError(error) {
    const text = String(error?.message || error || 'unknown');
    return (this.token ? text.split(this.token).join('[BOT_TOKEN]') : text)
      .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, '[BOT_TOKEN]')
      .slice(0, 800);
  }

  start() {
    if (this.timer) return;
    this.startedAt = this.now();
    this.lastPollCompletedAt = this.startedAt;
    const monitor = this;
    // Keep the library's cancellable promise and its existing update offset.
    this.bot.getUpdates = function (...args) {
      const request = monitor.originalGetUpdates.apply(this, args).then(updates => {
        monitor.onPollSuccess(updates.length);
        return updates;
      }, error => {
        monitor.lastPollCompletedAt = monitor.now();
        throw error;
      });
      monitor.activeRequest = request;
      return request;
    };
    this.bot.on('polling_error', this.errorHandler);
    this.timer = setInterval(() => {
      this.check().catch(error => {
        this.logger.error(`[TELEGRAM HEALTH ERROR] ${this.safeError(error)}`);
      });
    }, this.checkIntervalMs);
    this.timer.unref();
    this.startPolling();
  }

  startPolling() {
    this.bot.startPolling({ restart: false }).catch(this.errorHandler);
  }

  onPollSuccess(updateCount) {
    const now = this.now();
    this.lastPollCompletedAt = now;
    this.lastSuccessfulPollAt = now;
    this.lastError = null;
    if (this.outage) {
      this.outage = false;
      this.lastAlertAt = null;
      this.queueNotice('🐸 Нора: связь с Telegram восстановлена, снова получаю сообщения.');
      this.logger.log('[TELEGRAM HEALTH] Polling recovered');
    }
    if (this.lastHeartbeatAt === null || now - this.lastHeartbeatAt >= this.heartbeatIntervalMs) {
      this.lastHeartbeatAt = now;
      this.logger.log(`[TELEGRAM HEALTH] Polling OK; updates=${updateCount}`);
    }
  }

  onPollingError(error) {
    this.lastError = this.safeError(error);
    this.logger.error(`[POLLING ERROR] ${error.code || 'unknown'}: ${this.lastError}`);
    const status = error.response?.statusCode;
    if (status === 401 || status === 409) {
      this.reportOutage(`Telegram отклонил получение сообщений: ${this.lastError}`);
    }
  }

  reportOutage(reason) {
    this.outage = true;
    const now = this.now();
    if (this.lastAlertAt === null || now - this.lastAlertAt >= this.alertIntervalMs) {
      this.lastAlertAt = now;
      this.queueNotice(`⚠️ Нора: проблема с получением сообщений. ${reason}`);
    }
  }

  queueNotice(text) {
    this.pendingNotice = text;
    void this.flushNotice();
  }

  async flushNotice() {
    if (!this.pendingNotice || this.notifying || this.now() < this.nextNotificationAttemptAt) return;
    const text = this.pendingNotice;
    this.notifying = true;
    try {
      // A separate bounded HTTP request does not reuse the hung polling socket.
      await this.notify(text);
      if (this.pendingNotice === text) this.pendingNotice = null;
      this.nextNotificationAttemptAt = 0;
    } catch (error) {
      this.nextNotificationAttemptAt = this.now() + this.notificationRetryMs;
      this.logger.error(`[TELEGRAM ALERT ERROR] ${this.safeError(error)}`);
    } finally {
      this.notifying = false;
    }
  }

  async check() {
    if (!this.timer) return;
    const now = this.now();
    const stalled = now - this.lastPollCompletedAt >= this.stallTimeoutMs;
    const unhealthy = now - (this.lastSuccessfulPollAt ?? this.startedAt) >= this.stallTimeoutMs;
    if (unhealthy) {
      this.reportOutage(stalled
        ? 'Запрос к Telegram завис. Автоматически восстанавливаю соединение.'
        : `Telegram недоступен; повторяю запросы. ${this.lastError || ''}`);
    }
    if (stalled && !this.restarting &&
        (this.lastRestartAttemptAt === null || now - this.lastRestartAttemptAt >= this.stallTimeoutMs)) {
      this.restarting = true;
      this.lastRestartAttemptAt = now;
      this.logger.error('[TELEGRAM WATCHDOG] Polling stalled; restarting transport');
      try {
        await this.stopPollingSafely();
        if (this.timer) this.startPolling();
      } catch (error) {
        this.onPollingError(error);
      } finally {
        this.restarting = false;
      }
    }
    await this.flushNotice();
  }

  stopPollingSafely() {
    // A plain cancel:true allows this library's pending finally() to schedule
    // another polling loop. Stop gracefully first, then cancel the HTTP promise
    // and wait for all polling finalizers before starting another loop.
    const stopped = this.bot.stopPolling({ reason: 'Telegram health monitor' });
    const finished = new Promise(resolve => {
      stopped.finally(resolve).catch(error => {
        this.logger.error(`[TELEGRAM STOP ERROR] ${this.safeError(error)}`);
      });
    });
    this.activeRequest?.cancel?.();
    return finished;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.bot.removeListener('polling_error', this.errorHandler);
    this.bot.getUpdates = this.originalGetUpdates;
    return this.stopPollingSafely();
  }
}

module.exports = { TELEGRAM_OPTIONS, TelegramHealth, createAdminNotifier };
