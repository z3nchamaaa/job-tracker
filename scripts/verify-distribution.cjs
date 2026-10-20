#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runtimeFiles } = require('./stage.cjs');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'dist/mac-arm64/就活トラッカー.app');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = runtimeFiles('macos').map((relative) => {
  const source = sha(path.join(root, relative));
  const bundled = sha(path.join(app, 'Contents/Resources/app', relative));
  if (source !== bundled) throw new Error('Stale bundle: ' + relative);
  return { file: relative, sha256: source };
});
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const policy = execFileSync(path.join(app, 'Contents/MacOS/JobTrackerHost'), ['--test-origin-policy'], { encoding: 'utf8' }).trim();
if (policy !== 'ORIGIN_POLICY_SELF_TEST_OK') throw new Error('Native origin test failed');
const report = JSON.parse(fs.readFileSync(path.join(root, 'dist/size-report.json')));
for (const asset of [report.compressedDistributionDownload.macosDmg, report.compressedDistributionDownload.macosZip]) {
  if (sha(path.join(root, asset.path)) !== asset.sha256) throw new Error('Archive digest mismatch');
}
const result = { ok: true, checkedAt: new Date().toISOString(), sourceFilesMatched: files.length,
  codeSigningVerified: 'ad-hoc only', nativeOriginPolicy: policy, files };
fs.mkdirSync(path.join(root, 'dist/verification'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/verification/mac-bundle.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, sourceFilesMatched: files.length, nativeOriginPolicy: policy }));
