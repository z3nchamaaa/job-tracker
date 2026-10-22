'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { artifactName } = require('../src/backend/artifact-names.cjs');
const root = path.resolve(__dirname, '..');

function generateSbom(directory, output) {
  const cwd = path.resolve(directory);
  const disabledGlobalConfig = path.join(cwd, '.npm-global-disabled');
  if (fs.existsSync(disabledGlobalConfig)) throw new Error('Unexpected npm configuration in SBOM input');
  const args = ['sbom', '--sbom-format=cyclonedx', '--sbom-type=application', '--omit=dev', '--offline', '--ignore-scripts',
    `--userconfig=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '--globalconfig=./.npm-global-disabled'];
  // Fixed arguments only; npm.cmd requires cmd.exe on Windows. No user prompt,
  // branch, token, or output path is interpolated into the command.
  const raw = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, shell: process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_offline: 'true' },
  });
  const bom = JSON.parse(raw);
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5' || !Array.isArray(bom.components)) throw new Error('Unexpected npm CycloneDX format');
  bom.metadata.authors = [{ name: 'job-tracker build tooling' }];
  bom.metadata.properties = [
    { name: 'job-tracker:scope', value: 'Installed npm packages and, when staged, the pinned bundled Node executable. Native runtime internals, OS libraries and .NET/WebView runtimes require separate review.' },
    { name: 'job-tracker:node-build-version', value: process.version },
    { name: 'job-tracker:install-scripts', value: 'disabled' },
  ];
  if (fs.existsSync(path.join(cwd, 'runtime/node-runtime.json'))) {
    const metadata = JSON.parse(fs.readFileSync(path.join(cwd, 'runtime/node-runtime.json')));
    const node = require('./node-runtime.cjs').verifyBundledNode(cwd, metadata.platform, metadata.arch);
    const reference = 'bundled-node-' + node.platform + '-' + node.arch;
    bom.components.push({ type: 'application', name: 'Node.js', version: node.version, 'bom-ref': reference,
      hashes: [{ alg: 'SHA-256', content: node.binarySha256 }],
      licenses: [{ license: { name: 'Node.js and bundled third-party license notices', url: 'https://nodejs.org/dist/v' + node.version + '/LICENSE' } }],
      externalReferences: [{ type: 'distribution', url: node.source }],
      properties: [{ name: 'job-tracker:bundled-target', value: node.platform + '-' + node.arch },
        { name: 'job-tracker:archive-sha256', value: node.archiveSha256 },
        { name: 'job-tracker:license-notice', value: 'runtime/LICENSE.txt' }] });
    const appDependency = bom.dependencies?.find((d) => d.ref === bom.metadata.component['bom-ref']);
    if (appDependency) appDependency.dependsOn = [...(appDependency.dependsOn || []), reference];
  }
  // npm may include repository author email from dependency metadata. That is
  // public upstream metadata, but it is unnecessary for this app's inventory.
  for (const component of [bom.metadata.component, ...bom.components]) delete component.author;
  for (const component of bom.components) {
    if (!/^@github\/copilot-sdk-(darwin|linux|linuxmusl|win32)-(arm64|x64)$/.test(component.name)) continue;
    if (!fs.existsSync(path.join(cwd, 'licenses/Copilot-CLI.txt'))) throw new Error('Copilot CLI license notice is missing from staged application');
    component.licenses = [
      { license: { id: 'MIT' } },
      { license: { name: 'GitHub Copilot CLI License', url: 'https://github.com/github/copilot-cli/blob/v1.0.100/LICENSE.md' } },
    ];
    component.properties = [...(component.properties || []), {
      name: 'job-tracker:license-scope',
      value: 'MIT applies to npm wrapper metadata; the bundled Copilot CLI is separately licensed under GitHub Copilot CLI License. These are separate components, not an offer to use the CLI under MIT.',
    }];
  }
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(bom, null, 2) + '\n'); }
  return bom;
}
function platformSbom(directory, outputDir, platform, arch) {
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version;
  return generateSbom(directory, path.join(outputDir, artifactName(version, platform, arch, 'cdx.json')));
}
if (require.main === module) {
  try {
    const bom = generateSbom(root, path.join(root, 'dist/sbom/source.cdx.json'));
    console.log(`CycloneDX ${bom.specVersion}: ${bom.components.length} installed npm components`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { generateSbom, platformSbom };
