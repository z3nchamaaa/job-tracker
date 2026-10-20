'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { DatabaseStore } = require('../src/backend/db.cjs');
const { CareerProfileStore } = require('../src/backend/career-profile-store.cjs');

test('DatabaseStore CRUD, deletion impact count, and cascade delete', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-db-test-'));
  const store = new DatabaseStore({ dataDir: tmpDir });

  try {
    const company = store.createCompany({
      name: '株式会社テストキャリア',
      industry: 'IT',
      status: 'INTERVIEWING',
      isEarlySelection: true,
      priority: 5,
      annualIncome: 560,
    });
    assert.equal(company.name, '株式会社テストキャリア');
    assert.equal(company.priority, 5);
    assert.equal(company.annualIncome, 560);

    store.createStep({ companyId: company.id, stepName: 'ES提出', status: 'PASSED' });
    store.createStep({ companyId: company.id, stepName: '一次面接', status: 'PENDING' });
    store.createInterviewNote({ companyId: company.id, stepName: '一次面接', questions: '志望動機' });
    store.createEvent({
      companyId: company.id,
      title: '二次面接',
      eventType: 'INTERVIEW',
      startAt: '2026-10-25T05:00:00Z',
    });

    const impact = store.getCompanyDeletionImpact(company.id);
    assert.equal(impact.name, '株式会社テストキャリア');
    assert.equal(impact.stepsCount, 2);
    assert.equal(impact.interviewsCount, 1);
    assert.equal(impact.eventsCount, 1);

    const del = store.deleteCompany(company.id);
    assert.equal(del.name, '株式会社テストキャリア');
    assert.equal(store.listCompanies().length, 0);
    assert.equal(store.listEvents().length, 0);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DatabaseStore and CareerProfileStore detect corruption without silent wipe and support explicit recovery', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-corrupt-test-'));
  const badDbPath = path.join(tmpDir, 'job-tracker.db');
  const badProfilePath = path.join(tmpDir, 'career-profile.json');

  try {
    // Write invalid bytes to DB file and profile file
    fs.writeFileSync(badDbPath, 'NOT_A_VALID_SQLITE_FILE_HEADER_1234567890', 'utf8');
    fs.writeFileSync(badProfilePath, '{invalid json', 'utf8');

    const dbStore = new DatabaseStore({ dataDir: tmpDir, dbPath: badDbPath });
    const status = dbStore.getStatus();
    assert.equal(status.healthy, false);
    assert.match(status.corruptionError, /破損/);
    // Must not silently overwrite the corrupt file
    assert.equal(fs.readFileSync(badDbPath, 'utf8'), 'NOT_A_VALID_SQLITE_FILE_HEADER_1234567890');
    assert.throws(() => dbStore.listCompanies(), /破損/);

    // Explicit recovery archives corrupt file to backups/ and initializes fresh DB
    const rec = dbStore.recoverCorruptDatabase();
    assert.equal(rec.recovered, true);
    assert.ok(rec.archivedCorruptFile);
    assert.equal(dbStore.getStatus().healthy, true);
    assert.deepEqual(dbStore.listCompanies(), []);
    dbStore.close();

    // CareerProfileStore corruption detection and safe archival on save
    const profStore = new CareerProfileStore(tmpDir);
    assert.throws(() => profStore.getProfile(), /破損/);
    assert.equal(fs.readFileSync(badProfilePath, 'utf8'), '{invalid json');

    const saved = profStore.saveProfile({
      version: 1,
      completed: true,
      major: '情報工学',
      industries: 'IT',
      roles: 'エンジニア',
      priorities: '裁量',
      strengths: '推進力',
    });
    assert.equal(saved.major, '情報工学');
    assert.equal(profStore.getProfile().completed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Legacy SQLite .db import preview strips myPagePassword, executes transactionally, and supports rollback', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-legacy-mig-'));
  const legacyDbPath = path.join(tmpDir, 'legacy-v1.db');
  const dataDir = path.join(tmpDir, 'new-v2');
  fs.mkdirSync(dataDir, { recursive: true });

  // Create a synthetic legacy v1 SQLite database (with myPagePassword column)
  const legacyDb = new DatabaseSync(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE Company (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      industry TEXT,
      status TEXT,
      isEarlySelection INTEGER,
      priority INTEGER,
      myPageUrl TEXT,
      myPageId TEXT,
      myPagePassword TEXT,
      annualIncome INTEGER
    );
    CREATE TABLE SelectionStep (
      id TEXT PRIMARY KEY,
      companyId TEXT NOT NULL,
      stepName TEXT NOT NULL,
      stepOrder INTEGER,
      status TEXT
    );
    CREATE TABLE InterviewNote (
      id TEXT PRIMARY KEY,
      companyId TEXT NOT NULL,
      stepName TEXT NOT NULL
    );
    CREATE TABLE ScheduleEvent (
      id TEXT PRIMARY KEY,
      companyId TEXT,
      stepId TEXT,
      title TEXT NOT NULL,
      eventType TEXT,
      startAt TEXT NOT NULL,
      endAt TEXT,
      location TEXT,
      memo TEXT,
      isDone INTEGER
    );
    INSERT INTO Company (id, name, industry, status, isEarlySelection, priority, myPageUrl, myPageId, myPagePassword, annualIncome)
    VALUES ('leg-1', '旧版サンプル株式会社', 'メーカー', 'ES_PASSED', 1, 4, 'https://example.jp/legacy', 'leg_user', 'secret_plaintext_pw', 513);
  `);
  legacyDb.close();

  const store = new DatabaseStore({ dataDir });
  try {
    // Seed 1 existing company before import
    store.createCompany({ name: '既存株式会社', industry: 'IT', status: 'INTERESTED', priority: 3 });
    assert.equal(store.listCompanies().length, 1);

    const legacyBase64 = fs.readFileSync(legacyDbPath).toString('base64');
    const preview = store.previewImport({ kind: 'sqlite_base64', base64: legacyBase64 });
    assert.equal(preview.counts.companies, 1);
    assert.ok(preview.strippedFields.includes('myPagePassword'));

    const execRes = store.executeImport(
      {
        kind: 'sqlite_base64',
        base64: legacyBase64,
      },
      'replace'
    );
    assert.equal(execRes.imported, true);
    assert.equal(store.listCompanies().length, 1);
    assert.equal(store.listCompanies()[0].name, '旧版サンプル株式会社');

    // Rollback restores exact pre-import state ('既存株式会社')
    const rbRes = store.rollbackLastImport();
    assert.equal(rbRes.rolledBack, true);
    const remaining = store.listCompanies();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].name, '既存株式会社');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Import boundary rejects sqlite_file and arbitrary file paths at both dbStore and HTTP API', async () => {
  const { createAppServer } = require('../src/backend/server.cjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-import-boundary-'));
  const dataDir = path.join(tmpDir, 'data');
  const fakeFilePath = path.join(tmpDir, 'fictional-secret.db');
  fs.writeFileSync(fakeFilePath, 'fictional-content', 'utf8');

  const appServer = createAppServer({ dataDir });
  const { origin, bootstrapUrl, desktopToken, csrfToken } = await appServer.start(0);

  try {
    assert.throws(
      () => appServer.dbStore.previewImport({ kind: 'sqlite_file', filePath: fakeFilePath }),
      /ファイルパスの直接指定/
    );
    assert.throws(
      () => appServer.dbStore.executeImport({ kind: 'sqlite_file', filePath: fakeFilePath }, 'replace'),
      /ファイルパスの直接指定/
    );
    assert.throws(
      () => appServer.dbStore.previewImport({ kind: 'json', payload: '{}', path: fakeFilePath }),
      /ファイルパスの直接指定/
    );

    const bootRes = await fetch(bootstrapUrl);
    const cookieHeader = (bootRes.headers.get('set-cookie') || '').split(';')[0];

    const headers = {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: cookieHeader,
      'x-jt-desktop-token': desktopToken,
      'x-jt-csrf': csrfToken,
    };

    const prevRes = await fetch(`${origin}/api/data/import/preview`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'sqlite_file', filePath: fakeFilePath }),
    });
    assert.equal(prevRes.status, 400);
    const prevJson = await prevRes.json();
    assert.match(prevJson.error, /ファイルパスの直接指定/);

    const execRes = await fetch(`${origin}/api/data/import/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'json', payload: '{}', filePath: fakeFilePath }),
    });
    assert.equal(execRes.status, 400);
    const execJson = await execRes.json();
    assert.match(execJson.error, /ファイルパスの直接指定/);
  } finally {
    await appServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Backup export, import preview/execute, and rollback atomically include careerProfile and preserve valid snapshot on failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-atomic-profile-'));
  const dataDir = path.join(tmpDir, 'data');
  const profileStore = new CareerProfileStore(dataDir);
  const store = new DatabaseStore({ dataDir, profileStore });

  try {
    // 1. Seed initial state A (Company A + Profile A)
    store.createCompany({ name: '初期企業A株式会社', industry: 'IT', status: 'APPLIED', priority: 4 });
    const profileA = profileStore.saveProfile({
      version: 1,
      completed: true,
      major: '情報工学A',
      industries: 'クラウドA',
      roles: 'バックエンドエンジニア',
      priorities: '技術的裁量A',
      strengths: '分散基盤構築A',
    });

    const backupA = store.exportBackup(profileA);
    assert.equal(backupA.data.careerProfile.major, '情報工学A');

    // 2. Mutate state to B (Company B + Profile B)
    const compAId = store.listCompanies()[0].id;
    store.deleteCompany(compAId);
    store.createCompany({ name: '変更後企業B株式会社', industry: '金融', status: 'INTERVIEWING', priority: 5 });
    profileStore.saveProfile({
      version: 1,
      completed: true,
      major: '金融工学B',
      industries: 'フィンテックB',
      roles: 'クオンツ',
      priorities: '安定基盤B',
      strengths: '数理モデルB',
    });

    // 3. Preview and Execute import of Backup A (restores both Company A and Profile A, saving State B as rollback snapshot)
    const previewA = store.previewImport({ kind: 'json', payload: JSON.stringify(backupA) });
    assert.equal(previewA.hasCareerProfile, true);
    assert.equal(previewA.counts.companies, 1);

    const execA = store.executeImport({ kind: 'json', payload: JSON.stringify(backupA) }, 'replace');
    assert.equal(execA.imported, true);
    assert.equal(execA.profileRestored, true);
    assert.equal(store.listCompanies().length, 1);
    assert.equal(store.listCompanies()[0].name, '初期企業A株式会社');
    assert.equal(profileStore.getProfile().major, '情報工学A');
    assert.equal(profileStore.getProfile().priorities, '技術的裁量A');

    // 4. Reject corrupted careerProfile in backup JSON without touching DB or Profile
    const badBackup = {
      ...backupA,
      data: {
        ...backupA.data,
        companies: [{ name: '不正インポート企業', industry: 'IT', status: 'INTERESTED', priority: 3 }],
        careerProfile: { version: 1, completed: true, major: 99999 },
      },
    };
    assert.throws(
      () => store.previewImport({ kind: 'json', payload: JSON.stringify(badBackup) }),
      /就活プロフィールが不正/
    );
    assert.throws(
      () => store.executeImport({ kind: 'json', payload: JSON.stringify(badBackup) }, 'replace'),
      /就活プロフィールが不正/
    );
    assert.equal(store.listCompanies()[0].name, '初期企業A株式会社');
    assert.equal(profileStore.getProfile().major, '情報工学A');

    // 5. Simulate profileStore.saveProfile failure mid-import:
    //    SQLite transaction must roll back AND previous rollback snapshot (State B) must NOT be overwritten!
    const validBackupC = {
      ...backupA,
      data: {
        ...backupA.data,
        companies: [{ name: '途中失敗企業C株式会社', industry: 'メーカー', status: 'OFFER', priority: 5 }],
        careerProfile: {
          version: 1,
          completed: true,
          major: '機械工学C',
          industries: 'ロボティクス',
          roles: '制御エンジニア',
          priorities: 'ものづくりC',
          strengths: 'ROS開発C',
        },
      },
    };

    const origSaveProfile = profileStore.saveProfile.bind(profileStore);
    profileStore.saveProfile = () => {
      throw new Error('模擬的なプロフィール保存I/Oエラー');
    };
    try {
      assert.throws(
        () => store.executeImport({ kind: 'json', payload: JSON.stringify(validBackupC) }, 'replace'),
        /模擬的なプロフィール保存I/
      );
    } finally {
      profileStore.saveProfile = origSaveProfile;
    }

    // Verify neither DB nor profile was partially updated to C
    assert.equal(store.listCompanies().length, 1);
    assert.equal(store.listCompanies()[0].name, '初期企業A株式会社');
    assert.equal(profileStore.getProfile().major, '情報工学A');

    // Verify rollbackLastImport STILL restores State B (because failed import C did not overwrite pre-import-latest.json)
    const rbToB = store.rollbackLastImport();
    assert.equal(rbToB.rolledBack, true);
    assert.equal(store.listCompanies().length, 1);
    assert.equal(store.listCompanies()[0].name, '変更後企業B株式会社');
    assert.equal(profileStore.getProfile().major, '金融工学B');
    assert.equal(profileStore.getProfile().priorities, '安定基盤B');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

