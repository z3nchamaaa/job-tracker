(function () {
  'use strict';

  // Native WebView2 draggable regions preserve Windows' drag, double-click and
  // system-menu behavior. Keep every interactive control out of those regions.
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      .app-header { -webkit-app-region: drag; app-region: drag; user-select: none; }
      .app-header :is(button, a, input, select, textarea, [contenteditable], [tabindex]),
      .app-header .header-actions, .app-header .view-nav,
      body:has(.modal-root:not(.is-hidden)) .app-header {
        -webkit-app-region: no-drag; app-region: no-drag;
      }
    `;
    document.head.appendChild(style);
  }, { once: true });

  const ALLOWED_METHODS = Object.freeze([
    'getAiAgents', 'saveAiAgent', 'removeAiAgent', 'generateWithAiAgent', 'cancelAiAgentGeneration',
    'getGoogleDriveStatus', 'beginGoogleDriveLogin', 'cancelGoogleDriveLogin', 'cancelGoogleDriveTransfer', 'prepareGoogleDriveBackup', 'configureGoogleDrive', 'disconnectGoogleDrive', 'uploadGoogleDriveBackup', 'listGoogleDriveBackups', 'previewGoogleDriveBackup', 'restoreGoogleDriveBackup',
    'getCopilotStatus', 'installCopilotPack', 'cancelCopilotPack', 'removeCopilotPack', 'configureCopilot', 'beginCopilotLogin', 'cancelCopilotLogin', 'signOutCopilot', 'getCopilotDetails', 'generateWithCopilot', 'cancelCopilotGeneration',
    'getAppSettings',
    'saveAppSettings',
    'getUpdateStatus',
    'checkForUpdates',
    'downloadUpdate',
    'installUpdate',
    'getSession',
    'signIn',
    'cancelSignIn',
    'signOut',
    'listModels',
    'generate',
    'cancelGenerate',
    'openUsage',
    'openExternalUrl',
    'getCareerProfile',
    'saveCareerProfile',
  ]);

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="jt-csrf"]');
    return meta ? meta.getAttribute('content') || '' : '';
  }

  Object.defineProperty(window, 'desktopBridge', {
    value: Object.freeze({
      isNativeHost: true,
      platform: 'win32',
      allowedMethods: ALLOWED_METHODS,
      async invoke(method, argument = undefined) {
        if (!ALLOWED_METHODS.includes(method)) {
          throw new Error('許可されていないIPC操作です: ' + String(method));
        }
        const res = await fetch('/api/desktop/ipc', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-jt-csrf': getCsrfToken(),
          },
          credentials: 'same-origin',
          body: JSON.stringify({ method, argument }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || 'IPC呼び出しに失敗しました');
        }
        return data.result;
      },
    }),
    writable: false,
    configurable: false,
  });
})();
