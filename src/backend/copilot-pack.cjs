'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const lock = require('./copilot-pack-lock.json');
const id = crypto.createHash('sha256').update(JSON.stringify(lock)).digest('hex');
const fail = (message) => new Error(message);
function specs(platform, arch) {
  const result = lock.targets[platform + '-' + arch];
  if (lock.schema !== 1 || !result) throw fail('このOS・CPUにはCopilot追加機能が対応していません。');
  for (const p of result) {
    const url = new URL(p.resolved);
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(p.name) || !/^\d+\.\d+\.\d+$/.test(p.version) ||
        url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith('.tgz') || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)) throw fail('Copilot追加機能の配布情報が不正です。');
  }
  return result;
}
function regularTree(root) {
  const result = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw fail('追加機能に不正なファイルがあります。');
      if (stat.isDirectory()) walk(full); else result.push({ full, relative: path.relative(root, full).split(path.sep).join('/'), bytes: stat.size });
    }
  };
  walk(root); return result;
}
function validateMembers(list, verbose) {
  if (verbose.split(/\r?\n/).filter(Boolean).some((line) => !/^[-d]/.test(line))) throw fail('追加機能にリンクなどの不正な項目があります。');
  const members = list.split(/\r?\n/).filter(Boolean), seen = new Set();
  if (!members.length || members.length > 10000) throw fail('追加機能のファイル数が不正です。');
  for (const member of members) {
    const clean = member.replace(/\/$/, '');
    if (!clean.startsWith('package/') && clean !== 'package') throw fail('追加機能の展開先が不正です。');
    if (/[\\:\x00-\x1f\x7f<>"|?*]/.test(clean) || clean.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(clean)) throw fail('追加機能の展開先が不正です。');
    seen.add(clean);
  }
}
class CopilotPack {
  constructor({ directory, platform = process.platform, arch = process.arch, fetch: request = globalThis.fetch }) {
    this.directory = directory; this.platform = platform; this.arch = arch; this.fetch = request;
    this.operation = null; this.progress = null; this.error = ''; this.checked = null;
  }
  safeDirectory() {
    // Only this extension's dedicated directory is managed; never inspect auth/profile files.
    for (const dir of [path.dirname(this.directory), this.directory]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw fail('追加機能の保存先を確認できません。');
    }
  }
  installed() {
    try {
      const pointer = path.join(this.directory, 'current.json'), stat = fs.lstatSync(pointer);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
      const data = JSON.parse(fs.readFileSync(pointer));
      if (data.id !== id || data.target !== this.platform + '-' + this.arch || !/^install-[a-f0-9]{32}$/.test(data.directory)) return null;
      const root = path.join(this.directory, data.directory);
      if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) return null;
      return root;
    } catch { return null; }
  }
  status() {
    let supported = true; try { specs(this.platform, this.arch); } catch { supported = false; }
    const current = this.installed();
    let pendingRemoval = false;
    try {
      if (!fs.lstatSync(this.directory).isSymbolicLink()) pendingRemoval = fs.readdirSync(this.directory).some((name) => /^install-[a-f0-9]{32}$/.test(name) && path.join(this.directory, name) !== current);
    } catch {}
    return { installed: Boolean(current), pendingRemoval, supported, version: lock.sdkVersion, installing: Boolean(this.operation), progress: this.progress, error: this.error };
  }
  async download(spec, file, signal) {
    const response = await this.fetch(spec.resolved, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 256 * 1024 * 1024) {
      await response.body?.cancel?.();
      throw fail('Copilot追加機能をダウンロードできませんでした。接続を確認して再試行してください。');
    }
    const digest = crypto.createHash('sha512'); let bytes = 0, fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      for await (const chunk of response.body) {
        signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) throw fail('Copilot追加機能のサイズが上限を超えました。');
        digest.update(chunk); let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
        this.progress.bytes = bytes;
      }
      fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if ('sha512-' + digest.digest('base64') !== spec.integrity) throw fail('Copilot追加機能のハッシュが一致しません。ダウンロードをやり直してください。');
  }
  async unpack(archive, directory, signal) {
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe') : process.platform === 'darwin' ? '/usr/bin/tar' : '/bin/tar';
    const env = { LC_ALL: 'C', PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin',
      TMPDIR: directory, TMP: directory, TEMP: directory };
    if (process.platform === 'win32') {
      env.SystemRoot = process.env.SystemRoot || 'C:\\Windows'; env.WINDIR = env.SystemRoot;
    }
    const options = { signal, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env };
    const listing = await run(tar, ['-tf', archive], options);
    const verbose = await run(tar, ['-tvf', archive], options);
    validateMembers(listing.stdout, verbose.stdout);
    await run(tar, ['-xf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions'], options);
    const files = regularTree(directory);
    if (files.reduce((sum, file) => sum + file.bytes, 0) > 512 * 1024 * 1024) throw fail('Copilot追加機能の展開サイズが上限を超えました。');
  }
  async install() {
    if (this.operation) throw fail('Copilot追加機能を準備中です。');
    const packages = specs(this.platform, this.arch);
    if (this.installed()) return this.status();
    this.safeDirectory(); this.error = '';
    const controller = new AbortController(); this.operation = controller;
    const temporary = fs.mkdtempSync(path.join(this.directory, '.download-'));
    const installation = path.join(this.directory, 'install-' + crypto.randomBytes(16).toString('hex'));
    let activated = false;
    try {
      fs.mkdirSync(installation, { mode: 0o700 });
      for (const [index, spec] of packages.entries()) {
        controller.signal.throwIfAborted();
        this.progress = { package: index + 1, total: packages.length, bytes: 0 };
        const archive = path.join(temporary, index + '.tgz'), unpacked = path.join(temporary, String(index));
        fs.mkdirSync(unpacked);
        await this.download(spec, archive, controller.signal);
        await this.unpack(archive, unpacked, controller.signal);
        const source = path.join(unpacked, 'package');
        const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
        if (metadata.name !== spec.name || metadata.version !== spec.version) throw fail('Copilot追加機能のバージョンが一致しません。');
        const destination = path.join(installation, 'node_modules', spec.name);
        fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(source, destination);
      }
      controller.signal.throwIfAborted();
      fs.writeFileSync(path.join(installation, 'package.json'), JSON.stringify({ private: true, version: lock.sdkVersion }));
      const files = regularTree(installation).map((file) => ({ path: file.relative, bytes: file.bytes, sha256: crypto.createHash('sha256').update(fs.readFileSync(file.full)).digest('hex') }));
      fs.writeFileSync(path.join(installation, 'inventory.json'), JSON.stringify({ id, files }));
      const pointer = path.join(this.directory, 'current.json'), next = path.join(temporary, 'current.json');
      fs.writeFileSync(next, JSON.stringify({ id, target: this.platform + '-' + this.arch, directory: path.basename(installation) }), { mode: 0o600 });
      fs.renameSync(next, pointer); activated = true; this.checked = null;
      return this.status();
    } catch (error) {
      this.error = controller.signal.aborted ? '追加機能のダウンロードを中断しました。' : error.message?.includes('追加機能') ? error.message : 'Copilot追加機能を導入できませんでした。接続と空き容量を確認して再試行してください。';
      throw fail(this.error);
    } finally {
      this.operation = null; this.progress = null;
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
      if (!activated) fs.rmSync(installation, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  cancel() { this.operation?.abort(); return { cancelled: Boolean(this.operation) }; }
  load() {
    const root = this.installed();
    if (!root) throw fail('先にCopilot追加機能をダウンロードしてください。');
    // Verify once per installation/process before evaluating any downloaded JavaScript.
    if (this.checked !== root) {
      const tree = regularTree(root);
      const inventoryFile = tree.find((f) => f.relative === 'inventory.json');
      if (!inventoryFile || inventoryFile.bytes > 4 * 1024 * 1024) throw fail('Copilot追加機能が破損しています。削除して再導入してください。');
      const inventory = JSON.parse(fs.readFileSync(inventoryFile.full));
      if (inventory.id !== id || !Array.isArray(inventory.files)) throw fail('Copilot追加機能が破損しています。削除して再導入してください。');
      const actual = tree.filter((f) => f.relative !== 'inventory.json');
      if (actual.length !== inventory.files.length) throw fail('Copilot追加機能が破損しています。削除して再導入してください。');
      const expected = new Map(inventory.files.map((file) => [file.path, file]));
      for (const file of actual) {
        const saved = expected.get(file.relative);
        if (!saved || saved.bytes !== file.bytes || crypto.createHash('sha256').update(fs.readFileSync(file.full)).digest('hex') !== saved.sha256) throw fail('Copilot追加機能が破損しています。削除して再導入してください。');
      }
      this.checked = root;
    }
    return createRequire(path.join(root, 'package.json'))('@github/copilot-sdk');
  }
  remove() {
    if (this.operation) throw fail('ダウンロードを中断してから追加機能を削除してください。');
    this.safeDirectory();
    fs.rmSync(path.join(this.directory, 'current.json'), { force: true }); this.checked = null; this.error = '';
    let pendingRestart = false;
    // Include abandoned/incompatible generations; never follow links or touch login data.
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^install-[a-f0-9]{32}$/.test(name)) continue;
      try { fs.rmSync(path.join(this.directory, name), { recursive: true, force: true, maxRetries: 1 }); }
      catch { pendingRestart = true; }
    }
    return { ...this.status(), pendingRestart };
  }
}
module.exports = { CopilotPack, specs, validateMembers, regularTree };
