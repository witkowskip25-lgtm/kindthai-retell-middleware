const express = require("express");
const router = express.Router();
const {
  ZONE,
  getTherapistMap, getCalendarIdForTherapist,
  isFree, createEvent, getEvent, updateEventTimes, deleteEvent
} = require("../lib/gcal");
const { DateTime } = require("luxon");

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
    ].filter(Boolean).join("\\n");

    const result = await createEvent(calId, {
      startIso, endIso, summary, description, requestId,
      privateProps: { therapist: selectedName, calendarId: calId }
    });

    return res.json({
      ok: true,
      therapist: selectedName,
      calendarId: calId,
      alreadyExists: result.alreadyExists,
      startIso, endIso,
      startLocalPretty: pretty,
      eventId: result.event.id,
      htmlLink: result.event.htmlLink,
    });
  } catch (err) {
    console.error("booking/create error:", err?.response?.data || err?.message || err);
    const status = (err && err.response && err.response.status) ? err.response.status : 500;
    const msg = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message)
      || (err && err.message)
      || "Server error";
    const code = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.status) || undefined;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

// POST /booking/reschedule
// Body: { eventId, currentCalendarId, newStartIso, newEndIso, newTherapist? ('any' | name), requestId? }
router.post("/reschedule", async (req, res) => {
  try {
    const { eventId, currentCalendarId, newStartIso, newEndIso, newTherapist, requestId } = req.body || {};
    if (!eventId || !currentCalendarId || !newStartIso || !newEndIso) {
      return res.status(400).json({ ok: false, error: "eventId, currentCalendarId, newStartIso, newEndIso are required" });
    }

    const map = getTherapistMap();
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    // Decide target therapist/calendar
    let selectedName = (newTherapist && newTherapist.toLowerCase() !== "any") ? newTherapist : null;
    let targetCalId = selectedName ? getCalendarIdForTherapist(selectedName) : null;

    if (selectedName && !targetCalId) {
      return res.status(404).json({ ok: false, error: `Unknown therapist '${selectedName}'` });
    }

    if (!targetCalId) {
      // If therapist not specified, keep same calendar; else try any
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

    // Ensure time free on target
    const { anyFree } = await isFree(targetCalId, newStartIso, newEndIso);
    if (!anyFree) return res.status(409).json({ ok: false, error: `Time not available for therapist '${selectedName}'` });

    // If staying on same calendar -> patch
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

    // Moving across calendars: copy then delete old
    const original = await getEvent(currentCalendarId, eventId);
    const summary = original.summary || "Appointment";
    const description = (original.description || "") + "\n[Rescheduled]";
    const created = await createEvent(targetCalId, {
      startIso: newStartIso,
      endIso: newEndIso,
      summary,
      description,
      requestId,
      privateProps: { therapist: selectedName, calendarId: targetCalId }
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
    const status = (err && err.response && err.response.status) ? err.response.status : 500;
    const msg = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message)
      || (err && err.message)
      || "Server error";
    const code = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.status) || undefined;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

// POST /booking/cancel
// Body: { eventId, calendarId, reason? }
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
    const status = (err && err.response && err.response.status) ? err.response.status : 500;
    const msg = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message)
      || (err && err.message)
      || "Server error";
    const code = (err && err.response && err.response.data && err.response.data.error && err.response.data.error.status) || undefined;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

module.exports = router;
