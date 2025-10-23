/** Return true if startIso (interpreted in TIMEZONE) is within 10:00–21:00 local. */
function isWithinOpeningHours(startIso, TIMEZONE) {
  try {
    const tz = TIMEZONE || "Europe/London";
    const local = new Date(new Date(startIso).toLocaleString("en-GB", { timeZone: tz }));
    const h = local.getHours();
    return h >= 10 && h < 21; // last booking must start before 21:00
  } catch (_e) {
    return false;
  }
}
const express = require("express");
require("dotenv").config();

const {
  getAuth,
  isFree,
  createEvent,
  getEvent,
  deleteEvent,
  updateEventTime,
  searchEvents
} = require("./gcal");

const app = express();
app.use(express.json());

const TIMEZONE = process.env.GOOGLE_TIMEZONE || "Europe/London";
/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}

/** Therapist -> Calendar mapping */
const THERAPISTS = [
  { name: "Lilly", calendarId: "cd6e4c1efc4856dafe592cf03f99883474944f882d89d16ce0b82023337494cc@group.calendar.google.com" },
  { name: "Kat",   calendarId: "ce3a7c522d6f27ef89a814cbd4371bee305a3067ee77c96e80a2ab37ad50bdd9@group.calendar.google.com" },
  { name: "Sara",  calendarId: "3d81f53c3c66d78ba04016c786782fca077b46ffd11b90e95d00c0ed4fb226b9@group.calendar.google.com" }
];

/** Health */
app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: process.env.GOOGLE_AUTH_MODE || "service", therapists: THERAPISTS.map(t => t.name) });
});

/** Availability — returns anyFree + freeTherapists to avoid LLM misread */
app.post("/availability_OLD", async (req, res) => {
  const { startIso, endIso, preferredTherapist } = req.body || {};
  if (!startIso || !endIso) {
    return res.status(400).json({ error: "startIso and endIso required" });
  }
  try {

    const list = preferredTherapist
      ? THERAPISTS.filter(t => t.name.toLowerCase() === String(preferredTherapist).toLowerCase())
      : THERAPISTS;

    const results = [];
    for (const t of list) {
      try {
        const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
        results.push({ therapist: t.name, calendarId: t.calendarId, free, status: "ok" });
      } catch (inner) {
        results.push({
          therapist: t.name,
          calendarId: t.calendarId,
          free: null,
          status: "error",
          error: String(inner.message || inner)});
      }
    }

    const freeTherapists = results.filter(r => r.free === true).map(r => r.therapist);
    const anyFree = freeTherapists.length > 0;

    res.json({ ok: true, anyFree, freeTherapists, availability: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Book */
app.post("/book_OLD", async (req, res) => {
  const { therapistName, startIso, endIso, clientName, clientPhone, serviceName, duration } = req.body || {};
  if (!startIso || !endIso || !clientName) return res.status(400).json({ error: "startIso, endIso, clientName required" });
  try {

    let candidates = THERAPISTS;
    if (therapistName) {
      const match = THERAPISTS.find(t => t.name.toLowerCase() === String(therapistName).toLowerCase());
      candidates = match ? [match] : THERAPISTS;
    }

    let chosen = null;
    for (const t of candidates) {
      const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
      if (free) { chosen = t; break; }
    }
    if (!chosen) return res.status(409).json({ ok:false, error: "No therapist available for that time." });

    const summary = `${serviceName || "Massage"} — ${clientName}${therapistName ? " ("+chosen.name+")" : ""}`;
    const description = `Booked by AI Receptionist
Client: ${clientName} (${clientPhone || "-"})
Service: ${serviceName || "Massage"} (${duration || "?"} mins)
Therapist: ${chosen.name}`;

    const event = await createEvent(await getAuth(), chosen.calendarId, {
      summary, description, startIso, endIso, timeZone: TIMEZONE
    });

    res.json({ ok: true, therapist: chosen.name, eventId: event.id, htmlLink: event.htmlLink });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Helpers */
async function findEventByIdAcross(auth, eventId) {
  for (const t of THERAPISTS) {
    try {
      const ev = await getEvent(auth, t.calendarId, eventId);
      if (ev) return { therapist: t, event: ev };
    } catch {}
  }
  return null;
}

async function findEventByClientAndTime(auth, {
  clientName,
  approxStartIso,
  windowMins = 180,
  forceCalendarId
}) {
  const TIMEZONE = process.env.TIMEZONE || "Europe/London";
/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}
  const calendar = await getCalendarSafe();
  const approx = new Date(approxStartIso);
  const min = new Date(approx.getTime() - windowMins * 60 * 1000).toISOString();
  const max = new Date(approx.getTime() + windowMins * 60 * 1000).toISOString();

  const lc = (s) => String(s || "").toLowerCase();
  const target = lc(clientName);

  const who = THERAPISTS || [];
  const list = forceCalendarId
    ? who.filter(t => t.calendarId === forceCalendarId)
    : who;

  for (const t of list) {
    const evs = await calendar.events.list({
      calendarId: t.calendarId,
      timeMin: min,
      timeMax: max,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
      q: clientName
    });

    const items = evs.data.items || [];
    const match = items.find(e => {
      const sum = lc(e.summary);
      const desc = lc((e.description || ""));
      return sum.includes(target) || desc.includes(target);
    });

    if (match) {
      return {
        therapist: t,
        event: {
          id: match.id,
          start: match.start?.dateTime || match.start?.date,
          end:   match.end?.dateTime   || match.end?.date
        }
      };
    }
  }
  return null;
}

/** Reschedule */
app.post("/availability_OLD", async (req, res) => {
  const { startIso, endIso, preferredTherapist } = req.body || {};
  if (!startIso || !endIso) {
    return res.status(400).json({ error: "startIso and endIso required" });
  }
  try {

    const list = preferredTherapist
      ? THERAPISTS.filter(t => t.name.toLowerCase() === String(preferredTherapist).toLowerCase())
      : THERAPISTS;

    const results = [];
    for (const t of list) {
      try {
        const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
        results.push({ therapist: t.name, calendarId: t.calendarId, free, status: "ok" });
      } catch (inner) {
        results.push({
          therapist: t.name,
          calendarId: t.calendarId,
          free: null,
          status: "error",
          error: String(inner.message || inner)});
      }
    }

    const freeTherapists = results.filter(r => r.free === true).map(r => r.therapist);
    const anyFree = freeTherapists.length > 0;

    res.json({ ok: true, anyFree, freeTherapists, availability: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Book */
app.post("/book_OLD", async (req, res) => {
  const { therapistName, startIso, endIso, clientName, clientPhone, serviceName, duration } = req.body || {};
  if (!startIso || !endIso || !clientName) return res.status(400).json({ error: "startIso, endIso, clientName required" });
  try {

    let candidates = THERAPISTS;
    if (therapistName) {
      const match = THERAPISTS.find(t => t.name.toLowerCase() === String(therapistName).toLowerCase());
      candidates = match ? [match] : THERAPISTS;
    }

    let chosen = null;
    for (const t of candidates) {
      const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
      if (free) { chosen = t; break; }
    }
    if (!chosen) return res.status(409).json({ ok:false, error: "No therapist available for that time." });

    const summary = `${serviceName || "Massage"} — ${clientName}${therapistName ? " ("+chosen.name+")" : ""}`;
    const description = `Booked by AI Receptionist
Client: ${clientName} (${clientPhone || "-"})
Service: ${serviceName || "Massage"} (${duration || "?"} mins)
Therapist: ${chosen.name}`;

    const event = await createEvent(await getAuth(), chosen.calendarId, {
      summary, description, startIso, endIso, timeZone: TIMEZONE
    });

    res.json({ ok: true, therapist: chosen.name, eventId: event.id, htmlLink: event.htmlLink });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Helpers */
async function findEventByIdAcross(auth, eventId) {
  for (const t of THERAPISTS) {
    try {
      const ev = await getEvent(auth, t.calendarId, eventId);
      if (ev) return { therapist: t, event: ev };
    } catch {}
  }
  return null;
}

async function findEventByClientAndTime(auth, {
  clientName,
  approxStartIso,
  windowMins = 180,
  forceCalendarId
}) {
  const TIMEZONE = process.env.TIMEZONE || "Europe/London";
/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}
  const calendar = await getCalendarSafe();
  const approx = new Date(approxStartIso);
  const min = new Date(approx.getTime() - windowMins * 60 * 1000).toISOString();
  const max = new Date(approx.getTime() + windowMins * 60 * 1000).toISOString();

  const lc = (s) => String(s || "").toLowerCase();
  const target = lc(clientName);

  const who = THERAPISTS || [];
  const list = forceCalendarId
    ? who.filter(t => t.calendarId === forceCalendarId)
    : who;

  for (const t of list) {
    const evs = await calendar.events.list({
      calendarId: t.calendarId,
      timeMin: min,
      timeMax: max,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
      q: clientName
    });

    const items = evs.data.items || [];
    const match = items.find(e => {
      const sum = lc(e.summary);
      const desc = lc((e.description || ""));
      return sum.includes(target) || desc.includes(target);
    });

    if (match) {
      return {
        therapist: t,
        event: {
          id: match.id,
          start: match.start?.dateTime || match.start?.date,
          end:   match.end?.dateTime   || match.end?.date
        }
      };
    }
  }
  return null;
}

/** Reschedule */


/** Cancel */
app.post("/availability_OLD", async (req, res) => {
  const { startIso, endIso, preferredTherapist } = req.body || {};
  if (!startIso || !endIso) {
    return res.status(400).json({ error: "startIso and endIso required" });
  }
  try {

    const list = preferredTherapist
      ? THERAPISTS.filter(t => t.name.toLowerCase() === String(preferredTherapist).toLowerCase())
      : THERAPISTS;

    const results = [];
    for (const t of list) {
      try {
        const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
        results.push({ therapist: t.name, calendarId: t.calendarId, free, status: "ok" });
      } catch (inner) {
        results.push({
          therapist: t.name,
          calendarId: t.calendarId,
          free: null,
          status: "error",
          error: String(inner.message || inner)});
      }
    }

    const freeTherapists = results.filter(r => r.free === true).map(r => r.therapist);
    const anyFree = freeTherapists.length > 0;

    res.json({ ok: true, anyFree, freeTherapists, availability: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Book */
app.post("/book_OLD", async (req, res) => {
  const { therapistName, startIso, endIso, clientName, clientPhone, serviceName, duration } = req.body || {};
  if (!startIso || !endIso || !clientName) return res.status(400).json({ error: "startIso, endIso, clientName required" });
  try {

    let candidates = THERAPISTS;
    if (therapistName) {
      const match = THERAPISTS.find(t => t.name.toLowerCase() === String(therapistName).toLowerCase());
      candidates = match ? [match] : THERAPISTS;
    }

    let chosen = null;
    for (const t of candidates) {
      const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
      if (free) { chosen = t; break; }
    }
    if (!chosen) return res.status(409).json({ ok:false, error: "No therapist available for that time." });

    const summary = `${serviceName || "Massage"} — ${clientName}${therapistName ? " ("+chosen.name+")" : ""}`;
    const description = `Booked by AI Receptionist
Client: ${clientName} (${clientPhone || "-"})
Service: ${serviceName || "Massage"} (${duration || "?"} mins)
Therapist: ${chosen.name}`;

    const event = await createEvent(await getAuth(), chosen.calendarId, {
      summary, description, startIso, endIso, timeZone: TIMEZONE
    });

    res.json({ ok: true, therapist: chosen.name, eventId: event.id, htmlLink: event.htmlLink });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Helpers */
async function findEventByIdAcross(auth, eventId) {
  for (const t of THERAPISTS) {
    try {
      const ev = await getEvent(auth, t.calendarId, eventId);
      if (ev) return { therapist: t, event: ev };
    } catch {}
  }
  return null;
}

async function findEventByClientAndTime(auth, {
  clientName,
  approxStartIso,
  windowMins = 180,
  forceCalendarId
}) {
  const TIMEZONE = process.env.TIMEZONE || "Europe/London";
/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}
  const calendar = await getCalendarSafe();
  const approx = new Date(approxStartIso);
  const min = new Date(approx.getTime() - windowMins * 60 * 1000).toISOString();
  const max = new Date(approx.getTime() + windowMins * 60 * 1000).toISOString();

  const lc = (s) => String(s || "").toLowerCase();
  const target = lc(clientName);

  const who = THERAPISTS || [];
  const list = forceCalendarId
    ? who.filter(t => t.calendarId === forceCalendarId)
    : who;

  for (const t of list) {
    const evs = await calendar.events.list({
      calendarId: t.calendarId,
      timeMin: min,
      timeMax: max,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
      q: clientName
    });

    const items = evs.data.items || [];
    const match = items.find(e => {
      const sum = lc(e.summary);
      const desc = lc((e.description || ""));
      return sum.includes(target) || desc.includes(target);
    });

    if (match) {
      return {
        therapist: t,
        event: {
          id: match.id,
          start: match.start?.dateTime || match.start?.date,
          end:   match.end?.dateTime   || match.end?.date
        }
      };
    }
  }
  return null;
}

/** Reschedule */
app.post("/availability_OLD", async (req, res) => {
  const { startIso, endIso, preferredTherapist } = req.body || {};
  if (!startIso || !endIso) {
    return res.status(400).json({ error: "startIso and endIso required" });
  }
  try {

    const list = preferredTherapist
      ? THERAPISTS.filter(t => t.name.toLowerCase() === String(preferredTherapist).toLowerCase())
      : THERAPISTS;

    const results = [];
    for (const t of list) {
      try {
        const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
        results.push({ therapist: t.name, calendarId: t.calendarId, free, status: "ok" });
      } catch (inner) {
        results.push({
          therapist: t.name,
          calendarId: t.calendarId,
          free: null,
          status: "error",
          error: String(inner.message || inner)});
      }
    }

    const freeTherapists = results.filter(r => r.free === true).map(r => r.therapist);
    const anyFree = freeTherapists.length > 0;

    res.json({ ok: true, anyFree, freeTherapists, availability: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Book */
app.post("/book_OLD", async (req, res) => {
  const { therapistName, startIso, endIso, clientName, clientPhone, serviceName, duration } = req.body || {};
  if (!startIso || !endIso || !clientName) return res.status(400).json({ error: "startIso, endIso, clientName required" });
  try {

    let candidates = THERAPISTS;
    if (therapistName) {
      const match = THERAPISTS.find(t => t.name.toLowerCase() === String(therapistName).toLowerCase());
      candidates = match ? [match] : THERAPISTS;
    }

    let chosen = null;
    for (const t of candidates) {
      const free = await isFree(await getAuth(), t.calendarId, startIso, endIso, TIMEZONE);
      if (free) { chosen = t; break; }
    }
    if (!chosen) return res.status(409).json({ ok:false, error: "No therapist available for that time." });

    const summary = `${serviceName || "Massage"} — ${clientName}${therapistName ? " ("+chosen.name+")" : ""}`;
    const description = `Booked by AI Receptionist
Client: ${clientName} (${clientPhone || "-"})
Service: ${serviceName || "Massage"} (${duration || "?"} mins)
Therapist: ${chosen.name}`;

    const event = await createEvent(await getAuth(), chosen.calendarId, {
      summary, description, startIso, endIso, timeZone: TIMEZONE
    });

    res.json({ ok: true, therapist: chosen.name, eventId: event.id, htmlLink: event.htmlLink });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Helpers */
async function findEventByIdAcross(auth, eventId) {
  for (const t of THERAPISTS) {
    try {
      const ev = await getEvent(auth, t.calendarId, eventId);
      if (ev) return { therapist: t, event: ev };
    } catch {}
  }
  return null;
}

async function findEventByClientAndTime(auth, {
  clientName,
  approxStartIso,
  windowMins = 180,
  forceCalendarId
}) {
  const TIMEZONE = process.env.TIMEZONE || "Europe/London";
/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}
  const calendar = await getCalendarSafe();
  const approx = new Date(approxStartIso);
  const min = new Date(approx.getTime() - windowMins * 60 * 1000).toISOString();
  const max = new Date(approx.getTime() + windowMins * 60 * 1000).toISOString();

  const lc = (s) => String(s || "").toLowerCase();
  const target = lc(clientName);

  const who = THERAPISTS || [];
  const list = forceCalendarId
    ? who.filter(t => t.calendarId === forceCalendarId)
    : who;

  for (const t of list) {
    const evs = await calendar.events.list({
      calendarId: t.calendarId,
      timeMin: min,
      timeMax: max,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
      q: clientName
    });

    const items = evs.data.items || [];
    const match = items.find(e => {
      const sum = lc(e.summary);
      const desc = lc((e.description || ""));
      return sum.includes(target) || desc.includes(target);
    });

    if (match) {
      return {
        therapist: t,
        event: {
          id: match.id,
          start: match.start?.dateTime || match.start?.date,
          end:   match.end?.dateTime   || match.end?.date
        }
      };
    }
  }
  return null;
}

/** Reschedule */
app.post("/reschedule", async (req, res) => {
  const { eventId, therapistName, clientName, oldStartIso, windowMins, newStartIso, newEndIso } = req.body || {};
  if (!newStartIso || !newEndIso) return res.status(400).json({ error: "newStartIso and newEndIso required" });

  try {

    let found = null;

    if (eventId) {
      found = await findEventByIdAcross(auth, eventId);
    } else if (clientName && oldStartIso) {
      found = await findEventByClientAndTime(await getAuth(), { clientName, approxStartIso: oldStartIso, windowMins: windowMins || 180 });
    } else {
      return res.status(400).json({ error: "Provide eventId or (clientName + oldStartIso)" });
    }

    if (!found) return res.status(404).json({ ok:false, error: "Existing booking not found." });

    if (therapistName && therapistName.toLowerCase() !== found.therapist.name.toLowerCase()) {
      return res.status(409).json({ ok:false, error: "Booking belongs to a different therapist. Please cancel & rebook with the requested therapist." });
    }

    const free = await isFree(await getAuth(), found.therapist.calendarId, newStartIso, newEndIso, TIMEZONE);
    if (!free) return res.status(409).json({ ok:false, error: `New time not available for ${found.therapist.name}.` });

    const updated = await updateEventTime(await getAuth(), found.therapist.calendarId, found.event.id, {
      startIso: newStartIso, endIso: newEndIso, timeZone: TIMEZONE
    });

    res.json({ ok:true, therapist: found.therapist.name, eventId: updated.id, oldStart: found.event.start, newStart: updated.start, htmlLink: updated.htmlLink });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Cancel */
app.post("/cancel", async (req, res) => {
  const { eventId, clientName, startIso, windowMins, therapistName } = req.body || {};

  try {

    let found = null;

    if (eventId) {
      found = await findEventByIdAcross(auth, eventId);
    } else if (clientName && startIso) {
      found = await findEventByClientAndTime(await getAuth(), { clientName, approxStartIso: startIso, windowMins: windowMins || 180 });
    } else {
      return res.status(400).json({ error: "Provide eventId or (clientName + startIso)" });
    }

    if (!found) return res.status(404).json({ ok:false, error: "Booking not found." });

    if (therapistName && therapistName.toLowerCase() !== found.therapist.name.toLowerCase()) {
      return res.status(409).json({ ok:false, error: "Booking belongs to a different therapist than requested." });
    }

    await deleteEvent(await getAuth(), found.therapist.calendarId, found.event.id);
    res.json({ ok:true, therapist: found.therapist.name, cancelledEventId: found.event.id });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Secure webhook for Retell */
function verifySecret(req, res, next) {
  const header = req.headers["x-shared-secret"];
  if (!header || header !== process.env.SECURITY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
app.post("/webhook/retell", verifySecret, (req, res) => {
  console.log("[Retell] Event:", req.body?.event, "Payload:", JSON.stringify(req.body?.data || {}));
  res.json({ ok: true });
});

app.get("/", (_req, res) => res.send("KindThai Retell + Google API (service account) — ready"));

const PORT = process.env.PORT || 3000;

const { google } = require("googleapis");
/** Opening hours check using only req.body values (no route variables).
 *  Hours (Europe/London): 10:00–21:00 (inclusive start, exclusive end).
 *  Returns { ok:true } if inside hours or no time was supplied.
 *  Returns { ok:false, error:"outside_hours", message: "..."} if outside hours.
 */
function openingHoursGuard(req, TIMEZONE) {
  try {
    const b = (req && req.body) ? req.body : {};
    const iso = b.newStartIso || b.oldStartIso || b.startIso;
    if (!iso) return { ok: true };  // no time provided yet -> don't block

    const tz = TIMEZONE || "Europe/London";
    const local = new Date(new Date(iso).toLocaleString("en-GB", { timeZone: tz }));
    const h = local.getHours();

    const openHour  = 10; // 10:00
    const closeHour = 21; // last booking must start before 21:00

    if (Number.isFinite(h) && (h < openHour || h >= closeHour)) {
      return {
        ok: false,
        error: "outside_hours",
        message: "We open at 10 AM and close at 9 PM — please choose a time within that range."
      };
    }
    return { ok: true };
  } catch (e) {
    // Fail-open: in doubt, don't crash the route.
    return { ok: true };
  }
}


async function getCalendarSafe() {
  const auth = await getAuth();
  const { google } = require("googleapis");
/** Opening hours check using only req.body values (no route variables).
 *  Hours (Europe/London): 10:00–21:00 (inclusive start, exclusive end).
 *  Returns { ok:true } if inside hours or no time was supplied.
 *  Returns { ok:false, error:"outside_hours", message: "..."} if outside hours.
 */
function openingHoursGuard(req, TIMEZONE) {
  try {
    const b = (req && req.body) ? req.body : {};
    const iso = b.newStartIso || b.oldStartIso || b.startIso;
    if (!iso) return { ok: true };  // no time provided yet -> don't block

    const tz = TIMEZONE || "Europe/London";
    const local = new Date(new Date(iso).toLocaleString("en-GB", { timeZone: tz }));
    const h = local.getHours();

    const openHour  = 10; // 10:00
    const closeHour = 21; // last booking must start before 21:00

    if (Number.isFinite(h) && (h < openHour || h >= closeHour)) {
      return {
        ok: false,
        error: "outside_hours",
        message: "We open at 10 AM and close at 9 PM — please choose a time within that range."
      };
    }
    return { ok: true };
  } catch (e) {
    // Fail-open: in doubt, don't crash the route.
    return { ok: true };
  }
}
  return google.calendar({ version: "v3", auth });
}
/** TEMP DEBUG: raw freebusy + events in a window for a therapist */
app.post("/_debug/window", async (req, res) => {
  try {
    const { therapistName, startIso, endIso } = req.body || {};
    if (!therapistName || !startIso || !endIso) {
      return res.status(400).json({ error: "therapistName, startIso, endIso required" });
    }

    const t = THERAPISTS.find(x => x.name.toLowerCase() === String(therapistName).toLowerCase());
    if (!t) return res.status(404).json({ error: "Therapist not found" });

    const calendar = await getCalendarSafe();

    // 1) Raw freebusy
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: startIso,
        timeMax: endIso,
        timeZone: TIMEZONE,
        items: [{ id: t.calendarId }]
      }
    });

    // 2) Events list in the same window
    const evs = await calendar.events.list({
      calendarId: t.calendarId,
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25
    });

    res.json({
      ok: true,
      therapist: t.name,
      calendarId: t.calendarId,
      timeWindow: { startIso, endIso, timeZone: TIMEZONE },
      freebusyRaw: fb.data,
      events: evs.data.items?.map(e => ({
        id: e.id,
        status: e.status,
        summary: e.summary,
        start: e.start,
        end: e.end,
        creator: e.creator,
        organizer: e.organizer,
        transparency: e.transparency,      // "transparent" for free
        eventType: e.eventType,            // "default", "focusTime", etc.
      })) || []
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});

const chrono = require("chrono-node");

/** Natural language time -> ISO start/end in Europe/London (DST-safe).
 *  Body: { whenText: "tomorrow 6pm", durationMins: 60 }
 *  Returns: { ok, timeZone, startIso, endIso, parsedText }
 */
app.post("/nlp/slot", async (req, res) => {
  try {
    const { whenText, durationMins } = req.body || {};
    if (!whenText || !durationMins) {
      return res.status(400).json({ ok:false, error: "whenText and durationMins required" });
    }

    // Anchor "now" in Europe/London so 'tomorrow' resolves for the business timezone.
    const now = new Date(new Date().toLocaleString("en-GB", { timeZone: TIMEZONE }));

    // forwardDate ensures "Monday" in the past moves to the next Monday
    const parsed = chrono.parse(whenText, now, { forwardDate: true });
    if (!parsed.length || !parsed[0].start) {
      return res.status(422).json({ ok:false, error: "Could not parse whenText" });
    }

    const startLocal = parsed[0].start.date();                   // Local time in Europe/London
    const endLocal   = new Date(startLocal.getTime() + durationMins * 60000);

    // Format with the correct offset for TIMEZONE at that instant (handles DST)
    const toIsoWithTz = (d) => {
      // Get date-time parts in the business timezone
      const parts = Intl.DateTimeFormat("en-GB", {
        timeZone: TIMEZONE, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      }).formatToParts(d);
      const get = (t) => parts.find(p => p.type === t)?.value.padStart(2, "0");
      const y = get("year"), m = get("month"), da = get("day");
      const hh = get("hour"), mm = get("minute"), ss = get("second");

      // Derive numeric offset (minutes) for TIMEZONE at this date-time
      const utcNowStr = d.toLocaleString("en-US", { timeZone: "UTC" });
      const utcNow = new Date(utcNowStr);
      const offsetMin = -Math.round((d - utcNow) / 60000);
      const sign = offsetMin >= 0 ? "+" : "-";
      const abs = Math.abs(offsetMin);
      const offH = String(Math.floor(abs / 60)).padStart(2, "0");
      const offM = String(abs % 60).padStart(2, "0");
      return `${y}-${m}-${da}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
    };

    const startIso = toIsoWithTz(startLocal);
    const endIso   = toIsoWithTz(endLocal);

    return res.json({ ok: true, timeZone: TIMEZONE, startIso, endIso, parsedText: whenText });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});
app.listen(PORT, () => console.log(`Server started on http://localhost:${PORT}`));














/** =========================================
 *  NEW: /availability2 — DST-safe, async map, single auth
 *  ========================================= */
app.post("/availability", verifySecret, async (req, res) => {
  const TIMEZONE = process.env.TIMEZONE || "Europe/London";
        // Opening-hours guard (Europe/London 10:00–21:00)
    {
      const checkIso =
      (typeof newStartIso !== "undefined" && newStartIso) ||
      (typeof oldStartIso !== "undefined" && oldStartIso) ||
      (typeof startIso    !== "undefined" && startIso)    ||
      null;
      if (checkIso && !isWithinOpeningHours(checkIso, TIMEZONE)) {
        return res.json({
          ok: false,
          error: "outside_hours",
          message: "We open at 10 AM and close at 9 PM — please choose a time within that range."
        });
      }
    }// Opening-hours guard (Europe/London 10:00–21:00)
    if (!isWithinOpeningHours(startIso, TIMEZONE)) {
      return res.json({
        ok: false,
        error: "outside_hours",
        message: "We open at 10 AM and close at 9 PM — please choose a time within that range."
      });
    }/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}
  const { startIso, endIso, preferredTherapist } = req.body || {};
  if (!startIso || !endIso) {
    return res.status(400).json({ ok: false, error: "startIso and endIso required" });
  }
  try {
    const auth = await getAuth();
    // Narrow list if preferredTherapist specified
    const list = THERAPISTS.filter(t =>
      !preferredTherapist ||
      t.name.toLowerCase() === String(preferredTherapist).toLowerCase()
    );

    const checks = await Promise.all(list.map(async (t) => {
      try {
        const free = await isFree(auth, t.calendarId, startIso, endIso, TIMEZONE);
        return { therapist: t.name, calendarId: t.calendarId, free, status: "ok" };
      } catch (err) {
        return { therapist: t.name, calendarId: t.calendarId, free: null, status: "error", error: String(err && err.message || err) };
      }
    }));

    const freeTherapists = checks.filter(c => c.free === true).map(c => c.therapist);
    const anyFree = freeTherapists.length > 0;
    return res.json({ ok: true, anyFree, freeTherapists, availability: checks });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

/** =========================================
 *  NEW: /book2 — enforce clientName + clientPhone + duration
 *  therapist order Kat -> Sara -> Lilly when not specified.
 *  ========================================= */
app.post("/book", verifySecret, async (req, res) => {
  try {
    const auth = await getAuth();
    const TIMEZONE = process.env.TIMEZONE || "Europe/London";
    // Opening-hours guard (Europe/London 10:00–21:00)
    if (!isWithinOpeningHours(startIso, TIMEZONE)) {
      return res.json({
        ok: false,
        error: "outside_hours",
        message: "We open at 10 AM and close at 9 PM — please choose a time within that range."
      });
    }/** Business hours guard (Europe/London, DST-safe)
 * Open: 10:00, Close: 21:00, Closed DOW: none (change below if needed)
 */
const BUSINESS_OPEN_HHMM  = process.env.BUSINESS_OPEN_HHMM  || "10:00";
const BUSINESS_CLOSE_HHMM = process.env.BUSINESS_CLOSE_HHMM || "21:00";
const BUSINESS_CLOSED_DOW = (process.env.BUSINESS_CLOSED_DOW || "").split(",").map(s => s.trim()).filter(Boolean); // e.g. "Sun" or "Sun,Sat"

function _hmToMinutes(hm) {
  const [h, m] = String(hm).split(":").map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}
function _tzParts(iso, tz) {
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d); // e.g. "Sun"
  const hh = parseInt(hm.find(p => p.type === "hour").value, 10);
  const mm = parseInt(hm.find(p => p.type === "minute").value, 10);
  return { minutes: hh*60 + mm, weekday: wd };
}
function withinBusinessHours(startIso, endIso, tz) {
  try {
    const s = _tzParts(startIso, tz);
    const e = _tzParts(endIso,   tz);
    if (BUSINESS_CLOSED_DOW.includes(s.weekday)) return false;
    const open  = _hmToMinutes(BUSINESS_OPEN_HHMM);
    const close = _hmToMinutes(BUSINESS_CLOSE_HHMM);
    // Entire appointment must be within open..close (same local day window)
    return (s.minutes >= open) && (e.minutes <= close) && (e.minutes > s.minutes);
  } catch {
    return false;
  }
}
    const { therapistName, startIso, endIso, clientName, clientPhone, serviceName, duration } = req.body || {};

    // Minimum required fields
    if (!startIso || !endIso) {
      return res.status(400).json({ ok:false, error: "startIso and endIso are required" });
    }
    if (!clientName || !clientPhone || !duration) {
      return res.status(400).json({ ok:false, error: "clientName, clientPhone, and duration are required" });
    }

    // therapist selection
    function findTherapistByName(n) {
      const low = String(n || "").trim().toLowerCase();
      return THERAPISTS.find(x => String(x.name).trim().toLowerCase() === low);
    }
    let chosen = null;
    if (therapistName) {
      chosen = findTherapistByName(therapistName);
      if (!chosen) return res.status(404).json({ ok:false, error: "Requested therapist not found" });
    } else {
      const order = ["Kat", "Sara", "Lilly"];
      for (const n of order) {
        const t = findTherapistByName(n);
        if (t) { chosen = t; break; }
      }
    }
    if (!chosen) return res.status(404).json({ ok:false, error: "No therapist configured" });

    // check free
    const free = await isFree(auth, chosen.calendarId, startIso, endIso, TIMEZONE);
    if (!free) return res.status(409).json({ ok:false, error: `That time is not available for ${chosen.name}.` });

    // Create event
    const summary = `${serviceName || "Massage"} — ${clientName} (${chosen.name})`;
    const description = [
      `Booked by AI Receptionist`,
      `Client: ${clientName} (${clientPhone})`,
      `Service: ${serviceName || "Unknown"} (${duration} mins)`,
      `Therapist: ${chosen.name}`
    ].join("\n");

    const ev = await createEvent(auth, chosen.calendarId, {summary, description, startIso: startIso, endIso: endIso, timeZone: TIMEZONE});

    const eventId = ev?.data?.id || ev?.id;
    const htmlLink = ev?.data?.htmlLink || ev?.htmlLink;

    return res.json({ ok:true, therapist: chosen.name, eventId, htmlLink });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});











