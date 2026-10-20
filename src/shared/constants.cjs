(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerConstants = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const APP_NAME = "就活トラッカー";
  const APP_ID = "jp.jobtracker.app";
  const APP_VERSION = "2.0.0";

  const SELECTION_STATUSES = Object.freeze([
    "INTERESTED",
    "APPLIED",
    "ES_PASSED",
    "INTERVIEWING",
    "FINAL",
    "OFFER",
    "REJECTED",
    "WITHDRAWN",
  ]);

  const RESULT_STATUSES = Object.freeze(["OFFER", "REJECTED", "WITHDRAWN"]);

  const STATUS_META = Object.freeze({
    INTERESTED: Object.freeze({
      label: "検討",
      symbol: "○",
      chipClass: "status-chip-interested",
    }),
    APPLIED: Object.freeze({
      label: "応募済み",
      symbol: "▶",
      chipClass: "status-chip-applied",
    }),
    ES_PASSED: Object.freeze({
      label: "ES通過",
      symbol: "◎",
      chipClass: "status-chip-es-passed",
    }),
    INTERVIEWING: Object.freeze({
      label: "面接中",
      symbol: "◆",
      chipClass: "status-chip-interviewing",
    }),
    FINAL: Object.freeze({
      label: "最終面接",
      symbol: "★",
      chipClass: "status-chip-final",
    }),
    OFFER: Object.freeze({
      label: "内定",
      symbol: "✓",
      chipClass: "status-chip-offer",
    }),
    REJECTED: Object.freeze({
      label: "不合格",
      symbol: "×",
      chipClass: "status-chip-rejected",
    }),
    WITHDRAWN: Object.freeze({
      label: "辞退",
      symbol: "−",
      chipClass: "status-chip-withdrawn",
    }),
  });

  const KANBAN_LANES = Object.freeze([
    Object.freeze({ key: "INTERESTED", label: "検討", isEarlyLane: false, statuses: Object.freeze(["INTERESTED"]) }),
    Object.freeze({ key: "EARLY_SELECTION", label: "早期選考", isEarlyLane: true, statuses: Object.freeze(["INTERESTED", "APPLIED", "ES_PASSED", "INTERVIEWING", "FINAL"]) }),
    Object.freeze({ key: "APPLIED", label: "応募済み", isEarlyLane: false, statuses: Object.freeze(["APPLIED"]) }),
    Object.freeze({ key: "ES_PASSED", label: "ES通過", isEarlyLane: false, statuses: Object.freeze(["ES_PASSED"]) }),
    Object.freeze({ key: "INTERVIEWING", label: "面接", isEarlyLane: false, statuses: Object.freeze(["INTERVIEWING", "FINAL"]) }),
    Object.freeze({ key: "OFFER", label: "内定", isEarlyLane: false, statuses: Object.freeze(["OFFER"]) }),
    Object.freeze({ key: "REJECTED", label: "不合格", isEarlyLane: false, statuses: Object.freeze(["REJECTED"]) }),
    Object.freeze({ key: "WITHDRAWN", label: "辞退", isEarlyLane: false, statuses: Object.freeze(["WITHDRAWN"]) }),
  ]);

  const EARLY_STATUS_ORDER = Object.freeze([
    "FINAL",
    "INTERVIEWING",
    "ES_PASSED",
    "APPLIED",
    "INTERESTED",
  ]);

  const STEP_STATUSES = Object.freeze(["PENDING", "PASSED", "FAILED", "SKIPPED"]);

  const STEP_STATUS_LABELS = Object.freeze({
    PENDING: "未対応",
    PASSED: "通過",
    FAILED: "不通過",
    SKIPPED: "スキップ",
  });

  const EVENT_TYPES = Object.freeze([
    "INTERVIEW",
    "INTERNSHIP",
    "ES_DEADLINE",
    "WEB_TEST",
    "BRIEFING",
    "OTHER",
  ]);

  const EVENT_LABELS = Object.freeze({
    INTERVIEW: "面接",
    INTERNSHIP: "インターン",
    ES_DEADLINE: "ES締切",
    WEB_TEST: "Webテスト",
    BRIEFING: "説明会",
    OTHER: "その他",
  });

  const M3_COLORS = Object.freeze({
    primary: "#6750a4",
    primaryContainer: "#eaddff",
    secondaryContainer: "#e8def8",
    tertiary: "#7d5260",
    surface: "#fef7ff",
    onSurface: "#1d1b20",
    onSurfaceVariant: "#49454f",
    outlineVariant: "#cac4d0",
    error: "#b3261e",
  });

  function isSelectionStatus(value) {
    return typeof value === "string" && SELECTION_STATUSES.includes(value);
  }

  function isStepStatus(value) {
    return typeof value === "string" && STEP_STATUSES.includes(value);
  }

  function isResultStatus(status) {
    return RESULT_STATUSES.includes(status);
  }

  function isEarlyLaneCandidate(company) {
    return Boolean(company && company.isEarlySelection) && !isResultStatus(company.status);
  }

  function getKanbanLanes(companies) {
    const list = Array.isArray(companies) ? companies : [];
    return KANBAN_LANES.map((lane) => {
      if (lane.isEarlyLane) {
        const items = list
          .filter(isEarlyLaneCandidate)
          .sort((a, b) => {
            const idxA = EARLY_STATUS_ORDER.indexOf(a.status);
            const idxB = EARLY_STATUS_ORDER.indexOf(b.status);
            const diff = (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
            if (diff !== 0) return diff;
            return (b.priority || 3) - (a.priority || 3);
          });
        return { ...lane, companies: items };
      }

      const items = list.filter(
        (c) => lane.statuses.includes(c.status) && !isEarlyLaneCandidate(c)
      );

      if (lane.key === "INTERVIEWING") {
        items.sort((a, b) => {
          if (a.status === "FINAL" && b.status !== "FINAL") return -1;
          if (a.status !== "FINAL" && b.status === "FINAL") return 1;
          return (b.priority || 3) - (a.priority || 3);
        });
      } else {
        items.sort((a, b) => (b.priority || 3) - (a.priority || 3));
      }

      return { ...lane, companies: items };
    });
  }

  function getAdjacentStatus(currentStatus, direction) {
    const idx = SELECTION_STATUSES.indexOf(currentStatus);
    if (idx === -1) return null;
    const nextIdx = direction === "next" ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= SELECTION_STATUSES.length) return null;
    return SELECTION_STATUSES[nextIdx];
  }

  return {
    APP_NAME,
    APP_ID,
    APP_VERSION,
    SELECTION_STATUSES,
    RESULT_STATUSES,
    STATUS_META,
    KANBAN_LANES,
    EARLY_STATUS_ORDER,
    STEP_STATUSES,
    STEP_STATUS_LABELS,
    EVENT_TYPES,
    EVENT_LABELS,
    M3_COLORS,
    isSelectionStatus,
    isStepStatus,
    isResultStatus,
    isEarlyLaneCandidate,
    getKanbanLanes,
    getAdjacentStatus,
  };
});
