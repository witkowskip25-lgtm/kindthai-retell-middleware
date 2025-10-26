const express = require("express");
const router = express.Router();
const { getTherapistMap } = require("../lib/gcal");

router.get("/", async (_req, res) => {
  try {
    const map = getTherapistMap();
    const therapists = Object.keys(map).map(name => ({ name, calendarId: map[name] }));
    return res.json({ ok: true, therapists });
  } catch (err) {
    console.error("therapists/list error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
