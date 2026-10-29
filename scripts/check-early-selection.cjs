'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-early-ui-'));
  const app = createAppServer({ dataDir: directory, allowDevBrowserSession: true });
  let browser;
  try {
    app.profileStore.saveProfile({ version: 1, completed: true });
    const existing = app.dbStore.createCompany({ name: '架空の既存企業', status: 'INTERESTED', isEarlySelection: true });
    browser = await launchPage((await app.start(0)).bootstrapUrl);
    const evaluate = (expression) => browser.evaluate(expression);
    const wait = async (expression) => {
      for (let i = 0; i < 200; i++) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error('Timed out: ' + expression);
    };
    const click = async (selector) => {
      await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const openExisting = () => click(`[data-open-detail="${existing.id}"]`);
    const closeDetail = async () => {
      await click('.company-detail-dialog [data-modal-close]');
      await wait("!document.getElementById('cd-modal-title')");
    };
    await openExisting();
    for (const [width, height] of [[360, 480], [1280, 820]]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      assert(await evaluate("(()=>{const d=document.querySelector('.company-detail-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&d.scrollWidth<=d.clientWidth+1})()"));
    }
    await click('#cd-quick-early');
    await wait("!document.getElementById('cd-quick-early').disabled");
    assert.equal(app.dbStore.listCompanies().find((c) => c.id === existing.id).isEarlySelection, false);
    await closeDetail();
    await wait(`Boolean(document.querySelector('[data-lane-key="INTERESTED"] [data-company-id="${existing.id}"]'))`);
    await openExisting();
    await click('#cd-quick-early');
    await wait("!document.getElementById('cd-quick-early').disabled");
    assert.equal(app.dbStore.listCompanies().find((c) => c.id === existing.id).isEarlySelection, true);
    // Save changes through the existing notes form as well.
    await click('[data-cd-tab="notes"]');
    await evaluate("document.querySelector('#cd-notes-form [name=name]').value='架空の変更済み企業';document.querySelector('#cd-notes-form').requestSubmit()");
    await wait("document.getElementById('cd-modal-title').textContent === '架空の変更済み企業'");
    assert.equal(app.dbStore.listCompanies().find((c) => c.id === existing.id).name, '架空の変更済み企業');
    await evaluate("const select=document.getElementById('cd-quick-status');select.value='APPLIED';select.dispatchEvent(new Event('change',{bubbles:true}))");
    await wait("document.querySelector('#cd-notes-form [name=name]')?.value === '架空の変更済み企業' && document.getElementById('cd-quick-status').value === 'APPLIED'");
    await closeDetail();
    await wait(`Boolean(document.querySelector('[data-lane-key="APPLIED"] [data-company-id="${existing.id}"]'))`);
    assert.equal(app.dbStore.listCompanies().find((c) => c.id === existing.id).isEarlySelection, true);

    await click('[data-lane-key="EARLY_SELECTION"] .lane-expand');
    await click('.kanban-expanded [data-add-early]');
    assert.equal(await evaluate("document.querySelector('#manual-add-form [name=isEarlySelection]').checked"), true);
    await evaluate("document.getElementById('ma-name').value='架空の早期追加企業';document.getElementById('manual-add-form').requestSubmit()");
    await wait("!document.getElementById('manual-add-form')");
    const added = app.dbStore.listCompanies().find((c) => c.name === '架空の早期追加企業');
    assert(added?.isEarlySelection);
    assert.equal(added.status, 'INTERESTED');
    await wait(`Boolean(document.querySelector('.kanban-expanded [data-company-id="${added.id}"]'))`);
    const output = path.resolve(__dirname, '../dist/screenshots');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'early-selection.png'), Buffer.from((await browser.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    console.log('PASS: edit an existing early company, toggle flag both ways, advance to application retaining flag, and add directly in the expanded early lane. Synthetic data only.');
  } finally {
    await browser?.close();
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
