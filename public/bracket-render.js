'use strict';

class PoolBracketRenderer {
  constructor(bracket, trackedIds, poolName) {
    this.bracket = bracket || [];
    this.trackedIds = new Set((Array.isArray(trackedIds) ? trackedIds : []).map(String));
    this.poolName = poolName;
    this.boxWidth = 130;
    this.boxHeight = 45;
    this.colGap = 160;
    this.rowGap = 65;
    this.padding = 60;
  }

  separateBrackets() {
    const winners = [];
    const losers = [];

    for (const set of this.bracket) {
      const round = set.round || 0;
      if (round > 0) winners.push(set);
      else if (round < 0) losers.push(set);
    }

    return { winners, losers };
  }

  groupByRound(sets) {
    const rounds = {};
    for (const set of sets) {
      const round = Math.abs(set.round || 0);
      if (!rounds[round]) rounds[round] = [];
      rounds[round].push(set);
    }
    return rounds;
  }

  calculateLayout(sets) {
    const rounds = this.groupByRound(sets);
    const sortedRounds = Object.keys(rounds).map(Number).sort((a, b) => a - b);

    const layout = {};
    let colIndex = 0;

    for (const round of sortedRounds) {
      const roundSets = rounds[round];
      const maxInRound = roundSets.length;
      const roundHeight = maxInRound * this.rowGap + this.padding;

      layout[round] = {
        col: colIndex,
        x: this.padding + colIndex * this.colGap,
        sets: roundSets.map((set, idx) => ({
          set,
          y: this.padding + idx * this.rowGap,
          id: set.id
        }))
      };

      colIndex++;
    }

    return { layout, colIndex };
  }

  drawLines(svg, layout, sets) {
    let lines = '';

    for (const round in layout) {
      const roundData = layout[round];

      roundData.sets.forEach((matchData) => {
        const set = matchData.set;
        const currentX = roundData.x;
        const currentY = matchData.y + this.boxHeight / 2;

        // Draw lines to next round matches if they exist
        for (const nextSet of sets) {
          if (!nextSet.slots) continue;

          // Check if any slot in next match feeds from this match
          for (const slot of nextSet.slots) {
            if (slot.prereqId === String(set.id)) {
              const nextRound = Math.abs(nextSet.round || 0);
              const nextRoundData = layout[nextRound];

              if (nextRoundData) {
                const nextMatch = nextRoundData.sets.find(m => m.id === nextSet.id);
                if (nextMatch) {
                  const nextX = nextRoundData.x;
                  const nextY = nextMatch.y + this.boxHeight / 2;

                  // Green lines for advancement (winners bracket or within losers bracket)
                  const lineColor = 'var(--win)';

                  // Draw connecting line
                  const midX = (currentX + this.boxWidth + nextX) / 2;
                  lines += `<line x1="${currentX + this.boxWidth}" y1="${currentY}"
                                   x2="${midX}" y2="${currentY}"
                                   stroke="${lineColor}" stroke-width="2" opacity="0.6"/>`;
                  lines += `<line x1="${midX}" y1="${currentY}"
                                   x2="${midX}" y2="${nextY}"
                                   stroke="${lineColor}" stroke-width="2" opacity="0.6"/>`;
                  lines += `<line x1="${midX}" y1="${nextY}"
                                   x2="${nextX}" y2="${nextY}"
                                   stroke="${lineColor}" stroke-width="2" opacity="0.6"/>`;
                }
              }
            }
          }
        }
      });
    }

    return lines;
  }

  render() {
    const { winners, losers } = this.separateBrackets();

    let html = `<div class="bracket-wrapper">`;

    // Winners Bracket
    if (winners.length > 0) {
      html += this.renderBracketSection('Winners Bracket', winners, 'winners');
    }

    // Losers Bracket
    if (losers.length > 0) {
      html += this.renderBracketSection('Losers Bracket', losers, 'losers');
    }

    html += `</div>`;
    return html;
  }

  renderBracketSection(title, sets, type) {
    const { layout, colIndex } = this.calculateLayout(sets);
    const height = Math.max(...sets.map(s => (s.slots || []).length)) * this.rowGap + this.padding * 2;
    const width = (colIndex * this.colGap) + this.padding + 200;

    let html = `<div class="bracket-section">
      <h3 class="bracket-title">${title}</h3>
      <div class="bracket-canvas-container">
        <svg width="${width}" height="${height}" class="bracket-svg" style="min-width: 100%; overflow: visible;">`;

    // Draw connecting lines within this bracket section
    html += this.drawLines('<g>', layout, sets);

    // Draw matches
    for (const round in layout) {
      const roundData = layout[round];

      roundData.sets.forEach((matchData) => {
        const set = matchData.set;
        const x = roundData.x;
        const y = matchData.y;

        const p1 = set.slots?.[0]?.entrant;
        const p2 = set.slots?.[1]?.entrant;

        const p1Tracked = p1 && this.trackedIds.has(String(p1.id));
        const p2Tracked = p2 && this.trackedIds.has(String(p2.id));
        const hasTracked = p1Tracked || p2Tracked;

        // Match box
        html += `<rect x="${x}" y="${y}" width="${this.boxWidth}" height="${this.boxHeight}"
                 fill="${hasTracked ? 'rgba(255,98,0,0.12)' : 'var(--surface2)'}"
                 stroke="${hasTracked ? 'var(--accent)' : 'var(--border)'}"
                 stroke-width="${hasTracked ? '2' : '1'}" rx="3"/>`;

        // Player 1
        const p1Name = (p1 ? p1.name : 'TBD').substring(0, 13);
        const p1TextColor = p1Tracked ? 'var(--accent)' : 'var(--text)';
        html += `<text x="${x + 4}" y="${y + 15}" font-size="10" font-weight="600"
                 fill="${p1TextColor}" text-anchor="start">${this.esc(p1Name)}</text>`;

        // Result indicator for P1
        if (set.completedAt && set.winnerId && p1) {
          if (p1.id === set.winnerId) {
            html += `<circle cx="${x + this.boxWidth - 6}" cy="${y + 8}" r="3.5" fill="var(--win)"/>`;
          } else {
            html += `<circle cx="${x + this.boxWidth - 6}" cy="${y + 8}" r="3.5" fill="var(--loss)"/>`;
          }
        }

        // Player 2
        const p2Name = (p2 ? p2.name : 'TBD').substring(0, 13);
        const p2TextColor = p2Tracked ? 'var(--accent)' : 'var(--text)';
        html += `<text x="${x + 4}" y="${y + 32}" font-size="10" font-weight="600"
                 fill="${p2TextColor}" text-anchor="start">${this.esc(p2Name)}</text>`;

        // Result indicator for P2
        if (set.completedAt && set.winnerId && p2) {
          if (p2.id === set.winnerId) {
            html += `<circle cx="${x + this.boxWidth - 6}" cy="${y + 35}" r="3.5" fill="var(--win)"/>`;
          } else {
            html += `<circle cx="${x + this.boxWidth - 6}" cy="${y + 35}" r="3.5" fill="var(--loss)"/>`;
          }
        }
      });
    }

    html += `</svg></div></div>`;
    return html;
  }

  esc(str) {
    return (str || '').replace(/[<>&]/g, c => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;'
    }[c]));
  }
}

window.PoolBracketRenderer = PoolBracketRenderer;
