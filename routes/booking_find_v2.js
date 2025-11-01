const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const { normaliseUK, haystackHasPhone, digits } = require('../lib/phone_util');

/** Get an authenticated Calendar client via ADC */
async function getCalendarClient() {
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

/** Determine which calendars to scan */
async function getCalendarIds(calendar) {
  const raw = process.env.KINDTHAI_CALENDAR_IDS || process.env.SALON_CALENDAR_IDS || '';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error('Missing KINDTHAI_CALENDAR_IDS env var (comma-separated therapist calendar IDs).');
  }
  return list;
}

async function listEventsForDay(calendar, calendarIds, dayIso, zone) {
  const start = DateTime.fromISO(dayIso, { zone }).startOf('day').toISO();
  const end   = DateTime.fromISO(dayIso, { zone }).endOf('day').toISO();

  const all = [];
  for (const calId of calendarIds) {
    const { data } = await calendar.events.list({
      calendarId: calId,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500
    });
    (data.items || []).forEach(ev => all.push({ ...ev, calendarId: calId }));
  }
  return all;
}

router.post('/booking/find_v2', async (req, res) => {
  try {
    const { onDateIso, startIso, endIso, timeZone = 'Europe/London', clientPhone, relaxed = false } = req.body || {};
    if (!timeZone || !(onDateIso || (startIso && endIso))) {
      return res.status(400).json([{ ok:false, error:'bad_request' }, 'Need onDateIso OR startIso+endIso and timeZone']);
    }

    const norm = normaliseUK(clientPhone || '');
    const variants = norm.variants; // ["44XXXXXXXXXX","0XXXXXXXXXX"] (digits only)

    const dayISO = onDateIso
      ? DateTime.fromISO(onDateIso, { zone: timeZone }).toISODate()
      : DateTime.fromISO(startIso,  { zone: timeZone }).toISODate();

    const calendar = await getCalendarClient();
    const calendarIds = await getCalendarIds(calendar);
    const events = await listEventsForDay(calendar, calendarIds, dayISO, timeZone);

    const matches = [];
    for (const ev of events) {
      const props = ev.extendedProperties?.private || ev.extendedProperties?.shared || {};
      const structured = props.clientPhone || props.phone || props.mobile;

      let hit = false;

      if (structured && variants.length) {
        const sNorm = normaliseUK(structured);
        const vset = new Set(variants);
        if (sNorm.e164 && vset.has(digits(sNorm.e164).replace(/^\+/, ''))) hit = true;
        if (!hit && sNorm.national && vset.has(digits(sNorm.national)))     hit = true;
      }

      if (!hit && variants.length) {
        if (haystackHasPhone(ev, variants)) hit = true;
      }

      if (!hit && relaxed && clientPhone) {
        const last4 = digits(clientPhone).slice(-4);
        const text = `${ev.summary || ''} ${ev.description || ''} ${ev.location || ''}`.toLowerCase();
        if (last4 && new RegExp(`(?:^|\\D)${last4}(?:\\D|$)`).test(text)) {
          hit = true;
        }
      }

      if (hit) {
        matches.push({
          calendarId: ev.calendarId,
          eventId: ev.id,
          summary: ev.summary,
          startIso: ev.start?.dateTime || ev.start?.date,
          endIso:   ev.end?.dateTime   || ev.end?.date,
          htmlLink: ev.htmlLink,
          extendedProperties: ev.extendedProperties || {}
        });
      }
    }

    return res.json({
      ok: true,
      phoneUsed: norm.e164 || norm.national || null,
      window: {
        startIso: DateTime.fromISO(dayISO, { zone: timeZone }).startOf('day').toISO(),
        endIso:   DateTime.fromISO(dayISO, { zone: timeZone }).endOf('day').toISO(),
        zone: timeZone
      },
      matches
    });
  } catch (e) {
    console.error('booking/find_v2 error', e);
    const msg = e?.message || 'Internal error in booking_find_v2';
    return res.status(500).json([{ ok:false, error:'srv' }, msg]);
  }
});

module.exports = router;
