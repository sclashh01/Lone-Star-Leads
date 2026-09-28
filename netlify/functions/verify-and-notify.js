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

async function checkAddress({ street, city, zip, state }) {
  try {
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
        matchedAddress: formatted,
        correctedAddress: formatted,
        reason: `Auto-corrected by Google (${parts.join('; ')}). Using the corrected address.`
      };
    }

    return {
      exists: true,
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

async function sendNotification(lead, results) {
  const html = `
    <h2>New Roofing Lead — Score: ${lead.score}/100</h2>
    <h3>Contact</h3>
    <p><b>${lead.fullname}</b><br>Phone: ${lead.phone}<br>Email: ${lead.email}</p>
    <h3>Property</h3>
    <p>${results.address.corrected ? results.address.correctedAddress + ' <i>(auto-corrected by Google; homeowner typed: ' + lead.street + ', ' + lead.city + ', ' + lead.state + ' ' + lead.zip + ')</i>' : lead.street + (lead.unit ? ', ' + lead.unit : '') + ', ' + lead.city + ', ' + lead.state + ' ' + lead.zip}${results.address.corrected && lead.unit ? '<br>Unit: ' + lead.unit : ''}</p>
    <h3>Request</h3>
    <p>Need: ${lead.need}<br>Size: ${lead.size}<br>Urgency: ${lead.urgency}<br>Payment: ${lead.payment}<br>Description: ${lead.desc || '(none provided)'}</p>
    <h3>Live verification results (single pass)</h3>
    <p>
      Address (Google): ${results.address.exists ? (results.address.corrected ? '⚠️ ' : '✅ ') + results.address.reason : '❌ ' + results.address.reason}${results.address.matchedAddress ? ' [Google matched: ' + results.address.matchedAddress + ']' : ''}<br>
      Phone (Twilio): ${results.phone.valid ? '✅ ' + results.phone.reason : '❌ ' + results.phone.reason}<br>
      Email (ZeroBounce): ${results.email.status === 'valid' ? '✅ ' : (results.email.status === 'catch-all' || results.email.status === 'unknown' ? '⚠️ ' : '❌ ')}${results.email.reason}<br>
      Ownership: ⚠️ Not checked live (no public county records API) — confirm manually before selling this lead.
    </p>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev',
        to: process.env.LEAD_NOTIFICATION_EMAIL,
        subject: `New lead: ${lead.fullname} (score ${lead.score})`,
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
    const notificationSent = await sendNotification(lead, results);

    return {
      statusCode: 200,
      body: JSON.stringify({ ...results, notificationSent })
    };
  } catch (err) {
    console.error('verify-and-notify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
