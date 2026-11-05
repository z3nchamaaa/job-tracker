'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { GoogleDriveService, SCOPE } = require('../src/backend/google-drive.cjs');
const { DatabaseStore } = require('../src/backend/db.cjs');
const { CareerProfileStore } = require('../src/backend/career-profile-store.cjs');
const CLIENT = '123456789-synthetic.apps.googleusercontent.com';
const ACCESS = 'ya29.syntheticAccessOnly', REFRESH = '1//syntheticRefreshOnly';
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-drive-test-'));
  const profile = new CareerProfileStore(dir), db = new DatabaseStore({ dataDir: dir, profileStore: profile });
  const key = crypto.randomBytes(32);
  const storage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]); },
    decryptString(value) { const c = crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12)); c.setAuthTag(value.subarray(-16)); return Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString(); } };
  const service = new GoogleDriveService({ dataDir: dir, safeStorage: storage, dbStore: db, profileStore: profile, openExternal: async () => {}, defaultClient: { clientId: CLIENT, clientSecret: 'synthetic-secret' }, ...options });
  t.after(() => { service.shutdown(); db.close(); fs.rmSync(dir, { recursive:true,force:true }); });
  const authorize = () => service.write({version:1,clientId:CLIENT,clientSecret:'synthetic-secret',accessToken:ACCESS,refreshToken:REFRESH,expiresAt:Date.now()+3600000});
  return { service, dir, storage, db, profile, authorize };
}
function successToken() { return Response.json({ access_token:ACCESS, refresh_token:REFRESH, token_type:'Bearer', expires_in:3600, scope:SCOPE }); }
async function callback(url, values) {
  const redirect = new URL(url.searchParams.get('redirect_uri'));
  for (const [k,v] of Object.entries(values)) redirect.searchParams.set(k,v);
  return fetch(redirect);
}
test('Drive configuration and tokens are encrypted, never returned in status, and no network is used by status', (t) => {
  let calls=0; const {service,storage,authorize}=fixture(t,{fetch:async()=>{calls++;throw new Error('no network');}});
  assert.equal(service.getStatus().configured,true); assert.equal(service.getStatus().connected,false); assert.equal(fs.existsSync(service.file),false);
  authorize();
  const status=service.getStatus(); assert.equal(status.connected,true); assert.equal(calls,0);
  assert(!JSON.stringify(status).includes(ACCESS));assert(!JSON.stringify(status).includes(REFRESH));assert(!JSON.stringify(status).includes('synthetic-secret'));
  assert(!fs.readFileSync(service.file).includes(REFRESH));
  const before=fs.readFileSync(service.file); storage.encryptString=()=>{throw new Error('failure');};
  assert.throws(()=>service.write({...service.read(),accessToken:''})); assert.deepEqual(fs.readFileSync(service.file),before);
});
test('OAuth uses PKCE, state, loopback and only appdata; wrong state cannot consume the callback', async (t) => {
  let auth, fields; const {service}=fixture(t,{openExternal:async(url)=>{auth=new URL(url);},fetch:async(url,options)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');fields=new URLSearchParams(options.body);return successToken();}});
  await service.beginLogin();
  assert.equal(auth.origin,'https://accounts.google.com');assert.equal(auth.searchParams.get('scope'),SCOPE);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await callback(auth,{state:'wrong',code:'4/syntheticCode'})).status,400);assert.equal(service.getStatus().signingIn,true);
  const response=await callback(auth,{state:auth.searchParams.get('state'),code:'4/syntheticCode'}); assert.equal(response.status,200);
  const pending=service.login; if(pending)await pending.promise;
  assert.equal(service.getStatus().connected,true);
  assert.equal(crypto.createHash('sha256').update(fields.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));
  assert(!auth.href.includes('client_secret'));
});
test('Browser launch failure clears the pending Google login so it can be retried', async (t) => {
  let attempts = 0;
  const { service } = fixture(t, { openExternal: async () => { attempts++; throw new Error('synthetic launch failure'); } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(service.beginLogin(), /Google認証画面を開けませんでした/);
    assert.equal(service.getStatus().signingIn, false);
    assert.equal(service.login, null);
  }
  assert.equal(attempts, 2);
});

test('cancelled authorization cannot save a late exchange response', async (t) => {
  let auth, release, started; const reached=new Promise(r=>{started=r;});
  const {service}=fixture(t,{openExternal:async(u)=>{auth=new URL(u);},fetch:async()=>{started();return new Promise(r=>{release=()=>r(successToken());});}});
  await service.beginLogin();
  await callback(auth,{state:auth.searchParams.get('state'),code:'4/synthetic'});await reached;
  const pending=service.login; service.cancelLogin();release();await pending.promise;
  assert.equal(service.getStatus().connected,false);
});
test('missing appdata grant is rejected and keeps previous credentials unchanged', async (t) => {
  let auth; const {service}=fixture(t,{openExternal:async(u)=>{auth=new URL(u);},fetch:async()=>Response.json({access_token:ACCESS,refresh_token:REFRESH,expires_in:3600,token_type:'Bearer',scope:'openid'})});
  await service.beginLogin();await callback(auth,{state:auth.searchParams.get('state'),code:'4/synthetic'});
  if(service.login)await service.login.promise;
  assert.equal(service.getStatus().connected,false);assert(service.getStatus().error);
});
test('upload requires explicit prepared preview, targets only appDataFolder, excludes credentials, and never overwrites', async (t) => {
  let call; const {service,authorize}=fixture(t,{fetch:async(url,options={})=>{if(options.method!=='POST')return Response.json({files:[]});call={url,options};return Response.json({id:'synthetic-file-id'});}});authorize();
  await assert.rejects(service.uploadBackup({token:'wrong'}),/プレビュー/);assert.equal(call,undefined);
  const prepared=service.prepareBackup(); assert(prepared.counts); await service.uploadBackup({token:prepared.token});
  assert.equal(call.options.method,'POST');assert(call.url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'));
  const body=call.options.body.toString();assert(body.includes('appDataFolder'));assert(body.includes('job-tracker-backup'));assert(!body.includes(ACCESS));assert(!body.includes(REFRESH));assert(!body.includes('synthetic-secret'));
  assert.equal(call.options.headers.Authorization,'Bearer '+ACCESS);assert.equal(call.options.redirect,'error');
  await assert.rejects(service.uploadBackup({token:prepared.token}),/プレビュー/);
});
test('expired access tokens refresh securely and list only application-owned files with pagination', async (t) => {
  const calls=[];const {service,authorize}=fixture(t,{fetch:async(url,options)=>{calls.push({url,options});return url.includes('/token')?successToken():Response.json({files:[{id:'synthetic',name:'backup.json',size:'15'}],nextPageToken:'synthetic-next'});}});authorize();service.write({...service.read(),expiresAt:1});
  const result=await service.listBackups({});assert.equal(calls.length,2);assert(calls[0].options.body.includes('refresh_token='));
  const url=new URL(calls[1].url);assert.equal(url.searchParams.get('spaces'),'appDataFolder');assert(url.searchParams.get('q').includes('jp.jobtracker.app'));assert.equal(result.nextPageToken,'synthetic-next');
  await service.listBackups({pageToken:result.nextPageToken});assert.equal(new URL(calls[2].url).searchParams.get('pageToken'),'synthetic-next');
});
test('Drive restore verifies ownership and hash, previews without writing, rejects stale local state, and uses import rollback', async (t) => {
  let raw, metadata;const {service,authorize,db,profile}=fixture(t,{fetch:async(url)=>Response.json(url.includes('alt=media')?JSON.parse(raw):metadata)});authorize();
  // Exact bytes rather than Response.json formatting are used for media hashes.
  service.fetch=async(url)=>url.includes('alt=media')?new Response(raw):Response.json(metadata);
  raw=JSON.stringify(service.snapshot());metadata={name:'synthetic.json',size:String(Buffer.byteLength(raw)),mimeType:'application/json',appProperties:{application:'jp.jobtracker.app',sha256:crypto.createHash('sha256').update(raw).digest('hex')}};
  const before=JSON.stringify(db.exportBackup(profile.getProfile()).data);
  const preview=await service.previewBackup({id:'synthetic'});assert(preview.preview.counts);assert.equal(JSON.stringify(service.snapshot().data),before);assert(!('normalizedData' in preview.preview));
  profile.saveProfile({...profile.getProfile(),strengths:'synthetic changed'});
  assert.throws(()=>service.restoreBackup({token:preview.token,mode:'replace'}),/変更/);
  const next=await service.previewBackup({id:'synthetic'});const result=service.restoreBackup({token:next.token,mode:'replace'});assert.equal(result.imported,true);assert.equal(db.getStatus().hasPreImportSnapshot,true);
  db.rollbackLastImport();assert.equal(profile.getProfile().strengths,'synthetic changed');
  metadata.appProperties.sha256='0'.repeat(64);await assert.rejects(service.previewBackup({id:'synthetic'}),/ハッシュ/);
  metadata.appProperties.application='other-app';await assert.rejects(service.previewBackup({id:'synthetic'}),/有効なバックアップ/);
});
test('failed revocation preserves connection and local-only disconnect sends no tokens to Google', async (t) => {
  let calls=0;const {service,authorize}=fixture(t,{fetch:async()=>{calls++;return new Response('',{status:503});}});authorize();
  await assert.rejects(service.disconnect({}),/解除/);assert.equal(service.getStatus().connected,true);
  await service.disconnect({localOnly:true});assert.equal(calls,1);assert.equal(service.getStatus().connected,false);
});

test('bundled Desktop client allows first login without configuration; tokens from other clients require reconnecting', async (t) => {
  const defaultClient = { clientId: '987654321-bundled.apps.googleusercontent.com', clientSecret: 'synthetic-bundled-secret' };
  let auth, calls = 0;
  const { service, authorize } = fixture(t, { defaultClient, openExternal: async (url) => { auth = new URL(url); }, fetch: async () => { calls++; return successToken(); } });
  assert.equal(service.getStatus().configured, true);
  assert.equal(fs.existsSync(service.file), false);
  assert(!JSON.stringify(service.getStatus()).includes(defaultClient.clientSecret));
  assert.equal(typeof service.configure, 'undefined');
  authorize(); // legacy token issued to a user-supplied client
  assert.equal(service.getStatus().connected, false);
  assert.equal(service.getStatus().needsReconnect, true);
  await assert.rejects(service.listBackups({}), /再接続/); assert.equal(calls, 0);
  await service.beginLogin();
  assert.equal(auth.searchParams.get('client_id'), defaultClient.clientId);
  await callback(auth, { state: auth.searchParams.get('state'), code: '4/synthetic' });
  if (service.login) await service.login.promise;
  assert.equal(service.getStatus().connected, true);
  assert.equal(service.read().clientId, defaultClient.clientId);
});

test('builds without an embedded client cannot start Google login', async (t) => {
  let opened = false;
  const { service } = fixture(t, { defaultClient: null, openExternal: async () => { opened = true; } });
  assert.equal(service.getStatus().configured, false);
  await assert.rejects(service.beginLogin(), /接続設定が含まれていない/);
  assert.equal(opened, false);
});

test('local quotas cap request bursts, daily uploads, upload interval and login attempts', async (t) => {
  let now = Date.parse('2026-11-05T00:00:00Z'), uploads = 0;
  const { service, authorize } = fixture(t, { now: () => now, limits: { requestsPerMinute: 4, uploadsPerDay: 2, uploadIntervalMs: 60000, loginsPerHour: 2 },
    fetch: async (url, options) => {
      if (options?.method === 'POST') { uploads++; return Response.json({ id: 'synthetic-upload-' + uploads }); }
      return Response.json({ files: [] });
    } });
  authorize(); service.write({ ...service.read(), expiresAt: now + 7 * 86400000 });
  await service.uploadBackup({ token: service.prepareBackup().token });
  assert.throws(() => service.prepareBackup(), /秒待って/);
  assert.match(service.getStatus().usage.uploadBlockedReason, /秒待って/);
  now += 61000;
  await service.uploadBackup({ token: service.prepareBackup().token });
  now += 61000;
  assert.throws(() => service.prepareBackup(), /1日2回/);
  assert.equal(uploads, 2);
  for (let i = 0; i < 4; i++) await service.listBackups({});
  await assert.rejects(service.listBackups({}), /集中/);
  now = Date.parse('2026-11-06T00:00:00Z');
  await service.uploadBackup({ token: service.prepareBackup().token });
  assert.equal(uploads, 3);
  // Usage survives a restart because it is persisted in the data directory.
  const reopened = new GoogleDriveService({ dataDir: path.dirname(service.file), safeStorage: service.storage, dbStore: service.db, profileStore: service.profile, openExternal: async () => {}, defaultClient: service.client, now: () => now, limits: { uploadsPerDay: 1 } });
  assert.throws(() => reopened.prepareBackup(), /1日1回/);
  await service.disconnect({ localOnly: true });
  await service.beginLogin(); service.cancelLogin();
  await service.beginLogin(); service.cancelLogin();
  await assert.rejects(service.beginLogin(), /しばらく待って/);
});

test('upload refuses when the stored backup cap is reached unless automatic pruning is enabled', async (t) => {
  const stored = Array.from({ length: 3 }, (_, i) => ({ id: 'old' + i, name: 'job-tracker-backup-' + i + '.json', size: '10', createdTime: `2026-11-0${3 - i}T00:00:00Z` }));
  const calls = [];
  const { service, authorize } = fixture(t, { limits: { maxStored: 3 }, fetch: async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (options.method === 'POST') return Response.json({ id: 'fresh' });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ files: stored });
  } });
  authorize();
  await assert.rejects(service.uploadBackup({ token: service.prepareBackup().token }), /3件まで/);
  assert(!calls.some((c) => c.method === 'POST'));
  assert.throws(() => service.saveSettings({ retentionCount: 4, autoPrune: true }), /1〜3件/);
  service.saveSettings({ retentionCount: 2, autoPrune: true });
  assert.deepEqual(service.getStatus().settings, { retentionCount: 2, autoPrune: true });
  const result = await service.uploadBackup({ token: service.prepareBackup().token });
  assert.equal(result.pruned, 2);
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()), ['old1', 'old2']);
});

test('deleting a backup verifies it belongs to this app and handles empty Drive responses', async (t) => {
  const calls = []; let application = 'jp.jobtracker.app';
  const { service, authorize } = fixture(t, { fetch: async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 'synthetic', appProperties: { application } });
  } });
  authorize();
  await assert.rejects(service.deleteBackup({ id: '../escape' }), /選択が不正/);
  assert.deepEqual(await service.deleteBackup({ id: 'synthetic' }), { deleted: 1 });
  assert.equal(calls.at(-1).method, 'DELETE'); assert.equal(calls.at(-1).url, 'https://www.googleapis.com/drive/v3/files/synthetic');
  application = 'other-app';
  await assert.rejects(service.deleteBackup({ id: 'synthetic' }), /このアプリのバックアップではない/);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('pruning old backups is previewed first and deletes only the staged older files', async (t) => {
  const stored = Array.from({ length: 5 }, (_, i) => ({ id: 'b' + i, name: 'job-tracker-backup-' + i + '.json', size: '10', createdTime: `2026-11-0${5 - i}T00:00:00Z` }));
  const deleted = [];
  const { service, authorize } = fixture(t, { fetch: async (url, options = {}) => {
    if (options.method === 'DELETE') { deleted.push(url.split('/').pop()); return new Response(null, { status: 204 }); }
    return Response.json({ files: stored });
  } });
  authorize();
  await assert.rejects(service.preparePrune({ keep: 0 }), /1〜/);
  const plan = await service.preparePrune({ keep: 2 });
  assert.equal(plan.total, 5); assert.equal(plan.count, 3); assert.equal(plan.oldest, '2026-11-01T00:00:00Z');
  assert.deepEqual(deleted, []);
  await assert.rejects(service.pruneBackups({ token: 'wrong' }), /プレビュー/);
  assert.deepEqual(await service.pruneBackups({ token: plan.token }), { deleted: 3 });
  assert.deepEqual(deleted, ['b2', 'b3', 'b4']);
  await assert.rejects(service.pruneBackups({ token: plan.token }), /プレビュー/);
});

test('staging extracts only Desktop application fields and never copies user tokens or URLs', (t) => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-google-stage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'client.json');
  const stage = path.resolve(__dirname, '../scripts/stage.cjs');
  const content = (source) => execFileSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).stagedContent("src/backend/google-oauth-client.json"))', stage], { env: { ...process.env, JOB_TRACKER_GOOGLE_OAUTH_CLIENT_FILE: source }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(content('')), {});
  fs.writeFileSync(file, JSON.stringify({ installed: { client_id: CLIENT, client_secret: 'synthetic-only', token_uri: 'https://untrusted.invalid' }, refresh_token: REFRESH }));
  assert.deepEqual(JSON.parse(content(file)), { clientId: CLIENT, clientSecret: 'synthetic-only' });
  // copyRuntime passes native separators (backslashes on Windows); the client must still be embedded.
  const distDir = path.resolve(__dirname, '../dist');
  fs.mkdirSync(distDir, { recursive: true });
  const out = fs.mkdtempSync(path.join(distDir, 'test-stage-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  execFileSync(process.execPath, [stage, out, 'windows', 'x64'], { env: { ...process.env, JOB_TRACKER_GOOGLE_OAUTH_CLIENT_FILE: file }, stdio: 'ignore' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'src', 'backend', 'google-oauth-client.json'), 'utf8')), { clientId: CLIENT, clientSecret: 'synthetic-only' });
  fs.writeFileSync(file, JSON.stringify({ web: { client_id: CLIENT } }));
  assert.throws(() => content(file));
  fs.writeFileSync(file, '{"sensitive-malformed-input":');
  try { content(file); assert.fail('should reject'); } catch (e) { assert(!String(e.stderr).includes('sensitive-malformed-input')); }
  assert.throws(() => content(dir));
});
