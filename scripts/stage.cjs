'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// Copilot dependencies are installed explicitly as an optional extension pack.

// Only executable application sources, known icons and license notices are staged.
// Dotfiles, links, data/config files and unrelated directories are never copied.
function runtimeFiles(platform, arch = process.arch) {
  const files = [];
  const visit = (relative, extensions) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(rel, extensions);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) files.push(rel);
    }
  };
  visit('src/backend', ['.cjs', '.json']);
  visit('src/shared', ['.cjs']);
  visit('src/ui', ['.js', '.css', '.html']);
  files.push('package.json', 'package-lock.json', 'LICENSE', 'licenses/Lucide.txt', 'licenses/Copilot-SDK-MIT.txt', 'licenses/Copilot-CLI.txt', 'licenses/Node.js.txt', ...['png', 'ico'].map((ext) => `assets/icons/app-icon.${ext}`));

  const hosts = { macos: ['bridge.js'], windows: ['bridge.js'], linux: ['job-tracker-host.py'] };
  if (!hosts[platform]) throw new Error('Unsupported staging platform');
  files.push(...hosts[platform].map((file) => `platforms/${platform}/${file}`));
  for (const notice of ['THIRD_PARTY_NOTICES.md']) {
    if (fs.existsSync(path.join(root, notice))) files.push(notice);
  }
  if (platform === 'windows') {
    files.push('licenses/Microsoft.Web.WebView2.txt', 'licenses/ProtectedData-MIT.txt', 'dependency-integrity.json');
  }
  return files.sort();
}

function stagedContent(relative) {
  if (relative === 'src/backend/google-oauth-client.json') {
    const source = process.env.JOB_TRACKER_GOOGLE_OAUTH_CLIENT_FILE;
    if (!source) return Buffer.from('{}\n');
    // Explicit build input only: never auto-discover credentials or read .env.
    // Copy only the Desktop client fields, not tokens, URLs or other JSON data.
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error();
      const client = require('../src/backend/google-oauth-config.cjs').desktopClient(JSON.parse(fs.readFileSync(source, 'utf8')));
      return Buffer.from(JSON.stringify(client) + '\n');
    } catch { throw new Error('配布用Google設定を読み取れません。JOB_TRACKER_GOOGLE_OAUTH_CLIENT_FILEにデスクトップ用クライアントJSONを指定してください。'); }
  }
  const raw = fs.readFileSync(path.join(root, relative));
  if (relative === 'package.json') {
    const pkg = JSON.parse(raw); pkg.dependencies = {};
    return Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  }
  if (relative === 'package-lock.json') {
    const pkg = JSON.parse(stagedContent('package.json'));
    return Buffer.from(JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
      packages: { '': { name: pkg.name, version: pkg.version, license: pkg.license, engines: pkg.engines } } }, null, 2) + '\n');
  }
  return raw;
}
function copyRuntime(destination, platform, arch = process.arch) {
  for (const relative of runtimeFiles(platform, arch)) {
    const source = path.join(root, relative);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsupported distribution file: ${relative}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, stagedContent(relative));
  }
}

if (require.main === module) {
  const [destination, platform, arch] = process.argv.slice(2);
  if (!destination) throw new Error('Staging destination is required');
  const resolved = path.resolve(destination);
  if (!resolved.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Stage inside dist only');
  copyRuntime(resolved, platform, arch);
}

module.exports = { runtimeFiles, copyRuntime, stagedContent };
