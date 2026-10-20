'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const THEMES = ['system', 'light', 'dark'];
const ACCENTS = ['purple', 'blue', 'green', 'rose'];
const DEFAULTS = Object.freeze({ version: 1, theme: 'system', accent: 'purple', lockOnStartup: false });

function validate(value, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('アプリ設定の形式が不正です。');
  const allowed = partial ? ['theme', 'accent', 'lockOnStartup'] : Object.keys(DEFAULTS);
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      (!partial && Object.keys(DEFAULTS).some((key) => !Object.hasOwn(value, key))) ||
      (Object.hasOwn(value, 'version') && value.version !== 1) ||
      (Object.hasOwn(value, 'theme') && !THEMES.includes(value.theme)) ||
      (Object.hasOwn(value, 'accent') && !ACCENTS.includes(value.accent)) ||
      (Object.hasOwn(value, 'lockOnStartup') && typeof value.lockOnStartup !== 'boolean')) {
    throw new Error('アプリ設定の値が不正です。安全のため起動時ロックを自動解除しません。');
  }
}

class AppSettingsStore {
  constructor(dataDir) { this.file = path.join(dataDir, 'app-settings.json'); }
  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid settings file');
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      validate(value);
      return { ...value };
    } catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULTS };
      throw new Error('アプリ設定を読み込めません。安全のため起動を停止しました。設定ファイルの状態を確認してください。');
    }
  }
  savePatch(patch) {
    validate(patch, true);
    const value = { ...this.read(), ...patch };
    const temporary = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      return value;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
}

function createNativeAppAuth({ hostBinaryPath, platform = process.platform } = {}) {
  const supported = ['darwin', 'win32'].includes(platform) && typeof hostBinaryPath === 'string' && path.isAbsolute(hostBinaryPath);
  const label = platform === 'darwin' ? 'Touch ID・Macのログイン認証' : platform === 'win32' ? 'Windows Hello' : 'OS認証';
  const invoke = async (flag) => {
    if (!supported) throw new Error('起動時ロックはmacOS／Windowsのネイティブアプリで利用できます。');
    return run(hostBinaryPath, [flag], { timeout: 120000, maxBuffer: 4096, windowsHide: false, shell: false });
  };
  return {
    async availability() {
      try {
        const { stdout } = await invoke('--app-auth-available');
        if (stdout.trim() !== 'APP_AUTH_AVAILABLE') throw new Error('unavailable');
        return { available: true, label, reason: '' };
      } catch {
        return { available: false, label, reason: supported ? 'OS認証が利用できません。OS側の認証設定を確認してください。' : '起動時ロックはmacOS／Windowsのネイティブアプリで利用できます。' };
      }
    },
    async authenticate() {
      try {
        const { stdout } = await invoke('--authenticate-app');
        if (stdout.trim() !== 'APP_AUTH_OK') throw new Error('not verified');
      } catch {
        throw new Error('OS認証が完了しませんでした。キャンセル・失敗時はロックを解除しません。');
      }
    },
  };
}

async function authenticateStartup(store, auth) {
  if (store.read().lockOnStartup) await auth.authenticate();
}

function createAppSettingsService(store, auth) {
  let changingLock = false;
  return {
    async get() { return { ...store.read(), authentication: await auth.availability() }; },
    async update(patch) {
      validate(patch, true);
      const changesLock = Object.hasOwn(patch, 'lockOnStartup') && patch.lockOnStartup !== store.read().lockOnStartup;
      if (changingLock) throw new Error('OS認証が進行中です。認証が終わるまでお待ちください。');
      if (changesLock) {
        changingLock = true;
        try {
          const capability = await auth.availability();
          if (!capability.available) throw new Error(capability.reason);
          await auth.authenticate();
          return store.savePatch(patch);
        } finally { changingLock = false; }
      }
      return store.savePatch(patch);
    },
  };
}

module.exports = { AppSettingsStore, createNativeAppAuth, authenticateStartup, createAppSettingsService };
