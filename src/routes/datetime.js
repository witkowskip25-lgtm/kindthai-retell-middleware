const express = require("express");
const router = express.Router();
const { parseWhenText, normalizePhone } = require("../lib/time");

router.post("/parse", async (req, res) => {
  try {
    const {
      whenText,
      timeZone = "Europe/London",
      referenceNowLocal,
      durationMins = 60,
      anchorStartIso,
      clientPhone: bodyPhone,
    } = req.body || {};

    // Prefer caller phone from Retell header; fall back to body
    const headerPhone = (req.headers["x-retell-number"] || "").toString();
    const clientPhone = normalizePhone(headerPhone, bodyPhone);

    const parsed = parseWhenText({
      whenText,
      timeZone,
      referenceNowLocal,
      durationMins,
      anchorStartIso,
    });

    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const { startIso, endIso, parsedText, startLocalPretty } = parsed.data;

    return res.json({
      ok: true,
      source: "middleware",
      clientPhone,
      dateTimeInfo: {
        whenText,
        timeZone,
        referenceNowLocal: referenceNowLocal || null,
        durationMins,
        parsedText,
        startIso,
        endIso,
        startLocalPretty,
      },
    });
  } catch (err) {
    console.error("datetime/parse error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
