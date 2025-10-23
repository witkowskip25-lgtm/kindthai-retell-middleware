import express from "express";

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- Constants (embedded per your project defaults) ----
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = "KT-2025-SECRET";
const ZAPIER_CHECK_URL = "https://hooks.zapier.com/hooks/catch/24798804/u52yvgh/";
const ZAPIER_BOOK_URL  = "https://hooks.zapier.com/hooks/catch/24798804/u53j41u/";

// ---- Utils ----
function ok(res, data = {}) { return res.status(200).json({ ok: true, ...data }); }
function bad(res, msg = "Bad Request") { return res.status(400).json({ ok: false, error: msg }); }
function unauthorized(res) { return res.status(401).json({ ok: false, error: "Unauthorized" }); }

function requireSecret(req, res) {
  const secret = req.headers["x-shared-secret"];
  if (secret !== SHARED_SECRET) {
    return unauthorized(res);
  }
  return true;
}

function toE164(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d+]/g, "");
  // If it starts with 0 and looks UK, convert to +44
  if (/^0\d{9,}$/.test(p)) p = "+44" + p.slice(1);
  // If it doesn't start with +, assume UK +44 (adjust if needed later)
  if (!p.startsWith("+")) p = "+44" + p.replace(/^0/, "");
  return p;
}

async function postToZapier(url, payload, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shared-secret": SHARED_SECRET
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await r.text();
    // Try parse JSON, otherwise return text
    try {
      return { status: r.status, data: JSON.parse(text) };
    } catch {
      return { status: r.status, data: text };
    }
  } finally {
    clearTimeout(t);
  }
}

// ---- Health ----
app.get("/health", (_req, res) => ok(res, { status: "up", ts: Date.now() }));

// ---- Retell webhook receiver (we'll wire phone → actions next step) ----
app.post("/retell/webhook", async (req, res) => {
  if (requireSecret(req, res) !== true) return;
  // Log minimal event for debugging — keep PII low
  const { event, call_id, from } = req.body || {};
  console.log("[retell]", { event, call_id, from });
  return ok(res);
});

// ---- Booking APIs (used by Retell tool-calls or your IVR logic) ----
app.post("/api/book", async (req, res) => {
  if (requireSecret(req, res) !== true) return;
  const { phone, name, date, time, duration_minutes, service_type } = req.body || {};
  const normalized = toE164(phone);
  if (!normalized || !date || !time || !duration_minutes) {
    return bad(res, "Missing required fields: phone, date, time, duration_minutes");
  }
  const payload = {
    action: "book",
    phone: normalized,
    name: name || null,
    date,
    time,
    duration_minutes,
    service_type: service_type || null
  };
  const r = await postToZapier(ZAPIER_BOOK_URL, payload);
  return ok(res, { zapier: r });
});

app.post("/api/reschedule", async (req, res) => {
  if (requireSecret(req, res) !== true) return;
  const { phone, name, date, time, duration_minutes, service_type } = req.body || {};
  const normalized = toE164(phone);
  if (!normalized || !date || !time) {
    return bad(res, "Missing required fields: phone, date, time");
  }
  const payload = {
    action: "reschedule",
    phone: normalized,
    name: name || null,
    date,
    time,
    duration_minutes: duration_minutes || null,
    service_type: service_type || null
  };
  const r = await postToZapier(ZAPIER_BOOK_URL, payload);
  return ok(res, { zapier: r });
});

app.post("/api/cancel", async (req, res) => {
  if (requireSecret(req, res) !== true) return;
  const { phone, name } = req.body || {};
  const normalized = toE164(phone);
  if (!normalized) {
    return bad(res, "Missing required field: phone");
  }
  const payload = {
    action: "cancel",
    phone: normalized,
    name: name || null
  };
  const r = await postToZapier(ZAPIER_BOOK_URL, payload);
  return ok(res, { zapier: r });
});

app.listen(PORT, () => {
  console.log(`KindThai middleware listening on :${PORT}`);
});

