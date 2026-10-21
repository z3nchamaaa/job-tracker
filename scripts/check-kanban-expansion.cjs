'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-kanban-expansion-'));
  const app = createAppServer({ dataDir: dir, allowDevBrowserSession: true, safeStorage: { isEncryptionAvailable: () => false } });
  let browser;
  try {
    app.profileStore.saveProfile({ version: 1, completed: true });
    for (let i = 0; i < 12; i++) app.dbStore.createCompany({ name: `架空の検討企業 ${i + 1}`, status: 'INTERESTED', industry: '動作確認用の架空データ', location: '架空の所在地' });
    app.dbStore.createCompany({ name: '架空の早期選考企業', status: 'FINAL', isEarlySelection: true });
    app.dbStore.createCompany({ name: '架空の通常最終面接企業', status: 'FINAL' });
    const { bootstrapUrl } = await app.start(0);
    browser = await launchPage(bootstrapUrl, { width: 1440, height: 900 });
    // CI runners may inherit an OS reduced-motion preference. Exercise the
    // animated path explicitly here, then test reduced motion separately below.
    await browser.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const evaluate = (code) => browser.evaluate(code);
    const wait = async (code) => {
      for (let i = 0; i < 120; i++) {
        if (await evaluate(code)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(`Timed out: ${code}`);
    };
    await wait("document.querySelectorAll('.kanban-board .company-card').length===14");
    const clickCardBody = async (selector) => {
      const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.right-12,y:r.top+58}})()`);
      await browser.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await browser.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    await clickCardBody('.kanban-board .company-card');
    await wait("Boolean(document.querySelector('.modal-dialog'))");
    assert(await evaluate("!document.querySelector('.kanban-expanded')"), 'Card click must open details without expanding its lane');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('.modal-dialog')");
    await evaluate("document.querySelector('.card-detail-trigger').focus()");
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait("Boolean(document.querySelector('.modal-dialog'))");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('.modal-dialog')");
    assert(await evaluate("[...document.querySelectorAll('.kanban-board button')].every(b=>b.textContent.trim()!=='詳細')"));
    await evaluate("document.querySelector('.lane-cards').scrollTop=80");
    const scroll = await evaluate("document.querySelector('.lane-cards').scrollTop");
    await evaluate("document.querySelector('.lane-expand').click()");
    await evaluate("(()=>{const a=document.querySelector('.kanban-expanded').getAnimations()[0];a.pause();a.currentTime=0})()");
    assert(await evaluate("(()=>{const s=document.querySelector('.kanban-lane[data-lane-key=INTERESTED]'),p=document.querySelector('.kanban-expanded'),a=s.getBoundingClientRect(),b=p.getBoundingClientRect();return getComputedStyle(s).visibility==='hidden'&&Math.abs(a.left-b.left)<1&&Math.abs(a.top-b.top)<1&&Math.abs(a.width-b.width)<1&&Math.abs(a.height-b.height)<1})()"), 'Expansion must begin at the selected column bounds');
    const out = path.resolve(__dirname, '../dist/screenshots');
    fs.mkdirSync(out, { recursive: true });
    for (const [name, time] of [['start', 0], ['middle', 100]]) {
      await evaluate(`document.querySelector('.kanban-expanded').getAnimations()[0].currentTime=${time}`);
      const { data } = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(out, `kanban-expansion-${name}.png`), Buffer.from(data, 'base64'));
    }
    await evaluate("document.querySelector('.kanban-expanded').getAnimations()[0].play()");
    await wait("document.querySelector('.kanban-expanded')?.getAnimations()[0]?.playState==='finished'");
    assert(await evaluate("document.querySelector('.kanban-board').inert && document.querySelector('.kanban-expanded .expanded-cards').children.length===12 && document.querySelector('.view-tab.is-active').dataset.view==='kanban'"));
    assert(await evaluate("getComputedStyle(document.querySelector('.expanded-cards')).display==='grid'"));
    const { data } = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, 'kanban-expanded.png'), Buffer.from(data, 'base64'));
    await clickCardBody('.kanban-expanded .company-card');
    await wait("Boolean(document.querySelector('.modal-dialog'))");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('.modal-dialog')");
    assert(await evaluate("Boolean(document.querySelector('.kanban-expanded'))"));
    await evaluate("document.querySelector('[data-collapse-lane]').click()");
    assert(await evaluate("document.querySelector('.kanban-expanded').getAnimations()[0].effect.getTiming().duration<=160"), 'Closing should complete within 160ms');
    await wait("!document.querySelector('.kanban-expanded')");
    assert.equal(await evaluate("document.querySelector('.lane-cards').scrollTop"), scroll);
    assert(await evaluate("document.activeElement===document.querySelector('.lane-expand') && !document.querySelector('.kanban-board').inert"));
    assert(await evaluate("getComputedStyle(document.querySelector('[data-lane-key=INTERESTED]')).visibility==='visible' && !document.querySelector('.has-expanded-lane')"));
    // Reverse immediately, while the opening animation is still running.
    await evaluate("document.querySelector('.lane-expand').click();document.querySelector('[data-collapse-lane]').click()");
    await wait("!document.querySelector('.kanban-expanded')");
    for (const key of ['EARLY_SELECTION', 'INTERVIEWING', 'OFFER']) {
      await evaluate(`document.querySelector('[data-lane-key="${key}"] .lane-expand').click()`);
      assert.equal(await evaluate("document.querySelectorAll('.kanban-expanded .company-card').length"), key === 'OFFER' ? 0 : 1);
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("!document.querySelector('.kanban-expanded')");
    }
    await browser.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const [width, height] of [[390, 844], [360, 480], [640, 410]]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate("document.querySelector('.lane-expand').click()");
      assert(await evaluate("(()=>{const e=document.querySelector('.kanban-expanded'),r=e.getBoundingClientRect(),list=e.querySelector('.expanded-cards');return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth&&r.left>=0&&list.clientHeight>0&&list.scrollWidth<=list.clientWidth&&e.getAnimations().length===0})()"));
      await evaluate("document.querySelector('[data-collapse-lane]').click()");
      assert(await evaluate("!document.querySelector('.kanban-expanded')"));
    }
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('.lane-expand').click();document.querySelector('.kanban-expanded [data-move-status=\"APPLIED\"]').click()");
    await wait("document.querySelectorAll('.kanban-expanded .company-card').length===11");
    assert(await evaluate("!document.querySelector('.modal-dialog')"), 'Status button must not also open details');
    assert(await evaluate("document.querySelector('.view-tab.is-active').dataset.view==='kanban'"));
    await evaluate("document.querySelector('[data-collapse-lane]').click();document.querySelector('.lane-expand').click();document.querySelector('[data-view=\"table\"]').click()");
    assert(await evaluate("!document.querySelector('.kanban-expanded') && !document.querySelector('[inert]')"));
    console.log('PASS: expansion/return, 12 filtered cards, early/final/empty lanes, scroll/focus restoration, interrupted animation, detail modal, status move, view switch, reduced motion, 3 narrow viewports.');
  } finally {
    await browser?.close();
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
