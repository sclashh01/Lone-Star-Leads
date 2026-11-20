// netlify/functions/verify-and-notify.js
//
// ONE function, ONE call from the form (fired once, at final submit).
// Runs Google Address Validation, Twilio Lookup (phone), and ZeroBounce
// (email) in parallel, then immediately sends the lead notification email
// via Resend in the SAME invocation. Property ownership has no public
// county-records API in any state, so it always routes to manual review.
//
// State-agnostic: reads `state` from the submitted lead.
//
// HOLD RULE: if the STATE, ZIP or CITY the customer typed does not match what
// Google returned, the lead is put ON HOLD ("do not sell until manually
// reviewed"). The notification email shows this in red, in uppercase, and the
// subject line starts with "HOLD — DO NOT SELL".
//
// Required Netlify environment variables:
//   GOOGLE_MAPS_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   ZEROBOUNCE_API_KEY
//   RESEND_API_KEY, RESEND_FROM_ADDRESS, LEAD_NOTIFICATION_EMAIL

const GOOGLE_ADDRESS_VALIDATION_URL = 'https://addressvalidation.googleapis.com/v1:validateAddress';

// Normalizes a street line so "733 Yarsa Boulevard" and "733 YARSA BLVD" compare equal,
// but "733 Yarsa Cir" vs "733 Yarsa Blvd" do NOT.
const STREET_TOKEN_MAP = {
  boulevard: 'blvd', avenue: 'ave', street: 'st', drive: 'dr', lane: 'ln', road: 'rd', court: 'ct',
  circle: 'cir', place: 'pl', trail: 'trl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter',
  square: 'sq', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw'
};
function normalizeStreet(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => STREET_TOKEN_MAP[t] || t)
    .join(' ');
}

// Escapes customer-typed text before it goes into the HTML email.
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// City comparison that ignores punctuation and common abbreviations (St./Saint, Mt./Mount, Ft./Fort).
function normalizeCity(c) {
  return String(c || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmount\b/g, 'mt')
    .replace(/\bfort\b/g, 'ft')
    .replace(/[^a-z0-9]/g, '');
}

// Compares what the customer TYPED with what Google RETURNED.
// Any difference in STATE, ZIP or CITY => mismatch (hold).
function compareLocation(lead, result, formatted) {
  const pa = (result.address && result.address.postalAddress) || {};
  let gState = String(pa.administrativeArea || '').toUpperCase();
  let gCity = String(pa.locality || '');
  let gZip = String(pa.postalCode || '').slice(0, 5);

  // Fallback: parse "733 Yarsa Boulevard, Austin, TX 78748-6546, USA"
  if ((!gState || !gZip || !gCity) && formatted) {
    const parts = String(formatted).split(',').map(x => x.trim());
    const idx = parts.findIndex(p => /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(p));
    if (idx > 0) {
      const sz = parts[idx].split(/\s+/);
      gState = gState || sz[0].toUpperCase();
      gZip = gZip || sz[1].slice(0, 5);
      gCity = gCity || parts[idx - 1];
    }
  }

  const eState = String(lead.state || '').trim().toUpperCase();
  const eZip = String(lead.zip || '').trim();
  const eCity = String(lead.city || '').trim();

  const mismatches = [];
  if (eState && gState && eState !== gState) {
    mismatches.push(`STATE: CUSTOMER ENTERED "${eState}", GOOGLE RETURNED "${gState}"`);
  }
  if (eZip && gZip && eZip !== gZip) {
    mismatches.push(`ZIP: CUSTOMER ENTERED "${eZip}", GOOGLE RETURNED "${gZip}"`);
  }
  if (eCity && gCity && normalizeCity(eCity) !== normalizeCity(gCity)) {
    mismatches.push(`CITY: CUSTOMER ENTERED "${eCity.toUpperCase()}", GOOGLE RETURNED "${gCity.toUpperCase()}"`);
  }
  return { mismatches, googleState: gState, googleCity: gCity, googleZip: gZip };
}

// True when the customer typed a unit/apt number that Google did not keep.
function unitNotConfirmed(lead, result, formatted) {
  const eUnit = String(lead.unit || '').trim();
  if (!eUnit) return false;
  const unitTokens = eUnit.toLowerCase()
    .replace(/^(apt|apartment|unit|suite|ste|#)\s*/, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
  if (!unitTokens.length) return false;
  const pa = (result.address && result.address.postalAddress) || {};
  const lines = (pa.addressLines || []).join(' ');
  const comps = ((result.address && result.address.addressComponents) || [])
    .filter(c => c.componentType === 'subpremise')
    .map(c => (c.componentName && c.componentName.text) || '')
    .join(' ');
  const hay = `${formatted || ''} ${lines} ${comps}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return !unitTokens.every(t => hay.includes(t));
}

async function checkAddress(lead) {
  try {
    const { street, city, zip, state } = lead;
    if (!street) return { exists: false, reason: 'No street address provided.' };

    const res = await fetch(`${GOOGLE_ADDRESS_VALIDATION_URL}?key=${process.env.GOOGLE_MAPS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: {
          regionCode: 'US',
          administrativeArea: state || 'TX',
          locality: city,
          postalCode: zip,
          addressLines: [street]
        }
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return { exists: false, reason: `Google Address Validation error: ${data.error?.message || res.status} — route to manual review.` };
    }

    const result = data.result || {};
    const verdict = result.verdict || {};
    const usps = result.uspsData || {};
    const dpv = usps.dpvConfirmation;
    const confirmedDeliverable = dpv === 'Y' || dpv === 'D' || dpv === 'S';
    const goodGranularity = verdict.validationGranularity === 'PREMISE' || verdict.validationGranularity === 'SUB_PREMISE';
    const exists = verdict.addressComplete === true && (confirmedDeliverable || goodGranularity);

    if (!exists) {
      return {
        exists: false,
        reason: verdict.hasUnconfirmedComponents
          ? 'Google could not fully confirm this address — some components (street, number, or ZIP) did not match.'
          : 'No matching deliverable address found — likely a typo in the street name or house number.'
      };
    }

    const formatted = result.address?.formattedAddress || `${street}, ${city}, ${state} ${zip}`;
    const matchedLine = usps.standardizedAddress?.firstAddressLine || result.address?.postalAddress?.addressLines?.[0] || '';
    const matchedZip = String(result.address?.postalAddress?.postalCode || usps.standardizedAddress?.zipCode || '').slice(0, 5);

    // Compare what the customer typed with what Google returned (state, ZIP, city).
    const loc = compareLocation(lead, result, formatted);
    const hold = loc.mismatches.length > 0;
    const unitWarning = unitNotConfirmed(lead, result, formatted);

    // Google may silently "correct" typos (e.g. Cir -> Blvd). The lead is still valid,
    // but we surface the correction and use the corrected address.
    const streetCorrected = matchedLine && normalizeStreet(street) !== normalizeStreet(matchedLine);
    const zipCorrected = zip && matchedZip && String(zip).trim() !== matchedZip;
    if (streetCorrected || zipCorrected) {
      const parts = [];
      if (streetCorrected) parts.push(`street: entered "${street}" -> matched "${matchedLine}"`);
      if (zipCorrected) parts.push(`ZIP: entered ${zip} -> matched ${matchedZip}`);
      return {
        exists: true,
        corrected: true,
        hold,
        holdReasons: loc.mismatches,
        unitNotConfirmed: unitWarning,
        matchedAddress: formatted,
        correctedAddress: formatted,
        reason: `Auto-corrected by Google (${parts.join('; ')}). Using the corrected address.`
      };
    }

    return {
      exists: true,
      hold,
      holdReasons: loc.mismatches,
      unitNotConfirmed: unitWarning,
      matchedAddress: formatted,
      reason: `Confirmed as a real, deliverable address${dpv ? ' (USPS DPV: ' + dpv + ')' : ''}.`
    };
  } catch (err) {
    return { exists: false, reason: 'Address verification service error — route to manual review.', error: String(err) };
  }
}

async function checkPhone(phone) {
  try {
    const digits = (phone || '').replace(/\D/g, '');
    if (digits.length !== 10) return { valid: false, reason: 'Not a 10-digit US number.' };

    const e164 = `+1${digits}`;
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${e164}?Fields=line_type_intelligence`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    const data = await res.json();
    if (!res.ok) return { valid: false, reason: `Twilio Lookup error: ${data.message || res.status}` };

    const lti = data.line_type_intelligence || {};
    const lineType = lti.type || 'unknown';
    const smsCapable = lineType === 'mobile' || lineType === 'voip';

    return {
      valid: !!data.valid,
      lineType,
      smsCapable,
      carrierName: lti.carrier_name || null,
      reason: data.valid
        ? `Confirmed as a valid, in-service ${lineType} number${lti.carrier_name ? ' on ' + lti.carrier_name : ''}.${!smsCapable ? ' Note: cannot receive SMS.' : ''}`
        : 'Twilio could not confirm this is a valid, in-service number.'
    };
  } catch (err) {
    return { valid: false, reason: 'Phone verification service error — route to manual review.', error: String(err) };
  }
}

async function checkEmail(email) {
  try {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { status: 'invalid', reason: 'Does not match a valid email pattern.' };
    }
    const params = new URLSearchParams({ api_key: process.env.ZEROBOUNCE_API_KEY, email });
    const res = await fetch(`https://api.zerobounce.net/v2/validate?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      return { status: 'unknown', reason: `ZeroBounce error: ${data.error || res.status} — route to manual review.` };
    }
    const statusReasons = {
      valid: 'Mailbox confirmed to exist and accept mail.',
      invalid: 'Mailbox does not exist or domain does not accept mail.',
      'catch-all': 'Domain accepts all addresses (catch-all) — cannot fully confirm this specific mailbox.',
      unknown: 'Mail server did not respond conclusively.',
      spamtrap: 'Known spam trap — high risk.',
      abuse: 'History of marking mail as abuse/spam.',
      do_not_mail: `Flagged do-not-mail (${data.sub_status || 'unspecified'}).`
    };
    return { status: data.status, subStatus: data.sub_status || null, reason: statusReasons[data.status] || `ZeroBounce returned "${data.status}".` };
  } catch (err) {
    return { status: 'unknown', reason: 'Email verification service error — route to manual review.', error: String(err) };
  }
}


// ---------------------------------------------------------------------------
// LEAD SCORE (0-100) = buyer interest (50 pts) + REAL verification (50 pts).
// Interest: urgency 20, payment 15, roof need 15 (from the customer's answers).
// Verification: address 20, phone 20, email 10 (from Google / Twilio / ZeroBounce).
// Partial results (corrected address, phone without SMS, catch-all email) get half.
// If the address has a STATE / ZIP / CITY mismatch the lead is ON HOLD and the
// score is forced to 0 (the score it would have had is kept as `raw`).
// ---------------------------------------------------------------------------
const URGENCY_PTS = { immediately: 20, thisweek: 17, '1-2weeks': 10, '2plusweeks': 3, researching: 0 };
const URGENCY_LABEL = { immediately: 'Immediately', thisweek: 'This week', '1-2weeks': 'Within 1–2 weeks', '2plusweeks': 'More than 2 weeks', researching: 'Just researching' };
const PAYMENT_PTS = { insurance: 15, cashfinancing: 9, unsure: 3 };
const PAYMENT_LABEL = { insurance: 'Insurance', cashfinancing: 'Cash or financing', unsure: 'Not sure' };
const NEED_PTS = { replacement: 15, storm: 15, repair: 8, unsure: 4 };
const NEED_LABEL = { replacement: 'Complete replacement', storm: 'Hail / storm damage', repair: 'Repair', unsure: 'Not sure' };

function computeScore(lead, results) {
  const rows = []; // [label, points, max]
  const add = (label, pts, max) => rows.push([label, pts, max]);

  add('Urgency: ' + (URGENCY_LABEL[lead.urgency] || '—'), URGENCY_PTS[lead.urgency] ?? 0, 20);
  add('Payment: ' + (PAYMENT_LABEL[lead.payment] || '—'), PAYMENT_PTS[lead.payment] ?? 0, 15);
  add('Roof need: ' + (NEED_LABEL[lead.need] || '—'), NEED_PTS[lead.need] ?? 0, 15);

  const a = results.address || {};
  if (a.hold) add('Address: MISMATCH with Google (state/ZIP/city)', 0, 20);
  else if (a.exists && !a.corrected && !a.unitNotConfirmed) add('Address: confirmed by Google', 20, 20);
  else if (a.exists) add('Address: real, but corrected or unit not confirmed', 10, 20);
  else add('Address: NOT confirmed', 0, 20);

  const ph = results.phone || {};
  if (ph.valid && ph.smsCapable !== false) add('Phone: confirmed active line', 20, 20);
  else if (ph.valid) add('Phone: active line, cannot receive SMS', 10, 20);
  else add('Phone: NOT confirmed', 0, 20);

  const em = (results.email || {}).status;
  if (em === 'valid') add('Email: mailbox confirmed', 10, 10);
  else if (em === 'catch-all' || em === 'unknown') add('Email: inconclusive (catch-all / unknown)', 5, 10);
  else add('Email: NOT confirmed', 0, 10);

  const raw = rows.reduce((sum, r) => sum + r[1], 0);
  const hold = !!a.hold;
  return { total: hold ? 0 : raw, raw, hold, rows };
}

// Builds the email subject + HTML. Exported separately so it can be tested.
function buildNotification(lead, results, scoreInfo) {
  const e = escapeHtml;
  const addr = results.address;
  const hold = !!addr.hold;
  const holdText = hold
    ? `⚠ HOLD: MANUAL REVIEW REQUIRED — ADDRESS MISMATCH. ${addr.holdReasons.join('; ')}. DO NOT SELL THIS LEAD UNTIL MANUALLY REVIEWED.`
    : '';

  const bannerHtml = hold
    ? `<div style="border:3px solid #B00020;background:#FDECEA;color:#B00020;padding:14px;margin:0 0 16px;font-weight:bold;font-size:16px;line-height:1.4;">${e(holdText)}</div>`
    : '';

  const heading = hold
    ? `New Roofing Lead — ON HOLD <span style="color:#B00020;">(DO NOT SELL)</span> — Score: 0/100 <span style="font-size:13px;font-weight:normal;">(would have been ${e(scoreInfo.raw)}/100)</span>`
    : `New Roofing Lead — Score: ${e(scoreInfo.total)}/100`;
  const scoreRowsHtml = scoreInfo.rows
    .map(r => `${e(r[0])}: <b>+${e(r[1])}</b> / ${e(r[2])}`)
    .join('<br>');

  const typedAddress = `${e(lead.street)}${lead.unit ? ', ' + e(lead.unit) : ''}, ${e(lead.city)}, ${e(lead.state)} ${e(lead.zip)}`;

  let propertyHtml;
  if (hold) {
    propertyHtml = `<b>Customer entered:</b> ${typedAddress}<br><b style="color:#B00020;">GOOGLE RETURNED:</b> <span style="color:#B00020;font-weight:bold;">${e(String(addr.matchedAddress || '').toUpperCase())}</span>`;
  } else if (addr.corrected) {
    propertyHtml = `${e(addr.correctedAddress)} <i>(auto-corrected by Google; homeowner typed: ${e(lead.street)}, ${e(lead.city)}, ${e(lead.state)} ${e(lead.zip)})</i>${lead.unit ? '<br>Unit: ' + e(lead.unit) : ''}`;
  } else {
    propertyHtml = typedAddress;
  }

  let addressLine;
  if (hold) {
    addressLine = `<span style="color:#B00020;font-weight:bold;">❌ ${e(holdText)}</span>`;
  } else if (addr.exists) {
    addressLine = (addr.corrected || addr.unitNotConfirmed ? '⚠️ ' : '✅ ') + e(addr.reason);
  } else {
    addressLine = '❌ ' + e(addr.reason);
  }
  const unitLine = addr.unitNotConfirmed
    ? `<br><span style="color:#8A5A17;font-weight:bold;">⚠️ Unit "${e(lead.unit)}" was not confirmed by Google (it is missing from the address on file). Verify the unit manually.</span>`
    : '';

  const phone = results.phone;
  const phoneLine = phone.valid
    ? (phone.smsCapable === false ? '⚠️ ' : '✅ ') + e(phone.reason)
    : '❌ ' + e(phone.reason);

  const html = `
    ${bannerHtml}
    <h2>${heading}</h2>
    <p style="font-size:13px;color:#444;margin-top:-6px;">${scoreRowsHtml}</p>
    <h3>Contact</h3>
    <p><b>${e(lead.fullname)}</b><br>Phone: ${e(lead.phone)}<br>Email: ${e(lead.email)}</p>
    <h3>Property</h3>
    <p>${propertyHtml}</p>
    <h3>Request</h3>
    <p>Need: ${e(lead.need)}<br>Size: ${e(lead.size)}<br>Urgency: ${e(lead.urgency)}<br>Payment: ${e(lead.payment)}<br>Description: ${e(lead.desc || '(none provided)')}</p>
    <h3>Live verification results (single pass)</h3>
    <p>
      Address (Google): ${addressLine}${!hold && addr.matchedAddress ? ' [Google matched: ' + e(addr.matchedAddress) + ']' : ''}${unitLine}<br>
      Phone (Twilio): ${phoneLine}<br>
      Email (ZeroBounce): ${results.email.status === 'valid' ? '✅ ' : (results.email.status === 'catch-all' || results.email.status === 'unknown' ? '⚠️ ' : '❌ ')}${e(results.email.reason)}<br>
      Ownership: ⚠️ Not checked live (no public county records API) — confirm manually before selling this lead.
    </p>
  `;

  const subject = hold
    ? `⚠ HOLD — DO NOT SELL — ADDRESS MISMATCH — ${lead.fullname} (score 0)`
    : `New lead: ${lead.fullname} (score ${scoreInfo.total})`;

  return { subject, html };
}

async function sendNotification(lead, results, scoreInfo) {
  const { subject, html } = buildNotification(lead, results, scoreInfo);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev',
        to: process.env.LEAD_NOTIFICATION_EMAIL,
        subject,
        html
      })
    });
    return res.ok;
  } catch (err) {
    console.error('Resend error:', err);
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const lead = JSON.parse(event.body || '{}');

    const [address, phone, email] = await Promise.all([
      checkAddress(lead),
      checkPhone(lead.phone),
      checkEmail(lead.email)
    ]);

    const results = { address, phone, email };
    const score = computeScore(lead, results);
    const notificationSent = await sendNotification(lead, results, score);

    return {
      statusCode: 200,
      body: JSON.stringify({ ...results, score, notificationSent })
    };
  } catch (err) {
    console.error('verify-and-notify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};

// Exposed for local testing only (Netlify ignores extra exports).
exports._buildNotification = buildNotification;
exports._compareLocation = compareLocation;
exports._computeScore = computeScore;
