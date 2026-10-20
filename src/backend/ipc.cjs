"use strict";

const { validateSafeHttpUrl } = require("../shared/company-draft.cjs");

const SECRET_PATTERN =
  /(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|bearer\s|code[_-]?verifier|client[_-]?secret|api[_-]?key|eyJ[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{10,})/i;
const JAPANESE_CHAR_PATTERN = /[\u3040-\u30ff\u4e00-\u9fff]/;

function redactSecrets(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_KEY]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /((?:access_token|refresh_token|id_token|code_verifier|client_secret|api_key)["'\s:=]+)[^\s"',}&]+/gi,
      "$1[REDACTED]"
    );
}

function sanitizeErrorMessage(error, fallback = "操作に失敗しました。もう一度お試しください。") {
  let raw = "";
  if (error instanceof Error && typeof error.message === "string") {
    raw = error.message;
  } else if (typeof error === "string") {
    raw = error;
  }
  const trimmed = raw.trim();
  if (!trimmed || SECRET_PATTERN.test(trimmed)) {
    return fallback;
  }
  if (JAPANESE_CHAR_PATTERN.test(trimmed)) {
    return trimmed.slice(0, 400);
  }
  return fallback;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenKeys(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return true;
    }
    if (typeof obj[key] === "object" && obj[key] !== null && hasForbiddenKeys(obj[key])) {
      return true;
    }
  }
  return false;
}

function validateExternalHttpsUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("開くURLを指定してください。");
  }
  const validated = validateSafeHttpUrl(rawUrl, "外部URL", false);
  if (!validated) {
    throw new Error("外部ブラウザで開けるのは https:// のURLのみです。");
  }
  return validated;
}

function createIpcDispatcher({ chatgptService, profileStore, updater, openExternal, appSettingsService, aiAgents, copilotService }) {
  const assertNoArg = (arg, methodName) => {
    if (arg !== undefined && arg !== null) {
      throw new Error(`${methodName} に不要な引数は指定できません。`);
    }
  };

  const handlers = Object.freeze({
    getCopilotStatus: async (arg) => { assertNoArg(arg, 'getCopilotStatus'); return copilotService.getStatus(); },
    configureCopilot: async (arg) => { if (!isPlainObject(arg) || hasForbiddenKeys(arg)) throw new Error('Copilot設定が不正です。'); return copilotService.configure(arg); },
    beginCopilotLogin: async (arg) => { assertNoArg(arg, 'beginCopilotLogin'); return copilotService.beginLogin(); },
    cancelCopilotLogin: async (arg) => { assertNoArg(arg, 'cancelCopilotLogin'); return copilotService.cancelLogin(); },
    signOutCopilot: async (arg) => { assertNoArg(arg, 'signOutCopilot'); return copilotService.signOut(); },
    getCopilotDetails: async (arg) => { assertNoArg(arg, 'getCopilotDetails'); return copilotService.details(); },
    generateWithCopilot: async (arg) => { if (!isPlainObject(arg) || hasForbiddenKeys(arg)) throw new Error('Copilot生成入力が不正です。'); return copilotService.generate(arg); },
    cancelCopilotGeneration: async (arg) => { assertNoArg(arg, 'cancelCopilotGeneration'); return copilotService.cancelGenerate(); },
    getAiAgents: async (arg) => { assertNoArg(arg, 'getAiAgents'); return { providers: aiAgents.catalog(), agents: aiAgents.list() }; },
    saveAiAgent: async (arg) => { if (!isPlainObject(arg) || hasForbiddenKeys(arg)) throw new Error('登録内容が不正です。'); return aiAgents.save(arg); },
    removeAiAgent: async (arg) => { if (!isPlainObject(arg) || hasForbiddenKeys(arg)) throw new Error('登録IDが不正です。'); return aiAgents.remove(arg); },
    generateWithAiAgent: async (arg) => { if (!isPlainObject(arg) || hasForbiddenKeys(arg)) throw new Error('生成内容が不正です。'); return aiAgents.generate(arg); },
    cancelAiAgentGeneration: async (arg) => { assertNoArg(arg, 'cancelAiAgentGeneration'); return aiAgents.cancel(); },
    getAppSettings: async (arg) => {
      assertNoArg(arg, 'getAppSettings');
      return appSettingsService.get();
    },
    saveAppSettings: async (arg) => {
      if (!isPlainObject(arg) || hasForbiddenKeys(arg)) throw new Error('アプリ設定の形式が不正です。');
      return appSettingsService.update(arg);
    },
    getUpdateStatus: async (arg) => {
      assertNoArg(arg, "getUpdateStatus");
      return updater.getStatus();
    },
    checkForUpdates: async (arg) => {
      assertNoArg(arg, "checkForUpdates");
      return updater.check();
    },
    downloadUpdate: async (arg) => {
      assertNoArg(arg, "downloadUpdate");
      return updater.download();
    },
    installUpdate: async (arg) => {
      assertNoArg(arg, "installUpdate");
      return updater.install();
    },
    getSession: async (arg) => {
      assertNoArg(arg, "getSession");
      return chatgptService.getSession();
    },
    signIn: async (arg) => {
      assertNoArg(arg, "signIn");
      return chatgptService.signIn();
    },
    cancelSignIn: async (arg) => {
      assertNoArg(arg, "cancelSignIn");
      return chatgptService.cancelSignIn();
    },
    signOut: async (arg) => {
      assertNoArg(arg, "signOut");
      return chatgptService.signOut();
    },
    listModels: async (arg) => {
      assertNoArg(arg, "listModels");
      return chatgptService.listModels();
    },
    generate: async (arg) => {
      if (!isPlainObject(arg) || hasForbiddenKeys(arg)) {
        throw new Error("生成リクエストの形式が不正です。");
      }
      const allowedKeys = new Set(["model", "input", "instructions", "webSearch"]);
      for (const k of Object.keys(arg)) {
        if (!allowedKeys.has(k)) {
          throw new Error(`許可されていないパラメータが含まれています: ${k}`);
        }
      }
      return chatgptService.generate(arg);
    },
    cancelGenerate: async (arg) => {
      assertNoArg(arg, "cancelGenerate");
      return chatgptService.cancelGenerate();
    },
    openUsage: async (arg) => {
      assertNoArg(arg, "openUsage");
      return chatgptService.openUsage();
    },
    openExternalUrl: async (arg) => {
      if (!isPlainObject(arg) || hasForbiddenKeys(arg)) {
        throw new Error("URL指定の形式が不正です。");
      }
      const safeUrl = validateExternalHttpsUrl(arg.url);
      if (typeof openExternal === "function") {
        await openExternal(safeUrl);
      }
      return { opened: true, url: safeUrl };
    },
    getCareerProfile: async (arg) => {
      assertNoArg(arg, "getCareerProfile");
      return profileStore.getProfile();
    },
    saveCareerProfile: async (arg) => {
      if (!isPlainObject(arg) || hasForbiddenKeys(arg)) {
        throw new Error("プロフィールデータの形式が不正です。");
      }
      const allowedKeys = new Set([
        "version",
        "completed",
        "major",
        "industries",
        "roles",
        "priorities",
        "strengths",
      ]);
      for (const k of Object.keys(arg)) {
        if (!allowedKeys.has(k)) {
          throw new Error(`許可されていないプロフィール項目です: ${k}`);
        }
      }
      return profileStore.saveProfile(arg);
    },
  });

  async function invoke(method, argument) {
    if (typeof method !== "string" || !Object.hasOwn(handlers, method)) {
      throw new Error("許可されていないIPC操作です。");
    }
    try {
      const result = await handlers[method](argument);
      return result === undefined ? null : result;
    } catch (err) {
      throw new Error(sanitizeErrorMessage(err));
    }
  }

  return Object.freeze({
    allowedMethods: Object.freeze(Object.keys(handlers)),
    invoke,
  });
}

module.exports = {
  SECRET_PATTERN,
  redactSecrets,
  sanitizeErrorMessage,
  isPlainObject,
  hasForbiddenKeys,
  validateExternalHttpsUrl,
  createIpcDispatcher,
};
