'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const { getEvent, getEntrant, getSetsForEntrants, getPhaseGroupBracket, searchEntrants, clearCache, cacheSize } = require('./src/startgg');
const { findDirectCollisions, getPlayerTimeline, simulateBracket } = require('./src/bracket');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
let EVENT_SLUG = process.env.EVENT_SLUG
  || 'tournament/lvl-up-expo-2026-1/event/tekken-8-5-000-prize-pool';

// Start with 2 entrants; POST /api/config to update
let TRACKED_IDS = [22318059, 22785074, 22264159, 22927499];

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

app.get('/api/collisions', async (req, res) => {
  try {
    const event = await getEvent(EVENT_SLUG);
    const sets = await getSetsForEntrants(event.id, TRACKED_IDS);
    res.json(findDirectCollisions(sets, TRACKED_IDS));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/timeline/:entrantId', async (req, res) => {
  try {
    const event = await getEvent(EVENT_SLUG);
    const sets = await getSetsForEntrants(event.id, TRACKED_IDS);
    res.json(getPlayerTimeline(sets, req.params.entrantId));
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
    const collisions = findDirectCollisions(sets, TRACKED_IDS);

    const timelines = {};
    for (const id of TRACKED_IDS) {
      timelines[id] = getPlayerTimeline(sets, id);
    }

    // Only fetch brackets for pools with UPCOMING sets — not historical completed pools.
    // Using seeds would pull in Round 1 / Round 2 brackets and pollute the graph.
    const phaseGroupIds = new Set();
    for (const set of sets) {
      if (set?.phaseGroup?.id && !set.completedAt) {
        phaseGroupIds.add(String(set.phaseGroup.id));
      }
    }

    // Fetch full bracket for each active phase group (enables client-side propagation)
    const brackets = {};
    await Promise.all(Array.from(phaseGroupIds).map(async pgId => {
      try { brackets[pgId] = await getPhaseGroupBracket(pgId); } catch { /* skip */ }
    }));

    res.json({ event, players, sets, collisions, timelines, trackedIds: TRACKED_IDS, brackets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simulate bracket with overrides: { overrides: { setId: winnerId, ... } }
app.post('/api/simulate', async (req, res) => {
  try {
    const overrides = req.body?.overrides || {};
    const event = await getEvent(EVENT_SLUG);
    const sets = await getSetsForEntrants(event.id, TRACKED_IDS);
    const simSets = simulateBracket(sets, overrides);
    const collisions = findDirectCollisions(simSets, TRACKED_IDS);

    const timelines = {};
    for (const id of TRACKED_IDS) {
      timelines[id] = getPlayerTimeline(simSets, id);
    }

    res.json({ sets: simSets, collisions, timelines });
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

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Tekken Tracker → http://localhost:${PORT}`);
  console.log(`  Tracking: ${TRACKED_IDS.join(', ')}\n`);
});
