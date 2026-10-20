"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  DatabaseStore,
  DatabaseValidationError,
  DatabaseCorruptionError,
} = require("./db.cjs");
const { CareerProfileStore } = require("./career-profile-store.cjs");
const { createDefaultSafeStorage } = require("./credential-store.cjs");
const { ChatGPTService } = require("./chatgpt.cjs");
const { AppUpdater } = require("./updater.cjs");
const {
  createIpcDispatcher,
  sanitizeErrorMessage,
  hasForbiddenKeys,
} = require("./ipc.cjs");
const { EventInputError } = require("../shared/event-input.cjs");
const { AppSettingsStore, createNativeAppAuth, createAppSettingsService } = require('./app-settings.cjs');
const { AiAgents } = require('./ai-agents.cjs');

const MAX_JSON_BODY_BYTES = 60 * 1024 * 1024; // 60 MiB (allows up to 50MiB base64 SQLite import)
const DEFAULT_BODY_LIMIT = 512 * 1024; // 512 KiB for normal API requests

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

function timingSafeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function readJsonBody(req, maxBytes = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new DatabaseValidationError("リクエストサイズが上限を超えています。"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        if (hasForbiddenKeys(parsed)) {
          reject(new DatabaseValidationError("不正なキーが含まれています。"));
          return;
        }
        resolve(parsed);
      } catch (err) {
        if (err instanceof DatabaseValidationError) {
          reject(err);
        } else {
          reject(new DatabaseValidationError("入力JSONの形式が正しくありません。"));
        }
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function createAppServer(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir || typeof dataDir !== "string") {
    throw new Error("dataDir is required");
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const settingsStore = options.settingsStore || new AppSettingsStore(dataDir);
  if (settingsStore.read().lockOnStartup && options.startupAuthenticated !== true) {
    throw new Error('起動時ロックの認証が必要です。ネイティブアプリから起動してください。');
  }
  const appAuth = options.appAuth || createNativeAppAuth({ hostBinaryPath: options.hostBinaryPath });
  const appSettingsService = createAppSettingsService(settingsStore, appAuth);

  const authDir = path.join(dataDir, "auth");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const desktopToken = options.desktopToken || crypto.randomBytes(32).toString("hex");
  const sessionCookieToken = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const bootstrapNonce = crypto.randomBytes(24).toString("hex");

  const profileStore = options.profileStore || new CareerProfileStore(dataDir);
  const dbStore = options.dbStore || new DatabaseStore({ dataDir, profileStore });
  const safeStorage = createDefaultSafeStorage({
    safeStorage: options.safeStorage,
    hostBinaryPath: options.hostBinaryPath,
  });

  const openExternal =
    options.openExternal ||
    (async (rawUrl) => {
      if (typeof rawUrl !== "string") {
        throw new Error("URLが不正です。");
      }
      const trimmed = rawUrl.trim();
      if (!trimmed || trimmed.startsWith("-") || /[\u0000-\u001f\u007f\s"]/.test(trimmed)) {
        throw new Error("不正なURL形式です。");
      }
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error("不正なURL形式です。");
      }
      if (
        parsed.protocol !== "https:" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        !parsed.hostname
      ) {
        throw new Error("外部ブラウザで開けるのは認証情報を含まない https:// のURLのみです。");
      }
      const safeHref = parsed.toString();
      const { spawn } = require("node:child_process");
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
          ? "explorer.exe"
          : "xdg-open";
      const args = process.platform === "darwin" ? ["--", safeHref] : [safeHref];
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    });

  const chatgptService =
    options.chatgptService ||
    new ChatGPTService({
      userDataPath: authDir,
      safeStorage,
      openExternal,
      fetch: options.fetch,
      jwtVerify: options.jwtVerify,
      createRemoteJWKSet: options.createRemoteJWKSet,
    });

  const updater =
    options.updater ||
    new AppUpdater({
      version: options.version || "2.0.0",
      userDataPath: dataDir,
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
      fetch: options.fetch,
      repo: options.updateRepo,
      apiUrl: options.updateApiUrl,
      allowLoopbackTest: options.allowLoopbackTest,
      openInstaller: options.openInstaller || (async (file) => {
        const { spawn } = require("node:child_process");
        const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? file : "xdg-open";
        const args = process.platform === "win32" ? [] : [file];
        await new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: "ignore", windowsHide: true, shell: false });
          child.once("error", () => reject(new Error("インストーラーを開けませんでした。")));
          if (process.platform === "win32") child.once("spawn", resolve);
          else child.once("close", (code) => code === 0 ? resolve() : reject(new Error("インストーラーを開けませんでした。")));
        });
        return { opened: true };
      }),
    });

  const aiAgents = new AiAgents({ dataDir: authDir, safeStorage, fetch: options.agentFetch || options.fetch || globalThis.fetch });
  const ipcDispatcher = createIpcDispatcher({
    aiAgents,
    appSettingsService,
    chatgptService,
    profileStore,
    updater,
    openExternal,
  });

  const uiDir = options.uiDir || path.resolve(__dirname, "../ui");
  const iconsDir = options.iconsDir || path.resolve(__dirname, "../../assets/icons");
  const sharedDir = options.sharedDir || path.resolve(__dirname, "../shared");

  let boundPort = null;
  let testKeepAliveRes = null;

  function setSecurityHeaders(res) {
    res.setHeader("Content-Security-Policy", CSP_HEADER);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
  }

  function sendJson(res, status, payload) {
    setSecurityHeaders(res);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  function validateHostAndOrigin(req) {
    const host = req.headers.host || "";
    const expectedHostWithPort = boundPort ? `127.0.0.1:${boundPort}` : "127.0.0.1";
    if (host !== expectedHostWithPort && host !== "127.0.0.1") {
      return { ok: false, status: 403, error: "Forbidden Host (DNS Rebinding Protection)" };
    }

    const secFetchSite = req.headers["sec-fetch-site"];
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return { ok: false, status: 403, error: "Cross-site request blocked" };
    }

    const origin = req.headers.origin;
    if (origin) {
      const expectedOrigin = `http://127.0.0.1:${boundPort}`;
      if (origin !== expectedOrigin) {
        return { ok: false, status: 403, error: "Invalid Origin" };
      }
    }

    return { ok: true };
  }

  function isAuthorizedApiRequest(req) {
    // 1. Direct desktop token header (used by native host & backend tests)
    const headerToken = req.headers["x-desktop-token"];
    if (typeof headerToken === "string" && timingSafeCompare(headerToken, desktopToken)) {
      return true;
    }

    // 2. Same-origin UI session cookie + CSRF header
    const cookies = parseCookies(req.headers.cookie);
    const cookieVal = cookies["__jt_session"];
    const csrfHeader = req.headers["x-jt-csrf"];
    if (
      typeof cookieVal === "string" &&
      typeof csrfHeader === "string" &&
      timingSafeCompare(cookieVal, sessionCookieToken) &&
      timingSafeCompare(csrfHeader, csrfToken)
    ) {
      return true;
    }

    return false;
  }

  function serveStaticFile(res, filePath, contentType) {
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }
    setSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(fs.readFileSync(filePath));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const hostCheck = validateHostAndOrigin(req);
      if (!hostCheck.ok) {
        sendJson(res, hostCheck.status, { error: hostCheck.error });
        return;
      }

      const urlObj = new URL(req.url, `http://127.0.0.1:${boundPort || 80}`);
      const pathname = urlObj.pathname;
      const method = req.method || "GET";

      // Static & UI routes
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const queryBootstrap = urlObj.searchParams.get("bootstrap");
        const headerToken = req.headers["x-desktop-token"];
        const cookies = parseCookies(req.headers.cookie);
        const hasValidCookie =
          typeof cookies["__jt_session"] === "string" &&
          timingSafeCompare(cookies["__jt_session"], sessionCookieToken);
        const isDirectBootstrap =
          (typeof queryBootstrap === "string" &&
            timingSafeCompare(queryBootstrap, bootstrapNonce)) ||
          (typeof headerToken === "string" && timingSafeCompare(headerToken, desktopToken)) ||
          Boolean(options.allowDevBrowserSession);

        if (!hasValidCookie && !isDirectBootstrap) {
          sendJson(res, 401, { error: "Desktop session required" });
          return;
        }

        const htmlPath = path.join(uiDir, "index.html");
        if (!fs.existsSync(htmlPath)) {
          sendJson(res, 500, { error: "UI bundle not found" });
          return;
        }

        let html = fs
          .readFileSync(htmlPath, "utf8")
          .replace("__JT_CSRF_TOKEN__", csrfToken)
          .replace('__JT_THEME__', settingsStore.read().theme)
          .replace('__JT_ACCENT__', settingsStore.read().accent);

        if (typeof options.testDriverScript === "string" && options.testDriverScript.length > 0) {
          html = html.replace(
            "</body>",
            '  <script src="/__test_driver.js"></script>\n  <img src="/__test_keepalive.png" style="display:none" alt="">\n</body>'
          );
        }

        setSecurityHeaders(res);
        res.setHeader(
          "Set-Cookie",
          `__jt_session=${sessionCookieToken}; HttpOnly; SameSite=Strict; Path=/`
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (
        method === "GET" &&
        pathname === "/__test_driver.js" &&
        typeof options.testDriverScript === "string"
      ) {
        setSecurityHeaders(res);
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(options.testDriverScript);
        return;
      }

      if (
        method === "GET" &&
        pathname === "/__test_keepalive.png" &&
        typeof options.testDriverScript === "string"
      ) {
        testKeepAliveRes = res;
        return;
      }

      if (method === "GET" && pathname === "/styles.css") {
        serveStaticFile(res, path.join(uiDir, "styles.css"), "text/css; charset=utf-8");
        return;
      }

      if (method === "GET" && pathname === "/app.js") {
        serveStaticFile(res, path.join(uiDir, "app.js"), "application/javascript; charset=utf-8");
        return;
      }

      if (method === 'GET' && pathname === '/theme.js') {
        serveStaticFile(res, path.join(uiDir, 'theme.js'), 'application/javascript; charset=utf-8');
        return;
      }

      if (method === "GET" && pathname.startsWith("/shared/")) {
        const fileName = path.basename(pathname);
        if (!/^[a-z0-9-]+\.cjs$/i.test(fileName)) {
          sendJson(res, 404, { error: "Not Found" });
          return;
        }
        serveStaticFile(
          res,
          path.join(sharedDir, fileName),
          "application/javascript; charset=utf-8"
        );
        return;
      }

      if (method === "GET" && (pathname === "/app-icon.png" || pathname === "/favicon.ico")) {
        const iconFile =
          pathname === "/favicon.ico"
            ? path.join(iconsDir, "app-icon.ico")
            : path.join(iconsDir, "app-icon.png");
        const mime = pathname === "/favicon.ico" ? "image/x-icon" : "image/png";
        serveStaticFile(res, iconFile, mime);
        return;
      }

      // All /api/* routes require strict authorization
      if (pathname.startsWith("/api/")) {
        if (!isAuthorizedApiRequest(req)) {
          sendJson(res, 401, { error: "Desktop Auth required" });
          return;
        }

        if (
          pathname === "/api/__test_report" &&
          method === "POST" &&
          typeof options.onTestReport === "function"
        ) {
          const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
          sendJson(res, 200, { ok: true });
          if (testKeepAliveRes && !testKeepAliveRes.writableEnded) {
            testKeepAliveRes.writeHead(204);
            testKeepAliveRes.end();
            testKeepAliveRes = null;
          }
          options.onTestReport(body);
          return;
        }

        if (!['/api/system/status', '/api/system/recover-db'].includes(pathname)) {
          dbStore._recoverPendingImport();
        }

        // IPC route for desktop bridge
        if (pathname === "/api/desktop/ipc" && method === "POST") {
          const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
          if (!body || typeof body.method !== "string") {
            sendJson(res, 400, { error: "IPCメソッドが指定されていません。" });
            return;
          }
          try {
            const result = await ipcDispatcher.invoke(body.method, body.argument);
            sendJson(res, 200, { ok: true, result });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: sanitizeErrorMessage(err) });
          }
          return;
        }

        // System / DB health & recovery & backup & import routes
        if (pathname === "/api/system/status" && method === "GET") {
          sendJson(res, 200, {
            success: true,
            db: dbStore.getStatus(),
          });
          return;
        }

        if (pathname === "/api/system/recover-db" && method === "POST") {
          const result = dbStore.recoverCorruptDatabase();
          sendJson(res, 200, { success: true, ...result });
          return;
        }

        if (pathname === "/api/data/backup" && method === "GET") {
          const profile = profileStore.getProfile();
          const backup = dbStore.exportBackup(profile);
          sendJson(res, 200, { success: true, backup });
          return;
        }

        if (pathname === "/api/data/import/preview" && method === "POST") {
          const body = await readJsonBody(req, MAX_JSON_BODY_BYTES);
          if (
            !body ||
            typeof body !== "object" ||
            body.kind === "sqlite_file" ||
            Object.prototype.hasOwnProperty.call(body, "filePath") ||
            Object.prototype.hasOwnProperty.call(body, "path")
          ) {
            sendJson(res, 400, {
              error: "ファイルパスの直接指定によるインポートは許可されていません。ファイル選択から読み込んでください。",
            });
            return;
          }
          const preview = dbStore.previewImport(body);
          const { normalizedData, ...publicPreview } = preview;
          sendJson(res, 200, { success: true, preview: publicPreview });
          return;
        }

        if (pathname === "/api/data/import/execute" && method === "POST") {
          const body = await readJsonBody(req, MAX_JSON_BODY_BYTES);
          if (
            !body ||
            typeof body !== "object" ||
            body.kind === "sqlite_file" ||
            Object.prototype.hasOwnProperty.call(body, "filePath") ||
            Object.prototype.hasOwnProperty.call(body, "path")
          ) {
            sendJson(res, 400, {
              error: "ファイルパスの直接指定によるインポートは許可されていません。ファイル選択から読み込んでください。",
            });
            return;
          }
          const result = dbStore.executeImport(body, body.mode || "replace");
          sendJson(res, 200, { success: true, ...result });
          return;
        }

        if (pathname === "/api/data/import/rollback" && method === "POST") {
          const result = dbStore.rollbackLastImport();
          sendJson(res, 200, { success: true, ...result });
          return;
        }

        // Companies collection
        if (pathname === "/api/companies" && method === "GET") {
          const companies = dbStore.listCompanies();
          sendJson(res, 200, { success: true, companies });
          return;
        }

        if (pathname === "/api/companies" && method === "POST") {
          const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
          const company = dbStore.createCompany(body);
          sendJson(res, 201, { success: true, company });
          return;
        }

        // Single company routes: /api/companies/:id or /api/companies/:id/impact
        const companyImpactMatch = /^\/api\/companies\/([^/]+)\/impact$/.exec(pathname);
        if (companyImpactMatch && method === "GET") {
          const id = decodeURIComponent(companyImpactMatch[1]);
          const impact = dbStore.getCompanyDeletionImpact(id);
          if (!impact) {
            sendJson(res, 404, { error: "企業が見つかりません。" });
            return;
          }
          sendJson(res, 200, { success: true, impact });
          return;
        }

        const companyMatch = /^\/api\/companies\/([^/]+)$/.exec(pathname);
        if (companyMatch) {
          const id = decodeURIComponent(companyMatch[1]);
          if (method === "GET") {
            const company = dbStore.getCompany(id);
            if (!company) {
              sendJson(res, 404, { error: "企業が見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, company });
            return;
          }
          if (method === "PATCH") {
            const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
            const updated = dbStore.updateCompany(id, body);
            if (!updated) {
              sendJson(res, 404, { error: "企業が見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, company: updated });
            return;
          }
          if (method === "DELETE") {
            const deletedImpact = dbStore.deleteCompany(id);
            if (!deletedImpact) {
              sendJson(res, 404, { error: "企業が見つかりません。" });
              return;
            }
            sendJson(res, 200, {
              success: true,
              message: "削除しました。",
              deletedImpact,
            });
            return;
          }
        }

        // SelectionSteps routes: POST /api/steps, PATCH /api/steps/:id, DELETE /api/steps/:id
        if (pathname === "/api/steps" && method === "POST") {
          const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
          const step = dbStore.createStep(body);
          sendJson(res, 201, { success: true, step });
          return;
        }

        const stepMatch = /^\/api\/steps\/([^/]+)$/.exec(pathname);
        if (stepMatch) {
          const id = decodeURIComponent(stepMatch[1]);
          if (method === "PATCH") {
            const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
            const step = dbStore.updateStep(id, body);
            if (!step) {
              sendJson(res, 404, { error: "選考ステップが見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, step });
            return;
          }
          if (method === "DELETE") {
            const ok = dbStore.deleteStep(id);
            if (!ok) {
              sendJson(res, 404, { error: "選考ステップが見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, message: "ステップを削除しました。" });
            return;
          }
        }

        // InterviewNotes routes: POST /api/interviews, PATCH /api/interviews/:id, DELETE /api/interviews/:id
        if (pathname === "/api/interviews" && method === "POST") {
          const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
          const note = dbStore.createInterviewNote(body);
          sendJson(res, 201, { success: true, note });
          return;
        }

        const interviewMatch = /^\/api\/interviews\/([^/]+)$/.exec(pathname);
        if (interviewMatch) {
          const id = decodeURIComponent(interviewMatch[1]);
          if (method === "PATCH") {
            const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
            const note = dbStore.updateInterviewNote(id, body);
            if (!note) {
              sendJson(res, 404, { error: "面接記録が見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, note });
            return;
          }
          if (method === "DELETE") {
            const ok = dbStore.deleteInterviewNote(id);
            if (!ok) {
              sendJson(res, 404, { error: "面接記録が見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, message: "面接記録を削除しました。" });
            return;
          }
        }

        // ScheduleEvents routes: GET /api/events, POST /api/events, PATCH /api/events/:id, DELETE /api/events/:id
        if (pathname === "/api/events" && method === "GET") {
          const events = dbStore.listEvents();
          sendJson(res, 200, { success: true, events });
          return;
        }

        if (pathname === "/api/events" && method === "POST") {
          const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
          const event = dbStore.createEvent(body);
          sendJson(res, 201, { success: true, event });
          return;
        }

        const eventMatch = /^\/api\/events\/([^/]+)$/.exec(pathname);
        if (eventMatch) {
          const id = decodeURIComponent(eventMatch[1]);
          if (method === "PATCH") {
            const body = await readJsonBody(req, DEFAULT_BODY_LIMIT);
            const event = dbStore.updateEvent(id, body);
            if (!event) {
              sendJson(res, 404, { error: "予定が見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, event });
            return;
          }
          if (method === "DELETE") {
            const ok = dbStore.deleteEvent(id);
            if (!ok) {
              sendJson(res, 404, { error: "予定が見つかりません。" });
              return;
            }
            sendJson(res, 200, { success: true, message: "予定を削除しました。" });
            return;
          }
        }

        sendJson(res, 404, { error: "APIエンドポイントが見つかりません。" });
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      if (err instanceof DatabaseValidationError || err instanceof EventInputError) {
        sendJson(res, 400, { error: sanitizeErrorMessage(err, "入力内容を確認してください。") });
        return;
      }
      if (err instanceof DatabaseCorruptionError) {
        sendJson(res, 503, {
          error: sanitizeErrorMessage(err),
          corrupt: true,
        });
        return;
      }
      sendJson(res, 500, { error: sanitizeErrorMessage(err, "サーバー内部エラーが発生しました。") });
    }
  });

  async function start(port = 0) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        boundPort = server.address().port;
        resolve();
      });
    });
    const origin = `http://127.0.0.1:${boundPort}`;
    return {
      port: boundPort,
      origin,
      bootstrapUrl: `${origin}/?bootstrap=${bootstrapNonce}`,
      desktopToken,
      csrfToken,
    };
  }

  async function stop() {
    aiAgents.cancel();
    try {
      if (updater && typeof updater.shutdown === "function") {
        updater.shutdown();
      }
    } catch {}
    try {
      if (chatgptService && typeof chatgptService.shutdown === "function") {
        chatgptService.shutdown();
      }
    } catch {}
    try {
      if (dbStore && typeof dbStore.close === "function") {
        dbStore.close();
      }
    } catch {}
    if (testKeepAliveRes && !testKeepAliveRes.writableEnded) {
      try {
        testKeepAliveRes.destroy();
      } catch {}
      testKeepAliveRes = null;
    }
    if (server.listening) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  }

  return {
    server,
    dbStore,
    profileStore,
    chatgptService,
    updater,
    ipcDispatcher,
    desktopToken,
    csrfToken,
    bootstrapNonce,
    start,
    stop,
  };
}

module.exports = {
  CSP_HEADER,
  createAppServer,
};
