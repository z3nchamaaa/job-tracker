const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { createAppServer } = require(root + '/src/backend/server.cjs');
const { launchPage } = require(root + '/scripts/browser.cjs');
(async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jt-layout-'));
 const app=createAppServer({dataDir:dir,allowDevBrowserSession:true,safeStorage:{isEncryptionAvailable:()=>false}});
 const out=path.join(root,'dist/screenshots');fs.mkdirSync(out,{recursive:true});
 const results=[];const label=process.argv[2] || 'after'; if (!['before','after'].includes(label)) throw new Error('Expected before or after');
 try {
 app.profileStore.saveProfile({version:1,completed:true,major:'',industries:'',roles:'',priorities:'',strengths:''});
 app.dbStore.createCompany({name:'架空のとても長い企業名システムインテグレーション株式会社',status:'APPLIED',industry:'情報通信',location:'架空の所在地'});
 const {bootstrapUrl}=await app.start(0);
 for(const [modal,width,height] of [['data',360,480],['data',1280,820],['detail',360,480],['detail',768,480]]) {
  const b=await launchPage(bootstrapUrl+'&modal='+modal,{width,height});
  try {
   for(let i=0;i<100&&!await b.evaluate('!!document.querySelector("[role=dialog]")');i++) await new Promise(r=>setTimeout(r,50));
   await b.evaluate('document.documentElement.classList.add("native-macos")');
   await new Promise(r=>setTimeout(r,100));
   const metrics=await b.evaluate(`(()=>{const d=document.querySelector('[role=dialog]');const box=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}};return {dialog:box(d),header:box(d.querySelector('.modal-header')),body:box(d.querySelector('.modal-body')),footer:box(d.querySelector('.modal-footer')),controls:[...d.querySelectorAll('button,input,select')].filter(e=>e.getClientRects().length).map(e=>({id:e.id,text:e.textContent.slice(0,40),...box(e)}))}})()`);
   if (label === 'after' && (metrics.body.scrollWidth > metrics.body.clientWidth + 1 || metrics.body.height < 120 || metrics.dialog.top < 32 || metrics.footer.bottom > height)) throw new Error('Modal layout regression: ' + modal + ' ' + width);
   results.push({modal,width,height,...metrics});
   const image=await b.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,`layout-${label}-${modal}-${width}x${height}.png`),Buffer.from(image.data,'base64'));
  } finally {await b.close()}
 }
 fs.writeFileSync(path.join(out,`layout-${label}.json`),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results.map(r=>({modal:r.modal,width:r.width,bodyOverflow:r.body.scrollWidth>r.body.clientWidth,bodyHeight:r.body.height,headerHeight:r.header.height,footerBottom:r.footer.bottom,footerVisible:r.footer.bottom<=r.height})),null,2));
 } finally {await app.stop();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
