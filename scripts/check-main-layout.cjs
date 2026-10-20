#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppServer}=require('../src/backend/server.cjs');
const {launchPage}=require('./browser.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'jt-main-layout-'));
 const app=createAppServer({dataDir:dir,allowDevBrowserSession:true,safeStorage:{isEncryptionAvailable:()=>false}});
 const label=process.argv[2]||'after';if(!['before','after'].includes(label))throw Error('Expected before or after');
 const results=[];const out=path.join(root,'dist/screenshots');fs.mkdirSync(out,{recursive:true});
 try{
  app.profileStore.saveProfile({version:1,completed:true,major:'',industries:'',roles:'',priorities:'',strengths:''});
  for(const [index,status] of require('../src/shared/constants.cjs').SELECTION_STATUSES.entries()){
   const company=app.dbStore.createCompany({name:'FictionalInternationalInfrastructure'+String(index)+'ResearchAndDevelopment'.repeat(3),status,industry:'SyntheticCloudInfrastructure'.repeat(4),location:'架空の所在地／'+ 'InternationalRemoteOffice'.repeat(4),priority:5,myPageUrl:'https://example.invalid/recruit'});
   app.dbStore.createEvent({companyId:company.id,title:'SyntheticInterviewAndRecruitingSession'.repeat(4),eventType:'INTERVIEW',startAt:new Date(Date.now()+86400000).toISOString()});
  }
  const {bootstrapUrl}=await app.start(0);
  for(const width of [360,768,1101,1280])for(const view of ['kanban','table','schedule','compensation']){
   const browser=await launchPage(bootstrapUrl+'&view='+view,{width,height:820});
   try{
    for(let i=0;i<100&&!await browser.evaluate("document.querySelectorAll('.metric-card').length===5");i++)await new Promise(r=>setTimeout(r,40));
    await browser.evaluate("document.documentElement.classList.add('native-macos');window.scrollTo(0,0)");
    await new Promise(r=>setTimeout(r,80));
    const metrics=await browser.evaluate(`(()=>{const items=[...document.querySelectorAll('.app-header,.metrics-grid,.metric-card,.kanban-board,.kanban-lane,.company-card,.card-top,.card-meta,.card-next-event,.panel,.table-scroll')];return {width:innerWidth,overflow:items.filter(e=>!e.matches('.table-scroll,.kanban-board') && e.scrollWidth>e.clientWidth+1).map(e=>({className:e.className,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth})),outside:items.filter(e=>{if(e.closest('.kanban-board') && !e.classList.contains('kanban-board')) return false;const r=e.getBoundingClientRect();return r.left < -1 || r.right>innerWidth+1}).map(e=>e.className)}})()`);
    results.push({view,...metrics});
    if(view==='kanban'&&(width===360||width===1280)){
     const {data}=await browser.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,`main-${label}-${view}-${width}.png`),Buffer.from(data,'base64'));
    }
   }finally{await browser.close()}
  }
  fs.writeFileSync(path.join(out,`main-${label}.json`),JSON.stringify(results,null,2)+'\n');
  if(process.argv.includes('--native')){
   await app.stop();
   const run=require('node:util').promisify(require('node:child_process').execFile);
   const native=[];
   for(const [width,height] of [[1280,820],[360,740]]){
    const {stdout}=await run(path.join(root,'dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost'),['--smoke-test','--size',`${width}x${height}`,'--snapshot',path.join(out,`main-native-${label}-${width}.png`)],{env:{...process.env,JOB_TRACKER_DATA_DIR:dir},timeout:20000});
    native.push(JSON.parse(stdout.trim().split('SMOKE_TEST_OK:')[1]));
   }
   fs.writeFileSync(path.join(out,`main-native-${label}.json`),JSON.stringify(native,null,2)+'\n');
  }
  const failures=results.filter(r=>r.overflow.length||r.outside.length);console.log(JSON.stringify(failures,null,2));
  if(label==='after'&&failures.length)throw Error('Main screen layout regression');
 }finally{await app.stop();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
