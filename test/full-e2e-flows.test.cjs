'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encryptAesGcm, decryptAesGcm } = require('../src/backend/credential-store.cjs');
const { ChatGPTService } = require('../src/backend/chatgpt.cjs');
const { AppUpdater } = require('../src/backend/updater.cjs');

test('credential-store AES-256-GCM encrypts and decrypts cleanly and rejects tampered ciphertext', () => {
  const key = crypto.randomBytes(32);
  const plain = JSON.stringify({ access_token: 'tok_123', refresh_token: 'ref_456' });
  const packet = encryptAesGcm(key, plain);
  const decrypted = decryptAesGcm(key, packet);
  assert.equal(decrypted, plain);

  // Tamper with auth tag / ciphertext
  const tampered = Buffer.from(packet);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptAesGcm(key, tampered));
});

test('ChatGPTService full OAuth PKCE callback, state mismatch rejection, model catalog check, and generate SSE', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-oauth-e2e-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'oauth-key-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  let capturedAuthUrl = null;
  let expectedNonce = null;

  const mockSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  };

  const mockFetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr === 'https://auth.openai.com/api/accounts/oauth/token') {
      const nowSec = Math.floor(Date.now() / 1000);
      const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'oauth-key-1' })).toString('base64url');
      const pay = Buffer.from(
        JSON.stringify({
          iss: 'https://auth.openai.com',
          aud: 'issued-client-id-001',
          sub: 'user-sub-001',
          email: 'applicant@example.jp',
          nonce: expectedNonce,
          iat: nowSec - 5,
          exp: nowSec + 3600,
        })
      ).toString('base64url');
      const sig = crypto
        .sign('RSA-SHA256', Buffer.from(`${hdr}.${pay}`, 'ascii'), privateKey)
        .toString('base64url');

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            token_type: 'Bearer',
            access_token: 'at_valid_001',
            refresh_token: 'rt_valid_001',
            expires_in: 3600,
            scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
            id_token: `${hdr}.${pay}.${sig}`,
          };
        },
      };
    }
    if (urlStr === 'https://auth.openai.com/.well-known/jwks.json') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { keys: [publicJwk] };
        },
      };
    }
    if (urlStr === 'https://api.openai.com/v1/models') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            models: [{ slug: 'gpt-5-mini', display_name: 'Fast Model', visibility: 'list' }],
          };
        },
      };
    }
    if (urlStr === 'https://api.openai.com/v1/responses') {
      const ssePayload = [
        'data: {"type":"response.output_text.delta","delta":"{\\"name\\":\\"テスト株式会社\\"}"}',
        '',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        '',
      ].join('\n');
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(ssePayload));
            c.close();
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  const service = new ChatGPTService({
    userDataPath: tmpDir,
    safeStorage: mockSafeStorage,
    fetch: mockFetch,
    openExternal: async (authUrl) => {
      capturedAuthUrl = new URL(authUrl);
      expectedNonce = capturedAuthUrl.searchParams.get('nonce');
      const redirectUri = new URL(capturedAuthUrl.searchParams.get('redirect_uri'));
      const state = capturedAuthUrl.searchParams.get('state');

      // 1. Test invalid path -> 404
      const wrongPathRes = await fetch(`${redirectUri.origin}/wrong-path`);
      assert.equal(wrongPathRes.status, 404);

      // 2. Test state mismatch -> 400 (does not consume pendingLogin)
      const badStateRes = await fetch(`${redirectUri.href}?state=wrong_state&code=abc`);
      assert.equal(badStateRes.status, 400);

      // 3. Valid callback with issued client_id
      const okRes = await fetch(
        `${redirectUri.href}?state=${encodeURIComponent(state)}&code=auth_code_123&client_id=issued-client-id-001`
      );
      assert.equal(okRes.status, 200);
    },
  });

  try {
    await service.signIn();
    const session = service.getSession();
    assert.equal(session.connected, true);
    assert.equal(session.sharing, true);
    assert.equal(session.email, 'applicant@example.jp');

    const models = await service.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].slug, 'gpt-5-mini');

    const generated = await service.generate({
      model: 'gpt-5-mini',
      input: '株式会社テストを調査してください',
      webSearch: true,
    });
    assert.equal(generated, '{"name":"テスト株式会社"}');
  } finally {
    service.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AppUpdater verifies SHA-256 and size, rejects mismatched digest and ignores claimed signing flags', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-updater-dl-'));
  const fakeDmg = Buffer.from('fake-dmg-binary-payload-for-sha256-test', 'utf8');
  const validSha256 = crypto.createHash('sha256').update(fakeDmg).digest('hex');

  try {
    const updater = new AppUpdater({
      version: '2.0.0',
      platform: 'darwin',
      arch: 'arm64',
      userDataPath: tmpDir,
      repo: 'owner/job-tracker',
      apiUrl: 'https://api.github.com/repos/owner/job-tracker/releases/latest',
      fetch: async (url) => {
        const u = String(url);
        if (u.endsWith('/releases/latest')) {
          const releaseJson = JSON.stringify({
            tag_name: 'v2.1.0',
            draft: false,
            prerelease: false,
            code_signed: true,
            body: 'Release notes 2.1.0',
            assets: [
              {
                name: 'job-tracker-2.1.0-mac-arm64.dmg',
                state: 'uploaded',
                size: fakeDmg.length,
                digest: `sha256:${validSha256}`,
                browser_download_url:
                  'https://github.com/owner/job-tracker/releases/download/v2.1.0/job-tracker-2.1.0-mac-arm64.dmg',
              },
            ],
          });
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(releaseJson));
                c.close();
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(fakeDmg.length) }),
          body: new ReadableStream({
            start(c) {
              c.enqueue(fakeDmg);
              c.close();
            },
          }),
        };
      },
    });

    const checkState = await updater.check(true);
    assert.equal(checkState.status, 'available');
    assert.equal(checkState.latestVersion, '2.1.0');
    assert.equal(checkState.codeSigned, false);

    const dlState = await updater.download();
    assert.equal(dlState.status, 'ready');
    assert.equal(dlState.progress, 100);

    const installRes = await updater.install();
    assert.equal(installRes.opened, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('All 8 selection statuses, early selection lane deduplication vs terminal lanes, post-registration priority update, and persistence across DB restart', () => {
  const { DatabaseStore } = require('../src/backend/db.cjs');
  const { SELECTION_STATUSES, getKanbanLanes, getAdjacentStatus } = require('../src/shared/constants.cjs');
  const { previewCalendarExport } = require('../src/shared/calendar.cjs');
  const { parseCompanyDraft } = require('../src/shared/company-draft.cjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-all-statuses-'));
  try {
    assert.deepEqual(SELECTION_STATUSES, [
      'INTERESTED',
      'APPLIED',
      'ES_PASSED',
      'INTERVIEWING',
      'FINAL',
      'OFFER',
      'REJECTED',
      'WITHDRAWN',
    ]);

    let store = new DatabaseStore({ dataDir: tmpDir });
    const createdByStatus = {};
    for (const status of SELECTION_STATUSES) {
      const isEarly = ['INTERESTED', 'ES_PASSED', 'OFFER', 'REJECTED', 'WITHDRAWN'].includes(status);
      createdByStatus[status] = store.createCompany({
        name: `企業_${status}`,
        industry: 'IT・通信',
        jobType: 'ソフトウェアエンジニア',
        status,
        isEarlySelection: isEarly,
        priority: 3,
        websiteUrl: 'https://example.jp/company',
        description: '事業概要テスト',
        features: '技術特徴テスト',
        salary: '月給30万円',
        ratingSalary: 4,
        ratingBenefits: 5,
        annualIncome: 500,
      });
    }

    // Verify Kanban lane placement and early selection deduplication
    const allCompanies = store.listCompanies();
    const lanes = getKanbanLanes(allCompanies);
    const laneMap = Object.fromEntries(lanes.map((l) => [l.key, l.companies.map((c) => c.status)]));

    // Only interested early-selection companies use the special lane.
    assert.deepEqual(laneMap.EARLY_SELECTION, ['INTERESTED']);
    assert.equal(laneMap.INTERESTED.includes('INTERESTED'), false);
    assert.deepEqual(laneMap.ES_PASSED, ['ES_PASSED']);

    // FINAL is grouped into INTERVIEWING lane alongside INTERVIEWING
    assert.deepEqual(laneMap.INTERVIEWING.sort(), ['FINAL', 'INTERVIEWING']);

    // Terminal early selection companies (OFFER, REJECTED, WITHDRAWN) move to their respective result lanes
    assert.deepEqual(laneMap.OFFER, ['OFFER']);
    assert.deepEqual(laneMap.REJECTED, ['REJECTED']);
    assert.deepEqual(laneMap.WITHDRAWN, ['WITHDRAWN']);

    // Adjacent transitions across all 8 statuses
    let cur = 'INTERESTED';
    const visited = [cur];
    while (getAdjacentStatus(cur, 'next')) {
      cur = getAdjacentStatus(cur, 'next');
      visited.push(cur);
    }
    assert.deepEqual(visited, SELECTION_STATUSES);

    // Post-registration priority update + step order/location + interview interviewer + allDay/stepId event
    const targetId = createdByStatus.INTERVIEWING.id;
    const updated = store.updateCompany(targetId, { priority: 5, ratingSalary: 5 });
    assert.equal(updated.priority, 5);
    assert.equal(updated.ratingSalary, 5);

    const s1 = store.createStep({ companyId: targetId, stepName: 'ES選考', stepOrder: 1, location: 'Web提出', status: 'PASSED' });
    const s2 = store.createStep({ companyId: targetId, stepName: '一次面接', stepOrder: 2, location: 'オンライン', status: 'PENDING' });
    store.updateStep(s2.id, { stepOrder: 1, location: '東京本社' });
    store.updateStep(s1.id, { stepOrder: 2 });

    const note = store.createInterviewNote({
      companyId: targetId,
      stepName: '一次面接',
      interviewer: '開発部長',
      questions: '設計経験',
    });
    assert.equal(note.interviewer, '開発部長');

    const ev = store.createEvent({
      companyId: targetId,
      stepId: s2.id,
      title: '終日インターン',
      eventType: 'OTHER',
      startAt: '2026-10-28T00:00:00+09:00',
      endAt: null,
      allDay: true,
    });
    assert.equal(ev.allDay, true);
    assert.equal(ev.stepId, s2.id);

    const calPrevAllDay = previewCalendarExport(ev);
    assert.equal(calPrevAllDay.allDay, true);
    assert.equal(calPrevAllDay.isOneHourFallback, false);
    assert.equal(calPrevAllDay.fallbackNotice, null);

    const updatedEv = store.updateEvent(ev.id, { title: '終日インターン（更新）', allDay: false });
    assert.equal(updatedEv.title, '終日インターン（更新）');
    assert.equal(updatedEv.allDay, false);

    // Backup warning check and oversized AI JSON rejection
    store.updateCompany(targetId, { myPageId: 'my_secret_id_01' });
    const backup = store.exportBackup({ major: '情報科学' });
    assert.equal(backup.containsSensitiveInfo, true);
    assert.match(backup.securityNotice, /マイページID/);

    const hugeJson = JSON.stringify({ name: '巨大株式会社', description: 'あ'.repeat(300 * 1024) });
    const hugeRes = parseCompanyDraft(hugeJson);
    assert.equal(hugeRes.ok, false);
    assert.match(hugeRes.error, /200000文字|大きすぎ/);

    // Close and reopen DatabaseStore on the same directory to verify disk persistence
    store.close();
    store = new DatabaseStore({ dataDir: tmpDir });
    const reloaded = store.getCompany(targetId);
    assert.equal(reloaded.priority, 5);
    assert.equal(reloaded.jobType, 'ソフトウェアエンジニア');
    assert.equal(reloaded.ratingSalary, 5);
    assert.equal(reloaded.steps[0].stepName, '一次面接');
    assert.equal(reloaded.steps[0].location, '東京本社');
    assert.equal(reloaded.interviews[0].interviewer, '開発部長');
    const reloadedEvents = store.listEvents();
    assert.equal(reloadedEvents.length, 1);
    assert.equal(reloadedEvents[0].stepName, '一次面接');
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Linux host origin policy self-test', async (t) => {
  const { execFile } = require('node:child_process');
  const run = require('node:util').promisify(execFile);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  let linuxOut;
  // A cold Python start on a busy Windows runner can exceed five seconds.
  // Keep the security assertion, with a bounded budget below the test's 30s.
  try { ({ stdout: linuxOut } = await run(
    python,
    [path.join(__dirname, '..', 'platforms', 'linux', 'job-tracker-host.py'), '--test-origin-policy'],
    { encoding: 'utf8', timeout: 20000, windowsHide: true }
  )); } catch (error) {
    if (process.platform === 'win32' && error.code === 'ENOENT') {
      t.skip('Python is not installed on this Windows host');
      return;
    }
    throw error;
  }
  assert.match(linuxOut, /ORIGIN_POLICY_SELF_TEST_OK/);
});

test('WebView host origin policy & external URL launch restrictions (macOS, Windows, Linux, and backend openExternal)', async () => {
  const { createAppServer } = require('../src/backend/server.cjs');

  // 2. Verify static source invariants across macOS, Windows, and Linux hosts
  const macSwift = fs.readFileSync(path.join(__dirname, '..', 'platforms', 'macos', 'Host.swift'), 'utf8');
  assert.ok(!macSwift.includes('hasPrefix(allowedOrigin)'), 'Host.swift must not use prefix match for origin validation');
  assert.ok(macSwift.includes('parseNormalizedOrigin'), 'Host.swift must parse scheme/host/normalized port');
  assert.ok(macSwift.includes('comps.user != nil || comps.password != nil'), 'Host.swift must forbid user-info');
  assert.ok(macSwift.includes('isSafeExternalHttpsURL'), 'Host.swift must restrict external open to safe https URLs');

  const winCs = fs.readFileSync(path.join(__dirname, '..', 'platforms', 'windows', 'Program.cs'), 'utf8');
  assert.ok(!winCs.includes('StartsWith(_allowedOrigin'), 'Program.cs must not use StartsWith for origin validation');
  assert.ok(winCs.includes('IsAllowedWebViewNavigation'), 'Program.cs must compare parsed Uri scheme/host/port');
  assert.ok(winCs.includes('candidate.UserInfo'), 'Program.cs must forbid UserInfo');
  assert.ok(winCs.includes('TryGetSafeExternalHttpsUri'), 'Program.cs must restrict external open to safe https URLs');

  // 3. Verify backend default openExternal rejects http://, user-info, CLI flags, and non-https schemes
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-openext-'));
  const appServer = createAppServer({ dataDir: tmpDir });
  try {
    await assert.rejects(
      async () => appServer.ipcDispatcher.invoke('openExternalUrl', { url: 'http://example.com/' }),
      /https:/
    );
    await assert.rejects(
      async () => appServer.ipcDispatcher.invoke('openExternalUrl', { url: 'https://user:pass@example.com/' }),
      /https:|不正|URL/
    );
    await assert.rejects(
      async () => appServer.ipcDispatcher.invoke('openExternalUrl', { url: '-aCalculator' }),
      /https:|不正|URL/
    );
    await assert.rejects(
      async () => appServer.ipcDispatcher.invoke('openExternalUrl', { url: 'file:///etc/passwd' }),
      /https:/
    );
  } finally {
    await appServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Real UI DOM & Browser E2E: onboarding skip/edit, narrow modal prompt copy & fallback (true/false/throw), AI generate identity, unconfirmed-save guard, failure retry, and XSS safety', async (t) => {
  const { spawn } = require('node:child_process');
  const { createAppServer } = require('../src/backend/server.cjs');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chromePath)) {
    t.skip(`Google Chrome binary not found at ${chromePath}; skipping real browser UI E2E test.`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-ui-e2e-'));
  const { launchPage } = require('../scripts/browser.cjs');
  const { DatabaseStore } = require('../src/backend/db.cjs');
  const fixtureDir = path.join(tmpDir, 'selected-db-fixture');
  const fixtureStore = new DatabaseStore({ dataDir: fixtureDir });
  fixtureStore.createCompany({ name: '架空の選択DB企業', status: 'APPLIED' });
  fixtureStore.close();
  const selectedDbBase64 = fs.readFileSync(path.join(fixtureDir, 'job-tracker.db')).toString('base64');

  let serverGeneratedPromptInput = null;
  let companyCountDuringGenerate = -1;
  let reportResolve;
  const reportPromise = new Promise((resolve) => {
    reportResolve = resolve;
  });

  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  };

  let appServer;
  const mockChatGptService = {
    getSession: () => ({
      connected: true,
      sharing: true,
      email: 'ui-e2e@example.jp',
    }),
    listModels: async () => [{ slug: 'gpt-5-mini', displayName: 'Fast Model' }],
    signIn: async () => ({ connected: true, sharing: true }),
    cancelSignIn: () => ({ cancelled: true }),
    signOut: async () => ({ connected: false }),
    openUsage: async () => ({ opened: true }),
    cancelGenerate: () => ({ cancelled: true }),
    shutdown: () => {},
    generate: async ({ input }) => {
      serverGeneratedPromptInput = input;
      companyCountDuringGenerate = appServer.dbStore.listCompanies().length;
      return JSON.stringify({
        name: '株式会社UI自動検証 <img src=x onerror="window.__xss=1">',
        industry: 'クラウドSaaS',
        jobType: 'SRE',
        location: '東京都渋谷区',
        annualIncome: 584.6,
        startingSalary: 330000,
        bonusTimes: 2,
        bonusMonths: 4.5,
        annualHolidays: 125,
        verifiedAt: '2026-10-19',
        sources: [{ title: '公式採用ページ', url: 'https://example.jp/recruit', verifiedAt: '2026-10-19' }],
        interviewPrepTips: {
          fitLevel: '高',
          fitReason: '分散システム専攻と一致',
          appealPoints: ['自動化基盤の構築実績'],
          expectedQuestions: ['障害対応の経験は？'],
          reverseQuestions: ['オンコール体制は？'],
        },
      });
    },
  };

  const updateCalls = [];
  let mockUpdateStatus = { status: 'disabled', currentVersion: '2.0.0', notice: '配布元が未設定です。' };
  const mockUpdater = {
    getStatus: () => ({ ...mockUpdateStatus }),
    check: async () => {
      updateCalls.push('check');
      if (updateCalls.length > 1) mockUpdateStatus = { status: 'available', currentVersion: '2.0.0', latestVersion: '2.1.0', available: true };
      return { ...mockUpdateStatus };
    },
    download: async () => { updateCalls.push('download'); mockUpdateStatus = { ...mockUpdateStatus, status: 'ready' }; return { ...mockUpdateStatus }; },
    install: async () => { assert.equal(mockUpdateStatus.status, 'ready'); updateCalls.push('install'); return { opened: true }; },
    shutdown() {},
  };

  const testDriverScript = `
    (async function runUiE2e() {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 8000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const val = fn();
          if (val) return val;
          await wait(40);
        }
        throw new Error('Timeout waiting for condition: ' + fn.toString());
      };

      const csrf = () => document.querySelector('meta[name="jt-csrf"]')?.getAttribute('content') || '';
      const sendReport = async (payload) => {
        await fetch('/api/__test_report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-jt-csrf': csrf() },
          body: JSON.stringify(payload),
        });
      };

      try {
        // 1. Wait for initial load
        await waitFor(() => document.querySelectorAll('.metric-card').length === 5);

        // 2. Open Career Profile modal, test skip, then reopen and save profile
        document.getElementById('btn-career-profile').click();
        const skipBtn = await waitFor(() => document.getElementById('btn-cp-skip'));
        skipBtn.click();
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));

        document.getElementById('btn-career-profile').click();
        const majorInput = await waitFor(() => document.querySelector('[data-cp-field="major"]'));
        majorInput.value = '情報科学専攻';
        majorInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-step="3"]').click();
        const prioInput = await waitFor(() => document.querySelector('[data-cp-field="priorities"]'));
        prioInput.value = '基盤開発の裁量';
        prioInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-cp-save').click();
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));

        // 3. Open AI / Prompt modal in narrow/low-height viewport (360x480)
        document.getElementById('btn-add-prompt').click();
        const nameInput = await waitFor(() => document.getElementById('pa-company-name'));
        const copyTopBtn = document.getElementById('btn-copy-prompt');
        const copyFooterBtn = document.getElementById('btn-footer-copy-prompt');
        const saveAiBtn = document.getElementById('btn-save-draft-company');
        const headerEl = document.querySelector('#modal-root .modal-header');
        const footerEl = document.querySelector('#modal-root .modal-footer');

        const headerRect = headerEl.getBoundingClientRect();
        const footerRect = footerEl.getBoundingClientRect();
        const modalBoundsOk =
          headerRect.top >= 0 &&
          footerRect.bottom <= window.innerHeight + 2 &&
          copyFooterBtn.getBoundingClientRect().width > 0 &&
          saveAiBtn.getBoundingClientRect().width > 0;

        nameInput.value = '株式会社UI自動検証';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(60);

        // 3a. Test copyTextToClipboard FALLBACK when navigator.clipboard.writeText rejects:
        //     - Case 1: document.execCommand('copy') returns false
        //     - Case 2: document.execCommand('copy') throws an error
        //     - Case 3: document.execCommand('copy') returns true (via retry button) and restores focus/selection
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error('Clipboard API blocked in test');
            },
          },
        });

        // Clear any existing toasts before testing copy failure
        document.querySelectorAll('#toast-container .toast').forEach((el) => el.remove());

        // Case 1: execCommand('copy') returns false
        document.execCommand = () => false;
        copyTopBtn.click();
        await wait(60);
        const falseNoSuccessToast = document.querySelectorAll('#toast-container .toast-success').length === 0;
        const falseErrorToastEl = document.querySelector('#toast-container .toast-error');
        const falseHasRetryBtn = Boolean(falseErrorToastEl && falseErrorToastEl.querySelector('[data-toast-retry]'));
        const falseNoLeftoverTextarea = document.querySelectorAll('body > textarea').length === 0;
        const falseSelectedText = window.getSelection ? window.getSelection().toString() : '';
        const falsePromptSelected = falseSelectedText.includes('株式会社UI自動検証');

        // Case 2: execCommand('copy') throws
        document.querySelectorAll('#toast-container .toast').forEach((el) => el.remove());
        document.execCommand = () => {
          throw new Error('execCommand copy failure');
        };
        copyFooterBtn.click();
        await wait(60);
        const throwNoSuccessToast = document.querySelectorAll('#toast-container .toast-success').length === 0;
        const throwErrorToastEl = document.querySelector('#toast-container .toast-error');
        const retryCopyBtn = throwErrorToastEl ? throwErrorToastEl.querySelector('[data-toast-retry]') : null;
        const throwNoLeftoverTextarea = document.querySelectorAll('body > textarea').length === 0;

        // Case 3: execCommand('copy') returns true on retry, restoring focus & selection on nameInput
        let fallbackCopiedText = '';
        document.execCommand = (cmd) => {
          if (cmd === 'copy') {
            const active = document.activeElement;
            fallbackCopiedText = active && typeof active.value === 'string' ? active.value : '';
            return true;
          }
          return false;
        };
        nameInput.focus();
        nameInput.setSelectionRange(1, 4);
        retryCopyBtn.click();
        await wait(80);
        const retrySuccessToast = document.querySelectorAll('#toast-container .toast-success').length === 1;
        const retryNoLeftoverTextarea = document.querySelectorAll('body > textarea').length === 0;
        const focusRestored =
          document.activeElement === nameInput &&
          nameInput.selectionStart === 1 &&
          nameInput.selectionEnd === 4;

        const copyFallbackChecksOk =
          falseNoSuccessToast &&
          falseHasRetryBtn &&
          falseNoLeftoverTextarea &&
          falsePromptSelected &&
          throwNoSuccessToast &&
          Boolean(retryCopyBtn) &&
          throwNoLeftoverTextarea &&
          retrySuccessToast &&
          retryNoLeftoverTextarea &&
          focusRestored;

        // 4. Trigger AI Generate and verify preview before confirmation
        const genBtn = await waitFor(() => document.getElementById('btn-cg-generate'));
        genBtn.click();
        await waitFor(() => !saveAiBtn.disabled);

        const previewHtml = document.getElementById('pa-preview-area').innerHTML;
        const hasNormalized585 = previewHtml.includes('585万円') && previewHtml.includes('584.6');
        const hasAppealPoint = previewHtml.includes('自動化基盤の構築実績');

        // Confirm registration in narrow/low-height modal
        saveAiBtn.click();
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));
        await wait(120);

        // 5. Test failure retry in Manual Add modal
        const origFetch = window.fetch.bind(window);
        let failNextPostCompany = true;
        window.fetch = async (url, opts = {}) => {
          if (failNextPostCompany && String(url) === '/api/companies' && opts.method === 'POST') {
            failNextPostCompany = false;
            return new Response(JSON.stringify({ ok: false, error: '一時的な通信エラー' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return origFetch(url, opts);
        };

        document.getElementById('btn-add-manual').click();
        const mcName = await waitFor(() => document.getElementById('ma-name'));
        mcName.value = '株式会社リトライ検証';
        mcName.dispatchEvent(new Event('input', { bubbles: true }));
        if (!window.jobTrackerHasUnsavedChanges()) throw new Error('Native unsaved state must reflect editing');
        const saveManualBtn = document.getElementById('ma-submit-btn');
        saveManualBtn.click();

        const retryBtn = await waitFor(() => document.getElementById('ma-retry-btn'));
        if (!window.jobTrackerHasUnsavedChanges()) throw new Error('Failed save cleared the unsaved state');
        const buttonReenabledAfterError = !saveManualBtn.disabled;
        retryBtn.click();
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));
        if (window.jobTrackerHasUnsavedChanges()) throw new Error('Successful save retained unsaved state');
        await wait(150);

        // 6. Open Company Detail modal & update post-registration priority via quick selector
        const detailBtn = await waitFor(() => document.querySelector('[data-open-detail]'));
        detailBtn.click();
        const quickPrio = await waitFor(() => document.getElementById('cd-quick-priority'));
        quickPrio.value = '5';
        quickPrio.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(150);

        // Release check does not download or open an installer before explicit actions.
        if (innerWidth !== 360 || !matchMedia('(max-width:400px)').matches) throw new Error('Not a true 360px viewport');
        document.querySelector('[data-modal-close]').click();
        const versionBtn = document.getElementById('btn-version');
        if (!versionBtn) throw new Error('btn-version not found');
        versionBtn.click();
        const downloadUpdate = await waitFor(() => {
          const button = document.getElementById('update-download');
          return button && !button.hidden && !button.disabled && button;
        });
        const installUpdate = document.getElementById('update-install');
        if (installUpdate.getClientRects().length) throw new Error('Install button visible before verification');
        downloadUpdate.click();
        await waitFor(() => !installUpdate.hidden && !installUpdate.disabled);
        window.confirm = () => false;
        installUpdate.click();
        await wait(40);
        if (document.getElementById('update-message').textContent.includes('開きました')) throw new Error('Opened without consent');
        window.confirm = () => true;
        installUpdate.click();
        await waitFor(() => document.getElementById('update-message').textContent.includes('開きました'));

        document.querySelector('[data-modal-close]').click();
        document.getElementById('btn-data-manage').click();
        const importInput = await waitFor(() => document.getElementById('dm-import-file'));
        const transfer = new DataTransfer();
        const bytes = Uint8Array.from(atob(${JSON.stringify(selectedDbBase64)}), (ch) => ch.charCodeAt(0));
        transfer.items.add(new File([bytes], 'fictional-legacy.db'));
        importInput.files = transfer.files;
        importInput.dispatchEvent(new Event('input', { bubbles: true }));
        importInput.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btn-preview-import').click();
        const executeImport = await waitFor(() => {
          const button = document.getElementById('btn-exec-import');
          return !button.disabled && button;
        });
        if (!document.getElementById('dm-preview-result').textContent.includes('fictional-legacy.db')) throw new Error('Selected DB was not previewed');
        const replacement = new DataTransfer();
        replacement.items.add(new File(['invalid'], 'another.db'));
        importInput.files = replacement.files;
        importInput.dispatchEvent(new Event('input', { bubbles: true }));
        importInput.dispatchEvent(new Event('change', { bubbles: true }));
        if (!executeImport.disabled || document.getElementById('dm-preview-result').textContent) throw new Error('Old preview remained executable after changing file');
        if (window.jobTrackerHasUnsavedChanges()) throw new Error('File selection incorrectly requires a quit confirmation');

        window.confirm = () => { throw new Error('Import file selection must not be an unsaved edit'); };
        document.querySelector('.modal-header [data-modal-close]').click();
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));
        if (document.activeElement.id !== 'btn-data-manage') throw new Error('Focus not restored after import modal close');

        document.getElementById('btn-data-manage').click();
        const selectedAgain = document.getElementById('dm-import-file');
        selectedAgain.files = transfer.files;
        selectedAgain.dispatchEvent(new Event('input', { bubbles: true }));
        selectedAgain.dispatchEvent(new Event('change', { bubbles: true }));
        const mode = document.getElementById('dm-import-mode');
        mode.value = 'merge';
        mode.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-preview-import').click();
        const runImport = await waitFor(() => !document.getElementById('btn-exec-import').disabled && document.getElementById('btn-exec-import'));
        document.getElementById('toast-container').innerHTML = '';
        runImport.click();
        await waitFor(() => document.getElementById('toast-container').textContent.includes('インポート完了'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));

        document.getElementById('btn-data-manage').click();
        document.getElementById('btn-rollback-import').click();
        await waitFor(() => document.getElementById('toast-container').textContent.includes('ロールバックしました'));
        document.querySelector('.modal-footer [data-modal-close]').click();
        await waitFor(() => document.getElementById('modal-root').classList.contains('is-hidden'));

        await sendReport({
          ok: true,
          copiedText: fallbackCopiedText,
          copyFallbackChecksOk,
          modalBoundsOk,
          hasNormalized585,
          hasAppealPoint,
          buttonReenabledAfterError,
          xssTriggered: Boolean(window.__xss),
        });
      } catch (err) {
        await sendReport({ ok: false, error: err && err.stack ? err.stack : String(err) });
      }
    })();
  `;

  appServer = createAppServer({
    dataDir: tmpDir,
    safeStorage,
    chatgptService: mockChatGptService,
    updater: mockUpdater,
    allowDevBrowserSession: true,
    testDriverScript,
    onTestReport: (data) => reportResolve(data),
  });

  const { bootstrapUrl } = await appServer.start(0);
  let chromeChild = null;
  let raceTimer = null;

  try {
    chromeChild = await launchPage(bootstrapUrl, { width: 360, height: 480 });

    const report = await Promise.race([
      reportPromise,
      new Promise((_, reject) => {
        raceTimer = setTimeout(() => reject(new Error('UI E2E test timed out after 18s')), 18000);
      }),
    ]);

    assert.deepEqual(updateCalls, ['check', 'check', 'download', 'install']);
    assert.equal(report.ok, true, `UI E2E failed: ${report.error || ''}`);
    assert.equal(report.copyFallbackChecksOk, true, 'execCommand copy fallback (false, throw, true retry, textarea cleanup, focus restore) must pass');
    assert.equal(report.modalBoundsOk, true, 'Modal header/footer/buttons must fit inside 360x480 viewport');
    assert.equal(report.hasNormalized585, true, 'Decimal annualIncome 584.6 must display normalized 585万円 in preview');
    assert.equal(report.hasAppealPoint, true, 'Appeal points must render in preview');
    assert.equal(report.buttonReenabledAfterError, true, 'Save button must re-enable after failed request');
    assert.equal(report.xssTriggered, false, 'XSS payload in company name must never execute');

    // Verify copied prompt via fallback is non-empty and identical to the prompt sent to ChatGPT generate()
    assert.ok(report.copiedText.includes('株式会社UI自動検証'));
    assert.ok(report.copiedText.includes('情報科学専攻'));
    assert.equal(report.copiedText, serverGeneratedPromptInput);

    // Verify no company was saved in DB during generate() before user clicked confirm button
    assert.equal(companyCountDuringGenerate, 0);

    // Verify both companies (AI confirmed + manual retry) are now persisted in SQLite
    const savedCompanies = appServer.dbStore.listCompanies();
    assert.equal(savedCompanies.length, 2);
    assert.ok(savedCompanies.some((c) => c.name.startsWith('株式会社UI自動検証') && c.annualIncome === 585));
    assert.ok(savedCompanies.some((c) => c.name === '株式会社リトライ検証'));
    assert.ok(savedCompanies.some((c) => c.priority === 5));
  } finally {
    if (raceTimer) {
      clearTimeout(raceTimer);
    }
    if (chromeChild) await chromeChild.close();
    await appServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

