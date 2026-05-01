'use strict';

const STORAGE_KEY = 'tekken_tracked_ids';

const state = {
  event: null,
  players: [],
  sets: [],
  trackedIds: [],
  lastUpdated: null,
  refreshTimer: null,
};

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, opts);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

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

async function apiReset() {
  return apiFetch('/api/reset', { method: 'POST' });
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

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Get sets for a player, sorted by time
function getPlayerSets(playerId) {
  return state.sets
    .filter(s => s.slots?.some(sl => sl.entrant && String(sl.entrant.id) === String(playerId)))
    .sort((a, b) => {
      // Upcoming sets first, then completed
      const aComplete = a.completedAt;
      const bComplete = b.completedAt;
      if (!aComplete && bComplete) return -1;
      if (aComplete && !bComplete) return 1;
      // Sort by time
      const aTime = a.startAt || a.completedAt || 0;
      const bTime = b.startAt || b.completedAt || 0;
      return bTime - aTime;
    });
}

// Get opponent name from a set
function getOpponentName(set, playerId) {
  const myId = String(playerId);
  const opponent = (set.slots || []).find(sl => sl.entrant && String(sl.entrant.id) !== myId);
  return opponent?.entrant?.name || 'TBD';
}

// Check if a match is between two tracked players (collision)
function isCollision(set, trackedIds) {
  const trackedSet = new Set(trackedIds.map(String));
  const entrants = (set.slots || [])
    .filter(sl => sl.entrant)
    .map(sl => String(sl.entrant.id));
  return entrants.length === 2 && entrants.every(id => trackedSet.has(id));
}

// Check if match is in loser bracket
function isLoserBracket(set) {
  const round = set.round || 0;
  return round < 0;
}

// ─── Render ───────────────────────────────────────────────────────────────────
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

    return `
      <div class="player-card">
        ${canRemove ? `<button class="btn-remove" data-entrant-id="${p.id}" title="Remove">×</button>` : ''}
        <div class="player-tag">🇵🇰 ${esc(tag)}</div>
        <div class="badges">
          ${seed  ? `<span class="badge badge-seed">Seed #${seed}</span>` : ''}
          ${pool  ? `<span class="badge badge-pool">Pool ${esc(pool)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function getCompletedRounds(sets) {
  const completed = new Set();
  for (const s of sets) {
    if (s.completedAt && s.fullRoundText) {
      completed.add(s.fullRoundText);
    }
  }
  return Array.from(completed).sort();
}

function renderMatches() {
  const container = document.getElementById('matches-container');
  if (!state.players.length) {
    container.innerHTML = '<p class="muted">No players loaded.</p>';
    return;
  }

  // Get global completed rounds from all sets
  const globalCompletedRounds = getCompletedRounds(state.sets);

  container.innerHTML = state.players.map(player => {
    if (!player) return '';
    const id  = String(player.id);
    const tag = playerTag(player);
    const seed = player.seeds?.[0]?.seedNum;
    const pool = player.seeds?.[0]?.phaseGroup?.displayIdentifier;

    const playerSets = getPlayerSets(id);

    if (!playerSets.length) {
      return `
        <div class="player-row">
          <div class="player-info">
            <div class="player-name">🇵🇰 ${esc(tag)}</div>
            <div class="player-badges">
              ${seed ? `<span class="player-seed">Seed #${seed}</span>` : ''}
              ${pool ? `<span class="player-pool">Pool ${esc(pool)}</span>` : ''}
            </div>
          </div>
          <div class="matches-scroll">
            <p class="muted">No matches yet</p>
          </div>
        </div>`;
    }

    const upcomingSet = playerSets.find(s => !s.completedAt);
    const completedSets = playerSets.filter(s => s.completedAt);

    let matchesHtml = '';

    // Show completed rounds status
    if (globalCompletedRounds.length > 0) {
      matchesHtml += `<div class="completed-rounds-bar">${globalCompletedRounds.map(r => `<span class="round-tag">${esc(r)} ✓</span>`).join('')}</div>`;
    }

    // Show match history cards
    if (completedSets.length > 0) {
      matchesHtml += completedSets.map(s => {
        const opponent = getOpponentName(s, id);
        const result = String(s.winnerId) === id ? 'W' : 'L';
        const phaseName = s.phaseGroup?.phase?.name || '';
        const roundText = s.fullRoundText || `Round ${s.round || '?'}`;
        const displayRound = phaseName ? `${phaseName} - ${roundText}` : roundText;
        const collision = isCollision(s, state.trackedIds);
        const loser = isLoserBracket(s);
        const badges = `${loser ? ' 🔴' : ''}${collision ? ' ⚔️' : ''}`;
        return `<div class="match-card history result-${result}${collision ? ' collision' : ''}${loser ? ' loser-bracket' : ''}"><div class="card-round">${esc(displayRound)}${badges}</div><div class="card-result">${result}</div><div class="card-opp">${esc(opponent)}</div></div>`;
      }).join('');
    }

    // Show next match card
    if (upcomingSet) {
      const opponent = getOpponentName(upcomingSet, id);
      const setPool = upcomingSet.phaseGroup?.displayIdentifier;
      const time = fmtTime(upcomingSet.startAt);
      const phaseName = upcomingSet.phaseGroup?.phase?.name || '';
      const roundText = upcomingSet.fullRoundText || `Round ${upcomingSet.round || '?'}`;
      const displayRound = phaseName ? `${phaseName} - ${roundText}` : roundText;
      const collision = isCollision(upcomingSet, state.trackedIds);
      const loser = isLoserBracket(upcomingSet);
      const badges = `${loser ? ' 🔴' : ''}${collision ? ' ⚔️' : ''}`;
      matchesHtml += `
        <div class="match-card next${collision ? ' collision' : ''}${loser ? ' loser-bracket' : ''}">
          <div class="card-label">NEXT</div>
          <div class="card-round">${esc(displayRound)}${badges}</div>
          <div class="card-vs">vs</div>
          <div class="card-opp"><strong>${esc(opponent)}</strong></div>
          ${collision ? '<div class="collision-badge">COLLISION</div>' : ''}
          ${setPool ? `<div class="card-pool">Pool ${esc(setPool)}</div>` : ''}
          <div class="card-time">${time || 'TBD'}</div>
        </div>`;
    }

    return `
      <div class="player-row">
        <div class="player-info">
          <div class="player-name">🇵🇰 ${esc(tag)}</div>
          <div class="player-badges">
            ${seed ? `<span class="player-seed">Seed #${seed}</span>` : ''}
            ${pool ? `<span class="player-pool">Pool ${esc(pool)}</span>` : ''}
          </div>
        </div>
        <div class="matches-scroll">${matchesHtml}</div>
      </div>`;
  }).join('');
}

function renderEventMeta() {
  const meta = document.getElementById('event-meta');
  if (!state.event) {
    meta.innerHTML = '';
    return;
  }
  const name = state.event.name || '';
  const start = state.event.startAt ? new Date(state.event.startAt * 1000).toLocaleDateString('en-US') : '';
  meta.innerHTML = `${esc(name)}${start ? ` · ${start}` : ''}`;
}

function renderLastUpdated() {
  const el = document.getElementById('last-updated');
  if (!state.lastUpdated) {
    el.innerHTML = '';
    return;
  }
  const ago = Math.round((Date.now() - state.lastUpdated) / 1000);
  el.textContent = ago < 60 ? `Updated ${ago}s ago` : `Updated ${Math.round(ago / 60)}m ago`;
}

async function render() {
  renderEventMeta();
  renderPlayers();
  renderMatches();
  renderLastUpdated();
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const data = await loadDashboard();
    state.event = data.event;
    state.players = data.players;
    state.sets = data.sets;
    state.trackedIds = data.trackedIds;
    state.lastUpdated = Date.now();
    await render();
  } catch (e) {
    showError(`Failed to load data: ${e.message}`);
  }
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 5000);
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function handleSearch() {
  const input = document.getElementById('search-input');
  const status = document.getElementById('search-status');
  const results = document.getElementById('search-results');
  const q = input.value.trim();

  if (!q) {
    results.innerHTML = '';
    status.innerHTML = '';
    return;
  }

  status.textContent = 'Searching…';
  results.innerHTML = '';

  try {
    const res = await apiSearch(q);
    status.innerHTML = '';
    if (!res.length) {
      results.innerHTML = '<p class="muted">No results found</p>';
      return;
    }
    results.innerHTML = res.map(e => {
      const tag = playerTag(e);
      const alreadyTracked = state.trackedIds.includes(e.id);
      return `
        <div class="search-result">
          <span>${esc(tag)}</span>
          <button class="btn-add-player" data-entrant-id="${e.id}" ${alreadyTracked ? 'disabled' : ''}>
            ${alreadyTracked ? 'Tracking' : 'Add'}
          </button>
        </div>`;
    }).join('');
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────
function setupListeners() {
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    await apiRefresh();
    await loadData();
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset to default players?')) return;
    localStorage.removeItem(STORAGE_KEY);
    await apiReset();
    await loadData();
  });

  document.getElementById('search-input').addEventListener('input', debounce(handleSearch, 300));

  document.getElementById('btn-search').addEventListener('click', handleSearch);

  document.addEventListener('click', e => {
    if (e.target.classList.contains('btn-remove')) {
      removeTracked(e.target.dataset.entrantId);
    }
    if (e.target.classList.contains('btn-add-player')) {
      addTracked(e.target.dataset.entrantId);
    }
  });

  const autoRefresh = document.getElementById('auto-refresh');
  autoRefresh.addEventListener('change', () => {
    if (autoRefresh.checked) {
      state.refreshTimer = setInterval(() => loadData(), 60000);
    } else {
      clearInterval(state.refreshTimer);
    }
  });
}

function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  setupListeners();
  await syncFromStorage();
  await loadData();
}

document.addEventListener('DOMContentLoaded', init);
