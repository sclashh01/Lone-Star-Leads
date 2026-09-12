// netlify/functions/submit-lead.js
//
// Called once, right when a homeowner finishes and submits the form.
// Emails the full lead — including the verification results — to you, so
// a lead never just disappears into the browser with nobody seeing it.
//
// SETUP (one-time):
//   1. Create a free Resend account (resend.com) — no credit card needed,
//      free tier covers 3,000 emails/month (100/day), plenty for this.
//   2. Grab your API key from the Resend dashboard (API Keys section).
//   3. In Netlify: Site settings > Environment variables > add
//      RESEND_API_KEY = <your api key>
//      LEAD_NOTIFICATION_EMAIL = <the email that should receive leads>
//   4. Put this file at netlify/functions/submit-lead.js and deploy.
//      Reachable at: /.netlify/functions/submit-lead
//
// NOTE: this sends from Resend's shared "onboarding@resend.dev" address,
// which works immediately with zero setup. Once you have your own domain
// (e.g. lonestarleads.com), verify it in Resend and change the "from"
// address below to something like "leads@lonestarleads.com".

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.LEAD_NOTIFICATION_EMAIL;
  if (!apiKey || !toEmail) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing RESEND_API_KEY or LEAD_NOTIFICATION_EMAIL.' })
    };
  }

  let lead;
  try {
    lead = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const html = buildLeadEmailHtml(lead);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Lone Star Leads <onboarding@resend.dev>',
        to: [toEmail],
        subject: `New roofing lead — ${lead.fullname || 'Unknown'} (${lead.city || ''}, TX ${lead.zip || ''})`,
        html
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return { statusCode: 502, body: JSON.stringify({ error: 'Resend failed to send the email.', detail: errData }) };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Email send request failed.', detail: err.message }) };
  }
};

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function row(label, value) {
  return `<tr><td style="padding:4px 14px 4px 0;color:#57534A;font-size:13px;white-space:nowrap;">${esc(label)}</td><td style="padding:4px 0;font-size:13px;font-weight:600;">${esc(value)}</td></tr>`;
}

function buildLeadEmailHtml(lead) {
  const v = lead.verification || {};
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;color:#211E1A;">
      <h2 style="margin:0 0 4px;">New Roofing Lead</h2>
      <p style="color:#57534A;font-size:13px;margin:0 0 18px;">Score: <strong>${esc(lead.score)} / 100</strong></p>

      <h3 style="margin:0 0 8px;font-size:14px;">Homeowner</h3>
      <table>
        ${row('Name', lead.fullname)}
        ${row('Phone', lead.phone)}
        ${row('Email', lead.email)}
        ${row('Address', `${lead.street}${lead.unit ? ', ' + lead.unit : ''}, ${lead.city}, TX ${lead.zip}`)}
      </table>

      <h3 style="margin:20px 0 8px;font-size:14px;">Job details</h3>
      <table>
        ${row('Roof need', lead.need)}
        ${row('Property size', lead.size)}
        ${row('Problem description', lead.desc)}
        ${row('Urgency', lead.urgency)}
        ${row('Payment method', lead.payment)}
      </table>

      <h3 style="margin:20px 0 8px;font-size:14px;">Verification</h3>
      <table>
        ${row('Address', v.address)}
        ${row('Phone', v.phone)}
        ${row('Email', v.email)}
        ${row('Ownership', v.ownership)}
      </table>
    </div>
  `;
}
