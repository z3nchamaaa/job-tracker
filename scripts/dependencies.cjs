'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const VERSIONS = Object.freeze({ '@github/copilot-sdk': '1.0.23', koffi: '3.2.1', 'vscode-jsonrpc': '8.2.1', zod: '4.6.6' });

function verifyDependencyPolicy(directory = root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json')));
  if (JSON.stringify(pkg.dependencies) !== JSON.stringify({ '@github/copilot-sdk': VERSIONS['@github/copilot-sdk'] }) || Object.keys(pkg.devDependencies || {}).length) throw new Error('Only the pinned official Copilot SDK is an approved direct dependency');
  if (JSON.stringify(pkg.overrides) !== JSON.stringify({ '@github/copilot-sdk': { zod: VERSIONS.zod } })) throw new Error('The reviewed Zod security override must remain pinned');
  const approved = (name) => VERSIONS[name] || (/^@github\/copilot-sdk-(darwin|linux|linuxmusl|win32)-(arm64|x64)$/.test(name) ? '1.0.23' : /^@koromix\/koffi-(android|darwin|freebsd|linux|openbsd|win32)-(arm|arm64|ia32|loong64|riscv64|x64)$/.test(name) ? '3.2.1' : null);
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key) continue;
    const name = key.replace(/^node_modules\//, '');
    if (key !== `node_modules/${name}` || !approved(name) || approved(name) !== entry.version || entry.link || entry.license !== 'MIT') throw new Error(`Unapproved locked dependency: ${key}`);
    const url = new URL(entry.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || !entry.integrity?.startsWith('sha512-')) throw new Error(`Untrusted dependency origin/integrity: ${key}`);
    if (entry.hasInstallScript && name !== 'koffi') throw new Error(`Unreviewed install script: ${name}`);
  }
  for (const [name, version] of Object.entries(VERSIONS)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) throw new Error(`Missing locked dependency: ${name}`);
  }
  return lock;
}

function dependencyFiles(platform, arch = process.arch) {
  const lock = verifyDependencyPolicy();
  const target = { macos: 'darwin', windows: 'win32', linux: 'linux' }[platform];
  const packages = [...Object.keys(VERSIONS)];
  // Cross-packaging without that target's native packages keeps the core app
  // usable; Copilot explicitly reports unavailable instead of shipping a wrong CPU.
  for (const name of [`@github/copilot-sdk-${target}-${arch}`, `@github/copilot-sdk-linuxmusl-${arch}`, `@koromix/koffi-${target}-${arch}`]) {
    if (name.includes('linuxmusl') && target !== 'linux') continue;
    if (fs.existsSync(path.join(root, 'node_modules', name, 'package.json'))) packages.push(name);
  }
  const files = [];
  for (const name of packages) {
    const relative = path.join('node_modules', name), packageDir = path.join(root, relative);
    if (!fs.existsSync(packageDir) || fs.lstatSync(packageDir).isSymbolicLink()) throw new Error(`Run npm ci --ignore-scripts first: ${name}`);
    const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')));
    if (metadata.version !== lock.packages[`node_modules/${name}`]?.version) throw new Error(`Installed dependency differs from lock: ${name}`);
    const walk = (directory) => {
      for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue;
        const file = path.join(directory, item.name);
        if (item.isSymbolicLink()) throw new Error(`Symlink in dependency: ${file}`);
        if (item.isDirectory()) walk(file);
        else if (item.isFile()) files.push(file);
      }
    };
    walk(relative);
  }
  return files;
}
module.exports = { verifyDependencyPolicy, dependencyFiles };
