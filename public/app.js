'use strict';

const STORAGE_KEY = 'tekken_tracked_ids';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  event: null,
  players: [],
  sets: [],
  collisions: [],
  timelines: {},
  trackedIds: [],
  overrides: {},       // { setId: winnerId }
  brackets: {},        // phaseGroupId → sets[] (full bracket with prereq data)
  projected: null,     // Map<setId, { 0: Entrant|null, 1: Entrant|null }>
  lastUpdated: null,
  refreshTimer: null,
};

// ─── Bracket graph + propagation ──────────────────────────────────────────────
let bracketGraph = null; // { allSets: Map, advanceTo: Map }

function buildBracketGraph(brackets) {
  const allSets  = new Map(); // setId → set
  const advanceTo = new Map(); // setId → [{ nextSetId, slotIndex, isWin }]

  for (const sets of Object.values(brackets)) {
    for (const set of (sets || [])) {
      allSets.set(String(set.id), set);
      for (const slot of (set.slots || [])) {
        if (!slot.prereqId) continue;
        const key = String(slot.prereqId);
        if (!advanceTo.has(key)) advanceTo.set(key, []);
        advanceTo.get(key).push({
          nextSetId: String(set.id),
          slotIndex: slot.slotIndex ?? advanceTo.get(key).length,
          isWin: slot.prereqType !== 'loser',
        });
      }
    }
  }
  return { allSets, advanceTo };
}

// Returns Map<setId, { 0: Entrant|null, 1: Entrant|null }> with all confirmed
// and propagated-via-override entrants filled in.
function computeProjectedSets(graph, overrides) {
  const { allSets, advanceTo } = graph;
  const projected = new Map();

  const slots = (setId) => {
    if (!projected.has(setId)) projected.set(setId, {});
    return projected.get(setId);
  };

  // Seed from known entrants in actual slots
  for (const [setId, set] of allSets) {
    for (const sl of (set.slots || [])) {
      if (sl.entrant) slots(setId)[sl.slotIndex ?? 0] = sl.entrant;
    }
  }

  // Multi-pass propagation (up to 20 rounds for deep brackets)
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;

    for (const [setId, set] of allSets) {
      const s = slots(setId);
      const e0 = s[0] || null;
      const e1 = s[1] || null;

      let winner = null, loser = null;

      if (set.completedAt && set.winnerId) {
        const wid = String(set.winnerId);
        if (e0 && String(e0.id) === wid) { winner = e0; loser = e1; }
        else if (e1 && String(e1.id) === wid) { winner = e1; loser = e0; }
      } else {
        const ovId = overrides[setId];
        if (ovId !== undefined) {
          const ov = String(ovId);
          if (e0 && String(e0.id) === ov) { winner = e0; loser = e1; }
          else if (e1 && String(e1.id) === ov) { winner = e1; loser = e0; }
        }
      }

      if (!winner && !loser) continue;

      for (const { nextSetId, slotIndex, isWin } of (advanceTo.get(setId) || [])) {
        const entrant = isWin ? winner : loser;
        if (!entrant) continue;
        const ns = slots(nextSetId);
        if (!ns[slotIndex]) { ns[slotIndex] = entrant; changed = true; }
      }
    }

    if (!changed) break;
  }

  return projected;
}

function recomputeProjected() {
  if (bracketGraph) state.projected = computeProjectedSets(bracketGraph, state.overrides);
}

// Returns 'win', 'loss', or 'tbd' for a player in a given set.
function getEffectiveOutcome(setId, playerId) {
  const set = bracketGraph?.allSets.get(String(setId));
  if (!set) return 'tbd';
  const sid = String(setId);
  const id  = String(playerId);

  if (set.completedAt && set.winnerId) {
    return String(set.winnerId) === id ? 'win' : 'loss';
  }
  const ov = state.overrides[sid];
  if (ov !== undefined) {
    return String(ov) === id ? 'win' : 'loss';
  }
  return 'tbd';
}

// Follows the player's actual bracket path — entry point(s) → wherever confirmed/overrides lead.
// Only shows losers-bracket sets if the player actually dropped to the losers side.
function getPlayerSets(playerId) {
  if (!bracketGraph) {
    return state.sets
      .filter(s => s.slots?.some(sl => sl.entrant && String(sl.entrant.id) === String(playerId)))
      .sort((a, b) => {
        if (a.completedAt && b.completedAt) return a.completedAt - b.completedAt;
        return bracketRound(a) - bracketRound(b);
      });
  }

  const id = String(playerId);
  const { allSets, advanceTo } = bracketGraph;
  const result = [];
  const visited = new Set();

  // Entry sets: player has an actual slot AND that slot is not fed from another set
  // that also has this player (avoids treating mid-bracket progression as entry points).
  const entrySets = [];
  for (const [, set] of allSets) {
    const mySlot = (set.slots || []).find(sl => sl.entrant && String(sl.entrant.id) === id);
    if (!mySlot) continue;
    if (!mySlot.prereqId) { entrySets.push(set); continue; }
    const feeder = allSets.get(String(mySlot.prereqId));
    const feederHasPlayer = feeder
      ? (feeder.slots || []).some(sl => sl.entrant && String(sl.entrant.id) === id)
      : false;
    if (!feederHasPlayer) entrySets.push(set);
  }

  // BFS: follow only the branch the player is actually on.
  // TBD sets are included but we stop propagating beyond them.
  const queue = [...entrySets];
  while (queue.length) {
    const set = queue.shift();
    if (!set) continue;
    const setId = String(set.id);
    if (visited.has(setId)) continue;
    visited.add(setId);
    result.push(set);

    const outcome = getEffectiveOutcome(setId, id);
    if (outcome === 'tbd') continue;

    for (const { nextSetId, isWin } of (advanceTo.get(setId) || [])) {
      if ((outcome === 'win') === isWin) queue.push(allSets.get(nextSetId));
    }
  }

  return result.sort((a, b) => {
    if (a.completedAt && b.completedAt) return a.completedAt - b.completedAt;
    if (a.completedAt && !b.completedAt) return -1;
    if (!a.completedAt && b.completedAt)  return 1;
    if (a.startAt && b.startAt && a.startAt !== b.startAt) return a.startAt - b.startAt;
    return bracketRound(a) - bracketRound(b);
  });
}

// Sort key: positive (winners) rounds first, then losers rounds by depth.
function bracketRound(set) {
  const r = set.round ?? 0;
  return r >= 0 ? r : 1000 - r; // losers rounds go after winners
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, opts);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

// Single call that returns everything
async function loadDashboard() {
  return apiFetch('/api/dashboard');
}

async function apiRefresh() {
  return apiFetch('/api/refresh', { method: 'POST' });
}

async function apiSetTracked(ids) {
  return apiFetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entrantIds: ids }),
  });
}

async function apiSearch(q) {
  return apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
}

// ─── Tracked ID persistence ───────────────────────────────────────────────────
function loadStoredIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const ids = JSON.parse(raw);
    return Array.isArray(ids) && ids.length ? ids : null;
  } catch { return null; }
}

function saveIds(ids) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

async function syncFromStorage() {
  const ids = loadStoredIds();
  if (!ids) return;
  try { await apiSetTracked(ids); } catch { /* server will use defaults */ }
}

async function addTracked(entrantId) {
  const newIds = [...new Set([...state.trackedIds, Number(entrantId)])];
  saveIds(newIds);
  await apiSetTracked(newIds);
  await loadData();
}

async function removeTracked(entrantId) {
  const newIds = state.trackedIds.filter(id => String(id) !== String(entrantId));
  if (!newIds.length) return;
  saveIds(newIds);
  await apiSetTracked(newIds);
  await loadData();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString('en-US', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function playerTag(player) {
  return player?.participants?.[0]?.player?.gamerTag || player?.name || '?';
}

// Effective result for a set entry, factoring in overrides
function resolveResult(setId, completedAt, winnerId, myId) {
  const override = state.overrides[String(setId)];
  if (override !== undefined && !completedAt) {
    return String(override) === String(myId) ? 'override' : 'proj-L';
  }
  if (completedAt) {
    return String(winnerId) === String(myId) ? 'W' : 'L';
  }
  return 'tbd';
}

const resultLabel = { W: 'W', L: 'L', 'proj-W': 'W?', 'proj-L': 'L?', override: 'W*', tbd: '?' };

// ─── Render: players ──────────────────────────────────────────────────────────
function renderPlayers() {
  const grid = document.getElementById('players-grid');
  if (!state.players.length) {
    grid.innerHTML = '<p class="muted">No player data returned.</p>';
    return;
  }

  const canRemove = state.players.filter(Boolean).length > 1;
  grid.innerHTML = state.players.map(p => {
    if (!p) return '';
    const tag  = playerTag(p);
    const seed = p.seeds?.[0]?.seedNum;
    const pool = p.seeds?.[0]?.phaseGroup?.displayIdentifier;
    const phase = p.seeds?.[0]?.phaseGroup?.phase?.name;

    return `
      <div class="player-card">
        ${canRemove ? `<button class="btn-remove" data-entrant-id="${p.id}" title="Remove">×</button>` : ''}
        <div class="player-tag">🇵🇰 ${esc(tag)}</div>
        <div class="badges">
          ${seed  ? `<span class="badge badge-seed">Seed #${seed}</span>` : ''}
          ${pool  ? `<span class="badge badge-pool">Pool ${esc(pool)}</span>` : ''}
          ${phase ? `<span class="badge badge-phase">${esc(phase)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ─── Render: timelines ────────────────────────────────────────────────────────
function renderTimelines() {
  const container = document.getElementById('timelines-container');
  if (!state.players.length) {
    container.innerHTML = '<p class="muted">No players loaded.</p>';
    return;
  }

  container.innerHTML = state.players.map(player => {
    if (!player) return '';
    const id  = String(player.id);
    const tag = playerTag(player);

    const playerSets = getPlayerSets(id);

    if (!playerSets.length) {
      return `
        <div class="timeline-row">
          <div class="timeline-player">🇵🇰 ${esc(tag)}</div>
          <div class="timeline-matches"><span class="muted">No sets found yet</span></div>
        </div>`;
    }

    const cards = playerSets.map(s => {
      const sid  = String(s.id);
      const proj = state.projected?.get(sid) || {};

      // Opponent: prefer projected slot data, fall back to actual slot
      const projOpp   = Object.values(proj).find(e => e && String(e.id) !== id);
      const actualOpp = s.slots?.find(sl => sl.entrant && String(sl.entrant.id) !== id)?.entrant;
      const opp       = projOpp || actualOpp || null;
      const oppId     = String(opp?.id || '');

      // For TBD opponent, look back one step in the bracket to show possible candidates
      let oppTag = opp?.name || null;
      if (!oppTag && bracketGraph) {
        // Find player's slot index so we can look at the OTHER slot
        const myActualIdx  = (s.slots || []).find(sl => sl.entrant && String(sl.entrant.id) === id)?.slotIndex;
        const myProjIdx    = Object.entries(proj).find(([, e]) => e && String(e.id) === id)?.[0];
        const myIdx        = myActualIdx ?? (myProjIdx !== undefined ? Number(myProjIdx) : -1);

        for (const sl of (s.slots || [])) {
          if (sl.entrant) continue;                        // already resolved
          if (myIdx !== -1 && sl.slotIndex === myIdx) continue; // skip player's own slot
          if (!sl.prereqId) continue;
          const feeder = bracketGraph.allSets.get(String(sl.prereqId));
          const names  = (feeder?.slots || []).map(fsl => fsl.entrant?.name).filter(Boolean).slice(0, 2);
          if (names.length) { oppTag = names.join(' · '); break; }
        }
      }
      oppTag = oppTag || 'TBD';

      // Is player here only via override propagation (not in actual slot yet)?
      const inActual   = (s.slots || []).some(sl => sl.entrant && String(sl.entrant.id) === id);
      const isProjected = !inActual && Object.values(proj).some(e => e && String(e.id) === id);

      const result   = resolveResult(sid, s.completedAt, s.winnerId, id);
      const poolName = s.phaseGroup?.displayIdentifier ? `Pool ${s.phaseGroup.displayIdentifier}` : '';
      const time     = fmtTime(s.startAt || s.completedAt);

      return `
        <div class="match-card${isProjected ? ' is-projected' : ''}"
             data-result="${result}"
             data-set-id="${sid}"
             data-my-id="${id}"
             data-opp-id="${esc(oppId)}"
             data-my-tag="${esc(tag)}"
             data-opp-tag="${esc(oppTag)}">
          <div class="match-round">${esc(s.fullRoundText || `Rd ${s.round}`)}</div>
          ${poolName ? `<div class="match-pool">${esc(poolName)}</div>` : ''}
          <div class="match-opponent">vs ${esc(oppTag)}</div>
          <div class="match-footer">
            <span class="match-time">${esc(time)}</span>
            <span class="result-pill result-${result}">${resultLabel[result] || '?'}</span>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="timeline-row">
        <div class="timeline-player">🇵🇰 ${esc(tag)}</div>
        <div class="timeline-matches">${cards}</div>
      </div>`;
  }).join('');

  // Show/hide reset button
  const hasOverrides = Object.keys(state.overrides).length > 0;
  document.getElementById('btn-reset-overrides').classList.toggle('hidden', !hasOverrides);
}

// ─── Render: collisions ───────────────────────────────────────────────────────
function renderCollisions() {
  const container = document.getElementById('collisions-container');

  // Re-compute collisions with current overrides applied (client-side)
  const collisions = findClientCollisions();

  if (!collisions.length) {
    container.innerHTML = '<p class="muted">No direct collisions detected in the current bracket.</p>';
    return;
  }

  container.innerHTML = `
    <div class="collisions-list">
      ${collisions.map(c => {
        const p1   = esc(c.players[0]?.name || '?');
        const p2   = esc(c.players[1]?.name || '?');
        const pool = c.phaseGroup?.displayIdentifier ? `· Pool ${c.phaseGroup.displayIdentifier}` : '';
        const time = fmtTime(c.startAt);
        const cls  = c.confirmed ? 'confirmed' : c.isProjected ? 'sim-projected' : 'projected';
        const statusLabel = c.confirmed ? '● Confirmed'
          : c.isProjected ? '◈ Simulated'
          : '◌ Projected';
        return `
          <div class="collision-node ${cls}">
            <div class="collision-players">🇵🇰 ${p1} vs 🇵🇰 ${p2}</div>
            <div class="collision-meta">${esc(c.roundLabel || `Round ${c.round}`)} ${esc(pool)}${time ? ` · ${time}` : ''}</div>
            <div class="collision-status">${statusLabel}</div>
          </div>`;
      }).join('')}
    </div>`;
}

// Client-side collision detection — uses projected slots when bracket graph available
function findClientCollisions() {
  const trackedSet = new Set(state.trackedIds.map(String));
  const collisions = [];
  const seen = new Set();

  const setsToCheck = bracketGraph
    ? Array.from(bracketGraph.allSets.values())
    : state.sets;

  for (const s of setsToCheck) {
    if (!s) continue;
    const sid = String(s.id);
    if (seen.has(sid)) continue;
    seen.add(sid);

    const proj = state.projected?.get(sid) || {};

    // Collect all entrants (actual + projected), deduplicated
    const entrantMap = new Map();
    for (const sl of (s.slots || [])) {
      if (sl.entrant) entrantMap.set(String(sl.entrant.id), sl.entrant);
    }
    for (const e of Object.values(proj)) {
      if (e) entrantMap.set(String(e.id), e);
    }

    const tracked = [...entrantMap.values()].filter(e => trackedSet.has(String(e.id)));
    if (tracked.length < 2) continue;

    const isProjected = tracked.some(e => {
      const inActual = (s.slots || []).some(sl => sl.entrant && String(sl.entrant.id) === String(e.id));
      return !inActual;
    });

    collisions.push({
      setId: s.id,
      round: s.round,
      roundLabel: s.fullRoundText,
      phaseGroup: s.phaseGroup,
      startAt: s.startAt,
      completedAt: s.completedAt,
      winnerId: s.winnerId,
      players: tracked,
      confirmed: !isProjected && (s.slots || []).every(sl => sl.entrant != null),
      isProjected,
    });
  }

  return collisions.sort((a, b) => (a.round || 0) - (b.round || 0));
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  const status  = document.getElementById('search-status');
  const container = document.getElementById('search-results');
  status.textContent = 'Searching…';
  container.innerHTML = '';
  try {
    const results = await apiSearch(q);
    status.textContent = results.length
      ? `${results.length} result${results.length !== 1 ? 's' : ''}`
      : 'No results found';
    renderSearchResults(results);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

function renderSearchResults(results) {
  const container = document.getElementById('search-results');
  const tracked = new Set(state.trackedIds.map(String));
  container.innerHTML = results.map(r => {
    const tag  = playerTag(r);
    const seed = r.seeds?.[0]?.seedNum;
    const isTracked = tracked.has(String(r.id));
    return `
      <div class="search-result-card">
        <div class="search-result-info">
          <div class="search-result-tag">${esc(tag)}</div>
          ${seed ? `<div class="search-result-seed">Seed #${seed}</div>` : ''}
        </div>
        <button class="btn-track" data-entrant-id="${r.id}" ${isTracked ? 'disabled' : ''}>
          ${isTracked ? 'Tracking' : '+ Track'}
        </button>
      </div>`;
  }).join('');
}

// ─── Override modal ───────────────────────────────────────────────────────────
let _pendingOverride = null;

function openOverrideModal(setId, myId, oppId, myTag, oppTag) {
  const set = state.sets.find(s => String(s.id) === String(setId))
           || bracketGraph?.allSets.get(String(setId));
  if (set?.completedAt) return;

  _pendingOverride = { setId: String(setId) };

  const btns = document.getElementById('modal-buttons');
  btns.innerHTML = '';
  const tracked = new Set(state.trackedIds.map(String));

  const makeBtn = (id, label) => {
    if (!id) return;
    const b = document.createElement('button');
    b.textContent = (tracked.has(String(id)) ? '🇵🇰 ' : '') + label;
    b.addEventListener('click', () => applyOverride(setId, id));
    btns.appendChild(b);
  };

  makeBtn(myId, myTag);
  if (oppId) makeBtn(oppId, oppTag);

  document.getElementById('override-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('override-modal').classList.add('hidden');
  _pendingOverride = null;
}

function applyOverride(setId, winnerId) {
  state.overrides[String(setId)] = String(winnerId);
  closeModal();
  recomputeProjected();
  renderTimelines();
  renderCollisions();
}

function clearOverride(setId) {
  if (setId) delete state.overrides[String(setId)];
  closeModal();
  recomputeProjected();
  renderTimelines();
  renderCollisions();
}

// ─── Load + render cycle ──────────────────────────────────────────────────────
async function loadData(bustCache = false) {
  setStatus('Loading…');
  try {
    if (bustCache) await apiRefresh();

    const data = await loadDashboard();
    state.event      = data.event;
    state.players    = data.players || [];
    state.sets       = data.sets || [];
    state.collisions = data.collisions || [];
    state.timelines  = data.timelines || {};
    state.trackedIds = data.trackedIds || [];
    state.brackets   = data.brackets || {};
    state.lastUpdated = new Date();

    bracketGraph = buildBracketGraph(state.brackets);
    recomputeProjected();

    // Update event meta in header
    const meta = document.getElementById('event-meta');
    if (state.event) {
      meta.textContent = `${state.event.name}  ·  ${state.event.numEntrants} entrants`;
    }

    renderPlayers();
    renderTimelines();
    renderCollisions();
    hideError();
    setStatus(`Updated ${state.lastUpdated.toLocaleTimeString()}`);
  } catch (err) {
    showError(err.message);
    setStatus('Error — see banner above', true);
  }
}

function setStatus(msg, isErr = false) {
  const el = document.getElementById('last-updated');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = `Error: ${msg}`;
  el.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

// HTML-escape to avoid XSS from API data
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Wire up events ───────────────────────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', () => loadData(true));

document.getElementById('auto-refresh').addEventListener('change', e => {
  clearInterval(state.refreshTimer);
  if (e.target.checked) {
    state.refreshTimer = setInterval(() => loadData(false), 60_000);
  }
});

document.getElementById('btn-reset-overrides').addEventListener('click', () => {
  state.overrides = {};
  renderTimelines();
  renderCollisions();
});

// Event delegation for match card clicks
document.getElementById('timelines-container').addEventListener('click', e => {
  const card = e.target.closest('.match-card');
  if (!card) return;
  const { setId, myId, oppId, myTag, oppTag } = card.dataset;
  openOverrideModal(setId, myId, oppId, myTag, oppTag);
});

document.getElementById('modal-backdrop').addEventListener('click', closeModal);

document.getElementById('modal-clear').addEventListener('click', () => {
  if (_pendingOverride) clearOverride(_pendingOverride.setId);
});

// Remove tracked player
document.getElementById('players-grid').addEventListener('click', e => {
  const btn = e.target.closest('.btn-remove');
  if (!btn) return;
  removeTracked(btn.dataset.entrantId);
});

// Track from search results
document.getElementById('search-results').addEventListener('click', e => {
  const btn = e.target.closest('.btn-track');
  if (!btn || btn.disabled) return;
  addTracked(btn.dataset.entrantId);
});

// Search input
document.getElementById('btn-search').addEventListener('click', doSearch);
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
syncFromStorage().then(() => loadData());
