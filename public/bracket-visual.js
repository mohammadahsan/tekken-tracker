'use strict';

class BracketVisualizer {
  constructor(allSets, trackedIds, players) {
    this.allSets = allSets;
    this.trackedIds = new Set(trackedIds.map(String));
    this.players = players;
    this.phaseOrder = ['Round1', 'Round2', 'Round3', 'Semifinals', 'Finals'];
  }

  getPhaseStats(phaseName) {
    const phaseSets = this.allSets.filter(s => s.phaseGroup?.phase?.name === phaseName);
    const pools = new Set(phaseSets.map(s => s.phaseGroup?.displayIdentifier));
    const allEntrants = new Set();
    phaseSets.forEach(s => {
      (s.slots || []).forEach(slot => {
        if (slot.entrant) allEntrants.add(slot.entrant.id);
      });
    });

    // Check if complete
    const complete = phaseSets.every(s => s.completedAt);

    // Get progression info
    let progression = '';
    if (phaseName === 'Round1') progression = '3/Pool to Round2';
    else if (phaseName === 'Round2') progression = '3/Pool to Round3';
    else if (phaseName === 'Round3') progression = '3/Pool to Semifinals';
    else if (phaseName === 'Semifinals') progression = '8/Pool to Finals';
    else if (phaseName === 'Finals') progression = 'Grand Finals';

    return {
      name: phaseName,
      pools: pools.size,
      entrants: allEntrants.size,
      progression,
      complete,
      poolList: Array.from(pools).sort()
    };
  }

  renderSummary(containerId) {
    const container = document.getElementById(containerId);
    const phases = this.phaseOrder
      .map(phase => this.getPhaseStats(phase))
      .filter(p => this.allSets.some(s => s.phaseGroup?.phase?.name === p.name));

    container.innerHTML = phases.map(phase => `
      <div class="phase-card" data-phase="${phase.name}">
        <div class="phase-header">
          <h3 class="phase-name">${phase.name}</h3>
          <span class="phase-badge ${phase.complete ? 'complete' : 'in-progress'}">
            ${phase.complete ? 'COMPLETE' : 'IN PROGRESS'}
          </span>
        </div>
        <div class="phase-stats">
          <div class="stat">
            <span class="stat-value">${phase.pools}</span>
            <span class="stat-label">POOLS</span>
          </div>
          <div class="stat">
            <span class="stat-value">DE</span>
            <span class="stat-label">TYPE</span>
          </div>
          <div class="stat">
            <span class="stat-value">${phase.entrants}</span>
            <span class="stat-label">ENTRANTS</span>
          </div>
          <div class="stat progression">
            <span class="stat-value">${phase.progression}</span>
            <span class="stat-label">PROGRESSION</span>
          </div>
        </div>
      </div>
    `).join('');

    // Add click handlers
    document.querySelectorAll('.phase-card').forEach(card => {
      card.addEventListener('click', async () => {
        const phase = card.dataset.phase;
        await this.showPhaseModal(phase);
      });
    });
  }

  async showPhaseModal(phaseName) {
    const phaseSets = this.allSets.filter(s => s.phaseGroup?.phase?.name === phaseName);
    const poolsWithTracked = new Set();
    const poolIds = new Map();

    phaseSets.forEach(s => {
      const hasTracked = (s.slots || []).some(slot =>
        slot.entrant && this.trackedIds.has(String(slot.entrant.id))
      );
      if (hasTracked) {
        poolsWithTracked.add(s.phaseGroup?.displayIdentifier);
        poolIds.set(s.phaseGroup?.displayIdentifier, s.phaseGroup?.id);
      }
    });

    // Build advancement map: playerId → next pool
    const phaseOrder = ['Round1', 'Round2', 'Round3', 'Semifinals', 'Finals'];
    const nextPhase = phaseOrder[phaseOrder.indexOf(phaseName) + 1];
    const advancementMap = new Map();

    if (nextPhase && this.players) {
      this.players.forEach(player => {
        const nextSeed = (player.seeds || []).find(s => s.phaseGroup?.phase?.name === nextPhase);
        if (nextSeed) {
          advancementMap.set(String(player.id), {
            pool: nextSeed.phaseGroup.displayIdentifier,
            phase: nextPhase
          });
        }
      });
    }

    const pools = Array.from(poolsWithTracked).sort();
    let html = `<h2 style="color: #ff6200; margin-bottom: 10px;">${phaseName} - Interactive Bracket</h2>`;
    html += `<div style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 15px;">✓ = Tracked player | Scroll to zoom, drag to pan</div>`;
    html += `<div id="pools-container" style="display: flex; flex-direction: column; gap: 40px;"></div>`;

    document.getElementById('match-detail-content').innerHTML = html;
    document.getElementById('match-detail-modal').classList.remove('hidden');

    // Render D3 bracket for each pool
    const poolsContainer = document.getElementById('pools-container');
    for (const poolName of pools) {
      const poolId = poolIds.get(poolName);
      try {
        const res = await fetch(`/api/pool/${poolId}`);
        const data = await res.json();

        const poolDiv = document.createElement('div');
        poolDiv.style.cssText = 'width: 100%;';

        const poolTitle = document.createElement('h3');
        poolTitle.style.cssText = 'color: #ff6200; margin-bottom: 10px; font-size: 1rem;';
        poolTitle.textContent = `${poolName}`;
        poolDiv.appendChild(poolTitle);

        const containerDiv = document.createElement('div');
        containerDiv.id = `d3-bracket-${poolId}`;
        containerDiv.style.cssText = 'width: 100%; height: 600px; background: #0f172a; border-radius: 8px; border: 1px solid #475569; overflow: hidden;';
        poolDiv.appendChild(containerDiv);

        poolsContainer.appendChild(poolDiv);

        this.renderD3Bracket(data.bracket, poolName, `d3-bracket-${poolId}`, phaseName, advancementMap);
      } catch (e) {
        const errorDiv = document.createElement('p');
        errorDiv.style.cssText = 'color: #ef4444;';
        errorDiv.textContent = `Failed to load ${poolName}: ${e.message}`;
        poolsContainer.appendChild(errorDiv);
      }
    }
  }

  renderD3Bracket(bracket, poolName, containerId, phaseName, advancementMap) {
    // Create D3 visualization
    const container = document.getElementById(containerId || 'd3-bracket-container');
    if (!container) return;

    // Calculate dimensions
    const winners = bracket.filter(s => (s.round || 0) > 0);
    const losers = bracket.filter(s => (s.round || 0) < 0);
    const boxWidth = 100;
    const boxHeight = 40;
    const colGap = 140;
    const rowGap = 60;
    const padding = 40;
    const sectionGap = 80;

    // Helper to group by round
    const groupByRound = (sets) => {
      const rounds = {};
      sets.forEach(s => {
        const round = Math.abs(s.round || 0);
        if (!rounds[round]) rounds[round] = [];
        rounds[round].push(s);
      });
      return rounds;
    };

    const winnerRounds = groupByRound(winners);
    const loserRounds = groupByRound(losers);
    const winnerMaxRows = Math.max(...Object.values(winnerRounds).map(r => r.length), 0);
    const loserMaxRows = Math.max(...Object.values(loserRounds).map(r => r.length), 0);

    const winnerHeight = winnerMaxRows * rowGap + padding + 60; // +60 for title
    const loserHeight = loserMaxRows * rowGap + padding + 60;

    const winnerCols = Math.max(...winners.map(s => Math.abs(s.round || 0)), 0);
    const loserCols = Math.max(...losers.map(s => Math.abs(s.round || 0)), 0);
    const maxCols = Math.max(winnerCols, loserCols);

    const width = maxCols * colGap + padding * 2 + 150; // +150 for advancement labels
    const height = winnerHeight + sectionGap + loserHeight + padding;

    // Clear and create SVG
    d3.select(container).html('');
    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('background', '#0f172a');

    // Add zoom behavior
    const g = svg.append('g');
    const zoom = d3.zoom()
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    svg.call(zoom);

    // Render matches
    this.renderD3Matches(g, bracket, boxWidth, boxHeight, padding, colGap, rowGap, winnerHeight, sectionGap, advancementMap);
  }

  renderD3Matches(g, bracket, boxWidth, boxHeight, padding, colGap, rowGap, winnerHeight, sectionGap, advancementMap) {
    const groupByRound = (sets) => {
      const rounds = {};
      sets.forEach(s => {
        const round = Math.abs(s.round || 0);
        if (!rounds[round]) rounds[round] = [];
        rounds[round].push(s);
      });
      return rounds;
    };

    const winners = bracket.filter(s => (s.round || 0) > 0);
    const losers = bracket.filter(s => (s.round || 0) < 0);

    // Create lookup maps for finding matches by ID
    const winnerMap = new Map();
    winners.forEach(w => winnerMap.set(String(w.id), w));
    const loserMap = new Map();
    losers.forEach(l => loserMap.set(String(l.id), l));

    const renderSection = (sets, offsetX, offsetY, isLoser) => {
      const rounds = groupByRound(sets);
      const sortedRounds = Object.keys(rounds).map(Number).sort((a, b) => a - b);

      let colIndex = 0;
      const layout = {};

      sortedRounds.forEach(round => {
        const roundMatches = rounds[round];
        layout[round] = {
          x: padding + offsetX + colIndex * colGap,
          matches: roundMatches.map((m, idx) => ({
            match: m,
            y: padding + offsetY + idx * rowGap,
            id: m.id
          }))
        };
        colIndex++;
      });

      // Draw lines
      const lines = [];
      sets.forEach(set => {
        (set.slots || []).forEach(slot => {
          if (!slot.prereqId) return;
          const prereq = sets.find(s => String(s.id) === slot.prereqId);
          if (!prereq) return;

          const curRound = Math.abs(set.round || 0);
          const preRound = Math.abs(prereq.round || 0);
          const curLayout = layout[curRound];
          const preLayout = layout[preRound];

          if (!curLayout || !preLayout) return;

          const curPos = curLayout.matches.find(m => m.id === set.id);
          const prePos = preLayout.matches.find(m => m.id === prereq.id);

          if (curPos && prePos) {
            lines.push({
              x1: preLayout.x + boxWidth,
              y1: prePos.y + boxHeight / 2,
              x2: curLayout.x,
              y2: curPos.y + boxHeight / 2
            });
          }
        });
      });

      // Render lines
      g.selectAll(`.line-${isLoser ? 'loser' : 'winner'}`)
        .data(lines)
        .enter()
        .append('path')
        .attr('class', `line-${isLoser ? 'loser' : 'winner'}`)
        .attr('d', d => {
          const mx = (d.x1 + d.x2) / 2;
          return `M ${d.x1} ${d.y1} L ${mx} ${d.y1} L ${mx} ${d.y2} L ${d.x2} ${d.y2}`;
        })
        .attr('stroke', isLoser ? '#ef4444' : '#22c55e')
        .attr('stroke-width', 2)
        .attr('fill', 'none')
        .attr('opacity', 0.6);

      // Return layout for cross-bracket line drawing
      return layout;

      // Render matches
      Object.entries(layout).forEach(([round, data]) => {
        data.matches.forEach(matchData => {
          const m = matchData.match;
          const p1 = m.slots?.[0]?.entrant;
          const p2 = m.slots?.[1]?.entrant;
          const p1Tracked = p1 && this.trackedIds.has(String(p1.id));
          const p2Tracked = p2 && this.trackedIds.has(String(p2.id));
          const hasTracked = p1Tracked || p2Tracked;

          const group = g.append('g')
            .attr('transform', `translate(${data.x}, ${matchData.y})`);

          group.append('rect')
            .attr('width', boxWidth)
            .attr('height', boxHeight)
            .attr('rx', 3)
            .attr('fill', hasTracked ? 'rgba(255,98,0,0.12)' : '#1e293b')
            .attr('stroke', hasTracked ? '#ff6200' : '#475569')
            .attr('stroke-width', hasTracked ? 2 : 1);

          group.append('text')
            .attr('x', 4)
            .attr('y', 14)
            .attr('font-size', 9)
            .attr('font-weight', 600)
            .attr('fill', p1Tracked ? '#ff6200' : '#e2e8f0')
            .text((p1?.name || 'TBD').substring(0, 11));

          group.append('text')
            .attr('x', 4)
            .attr('y', 30)
            .attr('font-size', 9)
            .attr('font-weight', 600)
            .attr('fill', p2Tracked ? '#ff6200' : '#e2e8f0')
            .text((p2?.name || 'TBD').substring(0, 11));

          // Result indicators
          if (m.completedAt && m.winnerId) {
            if (p1 && p1.id === m.winnerId) {
              group.append('circle').attr('cx', boxWidth - 6).attr('cy', 6).attr('r', 3).attr('fill', '#22c55e');
            } else if (p1) {
              group.append('circle').attr('cx', boxWidth - 6).attr('cy', 6).attr('r', 3).attr('fill', '#ef4444');
            }
            if (p2 && p2.id === m.winnerId) {
              group.append('circle').attr('cx', boxWidth - 6).attr('cy', 34).attr('r', 3).attr('fill', '#22c55e');
            } else if (p2) {
              group.append('circle').attr('cx', boxWidth - 6).attr('cy', 34).attr('r', 3).attr('fill', '#ef4444');
            }
          }
        });
      });

      // Add advancement labels for winners bracket
      if (!isLoser && advancementMap && advancementMap.size > 0) {
        const lastRound = Math.max(...sortedRounds);
        const lastRoundData = layout[lastRound];

        lastRoundData.matches.forEach(matchData => {
          const m = matchData.match;
          if (!m.completedAt || !m.winnerId) return;

          // Check if winner is tracked
          const winner = m.slots?.find(s => s.entrant?.id === m.winnerId)?.entrant;
          if (!winner || !this.trackedIds.has(String(winner.id))) return;

          const advancement = advancementMap.get(String(winner.id));
          if (!advancement) return;

          // Render arrow + pool label to the right of the match box
          const arrowX = lastRoundData.x + boxWidth + 8;
          const arrowY = matchData.y + boxHeight / 2;

          g.append('text')
            .attr('x', arrowX)
            .attr('y', arrowY + 4)
            .attr('font-size', 8)
            .attr('font-weight', 700)
            .attr('fill', '#ff6200')
            .text(`→ ${advancement.phase}: Pool ${advancement.pool}`);
        });
      }
    };

    let winnerLayout = {};
    let loserLayout = {};

    // Render winners bracket (top)
    if (winners.length > 0) {
      const title = g.append('text')
        .attr('x', padding)
        .attr('y', padding - 20)
        .attr('font-size', 14)
        .attr('font-weight', 600)
        .attr('fill', '#ff6200')
        .text('Winners Bracket');
      winnerLayout = renderSection.call(this, winners, 0, 0, false);
    }

    // Render losers bracket (bottom)
    if (losers.length > 0) {
      const loserOffsetY = winnerHeight + sectionGap;
      const title = g.append('text')
        .attr('x', padding)
        .attr('y', loserOffsetY - 20)
        .attr('font-size', 14)
        .attr('font-weight', 600)
        .attr('fill', '#ff6200')
        .text('Losers Bracket');
      loserLayout = renderSection.call(this, losers, 0, loserOffsetY, true);
    }

    // Draw cross-bracket lines (winners to losers)
    const crossLines = [];
    losers.forEach(loserSet => {
      (loserSet.slots || []).forEach(slot => {
        if (!slot.prereqId) return;
        const winnerSet = winnerMap.get(slot.prereqId);
        if (!winnerSet) return;

        const loserRound = Math.abs(loserSet.round || 0);
        const winnerRound = Math.abs(winnerSet.round || 0);

        const loserLayout_ = loserLayout[loserRound];
        const winnerLayout_ = winnerLayout[winnerRound];

        if (!loserLayout_ || !winnerLayout_) return;

        const loserPos = loserLayout_.matches.find(m => m.id === loserSet.id);
        const winnerPos = winnerLayout_.matches.find(m => m.id === winnerSet.id);

        if (loserPos && winnerPos) {
          crossLines.push({
            x1: winnerLayout_.x + boxWidth,
            y1: winnerPos.y + boxHeight / 2,
            x2: loserLayout_.x,
            y2: loserPos.y + boxHeight / 2
          });
        }
      });
    });

    // Render cross-bracket lines (in a distinctive color)
    g.selectAll('.line-cross')
      .data(crossLines)
      .enter()
      .append('path')
      .attr('class', 'line-cross')
      .attr('d', d => {
        const midX = (d.x1 + d.x2) / 2;
        const midY = (d.y1 + d.y2) / 2;
        return `M ${d.x1} ${d.y1} L ${midX} ${midY} L ${d.x2} ${d.y2}`;
      })
      .attr('stroke', '#f97316')
      .attr('stroke-width', 1.5)
      .attr('fill', 'none')
      .attr('opacity', 0.5)
      .attr('stroke-dasharray', '4,4');
  }

  renderPoolBracket(poolName, sets) {
    let html = `<div class="pool-section">
      <h3 class="pool-name">${poolName}</h3>
      <div class="pool-matches">`;

    for (const set of sets) {
      const p1 = set.slots?.[0]?.entrant;
      const p2 = set.slots?.[1]?.entrant;

      const p1Tracked = p1 && this.trackedIds.has(String(p1.id));
      const p2Tracked = p2 && this.trackedIds.has(String(p2.id));

      let result = '—';
      if (set.completedAt && set.winnerId) {
        if (p1 && p1.id === set.winnerId) result = 'W';
        else if (p2 && p2.id === set.winnerId) result = 'W';
        else result = 'L';
      }

      const time = set.startAt ? new Date(set.startAt * 1000).toLocaleString('en-US', {
        timeZone: 'Asia/Karachi',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }) : 'TBD';

      html += `
        <div class="pool-match ${p1Tracked || p2Tracked ? 'has-tracked' : ''}">
          <div class="match-slot ${p1Tracked ? 'tracked' : ''}">
            <span>${p1 ? this.esc(p1.name) : 'TBD'}</span>
            ${result !== '—' && p1Tracked ? `<span class="result">${result}</span>` : ''}
          </div>
          <div class="match-vs">VS</div>
          <div class="match-slot ${p2Tracked ? 'tracked' : ''}">
            <span>${p2 ? this.esc(p2.name) : 'TBD'}</span>
            ${result !== '—' && p2Tracked ? `<span class="result">${result}</span>` : ''}
          </div>
          <div class="match-time">${time}</div>
        </div>`;
    }

    html += `</div></div>`;
    return html;
  }

  esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.BracketVisualizer = BracketVisualizer;
