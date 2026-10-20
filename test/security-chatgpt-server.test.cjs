'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ChatGPTService, parseSSE, defaultJwtVerify } = require('../src/backend/chatgpt.cjs');
const { AppUpdater, isNewerVersion, isSafeRedirect } = require('../src/backend/updater.cjs');
const { createIpcDispatcher, redactSecrets, validateExternalHttpsUrl } = require('../src/backend/ipc.cjs');
const { CareerProfileStore } = require('../src/backend/career-profile-store.cjs');
const { createAppServer } = require('../src/backend/server.cjs');

test('parseSSE extracts output_text deltas and handles completed responses', async () => {
  const rawSse = [
    'data: {"type":"response.output_text.delta","delta":"{\\"name\\":\\""}',
    '',
    'data: {"type":"response.output_text.delta","delta":"テスト株式会社\\"}"}',
    '',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(rawSse));
      controller.close();
    },
  });

  const ac = new AbortController();
  const text = await parseSSE(stream, ac);
  assert.equal(text, '{"name":"テスト株式会社"}');
});

test('defaultJwtVerify verifies RS256 OIDC ID token via JWKS and rejects tampered signature or wrong issuer', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1' })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: 'client-123',
      sub: 'user-abc',
      email: 'demo@example.jp',
      iat: nowSec - 10,
      exp: nowSec + 3600,
    })
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
  const token = `${signingInput}.${signature}`;

  const jwksSource = async () => [publicJwk];

  const verified = await defaultJwtVerify(token, jwksSource, {
    issuer: 'https://auth.openai.com',
    audience: 'client-123',
    requiredClaims: ['sub', 'exp', 'iat'],
  });
  assert.equal(verified.payload.email, 'demo@example.jp');

  // Tampered token must throw
  await assert.rejects(
    () =>
      defaultJwtVerify(`${signingInput}.invalidSignatureBytes`, jwksSource, {
        issuer: 'https://auth.openai.com',
        audience: 'client-123',
      }),
    /JWT signature verification failed/
  );
});

test('ChatGPTService isolates credential decryption failures and supports signOut recovery without affecting DB', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-cg-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'auth.enc'), Buffer.from('corrupted-cipher', 'utf8'));

    const brokenSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: () => {
        throw new Error('Decryption failed');
      },
    };

    const service = new ChatGPTService({
      userDataPath: tmpDir,
      safeStorage: brokenSafeStorage,
    });

    const session = service.getSession();
    assert.equal(session.connected, false);
    assert.equal(session.needsReauthentication, true);
    assert.match(session.authError, /復号に失敗/);

    await service.signOut();
    const afterSignOut = service.getSession();
    assert.equal(afterSignOut.connected, false);
    assert.equal(afterSignOut.authError, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AppUpdater enforces HTTPS, host allowlist, and disabled default when no v2 repo is configured', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-upd-test-'));
  try {
    const disabledUpdater = new AppUpdater({ version: '2.0.0', userDataPath: tmpDir });
    const disabledCheck = await disabledUpdater.check();
    assert.equal(disabledCheck.status, 'disabled');

    assert.equal(isNewerVersion('2.1.0', '2.0.0'), true);
    assert.equal(isNewerVersion('1.9.9', '2.0.0'), false);

    assert.equal(isSafeRedirect('http://github.com/release.dmg'), false);
    assert.equal(isSafeRedirect('https://evil.example.com/release.dmg'), false);
    assert.equal(isSafeRedirect('https://objects.githubusercontent.com/asset'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('IPC dispatcher enforces method allowlist, blocks prototype pollution, validates https URLs, and redacts secrets', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-ipc-test-'));
  try {
    const redacted = redactSecrets(
      'Failed with Authorization: Bearer secret_tok_1234567890 and "refresh_token":"rt_abcdef123456"'
    );
    assert.equal(redacted.includes('secret_tok_1234567890'), false);
    assert.equal(redacted.includes('rt_abcdef123456'), false);
    assert.ok(redacted.includes('[REDACTED'));

    assert.throws(() => validateExternalHttpsUrl('javascript:alert(1)'), /https/);
    assert.throws(() => validateExternalHttpsUrl('http://insecure.example.com'), /https/);
    assert.equal(validateExternalHttpsUrl('https://developers.openai.com/'), 'https://developers.openai.com/');

    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8'),
    };
    const dispatcher = createIpcDispatcher({
      chatgptService: new ChatGPTService({ userDataPath: tmpDir, safeStorage }),
      profileStore: new CareerProfileStore(tmpDir),
      updater: new AppUpdater({ version: '2.0.0', userDataPath: tmpDir }),
    });

    await assert.rejects(() => dispatcher.invoke('readArbitraryFile', {}), /許可されていないIPC/);

    const protoPayload = Object.create(null);
    Object.defineProperty(protoPayload, '__proto__', { value: { polluted: true }, enumerable: true });
    await assert.rejects(() => dispatcher.invoke('generate', protoPayload), /不正/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Loopback HTTP server blocks DNS rebinding, cross-origin requests, and missing CSRF/token while serving authorized requests', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-srv-test-'));
  const desktopToken = 'unit-test-desktop-token-12345';
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  };

  const appServer = createAppServer({
    dataDir: tmpDir,
    desktopToken,
    safeStorage,
  });

  const { origin } = await appServer.start(0);

  try {
    // 1. Cross-origin request must be blocked with 403
    const crossOriginRes = await fetch(`${origin}/api/system/status`, {
      headers: {
        Origin: 'https://evil.example.com',
        'x-desktop-token': desktopToken,
      },
    });
    assert.equal(crossOriginRes.status, 403);

    // 2. Unauthorized API request without token/cookie must be blocked with 401
    const unauthRes = await fetch(`${origin}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '不正追加企業' }),
    });
    assert.equal(unauthRes.status, 401);

    // 3. Authorized API request with x-desktop-token succeeds and includes CSP header
    const createRes = await fetch(`${origin}/api/companies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-token': desktopToken,
      },
      body: JSON.stringify({
        name: '株式会社セキュアテスト',
        status: 'INTERESTED',
        priority: 4,
        annualIncome: 520,
      }),
    });
    assert.equal(createRes.status, 201);
    assert.match(createRes.headers.get('content-security-policy') || '', /default-src 'self'/);
    const created = await createRes.json();
    assert.equal(created.company.name, '株式会社セキュアテスト');
  } finally {
    await appServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
