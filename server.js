const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HS_TOKEN = process.env.HUBSPOT_TOKEN;

const TITLE_FILTERS = [
  'CIO', 'CTO', 'CDO', 'CIDO',
  'Chief Information Officer',
  'Chief Technology Officer',
  'Chief Digital Officer',
  'Chief Information and Digital Officer',
  'Chief AI Officer',
  'Chief Automation Officer',
  'Chief Data Officer',
  'Chief Information & Digital Officer',
  'Digital',
  'Artificial Intelligence',
  'Automation',
];

const PROPERTIES = [
  'firstname', 'lastname', 'jobtitle', 'company',
  'mobilephone', 'phone',
  'hs_lead_status', 'hubspot_owner_id',
  'notes_last_contacted', 'hs_email_last_send_date',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsPost(body, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const wait = 1200 * (attempt + 1);
      console.log(`Rate limited, waiting ${wait}ms…`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HubSpot error ${res.status}: ${err}`);
    }

    return res.json();
  }
  throw new Error('HubSpot rate limit: max retries exceeded');
}

async function fetchHubSpotContacts() {
  const allContacts = [];
  const seen = new Set();

  const filterGroups = TITLE_FILTERS.map(token => ({
    filters: [{ propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: token }],
  }));

  // HubSpot max 5 filterGroups per request — batch with delay between
  const BATCH_SIZE = 5;
  for (let i = 0; i < filterGroups.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(600);
    const batch = filterGroups.slice(i, i + BATCH_SIZE);
    let after = undefined;

    do {
      const body = { filterGroups: batch, properties: PROPERTIES, limit: 100 };
      if (after) body.after = after;

      const data = await hsPost(body);
      for (const c of data.results || []) {
        if (!seen.has(c.id)) { seen.add(c.id); allContacts.push(c); }
      }
      after = data.paging?.next?.after;
      if (after) await sleep(400);
    } while (after);
  }

  return allContacts;
}

function isExecutiveAssistant(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return lower.includes('executive assistant') || lower.includes('office of ');
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// Cache results for 10 minutes to avoid re-hitting rate limits on reload
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/contacts', async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json(cache);
    }

    const raw = await fetchHubSpotContacts();
    const contacts = raw
      .filter(c => !isExecutiveAssistant(c.properties.jobtitle))
      .map(c => {
        const p = c.properties;
        const lastContact = p.notes_last_contacted || p.hs_email_last_send_date || null;
        const days = daysSince(lastContact);
        return {
          id: c.id,
          name: `${p.firstname || ''} ${p.lastname || ''}`.trim(),
          title: p.jobtitle || '',
          company: p.company || '',
          mobile: p.mobilephone || '',
          phone: p.phone || '',
          leadStatus: p.hs_lead_status || '',
          lastContactedDays: days,
          lastContactedDate: lastContact,
          active: days !== null && days <= 30,
        };
      })
      .filter(c => c.name);

    cache = { contacts, generatedAt: new Date().toISOString() };
    cacheTime = Date.now();
    res.json(cache);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FG Dashboard running at http://localhost:${PORT}`);
});
