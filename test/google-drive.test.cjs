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
  const service = new GoogleDriveService({ dataDir: dir, safeStorage: storage, dbStore: db, profileStore: profile, openExternal: async () => {}, ...options });
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
  assert.equal(service.getStatus().configured,false);
  service.configure({clientId:CLIENT,clientSecret:'synthetic-secret'}); authorize();
  const status=service.getStatus(); assert.equal(status.connected,true); assert.equal(calls,0);
  assert(!JSON.stringify(status).includes(ACCESS));assert(!JSON.stringify(status).includes(REFRESH));assert(!JSON.stringify(status).includes('synthetic-secret'));
  assert(!fs.readFileSync(service.file).includes(REFRESH));
  const before=fs.readFileSync(service.file); storage.encryptString=()=>{throw new Error('failure');};
  assert.throws(()=>service.configure({clientId:'999-synthetic.apps.googleusercontent.com'})); assert.deepEqual(fs.readFileSync(service.file),before);
});
test('OAuth uses PKCE, state, loopback and only appdata; wrong state cannot consume the callback', async (t) => {
  let auth, fields; const {service}=fixture(t,{openExternal:async(url)=>{auth=new URL(url);},fetch:async(url,options)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');fields=new URLSearchParams(options.body);return successToken();}});
  service.configure({clientId:CLIENT}); await service.beginLogin();
  assert.equal(auth.origin,'https://accounts.google.com');assert.equal(auth.searchParams.get('scope'),SCOPE);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await callback(auth,{state:'wrong',code:'4/syntheticCode'})).status,400);assert.equal(service.getStatus().signingIn,true);
  const response=await callback(auth,{state:auth.searchParams.get('state'),code:'4/syntheticCode'}); assert.equal(response.status,200);
  const pending=service.login; if(pending)await pending.promise;
  assert.equal(service.getStatus().connected,true);
  assert.equal(crypto.createHash('sha256').update(fields.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));
  assert(!auth.href.includes('client_secret'));
});
test('cancelled authorization cannot save a late exchange response', async (t) => {
  let auth, release, started; const reached=new Promise(r=>{started=r;});
  const {service}=fixture(t,{openExternal:async(u)=>{auth=new URL(u);},fetch:async()=>{started();return new Promise(r=>{release=()=>r(successToken());});}});
  service.configure({clientId:CLIENT});await service.beginLogin();
  await callback(auth,{state:auth.searchParams.get('state'),code:'4/synthetic'});await reached;
  const pending=service.login; service.cancelLogin();release();await pending.promise;
  assert.equal(service.getStatus().connected,false);
});
test('missing appdata grant is rejected and keeps previous credentials unchanged', async (t) => {
  let auth; const {service}=fixture(t,{openExternal:async(u)=>{auth=new URL(u);},fetch:async()=>Response.json({access_token:ACCESS,refresh_token:REFRESH,expires_in:3600,token_type:'Bearer',scope:'openid'})});
  service.configure({clientId:CLIENT});await service.beginLogin();await callback(auth,{state:auth.searchParams.get('state'),code:'4/synthetic'});
  if(service.login)await service.login.promise;
  assert.equal(service.getStatus().connected,false);assert(service.getStatus().error);
});
test('upload requires explicit prepared preview, targets only appDataFolder, excludes credentials, and never overwrites', async (t) => {
  let call; const {service,authorize}=fixture(t,{fetch:async(url,options)=>{call={url,options};return Response.json({id:'synthetic-file-id'});}});authorize();
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
