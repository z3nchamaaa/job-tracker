'use strict';
// 共有モーダル: 3段階の選考状況テキスト、企業データの書き出しと取り込み、狭い画面での表示を確認する
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');

const shotDir = process.argv.includes('--screenshots') ? path.join(__dirname, '..', 'dist', 'verification', 'share') : null;

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-share-ui-'));
  const app = createAppServer({ dataDir: directory, allowDevBrowserSession: true });
  let browser;
  try {
    app.profileStore.saveProfile({ version: 1, completed: true });
    const db = app.dbStore;
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    soon.setHours(14, 0, 0, 0);
    const later = new Date(soon.getTime() + 3 * 24 * 60 * 60 * 1000);
    const aoba = db.createCompany({
      name: '架空のあおば商事', industry: '商社', status: 'INTERVIEWING', priority: 5, isEarlySelection: true,
      memo: '共有されてはいけないメモ', myPageId: 'secret-id', description: '総合商社の架空企業', annualIncome: 650,
      steps: [
        { stepName: 'ES', status: 'PASSED' },
        { stepName: '一次面接', status: 'PASSED' },
        { stepName: '二次面接', status: 'PENDING' },
      ],
    });
    db.createEvent({ companyId: aoba.id, title: '二次面接', eventType: 'INTERVIEW', startAt: soon.toISOString() });
    db.createEvent({ companyId: aoba.id, title: '社員座談会', eventType: 'BRIEFING', startAt: later.toISOString() });
    db.createCompany({ name: '架空のいろは銀行', industry: '金融', status: 'OFFER' });
    db.createCompany({ name: '架空のうみ電機', industry: 'メーカー', status: 'REJECTED' });
    db.createCompany({ name: '架空のえがお食品', status: 'INTERESTED' });
    db.createCompany({ name: '架空のおか製薬', status: 'APPLIED', steps: [{ stepName: 'ES', status: 'PENDING' }] });

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
    const screenshot = async (name) => {
      if (!shotDir) return;
      fs.mkdirSync(shotDir, { recursive: true });
      const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(data, 'base64'));
    };
    const previewText = () => evaluate("document.getElementById('share-status-text').value");
    const setLevel = (level) => evaluate(`(()=>{const r=document.querySelector('input[name=share-level][value=${level}]');r.checked=true;r.dispatchEvent(new Event('change'));})()`);

    await wait("document.querySelectorAll('.company-card').length >= 5");
    await click('#btn-share');
    await wait("Boolean(document.getElementById('share-status-text')) && document.getElementById('share-status-text').value.length > 0");

    await setLevel('simple');
    let text = await previewText();
    assert.match(text, /エントリー 4社（選考中 2社・内定 1社）/);
    assert.doesNotMatch(text, /架空の/);
    assert.equal(await evaluate("document.getElementById('share-anonymize-row').hidden"), true);
    await screenshot('1-simple');

    await setLevel('standard');
    text = await previewText();
    assert.match(text, /■ 内定（1社）\n  架空のいろは銀行/);
    await screenshot('2-standard');

    await setLevel('detailed');
    text = await previewText();
    assert.match(text, /架空のあおば商事（商社・早期選考）/);
    assert.match(text, /選考: ES✓ → 一次面接✓ → 二次面接/);
    assert.match(text, /次の予定: .* 面接/);
    for (const secret of ['共有されてはいけないメモ', 'secret-id', '総合商社', '650']) assert.ok(!text.includes(secret), secret);
    await screenshot('3-detailed');

    await evaluate("(()=>{const c=document.getElementById('share-anonymize');c.checked=true;c.dispatchEvent(new Event('change'));})()");
    text = await previewText();
    assert.doesNotMatch(text, /架空の/);
    assert.match(text, /企業A/);

    // 選んだ段階は次回も使う
    await click('[data-modal-close]');
    await wait("!document.getElementById('share-modal-title')");
    await click('#btn-share');
    await wait("Boolean(document.querySelector('input[name=share-level][value=detailed]:checked'))");

    // 企業データを渡す: 中身は共有モジュールと同じ処理で作られることを確認
    await click('[data-share-tab="export"]');
    await wait("!document.querySelector('[data-share-panel=export]').hidden");
    await evaluate(`document.querySelector('[data-share-company="${aoba.id}"]').click()`);
    assert.equal(await evaluate("document.getElementById('share-export-count').textContent"), '（1社を選択中）');
    await screenshot('4-export');
    const payload = JSON.stringify(require('../src/shared/share.cjs').buildCompanyShare([db.getCompany(aoba.id)]));
    assert.ok(!payload.includes('secret-id') && !payload.includes('共有されてはいけない'));
    assert.ok(!payload.includes('"二次面接","eventType":"INTERVIEW"'));

    // 企業データを受け取る: 同名は選択を外した状態で表示され、新しい企業だけ追加される
    const friend = JSON.parse(payload);
    friend.companies.push({ ...friend.companies[0], name: '架空のかもめ物流', industry: '物流' });
    await click('[data-share-tab="import"]');
    await evaluate(`(()=>{const t=document.getElementById('share-import-text');t.value=${JSON.stringify(JSON.stringify(friend))};t.dispatchEvent(new Event('input'));})()`);
    await click('#btn-share-preview-import');
    await wait("document.querySelectorAll('[data-share-import]').length === 2");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-share-import]')].map(c=>c.checked)"), [false, true]);
    await screenshot('5-import-preview');
    await click('#btn-share-exec-import');
    await wait("document.querySelectorAll('.company-card').length >= 6");
    const added = db.listCompanies().find((c) => c.name === '架空のかもめ物流');
    assert.equal(added.status, 'INTERESTED');
    assert.equal(added.memo, null);
    assert.deepEqual(added.steps.map((s) => s.status), ['PENDING', 'PENDING', 'PENDING']);
    assert.deepEqual(added.events.map((e) => e.eventType), ['BRIEFING']);
    assert.equal(db.listCompanies().filter((c) => c.name === '架空のあおば商事').length, 1);

    // 狭い画面でもはみ出さない
    await click('[data-share-tab="status"]');
    for (const [width, height] of [[360, 640], [1280, 820]]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      assert(await evaluate("(()=>{const d=document.querySelector('[role=dialog]'),r=d.getBoundingClientRect(),b=d.querySelector('.modal-body');return r.left>=0&&r.right<=innerWidth+1&&b.scrollWidth<=b.clientWidth+1})()"), `layout at ${width}`);
      await screenshot(`6-status-${width}`);
    }
    console.log('Share UI check passed');
  } finally {
    if (browser) await browser.close();
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
