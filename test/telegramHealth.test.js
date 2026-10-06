const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramHealth, createAdminNotifier } = require('../src/services/telegramHealth');

class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.starts = 0;
    this.stops = [];
    this.fail = null;
  }

  getUpdates() { return this.fail ? Promise.reject(this.fail) : Promise.resolve([]); }
  startPolling() { this.starts++; return Promise.resolve(); }
  stopPolling(options) { this.stops.push(options); return Promise.resolve(); }
}

function setup(t, options = {}) {
  let time = 0;
  const bot = new FakeBot();
  const notices = [];
  const logs = [];
  const health = new TelegramHealth(bot, {
    token: '123456:fake_token_for_tests_only',
    adminId: 1,
    now: () => time,
    checkIntervalMs: 600000,
    logger: { log: text => logs.push(text), error: text => logs.push(text) },
    notify: async text => { notices.push(text); },
    ...options,
  });
  health.start();
  t.after(() => health.stop());
  return { bot, health, notices, logs, setTime: value => { time = value; } };
}

test('healthy empty polls do not restart a quiet chat', async t => {
  const { bot, health, notices, setTime } = setup(t);
  for (let time = 0; time <= 600000; time += 10000) {
    setTime(time);
    assert.deepEqual(await bot.getUpdates(), []);
    await health.check();
  }
  assert.equal(bot.starts, 1);
  assert.equal(bot.stops.length, 0);
  assert.equal(notices.length, 0);
});

test('stalled polling is cancelled once and recovery is reported', async t => {
  const { bot, health, notices, setTime } = setup(t);
  await bot.getUpdates();
  setTime(60001);
  await Promise.all([health.check(), health.check()]);
  assert.equal(bot.stops.length, 1);
  assert.equal(bot.stops[0].reason, 'Telegram health monitor');
  assert.equal(bot.starts, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /завис/);
  await bot.getUpdates();
  await health.check();
  assert.equal(notices.length, 2);
  assert.match(notices[1], /восстановлена/);
});

test('sustained polling errors alert without restarting live retries or flooding', async t => {
  const { bot, health, notices, setTime } = setup(t);
  bot.fail = new Error('502 Bad Gateway');
  for (const time of [10000, 40000, 60000, 120000, 359999, 360000]) {
    setTime(time);
    await assert.rejects(bot.getUpdates(), /502/);
    bot.emit('polling_error', bot.fail);
    await health.check();
  }
  assert.equal(bot.stops.length, 0);
  assert.equal(notices.length, 2);
  bot.fail = null;
  await bot.getUpdates();
  await health.check();
  assert.match(notices.at(-1), /восстановлена/);
});

test('conflicts alert immediately and redact credentials from logs and notices', async t => {
  const { bot, notices, logs } = setup(t);
  const error = new Error('Conflict at https://api.telegram.org/bot123456:fake_token_for_tests_only/getUpdates');
  error.response = { statusCode: 409 };
  bot.emit('polling_error', error);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Conflict/);
  assert.doesNotMatch([...logs, ...notices].join('\n'), /fake_token_for_tests_only/);
});

test('failed alert delivery is retried after connection recovery', async t => {
  let attempts = 0;
  const delivered = [];
  const { health, setTime } = setup(t, {
    notify: async text => {
      attempts++;
      if (attempts === 1) throw new Error('Telegram unavailable');
      delivered.push(text);
    },
  });
  health.queueNotice('Notice');
  await health.check();
  assert.equal(attempts, 1);
  setTime(29999);
  await health.check();
  assert.equal(attempts, 1);
  setTime(30000);
  await health.check();
  assert.deepEqual(delivered, ['Notice']);
});

test('stopping the monitor removes the wrapper and prevents restarts', async t => {
  const { bot, health, setTime } = setup(t);
  await health.stop();
  setTime(999999);
  await health.check();
  assert.equal(bot.starts, 1);
  assert.equal(bot.listenerCount('polling_error'), 0);
  assert.equal(bot.getUpdates, FakeBot.prototype.getUpdates);
});

test('admin notifications use a separate bounded request and plain text', async () => {
  let request;
  const notify = createAdminNotifier('dummy', 1, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await notify('Error with _ and `');
  assert.match(request.url, /\/sendMessage$/);
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: 1, text: 'Error with _ and `' });
  assert.ok(request.options.signal instanceof AbortSignal);
});

for (const recovery of ['network timeout', 'watchdog']) {
  test(`real Telegram client recovers from a hung HTTP request via ${recovery}`, { timeout: 5000 }, async t => {
    let requests = 0;
    let offsetSeen = false;
    const errors = [];
    const notices = [];
    let receivedMessage;
    const messageReceived = new Promise(resolve => { receivedMessage = resolve; });
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests++;
        if (requests === 1) return; // Reproduce a connection that never returns headers.
        const params = new URLSearchParams(body);
        if (params.get('offset') === '43') offsetSeen = true;
        const result = requests === 2 ? [{
          update_id: 42,
          message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, text: '/version' },
        }] : [];
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const bot = new TelegramBot('123456:fake_token_for_tests_only', {
      baseApiUrl: `http://127.0.0.1:${server.address().port}`,
      polling: { autoStart: false, interval: 10, params: { timeout: 0 } },
      request: { timeout: recovery === 'network timeout' ? 150 : 2000 },
    });
    const health = new TelegramHealth(bot, {
      token: bot.token,
      adminId: 1,
      checkIntervalMs: 10,
      stallTimeoutMs: recovery === 'network timeout' ? 3000 : 100,
      logger: { log() {}, error: text => errors.push(text) },
      notify: async text => { notices.push(text); },
    });
    t.after(async () => {
      await health.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    bot.on('message', message => receivedMessage(message));
    health.start();
    const message = await messageReceived;
    assert.equal(message.text, '/version');
    // Let the following real poll confirm the offset survived recovery.
    const deadline = Date.now() + 1000;
    while (!offsetSeen && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(offsetSeen);
    if (recovery === 'network timeout') {
      assert.ok(errors.some(error => /TIMEDOUT/.test(error)));
    } else {
      assert.ok(errors.some(error => /WATCHDOG/.test(error)));
      assert.ok(notices.some(text => /восстановлена/.test(text)));
    }
    await health.stop();
    const requestsAtStop = requests;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(requests, requestsAtStop, 'no polling loop should survive shutdown');
  });
}
