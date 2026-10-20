#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseStore } = require('../src/backend/db.cjs');

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS is required');
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-file-panel-'));
  try {
    const db = new DatabaseStore({ dataDir });
    db.createCompany({ name: '架空ファイル選択テスト', status: 'APPLIED' });
    db.close();
    const { stdout } = await promisify(execFile)(
      path.join(root, 'dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost'),
      ['--smoke-test', '--smoke-test-file-panel', '--smoke-test-dialogs'],
      { env: { ...process.env, JOB_TRACKER_DATA_DIR: dataDir }, timeout: 20000, maxBuffer: 1024 * 1024 }
    );
    if (!stdout.includes('FILE_PANEL_CANCEL_OK') || !stdout.includes('CONFIRM_PANEL_CANCEL_OK') || !stdout.includes('SMOKE_TEST_OK:')) throw new Error('Native file chooser or confirmation regression');
    fs.mkdirSync(path.join(root, 'dist/verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/verification/macos-file-panel.txt'), stdout);
    process.stdout.write(stdout);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
