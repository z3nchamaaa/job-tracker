#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function walkFiles(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules', '.agents', '.codex', '.aws'].includes(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, result);
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

function runAudit() {
  const findings = [];

  // 1. Check package.json & package-lock.json
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const depsCount = Object.keys(pkg.dependencies || {}).length;
  const devDepsCount = Object.keys(pkg.devDependencies || {}).length;
  if (depsCount !== 0 || devDepsCount !== 0) {
    findings.push(`External npm dependencies detected: dependencies=${depsCount}, devDependencies=${devDepsCount}`);
  }

  // 2. Check .npmrc
  const npmrc = fs.readFileSync(path.join(repoRoot, '.npmrc'), 'utf8');
  if (!npmrc.includes('ignore-scripts=true')) {
    findings.push('.npmrc is missing ignore-scripts=true');
  }

  // 3. Scan source files for dangerous execution or forbidden tokens
  // Internal implementation-agent identifiers/settings stay forbidden.
  // Public provider names are now intentionally used by the API registration UI.
  // Encoding keeps the audit's own definitions from matching themselves.
  const forbiddenBase64 = [
    'YW50aWdyYXZpdHk=',
    'Z2VtaW5pLTQtYXJnb24=',
    'LS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25z',
  ];
  const forbiddenPatterns = forbiddenBase64.map(
    (b64) => new RegExp(Buffer.from(b64, 'base64').toString('utf8'), 'i')
  );

  const files = walkFiles(repoRoot);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (['.png', '.icns', '.ico', '.db', '.sqlite', '.sqlite3'].includes(ext)) {
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);

    for (const pat of forbiddenPatterns) {
      if (pat.test(content)) {
        findings.push(`Forbidden identifier matched in ${rel}`);
      }
    }

    if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) {
      findings.push(`Dynamic code evaluation detected in ${rel}`);
    }

    if (/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/.test(content)) {
      findings.push(`TLS verification bypass detected in ${rel}`);
    }

    if (/sk-[A-Za-z0-9]{20,}/.test(content) && !rel.startsWith('test/')) {
      findings.push(`Potential secret token pattern detected in ${rel}`);
    }
  }

  // 4. Inspect dist/ if present to ensure no DB, keys, .env, personal/agent configs are bundled
  const distDir = path.join(repoRoot, 'dist');
  let distFilesCount = 0;
  if (fs.existsSync(distDir)) {
    function walkDist(dir, result = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDist(full, result);
        } else if (entry.isFile()) {
          result.push(full);
        }
      }
      return result;
    }
    const distFiles = walkDist(distDir);
    distFilesCount = distFiles.length;
    const forbiddenDistExts = new Set(['.db', '.sqlite', '.sqlite3', '.enc', '.pem', '.key', '.p12']);
    const forbiddenDistNames = new Set([
      '.env',
      '.env.local',
      'career-profile.json',
      'app-settings.json',
      'auth.enc',
      'master.key',
      'AGENTS.md',
    ]);
    for (const file of distFiles) {
      const base = path.basename(file);
      const ext = path.extname(file).toLowerCase();
      const rel = path.relative(repoRoot, file);
      if (forbiddenDistExts.has(ext) || forbiddenDistNames.has(base) || forbiddenPatterns.some((rx) => rx.test(base))) {
        findings.push(`Forbidden data/secret/config file in dist: ${rel}`);
      }
      if (['.cjs', '.js', '.json', '.html', '.css', '.plist'].includes(ext)) {
        const content = fs.readFileSync(file, 'utf8');
        for (const pat of forbiddenPatterns) {
          if (pat.test(content)) {
            findings.push(`Forbidden identifier matched in dist file: ${rel}`);
          }
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error('Security audit failed:');
    for (const f of findings) {
      console.error(' - ' + f);
    }
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        auditType: 'static-source-and-distribution-policy-check',
        note: 'This script performs static source/bundle checks (zero npm packages, ignore-scripts=true, forbidden identifiers, eval/TLS bypass, dist cleanliness). OS WebView, Node.js runtime, SQLite, and .NET CVE tracking are documented separately in README.md.',
        scannedSourceFilesCount: files.length,
        scannedDistFilesCount: distFilesCount,
        externalNpmDependenciesCount: 0,
        npmIgnoreScripts: true,
        nodeRuntimeVersion: process.version,
        findings: [],
      },
      null,
      2
    )
  );
}

runAudit();
