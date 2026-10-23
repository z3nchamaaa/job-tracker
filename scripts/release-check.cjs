'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { artifactName } = require('../src/backend/artifact-names.cjs');
const root = path.resolve(__dirname, '..');
function checkCandidate(directory, { version, platform = 'darwin', arch = 'arm64', candidate = true } = {}) {
  const dir = path.resolve(directory), checks = [];
  const check = (name, fn) => { try { const detail = fn(); checks.push({ name, passed: true, detail }); } catch (error) { checks.push({ name, passed: false, detail: error.message }); } };
  let manifest, bom;
  check('manifest integrity', () => {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'release-manifest.json')));
    if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('No release assets');
    const seen = new Set();
    for (const asset of manifest.assets) {
      if (typeof asset.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(asset.name) || asset.name.includes('..') || seen.has(asset.name)) throw new Error('Invalid or duplicate manifest asset');
      seen.add(asset.name);
      const file = path.join(dir, asset.name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid asset: ' + asset.name);
      if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== asset.sha256) throw new Error('SHA-256 mismatch: ' + asset.name);
    }
    return `${seen.size} asset hashes match`;
  });
  check('updater-compatible filenames', () => {
    const formats = platform === 'darwin' ? ['dmg','zip'] : platform === 'win32' ? candidate ? ['zip'] : ['zip','exe'] : ['deb','rpm'];
    for (const format of formats) {
      const name = artifactName(version, platform, arch, format);
      if (!manifest?.assets?.some((a) => a.name === name)) throw new Error('Missing ' + name);
    }
    return 'Package names match the updater';
  });
  check('platform SBOM', () => {
    const name = artifactName(version, platform, arch, 'cdx.json');
    if (!manifest?.assets?.some((a) => a.name === name)) throw new Error('SBOM is not included in the checksum manifest');
    bom = JSON.parse(fs.readFileSync(path.join(dir, name)));
    if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5' || bom.metadata?.component?.version !== version || !Array.isArray(bom.components)) throw new Error('Invalid or stale CycloneDX SBOM');
    return `${bom.components.length} npm/runtime components; native internals and OS runtimes need separate review`;
  });
  check('optional Copilot pack', () => {
    if (!bom?.metadata?.properties?.some((p) => p.name === 'job-tracker:copilot-mode' && p.value === 'optional')) throw new Error('Copilot optional-pack policy is missing');
    if (bom.components.some((c) => c.name.startsWith('@github/copilot-sdk') || ['koffi', 'zod', 'vscode-jsonrpc'].includes(c.name))) throw new Error('Copilot dependencies must not be in the base application');
    return 'Copilot is an explicit optional download; Node remains bundled';
  });
  check('bundled Node runtime', () => {
    const spec = require('./node-runtime.cjs').getNodeSpec(platform, arch);
    const node = bom?.components?.find((c) => c.name === 'Node.js');
    if (node?.version !== spec.version || !node.hashes?.some((h) => h.alg === 'SHA-256' && h.content === spec.binarySha256) ||
        !node.properties?.some((p) => p.name === 'job-tracker:bundled-target' && p.value === platform + '-' + arch) ||
        !node.properties?.some((p) => p.name === 'job-tracker:archive-sha256' && p.value === spec.archiveSha256)) throw new Error('Pinned bundled Node is missing or differs from the target lock');
    return 'Node.js ' + spec.version + '; separate Node installation is not required';
  });
  return checks;
}
function run(argv = process.argv.slice(2)) {
  const candidate = argv.includes('--candidate');
  const directory = argv.find((arg) => !arg.startsWith('--')) || 'dist/mac-arm64';
  if (argv.some((arg) => arg.startsWith('--') && arg !== '--candidate')) throw new Error('Only --candidate and an output directory are accepted');
  const dir = path.resolve(root, directory);
  if (!dir.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Check a distribution inside dist');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  const policy = JSON.parse(fs.readFileSync(path.join(root, '.github/release-policy.json')));
  const folder = path.basename(dir);
  const platform = folder.includes('win-') ? 'win32' : folder.includes('linux-') ? 'linux' : 'darwin';
  const arch = folder.endsWith('x64') ? 'x64' : 'arm64';
  const checks = checkCandidate(dir, { version, platform, arch, candidate });
  const confirmations = Object.entries(policy.operatorConfirmations || {}).map(([name, value]) => ({ name, confirmedByOperator: value === true }));
  let clean = false;
  try { clean = !execFileSync('git', ['status','--porcelain'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
  let developerIdVerified = false, notarizationVerified = false;
  if (process.platform === 'darwin' && /^[A-Z0-9]{10}$/.test(policy.macTeamId || '')) {
    const { spawnSync } = require('node:child_process');
    const app = path.join(dir, '就活トラッカー.app');
    const verified = spawnSync('codesign', ['--verify','--deep','--strict',app], { encoding:'utf8' });
    const details = spawnSync('codesign', ['-d','--verbose=4',app], { encoding:'utf8' });
    developerIdVerified = platform === 'darwin' && verified.status === 0 && details.status === 0 && details.stderr.includes(`TeamIdentifier=${policy.macTeamId}`) && details.stderr.includes('Authority=Developer ID Application:') && /flags=.*runtime/.test(details.stderr);
    if (developerIdVerified) notarizationVerified = spawnSync('xcrun', ['stapler','validate',path.join(dir,artifactName(version,'darwin','arm64','dmg'))], { stdio:'pipe' }).status === 0;
  }
  const technicalPassed = checks.every((c) => c.passed);
  const ready = technicalPassed && clean && developerIdVerified && notarizationVerified && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository || '') && confirmations.length > 0 && confirmations.every((c) => c.confirmedByOperator);
  const report = { checkedAt: new Date().toISOString(), candidateOnly: candidate, technicalPassed, readyForPublicRelease: ready, checks,
    sourceTreeClean: clean, developerIdVerified, notarizationVerified, repositoryConfigured: Boolean(policy.repository), operatorConfirmations: confirmations,
    notice: 'Operator confirmations are manual attestations, not verification of GitHub settings. Candidate success does not authorize publishing or prove production readiness.' };
  fs.mkdirSync(path.join(root,'dist/verification'), { recursive:true });
  fs.writeFileSync(path.join(root,'dist/verification/release-readiness.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  return candidate ? technicalPassed : ready;
}
if (require.main === module) { try { if (!run()) process.exitCode=1; } catch(error) { console.error(error.message); process.exitCode=1; } }
module.exports = { checkCandidate, run };
