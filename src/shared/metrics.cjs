(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerMetrics = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PASSED_DOCS_STATUSES = Object.freeze(["ES_PASSED", "INTERVIEWING", "FINAL", "OFFER"]);
  const INTERVIEWING_STATUSES = Object.freeze(["INTERVIEWING", "FINAL"]);

  /**
   * 集計定義（固定）:
   * - total: 登録されている全企業数
   * - passedDocs: 書類選考を通過し選考進行中または内定の企業数 (ES_PASSED, INTERVIEWING, FINAL, OFFER)
   * - interviewing: 現在面接段階の企業数 (INTERVIEWING, FINAL)
   * - offers: 内定数 (OFFER)
   * - upcoming7Days: 現在時刻から7日(168時間)以内に到来する未完了予定および未対応選考ステップの締切
   */
  function computeMetrics(companies, events, nowMs = Date.now()) {
    const companyList = Array.isArray(companies) ? companies : [];
    const eventList = Array.isArray(events) ? events : [];

    const total = companyList.length;
    const passedDocs = companyList.filter((c) => PASSED_DOCS_STATUSES.includes(c.status)).length;
    const interviewing = companyList.filter((c) => INTERVIEWING_STATUSES.includes(c.status)).length;
    const offers = companyList.filter((c) => c.status === "OFFER").length;

    const sevenDaysLater = nowMs + 7 * 24 * 60 * 60 * 1000;

    const upcomingEvents = eventList
      .filter((ev) => {
        if (!ev || ev.isDone) return false;
        const startMs = Date.parse(ev.startAt);
        const endMs = ev.endAt ? Date.parse(ev.endAt) : startMs;
        if (!Number.isFinite(startMs)) return false;
        return endMs >= nowMs && startMs <= sevenDaysLater;
      })
      .map((ev) => ({
        id: `event:${ev.id}`,
        kind: "event",
        title: ev.company && ev.company.name ? `${ev.company.name}：${ev.title}` : ev.title,
        at: ev.startAt,
        companyId: ev.companyId || null,
      }));

    // 未対応の選考ステップで7日以内に期限があるものも含める
    const upcomingStepDeadlines = [];
    for (const comp of companyList) {
      if (!Array.isArray(comp.steps)) continue;
      for (const step of comp.steps) {
        if (!step || step.status !== "PENDING" || !step.dueDate) continue;
        const dueMs = Date.parse(step.dueDate);
        if (!Number.isFinite(dueMs)) continue;
        if (dueMs >= nowMs && dueMs <= sevenDaysLater) {
          upcomingStepDeadlines.push({
            id: `step:${step.id}`,
            kind: "step_deadline",
            title: `${comp.name}：${step.stepName}（締切）`,
            at: step.dueDate,
            companyId: comp.id,
          });
        }
      }
    }

    const upcoming7Days = [...upcomingEvents, ...upcomingStepDeadlines].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at)
    );

    return {
      total,
      passedDocs,
      passedDocsRate: total > 0 ? Math.round((passedDocs / total) * 100) : 0,
      interviewing,
      offers,
      upcoming7Days,
    };
  }

  /**
   * 待遇比較向けの数値計算・並べ替えヘルパー。
   * 未確認(null/undefined)はゼロ(0)と厳密に区別し、並べ替えでは常に末尾へ配置する。
   */
  function estimateBonusAmount(company) {
    if (
      company.startingSalary === null ||
      company.startingSalary === undefined ||
      company.bonusMonths === null ||
      company.bonusMonths === undefined
    ) {
      return null;
    }
    return Math.round(Number(company.startingSalary) * Number(company.bonusMonths));
  }

  function getEffectiveAnnualIncome(company) {
    if (company.annualIncome !== null && company.annualIncome !== undefined) {
      return { value: Number(company.annualIncome), isEstimate: false };
    }
    if (company.startingSalary !== null && company.startingSalary !== undefined) {
      const months =
        company.bonusMonths !== null && company.bonusMonths !== undefined
          ? 12 + Number(company.bonusMonths)
          : 12;
      const yen = Number(company.startingSalary) * months;
      return { value: Math.round(yen / 10000), isEstimate: true };
    }
    return null;
  }

  function getCompensationNumericValue(company, key) {
    switch (key) {
      case "startingSalary":
        return company.startingSalary !== null && company.startingSalary !== undefined
          ? Number(company.startingSalary)
          : null;
      case "bonusTimes":
        return company.bonusTimes !== null && company.bonusTimes !== undefined
          ? Number(company.bonusTimes)
          : null;
      case "bonusMonths":
        return company.bonusMonths !== null && company.bonusMonths !== undefined
          ? Number(company.bonusMonths)
          : null;
      case "bonusAmount":
        return estimateBonusAmount(company);
      case "annualIncome": {
        const eff = getEffectiveAnnualIncome(company);
        return eff ? eff.value : null;
      }
      case "annualHolidays":
        return company.annualHolidays !== null && company.annualHolidays !== undefined
          ? Number(company.annualHolidays)
          : null;
      case "ratingSalary":
        return company.ratingSalary > 0 ? Number(company.ratingSalary) : null;
      case "ratingBenefits":
        return company.ratingBenefits > 0 ? Number(company.ratingBenefits) : null;
      case "priority":
        return typeof company.priority === "number" ? company.priority : null;
      default:
        return null;
    }
  }

  function sortCompaniesByCompensation(companies, sortKey, sortDir = "desc") {
    const list = Array.isArray(companies) ? [...companies] : [];
    const dirMultiplier = sortDir === "asc" ? 1 : -1;

    return list.sort((a, b) => {
      if (sortKey === "name") {
        return a.name.localeCompare(b.name, "ja") * dirMultiplier;
      }
      const valA = getCompensationNumericValue(a, sortKey);
      const valB = getCompensationNumericValue(b, sortKey);

      // 未確認(null)は昇順・降順を問わず常に末尾に配置し、0と混同しない
      if (valA === null && valB === null) {
        return a.name.localeCompare(b.name, "ja");
      }
      if (valA === null) return 1;
      if (valB === null) return -1;

      if (valA !== valB) {
        return (valA - valB) * dirMultiplier;
      }
      return a.name.localeCompare(b.name, "ja");
    });
  }

  return {
    PASSED_DOCS_STATUSES,
    INTERVIEWING_STATUSES,
    computeMetrics,
    estimateBonusAmount,
    getEffectiveAnnualIncome,
    getCompensationNumericValue,
    sortCompaniesByCompensation,
  };
});
