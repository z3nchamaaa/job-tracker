(function () {
  'use strict';

  const ALLOWED_METHODS = Object.freeze([
    'getAiAgents', 'saveAiAgent', 'removeAiAgent', 'generateWithAiAgent', 'cancelAiAgentGeneration',
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
