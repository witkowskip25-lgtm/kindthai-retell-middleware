const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEZONE_ENV = process.env.GOOGLE_TIMEZONE || "Europe/London";

function getServiceAccountCreds() {
  const rel = process.env.SERVICE_ACCOUNT_PATH || "service_account.json";
  const full = path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
  if (!fs.existsSync(full)) throw new Error(`Service account JSON not found at: ${full}`);
  const creds = JSON.parse(fs.readFileSync(full, "utf8"));
  if (!creds.client_email || !creds.private_key) throw new Error("Invalid service account JSON");
  return creds;
}

async function getAuth() {
  const creds = getServiceAccountCreds();
  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  await jwt.authorize();
  return jwt;
}

function getCalendar(auth) {
  return google.calendar({ version: "v3", auth });
}

async function isFree(auth, calendarId, startIso, endIso, timeZone = TIMEZONE_ENV) {
  const cal = getCalendar(auth);
  const fb = await cal.freebusy.query({
    requestBody: { timeMin: startIso, timeMax: endIso, timeZone, items: [{ id: calendarId }] }
  });
  const busy = fb.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}

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

/** Find an event by eventId OR by approximate start time (± leewayMin) and optional clientName match */
async function findEvent({ auth, calendarId, eventId, startIso, clientName, leewayMin = 10 }) {
  const cal = getCalendar(auth);

  if (eventId) {
    const resp = await cal.events.get({ calendarId, eventId });
    return resp.data;
  }

  if (!startIso) throw new Error("Missing eventId or startIso to locate the event.");

  const start = new Date(startIso);
  const windowStart = new Date(start.getTime() - leewayMin * 60000).toISOString();
  const windowEnd   = new Date(start.getTime() + leewayMin * 60000).toISOString();

  const resp = await cal.events.list({
    calendarId,
    timeMin: windowStart,
    timeMax: windowEnd,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10
  });

  let items = resp.data.items || [];
  if (clientName) {
    const lc = clientName.toLowerCase();
    items = items.filter(e =>
      (e.summary && e.summary.toLowerCase().includes(lc)) ||
      (e.description && e.description.toLowerCase().includes(lc))
    );
  }
  return items[0] || null;
}

async function updateEventTime(auth, calendarId, eventId, { startIso, endIso, timeZone = TIMEZONE_ENV }) {
  const cal = getCalendar(auth);
  const resp = await cal.events.patch({
    calendarId,
    eventId,
    sendUpdates: "all",
    requestBody: {
      start: { dateTime: startIso, timeZone },
      end:   { dateTime: endIso,  timeZone }
    }
  });
  return resp.data;
}

async function deleteEvent(auth, calendarId, eventId) {
  const cal = getCalendar(auth);
  await cal.events.delete({ calendarId, eventId, sendUpdates: "all" });
  return true;
}

module.exports = {
  getAuth,
  isFree,
  createEvent,
  findEvent,
  updateEventTime,
  deleteEvent
};
