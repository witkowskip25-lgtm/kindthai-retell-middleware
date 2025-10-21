const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEZONE_ENV = process.env.GOOGLE_TIMEZONE || "Europe/London";

function getServiceAccountCreds() {
  // prefer explicit path from env (relative to project root)
  const rel = process.env.SERVICE_ACCOUNT_PATH || "service_account.json";
  const full = path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`Service account JSON not found at: ${full}`);
  }
  const creds = JSON.parse(fs.readFileSync(full, "utf8"));
  if (!creds.client_email || !creds.private_key) {
    throw new Error("Invalid service account JSON: missing client_email/private_key");
  }
  return creds;
}

async function getAuth() {
  const creds = getServiceAccountCreds();
  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  // authorize ensures access token; throws if calendars not shared
  await jwt.authorize();
  return jwt;
}

function getCalendar(auth) {
  return google.calendar({ version: "v3", auth });
}

// Checks free/busy for a given calendarId and time range [startIso, endIso]
async function isFree(auth, calendarId, startIso, endIso, timeZone = TIMEZONE_ENV) {
  const cal = getCalendar(auth);
  const fb = await cal.freebusy.query({
    requestBody: { timeMin: startIso, timeMax: endIso, timeZone, items: [{ id: calendarId }] }
  });
  const busy = fb.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}

// Creates an event
async function createEvent(auth, calendarId, { summary, description, startIso, endIso, timeZone = TIMEZONE_ENV, attendeeEmail }) {
  const cal = getCalendar(auth);
  const ev = await cal.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary,
      description,
      start: { dateTime: startIso, timeZone },
      end:   { dateTime: endIso,  timeZone },
      attendees: attendeeEmail ? [{ email: attendeeEmail }] : []
    }
  });
  return ev.data;
}

module.exports = { getAuth, isFree, createEvent };
