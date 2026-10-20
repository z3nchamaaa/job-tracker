"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_JWT_ALGS = Object.freeze({
  RS256: { digest: "sha256", dsaEncoding: undefined },
  RS384: { digest: "sha384", dsaEncoding: undefined },
  RS512: { digest: "sha512", dsaEncoding: undefined },
  ES256: { digest: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { digest: "sha384", dsaEncoding: "ieee-p1363" },
  ES512: { digest: "sha512", dsaEncoding: "ieee-p1363" },
});

function decodeBase64UrlJson(segment) {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JWT segment");
  }
  return parsed;
}

/**
 * Node.js 標準の node:crypto を用いた OIDC ID トークン (JWS) 検証。
 * 外部パッケージ (jose) に依存せず JWKS の公開鍵で署名とクレームを検証する。
 */
async function defaultJwtVerify(token, jwksSource, options = {}) {
  if (typeof token !== "string") throw new Error("Invalid JWT token");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Invalid JWT structure");
  }

  const header = decodeBase64UrlJson(parts[0]);
  const payload = decodeBase64UrlJson(parts[1]);
  const signature = Buffer.from(parts[2], "base64url");
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");

  const algSpec = ALLOWED_JWT_ALGS[header.alg];
  if (!algSpec) {
    throw new Error(`Unsupported JWT algorithm: ${String(header.alg)}`);
  }

  const keys = typeof jwksSource === "function" ? await jwksSource(header) : jwksSource;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("No JWKS keys available");
  }

  const candidates = keys.filter((k) => {
    if (!k || typeof k !== "object") return false;
    if (header.kid && k.kid && k.kid !== header.kid) return false;
    if (k.use && k.use !== "sig") return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new Error("Matching JWK not found");
  }

  let verified = false;
  for (const jwk of candidates) {
    try {
      const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
      const verifyOpts = algSpec.dsaEncoding
        ? { key: pubKey, dsaEncoding: algSpec.dsaEncoding }
        : pubKey;
      if (crypto.verify(algSpec.digest, signingInput, verifyOpts, signature)) {
        verified = true;
        break;
      }
    } catch {}
  }

  if (!verified) {
    throw new Error("JWT signature verification failed");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const clockTolerance = 60;

  if (options.requiredClaims) {
    for (const claim of options.requiredClaims) {
      if (payload[claim] === undefined || payload[claim] === null || payload[claim] === "") {
        throw new Error(`Missing required claim: ${claim}`);
      }
    }
  }

  if (options.issuer && payload.iss !== options.issuer) {
    throw new Error("JWT issuer mismatch");
  }

  if (options.audience) {
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(options.audience)) {
      throw new Error("JWT audience mismatch");
    }
  }

  if (typeof payload.exp !== "number" || payload.exp + clockTolerance <= nowSec) {
    throw new Error("JWT has expired");
  }

  if (typeof payload.iat !== "number") {
    throw new Error("JWT missing valid iat");
  }

  if (typeof payload.nbf === "number" && payload.nbf - clockTolerance > nowSec) {
    throw new Error("JWT is not yet valid");
  }

  return { payload, protectedHeader: header };
}

function defaultCreateRemoteJWKSet(jwksUrl, fetchFn = fetch) {
  return async () => {
    const res = await fetchFn(jwksUrl.toString(), { redirect: "error" });
    if (!res.ok) throw new Error("Failed to fetch JWKS");
    const body = await res.json();
    if (!body || !Array.isArray(body.keys)) throw new Error("Invalid JWKS response");
    return body.keys;
  };
}

class ChatGPTService {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath;
    if (!this.userDataPath || typeof this.userDataPath !== "string") {
      throw new Error("userDataPath is required");
    }
    fs.mkdirSync(this.userDataPath, { recursive: true, mode: 0o700 });

    this.openExternal = options.openExternal;
    this.safeStorage = options.safeStorage;
    if (!this.safeStorage) {
      throw new Error("OSの暗号化機能（safeStorage）が利用できません。");
    }

    this.fetch = options.fetch || fetch;
    this.jwtVerify = options.jwtVerify || defaultJwtVerify;
    this.createRemoteJWKSet =
      options.createRemoteJWKSet || ((url) => defaultCreateRemoteJWKSet(url, this.fetch));

    this.authFilePath = path.join(this.userDataPath, "auth.enc");
    this.hostIdFilePath = path.join(this.userDataPath, "host_id.txt");

    this.pendingLogin = null;
    this.generateAbortController = null;
    this.refreshPromise = null;
    this.refreshAbortController = null;

    this.authLoadError = null;
    this.epoch = 0;

    this.hostId = this._loadHostId();
    this.authData = this._loadAuth();
  }

  _loadHostId() {
    if (fs.existsSync(this.hostIdFilePath)) {
      const existing = fs.readFileSync(this.hostIdFilePath, "utf-8").trim();
      if (/^urn:uuid:[0-9a-f-]{36}$/i.test(existing)) {
        return existing;
      }
    }
    const newId = `urn:uuid:${crypto.randomUUID()}`;
    fs.writeFileSync(this.hostIdFilePath, newId, { encoding: "utf-8", mode: 0o600 });
    return newId;
  }

  _loadAuth() {
    if (!fs.existsSync(this.authFilePath)) return null;

    if (this.safeStorage && !this.safeStorage.isEncryptionAvailable()) {
      this.authLoadError = new Error(
        "OSの暗号化機能が利用できません。アプリの権限等を確認してください。"
      );
      return null;
    }

    try {
      const encrypted = fs.readFileSync(this.authFilePath);
      const decrypted = this.safeStorage.decryptString(encrypted);
      const data = JSON.parse(decrypted);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Invalid format");
      }
      if (data.access_token && typeof data.access_token !== "string") {
        throw new Error("Invalid token");
      }
      if (data.clientId && typeof data.clientId !== "string") {
        throw new Error("Invalid clientId");
      }
      return data;
    } catch {
      this.authLoadError = new Error(
        "認証データの復号に失敗しました。キーチェーン等が変更された可能性があります。"
      );
      return null;
    }
  }

  _saveAuth(data, currentEpoch) {
    if (currentEpoch !== undefined && currentEpoch !== this.epoch) {
      throw new Error("stale epoch");
    }

    if (this.safeStorage && !this.safeStorage.isEncryptionAvailable()) {
      throw new Error("OSの暗号化機能が利用できないため、認証データを保存できません。");
    }

    const encrypted = this.safeStorage.encryptString(JSON.stringify(data));
    const tempPath = `${this.authFilePath}.tmp`;

    fs.writeFileSync(tempPath, encrypted, { mode: 0o600 });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {}
    fs.renameSync(tempPath, this.authFilePath);
    this.authData = data;
    this.authLoadError = null;
  }

  _hasSharingGrant(scopes) {
    if (!scopes || !Array.isArray(scopes)) return false;
    return scopes.includes("chatgpt.tokens.use.direct") && scopes.includes("resource.invoke");
  }

  getSession() {
    if (this.authLoadError) {
      return {
        connected: false,
        sharing: false,
        needsReauthentication: true,
        authError: this.authLoadError.message,
      };
    }
    if (!this.authData) {
      return { connected: false, sharing: false, email: undefined };
    }
    const hasTokens = Boolean(this.authData.access_token || this.authData.refresh_token);
    return {
      connected: hasTokens,
      sharing: hasTokens ? this._hasSharingGrant(this.authData.scopes) : false,
      email: typeof this.authData.email === "string" ? this.authData.email : undefined,
    };
  }

  shutdown() {
    this.epoch++;
    if (this.generateAbortController) {
      this.generateAbortController.abort();
      this.generateAbortController = null;
    }
    if (this.refreshAbortController) {
      this.refreshAbortController.abort();
      this.refreshAbortController = null;
    }
    this.refreshPromise = null;
    if (this.pendingLogin) {
      if (this.pendingLogin.timeoutId) clearTimeout(this.pendingLogin.timeoutId);
      if (this.pendingLogin.ac) this.pendingLogin.ac.abort();
      this.pendingLogin.reject(new Error("シャットダウンによりキャンセルされました。"));
      if (this.pendingLogin.server) this.pendingLogin.server.close();
      this.pendingLogin = null;
    }
  }

  cancelGenerate() {
    if (this.generateAbortController) {
      this.generateAbortController.abort();
      this.generateAbortController = null;
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  async signOut() {
    this.epoch++;
    if (this.generateAbortController) {
      this.generateAbortController.abort();
      this.generateAbortController = null;
    }
    if (this.refreshAbortController) {
      this.refreshAbortController.abort();
      this.refreshAbortController = null;
    }
    this.refreshPromise = null;
    if (this.pendingLogin) {
      if (this.pendingLogin.timeoutId) clearTimeout(this.pendingLogin.timeoutId);
      if (this.pendingLogin.ac) this.pendingLogin.ac.abort();
      this.pendingLogin.reject(new Error("サインアウトによりキャンセルされました。"));
      if (this.pendingLogin.server) this.pendingLogin.server.close();
      this.pendingLogin = null;
    }

    if (this.authLoadError) {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error(
          "OSの暗号化機能が利用できません。キーチェーン等を利用できる状態にしてから再ログインしてください。保存済みの認証情報は変更していません。"
        );
      }
      try {
        fs.unlinkSync(this.authFilePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(
            "保存済みの認証情報を削除できませんでした。アプリの保存先の権限を確認してください。"
          );
        }
      }
      this.authData = null;
      this.authLoadError = null;
      return { remoteRevoked: false };
    }

    if (!this.authData) {
      return { remoteRevoked: true };
    }

    const snapshotAuthData = this.authData;

    this._saveAuth(
      {
        clientId: snapshotAuthData.clientId,
        sub: snapshotAuthData.sub,
        issuer: snapshotAuthData.issuer,
        email: snapshotAuthData.email,
      },
      this.epoch
    );

    if (!snapshotAuthData.refresh_token) {
      return { remoteRevoked: true };
    }

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 8000);

    let remoteRevoked = false;
    try {
      let discoEndpoint = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const discoRes = await this.fetch(
            "https://auth.openai.com/.well-known/openid-configuration",
            {
              redirect: "error",
              signal: ac.signal,
            }
          );
          if (discoRes.ok) {
            const discoData = await discoRes.json();
            discoEndpoint = discoData.revocation_endpoint;
            break;
          }
          if (discoRes.status >= 500) throw new Error("server error");
          break;
        } catch {
          if (attempt === 0 && !ac.signal.aborted) {
            await new Promise((r) => setTimeout(r, 500));
          } else {
            break;
          }
        }
      }

      if (
        discoEndpoint &&
        typeof discoEndpoint === "string" &&
        discoEndpoint.startsWith("https://")
      ) {
        const parsedEndpoint = new URL(discoEndpoint);
        if (parsedEndpoint.hostname === "auth.openai.com") {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const revRes = await this.fetch(discoEndpoint, {
                method: "POST",
                redirect: "error",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  token: snapshotAuthData.refresh_token,
                  token_type_hint: "refresh_token",
                  client_id: snapshotAuthData.clientId,
                }),
                signal: ac.signal,
              });
              if (revRes.ok) {
                remoteRevoked = true;
                break;
              }
              if (revRes.status >= 500) throw new Error("server error");
              break;
            } catch {
              if (attempt === 0 && !ac.signal.aborted) {
                await new Promise((r) => setTimeout(r, 500));
              } else {
                break;
              }
            }
          }
        }
      }
    } catch {
      remoteRevoked = false;
    } finally {
      clearTimeout(timeoutId);
    }

    return { remoteRevoked };
  }

  cancelSignIn() {
    if (this.pendingLogin) {
      if (this.pendingLogin.timeoutId) clearTimeout(this.pendingLogin.timeoutId);
      if (this.pendingLogin.ac) this.pendingLogin.ac.abort();
      this.pendingLogin.reject(new Error("ログインがキャンセルされました。"));
      if (this.pendingLogin.server) this.pendingLogin.server.close();
      this.pendingLogin = null;
    }
  }

  async signIn() {
    if (this.authLoadError) {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error(
          "OSの暗号化機能が利用できません。キーチェーン等を利用できる状態にしてから再ログインしてください。保存済みの認証情報は変更していません。"
        );
      }
      try {
        fs.unlinkSync(this.authFilePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(
            "保存済みの認証情報を削除できませんでした。アプリの保存先の権限を確認してください。"
          );
        }
      }
      this.authData = null;
      this.authLoadError = null;
    }
    this.cancelSignIn();

    const currentEpoch = this.epoch;
    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const ac = new AbortController();

    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.pendingLogin && this.pendingLogin.state === state) {
          if (this.pendingLogin.server) {
            this.pendingLogin.server.close();
          }
          this.pendingLogin = null;
        }
      };

      const server = http.createServer(async (req, res) => {
        try {
          if (currentEpoch !== this.epoch) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("キャンセルされました。");
            return;
          }

          const urlObj = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
          if (req.method !== "GET" || urlObj.pathname !== "/auth/callback") {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
          }

          if (!this.pendingLogin || this.pendingLogin.state !== state || this.pendingLogin.consumed) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("無効なリクエストです。");
            return;
          }

          const reqState = urlObj.searchParams.get("state");
          if (reqState !== state) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Stateが一致しません。");
            return;
          }

          this.pendingLogin.consumed = true;

          const errParam = urlObj.searchParams.get("error");
          if (errParam) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("認証が拒否されたか、エラーが発生しました。");
            if (errParam === "access_denied") {
              reject(new Error("アクセスが拒否されました。"));
            } else {
              reject(new Error("認証エラーが発生しました。"));
            }
            cleanup();
            return;
          }

          const code = urlObj.searchParams.get("code");
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("認証コードがありません。");
            reject(new Error("認証コードが取得できませんでした。"));
            cleanup();
            return;
          }

          const issuedClientId = urlObj.searchParams.get("client_id");
          const isFirstTime = !this.authData || !this.authData.clientId;

          if (isFirstTime) {
            if (!issuedClientId || issuedClientId === "dynamic_agent_client") {
              throw new Error("コールバックからのclient_idが不正です。");
            }
          } else if (issuedClientId && issuedClientId !== this.authData.clientId) {
            throw new Error("返却されたclient_idが一致しません。");
          }

          const currentClientId = isFirstTime ? issuedClientId : this.authData.clientId;

          if (isFirstTime) {
            this._saveAuth({ clientId: currentClientId }, currentEpoch);
          }

          const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body>アプリで認証を確認しています。このウィンドウを閉じてアプリに戻ってください。</body></html>"
          );

          const tokenRes = await this.fetch("https://auth.openai.com/api/accounts/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: currentClientId,
              code,
              code_verifier: codeVerifier,
              redirect_uri: redirectUri,
              resource: "https://api.openai.com/v1",
            }),
            signal: ac.signal,
          });

          if (!tokenRes.ok) {
            throw new Error("トークンの交換に失敗しました。");
          }

          const tokenData = await tokenRes.json();
          if (currentEpoch !== this.epoch || ac.signal.aborted) {
            throw new Error("操作がキャンセルされました。");
          }

          if (!tokenData.id_token || typeof tokenData.id_token !== "string") {
            throw new Error("id_tokenが含まれていません。");
          }
          if (
            typeof tokenData.token_type !== "string" ||
            tokenData.token_type.toLowerCase() !== "bearer" ||
            !tokenData.access_token ||
            typeof tokenData.access_token !== "string" ||
            !Number.isFinite(tokenData.expires_in) ||
            tokenData.expires_in <= 0 ||
            !tokenData.refresh_token ||
            typeof tokenData.refresh_token !== "string" ||
            !tokenData.scope ||
            typeof tokenData.scope !== "string"
          ) {
            throw new Error("無効なトークンレスポンスです。");
          }

          const JWKS = this.createRemoteJWKSet(
            new URL("https://auth.openai.com/.well-known/jwks.json")
          );

          const { payload } = await this.jwtVerify(tokenData.id_token, JWKS, {
            issuer: "https://auth.openai.com",
            audience: currentClientId,
            requiredClaims: ["sub", "exp", "iat"],
          });

          if (currentEpoch !== this.epoch || ac.signal.aborted) {
            throw new Error("操作がキャンセルされました。");
          }

          if (payload.nonce !== nonce) {
            throw new Error("Nonceが一致しません。");
          }

          if (this.authData && this.authData.sub && this.authData.issuer) {
            if (payload.sub !== this.authData.sub || payload.iss !== this.authData.issuer) {
              throw new Error("保存されているアイデンティティと一致しません。");
            }
          }

          const scopes = typeof tokenData.scope === "string" ? tokenData.scope.split(" ") : [];

          this._saveAuth(
            {
              clientId: currentClientId,
              access_token: tokenData.access_token,
              refresh_token: tokenData.refresh_token,
              expires_at: Date.now() + tokenData.expires_in * 1000,
              scopes,
              sub: payload.sub,
              issuer: payload.iss,
              email: payload.email,
              id_token: tokenData.id_token,
            },
            currentEpoch
          );

          resolve();
          cleanup();
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("エラーが発生しました。");
          }
          if (currentEpoch === this.epoch) {
            reject(err);
            cleanup();
          }
        }
      });

      this.pendingLogin = {
        state,
        resolve,
        reject,
        ac,
        server,
        consumed: false,
      };

      server.on("error", (err) => {
        if (currentEpoch === this.epoch) {
          reject(err);
          cleanup();
        }
      });

      server.listen(0, "127.0.0.1", async () => {
        if (currentEpoch !== this.epoch) {
          cleanup();
          return;
        }

        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

        const isFirstTime = !this.authData || !this.authData.clientId;
        const clientId = isFirstTime ? "dynamic_agent_client" : this.authData.clientId;

        const params = new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: redirectUri,
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          resource: "https://api.openai.com/v1",
          ext_agent_host_id: this.hostId,
        });

        if (isFirstTime) {
          params.append("agent_name_hint", "就活トラッカー");
        } else if (this.authData && typeof this.authData.id_token === "string") {
          params.append("id_token_hint", this.authData.id_token);
        } else if (this.authData && typeof this.authData.email === "string" && this.authData.email) {
          params.append("login_hint", this.authData.email);
        }

        const authUrl = `https://auth.openai.com/api/accounts/authorize?${params.toString()}`;

        if (currentEpoch === this.epoch) {
          timeoutId = setTimeout(() => {
            if (currentEpoch === this.epoch) {
              ac.abort();
              reject(new Error("ログインがタイムアウトしました。"));
              cleanup();
            }
          }, 3 * 60 * 1000);
          if (this.pendingLogin && this.pendingLogin.state === state) {
            this.pendingLogin.timeoutId = timeoutId;
          }
        }

        try {
          await this.openExternal(authUrl);
        } catch {
          if (currentEpoch === this.epoch) {
            reject(new Error("ブラウザを開けませんでした。"));
            cleanup();
          }
        }
      });
    });
  }

  async _ensureToken(acSignal) {
    if (this.authLoadError) throw this.authLoadError;
    if (!this.authData || !this.authData.refresh_token) {
      throw new Error("未ログインです。ログインしてください。");
    }

    if (!this._hasSharingGrant(this.authData.scopes)) {
      throw new Error("権限が不足しています。");
    }

    if (acSignal && acSignal.aborted) {
      throw new Error("操作がキャンセルされました。");
    }

    if (Date.now() < this.authData.expires_at - 60000) {
      if (!this.authData.access_token) {
        throw new Error("無効なトークンレスポンスです。");
      }
      return this.authData.access_token;
    }

    const waitPromise = (promise, signal) => {
      if (!signal) return promise;
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("操作がキャンセルされました。"));
        const onAbort = () => reject(new Error("操作がキャンセルされました。"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (val) => {
            signal.removeEventListener("abort", onAbort);
            resolve(val);
          },
          (err) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          }
        );
      });
    };

    if (this.refreshPromise) {
      return waitPromise(this.refreshPromise, acSignal);
    }

    const currentEpoch = this.epoch;
    const refreshAc = new AbortController();
    this.refreshAbortController = refreshAc;

    const doRefresh = async () => {
      const timeoutId = setTimeout(() => refreshAc.abort(), 15000);
      try {
        const res = await this.fetch("https://auth.openai.com/api/accounts/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: this.authData.clientId,
            refresh_token: this.authData.refresh_token,
            resource: "https://api.openai.com/v1",
          }),
          signal: refreshAc.signal,
        });

        if (!res.ok) {
          let errBody = {};
          try {
            errBody = await res.json();
          } catch {}

          if (errBody.error === "invalid_grant") {
            if (currentEpoch === this.epoch) {
              this._saveAuth(
                {
                  clientId: this.authData.clientId,
                  sub: this.authData.sub,
                  issuer: this.authData.issuer,
                  email: this.authData.email,
                },
                currentEpoch
              );
            }
            throw new Error("セッションの有効期限が切れました。再度ログインしてください。");
          }
          throw new Error("トークンの更新に失敗しました。");
        }

        const data = await res.json();
        if (currentEpoch !== this.epoch) throw new Error("操作がキャンセルされました。");

        if (
          typeof data.token_type !== "string" ||
          data.token_type.toLowerCase() !== "bearer" ||
          !data.access_token ||
          typeof data.access_token !== "string" ||
          !Number.isFinite(data.expires_in) ||
          data.expires_in <= 0 ||
          !data.refresh_token ||
          typeof data.refresh_token !== "string" ||
          !data.scope ||
          typeof data.scope !== "string"
        ) {
          throw new Error("無効なトークンレスポンスです。");
        }

        const newScopes = data.scope.split(" ");

        this._saveAuth(
          {
            ...this.authData,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + data.expires_in * 1000,
            scopes: newScopes,
            id_token: typeof data.id_token === "string" ? data.id_token : this.authData.id_token,
          },
          currentEpoch
        );

        if (!this._hasSharingGrant(newScopes)) {
          throw new Error("ChatGPTプラン共有の権限が取り消されています。");
        }

        return this.authData.access_token;
      } finally {
        clearTimeout(timeoutId);
        if (this.refreshAbortController === refreshAc) {
          this.refreshAbortController = null;
        }
        this.refreshPromise = null;
      }
    };

    this.refreshPromise = doRefresh();
    return waitPromise(this.refreshPromise, acSignal);
  }

  async listModels() {
    const currentEpoch = this.epoch;
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 15000);

    try {
      const token = await this._ensureToken(ac.signal);
      if (currentEpoch !== this.epoch) throw new Error("操作がキャンセルされました。");

      const res = await this.fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${token}` },
        signal: ac.signal,
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error("認証エラーです。再度ログインしてください。");
        if (res.status === 403) throw new Error("モデル一覧へのアクセス権限がありません。");
        if (res.status === 429) {
          throw new Error("リクエスト制限に達しました。しばらく待ってから再度お試しください。");
        }
        throw new Error("モデル一覧の取得に失敗しました。");
      }

      const data = await res.json();
      if (currentEpoch !== this.epoch) throw new Error("操作がキャンセルされました。");

      if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.models)) {
        throw new Error("モデル一覧のレスポンスが不正です。");
      }

      const models = [];
      for (const m of data.models) {
        if (m && typeof m === "object" && m.visibility === "list" && typeof m.slug === "string" && m.slug) {
          models.push({
            slug: m.slug,
            displayName: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
          });
        }
      }
      return models;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async generate(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("リクエストが不正です。");
    }
    if (!request.model || typeof request.model !== "string" || !request.model.trim()) {
      throw new Error("モデルが指定されていません。");
    }
    if (!request.input || typeof request.input !== "string" || !request.input.trim()) {
      throw new Error("入力が空です。");
    }
    if (request.input.length > 50000) {
      throw new Error("入力が長すぎます（最大50000文字）。");
    }
    if (request.instructions !== undefined) {
      if (typeof request.instructions !== "string") {
        throw new Error("システム指示の形式が不正です。");
      }
      if (request.instructions.length > 50000) {
        throw new Error("システム指示が長すぎます（最大50000文字）。");
      }
    }
    if (request.webSearch !== undefined && typeof request.webSearch !== "boolean") {
      throw new Error("Web検索フラグの形式が不正です。");
    }

    if (this.generateAbortController) {
      this.generateAbortController.abort();
    }
    const localAc = new AbortController();
    this.generateAbortController = localAc;
    const currentEpoch = this.epoch;

    const timeoutDuration = request.webSearch === true ? 180 * 1000 : 120 * 1000;
    const timeout = setTimeout(() => {
      localAc.abort();
    }, timeoutDuration);

    try {
      const token = await this._ensureToken(localAc.signal);
      if (currentEpoch !== this.epoch) throw new Error("操作がキャンセルされました。");

      const modelsRes = await this.fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${token}` },
        signal: localAc.signal,
      });
      if (!modelsRes.ok) {
        throw new Error("モデルカタログの取得に失敗しました。");
      }
      const modelsData = await modelsRes.json();
      if (currentEpoch !== this.epoch || localAc.signal.aborted) {
        throw new Error("操作がキャンセルされました。");
      }
      if (
        !modelsData ||
        typeof modelsData !== "object" ||
        Array.isArray(modelsData) ||
        !Array.isArray(modelsData.models)
      ) {
        throw new Error("モデルカタログが不正です。");
      }
      const isValidModel = modelsData.models.some(
        (m) => m && typeof m.slug === "string" && m.slug === request.model && m.visibility === "list"
      );
      if (!isValidModel) {
        throw new Error("指定されたモデルは現在利用できません。");
      }

      const requestBody = {
        model: request.model,
        input: [{ role: "user", content: request.input }],
        store: false,
        stream: true,
      };
      if (request.instructions !== undefined) {
        requestBody.instructions = request.instructions;
      }
      if (request.webSearch === true) {
        requestBody.tools = [{ type: "web_search" }];
        requestBody.tool_choice = "required";
      }

      const res = await this.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: localAc.signal,
      });

      if (!res.ok) {
        if (request.webSearch === true && (res.status === 400 || res.status === 403)) {
          throw new Error(
            "Web検索がこのモデルまたはアカウントでは利用できない可能性があります。別のモデルを選ぶか、同じプロンプトをコピーしてChatGPTで実行してください。"
          );
        }
        if (res.status === 401) {
          throw new Error("認証に失敗しました。再ログインしてください。");
        } else if (res.status === 403) {
          throw new Error("アクセス権限がありません。");
        } else if (res.status === 429) {
          throw new Error("リクエスト制限に達しました。しばらく待ってから再度お試しください。");
        } else if (res.status >= 500) {
          throw new Error("サーバーでエラーが発生しました。");
        }
        throw new Error("生成リクエストに失敗しました。");
      }

      const result = await parseSSE(res.body, localAc);
      if (currentEpoch !== this.epoch || localAc.signal.aborted) {
        throw new Error("操作がキャンセルされました。");
      }
      return result;
    } finally {
      clearTimeout(timeout);
      if (this.generateAbortController === localAc) {
        this.generateAbortController = null;
      }
    }
  }

  async openUsage() {
    await this.openExternal("https://chatgpt.com/settings/usage");
  }
}

async function parseSSE(body, ac) {
  if (ac.signal.aborted) throw new Error("生成処理がキャンセルされました。");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let completed = false;

  const abortHandler = () => {
    reader.cancel(new Error("生成処理がキャンセルされました。")).catch(() => {});
  };
  ac.signal.addEventListener("abort", abortHandler);

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (ac.signal.aborted) throw new Error("生成処理がキャンセルされました。");
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1000000) throw new Error("バッファサイズが制限を超えました。");
      }
      if (done) {
        buffer += decoder.decode();
      }

      while (!completed) {
        const boundaryMatch = buffer.match(/\r?\n\r?\n/);
        let block;
        if (boundaryMatch) {
          block = buffer.slice(0, boundaryMatch.index);
          buffer = buffer.slice(boundaryMatch.index + boundaryMatch[0].length);
        } else if (done && buffer.trim()) {
          block = buffer;
          buffer = "";
        } else {
          break;
        }

        if (!block.trim()) continue;

        const lines = block.split(/\r?\n/);
        let dataPayload = "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const dataStr = line.slice(line.startsWith("data: ") ? 6 : 5);
            if (dataStr === "[DONE]") {
              if (!completed) throw new Error("完了イベントを受信する前に終了しました。");
              break;
            }
            if (dataPayload.length > 0) dataPayload += "\n";
            dataPayload += dataStr;
          }
        }

        if (dataPayload) {
          let event;
          try {
            event = JSON.parse(dataPayload);
          } catch {
            throw new Error("無効なJSONフォーマットです。");
          }

          if (!event || typeof event !== "object" || Array.isArray(event) || !event.type) {
            throw new Error("無効なイベントフォーマットです。");
          }

          if (event.type === "error" || event.error || event.response?.error) {
            throw new Error("生成が中断されたか、エラーが発生しました。");
          } else if (event.type === "response.output_text.delta") {
            if (event.delta && typeof event.delta === "string") {
              fullText += event.delta;
              if (fullText.length > 500000) {
                throw new Error("出力サイズが制限を超えました。");
              }
            }
          } else if (event.type === "response.completed") {
            completed = true;
            if (event.response?.status === "incomplete" || event.response?.status === "failed") {
              throw new Error("生成が中断されたか、エラーが発生しました。");
            }
            if (!fullText && event.response?.output) {
              for (const out of event.response.output) {
                if (out.content) {
                  for (const c of out.content) {
                    if (
                      (c.type === "text" || c.type === "output_text") &&
                      typeof c.text === "string" &&
                      c.text
                    ) {
                      fullText += c.text;
                      if (fullText.length > 500000) {
                        throw new Error("出力サイズが制限を超えました。");
                      }
                    }
                  }
                }
              }
            }
            break;
          } else if (event.type === "response.failed" || event.type === "response.incomplete") {
            throw new Error("生成が中断されたか、エラーが発生しました。");
          }
        }
      }
      if (done) break;
    }
  } finally {
    ac.signal.removeEventListener("abort", abortHandler);
    try {
      await reader.cancel();
    } catch {}
  }

  if (!completed) {
    throw new Error("レスポンスが不完全です。");
  }
  if (!fullText) {
    throw new Error("生成されたテキストが空です。");
  }

  return fullText;
}

module.exports = {
  ChatGPTService,
  parseSSE,
  defaultJwtVerify,
  defaultCreateRemoteJWKSet,
};
