const { google } = require("googleapis");
const { DateTime, Interval } = require("luxon");

const ZONE = "Europe/London";

// ------- Helpers -------
function pTimeout(promise, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    promise.then(v => { clearTimeout(id); resolve(v); },
                 e => { clearTimeout(id); reject(e); });
  });
}

function getAuth() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) throw new Error("Missing GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY");
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");
  return new google.auth.JWT(email, null, key, ["https://www.googleapis.com/auth/calendar"]);
}
function getCalendar() {
  const auth = getAuth();
  auth._context = { timeout: 8000 };
  return google.calendar({ version: "v3", auth });
}

function getTherapistMap() {
  const raw = process.env.THERAPIST_CALENDARS || "{}";
  try { return JSON.parse(raw); } catch {
    const m = {};
    raw.split(";").map(s => s.trim()).filter(Boolean).forEach(pair => {
      const i = pair.indexOf(":");
      if (i > 0) m[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    });
    return m;
  }
}
function getCalendarIdForTherapist(name) {
  if (!name) return null;
  const m = getTherapistMap();
  const key = Object.keys(m).find(k => k.toLowerCase() === String(name).toLowerCase());
  return key ? m[key] : null;
}
function listTherapists() { return Object.keys(getTherapistMap()); }

// ------- Availability -------
async function freebusy(calendarId, startIso, endIso) {
  if (!calendarId) throw new Error("calendarId required");
  const calendar = getCalendar();
  const resp = await pTimeout(
    calendar.freebusy.query({
      requestBody: {
        timeMin: startIso,
        timeMax: endIso,
        items: [{ id: calendarId }],
        timeZone: ZONE,
      },
    }),
    8000, "calendar.freebusy.query"
  );
  const busy = resp.data.calendars[calendarId]?.busy || [];
  return busy.map(b => ({ start: b.start, end: b.end }));
}
function overlaps(busy, startIso, endIso) {
  const start = DateTime.fromISO(startIso, { zone: ZONE });
  const end   = DateTime.fromISO(endIso,   { zone: ZONE });
  const target = Interval.fromDateTimes(start, end);
  return busy.some(b => {
    const bi = Interval.fromDateTimes(
      DateTime.fromISO(b.start, { zone: ZONE }),
      DateTime.fromISO(b.end,   { zone: ZONE })
    );
    return bi.overlaps(target);
  });
}
async function isFree(calendarId, startIso, endIso) {
  const busy = await freebusy(calendarId, startIso, endIso);
  return { anyFree: !overlaps(busy, startIso, endIso), busy };
}
async function suggestNearby(calendarId, startIso, endIso, limit = 2) {
  const { DateTime } = require("luxon");
  const start = DateTime.fromISO(startIso, { zone: ZONE });
  const end   = DateTime.fromISO(endIso,   { zone: ZONE });
  const durM  = end.diff(start, "minutes").minutes;
  const candidates = [
    start.minus({ minutes: 30 }), start.plus({ minutes: 30 }),
    start.minus({ minutes: 60 }), start.plus({ minutes: 60 }),
  ];
  const out = [];
  for (const s of candidates) {
    const e = s.plus({ minutes: durM });
    const sIso = s.toISO(); const eIso = e.toISO();
    try {
      const { anyFree } = await isFree(calendarId, sIso, eIso);
      if (anyFree) {
        out.push({ startIso: sIso, endIso: eIso, startLocalPretty: s.toFormat("ccc dd LLL yyyy, t") });
        if (out.length >= limit) break;
      }
    } catch (err) { console.error("[gcal] suggestNearby error:", err?.message || err); }
  }
  return out;
}

// ------- Events -------
async function getEvent(calendarId, eventId) {
  const calendar = getCalendar();
  const resp = await pTimeout(
    calendar.events.get({ calendarId, eventId }),
    8000, "calendar.events.get"
  );
  return resp.data;
}
async function updateEventTimes(calendarId, eventId, startIso, endIso) {
  const calendar = getCalendar();
  const resp = await pTimeout(
    calendar.events.patch({
      calendarId, eventId,
      requestBody: {
        start: { dateTime: startIso, timeZone: ZONE },
        end:   { dateTime: endIso,   timeZone: ZONE },
      },
      sendUpdates: "none",
    }),
    8000, "calendar.events.patch"
  );
  return resp.data;
}
async function deleteEvent(calendarId, eventId) {
  const calendar = getCalendar();
  await pTimeout(
    calendar.events.delete({ calendarId, eventId, sendUpdates: "none" }),
    8000, "calendar.events.delete"
  );
  return true;
}

async function createEvent(calendarId, { startIso, endIso, summary, description, requestId, privateProps }) {
  if (!calendarId) throw new Error("calendarId required");
  const calendar = getCalendar();

  if (requestId) {
    try {
      const existing = await pTimeout(
        calendar.events.list({
          calendarId,
          timeMin: startIso, timeMax: endIso,
      privateExtendedProperty: [String(key) + "=" + String(value)],
          singleEvents: true, maxResults: 1,
        }),
        8000, "calendar.events.list"
      );
      if ((existing.data.items || []).length > 0) {
        const it = existing.data.items[0];
        return { alreadyExists: true, event: it };
      }
    } catch (e) { console.warn("[gcal] list existing failed:", e?.message || e); }
  }

  const ext = {};
  if (requestId) ext.requestId = requestId;
  if (privateProps && typeof privateProps === "object") Object.assign(ext, privateProps);

  const resp = await pTimeout(
    calendar.events.insert({
      calendarId,
      requestBody: {
        summary,
        description,
        start: { dateTime: startIso, timeZone: ZONE },
        end:   { dateTime: endIso,   timeZone: ZONE },
        extendedProperties: Object.keys(ext).length ? { private: ext } : undefined,
      },
      sendUpdates: "none",
    }),
    8000, "calendar.events.insert"
  );
  return { alreadyExists: false, event: resp.data };
}

async function searchEvents(calendarId, timeMin, timeMax, query, maxResults = 10) {
  // Uses Calendar API: events.list with 'q' to match summary/description/body.
  // Returns an array of event items (singleEvents=true, orderBy=startTime).
  const calendar = getCalendar();
  const resp = await pTimeout(
    calendar.events.list({
      calendarId,
      singleEvents: true,
      orderBy: "startTime",
      timeMin,
      timeMax,
      q: query,
      maxResults
    }),
    8000,
    "calendar.events.list (search)"
  );
  return resp.data.items || [];
}
async function searchByPrivateProp(calendarId, timeMin, timeMax, key, value, maxResults = 25) {
  const calendar = getCalendar();
  const resp = await pTimeout(
    calendar.events.list({
      calendarId,
      singleEvents: true,
      orderBy: "startTime",
      timeMin,
      timeMax,
      privateExtendedProperty: [String(key) + "=" + String(value)],
      maxResults
    }),
    8000,
    "calendar.events.list (privateProp)"
  );
  return resp.data.items || [];
}
module.exports = {
  ZONE,
  getTherapistMap, listTherapists, getCalendarIdForTherapist,
  freebusy, isFree, suggestNearby, searchEvents,
  createEvent, getEvent, updateEventTimes, deleteEvent
};












