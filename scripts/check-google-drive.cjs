'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');
const { SCOPE } = require('../src/backend/google-drive.cjs');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-drive-ui-')); let browser, uploaded = null, metadata = null, network = 0, authCalls = 0, deleted = false, uploads = 0;
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]); },
    decryptString(value) { const c=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(-16));return Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString(); } };
  const defaultClient = process.argv.includes('--without-default') ? null : { clientId: '987654321-bundled.apps.googleusercontent.com', clientSecret: 'synthetic-bundled-secret' };
  const app = createAppServer({ dataDir: directory, allowDevBrowserSession: true, safeStorage, driveDefaultClient: defaultClient, driveLimits: { uploadIntervalMs: 0 },
    openExternal: async (raw) => {
      const url=new URL(raw);assert.equal(url.origin,'https://accounts.google.com');authCalls++;
      const redirect=new URL(url.searchParams.get('redirect_uri'));redirect.searchParams.set('state',url.searchParams.get('state'));redirect.searchParams.set('code','4/synthetic-ui-code');
      const res=await fetch(redirect);await res.text();
    },
    driveFetch: async (url, options) => {
      network++;
      if (url==='https://oauth2.googleapis.com/token') return Response.json({access_token:'ya29.synthetic-ui',refresh_token:'1//synthetic-ui-refresh',token_type:'Bearer',expires_in:3600,scope:SCOPE});
      if (url==='https://oauth2.googleapis.com/revoke') return new Response('');
      if (url.includes('/upload/')) {
        const text=options.body.toString(), boundary=options.headers['Content-Type'].split('boundary=')[1];
        const parts=text.split('--'+boundary);metadata=JSON.parse(parts[1].split('\r\n\r\n')[1].trim());uploaded=parts[2].split('\r\n\r\n')[1].replace(/\r\n$/,'');
        assert(!uploaded.includes('synthetic-ui-refresh'));uploads++;return Response.json({id:'synthetic-file'});
      }
      if (options?.method==='DELETE') { assert(url.endsWith('/synthetic-file')); deleted=true; return new Response(null,{status:204}); }
      if (url.includes('alt=media')) return new Response(uploaded);
      if (url.includes('/synthetic-file?')) return Response.json({...metadata,size:String(Buffer.byteLength(uploaded))});
      return Response.json({files:uploaded&&!deleted?[{id:'synthetic-file',name:metadata.name,size:String(Buffer.byteLength(uploaded)),createdTime:new Date().toISOString()}]:[]});
    } });
  try {
    app.profileStore.saveProfile({version:1,completed:true});
    browser=await launchPage((await app.start(0)).bootstrapUrl);
    const evaluate=(s)=>browser.evaluate(s), click=(id)=>evaluate(`document.getElementById('${id}').click()`);
    const wait=async(s)=>{for(let i=0;i<200;i++){if(await evaluate(s))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timed out: '+s);};
    const complete = (text, control = 'drive-connect') => wait(`document.getElementById('drive-message').textContent.includes(${JSON.stringify(text)}) && !document.getElementById(${JSON.stringify(control)}).disabled`);
    await wait("Boolean(document.querySelector('[data-empty-add=prompt]'))");
    await evaluate("window.driveErrors=[];window.addEventListener('unhandledrejection',e=>window.driveErrors.push(String(e.reason)))");
    const closeModal = (id) => evaluate("document.querySelector('[data-modal-close]').click()").then(() => wait(`!document.getElementById(${JSON.stringify(id)})`));
    const openSettings = async () => { await click('btn-app-settings'); await wait("Boolean(document.getElementById('app-settings-form')) && Boolean(document.getElementById('drive-connect'))"); };
    const openDataQuick = async (ready) => { await click('btn-data-manage'); await wait(`Boolean(document.getElementById('drive-quick-upload')) && document.getElementById('drive-quick-status').textContent.includes(${JSON.stringify(ready)})`); };
    // Data management offers save + restore-latest only; connecting and the full list live in app settings, with no link button.
    await openDataQuick(defaultClient ? '接続していません' : '利用できません');
    assert.equal(await evaluate("Boolean(document.getElementById('btn-open-drive-settings')) || Boolean(document.getElementById('drive-connect'))"),false);
    assert(await evaluate("document.getElementById('drive-quick-upload').disabled && document.getElementById('drive-quick-latest').disabled"));
    await closeModal('drive-quick-upload');
    await openSettings();
    assert.equal(network,0);assert.equal(authCalls,0);
    assert.equal(await evaluate("Boolean(document.getElementById('drive-client-id')) || Boolean(document.getElementById('drive-config-form'))"),false);
    assert.equal(await evaluate("document.getElementById('drive-connect').disabled"), !defaultClient);
    if (!defaultClient) {
      await wait("document.getElementById('drive-status').textContent.includes('利用できません')");
      assert(await evaluate("document.getElementById('drive-prune').disabled && document.getElementById('drive-retention-count').disabled"));
      assert.equal(network,0);assert.deepEqual(await evaluate('window.driveErrors'),[]);
      console.log('PASS: build without embedded client shows Drive as unavailable in settings and data management and sends nothing.');
      return;
    }
    await click('drive-connect');await wait("!document.getElementById('drive-upload').disabled");assert.equal(authCalls,1);
    await evaluate('window.confirm=()=>false');await click('drive-upload');await wait("!document.getElementById('drive-upload').disabled");assert.equal(uploaded,null);
    await evaluate('window.confirm=()=>true');await click('drive-upload');await complete('保存しました', 'drive-list');assert(uploaded);
    await click('drive-list');await complete('一覧を取得しました', 'drive-list');assert(await evaluate("Boolean(document.querySelector('[data-drive-preview]'))"));
    const before=JSON.stringify(app.dbStore.exportBackup(app.profileStore.getProfile()).data);
    await evaluate("document.querySelector('[data-drive-preview]').click()");await complete('プレビューしました', 'drive-list');assert(await evaluate("Boolean(document.getElementById('drive-restore'))"));assert.equal(JSON.stringify(app.dbStore.exportBackup(app.profileStore.getProfile()).data),before);
    await click('drive-restore');await complete('復元しました', 'drive-list');assert.equal(app.dbStore.getStatus().hasPreImportSnapshot,true);
    // Retention settings save immediately and do not mark the settings form dirty.
    await evaluate("const s=document.getElementById('drive-retention-count');s.value='5';s.dispatchEvent(new Event('change',{bubbles:true}))");await complete('最新5件', 'drive-list');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'auth','google-drive-state.json'),'utf8')).retentionCount,5);
    // Data management: save now and restore the newest backup with a preview first.
    await evaluate('window.confirm=()=>true');await closeModal('app-settings-form');
    await openDataQuick('接続済み');
    const quick = (text) => wait(`document.getElementById('drive-quick-message').textContent.includes(${JSON.stringify(text)}) && !document.getElementById('drive-quick-upload').disabled`);
    await evaluate('window.confirm=()=>false');await click('drive-quick-upload');await quick('中止しました');assert.equal(uploads,1);
    await evaluate('window.confirm=()=>true');await click('drive-quick-upload');await quick('保存しました');assert.equal(uploads,2);
    const beforeQuick=JSON.stringify(app.dbStore.exportBackup(app.profileStore.getProfile()).data);
    await click('drive-quick-latest');await quick('最新のバックアップをプレビュー');
    assert.equal(JSON.stringify(app.dbStore.exportBackup(app.profileStore.getProfile()).data),beforeQuick);
    await evaluate("document.querySelector('#drive-quick-preview [data-drive-restore-mode]').value='replace'");
    await evaluate("document.querySelector('#drive-quick-preview [data-drive-restore]').click()");await quick('復元しました');
    assert.equal(await evaluate("document.getElementById('btn-rollback-import').disabled"),false);
    assert.equal(await evaluate("Boolean(document.querySelector('#drive-quick-preview [data-drive-restore]'))"),false);
    await closeModal('drive-quick-upload');
    await openSettings();await click('drive-list');await complete('一覧を取得しました', 'drive-list');
    for (const [width,height] of [[360,480],[390,844],[768,700]]) {
      await browser.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      assert(await evaluate("(()=>{const r=document.querySelector('.modal-dialog').getBoundingClientRect(),b=document.querySelector('.modal-body');return r.left>=0&&r.right<=innerWidth+1&&b.scrollWidth<=b.clientWidth+1})()"));
    }
    const out=path.resolve(__dirname,'../dist/screenshots');fs.mkdirSync(out,{recursive:true});
    await evaluate("document.getElementById('google-drive-panel').scrollIntoView()");
    fs.writeFileSync(path.join(out,'google-drive-backup.png'),Buffer.from((await browser.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('window.confirm=()=>false');await evaluate("document.querySelector('[data-drive-delete]').click()");await complete('', 'drive-list');assert.equal(deleted,false);
    await evaluate('window.confirm=()=>true');await evaluate("document.querySelector('[data-drive-delete]').click()");await complete('削除しました', 'drive-list');assert.equal(deleted,true);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-drive-delete]'))"),false);
    await click('drive-prune');await complete('削除対象はありません', 'drive-list');
    await click('drive-disconnect');await complete('解除しました');assert(await evaluate("document.getElementById('drive-upload').disabled"));
    assert.equal(await evaluate("document.getElementById('drive-connect').disabled"), false);
    assert.deepEqual(await evaluate('window.driveErrors'),[]);
    console.log('PASS: Drive lives in app settings; data management can save and restore the newest backup (preview first) and has no settings link button; no automatic network; embedded client mock OAuth/PKCE; cancelled upload sends nothing; upload/list/preview/restore/delete/prune/retention/disconnect; three narrow sizes. No real Google account or cloud writes.');
  } finally { await browser?.close();await app.stop();fs.rmSync(directory,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
