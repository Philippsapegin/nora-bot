const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiFailover } = require('../src/services/aiFailover');

const HOUR = 3600000;

function clock() {
  let time = 1000000, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, delay) => { const token = ++id; timers.set(token, { fn, at: time + delay }); return token; },
    clearTimeout: token => timers.delete(token),
    advance: async ms => {
      time += ms;
      for (const [token, timer] of [...timers]) {
        if (timer.at <= time) { timers.delete(token); await timer.fn(); }
      }
      // Flush the controller's asynchronous probe/result/finally chain.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    timers,
  };
}

function setup(probe = async () => 'Ква', options = {}) {
  const timer = clock(), events = [], errors = [];
  let probes = 0;
  const controller = new AiFailover({
    mainModel: 'main', fallbackModels: ['older', 'oldest'],
    ...timer, probe: async () => { probes++; return probe(); },
    onEvent: (name, state) => events.push({ name, state }), onError: error => errors.push(error),
    ...options,
  });
  return { controller, timer, events, errors, probeCount: () => probes };
}

function fail(controller, model = 'older') {
  const route = controller.beginReply();
  controller.routedToFallback(route);
  controller.fallbackSucceeded(route, model);
  return route;
}

function pin(controller, model) { for (let i = 0; i < 4; i++) fail(controller, model); }

test('exactly four consecutive fallback replies pin for four hours and skip main', () => {
  const { controller, timer, events } = setup();
  for (let i = 0; i < 3; i++) {
    fail(controller);
    assert.equal(controller.pinned, false);
  }
  fail(controller);
  assert.equal(controller.fallbackUntil, timer.now() + 4 * HOUR);
  assert.deepEqual(controller.beginReply().models, ['older', 'oldest']);
  assert.equal(timer.timers.size, 1);
  assert.deepEqual(events.map(event => event.name), ['pinned']);
  const deadline = controller.fallbackUntil;
  for (let i = 0; i < 8; i++) fail(controller);
  assert.equal(controller.fallbackUntil, deadline, 'normal reserve replies must not postpone the probe');
});

test('a usable primary reply breaks the fallback streak', () => {
  const { controller } = setup();
  for (let i = 0; i < 3; i++) fail(controller);
  controller.primarySucceeded(controller.beginReply());
  assert.equal(controller.streak, 0);
  fail(controller);
  assert.equal(controller.streak, 1);
  assert.equal(controller.pinned, false);
});

test('multiple fallback candidates/keys count once, and all-reserve failures also count', () => {
  const { controller } = setup();
  for (let i = 0; i < 4; i++) {
    const route = controller.beginReply();
    controller.routedToFallback(route);
    controller.routedToFallback(route);
    assert.equal(controller.streak, i + 1);
  }
  assert.equal(controller.pinned, true);
});

test('the last working older model is used directly during pin, with other reserves behind it', () => {
  const { controller } = setup();
  pin(controller, 'oldest');
  assert.deepEqual(controller.beginReply().models, ['oldest', 'older']);
  fail(controller, 'older');
  assert.deepEqual(controller.beginReply().models, ['older', 'oldest']);
});

test('idle timer probes once after four hours and text restores the primary', async () => {
  const { controller, timer, events, probeCount } = setup();
  pin(controller);
  await timer.advance(4 * HOUR - 1);
  assert.equal(probeCount(), 0);
  assert.equal(controller.pinned, true);
  await timer.advance(1);
  assert.equal(probeCount(), 1);
  assert.equal(controller.pinned, false);
  assert.equal(controller.streak, 0);
  assert.deepEqual(controller.beginReply().models, ['main', 'older', 'oldest']);
  assert.equal(timer.timers.size, 0);
  assert.deepEqual(events.map(event => event.name), ['pinned', 'recovered']);
});

test('failure or empty probe extends by one hour, and the next timer can recover', async () => {
  for (const result of [null, '', '  ', new Error('503')]) {
    let healthy = false;
    const { controller, timer, events, probeCount } = setup(async () => {
      if (healthy) return 'Ква';
      if (result instanceof Error) throw result;
      return result;
    });
    pin(controller);
    await timer.advance(4 * HOUR);
    assert.equal(probeCount(), 1);
    assert.equal(controller.fallbackUntil, timer.now() + HOUR);
    assert.equal(controller.pinned, true);
    await timer.advance(HOUR - 1);
    assert.equal(probeCount(), 1);
    healthy = true;
    await timer.advance(1);
    assert.equal(probeCount(), 2);
    assert.equal(controller.pinned, false);
    assert.deepEqual(events.map(event => event.name), ['pinned', 'extended', 'recovered']);
  }
});

test('concurrent recovery checks share one probe; replies still go directly to reserve', async () => {
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const { controller, timer, probeCount } = setup(() => waiting);
  pin(controller);
  await timer.advance(4 * HOUR);
  const one = controller.checkRecovery(), two = controller.checkRecovery();
  assert.equal(one, two);
  assert.equal(probeCount(), 1);
  assert.deepEqual(controller.beginReply().models, ['older', 'oldest']);
  resolve('Ква');
  assert.equal(await one, true);
  assert.equal(controller.pinned, false);
});

test('old in-flight primary success cannot undo a pin; stale fallback cannot undo recovery', async () => {
  const { controller, timer } = setup();
  const slowPrimary = controller.beginReply();
  pin(controller, 'oldest');
  controller.primarySucceeded(slowPrimary);
  assert.equal(controller.pinned, true);
  const slowReserve = controller.beginReply();
  await timer.advance(4 * HOUR);
  controller.routedToFallback(slowPrimary);
  controller.fallbackSucceeded(slowReserve, 'older');
  assert.equal(controller.pinned, false);
  assert.equal(controller.streak, 0);
  assert.equal(controller.activeFallbackModel, 'oldest');
});

test('pin, deadline, streak and preferred reserve survive a process restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-failover-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'ai-failover.json');
  const before = setup(async () => 'Ква', { stateFile });
  for (let i = 0; i < 3; i++) fail(before.controller, 'oldest');
  before.controller.stop();
  const afterStreak = setup(async () => 'Ква', { stateFile });
  assert.equal(afterStreak.controller.streak, 3);
  fail(afterStreak.controller, 'oldest');
  const deadline = afterStreak.controller.fallbackUntil;
  afterStreak.controller.stop();
  const afterPin = setup(async () => 'Ква', { stateFile });
  assert.equal(afterPin.controller.fallbackUntil, deadline);
  assert.deepEqual(afterPin.controller.beginReply().models, ['oldest', 'older']);
  assert.equal(afterPin.timer.timers.size, 1);
  await afterPin.timer.advance(4 * HOUR);
  assert.equal(afterPin.controller.pinned, false);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.fallbackUntil, 0);
  assert.equal(saved.streak, 0);
});

test('an expired persisted pin probes once immediately after restart, not on each reply', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-failover-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const before = setup(async () => 'Ква', { stateFile });
  pin(before.controller);
  before.controller.stop();
  const timer = clock();
  await timer.advance(5 * HOUR);
  const after = setup(async () => { throw new Error('503'); }, { stateFile, ...timer });
  assert.equal(after.controller.pinned, true);
  for (let i = 0; i < 8; i++) assert.equal(after.controller.beginReply().direct, true);
  await timer.advance(1);
  assert.equal(after.probeCount(), 1);
  assert.equal(after.controller.fallbackUntil, timer.now() + HOUR);
  after.controller.stop();
});

test('changed models invalidate old state; malformed state fails safely', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-failover-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const before = setup(async () => 'Ква', { stateFile });
  pin(before.controller);
  before.controller.stop();
  const changed = setup(async () => 'Ква', { stateFile, mainModel: 'new-main' });
  assert.equal(changed.controller.pinned, false);
  assert.equal(changed.controller.streak, 0);
  fs.writeFileSync(stateFile, 'invalid JSON');
  const broken = setup(async () => 'Ква', { stateFile });
  assert.equal(broken.controller.pinned, false);
  assert.equal(broken.errors.length, 1);
});

test('shutdown cancels timers and an in-flight probe cannot change saved state', async () => {
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const { controller, timer, events } = setup(() => waiting);
  pin(controller);
  await timer.advance(4 * HOUR);
  const pending = controller.checkRecovery();
  const deadline = controller.fallbackUntil;
  controller.stop();
  resolve('Ква');
  assert.equal(await pending, false);
  assert.equal(controller.fallbackUntil, deadline);
  assert.equal(timer.timers.size, 0);
  assert.deepEqual(events.map(event => event.name), ['pinned']);
});
