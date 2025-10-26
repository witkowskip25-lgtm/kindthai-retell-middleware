const express = require("express");
const router = express.Router();
const { getTherapistMap, isFree, freebusy } = require("../lib/gcal");

router.get("/freebusy", async (req, res) => {
  try {
    const { startIso, endIso } = req.query || {};
    if (!startIso || !endIso) {
      return res.status(400).json({ ok: false, error: "startIso and endIso are required" });
    }
    const map = getTherapistMap();
    const names = Object.keys(map);
    if (names.length === 0) return res.status(500).json({ ok: false, error: "No therapist calendars configured" });

    const results = [];
    for (const name of names) {
      const calId = map[name];
      try {
        const fb = await freebusy(calId, startIso, endIso);
        const { anyFree } = await isFree(calId, startIso, endIso);
        results.push({ therapist: name, calendarId: calId, anyFree, busy: fb });
      } catch (e) {
        results.push({
          therapist: name,
          calendarId: calId,
          anyFree: null,
          error: e?.response?.data?.error?.message || e?.message || "Unknown error",
          code: e?.response?.data?.error?.status
        });
      }
    }
    return res.json({ ok: true, startIso, endIso, results });
  } catch (err) {
    console.error("debug/freebusy error:", err?.response?.data || err?.message || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
