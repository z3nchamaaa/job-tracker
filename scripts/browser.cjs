'use strict';

// Development-only CDP client. It starts a separate Chrome profile and never
// attaches to an existing browser or reads the user's browsing state.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function launchPage(url, { width = 1280, height = 820, scale = 1 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-browser-'));
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--hide-scrollbars',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let startupError;
  child.once('error', (error) => { startupError = error; });
  let socket;
  const pending = new Map();
  let id = 0;
  const close = async () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Browser closed')); }
    pending.clear();
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500); })]);
      clearTimeout(timer);
      await Promise.race([exited, delay(1500)]);
    }
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 12000;
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    while (port === undefined) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Test browser did not start');
      if (fs.existsSync(portFile)) {
        // Chrome can create this file before writing the port. Only consume
        // a complete first line, rather than interpreting an empty file as 0.
        const firstLine = /^(\d+)\r?\n/.exec(fs.readFileSync(portFile, 'utf8'));
        if (firstLine) {
          port = Number(firstLine[1]);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser port');
          break;
        }
      }
      await delay(50);
    }
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const page = pages.find((p) => p.type === 'page');
    if (!page || new URL(page.webSocketDebuggerUrl).hostname !== '127.0.0.1') throw new Error('Unexpected browser target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser connection timeout')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser connection failed')); }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Browser command timeout: ${method}`)); }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error('Browser evaluation failed');
      return result.result.value;
    };
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await call('Page.navigate', { url });
    return { call, evaluate, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { CHROME, launchPage };
