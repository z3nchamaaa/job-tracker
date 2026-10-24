'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyDependencyPolicy, dependencyFiles } = require('../scripts/dependencies.cjs');

test('Dependency policy rejects unapproved packages, tampered origin/version and unreviewed install scripts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-dependency-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json')));
  const original = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package-lock.json')));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const check = (edit) => {
    const lock = structuredClone(original); edit(lock);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    return () => verifyDependencyPolicy(dir);
  };
  assert.doesNotThrow(check(() => {}));
  assert.throws(check((lock) => { lock.packages['node_modules/zod'].resolved = 'https://example.invalid/zod.tgz'; }), /origin/);
  assert.throws(check((lock) => { lock.packages['node_modules/zod'].version = '999.0.0'; }), /Unapproved/);
  assert.throws(check((lock) => { lock.packages['node_modules/zod'].hasInstallScript = true; }), /install script/);
  assert.throws(check((lock) => { lock.packages['node_modules/unapproved'] = { version: '1.0.0' }; }), /Unapproved/);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(original));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, overrides: {} }));
  assert.throws(() => verifyDependencyPolicy(dir), /override/);
});

test('Cross-platform staging excludes the host native Copilot runtime from other OS packages', () => {
  const target = process.platform === 'darwin' ? 'windows' : 'macos';
  const files = dependencyFiles(target, process.arch);
  assert(files.includes(path.join('node_modules', '@github/copilot-sdk', 'package.json')));
  assert(!files.some((f) => f.includes(path.join('@github', `copilot-sdk-${process.platform}-${process.arch}`) + path.sep)));
  assert(!files.some((f) => /(^|[\\/])\.|\.(db|enc|key|pem)$/.test(f)));
});
