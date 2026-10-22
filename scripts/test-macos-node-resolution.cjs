'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('../src/backend/runtime.cjs').assertSupportedRuntime();

if (process.platform !== 'darwin') throw new Error('macOS is required');
let host = process.argv[2] ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-node-resolution-'));
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
try {
  const fixture = process.argv.includes('--package-fixture');
  if (fixture) {
    const contents = path.join(dir, 'Standalone.app/Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    const app = path.join(contents, 'Resources/app');
    fs.mkdirSync(path.join(app, 'src/backend'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../platforms/macos/Info.plist'), path.join(contents, 'Info.plist'));
    fs.copyFileSync(path.resolve(__dirname, '../src/backend/runtime.cjs'), path.join(app, 'src/backend/runtime.cjs'));
    fs.copyFileSync(path.resolve(__dirname, '../src/backend/cli.cjs'), path.join(app, 'src/backend/cli.cjs'));
    fs.cpSync(path.resolve(__dirname, '../dist/verification/bundled-node-' + process.platform + '-' + process.arch + '/runtime'), path.join(app, 'runtime'), { recursive: true });
    const copied = path.join(contents, 'MacOS/JobTrackerHost');
    fs.copyFileSync(host, copied); fs.chmodSync(copied, 0o755); host = copied;
  }
  const packagedNode = path.resolve(path.dirname(host), '../Resources/app/runtime/node');
  const packaged = fs.existsSync(packagedNode);
  const asdf = path.join(dir, 'asdf');
  const installed = path.join(asdf, 'installs/nodejs');
  const validDir = path.join(installed, process.versions.node, 'bin');
  const invalidDir = path.join(installed, '99.0.0/bin');
  fs.mkdirSync(validDir, { recursive: true });
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(validDir, 'node'));
  const preload = path.join(dir, 'old-node.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions,'node',{value:'26.12.0'});\n");
  const invalid = path.join(invalidDir, 'node');
  fs.writeFileSync(invalid, '#!/bin/sh\nexec ' + quote(process.execPath) + ' --require ' + quote(preload) + ' "$@"\n', { mode: 0o755 });
  const data = path.join(dir, 'must-not-be-created');
  const base = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ASDF_DATA_DIR: asdf, JOB_TRACKER_DATA_DIR: data };
  delete base.JOB_TRACKER_NODE_PATH;
  const resolve = (extra = {}) => spawnSync(host, ['--test-node-resolution'], {
    env: { ...base, ...extra }, encoding: 'utf8', timeout: 12000,
  });
  if (packaged) {
    for (const extra of [{}, { JOB_TRACKER_NODE_PATH: invalid }, { NODE_OPTIONS: '--require /not-present/preload.cjs', NODE_PATH: '/not-present' }]) {
      const result = resolve(extra);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(packagedNode));
    }
    if (fixture) {
      fs.renameSync(packagedNode, packagedNode + '.missing');
      try {
        const result = resolve({ JOB_TRACKER_NODE_PATH: process.execPath });
        assert.equal(result.status, 1, 'A damaged packaged app must not switch to an external Node');
        assert.match(result.stderr, /アプリを入れ直してください/);
      } finally { fs.renameSync(packagedNode + '.missing', packagedNode); }
    }
  } else {
    for (const extra of [{}, { JOB_TRACKER_NODE_PATH: process.execPath }]) {
      const result = resolve(extra);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(process.execPath));
    }
    for (const explicit of [invalid, path.join(dir, 'missing-node')]) {
      const result = resolve({ JOB_TRACKER_NODE_PATH: explicit });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Node.js/);
    }
  }
  assert.equal(fs.existsSync(data), false, 'Runtime discovery must not open or create user data');
  const report = { checkedAt: new Date().toISOString(), minimalPath: true, packaged, bundledNodeUsed: packaged, asdfDetected: !packaged,
    incompatibleCandidateRejected: true, explicitOverrideRespected: true, noDataCreated: true };
  const output = path.resolve(__dirname, '../dist/verification');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'macos-node-resolution.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(packaged ? 'PASS: packaged app uses bundled Node despite empty shell paths, poisoned Node options and invalid overrides; no data access.' : 'PASS: development asdf detection, security floors and explicit override; no data access.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
