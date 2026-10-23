'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getNodeSpec, verifyBundledNode } = require('../scripts/node-runtime.cjs');

test('Bundled Node pins official archive, binary, license and CPU separately', () => {
  for (const [platform, arch] of [['darwin','arm64'],['darwin','x64'],['win32','x64'],['win32','arm64'],['linux','x64']]) {
    const spec = getNodeSpec(platform, arch);
    assert.equal(spec.version, '26.12.1');
    assert.equal(spec.platform, platform);
    assert.equal(spec.arch, arch);
    for (const key of ['archiveSha256','binarySha256','licenseSha256']) assert.match(spec[key], /^[a-f0-9]{64}$/);
  }
  assert.notEqual(getNodeSpec('win32','x64').binarySha256, getNodeSpec('win32','arm64').binarySha256);
  assert.throws(() => getNodeSpec('../outside','x64'), /Unsupported/);
  assert.throws(() => getNodeSpec('linux','../outside'), /Unsupported/);
});

test('Bundled Node integrity verification rejects replaced executables and missing notices', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-node-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir,'runtime'); fs.mkdirSync(runtime);
  assert.throws(() => verifyBundledNode(dir,'darwin','arm64'));
  fs.writeFileSync(path.join(runtime,'node'),'not the official executable');
  assert.throws(() => verifyBundledNode(dir,'darwin','arm64'), /integrity mismatch/);
  assert.equal(fs.existsSync(path.join(dir,'job-tracker.db')), false);
});
