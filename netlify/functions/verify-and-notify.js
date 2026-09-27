// netlify/functions/verify-and-notify.js
//
// ONE function, ONE call from the form (fired once, at final submit).
// Runs Google Address Validation, Twilio Lookup (phone), and ZeroBounce
// (email) in parallel, then immediately sends the lead notification email
// via Resend in the SAME invocation. Property ownership has no public
// county-records API in any state, so it always routes to manual review.
//
// MULTI-STATE / MULTI-MARKET: this function is state-agnostic — it reads
// `state` from the submitted lead (set by the homeowner's State dropdown
// in the front-end HTML) instead of assuming Texas.
//
// Required Netlify environment variables:
//   GOOGLE_MAPS_API_KEY                       (Google Cloud Console)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN     (Twilio Console)
//   ZEROBOUNCE_API_KEY                        (ZeroBounce)
//   RESEND_API_KEY, RESEND_FROM_ADDRESS,
//   LEAD_NOTIFICATION_EMAIL                   (Resend)

const GOOGLE_ADDRESS_VALIDATION_URL = 'https://addressvalidation.googleapis.com/v1:validateAddress';

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

    return {
      exists: true,
      matchedAddress: result.address?.formattedAddress || `${street}, ${city}, ${state} ${zip}`,
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
    <p>${lead.street}${lead.unit ? ', ' + lead.unit : ''}, ${lead.city}, ${lead.state} ${lead.zip}</p>
    <h3>Request</h3>
    <p>Need: ${lead.need}<br>Size: ${lead.size}<br>Urgency: ${lead.urgency}<br>Payment: ${lead.payment}<br>Description: ${lead.desc || '(none provided)'}</p>
    <h3>Live verification results (single pass)</h3>
    <p>
      Address (Google): ${results.address.exists ? '✅ ' + results.address.reason : '❌ ' + results.address.reason}<br>
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
