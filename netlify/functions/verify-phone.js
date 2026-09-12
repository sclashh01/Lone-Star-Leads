// netlify/functions/verify-phone.js
//
// Calls Twilio Lookup (v2, with Line Type Intelligence) server-side to
// confirm a submitted phone number is a real, currently valid US number —
// not just 10 digits in the right shape.
//
// SETUP (one-time):
//   1. Create a Twilio account (twilio.com) if you don't have one.
//   2. From the Twilio Console, grab your Account SID and Auth Token.
//   3. In Netlify: Site settings > Environment variables > add
//      TWILIO_ACCOUNT_SID = <your account sid>
//      TWILIO_AUTH_TOKEN  = <your auth token>
//   4. Put this file at netlify/functions/verify-phone.js and deploy.
//      Reachable at: /.netlify/functions/verify-phone
//
// NOTE: this confirms the number is real, active, and in service. It does
// NOT confirm the homeowner is the one holding it right now — that needs an
// SMS one-time-passcode step (Twilio Verify), a separate, optional upgrade.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const digits = (payload.phone || '').replace(/\D/g, '');
  if (digits.length !== 10) {
    return {
      statusCode: 200,
      body: JSON.stringify({ valid: false, lineType: null, carrierName: null, reason: 'Not a 10-digit US number.' })
    };
  }

  const e164 = `+1${digits}`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    const res = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          valid: false,
          lineType: null,
          carrierName: null,
          reason: data.message || 'Twilio Lookup could not validate this number.'
        })
      };
    }

    const lti = data.line_type_intelligence || {};
    const lineType = lti.type || null;
    const carrierName = lti.carrier_name || null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        valid: !!data.valid,
        lineType,
        carrierName,
        reason: data.valid
          ? `Twilio confirmed this is an active${lineType ? ' ' + lineType : ''} number${carrierName ? ' on ' + carrierName : ''}.`
          : 'Twilio could not confirm this is a valid, in-service phone number.'
      })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Twilio Lookup request failed.', detail: err.message })
    };
  }
};
