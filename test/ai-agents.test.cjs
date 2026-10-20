'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AiAgents, CATALOG } = require('../src/backend/ai-agents.cjs');

function fixture(t, fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-agent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(buffer) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(-16)); return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  };
  return { agents: new AiAgents({ dataDir: dir, safeStorage: storage, fetch }), dir, storage };
}
function add(agents, provider = 'openai') { return agents.save({ name: '架空の接続先', provider, model: 'test-model', apiKey: provider === 'minimax-plan' ? 'sk-cp-synthetic-secret-only' : 'synthetic-secret-only' }).at(-1); }
const answer = '{"company":{"name":"架空の企業"}}';

test('Agent credentials are encrypted, absent from metadata, deletable and fail closed on corruption', (t) => {
  const { agents, storage } = fixture(t);
  const saved = add(agents);
  assert(!JSON.stringify(saved).includes('secret'));
  assert(!fs.readFileSync(agents.file).includes('synthetic-secret'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(agents.file).mode & 0o777, 0o600);
  assert.equal(agents.list()[0].name, '架空の接続先');
  const before = fs.readFileSync(agents.file);
  storage.encryptString = () => { throw new Error('synthetic encryption failure'); };
  assert.throws(() => add(agents));
  assert.deepEqual(fs.readFileSync(agents.file), before);
  fs.writeFileSync(agents.file, 'corrupted');
  assert.throws(() => agents.list(), /復号/);
  assert.throws(() => add(agents), /復号/);
  assert.equal(fs.readFileSync(agents.file, 'utf8'), 'corrupted');
});

test('Agent registration rejects custom endpoints, unknown providers and Gemini URL injection', (t) => {
  const { agents, storage } = fixture(t);
  const value = { name: 'test', provider: 'openai', model: 'test-model', apiKey: 'synthetic-secret' };
  assert.throws(() => agents.save({ ...value, endpoint: 'http://127.0.0.1/' }));
  assert.throws(() => agents.save({ ...value, provider: 'custom' }));
  assert.throws(() => agents.save({ ...value, apiKey: 'bad\nheader' }));
  assert.throws(() => agents.save({ ...value, provider: 'gemini', model: 'a/b' }));
  assert.throws(() => agents.save({ ...value, provider: 'minimax-plan' }));
  storage.isEncryptionAvailable = () => false;
  assert.throws(() => agents.save(value), /暗号化/);
  assert(!fs.existsSync(agents.file));
});

test('All provider adapters use fixed HTTPS endpoints and their documented response envelopes', async (t) => {
  const calls = [];
  let provider;
  const { agents } = fixture(t, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert(url.startsWith('https://'));
    if (provider.protocol === 'gemini') {
      assert.equal(options.headers['x-goog-api-key'], 'synthetic-secret-only');
      assert(body.contents[0].parts[0].text.includes('null'));
      return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: answer }] }, finishReason: 'STOP' }] });
    }
    if (provider.protocol === 'anthropic') {
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      return Response.json({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: answer }] });
    }
    assert(options.headers.Authorization.startsWith('Bearer '));
    if (provider.webSearch) assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    else assert.equal(body.tools, undefined);
    return Response.json(provider.protocol === 'responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] } : { choices: [{ message: { content: answer }, finish_reason: 'stop' }] });
  });
  for (provider of CATALOG) {
    const saved = add(agents, provider.id);
    assert.equal(await agents.generate({ id: saved.id, input: '架空企業の情報を整理してください' }), answer);
    assert.equal(calls.at(-1).url, provider.endpoint + (provider.protocol === 'gemini' ? 'test-model:generateContent' : ''));
  }
  assert.equal(calls.length, CATALOG.length);
});

test('Provider errors and transport secrets are not forwarded, truncated and oversized output is rejected', async (t) => {
  let response = () => new Response('synthetic-secret-in-error', { status: 401 });
  let calls = 0;
  const { agents } = fixture(t, async () => { calls++; return response(); });
  const { id } = add(agents);
  await assert.rejects(agents.generate({ id, input: 'test' }), (e) => !e.message.includes('synthetic-secret') && /APIキー/.test(e.message));
  response = () => { throw new Error('synthetic-secret-in-network-error'); };
  await assert.rejects(agents.generate({ id, input: 'test' }), /接続できません/);
  response = () => Response.json({ status: 'incomplete' });
  await assert.rejects(agents.generate({ id, input: 'test' }), /途中/);
  response = () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(agents.generate({ id, input: 'test' }));
  assert.equal(calls, 4); // No retries, fallback providers or additional charges.
});

test('Cancellation and deletion abort generation and release its single-request guard', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { agents } = fixture(t, (url, { signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }); }));
  const { id } = add(agents);
  const pending = agents.generate({ id, input: 'test' });
  await ready;
  await assert.rejects(agents.generate({ id, input: 'test' }), /進行中/);
  agents.remove({ id });
  await assert.rejects(pending, /中断/);
  assert.equal(agents.pending, null);
  assert.deepEqual(agents.list(), []);
});
