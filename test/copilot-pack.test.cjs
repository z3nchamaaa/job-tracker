'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CopilotPack, specs, validateMembers } = require('../src/backend/copilot-pack.cjs');
const { copyRuntime } = require('../scripts/stage.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-optional-copilot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, pack: new CopilotPack({ directory: path.join(dir, 'extensions/copilot') }) };
}
test('base app excludes all npm dependencies and keeps the pinned optional manifest', (t) => {
  const { dir } = fixture(t); copyRuntime(dir, 'macos', 'arm64');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).dependencies, {});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'src/backend/copilot-pack-lock.json'))).schema, 1);
});
test('all optional packages match the reviewed official npm lock and target CPU', () => {
  const lock = require('../package-lock.json');
  for (const [platform, arch] of [['darwin','arm64'],['darwin','x64'],['win32','x64'],['win32','arm64'],['linux','x64']]) {
    const packages = specs(platform, arch); assert.equal(packages.length, 6);
    for (const p of packages) {
      const saved = lock.packages['node_modules/' + p.name];
      assert.equal(p.integrity, saved.integrity); assert.equal(p.resolved, saved.resolved); assert.equal(p.version, saved.version);
    }
    assert(packages.some((p) => p.name === `@github/copilot-sdk-${platform}-${arch}`));
  }
  assert.throws(() => specs('../outside','x64'));
});
test('archive preflight rejects traversal, absolute paths, Windows paths, links and duplicate names', () => {
  validateMembers('package/\npackage/package.json\n', 'drwxr-xr-x directory\n-rw-r--r-- file\n');
  for (const name of ['../escape','/tmp/escape','package/../escape','package/C:/escape','package/a\\escape','package//file','package/./file','package/file\npackage/file']) {
    assert.throws(() => validateMembers(name, '-rw-r--r-- file\n'));
  }
  for (const type of ['l','h','b','c','p']) assert.throws(() => validateMembers('package/file', type + 'rw-r--r-- file\n'));
});
test('opening status does not create files or contact the network', (t) => {
  const { dir, pack } = fixture(t); pack.fetch = () => { throw new Error('no automatic network'); };
  assert.equal(pack.status().installed, false); assert.equal(pack.status().installing, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('checksum mismatch never reaches extraction or activation, cleans up and permits retry', async (t) => {
  const { pack } = fixture(t); let extracted = false;
  pack.fetch = async () => new Response('not the pinned official archive');
  pack.unpack = async () => { extracted = true; };
  await assert.rejects(pack.install(), /ハッシュ/);
  assert.equal(extracted, false); assert.equal(pack.status().installed, false); assert.equal(pack.operation, null);
  assert.deepEqual(fs.readdirSync(pack.directory), []);
  await assert.rejects(pack.install(), /ハッシュ/);
});
test('interrupted download cannot activate a pack and can be retried', async (t) => {
  const { pack } = fixture(t); let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  pack.fetch = async (url, options) => { requested(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); };
  const operation = pack.install(); await started; assert.equal(pack.status().installing, true);
  pack.cancel(); await assert.rejects(operation, /中断/);
  assert.equal(pack.status().installed, false); assert.equal(pack.operation, null);
  assert.deepEqual(fs.readdirSync(pack.directory), []);
});
test('download verifies official archive bytes rather than metadata or a successful HTTP code', async (t) => {
  const { dir, pack } = fixture(t); const bytes = Buffer.from('synthetic archive bytes');
  pack.progress = {}; pack.fetch = async () => new Response(bytes);
  const file = path.join(dir, 'synthetic.tgz');
  await pack.download({resolved:'https://registry.npmjs.org/synthetic.tgz',integrity:'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64')}, file, new AbortController().signal);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
