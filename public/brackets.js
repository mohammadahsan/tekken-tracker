'use strict';

// ─── Visual constants ─────────────────────────────────────────────────────────
const CARD_W   = 200;
const CARD_H   = 54;
const SLOT_H   = CARD_H / 2;   // 27
const BADGE_W  = 24;
const SCORE_W  = 30;
const ROW_GAP  = 82;
const COL_STEP = 268;
const HEADER_H = 34;
const TOP_PAD  = 10;
const SEC_GAP  = 56;
const SLUG_KEY = 'tekken_event_slug';

// ─── Module state ─────────────────────────────────────────────────────────────
const state = {
  overrides:     {},         // { setId: winnerId }
  showProjected: true,
  pendingSetId:  null,
  trackedSet:    new Set(),
};

// pgId → { wrap, sets, trackedSet, zoomFns }
const pgRegistry = new Map();

// ─── Entry point ──────────────────────────────────────────────────────────────
async function init() {
  const statusEl  = document.getElementById('bracket-status');
  const container = document.getElementById('brackets-container');
  container.innerHTML = '';
  pgRegistry.clear();
  statusEl.textContent = 'Loading…';

  try {
    const data = await fetch('/api/dashboard').then(r => r.json());
    if (data.error) throw new Error(data.error);

    const { brackets, trackedIds, event } = data;

    if (event) {
      document.getElementById('event-meta').textContent =
        `${event.name}  ·  ${event.numEntrants} entrants`;
    }

    const status = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
    const slugEl = document.getElementById('slug-input');
    if (slugEl && status.eventSlug) slugEl.value = status.eventSlug;

    statusEl.textContent = '';
    state.trackedSet = new Set((trackedIds || []).map(String));

    if (!brackets || !Object.keys(brackets).length) {
      container.innerHTML =
        '<p class="muted">No active bracket data — brackets load for phase groups with upcoming sets.</p>';
      return;
    }

    for (const [pgId, sets] of Object.entries(brackets)) {
      if (!sets?.length) continue;
      buildPhaseGroup(container, pgId, sets, state.trackedSet);
    }
  } catch (err) {
    statusEl.textContent = '';
    const eb = document.getElementById('error-banner');
    eb.textContent = `Error: ${err.message}`;
    eb.classList.remove('hidden');
  }

  document.getElementById('last-updated').textContent =
    `Updated ${new Date().toLocaleTimeString()}`;
}

// ─── Phase group scaffold ─────────────────────────────────────────────────────
function buildPhaseGroup(container, pgId, sets, trackedSet) {
  const pg      = sets[0]?.phaseGroup;
  const pgLabel = pg?.displayIdentifier ? `Pool ${pg.displayIdentifier}` : `Group ${pgId}`;
  const phase   = pg?.phase?.name || '';
  const title   = phase ? `${phase} — ${pgLabel}` : pgLabel;

  const section = document.createElement('section');
  section.className = 'bracket-section';
  section.innerHTML = `
    <h2 class="section-label">${esc(title)}</h2>
    <p class="bracket-hint">Scroll to zoom · Drag to pan · Double-click to reset · Click any open match to override winner</p>
  `;

  const wrap = document.createElement('div');
  wrap.className = 'bracket-wrap';

  const zCtrl = document.createElement('div');
  zCtrl.className = 'bracket-zoom-controls';
  zCtrl.innerHTML = `
    <button id="zin-${pgId}">+</button>
    <button id="zout-${pgId}">−</button>
    <button id="zfit-${pgId}" title="Fit">⊡</button>
  `;
  wrap.appendChild(zCtrl);
  section.appendChild(wrap);
  container.appendChild(section);

  pgRegistry.set(pgId, { wrap, sets, trackedSet, zoomFns: null });

  // Delegate to current zoomFns so re-renders keep working
  document.getElementById(`zin-${pgId}`).onclick  = () => pgRegistry.get(pgId)?.zoomFns?.zoomBy(1.4);
  document.getElementById(`zout-${pgId}`).onclick = () => pgRegistry.get(pgId)?.zoomFns?.zoomBy(1 / 1.4);
  document.getElementById(`zfit-${pgId}`).onclick = () => pgRegistry.get(pgId)?.zoomFns?.fit();

  renderPG(pgId);
}

// ─── Render / re-render one phase group ───────────────────────────────────────
function renderPG(pgId) {
  const entry = pgRegistry.get(pgId);
  if (!entry) return;
  const { wrap, sets, trackedSet } = entry;

  const projected = state.showProjected
    ? computeProjected(sets, state.overrides)
    : new Map();

  const old = wrap.querySelector('.bracket-svg');
  if (old) old.remove();

  entry.zoomFns = drawBracket(wrap, sets, trackedSet, projected);
}

function rerenderAll() {
  for (const pgId of pgRegistry.keys()) renderPG(pgId);
  const hasOv = Object.keys(state.overrides).length > 0;
  document.getElementById('btn-reset-overrides')?.classList.toggle('hidden', !hasOv);
}

// ─── Projected entrant propagation ────────────────────────────────────────────
// Returns Map of `${setId}:${slotIdx}` → entrant for all propagated positions.
function computeProjected(sets, overrides) {
  const setMap = new Map(sets.map(s => [String(s.id), s]));
  const proj   = new Map();

  // Get the effective entrant in slot idx of a set (actual or already projected)
  function slotEnt(sid, idx) {
    const s  = setMap.get(sid);
    const sl = (s?.slots || []).find(sl => (sl.slotIndex ?? 0) === idx)
            || (s?.slots || [])[idx];
    return sl?.entrant || proj.get(`${sid}:${idx}`) || null;
  }

  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const set of sets) {
      const sid      = String(set.id);
      const winnerId = set.completedAt && set.winnerId
        ? String(set.winnerId)
        : overrides[sid] ? String(overrides[sid]) : null;
      if (!winnerId) continue;

      const e0 = slotEnt(sid, 0);
      const e1 = slotEnt(sid, 1);
      let winner = null, loser = null;
      if      (e0 && String(e0.id) === winnerId) { winner = e0; loser = e1; }
      else if (e1 && String(e1.id) === winnerId) { winner = e1; loser = e0; }
      if (!winner) continue;

      for (const next of sets) {
        for (const sl of (next.slots || [])) {
          if (String(sl.prereqId) !== sid) continue;
          const key = `${next.id}:${sl.slotIndex ?? 0}`;
          if (proj.has(key)) continue;
          // Detect loser feed structurally: winners bracket → losers bracket
          const isLoserFeed = sl.prereqType === 'loser'
            || ((set.round || 0) >= 0 && (next.round || 0) < 0);
          const ent = isLoserFeed ? loser : winner;
          if (ent) { proj.set(key, ent); changed = true; }
        }
      }
    }
    if (!changed) break;
  }

  return proj;
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function buildLayout(sets) {
  const setMap     = new Map(sets.map(s => [String(s.id), s]));
  const childrenOf = new Map(sets.map(s => [String(s.id), []]));
  const parentOf   = new Map();

  for (const set of sets) {
    const sid = String(set.id);
    for (const slot of (set.slots || [])) {
      if (!slot.prereqId) continue;
      const cid = String(slot.prereqId);
      if (!setMap.has(cid)) continue;
      if (!childrenOf.get(sid).includes(cid)) childrenOf.get(sid).push(cid);
      if (!parentOf.has(cid)) parentOf.set(cid, sid);
    }
  }

  const hasLosers = sets.some(s => (s.round || 0) < 0);
  const wSets = sets.filter(s => (s.round || 0) >= 0);
  const lSets = sets.filter(s => (s.round || 0) < 0);

  const wRnds  = [...new Set(wSets.map(s => s.round || 0))].sort((a, b) => a - b);
  const lRnds  = [...new Set(lSets.map(s => s.round))].sort((a, b) => b - a);
  const wColOf = new Map(wRnds.map((r, i) => [r, i]));
  const lColOf = new Map(lRnds.map((r, i) => [r, i]));

  const wLabel = new Map(), lLabel = new Map();
  for (const s of wSets) if (!wLabel.has(s.round||0)) wLabel.set(s.round||0, s.fullRoundText || `Round ${s.round}`);
  for (const s of lSets) if (!lLabel.has(s.round))    lLabel.set(s.round, s.fullRoundText || `Losers R${Math.abs(s.round)}`);

  function assignY(sectionSets) {
    const secIds = new Set(sectionSets.map(s => String(s.id)));
    const yPos = new Map();
    const vis  = new Set();
    let leaf   = 0;

    function dfs(id) {
      if (vis.has(id)) return [yPos.get(id) ?? 0, yPos.get(id) ?? 0];
      vis.add(id);
      const kids = (childrenOf.get(id) || []).filter(k => secIds.has(k));
      if (!kids.length) { yPos.set(id, leaf++); return [yPos.get(id), yPos.get(id)]; }
      let lo = Infinity, hi = -Infinity;
      for (const kid of kids) { const [a, b] = dfs(kid); lo = Math.min(lo,a); hi = Math.max(hi,b); }
      const y = (lo + hi) / 2;
      yPos.set(id, y);
      return [lo, hi];
    }

    const roots = sectionSets.filter(s => {
      const p = parentOf.get(String(s.id));
      return !p || !secIds.has(p);
    });
    for (const r of roots) dfs(String(r.id));
    for (const s of sectionSets) if (!yPos.has(String(s.id))) yPos.set(String(s.id), leaf++);
    return { yPos, leafCount: leaf };
  }

  const wL = assignY(wSets);
  const lL = hasLosers ? assignY(lSets) : null;

  return {
    hasLosers, setMap, childrenOf, parentOf,
    winners: { sets: wSets, rounds: wRnds, colOf: wColOf, labels: wLabel, ...wL },
    losers:  hasLosers ? { sets: lSets, rounds: lRnds, colOf: lColOf, labels: lLabel, ...lL } : null,
  };
}

// ─── D3 drawing ───────────────────────────────────────────────────────────────
function drawBracket(container, sets, trackedSet, projected) {
  const L = buildLayout(sets);
  const { winners, losers, hasLosers } = L;

  const wSecH = winners.leafCount * ROW_GAP + HEADER_H + TOP_PAD;
  const lSecH = losers ? losers.leafCount * ROW_GAP + HEADER_H + TOP_PAD : 0;
  const lOff  = wSecH + SEC_GAP;
  const cols  = Math.max(winners.rounds.length, losers ? losers.rounds.length : 0);
  const svgW  = cols * COL_STEP + CARD_W + 40;
  const svgH  = wSecH + (hasLosers ? SEC_GAP + lSecH : 0) + 24;

  const svg = d3.select(container)
    .append('svg').attr('width', svgW).attr('height', svgH).attr('class', 'bracket-svg');

  const zoom = d3.zoom()
    .scaleExtent([0.08, 8])
    .on('zoom', ev => g.attr('transform', ev.transform));
  svg.call(zoom);
  svg.on('dblclick.zoom', () => svg.transition().duration(350).call(zoom.transform, fitT()));

  const g      = svg.append('g');
  const edgesG = g.append('g');
  const labG   = g.append('g');
  const cardsG = g.append('g');

  // Convert set id to card-centre pixel coords
  function cc(sid) {
    const s = L.setMap.get(String(sid));
    if (!s) return null;
    const r = s.round || 0;
    if (r >= 0) return {
      x: (winners.colOf.get(r) ?? 0) * COL_STEP + CARD_W / 2,
      y: (winners.yPos.get(String(sid)) ?? 0) * ROW_GAP + HEADER_H + TOP_PAD,
    };
    return {
      x: (losers.colOf.get(r) ?? 0) * COL_STEP + CARD_W / 2,
      y: (losers.yPos.get(String(sid)) ?? 0) * ROW_GAP + HEADER_H + TOP_PAD + lOff,
    };
  }

  // ── Section markers ────────────────────────────────────────────────────────
  if (hasLosers) {
    for (const [txt, yo] of [['WINNERS BRACKET', 11], ['LOSERS BRACKET', lOff + 11]]) {
      labG.append('text').attr('x', 6).attr('y', yo)
        .attr('font-size', 7.5).attr('fill', '#2e2e46')
        .attr('font-family', 'Segoe UI, system-ui, sans-serif')
        .attr('font-weight', '700').attr('letter-spacing', '0.12em').text(txt);
    }
    labG.append('line')
      .attr('x1', 0).attr('y1', lOff - SEC_GAP / 2)
      .attr('x2', svgW).attr('y2', lOff - SEC_GAP / 2)
      .attr('stroke', '#1a1a28').attr('stroke-width', 1);
  }

  // ── Column headers ─────────────────────────────────────────────────────────
  const hdrTopW = hasLosers ? 20 : 0;
  for (const [rnd, col] of winners.colOf) {
    labG.append('text')
      .attr('x', col * COL_STEP + CARD_W / 2)
      .attr('y', hdrTopW + HEADER_H - 6)
      .attr('text-anchor', 'middle').attr('font-size', 9.5)
      .attr('fill', '#484868')
      .attr('font-family', 'Segoe UI, system-ui, sans-serif')
      .attr('letter-spacing', '0.02em')
      .text(winners.labels.get(rnd) || '');
  }
  if (losers) {
    for (const [rnd, col] of losers.colOf) {
      labG.append('text')
        .attr('x', col * COL_STEP + CARD_W / 2)
        .attr('y', lOff + HEADER_H - 6)
        .attr('text-anchor', 'middle').attr('font-size', 9.5)
        .attr('fill', '#484868')
        .attr('font-family', 'Segoe UI, system-ui, sans-serif')
        .attr('letter-spacing', '0.02em')
        .text(losers.labels.get(rnd) || '');
    }
  }

  // ── Connector edges ────────────────────────────────────────────────────────
  for (const set of sets) {
    const sid = String(set.id);
    const pc  = cc(sid);
    if (!pc) continue;

    for (const slot of (set.slots || [])) {
      if (!slot.prereqId) continue;
      const cid = String(slot.prereqId);
      const fc  = cc(cid);
      if (!fc) continue;

      const si    = slot.slotIndex ?? 0;
      const toX   = pc.x - CARD_W / 2;
      const toY   = pc.y - CARD_H / 2 + (si + 0.5) * SLOT_H;
      const fromX = fc.x + CARD_W / 2;
      const fromY = fc.y;
      const midX  = fromX + (toX - fromX) / 2;

      const cross = (set.round || 0) >= 0 && (L.setMap.get(cid)?.round || 0) < 0;

      edgesG.append('path')
        .attr('d', `M${fromX},${fromY} H${midX} V${toY} H${toX}`)
        .attr('fill', 'none')
        .attr('stroke', cross ? '#38385a' : '#252536')
        .attr('stroke-width', cross ? 1 : 1.5)
        .attr('stroke-dasharray', cross ? '5,3' : null)
        .attr('stroke-linecap', 'round');
    }
  }

  // ── Cards ─────────────────────────────────────────────────────────────────
  for (const set of sets) {
    const sid = String(set.id);
    const c   = cc(sid);
    if (!c) continue;
    drawCard(cardsG, set, c.x - CARD_W / 2, c.y - CARD_H / 2, trackedSet, projected, L.setMap);
  }

  // ── Initial fit ───────────────────────────────────────────────────────────
  const wW = container.clientWidth  || 900;
  const wH = container.clientHeight || 520;
  function fitT() {
    const sc = Math.min((wW - 16) / svgW, (wH - 16) / svgH, 1);
    return d3.zoomIdentity.translate((wW - svgW * sc) / 2, (wH - svgH * sc) / 2).scale(sc);
  }
  svg.call(zoom.transform, fitT());

  return {
    zoomBy: f => svg.transition().duration(220).call(zoom.scaleBy, f),
    fit:    () => svg.transition().duration(350).call(zoom.transform, fitT()),
  };
}

// ─── Match card ───────────────────────────────────────────────────────────────
function drawCard(g, set, x, y, trackedSet, projected, setMap) {
  const sid      = String(set.id);
  const hasOv    = !!state.overrides[sid];
  const complete = !!set.completedAt;

  const card = g.append('g').attr('transform', `translate(${x},${y})`);

  if (!complete) {
    card.style('cursor', 'pointer')
      .on('click', () => openPicker(set, projected, setMap));
  }

  // Background
  card.append('rect')
    .attr('width', CARD_W).attr('height', CARD_H).attr('rx', 4)
    .attr('fill', hasOv ? '#131320' : '#0f0f17')
    .attr('stroke', hasOv ? 'rgba(255,98,0,0.35)' : '#252536')
    .attr('stroke-width', hasOv ? 1.5 : 0.75);

  // Left identifier badge
  card.append('rect').attr('width', BADGE_W).attr('height', CARD_H).attr('rx', 4).attr('fill', '#0b0b12');
  card.append('rect').attr('x', BADGE_W/2).attr('width', BADGE_W/2).attr('height', CARD_H).attr('fill', '#0b0b12');

  const idTxt = set.identifier ? String(set.identifier) : '';
  if (idTxt) {
    card.append('text')
      .attr('x', BADGE_W / 2).attr('y', CARD_H / 2 + 4)
      .attr('text-anchor', 'middle')
      .attr('font-size', idTxt.length > 2 ? 7 : 9)
      .attr('fill', '#4a4a6a')
      .attr('font-family', 'Segoe UI, monospace, sans-serif')
      .attr('font-weight', '700')
      .text(idTxt);
  }

  // Row divider
  card.append('line')
    .attr('x1', BADGE_W).attr('y1', SLOT_H)
    .attr('x2', CARD_W - 1).attr('y2', SLOT_H)
    .attr('stroke', '#181826').attr('stroke-width', 0.75);

  const slots = set.slots || [];
  const slot0 = slots.find(s => s.slotIndex === 0) || slots[0] || null;
  const slot1 = slots.find(s => s.slotIndex === 1) || slots[1] || null;

  drawSlotRow(card, 0, slot0, set, trackedSet, projected, setMap);
  drawSlotRow(card, 1, slot1, set, trackedSet, projected, setMap);
}

// ─── Slot row ─────────────────────────────────────────────────────────────────
function drawSlotRow(card, idx, slot, set, trackedSet, projected, setMap) {
  const sid       = String(set.id);
  const rowY      = idx * SLOT_H;
  const projKey   = `${sid}:${idx}`;

  const actualEnt = slot?.entrant;
  const projEnt   = projected?.get(projKey) || null;
  const entrant   = actualEnt || (state.showProjected ? projEnt : null);
  const isProj    = !actualEnt && !!projEnt && state.showProjected;

  const eid     = String(entrant?.id || '');
  const tracked = eid && trackedSet.has(eid);

  const scoreVal        = slot?.standing?.stats?.score?.value;
  const isDQ            = scoreVal === -1;
  const isWinner        = entrant && set.completedAt && String(set.winnerId) === eid;
  const isLoser         = entrant && set.completedAt && !isWinner;
  const overrideWinnerId = !set.completedAt ? (state.overrides[sid] || null) : null;
  const isOverrideW     = !!(eid && overrideWinnerId && overrideWinnerId === eid);
  const isOverrideL     = !!(eid && overrideWinnerId && overrideWinnerId !== eid);

  // Left accent bar
  const barColor = (isWinner || isOverrideW) ? '#22c55e'
    : (isLoser || isOverrideL) ? '#ef4444'
    : tracked                  ? '#ff6200'
    : '#23233a';

  card.append('rect')
    .attr('x', BADGE_W).attr('y', rowY)
    .attr('width', 3).attr('height', SLOT_H)
    .attr('fill', barColor);

  if (tracked) {
    card.append('rect')
      .attr('x', BADGE_W + 3).attr('y', rowY)
      .attr('width', CARD_W - BADGE_W - 3 - SCORE_W).attr('height', SLOT_H)
      .attr('fill', 'rgba(255,98,0,0.07)');
  }

  // Name text
  let nameTxt, nameColor, fontStyle = 'normal', fontWeight = '400';

  if (entrant) {
    nameTxt    = truncate(entrant.name, 19);
    fontWeight = (isWinner || isOverrideW || tracked) ? '600' : '400';
    fontStyle  = isProj ? 'italic' : 'normal';
    nameColor  = tracked                    ? '#ff8330'
      : (isWinner || isOverrideW)           ? '#e8eaf6'
      : (isLoser  || isOverrideL)           ? '#484860'
      : isProj                              ? '#6868a0'
      : '#9090b8';
  } else {
    // TBD — show "winner of X" / "loser of X"
    nameTxt   = getTBDLabel(slot, setMap, set.round);
    nameColor = '#2e2e44';
    fontStyle = 'italic';
  }

  card.append('text')
    .attr('x', BADGE_W + 8)
    .attr('y', rowY + SLOT_H / 2 + 4.5)
    .attr('font-size', entrant ? 11.5 : 10.5)
    .attr('font-weight', fontWeight)
    .attr('font-style', fontStyle)
    .attr('fill', nameColor)
    .attr('font-family', 'Segoe UI, system-ui, sans-serif')
    .text(nameTxt);

  // Score / override / DQ badge
  let scoreTxt = '', scoreBg = 'transparent', scoreFill = '#505070';

  if (isDQ) {
    scoreTxt = 'DQ'; scoreBg = 'rgba(239,68,68,0.12)'; scoreFill = '#ef4444';
  } else if (set.completedAt && entrant && !isProj) {
    if (scoreVal !== null && scoreVal !== undefined && scoreVal !== -1) {
      scoreTxt  = String(Math.round(scoreVal));
      scoreBg   = isWinner ? 'rgba(34,197,94,0.15)' : 'rgba(60,60,90,0.25)';
      scoreFill = isWinner ? '#22c55e' : '#4a4a68';
    } else {
      scoreTxt  = '✓';
      scoreBg   = isWinner ? 'rgba(34,197,94,0.12)' : 'transparent';
      scoreFill = isWinner ? '#22c55e' : '#303048';
    }
  } else if (isOverrideW) {
    scoreTxt  = '✓';
    scoreBg   = 'rgba(34,197,94,0.12)';
    scoreFill = '#22c55e';
  } else if (isOverrideL) {
    scoreTxt  = 'L';
    scoreBg   = 'rgba(239,68,68,0.10)';
    scoreFill = '#6b6b8a';
  }

  if (scoreTxt) {
    const bx = CARD_W - SCORE_W + 1, by = rowY + 3, bw = SCORE_W - 3, bh = SLOT_H - 6;
    card.append('rect').attr('x', bx).attr('y', by).attr('width', bw).attr('height', bh).attr('rx', 3).attr('fill', scoreBg);
    card.append('text')
      .attr('x', bx + bw / 2).attr('y', rowY + SLOT_H / 2 + 4.5)
      .attr('text-anchor', 'middle')
      .attr('font-size', scoreTxt.length > 1 ? 8 : 10.5)
      .attr('font-weight', '700').attr('fill', scoreFill)
      .attr('font-family', 'Segoe UI, monospace, sans-serif')
      .text(scoreTxt);
  }
}

// ─── TBD label from prereq metadata ──────────────────────────────────────────
// A slot is a "loser feed" if prereqType says so, OR if the source set is in
// the winners bracket (round ≥ 0) and the destination set is in the losers
// bracket (round < 0) — start.gg doesn't always return prereqType='loser'.
function getTBDLabel(slot, setMap, currentRound) {
  if (!slot?.prereqId) return 'TBD';
  const feeder = setMap?.get(String(slot.prereqId));
  const ident  = feeder?.identifier;
  if (!ident) return 'TBD';
  const isLoserFeed = slot.prereqType === 'loser'
    || ((feeder.round || 0) >= 0 && (currentRound || 0) < 0);
  return isLoserFeed ? `loser of ${ident}` : `winner of ${ident}`;
}

// ─── Override picker modal ────────────────────────────────────────────────────
function openPicker(set, projected, setMap) {
  const sid   = String(set.id);
  const slots = set.slots || [];

  function getEnt(slotIdx) {
    const sl = slots.find(s => (s.slotIndex ?? 0) === slotIdx) || slots[slotIdx];
    const actual = sl?.entrant;
    const proj   = projected?.get(`${sid}:${slotIdx}`);
    return actual || proj || null;
  }

  const e0 = getEnt(0);
  const e1 = getEnt(1);
  if (!e0 && !e1) return;

  state.pendingSetId = sid;

  const modal = document.getElementById('match-modal');
  const btns  = document.getElementById('match-modal-btns');
  btns.innerHTML = '';

  [e0, e1].filter(Boolean).forEach(ent => {
    const btn      = document.createElement('button');
    const flag     = state.trackedSet.has(String(ent.id)) ? '🇵🇰 ' : '';
    const isActive = state.overrides[sid] === String(ent.id);
    btn.textContent = flag + truncate(ent.name, 28);
    if (isActive) {
      btn.style.outline = '2px solid var(--accent)';
      btn.style.outlineOffset = '1px';
    }
    btn.addEventListener('click', () => {
      state.overrides[sid] = String(ent.id);
      closePickerModal();
      rerenderAll();
    });
    btns.appendChild(btn);
  });

  modal.classList.remove('hidden');
}

function closePickerModal() {
  document.getElementById('match-modal').classList.add('hidden');
  state.pendingSetId = null;
}

// ─── Event slug config ────────────────────────────────────────────────────────
async function applySlug(slug) {
  if (!slug?.trim()) return;
  try {
    const res  = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventSlug: slug.trim() }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    localStorage.setItem(SLUG_KEY, slug.trim());
    state.overrides = {};
    pgRegistry.clear();
    await init();
  } catch (err) {
    alert(`Failed to set slug: ${err.message}`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', async () => {
  try { await fetch('/api/refresh', { method: 'POST' }); } catch {}
  state.overrides = {};
  await init();
});

document.getElementById('btn-apply-slug')?.addEventListener('click', () =>
  applySlug(document.getElementById('slug-input')?.value)
);
document.getElementById('slug-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') applySlug(e.target.value);
});

document.getElementById('btn-reset-overrides')?.addEventListener('click', () => {
  state.overrides = {};
  rerenderAll();
});

document.getElementById('show-projected')?.addEventListener('change', e => {
  state.showProjected = e.target.checked;
  rerenderAll();
});

document.getElementById('modal-backdrop')?.addEventListener('click', closePickerModal);

document.getElementById('match-modal-clear')?.addEventListener('click', () => {
  if (state.pendingSetId) delete state.overrides[state.pendingSetId];
  closePickerModal();
  rerenderAll();
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closePickerModal(); });

const savedSlug = localStorage.getItem(SLUG_KEY);
if (savedSlug) {
  const inp = document.getElementById('slug-input');
  if (inp) inp.value = savedSlug;
}

document.addEventListener('DOMContentLoaded', init);
