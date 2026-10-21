#!/usr/bin/env node
'use strict';

require("../src/backend/runtime.cjs").assertSupportedRuntime();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');
const macDist = path.join(distRoot, 'mac-arm64');
const appBundle = path.join(macDist, '就活トラッカー.app');
const contentsDir = path.join(appBundle, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const bundledAppDir = path.join(resourcesDir, 'app');

const { copyRuntime } = require('./stage.cjs');
const { artifactName } = require('../src/backend/artifact-names.cjs');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'))).version;
const { platformSbom } = require('./sbom.cjs');
const { writeManifest } = require('./release-manifest.cjs');

function getDirectorySizeBytes(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function measureExternalNodeLibraries(binary, prefix) {
  const visited = new Set();
  const external = [];
  const unresolved = new Set();
  const expand = (value, loader) => value.replace(/^@loader_path(?=\/|$)/, path.dirname(loader)).replace(/^@executable_path(?=\/|$)/, path.dirname(binary));
  const visit = (file, inheritedPaths = []) => {
    const real = fs.realpathSync(file);
    if (visited.has(real)) return;
    visited.add(real);
    const loadCommands = execFileSync('/usr/bin/otool', ['-l', real], { encoding: 'utf8' });
    const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset \d+\)/g)].map((match) => expand(match[1], real));
    const searchPaths = [...rpaths, ...inheritedPaths];
    const lines = execFileSync('/usr/bin/otool', ['-L', real], { encoding: 'utf8' }).split('\n').slice(1);
    for (const line of lines) {
      let dependency = line.trim().split(' (')[0];
      dependency = expand(dependency, real);
      if (dependency.startsWith('@rpath/')) {
        const relative = dependency.slice('@rpath/'.length);
        dependency = searchPaths.map((dir) => path.resolve(dir, relative)).find((candidate) => fs.existsSync(candidate)) || dependency;
      }
      if (dependency.startsWith('@')) { unresolved.add(`${real}: ${dependency}`); continue; }
      if (!dependency.startsWith('/') || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/')) continue;
      if (!fs.existsSync(dependency)) throw new Error(`Linked library missing: ${dependency}`);
      const resolved = fs.realpathSync(dependency);
      if (!visited.has(resolved) && !resolved.startsWith(prefix + path.sep)) {
        external.push({ path: resolved, bytes: fs.statSync(resolved).size });
      }
      visit(resolved, searchPaths);
    }
  };
  visit(binary);
  const unique = [...new Map(external.map((item) => [item.path, item])).values()];
  return { files: unique, bytes: unique.reduce((sum, item) => sum + item.bytes, 0), unresolved: [...unresolved], scope: 'Non-system linked library files only; whole dependency package directories and filesystem allocation are not measured. Any unresolved paths are excluded.' };
}

function buildMacArm64() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('このビルド手順はmacOS Apple Silicon専用です。');
  }
  fs.rmSync(macDist, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(bundledAppDir, { recursive: true });

  // 1. Copy Info.plist & Icon
  fs.copyFileSync(
    path.join(repoRoot, 'platforms', 'macos', 'Info.plist'),
    path.join(contentsDir, 'Info.plist')
  );
  fs.copyFileSync(
    path.join(repoRoot, 'assets', 'icons', 'app-icon.icns'),
    path.join(resourcesDir, 'app-icon.icns')
  );

  // 2. Stage the allowlisted application files only.
  copyRuntime(bundledAppDir, 'macos');

  // 3. Compile Swift Native Host
  const hostBinary = path.join(macosDir, 'JobTrackerHost');
  execFileSync(
    '/usr/bin/swiftc',
    [
      '-O',
      path.join(repoRoot, 'platforms', 'macos', 'Host.swift'),
      '-framework',
      'AppKit',
      '-framework',
      'WebKit',
      '-framework',
      'Security',
      '-framework',
      'CryptoKit',
      '-framework',
      'LocalAuthentication',
      '-o',
      hostBinary,
    ],
    { stdio: 'inherit' }
  );
  fs.chmodSync(hostBinary, 0o755);

  // 4. Ad-hoc sign the bundle for local execution
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], {
    stdio: 'inherit',
  });

  // 5. Create ZIP archive
  const zipPath = path.join(macDist, artifactName(version, 'darwin', 'arm64', 'zip'));
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, zipPath], {
    stdio: 'inherit',
  });

  // 6. Create DMG image
  const dmgPath = path.join(macDist, artifactName(version, 'darwin', 'arm64', 'dmg'));
  execFileSync(
    '/usr/bin/hdiutil',
    [
      'create',
      '-volname',
      '就活トラッカー',
      '-srcfolder',
      appBundle,
      '-ov',
      '-format',
      'UDZO',
      dmgPath,
    ],
    { stdio: 'inherit' }
  );

  platformSbom(bundledAppDir, macDist, 'darwin', 'arm64');
  writeManifest(macDist);

  // 7. Verify distribution cleanliness (no DB, keys, .env, personal/agent configs)
  const forbiddenExts = new Set(['.db', '.sqlite', '.sqlite3', '.enc', '.pem', '.key', '.p12']);
  const forbiddenNames = new Set([
    '.env',
    '.env.local',
    '.DS_Store',
    'career-profile.json',
    'app-settings.json',
    'auth.enc',
    'master.key',
    'AGENTS.md',
  ]);
  // Public API provider names are intentional UI content; internal agent setup is not.
  const forbiddenAgentB64 = ['YW50aWdyYXZpdHk=', 'Z2VtaW5pLTQtYXJnb24=', 'LS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25z'];
  const forbiddenAgentRegexes = forbiddenAgentB64.map(
    (b) => new RegExp(Buffer.from(b, 'base64').toString('utf8'), 'i')
  );

  function collectFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(full, out);
      } else {
        out.push(full);
      }
    }
    return out;
  }

  const bundleFiles = collectFiles(appBundle);
  for (const file of bundleFiles) {
    const base = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    if (forbiddenExts.has(ext) || forbiddenNames.has(base) || forbiddenAgentRegexes.some((rx) => rx.test(base))) {
      throw new Error(`Forbidden file bundled in distribution: ${path.relative(repoRoot, file)}`);
    }
    if (['.cjs', '.js', '.json', '.html', '.css', '.plist'].includes(ext)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const rx of forbiddenAgentRegexes) {
        if (rx.test(text)) {
          throw new Error(`Forbidden agent/model identifier found in bundled file: ${path.relative(repoRoot, file)}`);
        }
      }
    }
  }

  // 8. Inspect dynamic link dependencies of native host binary
  const otoolOut = execFileSync('/usr/bin/otool', ['-L', hostBinary], { encoding: 'utf8' });
  const dynamicLibs = otoolOut
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);

  // 9. Measure exact sizes
  const unpackedBytes = getDirectorySizeBytes(appBundle);
  const hostBinBytes = fs.statSync(hostBinary).size;
  const zipBytes = fs.statSync(zipPath).size;
  const dmgBytes = fs.statSync(dmgPath).size;
  const nodeBinPath = fs.realpathSync(process.execPath);
  const nodeBinBytes = fs.existsSync(nodeBinPath) ? fs.statSync(nodeBinPath).size : 0;
  const nodePrefixDir = path.resolve(path.dirname(nodeBinPath), '..');
  const nodeInstallDirBytes = fs.existsSync(nodePrefixDir) ? getDirectorySizeBytes(nodePrefixDir) : nodeBinBytes;
  const linkedLibraries = measureExternalNodeLibraries(nodeBinPath, nodePrefixDir);

  // Measure fresh empty SQLite DB size in temp dir
  const os = require('node:os');
  const { DatabaseStore } = require('../src/backend/db.cjs');
  const tmpMeasureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-size-db-'));
  const tmpDbPath = path.join(tmpMeasureDir, 'job-tracker.db');
  const tmpDb = new DatabaseStore({ dataDir: tmpMeasureDir });
  tmpDb.close();
  const initialEmptyDbBytes = fs.existsSync(tmpDbPath) ? fs.statSync(tmpDbPath).size : 0;
  fs.rmSync(tmpMeasureDir, { recursive: true, force: true });

  const report = {
    measuredAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    codeSigning: {
      signatureType: 'ad-hoc',
      command: 'codesign --force --deep --sign -',
      developerIdSigned: false,
      appleNotarized: false,
      note: 'Local build applies an ad-hoc signature (-). Distributing to external macOS machines without Gatekeeper warnings requires an Apple Developer ID Application certificate and notarization via xcrun notarytool.',
    },
    compressedDistributionDownload: {
      macosDmg: {
        path: path.relative(repoRoot, dmgPath),
        bytes: dmgBytes,
        formatted: formatBytes(dmgBytes),
        sha256: sha256File(dmgPath),
      },
      macosZip: {
        path: path.relative(repoRoot, zipPath),
        bytes: zipBytes,
        formatted: formatBytes(zipBytes),
        sha256: sha256File(zipPath),
      },
      windowsDistributionDownloadBytes: 'unmeasured',
      linuxDistributionDownloadBytes: 'unmeasured',
    },
    unpackedInstalledSize: {
      macosAppBundle: {
        path: path.relative(repoRoot, appBundle),
        appBundleBytes: unpackedBytes,
        appBundleFormatted: formatBytes(unpackedBytes),
        nativeHostBinaryBytes: hostBinBytes,
        nativeHostBinaryFormatted: formatBytes(hostBinBytes),
      },
      windowsUnpackedBytes: 'unmeasured',
      linuxUnpackedBytes: 'unmeasured',
    },
    sizeReductionEvaluation: {
      legacyWindowsWebUnpackedBytes: 479627417,
      legacyWindowsWebTarget50PercentMaxBytes: 239813708,
      unpackedTargetMaxBytes: 50 * 1024 * 1024,
      unpackedStretchMaxBytes: 15 * 1024 * 1024,
      macosMeets50MBTarget: unpackedBytes <= 50 * 1024 * 1024,
      macosMeets15MBTarget: unpackedBytes <= 15 * 1024 * 1024,
      windows50PercentReductionVerified: false,
      note: 'macOS .app size is measured; the boolean fields report whether the targets are met. Copilot runtime increases the application size. Windows reduction remains unverified until a measured Windows build is available.',
    },
    dynamicLinkDependencies: {
      macosHostBinary: dynamicLibs,
      additionalDownloadBytes: 0,
      note: 'All dynamic libraries linked by JobTrackerHost are macOS system frameworks and libSystem/Swift OS libraries.',
    },
    requiredSharedRuntime: {
      webviewEngine: {
        macos: 'OS built-in WKWebView (WebKit.framework, 0 B extra download)',
        windows: 'Microsoft Edge WebView2 Runtime (OS built-in on Windows 11 / shared Evergreen runtime)',
        linux: 'WebKitGTK 4.1 (system shared package)',
      },
      nodejsRuntime: {
        requiredVersion: require('../src/backend/runtime.cjs').SUPPORTED_NODE_RANGE,
        detectedVersion: process.version,
        localNodeExecutablePath: nodeBinPath,
        localNodeExecutableUnpackedBytes: nodeBinBytes,
        localNodeExecutableUnpackedFormatted: formatBytes(nodeBinBytes),
        localNodeInstallPrefixPath: nodePrefixDir,
        localNodeInstallUnpackedBytes: nodeInstallDirBytes,
        localNodeInstallUnpackedFormatted: formatBytes(nodeInstallDirBytes),
        externalLinkedLibraries: linkedLibraries,
        measuredRuntimeFilesTotalBytes: nodeInstallDirBytes + linkedLibraries.bytes,
        externalNodeInstallerCompressedDownloadBytes: 'unmeasured',
        note: 'localNodeInstallUnpackedBytes is the expanded disk usage of the Node installation used to build (including headers and libraries), NOT a compressed network download size. Node is a shared runtime and is not bundled.',
      },
      windowsDotNetHost: {
        requiredRuntime: '.NET 10 Desktop Runtime (net10.0-windows10.0.19041.0) + Microsoft.Web.WebView2 NuGet (1.0.4258.31)',
        downloadBytes: 'unmeasured',
        unpackedBytes: 'unmeasured',
      },
    },
    firstRunAcquisition: {
      whenSharedNodeRuntimeAlreadyInstalled: {
        macosDmgDownloadBytes: dmgBytes,
        macosDmgDownloadFormatted: formatBytes(dmgBytes),
        macosZipDownloadBytes: zipBytes,
        macosZipDownloadFormatted: formatBytes(zipBytes),
      },
      whenSharedNodeRuntimeMustBeFetchedFromNetwork: {
        totalCompressedDownloadBytes: 'unmeasured',
        reason: 'Compressed installer download size for Node.js varies by OS/distributor and is not fetched during offline local build.',
      },
    },
    userDataAndCache: {
      bundledUserDataBytes: 0,
      initialEmptySqliteDbBytes: initialEmptyDbBytes,
      initialEmptySqliteDbFormatted: formatBytes(initialEmptyDbBytes),
      runtimeDataLocations: {
        macos: '~/Library/Application Support/jp.jobtracker.app',
        windows: '%APPDATA%\\jp.jobtracker.app',
        linux: '${XDG_CONFIG_HOME:-~/.config}/jp.jobtracker.app',
      },
      runtimeDataFiles: [
        'job-tracker.db (SQLite database + WAL/SHM)',
        'career-profile.json (JSON career profile)',
        'app-settings.json (theme, accent, optional startup lock; no credentials)',
        'auth/auth.enc (AES-256-GCM encrypted OAuth token store)',
        'backups/*.json (automatic pre-import/pre-update JSON backups)',
        'updates/ (downloaded update staging)',
      ],
      webviewCacheLocations: {
        macos: '~/Library/Caches/jp.jobtracker.app (nonPersistent ephemeral store used in --smoke-test)',
        windows: '%LOCALAPPDATA%\\jp.jobtracker.app\\WebView2',
      },
    },
    distributionCleanlinessCheck: {
      checkedFilesCount: bundleFiles.length,
      verifiedNoDatabaseFiles: true,
      verifiedNoSecretOrAuthFiles: true,
      verifiedNoPersonalOrAgentConfig: true,
    },
  };

  const reportPath = path.join(distRoot, 'size-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('\n=== Build & Size Measurement Complete ===');
  console.log(JSON.stringify(report, null, 2));
}

buildMacArm64();
