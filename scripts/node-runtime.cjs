'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { assertSupportedRuntime } = require('../src/backend/runtime.cjs');
const lock = require('../node-runtime-lock.json');
const root = path.resolve(__dirname, '..');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function getNodeSpec(platform, arch) {
  assertSupportedRuntime(lock.version);
  const target = (platform === 'win32' ? 'win' : platform) + '-' + arch;
  if (!['darwin-arm64', 'darwin-x64', 'win-x64', 'win-arm64', 'linux-x64'].includes(target)) throw new Error('Unsupported bundled Node target');
  const spec = lock.targets[target];
  const prefix = 'node-v' + lock.version + '-' + target;
  const windows = platform === 'win32';
  if (lock.source !== 'https://nodejs.org/dist/' || spec?.archive !== prefix + (windows ? '.zip' : '.tar.gz') ||
      spec.binaryPath !== prefix + (windows ? '/node.exe' : '/bin/node') || spec.licensePath !== prefix + '/LICENSE' ||
      ![spec.archiveSha256, spec.binarySha256, spec.licenseSha256].every((s) => /^[a-f0-9]{64}$/.test(s))) throw new Error('Invalid bundled Node lock');
  return { ...spec, version: lock.version, platform, arch, target, executable: windows ? 'node.exe' : 'node' };
}
function verifyBundledNode(directory, platform, arch) {
  const spec = getNodeSpec(platform, arch);
  const runtime = path.join(directory, 'runtime');
  for (const [name, digest] of [[spec.executable, spec.binarySha256], ['LICENSE.txt', spec.licenseSha256]]) {
    const file = path.join(runtime, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(file) !== digest) throw new Error('Bundled Node integrity mismatch: ' + name);
  }
  const metadataFile = path.join(runtime, 'node-runtime.json'), metadataStat = fs.lstatSync(metadataFile);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error('Invalid bundled Node metadata file');
  const metadata = JSON.parse(fs.readFileSync(metadataFile));
  for (const key of ['version', 'platform', 'arch', 'archiveSha256', 'binarySha256', 'licenseSha256']) {
    if (metadata[key] !== spec[key]) throw new Error('Bundled Node metadata mismatch: ' + key);
  }
  return metadata;
}
async function stageBundledNode(directory, platform, arch) {
  assertSupportedRuntime();
  const destination = path.resolve(directory);
  if (!destination.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Stage bundled Node inside dist only');
  const spec = getNodeSpec(platform, arch);
  const cache = path.join(root, 'dist/node-downloads', spec.version);
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, spec.archive);
  if (!fs.existsSync(archive)) {
    const temporary = archive + '.' + crypto.randomUUID() + '.tmp';
    const response = await fetch('https://nodejs.org/dist/v' + spec.version + '/' + spec.archive, {
      redirect: 'error', signal: AbortSignal.timeout(180000),
    });
    if (!response.ok || !response.body) throw new Error('Official Node download failed: ' + response.status);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    let downloadError;
    try {
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) throw new Error('Node archive exceeds download limit');
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
      }
      fs.fsyncSync(fd);
    } catch (error) { downloadError = error; }
    finally { fs.closeSync(fd); }
    if (downloadError) { fs.rmSync(temporary, { force: true }); throw downloadError; }
    if (sha(temporary) !== spec.archiveSha256) { fs.rmSync(temporary); throw new Error('Official Node archive checksum mismatch'); }
    fs.renameSync(temporary, archive);
  }
  const archiveStat = fs.lstatSync(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || sha(archive) !== spec.archiveSha256) throw new Error('Cached Node archive checksum mismatch');
  const extracted = fs.mkdtempSync(path.join(cache, 'unpack-'));
  try {
    // Git Bash's GNU tar treats drive letters as remote hosts and cannot read ZIPs.
    // Windows ships bsdtar with ZIP support; select it explicitly on the build host.
    const tar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    execFileSync(tar, ['-xf', archive, '-C', extracted, spec.binaryPath, spec.licensePath], { timeout: 120000 });
    const binary = path.join(extracted, spec.binaryPath), license = path.join(extracted, spec.licensePath);
    for (const file of [binary, license]) if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Unexpected Node archive entry');
    if (sha(binary) !== spec.binarySha256 || sha(license) !== spec.licenseSha256) throw new Error('Extracted Node integrity mismatch');
    const runtime = path.join(destination, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.copyFileSync(binary, path.join(runtime, spec.executable));
    fs.chmodSync(path.join(runtime, spec.executable), 0o755);
    fs.copyFileSync(license, path.join(runtime, 'LICENSE.txt'));
    const metadata = { version: spec.version, platform, arch, source: 'https://nodejs.org/dist/v' + spec.version + '/' + spec.archive,
      archiveSha256: spec.archiveSha256, binarySha256: spec.binarySha256, licenseSha256: spec.licenseSha256,
      archiveBytes: archiveStat.size, binaryBytes: fs.statSync(binary).size };
    fs.writeFileSync(path.join(runtime, 'node-runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
    verifyBundledNode(destination, platform, arch);
    console.log('Bundled Node.js ' + spec.version + ' (' + spec.target + '), official checksums and full license verified.');
    return metadata;
  } finally { fs.rmSync(extracted, { recursive: true, force: true, maxRetries: 3 }); }
}
if (require.main === module) {
  stageBundledNode(...process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { getNodeSpec, verifyBundledNode, stageBundledNode };
