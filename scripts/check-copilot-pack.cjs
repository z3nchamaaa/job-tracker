'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { isolatedEnvironment } = require('../src/backend/copilot.cjs');
const { CopilotPack } = require('../src/backend/copilot-pack.cjs');
if (!process.argv.includes('--download')) throw new Error('Use --download to explicitly fetch the fixed official optional packages');
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-copilot-pack-live-'));
  const pack = new CopilotPack({ directory: path.join(temporary, 'extensions/copilot') });
  try {
    assert.equal(pack.status().installed, false);
    await pack.install(); assert.equal(pack.status().installed, true);
    const loader = "const {CopilotPack}=require(process.argv[1]); const s=new CopilotPack({directory:process.argv[2]}).load(); if(typeof s.CopilotClient!=='function'||typeof s.RuntimeConnection.forStdio!=='function')process.exit(1);console.log('SDK_LOAD_OK')";
    const result = execFileSync(process.execPath, ['-e', loader, path.resolve(__dirname, '../src/backend/copilot-pack.cjs'), pack.directory], { encoding: 'utf8', timeout: 30000, env: isolatedEnvironment(temporary), windowsHide: true });
    assert(result.includes('SDK_LOAD_OK'));
    const root = pack.installed();
    const bytes = require('../src/backend/copilot-pack.cjs').regularTree(root).reduce((sum, f) => sum + f.bytes, 0);
    fs.appendFileSync(path.join(root, 'node_modules/@github/copilot-sdk/package.json'), '\n');
    assert.throws(() => new CopilotPack({ directory: pack.directory }).load(), /破損/);
    const removed = pack.remove(); assert.equal(removed.installed, false);
    const report = { platform: process.platform, arch: process.arch, bytes, officialPackages: 6, integrity: 'SHA-512 before extraction and per-file SHA-256 before loading', sdkExportsLoaded: true, tamperingRejected: true, removed: true, pendingRestart: removed.pendingRestart, realLoginOrGeneration: false };
    const output = path.resolve(__dirname, '../dist/verification/copilot-pack-' + process.platform + '-' + process.arch + '.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { pack.cancel(); fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
