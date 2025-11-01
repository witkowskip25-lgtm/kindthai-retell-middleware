function digits(s) {
  return (s || '').replace(/\D+/g, '');
}

function normaliseUK(phone) {
  const d = digits(phone);
  if (!d) return { e164: null, national: null, variants: [] };

  let e164 = null, national = null;

  // +44xxxxxxxxxx or 44xxxxxxxxxx
  if ((phone + '').startsWith('+44') || d.startsWith('44')) {
    if (d.length >= 12) {
      e164 = '+44' + d.slice(-10);
      national = '0' + d.slice(-10);
    }
  }
  // 07xxxxxxxxx -> +44xxxxxxxxxx
  if (!e164 && d.length === 11 && d.startsWith('0')) {
    national = d;
    e164 = '+44' + d.slice(1);
  }

  const v = [];
  if (e164) v.push(digits(e164).replace(/^\+/, '')); // 44XXXXXXXXXX
  if (national) v.push(digits(national));            // 0XXXXXXXXXX

  return { e164, national, variants: v };
}

function haystackHasPhone(ev, variants) {
  const blob = `${ev.summary || ''} ${ev.description || ''} ${ev.location || ''} ${JSON.stringify(ev.extendedProperties || {})}`;
  const d = digits(blob);
  return variants.some(v => v && d.includes(v));
}

module.exports = { digits, normaliseUK, haystackHasPhone };
