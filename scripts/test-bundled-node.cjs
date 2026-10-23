'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stageBundledNode, verifyBundledNode } = require('./node-runtime.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const directory = path.join(root, 'dist/verification/bundled-node-' + process.platform + '-' + process.arch);
  await stageBundledNode(directory, process.platform, process.arch);
  const metadata = verifyBundledNode(directory, process.platform, process.arch);
  const executable = path.join(directory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const env = { ...process.env, PATH: '', JOB_TRACKER_NODE_PATH: path.join(directory, 'does-not-exist') };
  for (const key of Object.keys(env)) if (['path', 'node_options', 'node_path'].includes(key.toLowerCase())) delete env[key];
  env.PATH = '';
  const output = JSON.parse(execFileSync(executable, ['--no-warnings', '-e',
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE example(value INTEGER)');db.close();console.log(JSON.stringify({version:process.versions.node,executable:process.execPath}))"],
    { env, encoding: 'utf8', timeout: 15000 }));
  assert.equal(output.version, metadata.version);
  assert.equal(fs.realpathSync(output.executable), fs.realpathSync(executable));
  fs.writeFileSync(path.join(root, 'dist/verification/bundled-node.json'), JSON.stringify({ version: metadata.version,
    target: process.platform + '-' + process.arch, emptyPath: true, sqlitePassed: true,
    binarySha256: metadata.binarySha256, fullLicenseVerified: true }, null, 2) + '\n');
  console.log('PASS: bundled Node and SQLite run with an empty PATH; no separate Node installation is used.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
