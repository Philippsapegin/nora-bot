const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(values) {
  const filename = path.resolve(__dirname, '../src/config.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: { env: {
      TELEGRAM_BOT_TOKEN: '123:test', ADMIN_USER_ID: '123', AI_PROVIDER: 'google',
      GOOGLE_GEMINI_API_KEY: 'test', AI_MAIN_MODEL: 'main', AI_LOGIC_MODEL: 'logic',
      GOOGLE_NATIVE_MODEL: 'main', ...values,
    } },
    require: name => name === 'dotenv' ? { config() {} } : { version: 'test' },
    console: { log() {} },
  }, { filename });
  return module.exports;
}

test('ordered fallback list is trimmed, deduplicated and overrides the legacy setting', () => {
  const config = load({ GOOGLE_FALLBACK_MODELS: ' older,oldest, older ', GOOGLE_FALLBACK_MODEL: 'legacy' });
  assert.deepEqual(Array.from(config.fallbackModels), ['older', 'oldest']);
  assert.equal(config.fallbackModelName, 'older');
});

test('legacy single fallback remains compatible', () => {
  const config = load({ GOOGLE_FALLBACK_MODEL: 'older' });
  assert.deepEqual(Array.from(config.fallbackModels), ['older']);
});

test('rejects missing, empty or primary-only fallback configuration', () => {
  assert.throws(() => load({}), /GOOGLE_FALLBACK_MODEL/);
  assert.throws(() => load({ GOOGLE_FALLBACK_MODELS: ' , ' }), /different from the primary/);
  assert.throws(() => load({ GOOGLE_FALLBACK_MODELS: 'main' }), /different from the primary/);
});
