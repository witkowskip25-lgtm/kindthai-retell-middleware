const express = require("express");
require("dotenv").config();

const { getAuth, isFree, createEvent } = require("./gcal");

const app = express();
app.use(express.json());

const TIMEZONE = process.env.GOOGLE_TIMEZONE || "Europe/London";

/** Therapist -> Calendar mapping (names reflect real therapists) */
const THERAPISTS = [
  { name: "Lilly", calendarId: "cd6e4c1efc4856dafe592cf03f99883474944f882d89d16ce0b82023337494cc@group.calendar.google.com" },
  { name: "Kat",   calendarId: "ce3a7c522d6f27ef89a814cbd4371bee305a3067ee77c96e80a2ab37ad50bdd9@group.calendar.google.com" },
  { name: "Sara",  calendarId: "3d81f53c3c66d78ba04016c786782fca077b46ffd11b90e95d00c0ed4fb226b9" }
];

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: process.env.GOOGLE_AUTH_MODE || "service", therapists: THERAPISTS.map(t => t.name) });
});

/** Availability: body = { startIso, endIso, preferredTherapist? } */
app.post("/availability", async (req, res) => {
  const { startIso, endIso, preferredTherapist } = req.body || {};
  if (!startIso || !endIso) return res.status(400).json({ error: "startIso and endIso required" });
  try {
    const auth = await getAuth();

    const list = preferredTherapist
      ? THERAPISTS.filter(t => t.name.toLowerCase() === String(preferredTherapist).toLowerCase())
      : THERAPISTS;

    const results = [];
    for (const t of list) {
      try {
        const free = await isFree(auth, t.calendarId, startIso, endIso, TIMEZONE);
        results.push({ therapist: t.name, calendarId: t.calendarId, free });
      } catch (inner) {
        results.push({ therapist: t.name, calendarId: t.calendarId, free: null, error: String(inner.message || inner) });
      }
    }

    res.json({ ok: true, availability: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Book: body = { therapistName?, startIso, endIso, clientName, clientPhone, serviceName, duration } */
app.post("/book", async (req, res) => {
  const { therapistName, startIso, endIso, clientName, clientPhone, serviceName, duration } = req.body || {};
  if (!startIso || !endIso || !clientName) return res.status(400).json({ error: "startIso, endIso, clientName required" });
  try {
    const auth = await getAuth();

    let candidates = THERAPISTS;
    if (therapistName) {
      const match = THERAPISTS.find(t => t.name.toLowerCase() === String(therapistName).toLowerCase());
      candidates = match ? [match] : THERAPISTS;
    }

    let chosen = null;
    for (const t of candidates) {
      const free = await isFree(auth, t.calendarId, startIso, endIso, TIMEZONE);
      if (free) { chosen = t; break; }
    }
    if (!chosen) return res.status(409).json({ ok:false, error: "No therapist available for that time." });

    const summary = `${serviceName || "Massage"} — ${clientName}${therapistName ? " ("+chosen.name+")" : ""}`;
    const description = `Booked by AI Receptionist
Client: ${clientName} (${clientPhone || "-"})
Service: ${serviceName || "Massage"} (${duration || "?"} mins)
Therapist: ${chosen.name}`;

    const event = await createEvent(auth, chosen.calendarId, {
      summary, description, startIso, endIso, timeZone: TIMEZONE
    });

    res.json({ ok: true, therapist: chosen.name, eventId: event.id, htmlLink: event.htmlLink });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/** Secure webhook for Retell (unchanged) */
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

app.get("/", (_req, res) => res.send("Retell + Google API (service account) — ready"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on http://localhost:${PORT}`));
