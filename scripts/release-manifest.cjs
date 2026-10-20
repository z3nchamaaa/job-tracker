'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function writeManifest(directory) {
  const dir = path.resolve(directory);
  const files = fs.readdirSync(dir).filter((name) => /^job-tracker-\d+\.\d+\.\d+-(mac-arm64|win-(x64|arm64)|linux-(amd64|x86_64|x64))(?:-portable)?\.(dmg|zip|exe|deb|rpm|cdx\.json)$/.test(name)).sort();
  const assets = files.map((name) => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid release asset: ' + name);
    return { name, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
  if (!assets.length) throw new Error('No named release assets found');
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), signed: false,
    notice: 'SHA-256 proves integrity only. This manifest is not an authenticated publisher signature or notarization proof.', assets };
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), assets.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n');
  return manifest;
}
if (require.main === module) {
  try {
    const dir = path.resolve(process.argv[2] || 'dist/mac-arm64');
    if (!dir.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Manifest output must be inside dist');
    console.log(JSON.stringify({ assets: writeManifest(dir).assets.length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { writeManifest };
