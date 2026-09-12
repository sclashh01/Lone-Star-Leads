// netlify/functions/verify-email.js
//
// Calls ZeroBounce server-side to confirm a submitted email's mailbox
// actually exists — not just that the format looks right and the domain
// isn't a known typo.
//
// SETUP (one-time):
//   1. Create a free ZeroBounce account (zerobounce.net) and buy a small
//      credit bundle (validations are roughly a fraction of a cent each).
//   2. Grab your API key from the ZeroBounce dashboard.
//   3. In Netlify: Site settings > Environment variables > add
//      ZEROBOUNCE_API_KEY = <your api key>
//   4. Put this file at netlify/functions/verify-email.js and deploy.
//      Reachable at: /.netlify/functions/verify-email
//
// NOTE: this confirms the mailbox exists and can receive mail. It does NOT
// confirm the homeowner is the one who controls it — that needs a
// confirmation-link email, a separate, optional upgrade on top of this.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ZEROBOUNCE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing ZEROBOUNCE_API_KEY.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const email = (payload.email || '').trim();
  if (!email) {
    return { statusCode: 200, body: JSON.stringify({ status: 'invalid', subStatus: null, reason: 'No email provided.' }) };
  }

  try {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${apiKey}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({ status: 'unknown', subStatus: null, reason: data.error || 'ZeroBounce could not validate this email right now.' })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: data.status,
        subStatus: data.sub_status,
        reason: describeStatus(data.status, data.sub_status)
      })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'ZeroBounce request failed.', detail: err.message })
    };
  }
};

function describeStatus(status, subStatus) {
  const map = {
    valid: 'ZeroBounce confirmed this mailbox exists and can receive mail.',
    invalid: 'ZeroBounce confirmed this mailbox does not exist.',
    'catch-all': "This domain accepts all mail (catch-all) — ZeroBounce can't confirm this specific mailbox exists.",
    unknown: "ZeroBounce couldn't determine mailbox status (e.g. the mail server didn't respond in time).",
    spamtrap: 'This address is a known spam trap.',
    abuse: 'This address has a history of abuse complaints.',
    do_not_mail: 'This address is on a do-not-mail list (role account, disposable domain, etc.).'
  };
  const base = map[status] || 'Unrecognized ZeroBounce status.';
  return subStatus ? `${base} (${subStatus})` : base;
}
