'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const { getEvent, getEntrant, getSetsForEntrants, getPhaseGroupBracket, searchEntrants, clearCache, cacheSize } = require('./src/startgg');
const { findDirectCollisions, getPlayerTimeline, simulateBracket } = require('./src/bracket');

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

// Start with 2 entrants; POST /api/config to update
let TRACKED_IDS = [22927499, 22318059, 22785074, 22264159, 22920324, 23216301, 22912564, 23215432, 102331399];

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

    // Collect phase group IDs from:
    // 1. Upcoming sets (current active pools)
    // 2. Player seeds across ALL phases (Round 2, Round 3, etc.)
    const phaseGroupIds = new Set();
    for (const set of sets) {
      if (set?.phaseGroup?.id && !set.completedAt) {
        phaseGroupIds.add(String(set.phaseGroup.id));
      }
    }
    for (const player of players) {
      for (const seed of (player?.seeds || [])) {
        if (seed?.phaseGroup?.id) phaseGroupIds.add(String(seed.phaseGroup.id));
      }
    }

    // For Phase 2, 3, Finals, etc.: fetch ALL groups if the phase is small (≤ 16 groups).
    // Phase 1 pools can have 50–100+ groups (too many) — we only use tracked player seeds there.
    // Phase 2+ typically has 8–16 groups, and Phase 3/Finals has 1–2, so fetching all
    // gives the complete multi-round bracket picture without excessive API calls.
    for (const phase of (event.phases || [])) {
      const pgs = phase.phaseGroups?.nodes || [];
      if (pgs.length <= 16) {
        for (const pg of pgs) phaseGroupIds.add(String(pg.id));
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

// Debug: show bracket graph size + opponent preview per tracked player
app.get('/api/debug/opponents', async (req, res) => {
  try {
    const event   = await getEvent(EVENT_SLUG);
    const players = await Promise.all(TRACKED_IDS.map(id => getEntrant(id)));
    const sets    = await getSetsForEntrants(event.id, TRACKED_IDS);

    const phaseGroupIds = new Set();
    for (const s of sets) if (s?.phaseGroup?.id) phaseGroupIds.add(String(s.phaseGroup.id));
    for (const p of players) for (const seed of (p?.seeds || [])) if (seed?.phaseGroup?.id) phaseGroupIds.add(String(seed.phaseGroup.id));

    const brackets = {};
    await Promise.all(Array.from(phaseGroupIds).map(async pgId => {
      try { brackets[pgId] = await getPhaseGroupBracket(pgId); } catch { /* skip */ }
    }));

    // For each tracked player, trace their next set's opponent via prereqId
    const out = [];
    for (const player of players) {
      if (!player) continue;
      const pid = String(player.id);
      let nextSet = null;
      let oppInfo = 'not found';

      // Find the set where this player appears in any pool bracket
      for (const [, pgSets] of Object.entries(brackets)) {
        for (const s of pgSets) {
          const mySlot = (s.slots || []).find(sl => sl.entrant && String(sl.entrant.id) === pid);
          if (!mySlot) continue;
          const oppSlot = (s.slots || []).find(sl => sl !== mySlot);
          if (oppSlot?.entrant) { oppInfo = oppSlot.entrant.name; nextSet = s.id; break; }
          if (oppSlot?.prereqId) {
            const allSets = new Map();
            for (const [, pgS] of Object.entries(brackets)) for (const ss of pgS) allSets.set(String(ss.id), ss);
            const feeder = allSets.get(String(oppSlot.prereqId));
            const names = (feeder?.slots || []).map(sl => sl.entrant?.name).filter(Boolean);
            oppInfo = names.length ? `W of ${names.join(' vs ')}` : `prereq=${oppSlot.prereqId} (not in graph)`;
            nextSet = s.id;
          }
          if (nextSet) break;
        }
        if (nextSet) break;
      }
      out.push({ player: player.name, setId: nextSet, opponent: oppInfo });
    }

    res.json({ bracketPoolCount: Object.keys(brackets).length, opponents: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Tekken Tracker → http://localhost:${PORT}`);
  console.log(`  Tracking: ${TRACKED_IDS.join(', ')}\n`);
});
