(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.JobTrackerCalendar = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EVENT_LABELS = Object.freeze({
    INTERVIEW: "面接",
    INTERNSHIP: "インターン",
    ES_DEADLINE: "ES締切",
    WEB_TEST: "Webテスト",
    BRIEFING: "説明会",
    OTHER: "その他",
  });

  const ONE_HOUR_FALLBACK_NOTE = "終了日時が未設定のため、カレンダーでは1時間の予定にしています。";

  function nextEvent(events, now = Date.now()) {
    if (!Array.isArray(events)) return undefined;
    return events
      .filter((e) => e && !e.isDone && new Date(e.endAt || e.startAt).getTime() >= now)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0];
  }

  function localDateTime(value) {
    const d = new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function stamp(value) {
    return new Date(value)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  }

  function formatEventTitle(e) {
    return e.company && e.company.name ? `${e.company.name}：${e.title}` : e.title;
  }

  function resolveEventEnd(e) {
    return e.endAt || new Date(Date.parse(e.startAt) + 60 * 60 * 1000).toISOString();
  }

  function formatEventDetails(e) {
    return [e.memo, !e.endAt ? ONE_HOUR_FALLBACK_NOTE : ""].filter(Boolean).join("\n\n");
  }

  function previewCalendarExport(e) {
    const isOneHourFallback = !e.endAt && !e.allDay;
    const resolvedEnd = resolveEventEnd(e);
    return {
      title: formatEventTitle(e),
      startAt: new Date(e.startAt).toISOString(),
      endAt: resolvedEnd,
      allDay: Boolean(e.allDay),
      isOneHourFallback,
      fallbackNotice: isOneHourFallback ? ONE_HOUR_FALLBACK_NOTE : null,
      location: e.location || "",
      details: formatEventDetails(e),
    };
  }

  function googleCalendarUrl(e) {
    const url = new URL("https://calendar.google.com/calendar/render");
    url.search = new URLSearchParams({
      action: "TEMPLATE",
      text: formatEventTitle(e),
      dates: `${stamp(e.startAt)}/${stamp(resolveEventEnd(e))}`,
      details: formatEventDetails(e),
      location: e.location || "",
    }).toString();
    return url.href;
  }

  function escapeText(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,");
  }

  // RFC 5545: fold at 75 UTF-8 octets without splitting a multi-byte Unicode code point.
  function fold(value) {
    const encoder = new TextEncoder();
    let line = "";
    let bytes = 0;
    const lines = [];
    for (const char of value) {
      const size = encoder.encode(char).length;
      if (bytes + size > 75) {
        lines.push(line);
        line = " ";
        bytes = 1;
      }
      line += char;
      bytes += size;
    }
    lines.push(line);
    return lines.join("\r\n");
  }

  function calendarFile(e, now = new Date()) {
    return (
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Job Tracker//Calendar//JA",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        `UID:${escapeText(e.id)}@job-tracker.local`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(e.startAt)}`,
        `DTEND:${stamp(resolveEventEnd(e))}`,
        `SUMMARY:${escapeText(formatEventTitle(e))}`,
        `LOCATION:${escapeText(e.location || "")}`,
        `DESCRIPTION:${escapeText(formatEventDetails(e))}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ]
        .map(fold)
        .join("\r\n") + "\r\n"
    );
  }

  return {
    EVENT_LABELS,
    ONE_HOUR_FALLBACK_NOTE,
    nextEvent,
    localDateTime,
    previewCalendarExport,
    googleCalendarUrl,
    calendarFile,
    fold,
    escapeText,
  };
});
