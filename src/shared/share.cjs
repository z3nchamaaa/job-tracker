(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerShare = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 選考状況の共有テキストと、友人と受け渡す企業データの形式を扱う。
  // どちらも「純粋な選考状況・企業の公開情報」だけを出し、志望度・評価・メモ・
  // マイページID・面接記録・AI分析結果は含めない。

  const SHARE_LEVELS = Object.freeze(["simple", "standard", "detailed"]);

  const SHARE_LEVEL_META = Object.freeze({
    simple: Object.freeze({ label: "かんたん", description: "社数の集計だけ" }),
    standard: Object.freeze({ label: "ふつう", description: "集計＋ステータスごとの企業名" }),
    detailed: Object.freeze({ label: "くわしく", description: "企業ごとの選考の進み具合と次の予定" }),
  });

  const STATUS_LABELS = Object.freeze({
    INTERESTED: "検討中",
    APPLIED: "応募済み",
    ES_PASSED: "ES通過",
    INTERVIEWING: "面接中",
    FINAL: "最終面接",
    OFFER: "内定",
    REJECTED: "不合格",
    WITHDRAWN: "辞退",
  });

  // 共有テキスト上の並び（進んでいる順 → 終了）
  const STATUS_ORDER = Object.freeze([
    "OFFER",
    "FINAL",
    "INTERVIEWING",
    "ES_PASSED",
    "APPLIED",
    "INTERESTED",
    "REJECTED",
    "WITHDRAWN",
  ]);

  const ACTIVE_STATUSES = Object.freeze(["APPLIED", "ES_PASSED", "INTERVIEWING", "FINAL"]);
  const CLOSED_STATUSES = Object.freeze(["REJECTED", "WITHDRAWN"]);

  const STEP_MARKS = Object.freeze({ PASSED: "✓", FAILED: "×", SKIPPED: "−" });

  const EVENT_LABELS = Object.freeze({
    INTERVIEW: "面接",
    INTERNSHIP: "インターン",
    ES_DEADLINE: "ES締切",
    WEB_TEST: "Webテスト",
    BRIEFING: "説明会",
    OTHER: "その他",
  });

  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  const COMPANY_SHARE_FORMAT = "job-tracker-company-share";
  const COMPANY_SHARE_VERSION = 1;
  const MAX_SHARED_COMPANIES = 200;
  const MAX_SHARED_STEPS = 50;
  const MAX_SHARED_EVENTS = 50;

  // 共有してよい企業の項目（志望度・評価・メモ・マイページID・AI分析は含めない）
  const SHARED_TEXT_FIELDS = Object.freeze({
    industry: 200,
    jobType: 200,
    location: 1000,
    description: 10000,
    features: 10000,
    salary: 10000,
    benefits: 10000,
    fixedOvertime: 2000,
    housingAllowance: 2000,
    remoteWork: 2000,
  });
  const SHARED_RESEARCH_FIELDS = Object.freeze(["description", "features"]);
  const SHARED_COMPENSATION_FIELDS = Object.freeze([
    "salary",
    "benefits",
    "fixedOvertime",
    "housingAllowance",
    "remoteWork",
    "startingSalary",
    "bonusTimes",
    "bonusMonths",
    "annualIncome",
    "annualHolidays",
  ]);
  const SHARED_NUMBER_FIELDS = Object.freeze({
    startingSalary: { min: 0, max: 10000000, integer: true },
    bonusTimes: { min: 0, max: 12, integer: true },
    bonusMonths: { min: 0, max: 24, integer: false },
    annualIncome: { min: 0, max: 100000, integer: true },
    annualHolidays: { min: 0, max: 366, integer: true },
  });
  // 面接の日程は本人だけのものなので、共有するのは誰にでも関係する予定だけにする
  const SHAREABLE_EVENT_TYPES = Object.freeze(["ES_DEADLINE", "BRIEFING", "WEB_TEST", "INTERNSHIP", "OTHER"]);

  class ShareFormatError extends Error {}

  function isShareLevel(value) {
    return typeof value === "string" && SHARE_LEVELS.includes(value);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDate(date) {
    return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
  }

  function formatShortDate(date, allDay) {
    const base = `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
    return allDay ? base : `${base} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function anonymousName(index) {
    let n = index;
    let label = "";
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `企業${label}`;
  }

  function compareByName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), "ja");
  }

  function upcomingEvent(company, now) {
    const events = Array.isArray(company.events) ? company.events : [];
    let best = null;
    let bestTime = Infinity;
    for (const ev of events) {
      if (!ev || ev.isDone) continue;
      const time = Date.parse(ev.startAt);
      if (!Number.isFinite(time)) continue;
      const end = Date.parse(ev.endAt);
      const relevant = ev.allDay
        ? time + 24 * 60 * 60 * 1000 > now.getTime()
        : (Number.isFinite(end) ? end : time) >= now.getTime();
      if (relevant && time < bestTime) {
        best = ev;
        bestTime = time;
      }
    }
    return best;
  }

  function stepProgress(company) {
    const steps = (Array.isArray(company.steps) ? company.steps : [])
      .slice()
      .sort((a, b) => (Number(a.stepOrder) || 0) - (Number(b.stepOrder) || 0));
    return steps
      .map((s) => {
        const name = String(s.stepName || "").trim();
        if (!name) return null;
        const mark = STEP_MARKS[s.status];
        return mark ? `${name}${mark}` : name;
      })
      .filter(Boolean);
  }

  /**
   * 選考状況の共有テキストを作る。
   * options.level: "simple" | "standard" | "detailed"
   * options.includeInterested: 検討中の企業を含めるか
   * options.includeClosed: 不合格・辞退の企業を含めるか
   * options.anonymize: 企業名を「企業A」などに置き換えるか
   * options.now: 基準日時（テスト用）
   */
  function buildStatusSummary(companies, options = {}) {
    const level = isShareLevel(options.level) ? options.level : "standard";
    const includeInterested = options.includeInterested !== false;
    const includeClosed = options.includeClosed !== false;
    const anonymize = Boolean(options.anonymize);
    const now = options.now instanceof Date ? options.now : new Date();

    const all = (Array.isArray(companies) ? companies : []).filter(
      (c) => c && typeof c === "object" && STATUS_LABELS[c.status]
    );
    const visible = all.filter((c) => {
      if (c.status === "INTERESTED") return includeInterested;
      if (CLOSED_STATUSES.includes(c.status)) return includeClosed;
      return true;
    });

    const counts = {};
    for (const status of STATUS_ORDER) counts[status] = 0;
    for (const c of visible) counts[c.status] += 1;

    const entered = visible.filter((c) => c.status !== "INTERESTED").length;
    const active = visible.filter((c) => ACTIVE_STATUSES.includes(c.status)).length;

    const lines = [];
    lines.push(`【就活の選考状況】${formatDate(now)} 時点`);

    if (visible.length === 0) {
      lines.push("共有できる企業はまだありません。");
      return lines.join("\n");
    }

    lines.push(`エントリー ${entered}社（選考中 ${active}社・内定 ${counts.OFFER}社）`);
    const activeParts = ["APPLIED", "ES_PASSED", "INTERVIEWING", "FINAL"]
      .filter((s) => counts[s] > 0)
      .map((s) => `${STATUS_LABELS[s]} ${counts[s]}`);
    if (activeParts.length) lines.push(`・選考中の内訳: ${activeParts.join(" / ")}`);
    if (includeClosed && counts.REJECTED + counts.WITHDRAWN > 0) {
      lines.push(`・終了: 不合格 ${counts.REJECTED} / 辞退 ${counts.WITHDRAWN}`);
    }
    if (includeInterested && counts.INTERESTED > 0) {
      lines.push(`・検討中 ${counts.INTERESTED}社`);
    }

    if (level === "simple") return lines.join("\n");

    // 匿名化の記号は並び順（ステータス順→企業名順）で振る
    const ordered = [];
    for (const status of STATUS_ORDER) {
      ordered.push(...visible.filter((c) => c.status === status).sort(compareByName));
    }
    const displayName = new Map();
    ordered.forEach((c, idx) => {
      const name = anonymize ? anonymousName(idx) : String(c.name || "").trim() || "（名称未設定）";
      displayName.set(c, name);
    });

    for (const status of STATUS_ORDER) {
      const group = ordered.filter((c) => c.status === status);
      if (group.length === 0) continue;
      lines.push("");
      lines.push(`■ ${STATUS_LABELS[status]}（${group.length}社）`);

      if (level === "standard") {
        lines.push(`  ${group.map((c) => displayName.get(c)).join("、")}`);
        continue;
      }

      for (const c of group) {
        const tags = [];
        const industry = typeof c.industry === "string" ? c.industry.trim() : "";
        if (industry) tags.push(industry);
        if (c.isEarlySelection) tags.push("早期選考");
        lines.push(`・${displayName.get(c)}${tags.length ? `（${tags.join("・")}）` : ""}`);
        const progress = stepProgress(c);
        if (progress.length) lines.push(`    選考: ${progress.join(" → ")}`);
        if (!CLOSED_STATUSES.includes(c.status) && c.status !== "OFFER") {
          const ev = upcomingEvent(c, now);
          if (ev) {
            const date = new Date(ev.startAt);
            const kind = EVENT_LABELS[ev.eventType] || "予定";
            lines.push(`    次の予定: ${formatShortDate(date, Boolean(ev.allDay))} ${kind}`);
          }
        }
      }
    }

    return lines.join("\n");
  }

  function cleanText(value, maxLength) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }

  function cleanNumber(value, rule) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num < rule.min || num > rule.max) return null;
    if (rule.integer && !Number.isInteger(num)) return null;
    return num;
  }

  function cleanUrl(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 2048) return null;
    try {
      const parsed = new URL(trimmed);
      if (!["https:", "http:"].includes(parsed.protocol)) return null;
      if (parsed.username || parsed.password || !parsed.hostname) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function cleanIsoDateTime(value) {
    if (typeof value !== "string") return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    return Number.isFinite(Date.parse(value)) ? value : null;
  }

  /**
   * 企業データ共有ファイルを作る。
   * options.includeResearch: 企業概要・特徴を含める
   * options.includeCompensation: 給与・待遇を含める
   * options.includeSteps: 選考フロー（ステップ名のみ）を含める
   * options.includeEvents: 今後の説明会・締切などの予定を含める（面接の日程は含めない）
   */
  function buildCompanyShare(companies, options = {}) {
    const includeResearch = options.includeResearch !== false;
    const includeCompensation = options.includeCompensation !== false;
    const includeSteps = options.includeSteps !== false;
    const includeEvents = options.includeEvents !== false;
    const now = options.now instanceof Date ? options.now : new Date();

    const list = (Array.isArray(companies) ? companies : []).filter(
      (c) => c && typeof c === "object" && cleanText(c.name, 200)
    );
    if (list.length > MAX_SHARED_COMPANIES) {
      throw new ShareFormatError(`一度に共有できるのは${MAX_SHARED_COMPANIES}社までです。`);
    }

    const shared = list.map((c) => {
      const item = {
        name: cleanText(c.name, 200),
        isEarlySelection: Boolean(c.isEarlySelection),
        websiteUrl: cleanUrl(c.websiteUrl),
        myPageUrl: cleanUrl(c.myPageUrl),
      };
      for (const [key, max] of Object.entries(SHARED_TEXT_FIELDS)) {
        if (!includeResearch && SHARED_RESEARCH_FIELDS.includes(key)) continue;
        if (!includeCompensation && SHARED_COMPENSATION_FIELDS.includes(key)) continue;
        item[key] = cleanText(c[key], max);
      }
      if (includeCompensation) {
        for (const [key, rule] of Object.entries(SHARED_NUMBER_FIELDS)) {
          item[key] = cleanNumber(c[key], rule);
        }
      }
      if (includeSteps) {
        item.steps = (Array.isArray(c.steps) ? c.steps : [])
          .slice()
          .sort((a, b) => (Number(a.stepOrder) || 0) - (Number(b.stepOrder) || 0))
          .map((s) => cleanText(s && s.stepName, 200))
          .filter(Boolean)
          .slice(0, MAX_SHARED_STEPS)
          .map((stepName, idx) => ({ stepName, stepOrder: idx + 1 }));
      }
      if (includeEvents) {
        item.events = (Array.isArray(c.events) ? c.events : [])
          .filter((ev) => ev && SHAREABLE_EVENT_TYPES.includes(ev.eventType))
          .filter((ev) => {
            const start = Date.parse(ev.startAt);
            const end = Date.parse(ev.endAt);
            const last = Number.isFinite(end) ? end : start + (ev.allDay ? 24 * 60 * 60 * 1000 : 0);
            return Number.isFinite(start) && last >= now.getTime();
          })
          .slice(0, MAX_SHARED_EVENTS)
          .map((ev) => ({
            title: cleanText(ev.title, 300) || EVENT_LABELS[ev.eventType],
            eventType: ev.eventType,
            startAt: ev.startAt,
            endAt: cleanIsoDateTime(ev.endAt),
            allDay: Boolean(ev.allDay),
            location: cleanText(ev.location, 2000),
          }));
      }
      return item;
    });

    return {
      format: COMPANY_SHARE_FORMAT,
      version: COMPANY_SHARE_VERSION,
      sharedAt: now.toISOString(),
      notice:
        "就活トラッカーの「共有」→「企業データ」から取り込めます。志望度・評価・メモ・マイページID・面接記録は含まれていません。",
      companies: shared,
    };
  }

  /**
   * 受け取った企業データ（JSON文字列またはオブジェクト）を検証し、取り込める形に整える。
   * 未知の項目は捨て、値は型と長さを確かめてから使う。
   */
  function parseCompanyShare(input) {
    let raw = input;
    if (typeof input === "string") {
      const text = input.trim();
      if (!text) throw new ShareFormatError("共有データが空です。");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) {
        throw new ShareFormatError("共有データの形式が正しくありません。受け取ったファイルか文字列をそのまま貼り付けてください。");
      }
      try {
        raw = JSON.parse(text.slice(start, end + 1));
      } catch {
        throw new ShareFormatError("共有データを読み取れませんでした。途中で切れていないか確認してください。");
      }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ShareFormatError("共有データの形式が正しくありません。");
    }
    if (raw.format === "job-tracker-backup") {
      throw new ShareFormatError("これはバックアップファイルです。「データ管理・移行」から取り込んでください。");
    }
    if (raw.format !== COMPANY_SHARE_FORMAT) {
      throw new ShareFormatError("就活トラッカーの企業データ共有ファイルではありません。");
    }
    if (raw.version !== COMPANY_SHARE_VERSION) {
      throw new ShareFormatError("この共有データの版には対応していません。アプリを更新してください。");
    }
    if (!Array.isArray(raw.companies) || raw.companies.length === 0) {
      throw new ShareFormatError("共有データに企業が含まれていません。");
    }
    if (raw.companies.length > MAX_SHARED_COMPANIES) {
      throw new ShareFormatError(`一度に取り込めるのは${MAX_SHARED_COMPANIES}社までです。`);
    }

    const companies = raw.companies.map((c, idx) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        throw new ShareFormatError(`${idx + 1}件目の企業データが正しくありません。`);
      }
      const name = cleanText(c.name, 200);
      if (!name) throw new ShareFormatError(`${idx + 1}件目の企業名がありません。`);
      const item = {
        name,
        isEarlySelection: c.isEarlySelection === true,
        websiteUrl: cleanUrl(c.websiteUrl),
        myPageUrl: cleanUrl(c.myPageUrl),
      };
      for (const [key, max] of Object.entries(SHARED_TEXT_FIELDS)) {
        item[key] = cleanText(c[key], max);
      }
      for (const [key, rule] of Object.entries(SHARED_NUMBER_FIELDS)) {
        item[key] = cleanNumber(c[key], rule);
      }
      item.steps = (Array.isArray(c.steps) ? c.steps : [])
        .map((s) => cleanText(s && s.stepName, 200))
        .filter(Boolean)
        .slice(0, MAX_SHARED_STEPS)
        .map((stepName, i) => ({ stepName, stepOrder: i + 1 }));
      item.events = (Array.isArray(c.events) ? c.events : [])
        .filter((ev) => ev && typeof ev === "object" && SHAREABLE_EVENT_TYPES.includes(ev.eventType))
        .map((ev) => ({
          title: cleanText(ev.title, 300) || EVENT_LABELS[ev.eventType],
          eventType: ev.eventType,
          startAt: cleanIsoDateTime(ev.startAt),
          endAt: cleanIsoDateTime(ev.endAt),
          allDay: ev.allDay === true,
          location: cleanText(ev.location, 2000),
        }))
        .filter((ev) => ev.startAt && (!ev.endAt || Date.parse(ev.endAt) >= Date.parse(ev.startAt)))
        .slice(0, MAX_SHARED_EVENTS);
      return item;
    });

    return {
      sharedAt: cleanIsoDateTime(raw.sharedAt),
      companies,
    };
  }

  function normalizeCompanyName(name) {
    return String(name || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .replace(/^(株式会社|\(株\)|（株）)|(株式会社|\(株\)|（株）)$/g, "")
      .toLowerCase();
  }

  /** 取り込み候補ごとに、手元にある同名企業かどうかを返す */
  function findDuplicateNames(sharedCompanies, existingCompanies) {
    const existing = new Set(
      (Array.isArray(existingCompanies) ? existingCompanies : []).map((c) => normalizeCompanyName(c && c.name))
    );
    return (Array.isArray(sharedCompanies) ? sharedCompanies : []).map((c) =>
      existing.has(normalizeCompanyName(c && c.name))
    );
  }

  return {
    SHARE_LEVELS,
    SHARE_LEVEL_META,
    COMPANY_SHARE_FORMAT,
    COMPANY_SHARE_VERSION,
    MAX_SHARED_COMPANIES,
    SHAREABLE_EVENT_TYPES,
    ShareFormatError,
    isShareLevel,
    buildStatusSummary,
    buildCompanyShare,
    parseCompanyShare,
    normalizeCompanyName,
    findDuplicateNames,
  };
});
