'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AppSettingsStore, createNativeAppAuth, authenticateStartup, createAppSettingsService } = require('../src/backend/app-settings.cjs');
const { createAppServer } = require('../src/backend/server.cjs');
const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-settings-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new AppSettingsStore(dir) };
};

test('Settings persist independently, validate strictly, reject corrupt/symlink files, and default lock to off', (t) => {
  const { dir, store } = fixture(t);
  assert.equal(store.read().lockOnStartup, false);
  store.savePatch({ theme: 'dark', accent: 'blue', lockOnStartup: true });
  assert.deepEqual(new AppSettingsStore(dir).read(), { version: 1, theme: 'dark', accent: 'blue', lockOnStartup: true });
  for (const patch of [{ theme: '<script>' }, { lockOnStartup: 0 }, { accent: 'bad' }, { authenticated: true }]) assert.throws(() => store.savePatch(patch));
  assert.equal(store.read().lockOnStartup, true);
  fs.writeFileSync(store.file, '{');
  assert.throws(() => store.read(), /起動を停止/);
  fs.unlinkSync(store.file);
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ version: 1, theme: 'light', accent: 'purple', lockOnStartup: false }));
  fs.symlinkSync(other, store.file);
  assert.throws(() => store.read(), /起動を停止/);
});

test('Lock changes require OS verification both ways; cancelled auth cannot persist any settings; concurrent changes rejected', async (t) => {
  const { store } = fixture(t);
  let calls = 0, fail = true, release;
  const auth = { availability: async () => ({ available: true }), authenticate: async () => { calls++; if (fail) throw new Error('認証キャンセル'); if (release === 'wait') await new Promise((resolve) => { release = resolve; }); } };
  const service = createAppSettingsService(store, auth);
  await assert.rejects(service.update({ lockOnStartup: true, theme: 'dark' }), /キャンセル/);
  assert.equal(store.read().theme, 'system');
  assert.equal(store.read().lockOnStartup, false);
  fail = false;
  await service.update({ lockOnStartup: true });
  fail = true;
  await assert.rejects(service.update({ lockOnStartup: false }), /キャンセル/);
  assert.equal(store.read().lockOnStartup, true);
  fail = false;
  await service.update({ theme: 'light' });
  assert.equal(calls, 3, 'Theme-only changes need no authentication');
  release = 'wait';
  const saving = service.update({ lockOnStartup: false });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.update({ theme: 'dark' }), /進行中/);
  release(); await saving;
  assert.equal(store.read().lockOnStartup, false);
});

test('Startup is fail-closed before DB creation and unsupported platforms cannot enable lock', async (t) => {
  const { dir, store } = fixture(t);
  const auth = createNativeAppAuth({ platform: 'linux' });
  await assert.rejects(createAppSettingsService(store, auth).update({ lockOnStartup: true }), /ネイティブアプリ/);
  store.savePatch({ lockOnStartup: true });
  await assert.rejects(authenticateStartup(store, auth));
  assert.throws(() => createAppServer({ dataDir: dir }), /認証が必要/);
  assert.equal(fs.existsSync(path.join(dir, 'job-tracker.db')), false);
  assert.equal(fs.existsSync(path.join(dir, 'auth')), false);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/backend/cli.cjs')], { env: { ...process.env, JOB_TRACKER_DATA_DIR: dir, JOB_TRACKER_HOST_BINARY: '', JOB_TRACKER_ALLOW_DEV_SESSION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', (s) => { stdout += s; }); child.stderr.resume();
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 1);
  assert.equal(stdout, '', 'No bootstrap session can be issued before authentication');
  assert.equal(fs.existsSync(path.join(dir, 'job-tracker.db')), false);
});

test('Native helper errors, cancellation and unexpected output never authenticate', async () => {
  for (const hostBinaryPath of ['/nonexistent/jt-host', '/usr/bin/true', '/usr/bin/false']) {
    const auth = createNativeAppAuth({ hostBinaryPath, platform: 'darwin' });
    assert.equal((await auth.availability()).available, false);
    await assert.rejects(auth.authenticate(), /ロックを解除しません/);
  }
});

test('A failed atomic settings replacement retains the enabled lock and previous theme', (t) => {
  const { store } = fixture(t);
  store.savePatch({ lockOnStartup: true, theme: 'dark' });
  const original = fs.readFileSync(store.file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === store.file) throw new Error('injected settings replacement failure');
    return rename(from, to);
  };
  try { assert.throws(() => store.savePatch({ lockOnStartup: false, theme: 'light' })); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(store.file, 'utf8'), original);
  assert.equal(store.read().lockOnStartup, true);
  assert.equal(fs.readdirSync(path.dirname(store.file)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('Settings survive server restart and first HTML paint receives only validated theme values', async (t) => {
  const { dir } = fixture(t);
  for (let pass = 0; pass < 2; pass++) {
    const app = createAppServer({ dataDir: dir, allowDevBrowserSession: true, safeStorage: { isEncryptionAvailable: () => false } });
    try {
      if (pass === 0) await app.ipcDispatcher.invoke('saveAppSettings', { theme: 'dark', accent: 'green' });
      const { bootstrapUrl } = await app.start(0);
      const html = await (await fetch(bootstrapUrl)).text();
      assert.match(html, /data-theme="dark" data-accent="green"/);
      const settings = await app.ipcDispatcher.invoke('getAppSettings');
      assert.equal(settings.lockOnStartup, false);
      assert.equal(settings.theme, 'dark');
    } finally { await app.stop(); }
  }
});
