const express = require("express");
const router = express.Router();
const { DateTime } = require("luxon");
const {
  ZONE,
  getTherapistMap, getCalendarIdForTherapist,
  isFree, suggestNearby, createEvent,
  getEvent, updateEventTimes, deleteEvent,
  searchEvents, searchByPrivateProp
} = require("../lib/gcal");
const { ROSTER, MAX_ROOMS } = require("../lib/salonPolicy");

/** Map alias + add Rose from env */
function effectiveTherapistMap(raw) {
  const map = { ...raw };
  if (map["Sara"] && !map["Nina"]) {
    map["Nina"] = map["Sara"];
    delete map["Sara"];
  }
  const roseCal = process.env.ROSE_CAL_ID;
  if (roseCal) map["Rose"] = roseCal;
  return map;
}

/** Count busy therapists in window (for capacity gate). */
async function countSalonLoad(calIds, startIso, endIso) {
  let busy = 0;
  for (const id of calIds) {
    const { anyFree } = await isFree(id, startIso, endIso);
    if (!anyFree) busy++;
  }
  return busy;
}

/** Nearby suggestions respecting roster & capacity */
async function suggestTwo({ allowedNames, map, startIso, endIso }) {
  const baseStart = DateTime.fromISO(startIso, { zone: ZONE });
  const baseEnd   = DateTime.fromISO(endIso,   { zone: ZONE });
  const deltas = [-30, 30, -60, 60];
  const out = [];

  for (const d of deltas) {
    const s = baseStart.plus({ minutes: d });
    const e = baseEnd.plus({ minutes: d });

    const wd = s.weekday;
    const rosterForShift = ROSTER[wd] || allowedNames;
    const allowedCalIds = rosterForShift.map(n => map[n]).filter(Boolean);
    if (allowedCalIds.length === 0) continue;

    const load = await countSalonLoad(allowedCalIds, s.toISO(), e.toISO());
    if (load >= MAX_ROOMS) continue;

    let ok = false;
    for (const name of rosterForShift) {
      const id = map[name];
      if (!id) continue;
      const { anyFree } = await isFree(id, s.toISO(), e.toISO());
      if (anyFree) { ok = true; break; }
    }
    if (!ok) continue;

    out.push({
      startIso: s.toISO(),
      endIso: e.toISO(),
      startLocalPretty: s.toFormat("ccc dd LLL yyyy, t")
    });
    if (out.length >= 2) break;
  }
  return out;
}

function nameForCalendarId(calId) {
  const map = getTherapistMap();
  return Object.keys(map).find(n => map[n] === calId) || null;
}

// POST /booking/create  (WITH ROSTER + CAPACITY BACKSTOP)
router.post("/create", async (req, res) => {
  try {
    const {
      startIso, endIso,
      clientName, clientPhone,
      serviceName, duration,
      therapist,
      requestId
    } = req.body || {};

    if (!startIso || !endIso || !clientName || !clientPhone || !serviceName) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    const map = effectiveTherapistMap(getTherapistMap());
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    const start = DateTime.fromISO(startIso, { zone: ZONE });
    const end   = DateTime.fromISO(endIso,   { zone: ZONE });
    if (!start.isValid || !end.isValid) {
      return res.status(400).json({ ok: false, error: "Invalid ISO times" });
    }

    // Roster + capacity for the requested start date
    const weekday = start.weekday; // 1=Mon..7=Sun
    const rosterForDay = ROSTER[weekday] || names;
    const allowedNames = rosterForDay.filter(n => !!map[n]);
    const allowedCalIds = allowedNames.map(n => map[n]);

    // Capacity gate (2 rooms total)
    const loadNow = await countSalonLoad(allowedCalIds, start.toISO(), end.toISO());
    if (loadNow >= MAX_ROOMS) {
      const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
      return res.status(409).json({
        ok: false,
        error: "capacity_reached",
        policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
        suggestions
      });
    }

    // Therapist selection honoring roster
    let selectedName = therapist && therapist.toLowerCase() !== "any" ? therapist : null;
    let calId = selectedName ? map[selectedName] : null;

    if (selectedName) {
      if (!allowedNames.includes(selectedName)) {
        const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
        return res.status(409).json({
          ok: false,
          error: "therapist_not_scheduled_today",
          therapistRequested: selectedName,
          policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
          suggestions
        });
      }
      const { anyFree } = await isFree(calId, startIso, endIso);
      if (!anyFree) {
        const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
        return res.status(409).json({
          ok: false,
          error: `time_not_available_for_${selectedName}`,
          policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
          suggestions
        });
      }
    } else {
      // auto-pick first free therapist within roster
      for (const name of allowedNames) {
        const id = map[name];
        if (!id) continue;
        const { anyFree } = await isFree(id, startIso, endIso);
        if (anyFree) { selectedName = name; calId = id; break; }
      }
      if (!calId) {
        const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
        return res.status(409).json({
          ok: false,
          error: "time_not_available_for_any_rostered_therapist",
          policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
          suggestions
        });
      }
    }

    const pretty = start.toFormat("ccc dd LLL yyyy, t");
    const summary = `${serviceName} — ${clientName}`;
    const description = [
      `Client: ${clientName}`,
      `Phone: ${clientPhone}`,
      `Service: ${serviceName} (${duration || "?"} min)`,
      `Therapist: ${selectedName}`,
      `Booked via Kind Thai Middleware`,
    ].join("\\n");

    const result = await createEvent(calId, {
      startIso, endIso, summary, description, requestId,
      privateProps: {
        therapist: selectedName,
        calendarId: calId,
        clientPhone,
        clientPhoneDigits: (clientPhone || "").replace(/\\D/g,"")
      }
    });

    return res.json({
      ok: true,
      therapist: selectedName,
      calendarId: calId,
      alreadyExists: result.alreadyExists,
      startIso, endIso,
      startLocalPretty: pretty,
      eventId: result.event.id,
      htmlLink: result.event.htmlLink
    });
  } catch (err) {
    console.error("booking/create error:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || "Server error";
    const code = err?.response?.data?.error?.status;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

// === Existing routes (unchanged) ===

/** Utility: safe stringify for logs */
function safeJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

/** Try to recover the latest event for a phone across all calendars */
async function recoverLatestEventForPhone(map, phone, fromIso, toIso) {
  if (!phone) return null;
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const start = fromIso ? DateTime.fromISO(fromIso, { zone: ZONE }) : DateTime.now().minus({ days: 14 }).setZone(ZONE);
  const end   = toIso   ? DateTime.fromISO(toIso,   { zone: ZONE }) : DateTime.now().plus({ days: 2 }).setZone(ZONE);
  const results = [];

  for (const [name, calId] of Object.entries(map)) {
    try {
      let list = await searchByPrivateProp(calId, start.toISO(), end.toISO(), "clientPhoneDigits", digits, 10);
      if (!list || list.length === 0) {
        list = await searchByPrivateProp(calId, start.toISO(), end.toISO(), "clientPhone", phone, 10);
      }
      for (const ev of (list || [])) {
        const s = ev.start?.dateTime || ev.start?.date || ev.updated || ev.created;
        if (s) results.push({ name, calId, ev, sortKey: Date.parse(s) || 0 });
      }
    } catch (e) {
      // ignore per-calendar errors during recovery
    }
  }

  results.sort((a, b) => b.sortKey - a.sortKey);
  return results[0] || null;
}

// POST /booking/reschedule (with preflight + recovery)
router.post("/reschedule", async (req, res) => {
  try {
    const { eventId, currentCalendarId, newStartIso, newEndIso, newTherapist, requestId, clientPhone } = req.body || {};
    if (!eventId || !currentCalendarId || !newStartIso || !newEndIso) {
      return res.status(400).json({ ok: false, error: "eventId, currentCalendarId, newStartIso, newEndIso are required" });
    }

    const map = effectiveTherapistMap(getTherapistMap());
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    // --- Preflight: does the event still exist where the client says it is?
    let evExists = true;
    try { await getEvent(currentCalendarId, eventId); }
    catch (e) {
      const code = e?.response?.status || e?.code;
      if (code === 404) evExists = false; else throw e;
    }

    // --- If not found, attempt recovery using phone (latest event for that phone)
    let srcCal = currentCalendarId;
    let srcEventId = eventId;
    if (!evExists) {
      const recovered = await recoverLatestEventForPhone(map, clientPhone, null, null);
      if (!recovered) {
        return res.status(404).json({ ok: false, error: "event_not_found", detail: "The original event no longer exists and recovery by phone failed." });
      }
      srcCal = recovered.calId;
      srcEventId = recovered.ev.id;
    }

    // --- Choose target calendar (keep same unless newTherapist specified)
    let selectedName = (newTherapist && newTherapist.toLowerCase() !== "any") ? newTherapist : null;
    let targetCalId = selectedName ? map[selectedName] : null;

    if (selectedName && !targetCalId) {
      return res.status(404).json({ ok: false, error: `Unknown therapist '${selectedName}'` });
    }

    if (!targetCalId) {
      // Keep same therapist/calendar
      selectedName = Object.keys(map).find(n => map[n] === srcCal) || null;
      targetCalId = srcCal;
    }

    // --- Ensure target slot is actually free
    const { anyFree } = await isFree(targetCalId, newStartIso, newEndIso);
    if (!anyFree) return res.status(409).json({ ok: false, error: `Time not available for therapist '${selectedName}'` });

    if (targetCalId === srcCal) {
      // Simple time move
      const updated = await updateEventTimes(srcCal, srcEventId, newStartIso, newEndIso);
      return res.json({
        ok: true,
        movedCalendar: false,
        therapist: selectedName,
        calendarId: srcCal,
        eventId: updated.id,
        htmlLink: updated.htmlLink,
        startIso: newStartIso, endIso: newEndIso
      });
    }

    // Cross-calendar move (copy then delete)
    const original = await getEvent(srcCal, srcEventId);
    const summary = original.summary || "Appointment";
    const description = (original.description || "") + "\n[Rescheduled]";
    const created = await createEvent(targetCalId, {
      startIso: newStartIso,
      endIso: newEndIso,
      summary,
      description,
      requestId,
      privateProps: {
        therapist: selectedName,
        calendarId: targetCalId,
        clientPhone: original?.extendedProperties?.private?.clientPhone,
        clientPhoneDigits: original?.extendedProperties?.private?.clientPhoneDigits
      }
    });
    await deleteEvent(srcCal, srcEventId);

    return res.json({
      ok: true,
      movedCalendar: true,
      therapist: selectedName,
      calendarId: targetCalId,
      eventId: created.event.id,
      htmlLink: created.event.htmlLink,
      startIso: newStartIso, endIso: newEndIso
    });
  } catch (err) {
    console.error("booking/reschedule error:", safeJson(err?.response?.data || { message: err?.message, stack: err?.stack }));
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || "Server error";
    const code = err?.response?.data?.error?.status;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});


// POST /booking/cancel
router.post("/cancel", async (req, res) => {, async (req, res) => {
  try {
    const { eventId, calendarId } = req.body || {};
    if (!eventId || !calendarId) {
      return res.status(400).json({ ok: false, error: "eventId and calendarId are required" });
    }
    await deleteEvent(calendarId, eventId);
    return res.json({ ok: true, eventId, calendarId });
  } catch (err) {
    console.error("booking/cancel error:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || "Server error";
    const code = err?.response?.data?.error?.status;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

// POST /booking/find
router.post("/find", async (req, res) => {
  try {
    const hdrPhone = (req.headers["x-retell-number"] || "").trim();
    const { clientPhone, onDateIso, startIso, endIso, timeZone } = req.body || {};
    const phone = (clientPhone || hdrPhone || "").trim();
    if (!phone) return res.status(400).json({ ok: false, error: "clientPhone required (or provide in x-retell-number header)" });

    const tz = timeZone || ZONE;
    let fromIso, toIso;
    if (onDateIso && (!startIso && !endIso)) {
      const day = DateTime.fromISO(onDateIso, { zone: tz });
      if (!day.isValid) return res.status(400).json({ ok: false, error: "Invalid onDateIso" });
      fromIso = day.startOf("day").toISO(); toIso = day.endOf("day").toISO();
    } else if (startIso && endIso) {
      fromIso = DateTime.fromISO(startIso, { zone: tz }).toISO();
      toIso   = DateTime.fromISO(endIso,   { zone: tz }).toISO();
    } else {
      return res.status(400).json({ ok: false, error: "Provide onDateIso OR startIso & endIso" });
    }

    const map = effectiveTherapistMap(getTherapistMap());
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    const matches = [];
    for (const name of names) {
      const calId = map[name];
      try {
        let list = await searchByPrivateProp(calId, fromIso, toIso, "clientPhone", phone, 25);
        if (list.length === 0) {
          const digits = phone.replace(/\\D/g,"");
          if (digits) list = await searchByPrivateProp(calId, fromIso, toIso, "clientPhoneDigits", digits, 25);
        }
        if (list.length === 0) list = await searchEvents(calId, fromIso, toIso, phone, 25);
        if (list.length === 0 && phone.replace(/\\D/g,"").length >= 6) {
          const last6 = phone.replace(/\\D/g,"").slice(-6);
          list = await searchEvents(calId, fromIso, toIso, last6, 25);
        }

        for (const ev of list) {
          const s = ev.start?.dateTime || (ev.start?.date ? DateTime.fromISO(ev.start.date, {zone: tz}).startOf("day").toISO() : null);
          const e = ev.end?.dateTime   || (ev.end?.date   ? DateTime.fromISO(ev.end.date,   {zone: tz}).endOf("day").toISO()   : null);
          matches.push({
            therapist: name,
            calendarId: calId,
            eventId: ev.id,
            htmlLink: ev.htmlLink,
            summary: ev.summary,
            status: ev.status,
            startIso: s,
            endIso: e,
            startLocalPretty: s ? DateTime.fromISO(s, { zone: tz }).toFormat("ccc dd LLL yyyy, t") : null,
            privateProps: ev.extendedProperties?.private || {}
          });
        }
      } catch (err) {
        matches.push({ therapist: name, calendarId: calId, error: err?.response?.data?.error?.message || err?.message || "Search error" });
      }
    }

    return res.json({ ok: true, phoneUsed: phone, window: { startIso: fromIso, endIso: toIso, zone: tz }, matches });
  } catch (err) {
    console.error("booking/find error:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || "Server error";
    const code = err?.response?.data?.error?.status;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

module.exports = router;

