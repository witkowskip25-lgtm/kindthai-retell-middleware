const express = require("express");
const router = express.Router();
const { DateTime } = require("luxon");
const { ZONE, getTherapistMap, isFree } = require("../lib/gcal");
const { ROSTER, MAX_ROOMS } = require("../lib/salonPolicy");

/**
 * Map tweaks:
 * - If a calendar exists under "Sara", alias it to "Nina" and drop "Sara".
 * - If env.ROSE_CAL_ID is set, add "Rose".
 */
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

/** Count how many therapists are BUSY in the window (approx salon load). */
async function countSalonLoad(calIds, startIso, endIso) {
  let busy = 0;
  for (const id of calIds) {
    const { anyFree } = await isFree(id, startIso, endIso);
    if (!anyFree) busy++;
  }
  return busy;
}

/** Try simple nearby suggestions: [-30m, +30m, -60m, +60m], filtered by roster & capacity. */
async function suggestTwo({ allowedNames, map, startIso, endIso }) {
  const baseStart = DateTime.fromISO(startIso, { zone: ZONE });
  const baseEnd   = DateTime.fromISO(endIso,   { zone: ZONE });
  const deltas = [-30, 30, -60, 60];
  const out = [];

  for (const d of deltas) {
    const s = baseStart.plus({ minutes: d });
    const e = baseEnd.plus({ minutes: d });

    // Only consider if the same roster applies (same day after shift)
    const wd = s.weekday;
    const rosterForShift = ROSTER[wd] || allowedNames;
    // Translate roster names -> calIds (present in map)
    const allowedCalIds = rosterForShift.map(n => map[n]).filter(Boolean);
    if (allowedCalIds.length === 0) continue;

    // Capacity gate
    const load = await countSalonLoad(allowedCalIds, s.toISO(), e.toISO());
    if (load >= MAX_ROOMS) continue;

    // Find first free therapist within roster
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

/**
 * POST /availability/check
 * Body: { startIso, endIso, therapist? ("any" or a name) }
 * Enforces:
 *  - Weekly roster (only named therapists for that weekday)
 *  - Salon capacity MAX_ROOMS
 *  - Sara->Nina alias; optional Rose via env.ROSE_CAL_ID
 */
router.post("/check", async (req, res) => {
  try {
    const { startIso, endIso, therapist } = req.body || {};
    if (!startIso || !endIso) {
      return res.status(400).json({ ok: false, error: "startIso and endIso are required" });
    }

    const mapRaw = getTherapistMap();
    const map = effectiveTherapistMap(mapRaw);
    const allNames = Object.keys(map);
    if (allNames.length === 0) {
      return res.status(500).json({ ok: false, error: "No therapist calendars configured" });
    }

    // Roster for the requested start date (London)
    const start = DateTime.fromISO(startIso, { zone: ZONE });
    const end   = DateTime.fromISO(endIso,   { zone: ZONE });
    if (!start.isValid || !end.isValid) {
      return res.status(400).json({ ok: false, error: "Invalid ISO times" });
    }
    const weekday = start.weekday; // 1=Mon..7=Sun
    const rosterForDay = ROSTER[weekday] || allNames;
    const allowedNames = rosterForDay.filter(n => !!map[n]); // only those with calendars present
    const allowedCalIds = allowedNames.map(n => map[n]);

    // Capacity gate (2 rooms total)
    const loadNow = await countSalonLoad(allowedCalIds, start.toISO(), end.toISO());
    if (loadNow >= MAX_ROOMS) {
      const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
      return res.json({
        ok: true,
        anyFree: false,
        reason: "capacity_reached",
        startLocalPretty: start.toFormat("ccc dd LLL yyyy, t"),
        policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
        suggestions
      });
    }

    // Candidate therapist selection
    let candidates;
    if (therapist && therapist.toLowerCase() !== "any") {
      // Must be on roster for the day
      if (!allowedNames.includes(therapist)) {
        const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
        return res.json({
          ok: true,
          anyFree: false,
          reason: "therapist_not_scheduled_today",
          therapistRequested: therapist,
          policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
          suggestions
        });
      }
      candidates = [therapist];
    } else {
      candidates = allowedNames;
    }

    // Find first free therapist within roster (honoring capacity already checked)
    let selectedName = null;
    let selectedId = null;
    for (const name of candidates) {
      const id = map[name];
      if (!id) continue;
      const { anyFree } = await isFree(id, start.toISO(), end.toISO());
      if (anyFree) {
        selectedName = name;
        selectedId = id;
        break;
      }
    }

    if (!selectedId) {
      const suggestions = await suggestTwo({ allowedNames, map, startIso, endIso });
      return res.json({
        ok: true,
        anyFree: false,
        reason: "no_free_therapist_in_roster",
        startLocalPretty: start.toFormat("ccc dd LLL yyyy, t"),
        policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
        suggestions
      });
    }

    // Success
    return res.json({
      ok: true,
      anyFree: true,
      therapistSelected: selectedName,
      calendarId: selectedId,
      startLocalPretty: start.toFormat("ccc dd LLL yyyy, t"),
      policy: { rosterForDay: allowedNames, maxRooms: MAX_ROOMS, loadNow },
      suggestions: []
    });
  } catch (err) {
    console.error("availability/check error:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || "Server error";
    const code = err?.response?.data?.error?.status;
    return res.status(status).json({ ok: false, error: msg, code });
  }
});

module.exports = router;
