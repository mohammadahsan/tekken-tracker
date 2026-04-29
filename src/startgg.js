'use strict';
require('dotenv').config();

const API_URL = 'https://api.start.gg/gql/alpha';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const _cache = new Map();

function _key(query, vars) {
  return JSON.stringify({ q: query.replace(/\s+/g, ' ').trim(), v: vars });
}

function _get(k) {
  const hit = _cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) { _cache.delete(k); return null; }
  return hit.d;
}

function _set(k, d) { _cache.set(k, { d, t: Date.now() }); }

async function gql(query, vars = {}) {
  const k = _key(query, vars);
  const hit = _get(k);
  if (hit !== null) return hit;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STARTGG_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: vars }),
  });

  if (res.status === 429) throw new Error('start.gg rate limit hit — wait a moment and retry');
  if (!res.ok) throw new Error(`start.gg HTTP ${res.status}: ${res.statusText}`);

  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));

  _set(k, json.data);
  return json.data;
}

async function allPages(fetcher) {
  const out = [];
  let page = 1;
  for (;;) {
    const result = await fetcher(page);
    if (!result?.nodes) break;
    out.push(...result.nodes);
    if (!result.nodes.length || page >= (result.pageInfo?.totalPages || 1)) break;
    page++;
  }
  return out;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const EVENT_QUERY = `
  query EventBySlug($slug: String!) {
    event(slug: $slug) {
      id
      name
      numEntrants
      phases {
        id
        name
        phaseGroups(query: { perPage: 100, page: 1 }) {
          nodes {
            id
            displayIdentifier
          }
        }
      }
    }
  }
`;

const ENTRANT_QUERY = `
  query EntrantById($id: ID!) {
    entrant(id: $id) {
      id
      name
      seeds {
        seedNum
        phaseGroup {
          id
          displayIdentifier
          phase { id name }
        }
      }
      participants {
        player {
          id
          gamerTag
        }
      }
    }
  }
`;

const PHASE_GROUP_BRACKET_QUERY = `
  query PhaseGroupBracket($id: ID!, $page: Int!, $perPage: Int!) {
    phaseGroup(id: $id) {
      id
      sets(page: $page, perPage: $perPage) {
        pageInfo { total totalPages }
        nodes {
          id
          identifier
          round
          fullRoundText
          completedAt
          startAt
          winnerId
          phaseGroup { id displayIdentifier phase { id name } }
          slots {
            slotIndex
            entrant { id name }
            prereqId
            prereqType
            standing {
              stats {
                score {
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const SEARCH_ENTRANTS_QUERY = `
  query SearchEntrants($eventId: ID!, $name: String!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      entrants(query: {
        page: $page
        perPage: $perPage
        filter: { name: $name }
      }) {
        pageInfo { total }
        nodes {
          id
          name
          participants { player { id gamerTag } }
          seeds { seedNum phaseGroup { displayIdentifier phase { name } } }
        }
      }
    }
  }
`;

const EVENT_SETS_QUERY = `
  query EventSets($eventId: ID!, $entrantIds: [ID], $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      sets(
        page: $page
        perPage: $perPage
        filters: { entrantIds: $entrantIds }
      ) {
        pageInfo { total totalPages }
        nodes {
          id
          round
          fullRoundText
          completedAt
          startAt
          winnerId
          phaseGroup {
            id
            displayIdentifier
            phase { id name }
          }
          slots {
            entrant {
              id
              name
            }
          }
        }
      }
    }
  }
`;

// ─── Public API ───────────────────────────────────────────────────────────────

async function getEvent(slug) {
  const data = await gql(EVENT_QUERY, { slug });
  return data.event;
}

async function getEntrant(id) {
  const data = await gql(ENTRANT_QUERY, { id: String(id) });
  return data.entrant;
}

async function getSetsForEntrants(eventId, entrantIds, perPage = 50) {
  return allPages(async (page) => {
    const data = await gql(EVENT_SETS_QUERY, {
      eventId: String(eventId),
      entrantIds: entrantIds.map(String),
      page,
      perPage,
    });
    return data.event.sets;
  });
}

async function getPhaseGroupBracket(phaseGroupId) {
  return allPages(async (page) => {
    const data = await gql(PHASE_GROUP_BRACKET_QUERY, {
      id: String(phaseGroupId),
      page,
      perPage: 50,
    });
    return data.phaseGroup?.sets;
  });
}

async function searchEntrants(eventId, name, perPage = 20) {
  const data = await gql(SEARCH_ENTRANTS_QUERY, {
    eventId: String(eventId),
    name,
    page: 1,
    perPage,
  });
  return data.event.entrants?.nodes || [];
}

function clearCache() { _cache.clear(); }

function cacheSize() { return _cache.size; }

module.exports = { getEvent, getEntrant, getSetsForEntrants, getPhaseGroupBracket, searchEntrants, clearCache, cacheSize };
