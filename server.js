const express = require('express');
const path = require('path');
const { getFortunRank } = require('./fortune500');

const app = express();
const PORT = process.env.PORT || 3000;
const HS_TOKEN = process.env.HUBSPOT_TOKEN;

const TITLE_FILTERS = [
  'CIO', 'CTO', 'CDO', 'CIDO',
  'Chief Information Officer', 'Chief Technology Officer',
  'Chief Digital Officer', 'Chief Information and Digital Officer',
  'Chief AI Officer', 'Chief Automation Officer', 'Chief Data Officer',
  'Chief Information & Digital Officer', 'Digital', 'Artificial Intelligence', 'Automation',
];

const CONTACT_PROPS = [
  'firstname', 'lastname', 'jobtitle', 'company',
  'mobilephone', 'phone', 'hs_lead_status', 'hubspot_owner_id',
  'notes_last_contacted', 'hs_email_last_send_date', 'num_associated_deals',
  'hubspotscore',
];

// Deal stages in main pipeline (17259398)
const OPEN_STAGES = new Set(['17259399','17259400','17259401','17259402','17259403']);
const CLOSED_WON = '17259404';

// Event keywords to detect in deal names
const EVENT_KEYWORDS = {
  ric: ['ric ', ' ric', 'ric2025', 'ric2024', 'ric 2025', 'ric 2024', 'relationship intelligence'],
  ceo_dinner: ['ceo dinner', 'disruptors dinner', "keith's dinner", 'scott cook dinner', 'dinner with keith'],
  scott_cook: ['scott cook'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsPost(url, body, retries = 6) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`https://api.hubapi.com${url}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('Rate limit: max retries exceeded');
}

async function hsGet(url, retries = 6) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`https://api.hubapi.com${url}`, {
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` },
    });
    if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('Rate limit: max retries exceeded');
}

async function fetchAllContacts() {
  const all = [], seen = new Set();
  const filterGroups = TITLE_FILTERS.map(t => ({
    filters: [{ propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: t }],
  }));
  const BATCH = 5;
  for (let i = 0; i < filterGroups.length; i += BATCH) {
    if (i > 0) await sleep(700);
    const batch = filterGroups.slice(i, i + BATCH);
    let after;
    do {
      const body = { filterGroups: batch, properties: CONTACT_PROPS, limit: 100 };
      if (after) body.after = after;
      const data = await hsPost('/crm/v3/objects/contacts/search', body);
      for (const c of data.results || []) {
        if (!seen.has(c.id)) { seen.add(c.id); all.push(c); }
      }
      after = data.paging?.next?.after;
      if (after) await sleep(400);
    } while (after);
  }
  return all;
}

async function fetchEventContactIds() {
  // Fetch deals with event keywords in their name, collect associated contact IDs
  const eventContactMap = {}; // contactId -> { ric, ceo_dinner, scott_cook }
  const allKeywords = [
    ...EVENT_KEYWORDS.ric,
    ...EVENT_KEYWORDS.ceo_dinner,
    ...EVENT_KEYWORDS.scott_cook,
  ];

  for (let i = 0; i < allKeywords.length; i++) {
    if (i > 0) await sleep(500);
    const kw = allKeywords[i];
    try {
      const data = await hsPost('/crm/v3/objects/deals/search', {
        query: kw,
        properties: ['dealname', 'dealstage', 'hs_object_id'],
        limit: 100,
      });
      for (const deal of data.results || []) {
        const dealNameLower = (deal.properties.dealname || '').toLowerCase();
        // Determine which event type
        let eventType = null;
        if (EVENT_KEYWORDS.ric.some(k => dealNameLower.includes(k))) eventType = 'ric';
        else if (EVENT_KEYWORDS.ceo_dinner.some(k => dealNameLower.includes(k))) eventType = 'ceo_dinner';
        else if (EVENT_KEYWORDS.scott_cook.some(k => dealNameLower.includes(k))) eventType = 'scott_cook';
        if (!eventType) continue;

        // Get contacts associated with this deal
        await sleep(300);
        const assoc = await hsGet(`/crm/v3/objects/deals/${deal.id}/associations/contacts`);
        for (const r of assoc.results || []) {
          if (!eventContactMap[r.id]) eventContactMap[r.id] = { ric: false, ceo_dinner: false, scott_cook: false };
          eventContactMap[r.id][eventType] = true;
        }
      }
    } catch (e) {
      console.warn(`Event search failed for "${kw}":`, e.message);
    }
  }
  return eventContactMap;
}

async function fetchOpenDealContactIds() {
  // Get all open deals and their contact associations
  const dealContactIds = new Set();
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'IN', values: [...OPEN_STAGES] }] }],
      properties: ['dealname', 'dealstage'],
      limit: 100,
    };
    if (after) body.after = after;
    const data = await hsPost('/crm/v3/objects/deals/search', body);
    for (const deal of data.results || []) {
      try {
        await sleep(200);
        const assoc = await hsGet(`/crm/v3/objects/deals/${deal.id}/associations/contacts`);
        for (const r of assoc.results || []) dealContactIds.add(r.id);
      } catch (e) { /* skip */ }
    }
    after = data.paging?.next?.after;
    if (after) await sleep(500);
  } while (after);
  return dealContactIds;
}

function isAssistant(title) {
  if (!title) return false;
  const l = title.toLowerCase();
  return l.includes('executive assistant') || l.includes('office of ') || l.startsWith('ea to');
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function priorityScore(c) {
  let score = 0;
  if (c.hasOpenDeal) score += 40;
  if (c.events.ric) score += 20;
  if (c.events.ceo_dinner) score += 15;
  if (c.events.scott_cook) score += 15;
  if (c.lastContactedDays !== null) {
    if (c.lastContactedDays <= 30) score += 25;
    else if (c.lastContactedDays <= 90) score += 10;
    else if (c.lastContactedDays <= 180) score += 5;
  }
  if (c.fortuneRank) {
    if (c.fortuneRank <= 50) score += 15;
    else if (c.fortuneRank <= 200) score += 10;
    else score += 5;
  }
  if (c.mobile) score += 5;
  return score;
}

// Cache for 10 minutes
let cache = null, cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;
// Track when we last did a full fetch so incremental checks only pull newer contacts
let lastFullFetchDate = null;

function shapeContact(c, openDealIds, eventMap) {
  const p = c.properties;
  const lastContact = p.notes_last_contacted || p.hs_email_last_send_date || null;
  const days = daysSince(lastContact);
  const fortuneRank = getFortunRank(p.company);
  const events = eventMap[c.id] || { ric: false, ceo_dinner: false, scott_cook: false };
  const contact = {
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
    hasOpenDeal: openDealIds.has(c.id),
    hasAnyDeal: parseInt(p.num_associated_deals || '0') > 0,
    fortuneRank,
    events,
    hubspotScore: parseInt(p.hubspotscore || '0'),
    createdAt: c.createdAt || null,
    isNew: false,
  };
  contact.priority = priorityScore(contact);
  return contact;
}

async function fetchNewContacts(sinceDate) {
  // Only fetch contacts created after sinceDate using createdate filter
  const sinceStr = sinceDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const all = [], seen = new Set();
  const filterGroups = TITLE_FILTERS.map(t => ({
    filters: [
      { propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: t },
      { propertyName: 'createdate', operator: 'GTE', value: sinceStr },
    ],
  }));
  const BATCH = 5;
  for (let i = 0; i < filterGroups.length; i += BATCH) {
    if (i > 0) await sleep(500);
    const batch = filterGroups.slice(i, i + BATCH);
    const body = { filterGroups: batch, properties: CONTACT_PROPS, limit: 100 };
    const data = await hsPost('/crm/v3/objects/contacts/search', body);
    for (const c of data.results || []) {
      if (!seen.has(c.id)) { seen.add(c.id); all.push(c); }
    }
  }
  return all;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/contacts', async (req, res) => {
  try {
    if (cache && Date.now() - cacheTime < CACHE_TTL) return res.json(cache);

    console.log('Fetching contacts…');
    const raw = await fetchAllContacts();
    console.log(`Got ${raw.length} raw contacts. Fetching deal associations…`);

    const [openDealIds, eventMap] = await Promise.all([
      fetchOpenDealContactIds().catch(e => { console.warn('Deals fetch failed:', e.message); return new Set(); }),
      fetchEventContactIds().catch(e => { console.warn('Events fetch failed:', e.message); return {}; }),
    ]);

    const contacts = raw
      .filter(c => !isAssistant(c.properties.jobtitle))
      .map(c => shapeContact(c, openDealIds, eventMap))
      .filter(c => c.name)
      .sort((a, b) => b.priority - a.priority);

    lastFullFetchDate = new Date();
    cache = { contacts, generatedAt: new Date().toISOString(), newCount: 0 };
    cacheTime = Date.now();
    res.json(cache);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Lightweight incremental check — only pulls contacts created since last full fetch
app.get('/api/check-new', async (req, res) => {
  try {
    if (!lastFullFetchDate) return res.json({ newContacts: [], message: 'No baseline yet — load /api/contacts first' });

    console.log(`Checking for new contacts since ${lastFullFetchDate.toISOString()}…`);
    const raw = await fetchNewContacts(lastFullFetchDate);
    const fresh = raw.filter(c => !isAssistant(c.properties.jobtitle));

    if (!fresh.length) {
      console.log('No new contacts found.');
      return res.json({ newContacts: [], checkedAt: new Date().toISOString() });
    }

    // Merge into cache without re-fetching deals/events (keep it cheap)
    const shaped = fresh
      .map(c => { const s = shapeContact(c, new Set(), {}); s.isNew = true; return s; })
      .filter(c => c.name);

    if (cache) {
      const existingIds = new Set(cache.contacts.map(c => c.id));
      const brandNew = shaped.filter(c => !existingIds.has(c.id));
      if (brandNew.length) {
        cache.contacts = [...brandNew, ...cache.contacts];
        cache.newCount = (cache.newCount || 0) + brandNew.length;
        cache.lastChecked = new Date().toISOString();
        lastFullFetchDate = new Date();
        console.log(`Added ${brandNew.length} new contacts to cache.`);
        return res.json({ newContacts: brandNew, checkedAt: cache.lastChecked });
      }
    }

    lastFullFetchDate = new Date();
    res.json({ newContacts: [], checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refresh', (req, res) => {
  cache = null; cacheTime = 0; lastFullFetchDate = null;
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`FG Dashboard → http://localhost:${PORT}`));
