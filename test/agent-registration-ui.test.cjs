'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Agent registration and ChatGPT consolidation UI test', async (t) => {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chromePath)) {
    t.skip(`Google Chrome binary not found at ${chromePath}; skipping real browser UI test.`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-agent-ui-'));

  const { launchPage } = require('../scripts/browser.cjs');
  const { createAppServer } = require('../src/backend/server.cjs');

  let reportResolve;
  const reportPromise = new Promise((resolve) => {
    reportResolve = resolve;
  });

  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  };

  let sessionState = { connected: false, sharing: false, email: null };
  const mockChatGptService = {
    getSession: () => ({ ...sessionState }),
    listModels: async () => [{ slug: 'gpt-5-mini', displayName: 'Fast Model' }],
    signIn: async () => {
      sessionState = { connected: true, sharing: true, email: 'signed-in@example.jp' };
      return { ...sessionState };
    },
    cancelSignIn: () => ({ cancelled: true }),
    signOut: async () => {
      sessionState = { connected: false, sharing: false, email: null };
      return { ...sessionState };
    },
    openUsage: async () => ({ opened: true }),
    cancelGenerate: () => ({ cancelled: true }),
    shutdown: () => {},
    generate: async () =>
      JSON.stringify({
        name: '株式会社E2E集約検証',
        industry: '情報通信',
        annualIncome: 620,
        sources: [],
      }),
  };

  const testDriverScript = `
    (async function runAgentRegisterUiTest() {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, timeout = 10000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const val = fn();
          if (val) return val;
          await wait(40);
        }
        throw new Error('Timeout waiting for: ' + fn.toString());
      };
      const csrf = () => document.querySelector('meta[name="jt-csrf"]')?.getAttribute('content') || '';
      const sendReport = async (payload) => {
        await fetch('/api/__test_report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-jt-csrf': csrf() },
          body: JSON.stringify(payload),
        });
      };
      try {
        await waitFor(() => document.querySelectorAll('.metric-card').length === 5);

        // 1. Open AI / Prompt Add modal
        document.getElementById('btn-add-prompt').click();
        await waitFor(() => document.getElementById('pa-company-name'));

        // Verify prompt modal has 3 panels (Company Name/Prompt, Registered Agent generation, Paste JSON)
        // and does NOT have a separate top-level ChatGPT status badge
        const promptPanels = document.querySelectorAll('#modal-root .panel');
        const panelCount = promptPanels.length;
        const hasSeparateCgBadge = Boolean(document.querySelector('#modal-root #cg-status-badge'));
        const initialHasAgentSelect = Boolean(document.getElementById('api-agent-select'));

        // 2. Open Agent Registration Modal
        const regBtn = document.getElementById('btn-register-agents');
        regBtn.click();
        await waitFor(() => document.getElementById('agent-register-title'));

        // Verify Agent Registration Modal consolidates both ChatGPT controls and API key registration
        const hasCgBadgeInRegModal = Boolean(document.querySelector('#modal-root #cg-status-badge'));
        const hasCgControlsInRegModal = Boolean(document.querySelector('#modal-root #cg-controls'));
        const hasCgSignInBtn = Boolean(document.querySelector('#modal-root #btn-cg-signin'));
        const hasAgentForm = Boolean(document.querySelector('#modal-root #agent-register-form'));
        const hasRegisteredAgentsList = Boolean(document.querySelector('#modal-root #registered-agents'));

        // 3. Perform Sign In inside Agent Registration Modal
        document.getElementById('btn-cg-signin').click();
        await waitFor(() => document.querySelector('#modal-root #btn-cg-signout'));
        const badgeAfterSignIn = document.querySelector('#modal-root #cg-status-badge')?.textContent || '';
        const hasCgModelSelect = Boolean(document.querySelector('#modal-root #cg-model-select'));

        // 4. Close registration modal to return to Prompt Add modal
        document.querySelector('#modal-root [data-modal-close]').click();
        await waitFor(() => document.getElementById('pa-company-name'));

        // 5. Verify Prompt Add modal now has consolidated #api-agent-select and #btn-cg-generate
        await waitFor(() => document.getElementById('api-agent-select'));
        const afterSignInSelectHasCg = document.getElementById('api-agent-select')?.innerHTML.includes('公式 ChatGPT');
        const hasGenBtn = Boolean(document.getElementById('btn-cg-generate'));

        // 6. Execute AI generation from consolidated panel
        document.getElementById('pa-company-name').value = '株式会社E2E集約検証';
        document.getElementById('pa-company-name').dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-cg-generate').click();
        await waitFor(() => !document.getElementById('btn-save-draft-company').disabled);
        const previewHasGeneratedName = document.getElementById('pa-preview-area')?.textContent.includes('株式会社E2E集約検証');

        // 7. Re-open registration modal and sign out
        document.getElementById('btn-register-agents').click();
        await waitFor(() => document.getElementById('agent-register-title'));
        const signOutBtn = await waitFor(() => document.querySelector('#modal-root #btn-cg-signout'));
        signOutBtn.click();
        await waitFor(() => document.querySelector('#modal-root #btn-cg-signin'));

        // 8. Close registration modal and verify prompt modal reverted to unconnected state
        document.querySelector('#modal-root [data-modal-close]').click();
        await waitFor(() => document.getElementById('pa-company-name'));
        await waitFor(() => !document.getElementById('api-agent-select'));
        const controlsReverted = document.getElementById('api-agent-controls')?.textContent.includes('追加できます');

        await sendReport({
          ok: true,
          panelCount,
          hasSeparateCgBadge,
          initialHasAgentSelect,
          hasCgBadgeInRegModal,
          hasCgControlsInRegModal,
          hasCgSignInBtn,
          hasAgentForm,
          hasRegisteredAgentsList,
          badgeAfterSignIn,
          hasCgModelSelect,
          afterSignInSelectHasCg,
          hasGenBtn,
          previewHasGeneratedName,
          controlsReverted,
        });
      } catch (err) {
        await sendReport({ ok: false, error: err.message });
      }
    })();
  `;

  const appServer = createAppServer({
    dataDir: tmpDir,
    safeStorage,
    chatgptService: mockChatGptService,
    allowDevBrowserSession: true,
    testDriverScript,
    onTestReport: (data) => reportResolve(data),
  });

  const { bootstrapUrl } = await appServer.start(0);
  let chromeChild = null;
  let raceTimer = null;

  try {
    chromeChild = await launchPage(bootstrapUrl, { width: 360, height: 480 });

    const report = await Promise.race([
      reportPromise,
      new Promise((_, reject) => {
        raceTimer = setTimeout(() => reject(new Error('Agent registration UI test timed out after 20s')), 20000);
      }),
    ]);

    assert.equal(report.ok, true, `Agent registration UI test failed: ${report.error || ''}`);
    assert.equal(report.panelCount, 3, 'Prompt add modal must contain exactly 3 panels (consolidated, not 4)');
    assert.equal(report.hasSeparateCgBadge, false, 'Prompt add modal must not have a separate top-level ChatGPT status badge');
    assert.equal(report.initialHasAgentSelect, false, 'Initial prompt modal must not show selector when nothing is registered');
    assert.equal(report.hasCgBadgeInRegModal, true, 'Agent registration modal must contain ChatGPT status badge');
    assert.equal(report.hasCgControlsInRegModal, true, 'Agent registration modal must contain ChatGPT controls');
    assert.equal(report.hasCgSignInBtn, true, 'Agent registration modal must contain ChatGPT sign in button');
    assert.equal(report.hasAgentForm, true, 'Agent registration modal must contain API key agent form');
    assert.equal(report.hasRegisteredAgentsList, true, 'Agent registration modal must contain registered agents list');
    assert.match(report.badgeAfterSignIn, /Using ChatGPT plan/, 'Badge must reflect active session after sign-in');
    assert.equal(report.hasCgModelSelect, true, 'Model selector must appear in registration modal after sign-in');
    assert.equal(report.afterSignInSelectHasCg, true, 'Prompt modal selector must include ChatGPT after sign-in');
    assert.equal(report.hasGenBtn, true, 'Generate button must appear in prompt modal');
    assert.equal(report.previewHasGeneratedName, true, 'AI generation must populate preview area');
    assert.equal(report.controlsReverted, true, 'Prompt modal must revert to setup notice after signing out');
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
    if (chromeChild) await chromeChild.close();
    await appServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
