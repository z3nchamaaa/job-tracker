"use strict";

// Security floors from the 2026-10-21 Node.js releases. Do not accept an
// unpatched newer major merely because it exceeds the lowest numeric version.
const MIN_NODE_VERSION = "24.22.1";
const SUPPORTED_NODE_RANGE = "^24.22.1 || ^26.12.1";
const SECURITY_MINIMUMS = Object.freeze({ 24: [22, 1], 26: [12, 1] });
function assertSupportedRuntime(version = process.versions.node) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version));
  const parts = match ? match.slice(1).map(Number) : [];
  const minimum = SECURITY_MINIMUMS[parts[0]];
  const supported = minimum && parts.every(Number.isSafeInteger) &&
    (parts[1] > minimum[0] || (parts[1] === minimum[0] && parts[2] >= minimum[1]));
  if (!supported) throw new Error(`Node.js 24.22.1以降の24系、または26.12.1以降の26系が必要です（検出: ${version}）。2026-10-21のセキュリティ修正を含む対応版へ更新してください。`);
}

module.exports = { MIN_NODE_VERSION, SUPPORTED_NODE_RANGE, assertSupportedRuntime };
