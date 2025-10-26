const express = require("express");
const router = express.Router();
const {
  ZONE,
  getTherapistMap, getCalendarIdForTherapist,
  isFree, suggestNearby
} = require("../lib/gcal");
const { DateTime } = require("luxon");

router.post("/check", async (req, res) => {
  try {
    const { startIso, endIso, therapist } = req.body || {};
    if (!startIso || !endIso) {
      return res.status(400).json({ ok: false, error: "startIso and endIso required" });
    }
    const map = getTherapistMap();
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    // Specific therapist requested
    if (therapist && therapist.toLowerCase() !== "any") {
      const calId = getCalendarIdForTherapist(therapist);
      if (!calId) return res.status(404).json({ ok: false, error: `Unknown therapist '${therapist}'` });
      const { anyFree } = await isFree(calId, startIso, endIso);
      if (anyFree) {
        console.log("[availability] free", { therapist, calendarId: calId, startIso, endIso });
        return res.json({ ok: true, anyFree: true, therapistSelected: therapist, calendarId: calId });
      }
      const suggestions = await suggestNearby(calId, startIso, endIso, 2);
      const pretty = DateTime.fromISO(startIso, { zone: ZONE }).toFormat("ccc dd LLL yyyy, t");
      return res.json({ ok: true, anyFree: false, therapistSelected: therapist, calendarId: calId, suggestions, startLocalPretty: pretty });
    }

    // ANY: pick first free
    for (const name of names) {
      const calId = map[name];
      const { anyFree } = await isFree(calId, startIso, endIso);
      if (anyFree) {
        console.log("[availability] any -> selected", { therapist: name, calendarId: calId, startIso, endIso });
        return res.json({ ok: true, anyFree: true, therapistSelected: name, calendarId: calId });
      }
    }

    // None free — suggest around first therapist
    const firstName = names[0];
    const suggestions = await suggestNearby(map[firstName], startIso, endIso, 2);
    const pretty = DateTime.fromISO(startIso, { zone: ZONE }).toFormat("ccc dd LLL yyyy, t");
    return res.json({ ok: true, anyFree: false, therapistSelected: null, suggestions, startLocalPretty: pretty, therapistsTried: names });
  } catch (err) {
    console.error("availability/check error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
