#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppServer}=require('../src/backend/server.cjs');
const {launchPage}=require('./browser.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'jt-dashboard-scroll-'));
 const app=createAppServer({dataDir:dir,allowDevBrowserSession:true,safeStorage:{isEncryptionAvailable:()=>false}});
 const out=path.join(root,'dist/screenshots');fs.mkdirSync(out,{recursive:true});const reports=[];
 try{
  app.profileStore.saveProfile({version:1,completed:true,major:'',industries:'',roles:'',priorities:'',strengths:''});
  for(let i=0;i<14;i++){
   const company=app.dbStore.createCompany({name:i===13?'架空の最終面接予定がある企業株式会社':'架空の企業'+(i+1),status:i<10?'INTERESTED':i<13?'APPLIED':'FINAL',isEarlySelection:i>=10&&i<13,industry:'架空の業種',location:'架空の拠点・全国各地／検証用の所在地',priority:3});
   if(i===13)app.dbStore.createEvent({companyId:company.id,title:'最終面接（架空の予定）',eventType:'INTERVIEW',startAt:new Date(Date.now()+86400000).toISOString()});
  }
  const {bootstrapUrl}=await app.start(0);
  for(const [width,height] of [[1440,756],[1280,820],[1101,640],[1024,700],[768,900],[390,844],[360,740],[640,410]]){
   const b=await launchPage(bootstrapUrl,{width,height});
   try{
    for(let i=0;i<100&&!await b.evaluate("document.querySelectorAll('.company-card').length===14");i++)await new Promise(r=>setTimeout(r,40));
    await b.evaluate("document.documentElement.classList.add('native-macos');window.scrollTo(0,0)");await new Promise(r=>setTimeout(r,80));
    const data=await b.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}};const header=document.querySelector('.app-header'),metrics=document.querySelector('#metrics-section'),board=document.querySelector('.kanban-board');const lanes=[...document.querySelectorAll('.kanban-lane')];const first=lanes[0],list=first.querySelector('.lane-cards'),cards=[...list.querySelectorAll('.company-card')];const minCardHeight=Math.min(...cards.map(c=>c.getBoundingClientRect().height));const headerBefore=rect(first.querySelector('.lane-header'));list.scrollTop=list.scrollHeight;const headerAfter=rect(first.querySelector('.lane-header'));const last=rect(cards.at(-1)),listRect=rect(list);const finalLane=rect(lanes.at(-1));const view=document.querySelector('#view-container');const columnCount=getComputedStyle(board).gridTemplateColumns.split(' ').length;const rowCount=new Set(lanes.map(l=>Math.round(rect(l).top))).size;return{width:innerWidth,height:innerHeight,header:rect(header),metrics:rect(metrics),board:rect(board),view:rect(view),columnCount,rowCount,noHorizontalScroll:board.scrollWidth<=board.clientWidth+1,pageHeight:document.documentElement.scrollHeight,pageScrollY:scrollY,listClientHeight:list.clientHeight,listScrollHeight:list.scrollHeight,listScrollTop:list.scrollTop,minCardHeight,lastCardVisible:last.bottom<=listRect.bottom+1&&last.bottom>listRect.top,headingUnmoved:Math.abs(headerBefore.top-headerAfter.top)<1,otherLaneScrollTop:lanes[1].querySelector('.lane-cards').scrollTop,lastLaneVisible:finalLane.left>=rect(board).left-1&&finalLane.right<=rect(board).right+1};})()`);
    if(data.columnCount!==(width>1100?4:width>720?2:1)||data.rowCount!==8/data.columnCount||!data.noHorizontalScroll)throw Error('Expected responsive 4x2 board without horizontal scrolling: '+JSON.stringify(data));
    if(data.metrics.top<data.header.bottom-1||data.listScrollHeight<=data.listClientHeight||data.listScrollTop<=0||data.minCardHeight<70||!data.lastCardVisible||!data.headingUnmoved||data.otherLaneScrollTop!==0||!data.lastLaneVisible)throw Error('Column scroll regression: '+JSON.stringify(data));
    if(width>=1101&&height>=640&&(data.pageHeight>height+1||data.pageScrollY!==0||data.view.bottom>height+1))throw Error('Dashboard clipping: '+JSON.stringify(data));
    reports.push(data);
    await b.evaluate("document.querySelector('.kanban-board').scrollLeft=0;document.querySelector('.lane-cards').scrollTop=0");
    if(width>=1101&&height>=640){
     const point=await b.evaluate("(()=>{const r=document.querySelector('.lane-cards').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+Math.min(40,r.height/2)}})()");
     await b.call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:200,deltaX:0});await new Promise(r=>setTimeout(r,150));
     if(!await b.evaluate("document.querySelector('.lane-cards').scrollTop>0 && scrollY===0 && document.getElementById('view-container').scrollTop===0"))throw Error('Wheel scrolling did not stay inside the column');
     await b.evaluate("document.querySelector('.lane-cards').scrollTop=0");data.wheelScrollStayedInColumn=true;
    }
    if(width===1440||width===1280){const {data:png}=await b.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,`dashboard-scroll-${width}x${height}.png`),Buffer.from(png,'base64'));}
   }finally{await b.close()}
  }
  fs.writeFileSync(path.join(out,'dashboard-scroll-report.json'),JSON.stringify(reports,null,2)+'\n');
  if(process.argv.includes('--native')){
   await app.stop();
   const run=require('node:util').promisify(require('node:child_process').execFile),native=[];
   for(const [width,height] of [[1440,756],[1280,820]]){
    const {stdout}=await run(path.join(root,'dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost'),['--smoke-test','--size',`${width}x${height}`,'--snapshot',path.join(out,`dashboard-native-${width}x${height}.png`)],{env:{...process.env,JOB_TRACKER_DATA_DIR:dir},timeout:20000});
    native.push(JSON.parse(stdout.trim().split('SMOKE_TEST_OK:')[1]));
   }
   fs.writeFileSync(path.join(out,'dashboard-native-report.json'),JSON.stringify(native,null,2)+'\n');
  }
  console.log('Dashboard and independent column scrolling passed: '+reports.length+' viewport conditions');
 }finally{await app.stop();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
