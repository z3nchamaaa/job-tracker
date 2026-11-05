'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { bundledClient, normalizeClient } = require('./google-oauth-config.cjs');
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3/files';
const APPLICATION = 'jp.jobtracker.app';
const MAX_BACKUP = 5 * 1024 * 1024;
// The bundled OAuth client is shared by every installation, so its Drive API
// quota is shared too. These local limits keep a bug, a stuck UI or a script
// talking to the local IPC from burning that quota. Google Cloud quotas remain
// the authoritative limit (see docs/README.md).
const LIMITS = Object.freeze({
  requestsPerMinute: 30, requestsPerDay: 500, uploadsPerDay: 20, uploadIntervalMs: 60000,
  deletesPerDay: 200, loginsPerHour: 10, maxStored: 30, deleteBatch: 100, listPages: 3,
});
const RETENTION_DEFAULT = 10;
class DriveError extends Error {}
const error = (message) => new DriveError(message);
const tokenValid = (s) => typeof s === 'string' && /^[A-Za-z0-9._~+/=-]{1,8192}$/.test(s);
const fileIdValid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(s);
function input(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw error('Google Driveの入力形式が不正です。');
}
function fingerprint(backup) { return crypto.createHash('sha256').update(JSON.stringify({ ...backup, exportedAt: undefined })).digest('hex'); }
async function bounded(response, max) {
  if (!response.body || Number(response.headers.get('content-length')) > max) { await response.body?.cancel?.(); throw error('Google Driveの応答サイズが上限を超えています。'); }
  let total = 0; const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > max) throw error('Google Driveの応答サイズが上限を超えています。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function publicFile(f) {
  return { id: f.id, name: f.name.slice(0, 200), bytes: Number(f.size) || 0, createdTime: typeof f.createdTime === 'string' ? f.createdTime : '' };
}
function atomicWrite(file, data) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'; let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
}
class GoogleDriveService {
  constructor({ dataDir, safeStorage, openExternal, dbStore, profileStore, fetch: request = globalThis.fetch, now = Date.now, loginTimeout = 180000, defaultClient = bundledClient(), limits = {} }) {
    this.file = path.join(dataDir, 'google-drive.enc'); this.stateFile = path.join(dataDir, 'google-drive-state.json');
    this.storage = safeStorage; this.openExternal = openExternal;
    this.db = dbStore; this.profile = profileStore; this.fetch = request; this.now = now; this.loginTimeout = loginTimeout;
    this.login = null; this.operation = null; this.staged = null; this.loginError = ''; this.epoch = 0; this.window = [];
    this.limits = Object.freeze({ ...LIMITS, ...limits });
    this.client = defaultClient ? normalizeClient(defaultClient) : null;
  }
  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw error('invalid');
      const value = JSON.parse(this.storage.decryptString(fs.readFileSync(this.file)));
      input(value, ['version', 'clientId', 'clientSecret', 'accessToken', 'refreshToken', 'expiresAt']);
      if (value.version !== 1 || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId) ||
          typeof value.clientSecret !== 'string' || !/^[\x21-\x7e]{0,256}$/.test(value.clientSecret) ||
          (value.accessToken !== '' && !tokenValid(value.accessToken)) || (value.refreshToken !== '' && !tokenValid(value.refreshToken)) ||
          !Number.isFinite(value.expiresAt)) throw error('invalid');
      return value;
    } catch (cause) {
      if (cause.code === 'ENOENT') return null;
      throw error('Google Driveの保存情報を読み取れません。既存のファイルは変更していません。');
    }
  }
  write(value) {
    if (!this.storage.isEncryptionAvailable()) throw error('OSの暗号化機能が必要です。ネイティブアプリから設定してください。');
    atomicWrite(this.file, this.storage.encryptString(JSON.stringify(value)));
  }
  // Only tokens issued to the embedded client are used. Tokens saved by older
  // versions for a user-supplied client require signing in again.
  usable(saved) { return Boolean(this.client && saved?.refreshToken && saved.clientId === this.client.clientId); }
  readState() {
    const state = { version: 1, retentionCount: RETENTION_DEFAULT, autoPrune: false, usage: { day: '', requests: 0, uploads: 0, deletes: 0, lastUploadAt: 0, logins: [] } };
    try {
      const stat = fs.lstatSync(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return state;
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')), u = value?.usage;
      if (value?.version !== 1) return state;
      if (Number.isInteger(value.retentionCount) && value.retentionCount >= 1 && value.retentionCount <= this.limits.maxStored) state.retentionCount = value.retentionCount;
      if (typeof value.autoPrune === 'boolean') state.autoPrune = value.autoPrune;
      if (u && typeof u.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u.day)) {
        const count = (n) => (Number.isInteger(n) && n >= 0 && n < 1e6 ? n : 0);
        state.usage = { day: u.day, requests: count(u.requests), uploads: count(u.uploads), deletes: count(u.deletes),
          lastUploadAt: Number.isFinite(u.lastUploadAt) ? u.lastUploadAt : 0,
          logins: Array.isArray(u.logins) ? u.logins.filter(Number.isFinite).slice(-50) : [] };
      }
    } catch {}
    return state;
  }
  writeState(state) { atomicWrite(this.stateFile, JSON.stringify(state)); }
  currentState() {
    const state = this.readState(), day = new Date(this.now()).toISOString().slice(0, 10);
    if (state.usage.day !== day) state.usage = { ...state.usage, day, requests: 0, uploads: 0, deletes: 0 };
    state.usage.logins = state.usage.logins.filter((t) => t > this.now() - 3600000);
    return state;
  }
  uploadBlock(state = this.currentState()) {
    const u = state.usage;
    if (u.uploads >= this.limits.uploadsPerDay) return `Driveへの保存は1日${this.limits.uploadsPerDay}回までです。明日以降に再試行してください。`;
    const wait = u.lastUploadAt + this.limits.uploadIntervalMs - this.now();
    if (wait > 0) return `連続保存を防ぐため、あと${Math.ceil(wait / 1000)}秒待ってから保存してください。`;
    return '';
  }
  charge({ requests = 0, uploads = 0, deletes = 0 }) {
    const now = this.now(), state = this.currentState(), u = state.usage;
    this.window = this.window.filter((t) => t > now - 60000);
    if (this.window.length + requests > this.limits.requestsPerMinute) throw error('短時間にGoogle Driveへの要求が集中しています。1分ほど待ってから再試行してください。');
    if (u.requests + requests > this.limits.requestsPerDay) throw error('本日のGoogle Drive通信回数の上限に達しました。明日以降に再試行してください。');
    if (u.deletes + deletes > this.limits.deletesPerDay) throw error(`バックアップの削除は1日${this.limits.deletesPerDay}件までです。明日以降に再試行してください。`);
    if (uploads) { const block = this.uploadBlock(state); if (block) throw error(block); }
    u.requests += requests; u.uploads += uploads; u.deletes += deletes; if (uploads) u.lastUploadAt = now;
    this.writeState(state);
    for (let i = 0; i < requests; i++) this.window.push(now);
  }
  getStatus() {
    const saved = this.read(), state = this.currentState(), connected = this.usable(saved);
    return { configured: Boolean(this.client), connected, needsReconnect: Boolean(saved?.refreshToken && !connected),
      signingIn: Boolean(this.login), busy: Boolean(this.operation), error: this.loginError,
      encryptedStorageAvailable: this.storage.isEncryptionAvailable(),
      settings: { retentionCount: state.retentionCount, autoPrune: state.autoPrune },
      limits: { maxStored: this.limits.maxStored, uploadsPerDay: this.limits.uploadsPerDay, uploadIntervalSeconds: Math.round(this.limits.uploadIntervalMs / 1000) },
      usage: { uploadsToday: state.usage.uploads, uploadBlockedReason: this.uploadBlock(state) } };
  }
  saveSettings(value) {
    input(value, ['retentionCount', 'autoPrune']);
    if (!Number.isInteger(value.retentionCount) || value.retentionCount < 1 || value.retentionCount > this.limits.maxStored || typeof value.autoPrune !== 'boolean') {
      throw error(`保持するバックアップ数は1〜${this.limits.maxStored}件で指定してください。`);
    }
    const state = this.currentState(); state.retentionCount = value.retentionCount; state.autoPrune = value.autoPrune;
    this.writeState(state); return this.getStatus();
  }
  async token(fields, signal) {
    const response = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    if (!response.ok) { await response.body?.cancel?.(); throw error('Google認証に失敗しました。Googleの許可を確認して再接続してください。'); }
    const value = JSON.parse(await bounded(response, 65536));
    if (!tokenValid(value.access_token) || value.token_type?.toLowerCase() !== 'bearer' || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86400 ||
        (value.refresh_token !== undefined && !tokenValid(value.refresh_token)) ||
        (value.scope !== undefined && (typeof value.scope !== 'string' || !value.scope.split(' ').includes(SCOPE)))) throw error('Googleから必要な権限を取得できませんでした。再接続してください。');
    return value;
  }
  async beginLogin() {
    if (this.login || this.operation) throw error('別のGoogle Drive処理が進行中です。');
    if (!this.client) throw error('このビルドにはGoogle接続設定が含まれていないため、Driveバックアップを利用できません。');
    if (!this.storage.isEncryptionAvailable()) throw error('OSの暗号化機能が必要です。ネイティブアプリから接続してください。');
    const state = this.currentState();
    if (state.usage.logins.length >= this.limits.loginsPerHour) throw error('Googleへの接続操作が続いています。しばらく待ってから再試行してください。');
    state.usage.logins.push(this.now()); this.writeState(state);
    const client = this.client;
    const pending = { state: crypto.randomBytes(32).toString('base64url'), verifier: crypto.randomBytes(48).toString('base64url'), controller: new AbortController(), epoch: this.epoch, accepted: false };
    pending.server = http.createServer((req, res) => {
      const reply = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' }); res.end(message); };
      let url;
      try { url = new URL(req.url, pending.redirect); } catch { reply(400, 'Invalid request'); return; }
      if (req.method !== 'GET' || req.headers.origin || req.headers.host !== pending.host || url.origin !== 'http://' + pending.host || url.pathname !== '/oauth/google/callback' || req.url.length > 8192 || pending.accepted ||
          url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state || this.login !== pending) { reply(400, 'Invalid request'); return; }
      pending.accepted = true;
      if (url.searchParams.has('error')) { reply(200, '接続がキャンセルされました。アプリへ戻ってください。'); this.loginError = 'Googleでの接続がキャンセルされました。'; this.finishLogin(pending); return; }
      const code = url.searchParams.get('code');
      if (url.searchParams.getAll('code').length !== 1 || !tokenValid(code)) { reply(400, 'Invalid code'); this.finishLogin(pending); return; }
      reply(200, '認証を受け付けました。この画面を閉じてアプリへ戻ってください。');
      pending.promise = this.token({ client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}), code, code_verifier: pending.verifier,
        redirect_uri: pending.redirect, grant_type: 'authorization_code' }, pending.controller.signal).then((value) => {
        if (this.login !== pending || pending.controller.signal.aborted || pending.epoch !== this.epoch) return;
        if (!value.scope?.split(' ').includes(SCOPE) || !tokenValid(value.refresh_token)) throw error('Google Drive用の権限・継続接続情報を取得できませんでした。再接続してください。');
        this.write({ version: 1, clientId: client.clientId, clientSecret: client.clientSecret, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: this.now() + value.expires_in * 1000 });
      }).catch(() => { if (this.login === pending && !pending.controller.signal.aborted) this.loginError = 'Google Driveへ接続できませんでした。Googleの許可を確認して再試行してください。'; })
        .finally(() => this.finishLogin(pending));
    });
    this.login = pending; this.loginError = '';
    try {
      await new Promise((resolve, reject) => { pending.server.once('error', reject); pending.server.listen(0, '127.0.0.1', resolve); });
      pending.host = '127.0.0.1:' + pending.server.address().port; pending.redirect = 'http://' + pending.host + '/oauth/google/callback';
      pending.timer = setTimeout(() => { if (this.login === pending) { this.loginError = 'Googleの接続がタイムアウトしました。再試行してください。'; this.finishLogin(pending); } }, this.loginTimeout); pending.timer.unref();
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: pending.redirect, response_type: 'code', scope: SCOPE, state: pending.state,
        code_challenge: crypto.createHash('sha256').update(pending.verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' }).toString();
      await this.openExternal(url.href); return this.getStatus();
    } catch { this.finishLogin(pending); throw error('Google認証画面を開けませんでした。もう一度お試しください。'); }
  }
  finishLogin(pending) {
    clearTimeout(pending.timer); pending.controller.abort(); pending.server.close(); pending.server.closeAllConnections();
    if (this.login === pending) this.login = null;
  }
  cancelLogin() { const pending = this.login; if (pending) this.finishLogin(pending); return { cancelled: Boolean(pending) }; }
  cancelOperation() { this.operation?.abort(); return { cancelled: Boolean(this.operation) }; }
  async run(task) {
    if (this.operation || this.login) throw error('別のGoogle Drive処理が進行中です。');
    const saved = this.read();
    if (!this.usable(saved)) throw error(saved?.refreshToken ? 'Googleへ再接続してください。' : '先にGoogle Driveへ接続してください。');
    const controller = new AbortController(), epoch = this.epoch; this.operation = controller;
    try {
      let access = saved.accessToken;
      if (!access || saved.expiresAt <= this.now() + 60000) {
        this.charge({ requests: 1 });
        const refreshed = await this.token({ client_id: saved.clientId, ...(saved.clientSecret ? { client_secret: saved.clientSecret } : {}), refresh_token: saved.refreshToken, grant_type: 'refresh_token' }, controller.signal);
        controller.signal.throwIfAborted(); if (epoch !== this.epoch) throw error('Google Driveの処理を中断しました。');
        this.write({ ...saved, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || saved.refreshToken, expiresAt: this.now() + refreshed.expires_in * 1000 }); access = refreshed.access_token;
      }
      const request = async (url, options = {}, limit = 131072) => {
        const target = new URL(url);
        if (target.origin !== 'https://www.googleapis.com' || !/^\/(?:upload\/)?drive\/v3\/files(?:\/|$)/.test(target.pathname) || target.username || target.password) throw error('Google Driveの接続先が不正です。');
        this.charge({ requests: 1 });
        const response = await this.fetch(url, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: 'Bearer ' + access }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!response.ok) { await response.body?.cancel?.(); throw error(`Google Driveの処理に失敗しました（HTTP ${response.status}）。接続・権限・空き容量を確認してください。`); }
        const text = response.status === 204 ? (await response.body?.cancel?.(), '') : await bounded(response, limit);
        controller.signal.throwIfAborted();
        if (epoch !== this.epoch) throw error('Google Driveの処理を中断しました。'); return text;
      };
      return await task(request);
    } catch (cause) {
      if (controller.signal.aborted) throw error('Google Driveの転送を中断しました。処理が完了している場合もあるため、一覧を確認してください。');
      if (cause instanceof DriveError) throw cause;
      throw error('Google Driveと通信できませんでした。接続を確認して再試行してください。');
    } finally { if (this.operation === controller) this.operation = null; }
  }
  async disconnect(value = {}) {
    input(value, ['localOnly']);
    if (value.localOnly !== undefined && typeof value.localOnly !== 'boolean') throw error('Google Driveの解除方法が不正です。');
    if (this.operation) throw error('転送を中断してから連携を解除してください。');
    this.cancelLogin(); const saved = this.read();
    if (!value.localOnly && saved?.refreshToken) {
      const controller = new AbortController(); this.operation = controller;
      try {
        const response = await this.fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refreshToken }).toString() });
        await response.body?.cancel?.(); controller.signal.throwIfAborted();
        if (response.status !== 200 && response.status !== 400) throw error('revocation failed');
      } catch { throw error('Googleの許可を解除できませんでした。再試行するか、この端末の接続情報だけを削除してください。'); }
      finally { if (this.operation === controller) this.operation = null; }
    }
    this.epoch++; this.staged = null; this.loginError = '';
    if (saved) this.write({ ...saved, accessToken: '', refreshToken: '', expiresAt: 0 });
    return this.getStatus();
  }
  // Lists application-owned backups, newest first, bounded to a few pages.
  async collect(request) {
    const files = []; let pageToken = '';
    for (let page = 0; page < this.limits.listPages; page++) {
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: `trashed = false and appProperties has { key='application' and value='${APPLICATION}' }`, fields: 'files(id,name,size,createdTime),nextPageToken', pageSize: '100', orderBy: 'createdTime desc' });
      if (pageToken) query.set('pageToken', pageToken);
      const result = JSON.parse(await request(API + '?' + query));
      if (!Array.isArray(result.files)) throw error('Google Driveの一覧を読み取れませんでした。');
      files.push(...result.files.filter((f) => fileIdValid(f.id) && typeof f.name === 'string').slice(0, 100).map(publicFile));
      pageToken = typeof result.nextPageToken === 'string' && /^[\x21-\x7e]{1,2048}$/.test(result.nextPageToken) ? result.nextPageToken : '';
      if (!pageToken) return { files, complete: true };
    }
    return { files, complete: false };
  }
  async remove(request, id) {
    this.charge({ deletes: 1 });
    await request(API + '/' + id, { method: 'DELETE' });
  }
  snapshot() { return this.db.exportBackup(this.profile.getProfile()); }
  prepareBackup() {
    if (!this.getStatus().connected || this.operation || this.login) throw error('Google Driveへの接続と転送状態を確認してください。');
    const block = this.uploadBlock(); if (block) throw error(block);
    const backup = this.snapshot(), raw = JSON.stringify(backup);
    if (Buffer.byteLength(raw) > MAX_BACKUP) throw error('Driveバックアップの上限は5 MiBです。ローカルのJSON出力を利用してください。');
    this.staged = { kind: 'upload', token: crypto.randomBytes(24).toString('hex'), raw, until: this.now() + 300000 };
    return { token: this.staged.token, counts: backup.counts, bytes: Buffer.byteLength(raw), exportedAt: backup.exportedAt };
  }
  stagedBackup(value, kind) {
    input(value, kind === 'restore' ? ['token', 'mode'] : ['token']);
    if (!this.staged || this.staged.kind !== kind || this.staged.token !== value.token || this.staged.until < this.now()) throw error('確認内容（プレビュー）の有効期限が切れました。もう一度確認してください。');
    return this.staged;
  }
  async uploadBackup(value) {
    const staged = this.stagedBackup(value, 'upload');
    const { retentionCount, autoPrune } = this.currentState();
    return this.run(async (request) => {
      const existing = await this.collect(request);
      if (!autoPrune && existing.files.length >= this.limits.maxStored) {
        throw error(`Driveに保存できるバックアップは${this.limits.maxStored}件までです。設定画面で古いバックアップを削除してください。`);
      }
      this.charge({ uploads: 1 });
      const boundary = 'jobtracker_' + crypto.randomBytes(20).toString('hex');
      const metadata = { name: 'job-tracker-backup-' + new Date(this.now()).toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID() + '.json', mimeType: 'application/json', parents: ['appDataFolder'],
        appProperties: { application: APPLICATION, format: '1', sha256: crypto.createHash('sha256').update(staged.raw).digest('hex') } };
      const body = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${staged.raw}\r\n--${boundary}--\r\n`);
      const result = JSON.parse(await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }));
      if (!fileIdValid(result.id)) throw error('Google Driveの保存結果を確認できませんでした。一覧を確認してください。');
      this.staged = null;
      let pruned = 0, pruneError = '';
      if (autoPrune) {
        const old = existing.files.filter((f) => f.id !== result.id).slice(Math.max(0, retentionCount - 1)).slice(0, this.limits.deleteBatch);
        try { for (const f of old) { await this.remove(request, f.id); pruned++; } }
        catch (cause) { pruneError = cause instanceof DriveError ? cause.message : '古いバックアップの自動削除に失敗しました。'; }
      }
      return { saved: true, id: result.id, pruned, pruneError };
    });
  }
  async listBackups(value = {}) {
    input(value, ['pageToken']);
    if (value.pageToken !== undefined && (typeof value.pageToken !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value.pageToken))) throw error('Google Driveの一覧指定が不正です。');
    return this.run(async (request) => {
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: `trashed = false and appProperties has { key='application' and value='${APPLICATION}' }`, fields: 'files(id,name,size,createdTime),nextPageToken', pageSize: '100', orderBy: 'createdTime desc' });
      if (value.pageToken) query.set('pageToken', value.pageToken);
      const result = JSON.parse(await request(API + '?' + query));
      if (!Array.isArray(result.files)) throw error('Google Driveの一覧を読み取れませんでした。');
      return { files: result.files.filter((f) => fileIdValid(f.id) && typeof f.name === 'string').slice(0, 100).map(publicFile), nextPageToken: typeof result.nextPageToken === 'string' && /^[\x21-\x7e]{1,2048}$/.test(result.nextPageToken) ? result.nextPageToken : '' };
    });
  }
  async deleteBackup(value) {
    input(value, ['id']); if (!fileIdValid(value.id)) throw error('バックアップの選択が不正です。');
    return this.run(async (request) => {
      const metadata = JSON.parse(await request(API + '/' + value.id + '?fields=id,appProperties'));
      if (metadata.appProperties?.application !== APPLICATION) throw error('このアプリのバックアップではないため削除しません。');
      await this.remove(request, value.id);
      return { deleted: 1 };
    });
  }
  async preparePrune(value) {
    input(value, ['keep']);
    if (!Number.isInteger(value.keep) || value.keep < 1 || value.keep > this.limits.maxStored) throw error(`残すバックアップ数は1〜${this.limits.maxStored}件で指定してください。`);
    return this.run(async (request) => {
      const { files, complete } = await this.collect(request);
      const targets = files.slice(value.keep).slice(0, this.limits.deleteBatch);
      this.staged = { kind: 'prune', token: crypto.randomBytes(24).toString('hex'), ids: targets.map((f) => f.id), until: this.now() + 300000 };
      return { token: this.staged.token, total: files.length, count: targets.length, keep: value.keep,
        newest: targets[0]?.createdTime || '', oldest: targets.at(-1)?.createdTime || '', more: !complete || files.length - value.keep > targets.length };
    });
  }
  async pruneBackups(value) {
    const staged = this.stagedBackup(value, 'prune'); this.staged = null;
    let deleted = 0;
    try {
      return await this.run(async (request) => {
        for (const id of staged.ids) { await this.remove(request, id); deleted++; }
        return { deleted };
      });
    } catch (cause) {
      throw deleted ? error(`${deleted}件を削除した後に中断しました：${cause.message}`) : cause;
    }
  }
  async previewBackup(value) {
    input(value, ['id']); if (!fileIdValid(value.id)) throw error('バックアップの選択が不正です。');
    return this.run(async (request) => {
      const metadata = JSON.parse(await request(API + '/' + value.id + '?fields=id,name,mimeType,size,appProperties'));
      if (metadata.appProperties?.application !== APPLICATION || metadata.mimeType !== 'application/json' || !/^[a-f0-9]{64}$/.test(metadata.appProperties?.sha256 || '') || !Number.isFinite(Number(metadata.size)) || Number(metadata.size) > MAX_BACKUP) throw error('このアプリの有効なバックアップではありません。');
      const raw = await request(API + '/' + value.id + '?alt=media', {}, MAX_BACKUP);
      if (crypto.createHash('sha256').update(raw).digest('hex') !== metadata.appProperties.sha256) throw error('バックアップのハッシュが一致しません。復元は行っていません。');
      const parsed = JSON.parse(raw);
      if (parsed?.format !== 'job-tracker-backup' || parsed.version !== 1) throw error('対応していないバックアップです。');
      const source = { kind: 'json', payload: raw }, preview = this.db.previewImport(source);
      this.staged = { kind: 'restore', token: crypto.randomBytes(24).toString('hex'), source, until: this.now() + 300000, localDigest: fingerprint(this.snapshot()) };
      const { normalizedData, ...publicPreview } = preview;
      return { token: this.staged.token, preview: publicPreview };
    });
  }
  restoreBackup(value) {
    const staged = this.stagedBackup(value, 'restore');
    if (this.operation || this.login || !this.getStatus().connected) throw error('Google Driveの転送・接続状態を確認してください。');
    if (!['merge', 'replace'].includes(value.mode)) throw error('復元方法を選択してください。');
    if (fingerprint(this.snapshot()) !== staged.localDigest) { this.staged = null; throw error('プレビュー後にローカルデータが変更されました。もう一度プレビューしてください。'); }
    const result = this.db.executeImport(staged.source, value.mode); this.staged = null; return result;
  }
  shutdown() { this.cancelLogin(); this.cancelOperation(); this.staged = null; this.epoch++; }
}
module.exports = { GoogleDriveService, SCOPE, MAX_BACKUP, LIMITS, fingerprint };
