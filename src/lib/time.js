const chrono = require("chrono-node");
const { DateTime } = require("luxon");

/**
 * Normalize UK mobile to E.164 (+44...) if possible.
 * Prefers headerPhone; falls back to bodyPhone.
 */
function normalizePhone(headerPhone, bodyPhone) {
  const pick = (headerPhone || bodyPhone || "").toString().trim();
  if (!pick) return "";
  let p = pick.replace(/[^\d+]/g, "");

  // Already E.164?
  if (p.startsWith("+")) return p;

  // UK local like 07xxxxxxxxx
  if (p.startsWith("07") && p.length >= 11) {
    return "+44" + p.substring(1);
  }

  // Landline 0xxxxxxxxxx → +44xxxxxxxxxx
  if (p.startsWith("0") && p.length >= 10) {
    return "+44" + p.substring(1);
  }

  return p; // Last resort
}

/**
 * Parse natural language time into start/end ISO with London TZ.
 * Returns { ok, data? , error? }
 */
function parseWhenText({ whenText, timeZone, referenceNowLocal, durationMins, anchorStartIso }) {
  if (!whenText || typeof whenText !== "string") {
    return { ok: false, error: "Missing whenText" };
  }

  const zone = timeZone || "Europe/London";
  const ref = referenceNowLocal
    ? DateTime.fromISO(referenceNowLocal, { zone })
    : DateTime.now().setZone(zone);

  const results = chrono.parse(whenText, ref.toJSDate(), { forwardDate: true });
  if (!results || results.length === 0) {
    return { ok: false, error: "Could not parse date/time" };
  }

  // Use first match
  const first = results[0];
  let start = first.start ? DateTime.fromJSDate(first.start.date(), { zone }) : null;

  // Optional anchoring for phrases like "next week same time"
  if (!start && anchorStartIso) {
    const anchor = DateTime.fromISO(anchorStartIso, { zone });
    if (anchor.isValid) start = anchor;
  }

  if (!start || !start.isValid) {
    return { ok: false, error: "Invalid start time" };
  }

  const mins = Number.isFinite(+durationMins) ? Number(durationMins) : 60;
  const end = start.plus({ minutes: mins });

  // Pretty strings for agent read-back
  const parsedText = start.toFormat("ccc dd LLL yyyy t");
  const startLocalPretty = start.toFormat("ccc dd LLL yyyy, t");

  return {
    ok: true,
    data: {
      startIso: start.toISO(),   // includes +00:00 / +01:00 offset
      endIso: end.toISO(),
      parsedText,
      startLocalPretty,
    },
  };
}

module.exports = { parseWhenText, normalizePhone };
