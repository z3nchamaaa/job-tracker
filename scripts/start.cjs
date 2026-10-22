#!/usr/bin/env node
'use strict';

require("../src/backend/runtime.cjs").assertSupportedRuntime();

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const macHostBin = path.join(
  repoRoot,
  'dist',
  'mac-arm64',
  '就活トラッカー.app',
  'Contents',
  'MacOS',
  'JobTrackerHost'
);

if (process.platform === 'darwin' && !process.argv.includes('--server-only') && fs.existsSync(macHostBin)) {
  const child = spawn(macHostBin, process.argv.slice(2), {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, JOB_TRACKER_NODE_PATH: process.env.JOB_TRACKER_NODE_PATH || process.execPath },
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  require('../src/backend/cli.cjs').main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
