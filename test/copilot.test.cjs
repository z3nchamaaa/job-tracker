'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CopilotService, isolatedEnvironment } = require('../src/backend/copilot.cjs');
const TOKEN = 'gho_syntheticTestTokenOnly';
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-copilot-unit-'));
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(s) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()]); },
    decryptString(b) { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12,-16)), c.final()]).toString(); },
  };
  const service = new CopilotService({ dataDir: dir, safeStorage: storage, clientFactory: () => ({}), ...options });
  t.after(async () => { await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const authorize = () => service.write({ version: 1, clientId: 'synthetic-client', token: TOKEN, login: 'synthetic-user', expiresAt: null });
  return { service, storage, dir, authorize };
}
function device() { return { device_code: 'syntheticDeviceCodeOnly123456', user_code: 'TEST-ONLY', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }; }

test('Copilot Client ID and OAuth tokens are encrypted, strict, absent from status, and preserved on encryption failure', (t) => {
  const { service, storage, authorize } = fixture(t);
  assert.equal(service.getStatus().connected, false);
  service.configure({ clientId: 'synthetic-client' });
  assert.equal(service.getStatus().clientId, 'synthetic-client');
  authorize();
  assert.equal(service.getStatus().connected, true);
  assert(!JSON.stringify(service.getStatus()).includes(TOKEN));
  assert(!fs.readFileSync(service.file).includes(TOKEN));
  if (process.platform !== 'win32') assert.equal(fs.statSync(service.file).mode & 0o777, 0o600);
  assert.throws(() => service.configure({ clientId: 'synthetic-client', clientSecret: 'never-accept' }));
  const before = fs.readFileSync(service.file);
  storage.encryptString = () => { throw new Error('synthetic failure'); };
  assert.throws(() => service.configure({ clientId: 'different-client' }));
  assert.deepEqual(fs.readFileSync(service.file), before);
});

test('Copilot device flow uses only official endpoints, enforces pending/slow_down intervals and verifies identity', async (t) => {
  const calls = [], waits = []; let polls = 0;
  const { service } = fixture(t, {
    delay: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, 1)); },
    fetch: async (url, options) => {
      calls.push({ url, options }); assert.equal(options.redirect, 'error');
      if (url.endsWith('/device/code')) { assert.equal(new URLSearchParams(options.body).get('scope'), 'read:user'); return Response.json(device()); }
      if (url.endsWith('/access_token')) {
        assert.equal(new URLSearchParams(options.body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
        return Response.json(++polls === 1 ? { error: 'authorization_pending' } : polls === 2 ? { error: 'slow_down' } : { access_token: TOKEN, token_type: 'bearer', expires_in: 28800 });
      }
      assert.equal(url, 'https://api.github.com/user'); assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      return Response.json({ login: 'synthetic-user' });
    },
  });
  service.configure({ clientId: 'synthetic-client' });
  const status = await service.beginLogin();
  assert.equal(status.userCode, 'TEST-ONLY'); assert(!JSON.stringify(status).includes('syntheticDeviceCode'));
  await service.login.promise;
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(service.getStatus().connected, true);
  assert.equal(service.getStatus().login, 'synthetic-user');
  assert.equal(calls.length, 5);
});

test('Cancelled device flow cannot persist a late token, and untrusted verification URLs are rejected', async (t) => {
  let release, reached;
  const started = new Promise((r) => { reached = r; });
  const { service } = fixture(t, { delay: async () => {}, fetch: async (url) => {
    if (url.endsWith('/device/code')) return Response.json(device());
    if (url.endsWith('/access_token')) { reached(); return new Promise((r) => { release = () => r(Response.json({ access_token: TOKEN, token_type: 'bearer' })); }); }
    return Response.json({ login: 'synthetic-user' });
  } });
  service.configure({ clientId: 'synthetic-client' }); await service.beginLogin(); await started;
  const completion = service.login.promise;
  service.signOut(); release(); await completion;
  assert.equal(service.getStatus().connected, false);
  service.fetch = async () => Response.json({ ...device(), verification_uri: 'https://example.invalid/login/device' });
  await assert.rejects(service.beginLogin(), /不正/);
});

test('SDK requests run in an empty isolated workspace, deny every tool, remove temporary data and do not inherit auth', async (t) => {
  let options, config, prompt, stopped = 0;
  const { service, authorize } = fixture(t, { clientFactory: (value) => {
    options = value;
    return { start: async () => {}, createSession: async (value) => { config = value; return { sendAndWait: async (value) => { prompt = value.prompt; return { data: { content: '{"name":"架空の企業"}' } }; } }; }, forceStop: async () => { stopped++; } };
  } });
  authorize();
  assert.equal(await service.generate({ model: 'auto', input: '架空の企業を整理' }), '{"name":"架空の企業"}');
  assert.equal(options.gitHubToken, TOKEN); assert.equal(options.useLoggedInUser, false); assert.equal(options.mode, 'empty');
  for (const key of ['GH_TOKEN','GITHUB_TOKEN','COPILOT_GITHUB_TOKEN','NODE_OPTIONS','COPILOT_CLI_PATH','OTEL_EXPORTER_OTLP_ENDPOINT']) assert.equal(options.env[key], undefined);
  assert.equal(options.env.HOME, path.dirname(options.workingDirectory));
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*', 'custom:*']);
  assert(config.onPermissionRequest({ kind: 'shell' }).kind.startsWith('denied-'));
  for (const key of ['enableConfigDiscovery','enableSkills','enableFileHooks','enableHostGitOperations','enableSessionStore','enableSessionTelemetry']) assert.equal(config[key], false);
  assert.equal(config.remoteSession, 'off'); assert.equal(config.infiniteSessions.enabled, false);
  assert(prompt.includes('Web検索やローカルファイル参照を使えません'));
  assert.equal(fs.existsSync(options.env.HOME), false); assert.equal(stopped, 1);
  const env = isolatedEnvironment('/synthetic'); assert.equal(env.COPILOT_GITHUB_TELEMETRY_DISABLED, 'true');
});

test('Copilot quota missing values remain unknown and model metadata is normalized without secrets', async (t) => {
  const { service, authorize } = fixture(t, { clientFactory: () => ({ start: async () => {}, forceStop: async () => {},
    listModels: async () => [{ id: 'auto', name: 'Auto' }, { id: 'bad\nmodel', name: 'invalid' }],
    rpc: { account: { getQuota: async () => ({ quotaSnapshots: { chat: { remainingPercentage: 40 }, missing: {}, unlimited: { isUnlimitedEntitlement: true } } }) } },
  }) });
  authorize(); const result = await service.details();
  assert.deepEqual(result.models, [{ id: 'auto', name: 'Auto' }]);
  assert.equal(result.quota[0].remainingPercentage, 40); assert.equal(result.quota[1].remainingPercentage, null);
  assert.equal(result.quota[2].unlimited, true);
});

test('Cancel and timeout stop SDK work, reject concurrent requests, suppress provider secrets and release the guard', async (t) => {
  let started; const ready = new Promise((r) => { started = r; });
  const { service, authorize } = fixture(t, { operationTimeout: 200, clientFactory: () => ({ start: async () => {}, forceStop: async () => {}, createSession: async () => ({ sendAndWait: () => { started(); return new Promise(() => {}); } }) }) });
  authorize(); const result = service.generate({ model: 'auto', input: 'test' }); await ready;
  await assert.rejects(service.generate({ model: 'auto', input: 'test' }), /進行中/);
  service.cancelGenerate(); await assert.rejects(result, /中断/); assert.equal(service.active, null);
  await assert.rejects(service.generate({ model: 'auto', input: 'test' }), /中断/);
  service.clientFactory = () => ({ start: async () => { throw new Error(TOKEN); }, forceStop: async () => {} });
  await assert.rejects(service.generate({ model: 'auto', input: 'test' }), (error) => !error.message.includes(TOKEN));
  assert.equal(service.active, null);
});

test('Corrupted Copilot credentials and symlinks fail closed without replacement; expiry requires reauthentication', (t) => {
  const { service, authorize, dir } = fixture(t);
  authorize();
  const value = service.read(); value.expiresAt = 1; service.write(value);
  assert.equal(service.getStatus().connected, false); assert.match(service.getStatus().error, /期限/);
  fs.writeFileSync(service.file, 'corrupted');
  assert.throws(() => service.configure({ clientId: 'synthetic-client' }), /変更していません/);
  assert.equal(fs.readFileSync(service.file, 'utf8'), 'corrupted');
  fs.rmSync(service.file); const target = path.join(dir, 'synthetic-target'); fs.writeFileSync(target, 'retained'); fs.symlinkSync(target, service.file);
  assert.throws(() => service.configure({ clientId: 'synthetic-client' }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'retained');
});
