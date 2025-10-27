const express = require("express");
const router = express.Router();
const {
  ZONE,
  getTherapistMap, getCalendarIdForTherapist,
  isFree, suggestNearby, createEvent,
  getEvent, updateEventTimes, deleteEvent,
  searchEvents, searchByPrivateProp
} = require("../lib/gcal");
const { DateTime } = require("luxon");

function nameForCalendarId(calId) {
  const map = getTherapistMap();
  return Object.keys(map).find(n => map[n] === calId) || null;
}

// POST /booking/create
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

    const map = getTherapistMap();
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    let selectedName = therapist && therapist.toLowerCase() !== "any" ? therapist : null;
    let calId = selectedName ? getCalendarIdForTherapist(selectedName) : null;
    if (selectedName && !calId) return res.status(404).json({ ok: false, error: `Unknown therapist '${selectedName}'` });

    if (!calId) {
      for (const name of names) {
        const id = map[name];
        const { anyFree } = await isFree(id, startIso, endIso);
        if (anyFree) { selectedName = name; calId = id; break; }
      }
      if (!calId) return res.status(409).json({ ok: false, error: "Time not available for any therapist" });
    } else {
      const { anyFree } = await isFree(calId, startIso, endIso);
      if (!anyFree) return res.status(409).json({ ok: false, error: `Time not available for therapist '${selectedName}'` });
    }

    const pretty = DateTime.fromISO(startIso, { zone: ZONE }).toFormat("ccc dd LLL yyyy, t");
    const summary = `${serviceName} — ${clientName}`;
    const description = [
      `Client: ${clientName}`,
      `Phone: ${clientPhone}`,
      `Service: ${serviceName} (${duration || "?"} min)`,
      `Therapist: ${selectedName}`,
      `Booked via Kind Thai Middleware`,
    ].join("\n");

    const result = await createEvent(calId, {
      startIso, endIso, summary, description, requestId,
      privateProps: {
        therapist: selectedName,
        calendarId: calId,
        clientPhone,
        clientPhoneDigits: (clientPhone || "").replace(/\D/g,"")
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

// POST /booking/reschedule
router.post("/reschedule", async (req, res) => {
  try {
    const { eventId, currentCalendarId, newStartIso, newEndIso, newTherapist, requestId } = req.body || {};
    if (!eventId || !currentCalendarId || !newStartIso || !newEndIso) {
      return res.status(400).json({ ok: false, error: "eventId, currentCalendarId, newStartIso, newEndIso are required" });
    }

    const map = getTherapistMap();
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    let selectedName = (newTherapist && newTherapist.toLowerCase() !== "any") ? newTherapist : null;
    let targetCalId = selectedName ? getCalendarIdForTherapist(selectedName) : null;

    if (selectedName && !targetCalId) {
      return res.status(404).json({ ok: false, error: `Unknown therapist '${selectedName}'` });
    }

    if (!targetCalId) {
      const keepSame = !newTherapist || newTherapist.toLowerCase() === "any";
      if (keepSame) {
        selectedName = Object.keys(map).find(n => map[n] === currentCalendarId) || null;
        targetCalId = currentCalendarId;
      } else {
        for (const name of names) {
          const id = map[name];
          const { anyFree } = await isFree(id, newStartIso, newEndIso);
          if (anyFree) { selectedName = name; targetCalId = id; break; }
        }
      }
    }

    if (!targetCalId) return res.status(409).json({ ok: false, error: "Time not available for any therapist" });

    const { anyFree } = await isFree(targetCalId, newStartIso, newEndIso);
    if (!anyFree) return res.status(409).json({ ok: false, error: `Time not available for therapist '${selectedName}'` });

    if (targetCalId === currentCalendarId) {
      const updated = await updateEventTimes(currentCalendarId, eventId, newStartIso, newEndIso);
      return res.json({
        ok: true,
        movedCalendar: false,
        therapist: selectedName,
        calendarId: currentCalendarId,
        eventId: updated.id,
        htmlLink: updated.htmlLink,
        startIso: newStartIso, endIso: newEndIso
      });
    }

    const original = await getEvent(currentCalendarId, eventId);
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
    await deleteEvent(currentCalendarId, eventId);

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
    console.error("booking/reschedule error:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || "Server error";
    const code = err?.response?.data?.error?.status;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

// POST /booking/cancel
router.post("/cancel", async (req, res) => {
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
// Body: { clientPhone?, onDateIso? (YYYY-MM-DD), startIso?, endIso?, timeZone? }
// - If clientPhone omitted, falls back to header 'x-retell-number'.
// - Provide onDateIso OR (startIso & endIso)
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

    const map = getTherapistMap();
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    const matches = [];
    for (const name of names) {
      const calId = map[name];
      try {
        // 1) exact private props (full phone), 2) digits, 3) text q, 4) last 6 digits
        let list = await searchByPrivateProp(calId, fromIso, toIso, "clientPhone", phone, 25);
        if (list.length === 0) {
          const digits = phone.replace(/\D/g,"");
          if (digits) list = await searchByPrivateProp(calId, fromIso, toIso, "clientPhoneDigits", digits, 25);
        }
        if (list.length === 0) list = await searchEvents(calId, fromIso, toIso, phone, 25);
        if (list.length === 0 && phone.replace(/\D/g,"").length >= 6) {
          const last6 = phone.replace(/\D/g,"").slice(-6);
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
