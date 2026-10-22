'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseStore } = require('../src/backend/db.cjs');
const { createAppServer } = require('../src/backend/server.cjs');
const { CareerProfileStore } = require('../src/backend/career-profile-store.cjs');
const { createLinuxSecretToolStorage, createMacKeychainStorage } = require('../src/backend/credential-store.cjs');
const { assertSupportedRuntime } = require('../src/backend/runtime.cjs');
const { runtimeFiles, copyRuntime } = require('../scripts/stage.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-transaction-test-'));
  const store = new DatabaseStore({ dataDir: dir });
  const profile = (major) => ({ version: 1, completed: true, major, industries: '', roles: '', priorities: '', strengths: '' });
  store.createCompany({ name: '架空A', status: 'APPLIED' });
  store.profileStore.saveProfile(profile('架空専攻A'));
  const backup = store.exportBackup();
  store.updateCompany(store.listCompanies()[0].id, { name: '架空B' });
  store.profileStore.saveProfile(profile('架空専攻B'));
  store.executeImport({ kind: 'json', payload: backup });
  const baseline = store.exportBackup();
  const candidate = structuredClone(backup);
  candidate.data.companies[0].name = '架空C';
  candidate.data.careerProfile.major = '架空専攻C';
  const snapshotPath = path.join(store.backupDir, 'pre-import-latest.json');
  return { dir, store, baseline, candidate, snapshotPath, snapshot: fs.readFileSync(snapshotPath) };
}

for (const fault of ['journal-write', 'journal-fsync', 'snapshot-write', 'snapshot-fsync', 'snapshot-rename', 'snapshot-rename-after', 'commit', 'profile-after-write']) {
  test(`Import rolls back DB, profile and previous undo snapshot on ${fault}`, () => {
    const f = fixture();
    let fired = false;
    try {
      const io = { ...fs };
      const openFiles = new Map();
      io.openSync = (file, ...args) => {
        const fd = fs.openSync(file, ...args);
        openFiles.set(fd, String(file));
        return fd;
      };
      io.closeSync = (fd) => {
        openFiles.delete(fd);
        return fs.closeSync(fd);
      };
      io.fsyncSync = (fd) => {
        const prefix = fault === 'journal-fsync' ? f.store.recoveryPath : f.snapshotPath;
        if (!fired && fault.endsWith('-fsync') && openFiles.get(fd)?.startsWith(prefix + '.')) {
          fired = true; throw new Error('injected fsync failure');
        }
        return fs.fsyncSync(fd);
      };
      io.writeFileSync = (file, ...args) => {
        const prefix = fault === 'journal-write' ? f.store.recoveryPath : f.snapshotPath;
        if (!fired && ['journal-write', 'snapshot-write'].includes(fault) && String(file).startsWith(prefix + '.')) {
          fired = true; throw new Error('injected write failure');
        }
        return fs.writeFileSync(file, ...args);
      };
      io.renameSync = (source, target) => {
        if (!fired && fault.startsWith('snapshot-rename') && target === f.snapshotPath) {
          fired = true;
          if (fault.endsWith('-after')) fs.renameSync(source, target);
          throw new Error('injected rename failure');
        }
        return fs.renameSync(source, target);
      };
      f.store.fileIO = io;
      if (fault === 'commit') {
        const exec = f.store.db.exec.bind(f.store.db);
        f.store.db.exec = (sql) => {
          if (!fired && sql === 'COMMIT;') { fired = true; throw new Error('injected commit failure'); }
          return exec(sql);
        };
      }
      const originalSave = f.store.profileStore.saveProfile;
      if (fault === 'profile-after-write') {
        const save = f.store.profileStore.saveProfile.bind(f.store.profileStore);
        f.store.profileStore.saveProfile = (data) => { save(data); fired = true; throw new Error('injected profile failure'); };
      }
      assert.throws(() => f.store.executeImport({ kind: 'json', payload: f.candidate }), /injected/);
      assert.equal(fired, true);
      assert.deepEqual(f.store.exportBackup().data, f.baseline.data);
      assert.deepEqual(fs.readFileSync(f.snapshotPath), f.snapshot);
      assert.equal(fs.existsSync(f.store.recoveryPath), false);
      assert.equal(openFiles.size, 0);
      for (const parent of [f.dir, f.store.backupDir]) {
        assert.equal(fs.readdirSync(parent).some((name) => name.endsWith('.tmp')), false);
      }
      f.store.profileStore.saveProfile = originalSave;
      f.store.rollbackLastImport();
      assert.equal(f.store.listCompanies()[0].name, '架空B');
      assert.equal(f.store.profileStore.getProfile().major, '架空専攻B');
    } finally { f.store.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
}

for (const point of ['before-commit', 'after-commit']) {
  test(`A terminated import recovers consistently on next startup: ${point}`, () => {
    const f = fixture();
    f.store.close();
    try {
      const script = `
        const fs = require('node:fs');
        const path = require('node:path');
        const { DatabaseStore } = require(process.argv[1]);
        const dir = process.argv[2], point = process.argv[3];
        const io = {...fs};
        io.renameSync = (a,b) => {
          fs.renameSync(a,b);
          if (point === 'before-commit' && b === path.join(dir,'backups','pre-import-latest.json')) process.exit(23);
        };
        io.unlinkSync = (p) => {
          if (point === 'after-commit' && p === path.join(dir,'import-recovery.json')) process.exit(24);
          fs.unlinkSync(p);
        };
        const db = new DatabaseStore({dataDir:dir,fileIO:io});
        const candidate = db.exportBackup();
        candidate.data.companies[0].name='架空C';
        candidate.data.careerProfile.major='架空専攻C';
        db.executeImport({kind:'json',payload:candidate});
      `;
      const run = spawnSync(process.execPath, ['-e', script, require.resolve('../src/backend/db.cjs'), f.dir, point], { timeout: 10000 });
      assert.equal(run.status, point === 'before-commit' ? 23 : 24);
      const recovered = new DatabaseStore({ dataDir: f.dir });
      try {
        const committed = point === 'after-commit';
        assert.equal(recovered.listCompanies()[0].name, committed ? '架空C' : '架空A');
        assert.equal(recovered.profileStore.getProfile().major, committed ? '架空専攻C' : '架空専攻A');
        assert.equal(fs.existsSync(recovered.recoveryPath), false);
        if (!committed) assert.deepEqual(fs.readFileSync(f.snapshotPath), f.snapshot);
      } finally { recovered.close(); }
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('Persistent file recovery failure is visible and retained; recovery can be retried', () => {
  const f = fixture();
  try {
    f.store.fileIO = { ...fs, renameSync(a, b) {
      if (b === f.snapshotPath) throw new Error('persistent storage failure');
      return fs.renameSync(a, b);
    } };
    assert.throws(() => f.store.executeImport({ kind: 'json', payload: f.candidate }), /復旧が完了していません/);
    assert.equal(fs.existsSync(f.store.recoveryPath), true);
    assert.throws(() => f.store.listCompanies(), /復旧/);
    f.store.fileIO = fs;
    assert.deepEqual(f.store.exportBackup().data, f.baseline.data);
    assert.deepEqual(fs.readFileSync(f.snapshotPath), f.snapshot);
  } finally { f.store.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('Backup API reports profile corruption instead of silently omitting it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-backup-error-'));
  const profileStore = new CareerProfileStore(dir);
  fs.writeFileSync(profileStore.filePath, '{broken');
  const server = createAppServer({ dataDir: dir, profileStore, safeStorage: { isEncryptionAvailable: () => false } });
  try {
    const { origin, desktopToken } = await server.start();
    const response = await fetch(origin + '/api/data/backup', { headers: { 'x-desktop-token': desktopToken } });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /プロフィールの読み込みに失敗/);
    assert.equal(body.backup, undefined);
    assert.equal(fs.readFileSync(profileStore.filePath, 'utf8'), '{broken');
  } finally { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Key provisioning fails closed on service errors and malformed keys, without overwriting them', () => {
  for (const result of [{ status: 1, stdout: '', stderr: 'permission denied' }, { status: 0, stdout: 'invalid' }, { status: null, error: new Error('timeout') }]) {
    const calls = [];
    const storage = createLinuxSecretToolStorage({ spawnSync: (...args) => { calls.push(args); return result; } });
    assert.throws(() => storage.encryptString('synthetic-token'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1][0], 'lookup');
  }
  const calls = [];
  const storage = createLinuxSecretToolStorage({ spawnSync: (command, args, options) => {
    calls.push({ args, options });
    return args[0] === 'lookup' ? { status: 1, stdout: '', stderr: '' } : { status: 0 };
  } });
  const encrypted = storage.encryptString('synthetic-token');
  assert.equal(storage.decryptString(encrypted), 'synthetic-token');
  assert.equal(calls[1].args.includes(calls[1].options.input), false);
  assert.match(calls[1].options.input, /^[a-f0-9]{64}$/);
  assert.equal(createMacKeychainStorage().isEncryptionAvailable(), false);
  assert.throws(() => createMacKeychainStorage().encryptString('synthetic-token'), /ネイティブ保護機能/);
});

test('Runtime minimum is checked before loading SQLite', () => {
  for (const version of ['22.5.0', '22.13.0', '24.14.9', 'unknown']) assert.throws(() => assertSupportedRuntime(version), /24.15.0以降/);
  for (const version of ['24.15.0', '24.21.0', '26.11.1']) assert.doesNotThrow(() => assertSupportedRuntime(version));
});

test('Distribution staging only copies allowlisted source and assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-stage-'));
  try {
    const files = runtimeFiles('macos');
    assert.ok(files.includes(path.join('src', 'backend', 'db.cjs')));
    assert.equal(files.some((f) => /(^|[\\/])\.|\.(db|enc|key|pem)$/.test(f)), false);
    copyRuntime(dir, 'macos');
    assert.equal(fs.existsSync(path.join(dir, 'src/.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(dir, 'src/backend/runtime.cjs')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Merge preserves related records absent from the selected backup; rollback restores an absent profile file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-merge-'));
  const store = new DatabaseStore({ dataDir: dir });
  try {
    const company = store.createCompany({ name: '架空合併テスト', status: 'APPLIED' });
    const selected = store.exportBackup();
    const step = store.createStep({ companyId: company.id, stepName: '後から作成した選考', status: 'PENDING' });
    const event = store.createEvent({ companyId: company.id, stepId: step.id, title: '後から作成した予定', eventType: 'INTERVIEW', startAt: '2026-11-01T10:00:00+09:00' });
    selected.data.companies[0].name = '架空合併テスト（更新）';
    selected.data.careerProfile = { version: 1, completed: true, major: '架空専攻', industries: '', roles: '', priorities: '', strengths: '' };
    store.executeImport({ kind: 'json', payload: selected }, 'merge');
    assert.equal(store.getCompany(company.id).steps.some((s) => s.id === step.id), true);
    assert.equal(store.listEvents().some((e) => e.id === event.id && e.stepId === step.id), true);
    assert.equal(fs.existsSync(store.profileStore.filePath), true);
    store.rollbackLastImport();
    assert.equal(fs.existsSync(store.profileStore.filePath), false);
    assert.equal(store.getCompany(company.id).name, '架空合併テスト');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
