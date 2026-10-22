'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CHROME, launchPage } = require('../scripts/browser.cjs');

test('Browser startup waits for Chrome to finish writing its debugging port', async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip('macOS Google Chrome is required'); return; }
  const readFile = fs.readFileSync;
  let incompleteReads = 0;
  const mock = t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (path.basename(String(file)) === 'DevToolsActivePort' && incompleteReads < 2) {
      // Exercise both a newly created empty file and a partial port line.
      return incompleteReads++ === 0 ? '' : '12';
    }
    return readFile.call(this, file, ...args);
  });
  let browser;
  try {
    browser = await launchPage('about:blank');
    assert.equal(incompleteReads, 2);
    assert.equal(await browser.evaluate('location.href'), 'about:blank');
  } finally {
    mock.mock.restore();
    await browser?.close();
  }
});
