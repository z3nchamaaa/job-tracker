'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { CopilotPack } = require('./copilot-pack.cjs');

class CopilotError extends Error {}
const DEVICE_URL = 'https://github.com/login/device';
function input(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) throw new CopilotError('Copilotの入力形式が不正です。');
}
function validClientId(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]{5,100}$/.test(value); }
function validToken(value) { return typeof value === 'string' && /^(gho_|ghu_)[A-Za-z0-9_]{8,512}$/.test(value); }
// A deliberately small environment: never inherit gh/CLI auth, BYOK, proxy,
// tracing, NODE_OPTIONS, custom CLI paths, or personal configuration directories.
function isolatedEnvironment(dir) {
  const env = {
    PATH: [path.dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(path.delimiter),
    HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'),
    TMPDIR: dir, TEMP: dir, TMP: dir, COPILOT_GITHUB_TELEMETRY_DISABLED: 'true',
  };
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  }
  return env;
}

class CopilotService {
  constructor({ dataDir, safeStorage, fetch: request = globalThis.fetch, clientFactory, delay = sleep, now = Date.now, operationTimeout = 180000 }) {
    this.file = path.join(dataDir, 'copilot.enc');
    this.pack = new CopilotPack({ directory: path.join(dataDir, 'extensions', 'copilot'), fetch: request });
    this.storage = safeStorage; this.fetch = request; this.delay = delay; this.now = now;
    this.clientFactory = clientFactory; this.operationTimeout = operationTimeout;
    this.login = null; this.loginError = ''; this.active = null; this.models = []; this.quota = null; this.epoch = 0;
  }
  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error();
      const data = JSON.parse(this.storage.decryptString(fs.readFileSync(this.file)));
      input(data, ['version', 'clientId', 'token', 'login', 'expiresAt']);
      if (data.version !== 1 || !validClientId(data.clientId) || typeof data.token !== 'string' || (data.token && !validToken(data.token)) ||
          typeof data.login !== 'string' || (data.login && !/^[A-Za-z0-9-]{1,39}$/.test(data.login)) ||
          (data.expiresAt !== null && (!Number.isFinite(data.expiresAt) || data.expiresAt < 0))) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new CopilotError('Copilotの保存情報を読み取れません。既存ファイルは変更していません。');
    }
  }
  write(value) {
    if (!this.storage.isEncryptionAvailable()) throw new CopilotError('OSの暗号化機能が必要です。ネイティブアプリから設定してください。');
    const encrypted = this.storage.encryptString(JSON.stringify(value));
    const temporary = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  }
  getStatus() {
    const data = this.read();
    const expired = Boolean(data?.expiresAt && data.expiresAt <= this.now());
    return { clientId: data?.clientId || '', connected: Boolean(data?.token && !expired), login: data?.login || '',
      runtimeAvailable: Boolean(this.clientFactory) || this.pack.status().installed, pack: this.pack.status(), generating: Boolean(this.active),
      signingIn: Boolean(this.login), userCode: this.login?.userCode || '', verificationUri: this.login ? DEVICE_URL : '',
      loginExpiresAt: this.login?.expiresAt || null, error: expired ? 'ログインの有効期限が切れました。再認証してください。' : this.loginError,
      models: this.models, quota: this.quota };
  }
  configure(value) {
    input(value, ['clientId']);
    if (!validClientId(value.clientId)) throw new CopilotError('GitHub OAuth AppのClient IDを入力してください。Client Secretは不要です。');
    if (this.login || this.active) throw new CopilotError('認証・生成を中断してからClient IDを変更してください。');
    const old = this.read();
    const next = old?.clientId === value.clientId ? old : { version: 1, clientId: value.clientId, token: '', login: '', expiresAt: null };
    this.write(next); this.loginError = ''; this.models = []; this.quota = null; this.epoch++;
    return this.getStatus();
  }
  async json(url, fields, signal, token) {
    const timeout = AbortSignal.timeout(15000);
    const response = await this.fetch(url, {
      method: fields ? 'POST' : 'GET', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', 'User-Agent': 'JobTracker', ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
    });
    if (!response.ok) { await response.body?.cancel?.(); throw new CopilotError(`GitHubへの接続に失敗しました（HTTP ${response.status}）。`); }
    let raw = '', bytes = 0; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 65536) throw new CopilotError('GitHubの応答が大きすぎます。');
      raw += decoder.decode(chunk, { stream: true });
    }
    const data = JSON.parse(raw + decoder.decode());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CopilotError('GitHubの応答形式が不正です。');
    return data;
  }
  async beginLogin() {
    if (this.login || this.active || this.pack.operation) throw new CopilotError('別の認証・生成・追加機能の処理が進行中です。');
    const config = this.read();
    if (!config?.clientId) throw new CopilotError('先にOAuth AppのClient IDを保存してください。');
    if (!(this.clientFactory || this.pack.status().installed)) throw new CopilotError('先にCopilot追加機能をダウンロードしてください。');
    const pending = { controller: new AbortController(), userCode: '', expiresAt: null, epoch: this.epoch };
    this.login = pending; this.loginError = '';
    try {
      const data = await this.json('https://github.com/login/device/code', { client_id: config.clientId, scope: 'read:user' }, pending.controller.signal);
      if (this.login !== pending || pending.controller.signal.aborted) throw new CopilotError('認証を中断しました。');
      if (data.error) throw new CopilotError('GitHub OAuth AppのClient IDとDevice Flowの有効化を確認してください。');
      if (data.verification_uri !== DEVICE_URL || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code) ||
          typeof data.device_code !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(data.device_code) ||
          !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 1800 ||
          !Number.isInteger(data.interval) || data.interval < 1 || data.interval > 60) throw new CopilotError('GitHubの認証コードの応答が不正です。');
      pending.userCode = data.user_code; pending.expiresAt = this.now() + data.expires_in * 1000;
      pending.promise = this.pollLogin(pending, config.clientId, data.device_code, data.interval).catch((error) => {
        if (this.login === pending && !pending.controller.signal.aborted) this.loginError = error instanceof CopilotError ? error.message : 'GitHubの認証に失敗しました。時間をおいて再実行してください。';
      }).finally(() => { if (this.login === pending) this.login = null; });
      return this.getStatus();
    } catch (error) {
      if (this.login === pending) this.login = null;
      throw error instanceof CopilotError ? error : new CopilotError('GitHubの認証を開始できませんでした。接続を確認してください。');
    }
  }
  async pollLogin(pending, clientId, deviceCode, initialInterval) {
    const signal = pending.controller.signal; let interval = initialInterval;
    while (!signal.aborted && this.now() < pending.expiresAt) {
      await this.delay(interval * 1000, undefined, { signal });
      if (signal.aborted || this.login !== pending || this.now() >= pending.expiresAt) break;
      const data = await this.json('https://github.com/login/oauth/access_token', { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { interval += 5; continue; }
      if (data.error) throw new CopilotError(data.error === 'access_denied' ? 'GitHubで認証が拒否されました。' : '認証コードが無効か期限切れです。再実行してください。');
      if (!validToken(data.access_token) || data.token_type?.toLowerCase() !== 'bearer') throw new CopilotError('GitHubの認証応答が不正です。');
      if (data.expires_in !== undefined && (!Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000)) throw new CopilotError('認証の有効期限が不正です。');
      const user = await this.json('https://api.github.com/user', null, signal, data.access_token);
      if (typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) throw new CopilotError('GitHubアカウントを確認できませんでした。');
      if (signal.aborted || this.login !== pending || pending.epoch !== this.epoch) return;
      this.write({ version: 1, clientId, token: data.access_token, login: user.login, expiresAt: data.expires_in ? this.now() + data.expires_in * 1000 : null });
      this.models = []; this.quota = null; return;
    }
    if (!signal.aborted) throw new CopilotError('認証コードの有効期限が切れました。再実行してください。');
  }
  cancelLogin() { const pending = this.login; this.login = null; pending?.controller.abort(); return { cancelled: Boolean(pending) }; }
  cancelGenerate() {
    const active = this.active; active?.controller.abort();
    active?.client?.forceStop().catch(() => {});
    return { cancelled: Boolean(active) };
  }
  signOut() {
    const data = this.read();
    if (data) this.write({ version: 1, clientId: data.clientId, token: '', login: '', expiresAt: null });
    this.epoch++; this.cancelLogin(); this.cancelGenerate(); this.models = []; this.quota = null; this.loginError = '';
    return this.getStatus();
  }
  async withClient(task) {
    if (this.active || this.login || this.pack.operation) throw new CopilotError('別のCopilot処理が進行中です。');
    const data = this.read();
    if (!data?.token || (data.expiresAt && data.expiresAt <= this.now())) throw new CopilotError('Copilotにログインしてください。');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-tracker-copilot-'));
    const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
    const active = { controller: new AbortController(), client: null, epoch: this.epoch }; this.active = active;
    const timer = setTimeout(() => active.controller.abort(), this.operationTimeout);
    let abortListener;
    try {
      let create = this.clientFactory;
      if (!create) {
        const { CopilotClient, RuntimeConnection } = this.pack.load();
        create = (options) => new CopilotClient({ ...options, connection: RuntimeConnection.forStdio() });
      }
      active.client = create({ mode: 'empty', baseDirectory: path.join(dir, 'runtime'), workingDirectory: workspace,
        useLoggedInUser: false, gitHubToken: data.token, env: isolatedEnvironment(dir), logLevel: 'none' });
      const cancelled = new Promise((resolve, reject) => {
        abortListener = () => reject(new CopilotError('Copilotの処理を中断しました。タイムアウトの場合は入力を短くしてください。'));
        active.controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const work = (async () => {
        await active.client.start();
        if (active.controller.signal.aborted) throw new CopilotError('処理を中断しました。');
        const result = await task(active.client, workspace);
        if (active.controller.signal.aborted || active.epoch !== this.epoch) throw new CopilotError('処理を中断しました。');
        return result;
      })();
      return await Promise.race([work, cancelled]);
    } catch (error) {
      if (error instanceof CopilotError) throw error;
      throw new CopilotError('Copilotを利用できませんでした。ログイン、契約・組織ポリシー、利用枠、モデルを確認してください。');
    } finally {
      clearTimeout(timer); if (abortListener) active.controller.signal.removeEventListener('abort', abortListener);
      try { await active.client?.forceStop(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      if (this.active === active) this.active = null;
    }
  }
  async details() {
    const epoch = this.epoch;
    const details = await this.withClient(async (client) => {
      const models = await client.listModels();
      const visibleModels = (Array.isArray(models) ? models : []).filter((m) => typeof m.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(m.id)).slice(0, 100).map((m) => ({ id: m.id, name: String(m.name || m.id).slice(0, 120) }));
      let quota = null;
      try {
        const result = await client.rpc.account.getQuota({});
        quota = Object.entries(result.quotaSnapshots || {}).slice(0, 12).map(([key, q]) => ({ key: key.slice(0, 80),
          remainingPercentage: Number.isFinite(q?.remainingPercentage) ? Math.max(0, Math.min(100, q.remainingPercentage)) : null,
          unlimited: q?.isUnlimitedEntitlement === true,
          resetDate: typeof q?.resetDate === 'string' && Number.isFinite(Date.parse(q.resetDate)) ? q.resetDate : null }));
      } catch {}
      return { models: visibleModels, quota };
    });
    if (epoch !== this.epoch) throw new CopilotError('操作を中断しました。');
    this.models = details.models; this.quota = details.quota; return details;
  }
  async generate(value) {
    input(value, ['model', 'input']);
    if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value.model) || typeof value.input !== 'string' || !value.input.trim() || value.input.length > 60000) throw new CopilotError('Copilotのモデルと生成プロンプトを確認してください。');
    return this.withClient(async (client, workspace) => {
      const session = await client.createSession({ model: value.model, workingDirectory: workspace, availableTools: [], excludedTools: ['builtin:*', 'mcp:*', 'custom:*'],
        tools: [], mcpServers: {}, customAgents: [], enableConfigDiscovery: false, enableSkills: false, enableFileHooks: false,
        enableHostGitOperations: false, enableOnDemandInstructionDiscovery: false, enableSessionStore: false,
        enableSessionTelemetry: false, interactiveUser: false, remoteSession: 'off', infiniteSessions: { enabled: false },
        onPermissionRequest: () => ({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' }),
      });
      const response = await session.sendAndWait({ prompt: value.input + '\nこの接続ではWeb検索やローカルファイル参照を使えません。最新の日程・待遇・確認日を確認済みと偽らず、不明項目はnullか空欄にし、要求された企業JSONだけを返してください。' }, 150000);
      const text = response?.data?.content;
      if (typeof text !== 'string' || !text.trim() || text.length > 128000) throw new CopilotError('Copilotの回答が空か大きすぎます。企業データは保存していません。');
      return text;
    });
  }
  async installPack() {
    if (this.active || this.login) throw new CopilotError('認証・生成を中断してから追加機能を操作してください。');
    await this.pack.install(); return this.getStatus();
  }
  cancelPack() { return this.pack.cancel(); }
  removePack() {
    if (this.active || this.login) throw new CopilotError('認証・生成を中断してから追加機能を削除してください。');
    const result = this.pack.remove(); this.models = []; this.quota = null;
    return { ...this.getStatus(), pendingRestart: result.pendingRestart };
  }
  async shutdown() { this.pack.cancel(); this.epoch++; this.cancelLogin(); this.cancelGenerate(); try { await this.active?.client?.forceStop(); } catch {} }
}
module.exports = { CopilotService, isolatedEnvironment };
