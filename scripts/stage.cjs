'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Only executable application sources, known icons and license notices are staged.
// Dotfiles, links, data/config files and unrelated directories are never copied.
function runtimeFiles(platform) {
  const files = [];
  const visit = (relative, extensions) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(rel, extensions);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) files.push(rel);
    }
  };
  visit('src/backend', ['.cjs']);
  visit('src/shared', ['.cjs']);
  visit('src/ui', ['.js', '.css', '.html']);
  files.push('package.json', 'LICENSE', 'licenses/Lucide.txt', ...['png', 'ico'].map((ext) => `assets/icons/app-icon.${ext}`));
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

function copyRuntime(destination, platform) {
  for (const relative of runtimeFiles(platform)) {
    const source = path.join(root, relative);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsupported distribution file: ${relative}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

if (require.main === module) {
  const [destination, platform] = process.argv.slice(2);
  if (!destination) throw new Error('Staging destination is required');
  const resolved = path.resolve(destination);
  if (!resolved.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Stage inside dist only');
  copyRuntime(resolved, platform);
}

module.exports = { runtimeFiles, copyRuntime };
