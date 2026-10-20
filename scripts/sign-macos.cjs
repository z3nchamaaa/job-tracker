'use strict';
// Signing/notarization is an explicit operator action. Without --execute this
// script only describes the work, and never inspects keys or contacts Apple.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { artifactName } = require('../src/backend/artifact-names.cjs');
const { checkCandidate } = require('./release-check.cjs');
const { writeManifest } = require('./release-manifest.cjs');
const root = path.resolve(__dirname, '..');
function parseOptions(argv) {
  const result = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') { result.execute = true; continue; }
    const key = { '--identity': 'identity', '--team-id': 'teamId', '--keychain-profile': 'profile' }[arg];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--') || result[key]) throw new Error('Invalid signing arguments');
    result[key] = argv[++i];
  }
  if (result.execute && (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(result.identity || '') || !/^[A-Z0-9]{10}$/.test(result.teamId || '') || !result.identity.endsWith(`(${result.teamId})`) || !/^[A-Za-z0-9_.-]{1,100}$/.test(result.profile || ''))) throw new Error('Execution requires an explicit Developer ID identity, matching Team ID and existing notarytool keychain profile');
  return result;
}
function run(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (!options.execute) {
    console.log(JSON.stringify({ execute: false, source: 'dist/mac-arm64', output: 'dist/signed-mac-arm64', steps: ['Validate candidate checksums and platform SBOM', 'Copy candidate; sign nested Mach-O code inside out with hardened runtime and secure timestamp', 'Sign app; submit ZIP to Apple notarytool using explicit keychain profile', 'Require Accepted; staple app; create final ZIP and DMG', 'Sign/notarize/staple DMG; regenerate SHA-256 manifest'], required: ['Developer ID Application identity', 'matching Team ID', 'preconfigured notarytool keychain profile'], note: 'No credential lookup, signing, upload or publication was performed. Actual notarized execution requires validation with your certificate.' }, null, 2));
    return;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Run signing on macOS arm64');
  const version = require('../package.json').version;
  const source = path.join(root, 'dist/mac-arm64'), output = path.join(root, 'dist/signed-mac-arm64');
  const checks = checkCandidate(source, { version });
  if (checks.some((c) => !c.passed)) throw new Error('Candidate verification failed');
  // Never erase an existing signed output or overwrite an earlier release.
  if (fs.existsSync(output)) throw new Error('Signed output already exists; archive it explicitly first');
  fs.mkdirSync(output);
  const app = path.join(output, '就活トラッカー.app');
  fs.cpSync(path.join(source, '就活トラッカー.app'), app, { recursive: true, dereference: false });
  const command = (file, args) => execFileSync(file, args, { stdio: 'pipe', timeout: 1200000, encoding: 'utf8' });
  const machos = [];
  const visit = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in signing input');
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) {
      const buffer = Buffer.alloc(4), fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buffer, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca','cafebabf'].includes(buffer.toString('hex'))) machos.push(file);
    }
  } };
  visit(app);
  const sign = (file, extra = []) => command('codesign', ['--force','--sign',options.identity,'--timestamp','--options','runtime',...extra,file]);
  for (const file of machos.sort((a, b) => b.length - a.length)) sign(file, /copilot-sdk-darwin-arm64/.test(file) && !/\.(dylib|node)$/.test(file) ? ['--entitlements',path.join(root,'platforms/macos/CopilotRuntime.entitlements.plist')] : []);
  sign(app);
  command('codesign', ['--verify','--deep','--strict',app]);
  const notarize = (file) => {
    const response = JSON.parse(command('xcrun', ['notarytool','submit',file,'--keychain-profile',options.profile,'--wait','--output-format','json']));
    if (response.status !== 'Accepted') throw new Error('Apple notarization did not return Accepted');
  };
  const zip = path.join(output, artifactName(version,'darwin','arm64','zip'));
  const zipApp = () => command('ditto', ['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
  zipApp(); notarize(zip);
  command('xcrun', ['stapler','staple',app]);
  fs.unlinkSync(zip); zipApp();
  const dmg = path.join(output, artifactName(version,'darwin','arm64','dmg'));
  const imageRoot = path.join(output, 'image-input'); fs.mkdirSync(imageRoot);
  fs.cpSync(app, path.join(imageRoot,path.basename(app)), { recursive: true });
  command('hdiutil', ['create','-volname','就活トラッカー','-srcfolder',imageRoot,'-ov','-format','UDZO',dmg]);
  fs.rmSync(imageRoot, { recursive: true });
  sign(dmg); notarize(dmg);
  command('xcrun', ['stapler','staple',dmg]);
  command('xcrun', ['stapler','validate',dmg]);
  command('spctl', ['--assess','--type','execute',app]);
  const sbom = artifactName(version,'darwin','arm64','cdx.json');
  fs.copyFileSync(path.join(source,sbom),path.join(output,sbom));
  writeManifest(output);
  console.log('Signed/notarized candidate created locally; no GitHub publication performed. Run release:check against dist/signed-mac-arm64.');
}
if (require.main === module) { try { run(); } catch(error) { console.error(error.message); process.exitCode=1; } }
module.exports = { parseOptions, run };
