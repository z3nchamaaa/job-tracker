"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_CAREER_PROFILE,
  normalizeCareerProfile,
} = require("../shared/career-profile.cjs");

class CareerProfileStore {
  constructor(userDataPath) {
    if (!userDataPath || typeof userDataPath !== "string") {
      throw new Error("userDataPath is required");
    }
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "career-profile.json");
  }

  getProfile() {
    if (!fs.existsSync(this.filePath)) {
      return { ...DEFAULT_CAREER_PROFILE };
    }
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      return normalizeCareerProfile(parsed);
    } catch (err) {
      // 破損を勝手な初期化で隠さずエラーを通知する
      throw new Error(
        `就活軸プロフィールの読み込みに失敗しました（ファイル破損または形式不正）。元のファイルは保持されています。`
      );
    }
  }

  saveProfile(profileInput) {
    const normalized = normalizeCareerProfile(profileInput);
    fs.mkdirSync(this.userDataPath, { recursive: true, mode: 0o700 });

    // 既存ファイルが破損していた場合は上書き前に退避する
    if (fs.existsSync(this.filePath)) {
      try {
        normalizeCareerProfile(JSON.parse(fs.readFileSync(this.filePath, "utf-8")));
      } catch {
        const backupPath = path.join(
          this.userDataPath,
          `career-profile.corrupt.${Date.now()}.json`
        );
        try {
          fs.copyFileSync(this.filePath, backupPath);
        } catch {}
      }
    }

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(normalized, null, 2);

    try {
      fs.writeFileSync(tempPath, data, { encoding: "utf-8", mode: 0o600 });
      try {
        fs.chmodSync(tempPath, 0o600);
      } catch {}
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      throw new Error("就活軸プロフィールの保存に失敗しました。");
    }

    return normalized;
  }
}

module.exports = {
  CareerProfileStore,
  DEFAULT_CAREER_PROFILE,
  normalizeCareerProfile,
};
