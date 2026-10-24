'use strict';

const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');

function createExternalBrowser({ platform = process.platform, hostBinaryPath, spawn = spawnProcess,
  systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  return async (rawUrl) => {
    if (typeof rawUrl !== 'string') throw new Error('URLが不正です。');
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('-') || /[\u0000-\u001f\u007f\s"]/.test(trimmed)) throw new Error('不正なURL形式です。');
    let parsed;
    try { parsed = new URL(trimmed); } catch { throw new Error('不正なURL形式です。'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
      throw new Error('外部ブラウザで開けるのは認証情報を含まない https:// のURLのみです。');
    }
    const href = parsed.href;
    const windows = platform === 'win32';
    const command = windows
      ? hostBinaryPath || path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = windows
      ? hostBinaryPath ? ['--open-external'] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; Start-Process -FilePath ([Console]::In.ReadToEnd()) -ErrorAction Stop | Out-Null"]
      : platform === 'darwin' ? ['--', href] : [href];

    await new Promise((resolve, reject) => {
      const failure = () => reject(new Error('既定のブラウザーを開けませんでした。既定のブラウザー設定を確認して再試行してください。'));
      let child;
      try { child = spawn(command, args, { stdio: [windows ? 'pipe' : 'ignore', 'ignore', 'ignore'], windowsHide: true, shell: false }); }
      catch { failure(); return; }
      const timer = setTimeout(() => { child.kill(); failure(); }, 15000);
      const failed = () => { clearTimeout(timer); failure(); };
      child.once('error', failed);
      child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : failure(); });
      if (windows) {
        child.stdin.on('error', failed);
        child.stdin.end(href);
      }
    });
  };
}

module.exports = { createExternalBrowser };
