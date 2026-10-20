"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const KEYCHAIN_SERVICE = "jp.jobtracker.app.auth";
const KEYCHAIN_ACCOUNT = "aes-gcm-master-key-v1";

function encryptAesGcm(keyBuffer, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: "JT01" (4B) + iv (12B) + tag (16B) + ciphertext
  return Buffer.concat([Buffer.from("JT01", "ascii"), iv, tag, encrypted]);
}

function decryptAesGcm(keyBuffer, packet) {
  const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  if (buf.length < 32 || buf.subarray(0, 4).toString("ascii") !== "JT01") {
    throw new Error("Invalid encrypted payload header");
  }
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * ネイティブホストバイナリ（macOS Security.framework / Windows DPAPI）の --protect / --unprotect を呼び出す。
 */
function createHostBinaryStorage(hostBinaryPath) {
  const transform = (mode, inputText) => {
    const res = spawnSync(hostBinaryPath, [mode], {
      input: inputText,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    if (res.error || res.status !== 0) {
      throw new Error("OSの資格情報保護機能を利用できません。");
    }
    return res.stdout.trim();
  };

  return {
    isEncryptionAvailable() {
      try {
        const probe = transform("--protect", "availability-check");
        return Boolean(probe);
      } catch {
        return false;
      }
    },
    encryptString(plaintext) {
      return Buffer.from(transform("--protect", plaintext), "base64");
    },
    decryptString(buffer) {
      return transform("--unprotect", Buffer.from(buffer).toString("base64"));
    },
  };
}

// The macOS CLI cannot safely provision a key without exposing it in argv.
// Authentication therefore requires the bundled native Security.framework helper.
function unavailableStorage(message = "OSの暗号化機能が利用できません。") {
  return {
    isEncryptionAvailable: () => false,
    encryptString() { throw new Error(message); },
    decryptString() { throw new Error(message); },
  };
}

function createMacKeychainStorage(hostBinaryPath) {
  return hostBinaryPath ? createHostBinaryStorage(hostBinaryPath)
    : unavailableStorage("認証にはmacOS版アプリのネイティブ保護機能が必要です。プロンプトのコピーは利用できます。");
}

/**
 * Linux libsecret (secret-tool) にマスター鍵を保管し、AES-256-GCM で暗号化・復号する。
 */
function createLinuxSecretToolStorage(options = {}) {
  const run = options.spawnSync || spawnSync;
  let cachedKey = null;

  const getOrCreateKey = () => {
    if (cachedKey) return cachedKey;
    const lookup = run(
      "secret-tool",
      ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      { encoding: "utf8", timeout: 5000 }
    );
    if (lookup.status === 0) {
      const hex = String(lookup.stdout || "").trim();
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("保管された暗号鍵の形式が不正です。既存の鍵は変更していません。");
      cachedKey = Buffer.from(hex, "hex");
      return cachedKey;
    }
    // secret-tool: exit 1 with empty stdout/stderr is an absent item.
    // Service errors, permission errors and timeouts must never replace a key.
    if (lookup.error || lookup.status !== 1 || String(lookup.stderr || "").trim() || String(lookup.stdout || "").trim()) {
      throw new Error("シークレットサービスの鍵を読み取れません。既存の鍵は保持されています。");
    }
    const newKeyHex = crypto.randomBytes(32).toString("hex");
    const store = run(
      "secret-tool",
      [
        "store",
        "--label=JobTracker Auth Key",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        KEYCHAIN_ACCOUNT,
      ],
      { input: newKeyHex, encoding: "utf8", timeout: 5000 }
    );
    if (store.status !== 0) {
      throw new Error("Linuxのシークレットサービス（libsecret）を利用できません。");
    }
    cachedKey = Buffer.from(newKeyHex, "hex");
    return cachedKey;
  };

  return {
    isEncryptionAvailable() {
      if (process.platform !== "linux") return false;
      try {
        getOrCreateKey();
        return true;
      } catch {
        return false;
      }
    },
    encryptString(plaintext) {
      return encryptAesGcm(getOrCreateKey(), plaintext);
    },
    decryptString(buffer) {
      return decryptAesGcm(getOrCreateKey(), buffer);
    },
  };
}

function createDefaultSafeStorage(options = {}) {
  if (options.safeStorage) return options.safeStorage;
  if (options.hostBinaryPath) return createHostBinaryStorage(options.hostBinaryPath);
  if (process.env.JOB_TRACKER_HOST) return createHostBinaryStorage(process.env.JOB_TRACKER_HOST);
  if (process.platform === "darwin") return createMacKeychainStorage();
  if (process.platform === "linux") return createLinuxSecretToolStorage();
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("OSの暗号化機能が利用できません。");
    },
    decryptString: () => {
      throw new Error("OSの暗号化機能が利用できません。");
    },
  };
}

module.exports = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  encryptAesGcm,
  decryptAesGcm,
  createHostBinaryStorage,
  createMacKeychainStorage,
  createLinuxSecretToolStorage,
  createDefaultSafeStorage,
};
