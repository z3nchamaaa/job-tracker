#!/usr/bin/env node
'use strict';

require("./runtime.cjs").assertSupportedRuntime();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_ID } = require('../shared/constants.cjs');
const { createAppServer } = require('./server.cjs');
const { AppSettingsStore, createNativeAppAuth, authenticateStartup } = require('./app-settings.cjs');

function resolveDefaultDataDir() {
  if (process.env.JOB_TRACKER_DATA_DIR) {
    return path.resolve(process.env.JOB_TRACKER_DATA_DIR);
  }
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_ID);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, APP_ID);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdgConfig, APP_ID);
}

async function main() {
  const dataDir = resolveDefaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const requestedPort = process.env.JOB_TRACKER_PORT ? Number(process.env.JOB_TRACKER_PORT) : 0;
  const hostBinaryPath =
    process.env.JOB_TRACKER_HOST_BINARY && fs.existsSync(process.env.JOB_TRACKER_HOST_BINARY)
      ? path.resolve(process.env.JOB_TRACKER_HOST_BINARY)
      : undefined;

  const settingsStore = new AppSettingsStore(dataDir);
  const appAuth = createNativeAppAuth({ hostBinaryPath });
  // Authenticate before creating/opening the database or starting the HTTP server.
  await authenticateStartup(settingsStore, appAuth);
  const appServer = createAppServer({
    dataDir,
    settingsStore,
    appAuth,
    startupAuthenticated: true,
    hostBinaryPath,
    desktopToken: process.env.JOB_TRACKER_DESKTOP_TOKEN || undefined,
    allowDevBrowserSession: process.env.JOB_TRACKER_ALLOW_DEV_SESSION === '1',
  });

  const started = await appServer.start(requestedPort);

  process.stdout.write(
    JSON.stringify({
      status: 'listening',
      port: started.port,
      origin: started.origin,
      url: started.bootstrapUrl,
      dataDir,
    }) + '\n'
  );

  const shutdown = async () => {
    try {
      await appServer.stop();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('disconnect', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal startup error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  resolveDefaultDataDir,
  main,
};
