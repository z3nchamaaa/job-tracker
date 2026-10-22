"use strict";

const MIN_NODE_VERSION = "24.15.0";
function assertSupportedRuntime(version = process.versions.node) {
  const parts = String(version).replace(/^v/, "").split(".").map(Number);
  const minimum = MIN_NODE_VERSION.split(".").map(Number);
  let supported = parts.length === 3 && parts.every(Number.isInteger);
  if (supported) {
    supported = false;
    for (let i = 0; i < 3; i++) {
      if (parts[i] !== minimum[i]) { supported = parts[i] > minimum[i]; break; }
      if (i === 2) supported = true;
    }
  }
  if (!supported) throw new Error(`Node.js ${MIN_NODE_VERSION}以降が必要です（検出: ${version}）。Node.jsのサポート中の版をインストールしてください。`);
}

module.exports = { MIN_NODE_VERSION, assertSupportedRuntime };
