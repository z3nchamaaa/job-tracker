(function () {
  'use strict';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  function apply(theme = root.dataset.theme, accent = root.dataset.accent) {
    root.dataset.theme = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
    root.dataset.accent = ['purple', 'blue', 'green', 'rose'].includes(accent) ? accent : 'purple';
    const mode = root.dataset.theme === 'system' ? (system.matches ? 'dark' : 'light') : root.dataset.theme;
    root.dataset.colorMode = mode;
    root.style.colorScheme = mode;
    window.webkit?.messageHandlers?.appearance?.postMessage({ mode, theme: root.dataset.theme });
    window.chrome?.webview?.postMessage({ type: 'appearance', mode });
  }
  system.addEventListener('change', () => apply());
  window.JobTrackerAppearance = Object.freeze({ apply });
  apply();
})();
