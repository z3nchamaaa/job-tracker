#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {DatabaseStore}=require('../src/backend/db.cjs');
(async()=>{
 if(process.platform!=='darwin')throw Error('macOS is required');
 const root=path.resolve(__dirname,'..');const reports=[];
 for(const scenario of ['clean-q','clean-w','dirty-cancel-q','dirty-discard-w']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jt-shortcuts-'));
  try{
   let db=new DatabaseStore({dataDir:dir});db.createCompany({name:'架空の保存済み企業',status:'APPLIED'});db.close();
   const {stdout}=await promisify(execFile)(path.join(root,'dist/mac-arm64/就活トラッカー.app/Contents/MacOS/JobTrackerHost'),['--smoke-test','--smoke-test-shortcuts',scenario],{env:{...process.env,JOB_TRACKER_DATA_DIR:dir},timeout:20000,maxBuffer:1024*1024});
   assert.match(stdout,/SHORTCUT_SELECT_ALL_OK/);assert.match(stdout,/SHORTCUT_MINIMIZE_OK/);
   if(scenario.startsWith('dirty'))assert.match(stdout,/SHORTCUT_DISCARD_CONFIRM_OK/);
   assert.match(stdout,scenario==='dirty-cancel-q'?/SHORTCUT_CANCEL_PRESERVES_INPUT_OK/:/SHORTCUT_TERMINATE_AND_BACKEND_STOP_OK/);
   db=new DatabaseStore({dataDir:dir});try{assert.equal(db.listCompanies().length,1);assert.equal(db.listCompanies()[0].name,'架空の保存済み企業')}finally{db.close()}
   reports.push({scenario,passed:true,output:stdout,savedDataPreserved:true});console.log(scenario+': passed');
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
 fs.mkdirSync(path.join(root,'dist/verification'),{recursive:true});fs.writeFileSync(path.join(root,'dist/verification/macos-shortcuts.json'),JSON.stringify({checkedAt:new Date().toISOString(),scenarios:reports,clipboardReadOrWritten:false},null,2)+'\n');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
