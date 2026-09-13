// netlify/functions/verify-property.js
//
// Queries Travis Central Appraisal District's PUBLIC parcel database
// (published as a free, public ArcGIS REST service by Travis County GIS)
// to confirm, from official county records:
//   1. That the property exists as a real, registered parcel, and
//   2. Who the county has on file as the owner of record.
//
// Completely free, no API key, no signup, no credit card.

const TCAD_QUERY_URL = 'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0/query';

const STREET_SUFFIXES = [
  'st','street','ave','avenue','blvd','boulevard','dr','drive','ct','court',
  'ln','lane','rd','road','way','cir','circle','pl','place','trl','trail',
  'pkwy','parkway','loop','path','ter','terrace','sq','square','hwy','highway'
];

function buildSearchTerm(street) {
  const s = (street || '').trim().toUpperCase();
  const words = s.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1]?.toLowerCase().replace(/[.,]/g, '');
  if (words.length > 1 && STREET_SUFFIXES.includes(last)) {
    words.pop();
  }
  return words.join(' ');
}

function findFieldValue(attributes, patterns) {
  const keys = Object.keys(attributes || {});
  for (const pattern of patterns) {
    const match = keys.find(k => pattern.test(k));
    if (match && attributes[match] != null && String(attributes[match]).trim() !== '') {
      return String(attributes[match]).trim();
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { street, fullname } = payload;
  const searchTerm = buildSearchTerm(street);

  if (!searchTerm) {
    return {
      statusCode: 200,
      body: JSON.stringify({ exists: false, reason: 'No street provided to search.' })
    };
  }

  const whereClause = `SITUS LIKE '%${searchTerm.replace(/'/g, "''")}%'`;
  const url = `${TCAD_QUERY_URL}?where=${encodeURIComponent(whereClause)}&outFields=*&returnGeometry=false&resultRecordCount=5&f=json`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return {
        statusCode: 200,
        body: JSON.stringify({ exists: false, source: 'error', reason: `TCAD query error: ${data.error.message || 'unknown error'}` })
      };
    }

    const features = data.features || [];
    if (features.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          exists: false,
          reason: `No parcel record found in Travis County's database matching "${searchTerm}". This could mean the address doesn't exist, or county records simply haven't caught up with a recent change — route to manual review rather than auto-rejecting.`
        })
      };
    }

    const attrs = features[0].attributes || {};
    const matchedAddress = findFieldValue(attrs, [/^situs_address$/i, /^situs$/i, /^py_address$/i, /address/i]);
    const ownerName = findFieldValue(attrs, [/^py_owner_name$/i, /^owner_name$/i, /^owner$/i]);
    const propId = findFieldValue(attrs, [/^prop_id$/i, /^pid/i]);

    let ownerMatch = null;
    if (ownerName && fullname) {
      const submittedLower = fullname.toLowerCase();
      const ownerLower = ownerName.toLowerCase();
      const submittedLast = submittedLower.trim().split(/\s+/).pop();
      const ownerLast = ownerLower.trim().split(/\s+/).pop();
      ownerMatch = submittedLower.includes(ownerLast) || ownerLower.includes(submittedLast);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        exists: true,
        propId,
        matchedAddress,
        ownerName,
        ownerMatch,
        recordCount: features.length,
        reason: `Found a matching parcel on file with Travis Central Appraisal District${propId ? ` (Property ID ${propId})` : ''}.`
      })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'TCAD query request failed.', detail: err.message })
    };
  }
};
