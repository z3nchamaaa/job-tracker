(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerDraft = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_DRAFT_JSON_LENGTH = 200000;
  const MAX_NAME_LENGTH = 200;
  const MAX_TEXT_LENGTH = 20000;
  const MAX_URL_LENGTH = 2048;
  const MAX_LIST_ITEMS = 50;
  const MAX_LIST_ITEM_LENGTH = 2000;
  const MAX_STEPS = 30;
  const MAX_STEP_ORDER = 1000;
  const MAX_SOURCES = 20;

  const DEFAULT_STEPS = Object.freeze([
    Object.freeze({ stepName: "エントリーシート提出", stepOrder: 1 }),
    Object.freeze({ stepName: "1次面接", stepOrder: 2 }),
    Object.freeze({ stepName: "最終面接", stepOrder: 3 }),
  ]);

  const ALLOWED_FIT_LEVELS = Object.freeze(["高", "中", "低", "未判定"]);

  class DraftValidationError extends Error {}

  function fail(message) {
    throw new DraftValidationError(message);
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function stripJsonFence(text) {
    if (typeof text !== "string") return "";
    const normalized = text.replace(/\r\n?/g, "\n").trim();
    const match = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(normalized);
    return (match ? match[1] : normalized).trim();
  }

  function validateSafeHttpUrl(rawUrl, label = "URL", allowHttp = true) {
    if (rawUrl === undefined || rawUrl === null || rawUrl === "") return null;
    if (typeof rawUrl !== "string") {
      fail(`${label}は文字列または null で指定してください。`);
    }
    const trimmed = rawUrl.trim();
    if (trimmed === "") return null;
    if (trimmed.length > MAX_URL_LENGTH) {
      fail(`${label}が長すぎます（${MAX_URL_LENGTH}文字まで）。`);
    }
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      fail(`${label}の形式が正しくありません（http:// または https:// で始まるURLを指定してください）。`);
    }
    const allowedProtocols = allowHttp ? ["https:", "http:"] : ["https:"];
    if (!allowedProtocols.includes(parsed.protocol)) {
      fail(`${label}には ${allowedProtocols.join(" または ")} スキームのみ使用できます。`);
    }
    if (parsed.username || parsed.password) {
      fail(`${label}に認証情報（ユーザー名・パスワード）を含めることはできません。`);
    }
    if (!parsed.hostname) {
      fail(`${label}のホスト名が不正です。`);
    }
    return parsed.href;
  }

  function optionalString(obj, key, label, maxLength = MAX_TEXT_LENGTH) {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      fail(`${label}（${key}）は文字列または null で指定してください。`);
    }
    if (value.length > maxLength) {
      fail(`${label}（${key}）が長すぎます（${maxLength}文字まで）。`);
    }
    return value;
  }

  function optionalNumber(obj, key, label, rule) {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
      fail(
        `${label}（${key}）に文字列は指定できません。通貨や単位が曖昧な文字列は自動変換しないため、数値または null で指定してください。`
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(`${label}（${key}）は数値または null で指定してください。`);
    }
    if (rule.integer && !Number.isInteger(value)) {
      fail(`${label}（${key}）は整数で指定してください。`);
    }
    if (value < rule.min || value > rule.max) {
      fail(`${label}（${key}）は${rule.min}〜${rule.max}の範囲で指定してください。`);
    }
    return value;
  }

  function stringList(obj, key, label) {
    const value = obj[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      fail(`${label}（${key}）は文字列の配列で指定してください。`);
    }
    if (value.length > MAX_LIST_ITEMS) {
      fail(`${label}（${key}）の項目数が多すぎます（${MAX_LIST_ITEMS}件まで）。`);
    }
    return value.map((item, idx) => {
      if (typeof item !== "string") {
        fail(`${label}（${key}）の${idx + 1}番目は文字列で指定してください。`);
      }
      if (item.length > MAX_LIST_ITEM_LENGTH) {
        fail(`${label}（${key}）の${idx + 1}番目が長すぎます（${MAX_LIST_ITEM_LENGTH}文字まで）。`);
      }
      return item;
    });
  }

  function parseSteps(value) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) {
      fail("選考ステップ（suggestedSteps）は配列で指定してください。");
    }
    if (value.length > MAX_STEPS) {
      fail(`選考ステップ（suggestedSteps）が多すぎます（${MAX_STEPS}件まで）。`);
    }
    return value.map((item, index) => {
      const label = `選考ステップの${index + 1}番目`;
      if (!isRecord(item)) {
        fail(`${label}はオブジェクトで指定してください。`);
      }
      const stepName = item.stepName;
      if (typeof stepName !== "string" || stepName.trim() === "") {
        fail(`${label}の stepName は空でない文字列で指定してください。`);
      }
      if (stepName.length > MAX_NAME_LENGTH) {
        fail(`${label}の stepName が長すぎます（${MAX_NAME_LENGTH}文字まで）。`);
      }
      let stepOrder = index + 1;
      const rawOrder = item.stepOrder;
      if (rawOrder !== undefined && rawOrder !== null) {
        if (
          typeof rawOrder !== "number" ||
          !Number.isInteger(rawOrder) ||
          rawOrder < 0 ||
          rawOrder > MAX_STEP_ORDER
        ) {
          fail(`${label}の stepOrder は0〜${MAX_STEP_ORDER}の整数で指定してください。`);
        }
        stepOrder = rawOrder;
      }
      const memo = optionalString(item, "memo", `${label}のメモ`);
      return { stepName: stepName.trim(), stepOrder, memo };
    });
  }

  function parseInterviewPrepTips(value) {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) {
      fail("面接対策（interviewPrepTips）はオブジェクトで指定してください。");
    }
    const rawFit = optionalString(value, "fitLevel", "面接対策のマッチ度", 50);
    let fitLevel = null;
    if (rawFit !== null && rawFit.trim() !== "") {
      const trimmedFit = rawFit.trim();
      if (!ALLOWED_FIT_LEVELS.includes(trimmedFit) && trimmedFit.length > 30) {
        fail("面接対策のマッチ度（fitLevel）は「高」「中」「低」等で指定してください。");
      }
      fitLevel = trimmedFit;
    }
    return {
      fitLevel,
      fitReason: optionalString(value, "fitReason", "面接対策のマッチ度の理由"),
      appealPoints: stringList(value, "appealPoints", "面接対策のアピールポイント"),
      idealCandidate: optionalString(value, "idealCandidate", "面接対策の求める人物像"),
      expectedQuestions: stringList(value, "expectedQuestions", "面接対策の想定質問"),
      reverseQuestions: stringList(value, "reverseQuestions", "面接対策の逆質問"),
    };
  }

  function parseSources(value, defaultVerifiedAt) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      fail("出典情報（sources）は配列で指定してください。");
    }
    if (value.length > MAX_SOURCES) {
      fail(`出典情報（sources）が多すぎます（${MAX_SOURCES}件まで）。`);
    }
    const result = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const label = `出典情報の${i + 1}番目`;
      if (typeof item === "string") {
        const url = validateSafeHttpUrl(item, `${label}のURL`);
        if (url) result.push({ title: null, url, verifiedAt: defaultVerifiedAt || null });
      } else if (isRecord(item)) {
        const url = validateSafeHttpUrl(item.url, `${label}のURL`);
        if (!url) fail(`${label}のURLは有効な http/https URL で指定してください。`);
        const title = optionalString(item, "title", `${label}のタイトル`, 300);
        const verifiedAt = optionalString(item, "verifiedAt", `${label}の確認日`, 64) || defaultVerifiedAt || null;
        result.push({ title: title ? title.trim() : null, url, verifiedAt });
      } else {
        fail(`${label}はURL文字列またはオブジェクトで指定してください。`);
      }
    }
    return result;
  }

  function normalizeAnnualIncome(obj) {
    const value = optionalNumber(obj, "annualIncome", "想定年収（万円）", {
      min: 0,
      max: 100000,
      integer: false,
    });
    if (value === null) return null;
    const rounded = Math.round(value);
    return rounded === 0 ? 0 : rounded;
  }

  const RATING_RULE = { min: 0, max: 5, integer: true };

  function validateDraft(obj) {
    const rawName = obj.name;
    if (typeof rawName !== "string" || rawName.trim() === "") {
      fail("企業名(name)が空でない文字列としてJSONに含まれていません。");
    }
    const name = rawName.trim();
    if (name.length > MAX_NAME_LENGTH) {
      fail(`企業名(name)が長すぎます（${MAX_NAME_LENGTH}文字まで）。`);
    }

    const websiteUrl = validateSafeHttpUrl(obj.websiteUrl, "WebサイトURL（websiteUrl）");
    const verifiedAt = optionalString(obj, "verifiedAt", "確認日（verifiedAt）", 64);
    const sources = parseSources(obj.sources, verifiedAt);

    const rawAnnualIncome = obj.annualIncome;
    const annualIncome = normalizeAnnualIncome(obj);
    const annualIncomeNormalizedFrom =
      typeof rawAnnualIncome === "number" && !Number.isInteger(rawAnnualIncome)
        ? rawAnnualIncome
        : null;

    return {
      name,
      industry: optionalString(obj, "industry", "業界"),
      jobType: optionalString(obj, "jobType", "職種"),
      websiteUrl,
      description: optionalString(obj, "description", "企業概要"),
      features: optionalString(obj, "features", "特徴"),
      location: optionalString(obj, "location", "勤務地"),
      salary: optionalString(obj, "salary", "給与メモ"),
      benefits: optionalString(obj, "benefits", "福利厚生"),
      ratingSalary: optionalNumber(obj, "ratingSalary", "給与レーティング", RATING_RULE),
      ratingBenefits: optionalNumber(obj, "ratingBenefits", "福利厚生レーティング", RATING_RULE),
      startingSalary: optionalNumber(obj, "startingSalary", "初任給（月額・円）", {
        min: 0,
        max: 10000000,
        integer: true,
      }),
      bonusTimes: optionalNumber(obj, "bonusTimes", "賞与回数", { min: 0, max: 12, integer: true }),
      bonusMonths: optionalNumber(obj, "bonusMonths", "賞与月数", { min: 0, max: 24, integer: false }),
      annualIncome,
      annualIncomeNormalizedFrom,
      annualHolidays: optionalNumber(obj, "annualHolidays", "年間休日", {
        min: 0,
        max: 366,
        integer: true,
      }),
      fixedOvertime: optionalString(obj, "fixedOvertime", "みなし残業", MAX_LIST_ITEM_LENGTH),
      housingAllowance: optionalString(obj, "housingAllowance", "住宅手当・社宅", MAX_LIST_ITEM_LENGTH),
      remoteWork: optionalString(obj, "remoteWork", "リモートワーク", MAX_LIST_ITEM_LENGTH),
      verifiedAt: verifiedAt ? verifiedAt.trim() : null,
      sources,
      suggestedSteps: parseSteps(obj.suggestedSteps),
      interviewPrepTips: parseInterviewPrepTips(obj.interviewPrepTips),
    };
  }

  function parseCompanyDraft(text) {
    if (typeof text !== "string") {
      return { ok: false, error: "JSONデータが空です。" };
    }
    const body = stripJsonFence(text);
    if (body === "") {
      return { ok: false, error: "JSONデータが空です。" };
    }
    if (body.length > MAX_DRAFT_JSON_LENGTH) {
      return {
        ok: false,
        error: `JSONデータが大きすぎます（${MAX_DRAFT_JSON_LENGTH}文字まで）。`,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        error: "正しいJSONフォーマットではありません。AIの出力をそのまま貼り付けてください。",
      };
    }

    if (!isRecord(parsed)) {
      return { ok: false, error: "JSONは { } で囲まれたオブジェクトである必要があります。" };
    }

    try {
      return { ok: true, draft: validateDraft(parsed) };
    } catch (err) {
      if (err instanceof DraftValidationError) {
        return { ok: false, error: err.message };
      }
      return { ok: false, error: "JSONの検証中に予期しないエラーが発生しました。" };
    }
  }

  function buildCompanyPayload(draft) {
    const steps =
      draft.suggestedSteps && draft.suggestedSteps.length > 0
        ? draft.suggestedSteps.map((step) => ({
            stepName: step.stepName,
            stepOrder: step.stepOrder,
            memo: step.memo ?? undefined,
          }))
        : DEFAULT_STEPS.map((step) => ({ ...step }));

    const aiMetadata = {
      generatedByAi: true,
      verifiedAt: draft.verifiedAt || null,
      sources: Array.isArray(draft.sources) ? draft.sources : [],
    };
    if (draft.interviewPrepTips) {
      aiMetadata.interviewPrepTips = draft.interviewPrepTips;
    }

    return {
      name: draft.name,
      industry: draft.industry ?? "",
      jobType: draft.jobType ?? "",
      websiteUrl: draft.websiteUrl ?? "",
      description: draft.description ?? "",
      features: draft.features ?? "",
      location: draft.location ?? "",
      salary: draft.salary ?? "",
      benefits: draft.benefits ?? "",
      ratingSalary: draft.ratingSalary ?? 0,
      ratingBenefits: draft.ratingBenefits ?? 0,
      startingSalary: draft.startingSalary,
      bonusTimes: draft.bonusTimes,
      bonusMonths: draft.bonusMonths,
      annualIncome: draft.annualIncome,
      annualHolidays: draft.annualHolidays,
      fixedOvertime: draft.fixedOvertime,
      housingAllowance: draft.housingAllowance,
      remoteWork: draft.remoteWork,
      aiExtractedJson: JSON.stringify(aiMetadata),
      status: "INTERESTED",
      priority: 3,
      steps,
    };
  }

  return {
    MAX_DRAFT_JSON_LENGTH,
    DEFAULT_STEPS,
    DraftValidationError,
    stripJsonFence,
    validateSafeHttpUrl,
    normalizeAnnualIncome,
    parseCompanyDraft,
    buildCompanyPayload,
  };
});
