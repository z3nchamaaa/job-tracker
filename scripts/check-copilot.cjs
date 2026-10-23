'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-copilot-ui-'));
  let browser, submitted, calls = 0, hold = false, rejectGeneration;
  const state = { clientId: '', connected: false, login: '', runtimeAvailable: false, pack: { installed: false, supported: true, installing: false }, generating: false, signingIn: false, models: [], quota: null };
  const service = {
    getStatus: () => ({ ...state }),
    installPack: async () => { state.runtimeAvailable = true; state.pack.installed = true; return { ...state }; },
    removePack: () => { state.runtimeAvailable = false; state.pack.installed = false; return { ...state }; },
    cancelPack: () => ({ cancelled: false }),
    configure: ({ clientId }) => { state.clientId = clientId; return { ...state }; },
    beginLogin: () => { state.signingIn = true; state.userCode = 'TEST-ONLY'; return { ...state }; },
    cancelLogin: () => { state.signingIn = false; state.userCode = ''; return { cancelled: true }; },
    signOut: () => { state.connected = false; state.login = ''; state.models = []; state.quota = null; return { ...state }; },
    details: async () => { state.models = [{ id: 'synthetic-copilot-model', name: '検証用モデル' }]; state.quota = [{ key: 'chat', remainingPercentage: 42, unlimited: false, resetDate: null }]; return { models: state.models, quota: state.quota }; },
    generate: async (value) => {
      calls++; submitted = value; state.generating = true;
      try {
        if (hold) await new Promise((resolve, reject) => { rejectGeneration = reject; });
        return JSON.stringify({ name: '架空のCopilot確認企業', industry: '検証用', annualIncome: null, sources: [] });
      } finally { state.generating = false; }
    },
    cancelGenerate: () => { rejectGeneration?.(new Error('検証用の生成中断')); return { cancelled: true }; },
    shutdown: async () => { rejectGeneration?.(new Error('shutdown')); },
  };
  const app = createAppServer({ dataDir: dir, allowDevBrowserSession: true, copilotService: service, safeStorage: { isEncryptionAvailable: () => false },
    openExternal: async (url) => { assert.equal(url, 'https://github.com/login/device'); state.connected = true; state.login = 'synthetic-user'; state.signingIn = false; state.userCode = ''; return { opened: true }; },
  });
  try {
    app.profileStore.saveProfile({ version: 1, completed: true });
    browser = await launchPage((await app.start(0)).bootstrapUrl);
    const evaluate = (s) => browser.evaluate(s);
    const wait = async (s) => { for (let i = 0; i < 200; i++) { if (await evaluate(s)) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out: ' + s); };
    const click = (id) => evaluate(`document.getElementById('${id}').click()`);
    const register = async () => { await click('btn-register-agents'); await wait("Boolean(document.getElementById('copilot-setup-form'))"); };
    const back = async () => { await evaluate("document.querySelector('#modal-root .modal-footer [data-modal-close]').click()"); await wait("Boolean(document.getElementById('pa-company-name'))"); };
    const out = path.resolve(__dirname, '../dist/screenshots'); fs.mkdirSync(out, { recursive: true });
    const screenshot = async (name) => { await evaluate("document.getElementById('toast-container').replaceChildren()"); fs.writeFileSync(path.join(out, name), Buffer.from((await browser.call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
    await wait("Boolean(document.querySelector('[data-empty-add=prompt]'))");
    await evaluate("window.reviewErrors=[];window.confirm=()=>true;window.addEventListener('unhandledrejection',e=>window.reviewErrors.push(String(e.reason)));document.getElementById('btn-add-prompt').click()");
    await register();
    assert(await evaluate("Boolean(document.getElementById('copilot-pack-install')) && !document.getElementById('copilot-login')"));
    await screenshot('copilot-pack-not-installed.png');
    await click('copilot-pack-install'); await wait("Boolean(document.getElementById('copilot-login'))");
    assert(await evaluate("document.getElementById('copilot-login').disabled"));
    await evaluate("document.getElementById('copilot-client-id').value='synthetic-client';document.getElementById('copilot-client-id').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('copilot-setup-form').requestSubmit()");
    await wait("!document.getElementById('copilot-login').disabled");
    await click('copilot-login'); await wait("Boolean(document.getElementById('copilot-open-device'))");
    await screenshot('copilot-device-login.png');
    await click('copilot-cancel-login'); await wait("Boolean(document.getElementById('copilot-login'))");
    await click('copilot-login'); await wait("Boolean(document.getElementById('copilot-open-device'))");
    await click('copilot-open-device'); await wait("Boolean(document.getElementById('copilot-details'))");
    await click('copilot-details'); await wait("document.querySelector('.copilot-quota').textContent.includes('42%')");
    await screenshot('copilot-connected.png');
    for (const [width,height] of [[360,480],[390,844],[768,700]]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false });
      assert(await evaluate("(()=>{const d=document.querySelector('#modal-root .modal-dialog'),r=d.getBoundingClientRect(),b=d.querySelector('.modal-body');return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&b.clientHeight>0&&b.scrollWidth<=b.clientWidth+1})()"));
    }
    await back(); await wait("Boolean(document.getElementById('btn-copilot-generate'))");
    await evaluate("document.getElementById('pa-company-name').value='架空のCopilot確認企業';document.getElementById('pa-company-name').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('copilot-model-select').value='synthetic-copilot-model';document.getElementById('copilot-model-select').dispatchEvent(new Event('change'))");
    await click('btn-copilot-generate'); await wait("!document.getElementById('btn-save-draft-company').disabled");
    assert.equal(submitted.model, 'synthetic-copilot-model'); assert(submitted.input.includes('架空のCopilot確認企業'));
    assert.equal(app.dbStore.listCompanies().length, 0);
    await click('btn-save-draft-company'); await wait("!document.getElementById('pa-json-input') && document.querySelector('.company-card')");
    assert.equal(app.dbStore.listCompanies().length, 1);
    // A cancelled/closed generation must not touch detached inputs or reopen a dialog.
    hold = true;
    await click('btn-add-prompt'); await wait("Boolean(document.getElementById('btn-copilot-generate'))");
    await click('btn-copilot-generate'); await wait("!document.getElementById('btn-copilot-cancel').hidden");
    await click('btn-copilot-cancel'); await wait("!document.getElementById('btn-copilot-generate').disabled");
    assert.equal(app.dbStore.listCompanies().length, 1);
    rejectGeneration = null;
    await click('btn-copilot-generate'); await wait("!document.getElementById('btn-copilot-cancel').hidden");
    await evaluate("document.querySelector('#modal-root .modal-header [data-modal-close]').click()");
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await evaluate('window.reviewErrors'), []);
    await click('btn-add-prompt'); await wait("Boolean(document.getElementById('btn-copilot-generate'))");
    await register(); await click('copilot-signout'); await wait("Boolean(document.getElementById('copilot-login'))");
    await click('copilot-pack-remove'); await wait("Boolean(document.getElementById('copilot-pack-install'))");
    await click('copilot-pack-install'); await wait("Boolean(document.getElementById('copilot-login'))");
    await back(); await wait("!document.getElementById('api-agent-select')");
    assert.equal(app.dbStore.listCompanies().length, 1); assert.equal(calls, 3);
    console.log('PASS: Client ID setup, device-code login/cancel, quota and model selection, explicit generation, preview before DB write, cancel and close during generation without exceptions, sign-out without company loss, 3 narrow viewports. OAuth/SDK/OS auth mocked; no real account or paid model calls.');
  } finally { await browser?.close(); await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
