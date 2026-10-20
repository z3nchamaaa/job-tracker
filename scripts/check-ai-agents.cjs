'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-agent-ui-'));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(s) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()]); },
    decryptString(b) { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString(); },
  };
  let calls = 0, browser;
  const app = createAppServer({ dataDir: dir, allowDevBrowserSession: true, safeStorage, agentFetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-ui-secret-only');
    assert(JSON.parse(options.body).input.includes('架空の企業テスト'));
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ name: '架空の企業テスト', industry: '架空の検証データ', annualIncome: null, sources: [] }) }] }] });
  } });
  try {
    app.profileStore.saveProfile({ version: 1, completed: true });
    const { bootstrapUrl } = await app.start(0);
    browser = await launchPage(bootstrapUrl);
    const evaluate = (s) => browser.evaluate(s);
    const wait = async (s) => { for (let i = 0; i < 150; i++) { if (await evaluate(s)) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out: ' + s); };
    await wait("Boolean(document.querySelector('[data-empty-add=prompt]'))");
    await evaluate("document.getElementById('btn-add-prompt').click()");
    await wait("Boolean(document.getElementById('btn-register-agents'))");
    await evaluate("(()=>{const n=document.getElementById('pa-company-name');n.value='架空の企業テスト';n.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('pa-json-input').value='保留中の入力';document.getElementById('btn-register-agents').click()})()");
    await wait("Boolean(document.getElementById('agent-register-form'))");
    assert(await evaluate("document.getElementById('suspended-prompt-modal').inert && document.getElementById('agent-key').type==='password' && window.jobTrackerHasUnsavedChanges()"));
    await evaluate("document.getElementById('agent-name').value='企業整理用 <架空>';document.getElementById('agent-model').value='synthetic-model';document.getElementById('agent-key').value='synthetic-ui-secret-only';document.getElementById('agent-register-form').requestSubmit()");
    await wait("Boolean(document.querySelector('[data-delete-agent]'))");
    assert.equal(calls, 0);
    assert(await evaluate("document.getElementById('agent-key').value==='' && !document.getElementById('registered-agents').innerHTML.includes('synthetic-ui-secret')"));
    const output = path.resolve(__dirname, '../dist/screenshots'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'ai-agent-registration.png'), Buffer.from((await browser.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    for (const [width, height] of [[360,480],[390,844],[768,700]]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      assert(await evaluate("(()=>{const d=document.querySelector('#modal-root .modal-dialog'),r=d.getBoundingClientRect(),b=d.querySelector('.modal-body');return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&b.clientHeight>0&&b.scrollWidth<=b.clientWidth+1})()"));
    }
    await evaluate("document.querySelector('#modal-root .modal-footer [data-modal-close]').click()");
    await wait("Boolean(document.getElementById('api-agent-select'))");
    assert(await evaluate("document.getElementById('pa-company-name').value==='架空の企業テスト' && document.getElementById('pa-json-input').value==='保留中の入力' && !document.getElementById('modal-root').inert && !document.getElementById('suspended-prompt-modal') && window.jobTrackerHasUnsavedChanges()"));
    await evaluate("document.getElementById('btn-api-agent-generate').click()");
    await wait("!document.getElementById('btn-save-draft-company').disabled");
    assert.equal(calls, 1);
    assert.equal(app.dbStore.listCompanies().length, 0);
    assert(await evaluate("document.getElementById('pa-preview-area').textContent.includes('架空の企業テスト')"));
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('toast-container').replaceChildren()");
    fs.writeFileSync(path.join(output, 'ai-agent-prompt.png'), Buffer.from((await browser.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate("document.getElementById('btn-save-draft-company').click()");
    await wait("!document.getElementById('pa-json-input') && document.querySelector('.company-card')");
    assert.equal(app.dbStore.listCompanies().length, 1);
    const credential = fs.readFileSync(path.join(dir, 'auth', 'api-agents.enc'));
    assert(!credential.includes('synthetic-ui-secret-only'));
    await evaluate("document.getElementById('btn-add-prompt').click();document.getElementById('btn-register-agents').click()");
    await wait("Boolean(document.getElementById('agent-register-form'))");
    await evaluate("window.confirm=()=>false;document.getElementById('agent-name').value='未保存';document.getElementById('agent-name').dispatchEvent(new Event('input',{bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert(await evaluate("Boolean(document.getElementById('agent-register-form'))"));
    await evaluate("window.confirm=()=>true;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.getElementById('agent-register-form')");
    await evaluate("document.getElementById('btn-register-agents').click()");
    await wait("Boolean(document.querySelector('[data-delete-agent]'))");
    await evaluate("document.querySelector('[data-delete-agent]').click()");
    await wait("!document.querySelector('[data-delete-agent]')");
    await evaluate("document.querySelector('#modal-root .modal-footer [data-modal-close]').click()");
    await wait("!document.getElementById('api-agent-select') && document.getElementById('api-agent-controls').textContent.includes('追加できます')");
    assert.equal(app.dbStore.listCompanies().length, 1);
    console.log('PASS: nested registration, retained prompt and unsaved state, encrypted key, no API call on registration, escaped metadata, 3 narrow viewports, explicit generation, preview before DB save, Escape discard confirmation, deletion without company loss. APIs and OS encryption are mocked.');
  } finally { await browser?.close(); await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
