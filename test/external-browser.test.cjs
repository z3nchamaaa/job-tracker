'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createExternalBrowser } = require('../src/backend/external-browser.cjs');

function fixture(platform, hostBinaryPath) {
  const child = new EventEmitter(), stdin = new EventEmitter();
  let call, input;
  stdin.end = (value) => { input = value; };
  child.stdin = stdin;
  child.kill = () => {};
  const open = createExternalBrowser({ platform, hostBinaryPath, spawn: (...args) => { call = args; return child; } });
  return { child, open, call: () => call, input: () => input };
}

test('Windows passes the entire OAuth URL via stdin and waits for the native ShellExecute result', async () => {
  const f = fixture('win32', 'C:\\app\\JobTrackerHost.exe');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&scope=synthetic';
  let finished = false;
  const result = f.open(url).then(() => { finished = true; });
  assert.deepEqual(f.call().slice(0, 2), ['C:\\app\\JobTrackerHost.exe', ['--open-external']]);
  assert.equal(f.call()[2].shell, false);
  assert.equal(f.input(), url);
  await Promise.resolve(); assert.equal(finished, false);
  f.child.emit('close', 0); await result;
});

test('Browser launch failures propagate without returning the OAuth URL or leaving an unhandled spawn error', async () => {
  for (const event of ['error', 'close', 'stdin']) {
    const f = fixture('win32', 'C:\\missing\\host.exe');
    const result = f.open('https://example.com/?state=synthetic-secret');
    const rejected = assert.rejects(result, (error) => error.message.includes('ブラウザー') && !error.message.includes('synthetic-secret'));
    if (event === 'error') f.child.emit('error', new Error('ENOENT synthetic-secret'));
    else if (event === 'stdin') f.child.stdin.emit('error', new Error('EPIPE synthetic-secret'));
    else f.child.emit('close', 1);
    await rejected;
  }
});

test('Development Windows fallback uses a fixed PowerShell script and URL data on stdin', async () => {
  const f = fixture('win32');
  const result = f.open('https://example.com/?a=one&b=two');
  assert.match(f.call()[0], /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert(!f.call()[1].some(arg => arg.includes('https://example.com')));
  assert.equal(f.input(), 'https://example.com/?a=one&b=two');
  f.child.emit('close', 0); await result;
});

test('Invalid external targets are rejected before launching; macOS and Linux use argument arrays', async () => {
  const invalid = fixture('win32');
  for (const url of ['http://example.com', 'file:///tmp/test', '-flag', 'https://user:pass@example.com', 'https://example.com/"x', 'https://example.com/a\nb']) {
    await assert.rejects(invalid.open(url));
    assert.equal(invalid.call(), undefined);
  }
  for (const platform of ['darwin', 'linux']) {
    const f = fixture(platform);
    const result = f.open('https://example.com/?a=one&b=two');
    assert.equal(f.call()[0], platform === 'darwin' ? 'open' : 'xdg-open');
    assert.equal(f.call()[1].at(-1), 'https://example.com/?a=one&b=two');
    f.child.emit('close', 0); await result;
  }
});
