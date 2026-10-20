(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerEventInput = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EVENT_KINDS = ["INTERVIEW", "INTERNSHIP", "ES_DEADLINE", "WEB_TEST", "BRIEFING", "OTHER"];
  const MAX_TITLE_LEN = 300;
  const MAX_LOCATION_LEN = 2000;
  const MAX_MEMO_LEN = 10000;

  class EventInputError extends Error {}

  function parseIsoDateTime(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new EventInputError("有効な日時を入力してください。");
    }
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const hour = Number(value.slice(11, 13));
    const minute = Number(value.slice(14, 16));
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonths[month - 1] ||
      hour > 23 ||
      minute > 59
    ) {
      throw new EventInputError("有効な日時を入力してください。");
    }
    return new Date(value);
  }

  function eventInput(body, current = undefined) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new EventInputError("入力内容を確認してください。");
    }
    const input = body;
    const data = {};

    for (const field of ["title", "location", "memo"]) {
      if (field in input) {
        const value = input[field];
        if (typeof value !== "string" && !(value === null && field !== "title")) {
          throw new EventInputError("タイトル・場所・メモは文字で入力してください。");
        }
        if (field === "title") {
          const trimmed = value.trim();
          if (trimmed.length > MAX_TITLE_LEN) {
            throw new EventInputError(`タイトルは${MAX_TITLE_LEN}文字以内で入力してください。`);
          }
          data.title = trimmed;
        } else if (field === "location") {
          if (value !== null && value.length > MAX_LOCATION_LEN) {
            throw new EventInputError(`場所は${MAX_LOCATION_LEN}文字以内で入力してください。`);
          }
          data.location = value === null ? null : value.trim();
        } else {
          if (value !== null && value.length > MAX_MEMO_LEN) {
            throw new EventInputError(`メモは${MAX_MEMO_LEN}文字以内で入力してください。`);
          }
          data.memo = value === null ? null : value.trim();
        }
      }
    }

    if ((!current || "title" in input) && !data.title) {
      throw new EventInputError("タイトルを入力してください。");
    }

    if (!current || "eventType" in input) {
      const value = input.eventType ?? "INTERVIEW";
      if (typeof value !== "string" || !EVENT_KINDS.includes(value)) {
        throw new EventInputError("予定の種別を選んでください。");
      }
      data.eventType = value;
    }

    for (const field of ["startAt", "endAt"]) {
      if (field in input || (!current && field === "startAt")) {
        const value = input[field];
        if (field === "endAt" && (value === null || value === "")) {
          data.endAt = null;
          continue;
        }
        data[field] = parseIsoDateTime(value);
      }
    }

    const start = data.startAt ?? (current && current.startAt ? new Date(current.startAt) : undefined);
    const end =
      data.endAt === undefined
        ? current && current.endAt
          ? new Date(current.endAt)
          : null
        : data.endAt;

    if (start && end && end <= start) {
      throw new EventInputError("終了日時は開始日時より後にしてください。");
    }

    if ("isDone" in input) {
      if (typeof input.isDone !== "boolean") {
        throw new EventInputError("完了状態を確認してください。");
      }
      data.isDone = input.isDone;
    }

    if ("allDay" in input) {
      if (typeof input.allDay !== "boolean") {
        throw new EventInputError("終日設定を確認してください。");
      }
      data.allDay = input.allDay;
    }

    return data;
  }

  return {
    EVENT_KINDS,
    EventInputError,
    parseIsoDateTime,
    eventInput,
  };
});
