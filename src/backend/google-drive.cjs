'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3/files';
const MAX_BACKUP = 5 * 1024 * 1024;
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
class GoogleDriveService {
  constructor({ dataDir, safeStorage, openExternal, dbStore, profileStore, fetch: request = globalThis.fetch, now = Date.now, loginTimeout = 180000 }) {
    this.file = path.join(dataDir, 'google-drive.enc'); this.storage = safeStorage; this.openExternal = openExternal;
    this.db = dbStore; this.profile = profileStore; this.fetch = request; this.now = now; this.loginTimeout = loginTimeout;
    this.login = null; this.operation = null; this.staged = null; this.loginError = ''; this.epoch = 0;
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
    const encrypted = this.storage.encryptString(JSON.stringify(value));
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp'; let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  }
  getStatus() {
    const saved = this.read();
    return { configured: Boolean(saved), clientId: saved?.clientId || '', hasClientSecret: Boolean(saved?.clientSecret),
      connected: Boolean(saved?.refreshToken), signingIn: Boolean(this.login), busy: Boolean(this.operation), error: this.loginError,
      encryptedStorageAvailable: this.storage.isEncryptionAvailable() };
  }
  configure(value) {
    input(value, ['clientId', 'clientSecret']);
    if (this.login || this.operation) throw error('認証・転送を中断してから接続設定を変更してください。');
    if (typeof value.clientId !== 'string' || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId) ||
        (value.clientSecret !== undefined && (typeof value.clientSecret !== 'string' || !/^[\x21-\x7e]{0,256}$/.test(value.clientSecret)))) throw error('デスクトップ用OAuthクライアントの設定を確認してください。');
    const old = this.read(), same = old?.clientId === value.clientId;
    const secret = value.clientSecret === undefined ? (same ? old.clientSecret : '') : value.clientSecret;
    if (same && secret === old.clientSecret) return this.getStatus();
    this.write({ version: 1, clientId: value.clientId, clientSecret: secret, accessToken: '', refreshToken: '', expiresAt: 0 });
    this.epoch++; this.staged = null; this.loginError = ''; return this.getStatus();
  }
  async token(fields, signal) {
    const response = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    if (!response.ok) { await response.body?.cancel?.(); throw error('Google認証に失敗しました。OAuth設定と許可を確認して再接続してください。'); }
    const value = JSON.parse(await bounded(response, 65536));
    if (!tokenValid(value.access_token) || value.token_type?.toLowerCase() !== 'bearer' || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86400 ||
        (value.refresh_token !== undefined && !tokenValid(value.refresh_token)) ||
        (value.scope !== undefined && (typeof value.scope !== 'string' || !value.scope.split(' ').includes(SCOPE)))) throw error('Googleから必要な権限を取得できませんでした。再接続してください。');
    return value;
  }
  async beginLogin() {
    if (this.login || this.operation) throw error('別のGoogle Drive処理が進行中です。');
    const saved = this.read();
    if (!saved || !this.storage.isEncryptionAvailable()) throw error('先にネイティブアプリでGoogleの接続設定を保存してください。');
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
      pending.promise = this.token({ client_id: saved.clientId, ...(saved.clientSecret ? { client_secret: saved.clientSecret } : {}), code, code_verifier: pending.verifier,
        redirect_uri: pending.redirect, grant_type: 'authorization_code' }, pending.controller.signal).then((value) => {
        if (this.login !== pending || pending.controller.signal.aborted || pending.epoch !== this.epoch) return;
        if (!value.scope?.split(' ').includes(SCOPE) || !tokenValid(value.refresh_token)) throw error('Google Drive用の権限・継続接続情報を取得できませんでした。再接続してください。');
        this.write({ ...saved, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: this.now() + value.expires_in * 1000 });
      }).catch(() => { if (this.login === pending && !pending.controller.signal.aborted) this.loginError = 'Google Driveへ接続できませんでした。OAuth設定と許可を確認して再試行してください。'; })
        .finally(() => this.finishLogin(pending));
    });
    this.login = pending; this.loginError = '';
    try {
      await new Promise((resolve, reject) => { pending.server.once('error', reject); pending.server.listen(0, '127.0.0.1', resolve); });
      pending.host = '127.0.0.1:' + pending.server.address().port; pending.redirect = 'http://' + pending.host + '/oauth/google/callback';
      pending.timer = setTimeout(() => { if (this.login === pending) { this.loginError = 'Googleの接続がタイムアウトしました。再試行してください。'; this.finishLogin(pending); } }, this.loginTimeout); pending.timer.unref();
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: saved.clientId, redirect_uri: pending.redirect, response_type: 'code', scope: SCOPE, state: pending.state,
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
    const saved = this.read(); if (!saved?.refreshToken) throw error('先にGoogle Driveへ接続してください。');
    const controller = new AbortController(), epoch = this.epoch; this.operation = controller;
    try {
      let access = saved.accessToken;
      if (!access || saved.expiresAt <= this.now() + 60000) {
        const refreshed = await this.token({ client_id: saved.clientId, ...(saved.clientSecret ? { client_secret: saved.clientSecret } : {}), refresh_token: saved.refreshToken, grant_type: 'refresh_token' }, controller.signal);
        controller.signal.throwIfAborted(); if (epoch !== this.epoch) throw error('Google Driveの処理を中断しました。');
        this.write({ ...saved, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || saved.refreshToken, expiresAt: this.now() + refreshed.expires_in * 1000 }); access = refreshed.access_token;
      }
      const request = async (url, options = {}, limit = 131072) => {
        const target = new URL(url);
        if (target.origin !== 'https://www.googleapis.com' || !/^\/(?:upload\/)?drive\/v3\/files(?:\/|$)/.test(target.pathname) || target.username || target.password) throw error('Google Driveの接続先が不正です。');
        const response = await this.fetch(url, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: 'Bearer ' + access }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!response.ok) { await response.body?.cancel?.(); throw error(`Google Driveの処理に失敗しました（HTTP ${response.status}）。接続・権限・空き容量を確認してください。`); }
        const text = await bounded(response, limit); controller.signal.throwIfAborted();
        if (epoch !== this.epoch) throw error('Google Driveの処理を中断しました。'); return text;
      };
      return await task(request);
    } catch (cause) {
      if (controller.signal.aborted) throw error('Google Driveの転送を中断しました。保存が完了している場合もあるため、一覧を確認してください。');
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
  snapshot() { return this.db.exportBackup(this.profile.getProfile()); }
  prepareBackup() {
    if (!this.getStatus().connected || this.operation || this.login) throw error('Google Driveへの接続と転送状態を確認してください。');
    const backup = this.snapshot(), raw = JSON.stringify(backup);
    if (Buffer.byteLength(raw) > MAX_BACKUP) throw error('Driveバックアップの上限は5 MiBです。ローカルのJSON出力を利用してください。');
    this.staged = { kind: 'upload', token: crypto.randomBytes(24).toString('hex'), raw, until: this.now() + 300000 };
    return { token: this.staged.token, counts: backup.counts, bytes: Buffer.byteLength(raw), exportedAt: backup.exportedAt };
  }
  stagedBackup(value, kind) {
    input(value, kind === 'restore' ? ['token', 'mode'] : ['token']);
    if (!this.staged || this.staged.kind !== kind || this.staged.token !== value.token || this.staged.until < this.now()) throw error('バックアップのプレビューが期限切れです。もう一度確認してください。');
    return this.staged;
  }
  async uploadBackup(value) {
    const staged = this.stagedBackup(value, 'upload');
    return this.run(async (request) => {
      const boundary = 'jobtracker_' + crypto.randomBytes(20).toString('hex');
      const metadata = { name: 'job-tracker-backup-' + new Date(this.now()).toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID() + '.json', mimeType: 'application/json', parents: ['appDataFolder'],
        appProperties: { application: 'jp.jobtracker.app', format: '1', sha256: crypto.createHash('sha256').update(staged.raw).digest('hex') } };
      const body = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${staged.raw}\r\n--${boundary}--\r\n`);
      const result = JSON.parse(await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }));
      if (!fileIdValid(result.id)) throw error('Google Driveの保存結果を確認できませんでした。一覧を確認してください。');
      this.staged = null; return { saved: true, id: result.id };
    });
  }
  async listBackups(value = {}) {
    input(value, ['pageToken']);
    if (value.pageToken !== undefined && (typeof value.pageToken !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value.pageToken))) throw error('Google Driveの一覧指定が不正です。');
    return this.run(async (request) => {
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: "trashed = false and appProperties has { key='application' and value='jp.jobtracker.app' }", fields: 'files(id,name,size,createdTime),nextPageToken', pageSize: '100', orderBy: 'createdTime desc' });
      if (value.pageToken) query.set('pageToken', value.pageToken);
      const result = JSON.parse(await request(API + '?' + query));
      if (!Array.isArray(result.files)) throw error('Google Driveの一覧を読み取れませんでした。');
      return { files: result.files.filter((f) => fileIdValid(f.id) && typeof f.name === 'string').slice(0, 100).map((f) => ({ id: f.id, name: f.name.slice(0, 200), bytes: Number(f.size) || 0, createdTime: typeof f.createdTime === 'string' ? f.createdTime : '' })), nextPageToken: typeof result.nextPageToken === 'string' && /^[\x21-\x7e]{1,2048}$/.test(result.nextPageToken) ? result.nextPageToken : '' };
    });
  }
  async previewBackup(value) {
    input(value, ['id']); if (!fileIdValid(value.id)) throw error('バックアップの選択が不正です。');
    return this.run(async (request) => {
      const metadata = JSON.parse(await request(API + '/' + value.id + '?fields=id,name,mimeType,size,appProperties'));
      if (metadata.appProperties?.application !== 'jp.jobtracker.app' || metadata.mimeType !== 'application/json' || !/^[a-f0-9]{64}$/.test(metadata.appProperties?.sha256 || '') || !Number.isFinite(Number(metadata.size)) || Number(metadata.size) > MAX_BACKUP) throw error('このアプリの有効なバックアップではありません。');
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
module.exports = { GoogleDriveService, SCOPE, MAX_BACKUP, fingerprint };
