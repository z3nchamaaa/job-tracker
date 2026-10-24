'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { createAppServer } = require('../src/backend/server.cjs');
const { launchPage } = require('./browser.cjs');
const { SCOPE } = require('../src/backend/google-drive.cjs');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-drive-ui-')); let browser, uploaded = null, metadata = null, network = 0, authCalls = 0;
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]); },
    decryptString(value) { const c=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(-16));return Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString(); } };
  const defaultClient = process.argv.includes('--without-default') ? null : { clientId: '987654321-bundled.apps.googleusercontent.com', clientSecret: 'synthetic-bundled-secret' };
  const app = createAppServer({ dataDir: directory, allowDevBrowserSession: true, safeStorage, driveDefaultClient: defaultClient,
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
        assert(!uploaded.includes('synthetic-ui-refresh'));return Response.json({id:'synthetic-file'});
      }
      if (url.includes('alt=media')) return new Response(uploaded);
      if (url.includes('/synthetic-file?')) return Response.json({...metadata,size:String(Buffer.byteLength(uploaded))});
      return Response.json({files:uploaded?[{id:'synthetic-file',name:metadata.name,size:String(Buffer.byteLength(uploaded)),createdTime:new Date().toISOString()}]:[]});
    } });
  try {
    app.profileStore.saveProfile({version:1,completed:true});
    browser=await launchPage((await app.start(0)).bootstrapUrl);
    const evaluate=(s)=>browser.evaluate(s), click=(id)=>evaluate(`document.getElementById('${id}').click()`);
    const wait=async(s)=>{for(let i=0;i<200;i++){if(await evaluate(s))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timed out: '+s);};
    const complete = (text, control = 'drive-connect') => wait(`document.getElementById('drive-message').textContent.includes(${JSON.stringify(text)}) && !document.getElementById(${JSON.stringify(control)}).disabled`);
    await wait("Boolean(document.querySelector('[data-empty-add=prompt]'))");await click('btn-data-manage');await wait("Boolean(document.getElementById('drive-config-form'))");
    assert.equal(network,0);assert.equal(authCalls,0);
    await wait("Boolean(document.getElementById('drive-connect'))");
    assert.equal(await evaluate("document.querySelector('.drive-config').open"), false);
    assert.equal(await evaluate("document.getElementById('drive-connect').disabled"), !defaultClient);
    if (defaultClient) {
      await click('drive-connect'); await wait("!document.getElementById('drive-upload').disabled");
      await evaluate('window.confirm=()=>true'); await click('drive-forget');
      await complete('解除しました');
      assert.equal(await evaluate("document.getElementById('drive-connect').disabled"), false);
    }
    const beforeCustomSetup = network;
    await evaluate("window.driveErrors=[];window.addEventListener('unhandledrejection',e=>window.driveErrors.push(String(e.reason)));window.confirm=()=>true;document.querySelector('.drive-config').open=true;document.getElementById('drive-client-id').value='123456789-synthetic.apps.googleusercontent.com';document.getElementById('drive-client-secret').value='synthetic-ui-secret';document.getElementById('drive-config-form').requestSubmit()");
    await complete('設定を保存しました');assert.equal(network,beforeCustomSetup);
    assert.equal(await evaluate("document.getElementById('drive-client-secret').value"),'');
    await click('drive-connect');await wait("!document.getElementById('drive-upload').disabled");
    await evaluate('window.confirm=()=>false');await click('drive-upload');await wait("!document.getElementById('drive-upload').disabled");assert.equal(uploaded,null);
    await evaluate('window.confirm=()=>true');await click('drive-upload');await complete('保存しました', 'drive-list');assert(uploaded);
    await click('drive-list');await complete('一覧を取得しました', 'drive-list');assert(await evaluate("Boolean(document.querySelector('[data-drive-preview]'))"));
    const before=JSON.stringify(app.dbStore.exportBackup(app.profileStore.getProfile()).data);
    await evaluate("document.querySelector('[data-drive-preview]').click()");await complete('プレビューしました', 'drive-list');assert(await evaluate("Boolean(document.getElementById('drive-restore'))"));assert.equal(JSON.stringify(app.dbStore.exportBackup(app.profileStore.getProfile()).data),before);
    await click('drive-restore');await complete('復元しました', 'drive-list');assert.equal(app.dbStore.getStatus().hasPreImportSnapshot,true);
    await click('btn-rollback-import');await wait("document.getElementById('btn-rollback-import').disabled");
    for (const [width,height] of [[360,480],[390,844],[768,700]]) {
      await browser.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      assert(await evaluate("(()=>{const r=document.querySelector('.modal-dialog').getBoundingClientRect(),b=document.querySelector('.modal-body');return r.left>=0&&r.right<=innerWidth+1&&b.scrollWidth<=b.clientWidth+1})()"));
    }
    const out=path.resolve(__dirname,'../dist/screenshots');fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'google-drive-backup.png'),Buffer.from((await browser.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await click('drive-disconnect');await complete('解除しました');assert(await evaluate("document.getElementById('drive-upload').disabled"));
    if (defaultClient) {
      assert.equal(await evaluate("document.getElementById('drive-use-bundled').hidden"), false);
      await click('drive-use-bundled'); await complete('共通の接続設定に戻しました');
      assert.equal(await evaluate("document.getElementById('drive-use-bundled').hidden"), true);
      assert.equal(await evaluate("document.getElementById('drive-connect').disabled"), false);
    }
    assert.deepEqual(await evaluate('window.driveErrors'),[]);
    console.log('PASS: no automatic Drive network; local-only client setup; mock OAuth/PKCE; cancelled upload sends nothing; explicit upload/list/preview/restore/rollback/disconnect; three narrow sizes. No real Google account or cloud writes.');
  } finally { await browser?.close();await app.stop();fs.rmSync(directory,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
