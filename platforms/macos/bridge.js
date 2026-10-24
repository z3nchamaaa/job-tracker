(function () {
  'use strict';

  const markNativeWindow = () => document.documentElement.classList.add('native-macos');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markNativeWindow, { once: true });
  else markNativeWindow();

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

  const desktopBridge = Object.freeze({
    isNativeHost: true,
    platform: 'darwin',
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
  });

  Object.defineProperty(window, 'desktopBridge', {
    value: desktopBridge,
    writable: false,
    configurable: false,
  });
})();
