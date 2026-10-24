'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets/icons/macos');
const inputs = ['assets/icons/app-icon.png', 'assets/icons/macos/icon.json', 'scripts/macos-icon.cjs'];
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceHashes() { return Object.fromEntries(inputs.map((file) => [file, sha(path.join(root, file))])); }
function verify(directory = assets) {
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  if (record.version !== 1 || record.iconName !== 'AppIcon' || JSON.stringify(record.inputs) !== JSON.stringify(sourceHashes()) ||
      record.assetsSha256 !== sha(path.join(directory, 'Assets.car'))) throw new Error('macOSのアイコンが古いか破損しています。scripts/macos-icon.cjsで再生成してください。');
  return record;
}
function compile() {
  if (process.platform !== 'darwin') throw new Error('macOSとXcode 26以降が必要です。');
  const directory = path.join(root, 'dist/macos-icon');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const icon = path.join(directory, 'AppIcon.icon');
  fs.mkdirSync(path.join(icon, 'Assets'), { recursive: true });
  // Keep the original artwork intact. The native icon layout fills the system
  // mask instead of asking macOS to wrap a legacy, already padded ICNS image.
  fs.copyFileSync(path.join(assets, 'icon.json'), path.join(icon, 'icon.json'));
  fs.copyFileSync(path.join(root, 'assets/icons/app-icon.png'), path.join(icon, 'Assets/artwork.png'));
  execFileSync('/usr/bin/xcrun', ['actool', icon, '--compile', directory, '--app-icon', 'AppIcon',
    '--include-all-app-icons', '--target-device', 'mac', '--minimum-deployment-target', '13.0', '--platform', 'macosx',
    '--output-format', 'human-readable-text', '--output-partial-info-plist', path.join(directory, 'generated.plist')], { stdio: 'inherit' });
  const record = { version: 1, iconName: 'AppIcon', inputs: sourceHashes(), assetsSha256: sha(path.join(directory, 'Assets.car')),
    compiler: execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' }).trim() };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(record, null, 2) + '\n');
  verify(directory);
  console.log('Native macOS icon compiled; source and asset hashes verified.');
}
function stage(resources) {
  verify();
  fs.copyFileSync(path.join(assets, 'Assets.car'), path.join(resources, 'Assets.car'));
}
if (require.main === module) {
  if (process.argv[2] === '--compile') compile();
  else { verify(); console.log('Native macOS icon source and compiled asset match.'); }
}
module.exports = { verify, stage };
