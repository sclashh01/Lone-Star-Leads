// netlify/functions/validate-address.js
//
// Calls Google's Address Validation API server-side to confirm a submitted
// address actually exists, and computes real distance from an Austin origin
// point using the returned coordinates — replacing the static ZIP-list
// stand-in used in the browser-only demo.
//
// SETUP (one-time):
//   1. In Google Cloud Console: enable the "Address Validation API" on your
//      project, and enable billing (required by Google — the first $200 of
//      usage per month is free, which covers roughly 11,000+ validations,
//      far more than a $15/day lead volume will use).
//   2. Create an API key restricted to the Address Validation API.
//   3. In Netlify: Site settings > Environment variables > add
//      GOOGLE_MAPS_API_KEY = <your key>
//   4. Put this file at netlify/functions/validate-address.js in your site
//      repo and deploy. It becomes reachable at:
//      /.netlify/functions/validate-address
//
// The frontend (lone-star-leads.html) calls this endpoint automatically and
// falls back to a local format-only check if the endpoint isn't reachable
// (e.g. when the HTML file is opened standalone, outside of Netlify).

const AUSTIN_ORIGIN = { lat: 30.2672, lng: -97.7431 }; // Austin, TX city center
const MAX_SERVICE_RADIUS_MILES = 30;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing GOOGLE_MAPS_API_KEY environment variable.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { street, unit, city, state, zip } = payload;
  const addressLines = [unit ? `${street} ${unit}` : street];

  try {
    const response = await fetch(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: {
            regionCode: 'US',
            addressLines,
            locality: city,
            administrativeArea: state || 'TX',
            postalCode: zip
          }
        })
      }
    );

    const data = await response.json();
    const result = data.result;

    if (!result) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          exists: false,
          confidence: null,
          standardizedAddress: null,
          distanceMiles: null,
          withinServiceArea: false
        })
      };
    }

    const verdict = result.verdict || {};
    const geocode = result.geocode || {};
    const location = geocode.location || {};
    const addressComponents = (result.address && result.address.addressComponents) || [];

    const exists = !!(verdict.addressComplete || location.latitude);

    const hasUnconfirmedComponents = !!verdict.hasUnconfirmedComponents;
    const hasInferredComponents = !!verdict.hasInferredComponents;
    const hasReplacedComponents = !!verdict.hasReplacedComponents;
    const exactMatch = !!verdict.addressComplete && !hasUnconfirmedComponents && !hasInferredComponents && !hasReplacedComponents;

    const postalComponent = addressComponents.find(c => c.componentType === 'postal_code');
    const zipMismatch = !!(postalComponent && postalComponent.replaced);
    const correctedZip = postalComponent ? postalComponent.componentName.text : null;

    let distanceMiles = null;
    let withinServiceArea = false;
    if (location.lat
