'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const { getEvent, getEntrant, getSetsForEntrants, searchEntrants, clearCache, cacheSize } = require('./src/startgg');

const app = express();
app.use(express.json());
// Disable caching for JS/CSS so the browser always picks up the latest code
app.use((req, res, next) => {
  if (req.path.match(/\.(js|css)$/)) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
let EVENT_SLUG = process.env.EVENT_SLUG
  || 'tournament/evo-japan-2026-presented-by-levtech/event/evo-japan-2026-tekken-8';

const DEFAULT_IDS = [22927499, 22318059, 22785074, 22264159, 22920324, 23216301, 22912564, 23215432];
let TRACKED_IDS = [...DEFAULT_IDS];

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/event', async (req, res) => {
  try {
    res.json(await getEvent(EVENT_SLUG));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/players', async (req, res) => {
  try {
    const players = await Promise.all(TRACKED_IDS.map(id => getEntrant(id)));
    res.json(players);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sets', async (req, res) => {
  try {
    const event = await getEvent(EVENT_SLUG);
    const sets = await getSetsForEntrants(event.id, TRACKED_IDS);
    res.json(sets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// Returns everything needed for the dashboard in one call
app.get('/api/dashboard', async (req, res) => {
  try {
    const [event, players] = await Promise.all([
      getEvent(EVENT_SLUG),
      Promise.all(TRACKED_IDS.map(id => getEntrant(id))),
    ]);
    const sets = await getSetsForEntrants(event.id, TRACKED_IDS);

    res.json({ event, players, sets, trackedIds: TRACKED_IDS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const event = await getEvent(EVENT_SLUG);
    const results = await searchEntrants(event.id, q);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh', (req, res) => {
  clearCache();
  res.json({ ok: true, clearedAt: new Date().toISOString() });
});

// Update event slug and/or tracked entrant IDs at runtime
app.post('/api/config', (req, res) => {
  const { entrantIds, eventSlug } = req.body || {};

  if (eventSlug && typeof eventSlug === 'string' && eventSlug.trim()) {
    EVENT_SLUG = eventSlug.trim();
  }

  if (entrantIds !== undefined) {
    if (!Array.isArray(entrantIds) || !entrantIds.length) {
      return res.status(400).json({ error: 'entrantIds must be a non-empty array' });
    }
    TRACKED_IDS = entrantIds.map(Number).filter(Boolean);
  }

  clearCache();
  res.json({ ok: true, trackedIds: TRACKED_IDS, eventSlug: EVENT_SLUG });
});

app.get('/api/status', (req, res) => {
  res.json({ trackedIds: TRACKED_IDS, cacheEntries: cacheSize(), eventSlug: EVENT_SLUG });
});

app.post('/api/reset', (req, res) => {
  TRACKED_IDS = [...DEFAULT_IDS];
  clearCache();
  res.json({ ok: true, trackedIds: TRACKED_IDS });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Tekken Tracker → http://localhost:${PORT}`);
  console.log(`  Tracking: ${TRACKED_IDS.join(', ')}\n`);
});
