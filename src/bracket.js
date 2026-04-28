'use strict';

// Find sets where 2+ tracked players are directly matched against each other
function findDirectCollisions(sets, trackedIds) {
  const ids = new Set(trackedIds.map(String));
  const collisions = [];

  for (const set of sets) {
    if (!set.slots || set.slots.length < 2) continue;

    const trackedSlots = set.slots.filter(
      slot => slot.entrant && ids.has(String(slot.entrant.id))
    );

    if (trackedSlots.length >= 2) {
      collisions.push({
        setId: set.id,
        round: set.round,
        roundLabel: set.fullRoundText,
        phaseGroup: set.phaseGroup,
        startAt: set.startAt,
        completedAt: set.completedAt,
        winnerId: set.winnerId,
        players: trackedSlots.map(s => s.entrant),
        confirmed: set.slots.every(s => s.entrant != null),
      });
    }
  }

  return collisions.sort((a, b) => (a.round || 0) - (b.round || 0));
}

// Build per-player timeline: sorted list of sets with result annotation
function getPlayerTimeline(sets, entrantId) {
  const id = String(entrantId);

  return sets
    .filter(s => s.slots?.some(slot => slot.entrant && String(slot.entrant.id) === id))
    .sort((a, b) => {
      if (a.completedAt && b.completedAt) return a.completedAt - b.completedAt;
      if (a.startAt && b.startAt) return a.startAt - b.startAt;
      return (a.round || 0) - (b.round || 0);
    })
    .map(s => {
      const oppSlot = s.slots.find(slot => slot.entrant && String(slot.entrant.id) !== id);
      let result = 'tbd';
      if (s.completedAt) {
        result = String(s.winnerId) === id ? 'W' : 'L';
      }
      return {
        setId: s.id,
        round: s.round,
        roundLabel: s.fullRoundText,
        phaseGroup: s.phaseGroup,
        startAt: s.startAt,
        completedAt: s.completedAt,
        opponent: oppSlot?.entrant || null,
        winnerId: s.winnerId,
        result,
      };
    });
}

// Apply user overrides (setId -> winnerId) on top of real results.
// Returns a copy of sets with .simulatedWinnerId and .isOverridden flags set.
function simulateBracket(sets, overrides = {}) {
  return sets.map(s => {
    const override = overrides[String(s.id)];
    if (override !== undefined && !s.completedAt) {
      return { ...s, slots: s.slots?.map(sl => ({ ...sl })), simulatedWinnerId: String(override), isOverridden: true };
    }
    return s;
  });
}

// Effective winner for a set (override > completedAt > null)
function effectiveWinner(set, overrides = {}) {
  const override = overrides[String(set.id)];
  if (override !== undefined) return String(override);
  if (set.completedAt && set.winnerId) return String(set.winnerId);
  return null;
}

module.exports = { findDirectCollisions, getPlayerTimeline, simulateBracket, effectiveWinner };
