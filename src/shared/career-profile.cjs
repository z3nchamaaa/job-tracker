(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerCareerProfile = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_PROFILE_FIELD_LENGTH = 2000;

  const DEFAULT_CAREER_PROFILE = Object.freeze({
    version: 1,
    completed: false,
    major: "",
    industries: "",
    roles: "",
    priorities: "",
    strengths: "",
  });

  function normalizeCareerProfile(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("プロフィールデータが不正です");
    }

    if (value.version !== 1) {
      throw new Error("対応していないプロフィールのバージョンです");
    }

    if (typeof value.completed !== "boolean") {
      throw new Error("完了ステータスが不正です");
    }

    const extract = (field, fieldName) => {
      if (field === undefined) return "";
      if (typeof field !== "string") {
        throw new Error(`${fieldName}は文字列である必要があります`);
      }
      const trimmed = field.trim();
      if (trimmed.length > MAX_PROFILE_FIELD_LENGTH) {
        throw new Error(`${fieldName}は${MAX_PROFILE_FIELD_LENGTH}文字以内で入力してください`);
      }
      return trimmed;
    };

    return {
      version: 1,
      completed: value.completed,
      major: extract(value.major, "専攻"),
      industries: extract(value.industries, "志望業界"),
      roles: extract(value.roles, "希望職種"),
      priorities: extract(value.priorities, "就活の軸・優先度"),
      strengths: extract(value.strengths, "強み・経験"),
    };
  }

  return {
    MAX_PROFILE_FIELD_LENGTH,
    DEFAULT_CAREER_PROFILE,
    normalizeCareerProfile,
  };
});
