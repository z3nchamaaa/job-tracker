(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerPriority = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isCompanyPriority(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
  }

  function formatPriorityStars(priority) {
    const p = isCompanyPriority(priority) ? priority : 3;
    return "★".repeat(p) + "☆".repeat(5 - p);
  }

  return {
    isCompanyPriority,
    formatPriorityStars,
  };
});
