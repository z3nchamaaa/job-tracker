'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { artifactName } = require('../src/backend/artifact-names.cjs');
const { expectedPackageName } = require('../src/backend/updater.cjs');
const { writeManifest } = require('../scripts/release-manifest.cjs');
const { checkCandidate } = require('../scripts/release-check.cjs');
const { parseOptions } = require('../scripts/sign-macos.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'jt-release-'));
  t.after(() => fs.rmSync(dir, { recursive:true,force:true }));
  for (const ext of ['zip','dmg']) fs.writeFileSync(path.join(dir,artifactName('2.0.0','darwin','arm64',ext)), 'synthetic package');
  const sbom = { bomFormat:'CycloneDX',specVersion:'1.5',metadata:{component:{version:'2.0.0'}},components:[{name:'@github/copilot-sdk-darwin-arm64',version:'1.0.23'}] };
  const node = require('../scripts/node-runtime.cjs').getNodeSpec('darwin', 'arm64');
  sbom.components.push({ name: 'Node.js', version: node.version,
    hashes: [{ alg: 'SHA-256', content: node.binarySha256 }],
    properties: [{ name: 'job-tracker:bundled-target', value: 'darwin-arm64' },
      { name: 'job-tracker:archive-sha256', value: node.archiveSha256 }] });
  const save = () => { fs.writeFileSync(path.join(dir,artifactName('2.0.0','darwin','arm64','cdx.json')),JSON.stringify(sbom)); writeManifest(dir); };
  save(); return {dir,sbom,save};
}
test('release assets use exactly the package names the updater requests', () => {
  for (const [platform,arch,format] of [['darwin','arm64','dmg'],['win32','x64','exe'],['win32','arm64','exe'],['linux','x64','deb'],['linux','x64','rpm']]) {
    assert.equal(artifactName('2.0.0',platform,arch,format), expectedPackageName('2.0.0',platform,arch,format));
  }
  assert.equal(artifactName('v2.0.0','linux','x64','rpm'),'job-tracker-2.0.0-linux-x86_64.rpm');
  assert.throws(() => artifactName('../2.0.0','darwin','arm64','zip'));
  assert.throws(() => artifactName('2.0.0','linux','arm64','rpm'));
});
test('candidate accepts correct checksums and refuses tampering', (t) => {
  const {dir} = fixture(t);
  assert.ok(checkCandidate(dir,{version:'2.0.0'}).every(c=>c.passed));
  fs.appendFileSync(path.join(dir,artifactName('2.0.0','darwin','arm64','zip')),'tampered');
  assert.equal(checkCandidate(dir,{version:'2.0.0'})[0].passed,false);
});
test('manifest rejects duplicate and traversing paths', (t) => {
  const {dir} = fixture(t), file = path.join(dir,'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.assets.push(manifest.assets[0]); fs.writeFileSync(file,JSON.stringify(manifest));
  assert.equal(checkCandidate(dir,{version:'2.0.0'})[0].passed,false);
  manifest.assets[0].name='../outside.zip'; fs.writeFileSync(file,JSON.stringify(manifest));
  assert.equal(checkCandidate(dir,{version:'2.0.0'})[0].passed,false);
});
test('missing target native runtime or stale SBOM prevents release readiness', (t) => {
  const {dir,sbom,save}=fixture(t);
  sbom.components[0].name='@github/copilot-sdk-win32-x64'; save();
  assert.equal(checkCandidate(dir,{version:'2.0.0'}).find(c=>c.name==='target Copilot runtime').passed,false);
  sbom.metadata.component.version='1.0.0'; save();
  assert.equal(checkCandidate(dir,{version:'2.0.0'}).find(c=>c.name==='platform SBOM').passed,false);
});
test('signing is dry-run by default and requires explicit matching identity to execute', () => {
  assert.deepEqual(parseOptions([]),{execute:false});
  assert.throws(()=>parseOptions(['--execute']));
  assert.throws(()=>parseOptions(['--identity','Developer ID Application: Example (AAAAAAAAAA)','--team-id','BBBBBBBBBB','--keychain-profile','example','--execute']));
  const options=parseOptions(['--identity','Developer ID Application: Example (AAAAAAAAAA)','--team-id','AAAAAAAAAA','--keychain-profile','example','--execute']);
  assert.equal(options.execute,true);
  assert.throws(()=>parseOptions(['--unknown']));
});
test('missing, wrong-CPU or unpinned bundled Node prevents release readiness', (t) => {
  const { dir, sbom, save } = fixture(t);
  const node = sbom.components[1];
  node.version = '26.12.0'; save();
  assert.equal(checkCandidate(dir, { version: '2.0.0' }).find(c => c.name === 'bundled Node runtime').passed, false);
  node.version = '26.12.1'; node.properties[0].value = 'win32-x64'; save();
  assert.equal(checkCandidate(dir, { version: '2.0.0' }).find(c => c.name === 'bundled Node runtime').passed, false);
  sbom.components.pop(); save();
  assert.equal(checkCandidate(dir, { version: '2.0.0' }).find(c => c.name === 'bundled Node runtime').passed, false);
});
