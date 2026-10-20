'use strict';
function artifactName(version, platform, arch, format) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version));
  if (!match) throw new Error('Invalid release version');
  const v = match.slice(1).join('.');
  if (platform === 'darwin' && arch === 'arm64' && ['dmg', 'zip', 'cdx.json'].includes(format)) return `job-tracker-${v}-mac-arm64.${format}`;
  if (platform === 'win32' && ['x64', 'arm64'].includes(arch) && ['exe', 'zip', 'cdx.json'].includes(format)) return `job-tracker-${v}-win-${arch}${format === 'zip' ? '-portable' : ''}.${format}`;
  if (platform === 'linux' && arch === 'x64' && ['deb', 'rpm', 'cdx.json'].includes(format)) return `job-tracker-${v}-linux-${format === 'deb' ? 'amd64.deb' : format === 'rpm' ? 'x86_64.rpm' : 'x64.cdx.json'}`;
  throw new Error('Unsupported release platform, CPU or format');
}
if (require.main === module) {
  try { console.log(artifactName(...process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { artifactName };
