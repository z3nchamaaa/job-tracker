"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const ALLOWED_REDIRECT_HOSTS = Object.freeze([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function expectedPackageName(tag, platform, arch, format) {
  const ver = String(tag || "").replace(/^v/, "");
  if (!parseSemver(ver)) return null;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return `job-tracker-${ver}-win-${arch}.exe`;
  }
  if (platform === "darwin" && arch === "arm64") {
    return `job-tracker-${ver}-mac-arm64.dmg`;
  }
  if (platform === "linux" && arch === "x64") {
    const ext = format === "rpm" ? "rpm" : "deb";
    return `job-tracker-${ver}-linux-${ext === "rpm" ? "x86_64.rpm" : "amd64.deb"}`;
  }
  return null;
}

function isSafeRedirect(rawUrl, allowLoopbackTest = false) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    if (allowLoopbackTest && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") {
      return true;
    }
    return parsed.protocol === "https:" && ALLOWED_REDIRECT_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isTrustedAssetUrl(rawUrl, repo, tag, assetName, allowLoopbackTest = false) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    if (allowLoopbackTest && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") {
      return parsed.pathname.endsWith(`/${assetName}`);
    }
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname === `/${repo}/releases/download/${tag}/${assetName}`
    );
  } catch {
    return false;
  }
}

async function readBoundedText(response, maxBytes) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("更新情報のサイズが上限を超えました。");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

class AppUpdater {
  constructor(options = {}) {
    this.current = options.version || "2.0.0";
    if (!parseSemver(this.current)) {
      throw new Error("Invalid current version");
    }
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.format = options.format || "deb";
    this.directory = path.join(options.userDataPath, "updates");
    this.fetch = options.fetch || fetch;
    this.openInstaller = options.openInstaller;

    // 公開リポジトリと更新先はユーザー確認まで確定しない（作成中は無効化またはテスト配布元のみ利用）
    this.repo = options.repo || process.env.JOB_TRACKER_UPDATE_REPO || null;
    this.apiUrl =
      options.apiUrl ||
      process.env.JOB_TRACKER_UPDATE_API_URL ||
      (this.repo ? `https://api.github.com/repos/${this.repo}/releases/latest` : null);
    this.allowLoopbackTest = Boolean(options.allowLoopbackTest);

    this.selection = null;
    this.downloaded = null;
    this.operation = null;
    this.controller = null;
    this.lastCheck = 0;
    this.state = {
      currentVersion: this.current,
      status: this.apiUrl ? "idle" : "disabled",
      available: false,
      progress: 0,
      codeSigned: false,
      notice: this.apiUrl
        ? undefined
        : "新版の公開配布元が未設定のため、自動更新確認は無効化されています（旧版の配布物は適用されません）。",
    };
  }

  getStatus() {
    return { ...this.state };
  }

  async _request(url, maxTime = 20000) {
    let currentUrl = url;
    for (let i = 0; i < 6; i++) {
      const response = await this.fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Accept:
            currentUrl === this.apiUrl
              ? "application/vnd.github+json"
              : "application/octet-stream",
          "User-Agent": "JobTracker-Updater/2.0",
        },
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(maxTime)]),
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("更新ファイルの転送先が不明です。");
        const nextUrl = new URL(location, currentUrl).href;
        if (!isSafeRedirect(nextUrl, this.allowLoopbackTest)) {
          throw new Error("更新ファイルの転送先ホストが許可されていません。");
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          response.status === 403 || response.status === 429
            ? "更新確認の利用制限に達しました。少し時間を置いてお試しください。"
            : "更新情報を取得できませんでした。"
        );
      }

      return response;
    }
    throw new Error("更新ファイルのリダイレクト回数が上限を超えました。");
  }

  _run(action) {
    if (this.operation) return this.operation;
    this.controller = new AbortController();
    this.operation = action()
      .catch((error) => {
        const msg =
          error && typeof error.message === "string" && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error.message)
            ? error.message
            : "更新処理に失敗しました。接続を確認して、もう一度お試しください。";
        this.state = { ...this.state, status: "error", error: msg };
        return this.getStatus();
      })
      .finally(() => {
        this.operation = null;
      });
    return this.operation;
  }

  check(force = false) {
    if (!this.apiUrl) {
      this.state = {
        currentVersion: this.current,
        status: "disabled",
        available: false,
        progress: 0,
        codeSigned: false,
        notice:
          "新版の公開配布元が未設定のため、更新確認は無効化されています（旧版の配布物は適用されません）。",
      };
      return Promise.resolve(this.getStatus());
    }
    if (this.operation || ["ready", "opened"].includes(this.state.status)) {
      return this.operation || Promise.resolve(this.getStatus());
    }
    if (!force && Date.now() - this.lastCheck < 60000) {
      return Promise.resolve(this.getStatus());
    }

    return this._run(async () => {
      this.state = {
        currentVersion: this.current,
        status: "checking",
        available: false,
        progress: 0,
        codeSigned: false,
      };
      this.selection = null;

      const release = JSON.parse(await readBoundedText(await this._request(this.apiUrl), 2 * 1024 * 1024));
      if (release.draft || release.prerelease || !parseSemver(release.tag_name)) {
        throw new Error("正式版の更新情報を確認できませんでした。");
      }
      if (!isNewerVersion(release.tag_name, this.current)) {
        this.lastCheck = Date.now();
        this.state.status = "current";
        return this.getStatus();
      }

      const name = expectedPackageName(release.tag_name, this.platform, this.arch, this.format);
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const matches = assets.filter((a) => a && a.name === name);
      const asset = matches[0];
      const effectiveRepo = this.repo || "owner/job-tracker";

      if (
        !name ||
        matches.length !== 1 ||
        asset.state !== "uploaded" ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1 ||
        asset.size > MAX_PACKAGE_BYTES ||
        !isTrustedAssetUrl(
          asset.browser_download_url,
          effectiveRepo,
          release.tag_name,
          name,
          this.allowLoopbackTest
        ) ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")
      ) {
        throw new Error("この端末向けの検証可能な更新ファイルが見つかりませんでした。");
      }

      const codeSigned = Boolean(release.code_signed === true);

      this.selection = Object.freeze({
        tag: release.tag_name,
        name,
        url: asset.browser_download_url,
        size: asset.size,
        digest: asset.digest.slice(7),
        codeSigned,
      });

      this.lastCheck = Date.now();
      this.state = {
        ...this.state,
        status: "available",
        available: true,
        latestVersion: release.tag_name.replace(/^v/, ""),
        size: asset.size,
        codeSigned,
        releaseNotes: typeof release.body === "string" ? release.body.slice(0, 30000) : "",
        releaseUrl: this.repo
          ? `https://github.com/${this.repo}/releases/tag/${release.tag_name}`
          : undefined,
      };
      return this.getStatus();
    });
  }

  download() {
    if (this.operation) return this.operation;
    if (this.downloaded) return Promise.resolve(this.getStatus());
    if (!this.selection) {
      return Promise.reject(new Error("先に更新を確認してください。"));
    }

    return this._run(async () => {
      const asset = this.selection;
      this.state = { ...this.state, status: "downloading", error: undefined, progress: 0 };
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });

      for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^release-[a-zA-Z0-9_-]{6,}$/.test(entry.name)) {
          continue;
        }
        const cached = path.join(this.directory, entry.name);
        try {
          if (Date.now() - fs.lstatSync(cached).mtimeMs > 7 * 86400000) {
            fs.rmSync(cached, { recursive: true });
          }
        } catch {}
      }

      const folder = fs.mkdtempSync(path.join(this.directory, "release-"));
      const file = path.join(folder, asset.name);
      let handle;
      try {
        const response = await this._request(asset.url, 15 * 60 * 1000);
        const sizeHeader = response.headers.get("content-length");
        if (sizeHeader !== null && Number(sizeHeader) !== asset.size) {
          await response.body?.cancel();
          throw new Error("更新ファイルのサイズが一致しません。");
        }
        handle = fs.openSync(file, "wx", 0o600);
        const hash = crypto.createHash("sha256");
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > asset.size) {
            throw new Error("更新ファイルのサイズが一致しません。");
          }
          hash.update(chunk);
          fs.writeFileSync(handle, chunk);
          this.state.progress = Math.floor((size / asset.size) * 100);
        }
        fs.closeSync(handle);
        handle = undefined;

        if (size !== asset.size || hash.digest("hex") !== asset.digest) {
          throw new Error("更新ファイルのチェックサムが一致しません。インストールを中止しました。");
        }

        this.downloaded = { ...asset, file };
        this.state.status = "ready";
        this.state.progress = 100;
        return this.getStatus();
      } catch (error) {
        if (handle !== undefined) {
          try {
            fs.closeSync(handle);
          } catch {}
        }
        fs.rmSync(folder, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async install() {
    if (this.operation || this.installing || !this.downloaded || this.state.status !== "ready") {
      throw new Error("更新ファイルのダウンロードを完了してください。");
    }
    this.installing = true;
    const item = this.downloaded;
    try {
      try {
        const stat = fs.lstatSync(item.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size) {
          throw new Error("stat mismatch");
        }
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        for await (const chunk of fs.createReadStream(item.file)) {
          bytes += chunk.length;
          if (bytes > item.size) throw new Error("size overflow");
          hash.update(chunk);
        }
        if (bytes !== item.size || hash.digest("hex") !== item.digest) {
          throw new Error("hash mismatch");
        }
      } catch {
        this.downloaded = null;
        this.state = {
          ...this.state,
          status: "error",
          error: "更新ファイルを確認できません。もう一度ダウンロードしてください。",
        };
        throw new Error(this.state.error);
      }

      if (typeof this.openInstaller === "function") {
        const result = await this.openInstaller(item.file);
        if (!result?.installerPath) {
          this.state.status = "opened";
        }
        return result || { opened: true };
      }
      this.state.status = "opened";
      return { opened: true, file: item.file };
    } finally {
      this.installing = false;
    }
  }

  shutdown() {
    this.controller?.abort();
  }
}

module.exports = {
  AppUpdater,
  parseSemver,
  isNewerVersion,
  expectedPackageName,
  isSafeRedirect,
  isTrustedAssetUrl,
};
