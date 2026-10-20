'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createAppServer } = require('../src/backend/server.cjs');
const { AppSettingsStore } = require('../src/backend/app-settings.cjs');
const { launchPage } = require('./browser.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-theme-lock-ui-'));
  let checks = 0, cancel = false, browser;
  const auth = { availability: async () => ({ available: true, label: '検証用のOS認証', reason: '' }), authenticate: async () => { checks++; if (cancel) throw new Error('認証がキャンセルされました'); } };
  const app = createAppServer({ dataDir: dir, allowDevBrowserSession: true, appAuth: auth, safeStorage: { isEncryptionAvailable: () => false } });
  const out = path.resolve(__dirname, '../dist/screenshots');
  fs.mkdirSync(out, { recursive: true });
  try {
    app.profileStore.saveProfile({ version: 1, completed: true });
    app.dbStore.createCompany({ name: '架空のテーマ確認企業', status: 'INTERESTED', isEarlySelection: true, industry: '検証用の架空データ' });
    const { bootstrapUrl } = await app.start(0);
    browser = await launchPage(bootstrapUrl, { width: 1280, height: 820 });
    const evaluate = (js) => browser.evaluate(js);
    const wait = async (js) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(js)) return;
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
      throw new Error('Timed out: ' + js);
    };
    const settings = async () => {
      await evaluate("document.getElementById('btn-app-settings').click()");
      await wait("Boolean(document.getElementById('app-settings-form'))");
    };
    const save = () => evaluate("document.getElementById('app-settings-form').requestSubmit()");
    await wait("document.querySelectorAll('.company-card').length===1");
    await settings();
    await evaluate("document.getElementById('setting-theme').value='dark';document.querySelector('input[name=setting-accent][value=blue]').click()");
    assert(await evaluate("document.querySelectorAll('.theme-preview').length===8 && document.querySelector('input[name=setting-accent]:checked').value==='blue'"));
    await save();
    await wait("document.documentElement.dataset.colorMode==='dark' && !document.getElementById('app-settings-form')");
    assert.equal(checks, 0);
    await browser.call('Page.reload', {});
    await wait("document.documentElement.dataset.colorMode==='dark' && document.documentElement.dataset.accent==='blue' && document.querySelector('.company-card')");
    const { data } = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'theme-dark.png'), Buffer.from(data, 'base64'));
    await settings();
    await evaluate("document.getElementById('setting-lock').checked=true");
    await save(); await wait("!document.getElementById('app-settings-form')");
    assert.equal(checks, 1);
    const store = new AppSettingsStore(dir);
    assert.equal(store.read().lockOnStartup, true);
    await settings(); cancel = true;
    await evaluate("document.getElementById('setting-lock').checked=false");
    await save(); await wait("document.getElementById('app-settings-message').textContent.includes('キャンセル')");
    assert.equal(store.read().lockOnStartup, true);
    assert(await evaluate("!document.querySelector('#app-settings-form button[type=submit]').disabled"));
    cancel = false;
    await save(); await wait("!document.getElementById('app-settings-form')");
    assert.equal(store.read().lockOnStartup, false);
    assert.equal(checks, 3);
    // OS theme changes affect system mode only; explicit light mode stays light.
    await settings();
    await evaluate("document.getElementById('setting-theme').value='system'");
    await save(); await wait("!document.getElementById('app-settings-form')");
    await browser.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await wait("document.documentElement.dataset.colorMode==='dark'");
    await browser.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await wait("document.documentElement.dataset.colorMode==='light'");
    const modes = [];
    for (const theme of ['light', 'dark']) {
      for (const accent of ['purple', 'blue', 'green', 'rose']) {
        await evaluate(`window.JobTrackerAppearance.apply('${theme}','${accent}')`);
        modes.push(await evaluate("({theme:document.documentElement.dataset.colorMode,accent:document.documentElement.dataset.accent,background:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.body).color})"));
      }
    }
    await settings();
    await evaluate("document.getElementById('toast-container').replaceChildren()");
    const swatches=await browser.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(out,'theme-swatches.png'),Buffer.from(swatches.data,'base64'));
    for (const [width, height] of [[390, 844], [360, 480], [640, 410]]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      assert(await evaluate("(()=>{const d=document.querySelector('.modal-dialog'),r=d.getBoundingClientRect(),b=d.querySelector('.modal-body');return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&b.clientHeight>0&&b.scrollWidth<=b.clientWidth+1})()"));
    }
    await evaluate("document.getElementById('toast-container').replaceChildren()");
    const narrow = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'settings-dark-narrow.png'), Buffer.from(narrow.data, 'base64'));
    await browser.close(); browser = null;
    await app.stop();
    // Actual native host uses the same persisted settings, with lock off to avoid interacting with a real account.
    if (process.argv.includes('--native')) {
      store.savePatch({ theme: 'dark', accent: 'blue', lockOnStartup: false });
      const native = await promisify(execFile)(path.resolve(__dirname, '../dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost'), ['--smoke-test', '--size', '1280x820', '--snapshot', path.join(out, 'theme-native-dark.png')], { env: { ...process.env, JOB_TRACKER_DATA_DIR: dir }, timeout: 25000 });
      assert(native.stdout.includes('SMOKE_TEST_OK'));
      fs.writeFileSync(path.join(out, 'theme-native-report.txt'), native.stdout);
      const transitions = await promisify(execFile)(path.resolve(__dirname, '../dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost'), ['--smoke-test', '--smoke-test-appearance'], { env: { ...process.env, JOB_TRACKER_DATA_DIR: dir }, timeout: 25000 });
      assert(transitions.stdout.includes('NATIVE_APPEARANCE_LIGHT_DARK_SYSTEM_OK'));
      fs.appendFileSync(path.join(out, 'theme-native-report.txt'), transitions.stdout);
    }
    fs.writeFileSync(path.join(out, 'theme-report.json'), JSON.stringify({ modes, authChecks: checks, mockAuthentication: true, narrowViewports: 3, restartPersistence: true }, null, 2));
    console.log('PASS: theme persistence, system changes, 8 color combinations, 3 narrow settings viewports, authenticated enable/disable, cancelled-disable persistence, native dark screenshot if requested. OS authentication results are mocked for UI checks.');
  } finally { await browser?.close(); await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
