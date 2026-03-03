const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LEAGUE_ID = process.env.LEAGUE_ID;
const SLEEPER_BASE_URL = process.env.SLEEPER_BASE_URL || "https://api.sleeper.app/v1";
const SLEEPER_CDN_BASE_URL = process.env.SLEEPER_CDN_BASE_URL || "https://sleepercdn.com";
const HISTORICAL_LEAGUE_IDS = (process.env.HISTORICAL_LEAGUE_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const VOTES_DIR = path.join(__dirname, "data");
const VOTES_FILE = path.join(VOTES_DIR, "matchup-votes.json");
const FORUM_SESSION_TTL_HOURS = Number(process.env.FORUM_SESSION_TTL_HOURS || 720);
const FORUM_POSTER_USERNAME = "gaberupps";
const forumDbPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "domination_league",
  user: process.env.POSTGRES_USER || "domination_app",
  password: process.env.POSTGRES_PASSWORD || "domination_pass"
});

app.use(express.json());
app.use(express.static(__dirname));

function requireLeagueId(res) {
  if (!LEAGUE_ID) {
    res.status(500).json({
      error: "LEAGUE_ID is missing.",
      message: "Set LEAGUE_ID in your environment before calling this endpoint."
    });
    return false;
  }

  return true;
}

function getAuthTokenFromRequest(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function normalizeForumChannel(channel) {
  const normalized = String(channel || "").trim().toLowerCase();
  if (normalized === "announcements" || normalized === "weekly-reports") {
    return normalized;
  }
  return null;
}

function canForumUserPost(username) {
  return String(username || "").trim().toLowerCase() === FORUM_POSTER_USERNAME;
}

async function resolveForumSessionUser(req) {
  const token = getAuthTokenFromRequest(req);
  if (!token) {
    return null;
  }

  const query = `
    SELECT fu.id, fu.username
    FROM forum_sessions fs
    JOIN forum_users fu ON fu.id = fs.user_id
    WHERE fs.token = $1
      AND fs.expires_at > NOW()
    LIMIT 1;
  `;
  const { rows } = await forumDbPool.query(query, [token]);
  if (!rows.length) {
    return null;
  }
  return { token, user: rows[0] };
}

async function requireForumSessionUser(req, res) {
  try {
    const session = await resolveForumSessionUser(req);
    if (!session) {
      res.status(401).json({
        error: "Authentication required.",
        message: "Login with a forum account first."
      });
      return null;
    }
    return session;
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to validate session.",
      message: error.message
    });
    return null;
  }
}

function toPoints(whole, decimal) {
  const wholeNumber = Number(whole || 0);
  const decimalString = String(decimal || 0).padStart(2, "0");
  return Number(`${wholeNumber}.${decimalString}`);
}

function formatRecord(settings = {}) {
  const wins = Number(settings.wins || 0);
  const losses = Number(settings.losses || 0);
  const ties = Number(settings.ties || 0);

  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function formatRecordFromParts(wins = 0, losses = 0, ties = 0) {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function buildAvatarUrl(avatar) {
  if (!avatar) {
    return null;
  }

  const normalized = String(avatar).trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized;
  }

  return `${SLEEPER_CDN_BASE_URL}/avatars/${normalized}`;
}

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getTeamNameFromRoster(roster, user) {
  const rosterMeta = roster?.metadata || {};
  const userMeta = user?.metadata || {};
  return (
    rosterMeta.team_name ||
    userMeta.team_name ||
    user?.display_name ||
    `Team ${roster?.roster_id || "?"}`
  );
}

function extractProjection(matchupEntry) {
  if (!matchupEntry || typeof matchupEntry !== "object") {
    return 0;
  }

  const directProjection = [
    matchupEntry.projected_points,
    matchupEntry.points_projected,
    matchupEntry.proj_points
  ].find((value) => Number.isFinite(Number(value)));
  if (directProjection !== undefined) {
    return Number(directProjection);
  }

  if (Array.isArray(matchupEntry.starters_projected_points)) {
    return matchupEntry.starters_projected_points.reduce(
      (sum, value) => sum + toSafeNumber(value, 0),
      0
    );
  }

  if (matchupEntry.starters_projected_points && typeof matchupEntry.starters_projected_points === "object") {
    return Object.values(matchupEntry.starters_projected_points).reduce(
      (sum, value) => sum + toSafeNumber(value, 0),
      0
    );
  }

  return toSafeNumber(matchupEntry.points, 0);
}

async function readVotesStore() {
  try {
    const raw = await fs.readFile(VOTES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return { weeks: {} };
  } catch (error) {
    return { weeks: {} };
  }
}

async function writeVotesStore(store) {
  await fs.mkdir(VOTES_DIR, { recursive: true });
  await fs.writeFile(VOTES_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function ensureWeekBucket(store, season, week) {
  if (!store.weeks || typeof store.weeks !== "object") {
    store.weeks = {};
  }

  const key = `${season}-${week}`;
  if (!store.weeks[key] || typeof store.weeks[key] !== "object") {
    store.weeks[key] = { matchups: {} };
  }
  if (!store.weeks[key].matchups || typeof store.weeks[key].matchups !== "object") {
    store.weeks[key].matchups = {};
  }
  return store.weeks[key];
}

function summarizeMatchupVotes(weekBucket, matchupId, userId) {
  const matchupKey = String(matchupId);
  const matchupBucket = weekBucket?.matchups?.[matchupKey];
  const votesByUserId =
    matchupBucket && typeof matchupBucket.votesByUserId === "object"
      ? matchupBucket.votesByUserId
      : {};
  const legacyVotesByClient =
    matchupBucket && typeof matchupBucket.votesByClient === "object"
      ? matchupBucket.votesByClient
      : {};

  const counts = {};
  Object.values(votesByUserId).forEach((rosterId) => {
    const key = String(rosterId);
    counts[key] = (counts[key] || 0) + 1;
  });

  if (!Object.keys(counts).length) {
    Object.values(legacyVotesByClient).forEach((rosterId) => {
      const key = String(rosterId);
      counts[key] = (counts[key] || 0) + 1;
    });
  }

  const userVote = userId ? votesByUserId[String(userId)] || null : null;
  return { counts, userVote };
}

function formatWinLossTie(wins = 0, losses = 0, ties = 0) {
  const w = Number(wins || 0);
  const l = Number(losses || 0);
  const t = Number(ties || 0);
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function getDivisionId(roster) {
  const settingsDivision = Number(roster?.settings?.division);
  if (Number.isFinite(settingsDivision) && settingsDivision > 0) {
    return settingsDivision;
  }
  const metadataDivision = Number(roster?.metadata?.division);
  if (Number.isFinite(metadataDivision) && metadataDivision > 0) {
    return metadataDivision;
  }
  return null;
}

function addRecordResult(recordBucket, outcome) {
  if (outcome === "W") {
    recordBucket.wins += 1;
  } else if (outcome === "L") {
    recordBucket.losses += 1;
  } else if (outcome === "T") {
    recordBucket.ties += 1;
  }
}

function getLeagueWeekContext(league, state) {
  const leagueSeason = String(league?.season || state?.season || new Date().getFullYear());
  const stateSeason = String(state?.season || "");
  const liveWeek = Math.max(1, Number(state?.week || 1));
  const playoffWeekStart = Number(league?.settings?.playoff_week_start || 18);
  const regularSeasonMaxWeek = Math.max(1, playoffWeekStart - 1);
  const isCurrentSeason = leagueSeason === stateSeason;

  const defaultWeek = isCurrentSeason ? Math.min(liveWeek, regularSeasonMaxWeek) : regularSeasonMaxWeek;
  const availableWeeks = Array.from({ length: regularSeasonMaxWeek }, (_, i) => i + 1);

  return {
    leagueSeason,
    stateSeason,
    isCurrentSeason,
    liveWeek,
    playoffWeekStart,
    regularSeasonMaxWeek,
    defaultWeek,
    availableWeeks
  };
}

function calculateBaselineFinishByRosterId(rosters = []) {
  const sortedRosters = [...rosters].sort((a, b) => {
    const aSettings = a.settings || {};
    const bSettings = b.settings || {};
    const winDiff = Number(bSettings.wins || 0) - Number(aSettings.wins || 0);
    if (winDiff !== 0) {
      return winDiff;
    }

    const fptsDiff =
      toPoints(bSettings.fpts, bSettings.fpts_decimal) -
      toPoints(aSettings.fpts, aSettings.fpts_decimal);
    if (fptsDiff !== 0) {
      return fptsDiff;
    }

    return Number(a.roster_id || 0) - Number(b.roster_id || 0);
  });

  const finishByRosterId = new Map();
  sortedRosters.forEach((roster, index) => {
    const rosterId = Number(roster.roster_id || 0);
    if (rosterId > 0) {
      finishByRosterId.set(rosterId, index + 1);
    }
  });

  return finishByRosterId;
}

function toOptionalNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function mergeMatchupResults(targetMap, matchups = []) {
  const groupedByMatchupId = new Map();
  matchups.forEach((entry) => {
    const matchupId = Number(entry.matchup_id || 0);
    if (!matchupId) {
      return;
    }

    const existing = groupedByMatchupId.get(matchupId) || [];
    existing.push(entry);
    groupedByMatchupId.set(matchupId, existing);
  });

  groupedByMatchupId.forEach((entries, matchupId) => {
    if (!entries.length) {
      return;
    }

    const normalized = entries
      .map((entry) => ({
        rosterId: Number(entry.roster_id || 0),
        points: Number(entry.points)
      }))
      .filter((entry) => entry.rosterId > 0 && Number.isFinite(entry.points));

    if (normalized.length < 2) {
      return;
    }

    normalized.sort((a, b) => b.points - a.points);
    if (normalized[0].points === normalized[1].points) {
      targetMap.set(matchupId, { winnerId: null, loserId: null });
      return;
    }

    targetMap.set(matchupId, {
      winnerId: normalized[0].rosterId,
      loserId: normalized[1].rosterId
    });
  });
}

async function fetchSleeperJsonOrNull(url) {
  try {
    return await fetchSleeperJson(url);
  } catch (error) {
    if (String(error.message || "").includes("status 404")) {
      return null;
    }
    throw error;
  }
}

function getResolvedBracketNodes(bracketNodes, matchupResultsById, bracketType) {
  return (Array.isArray(bracketNodes) ? bracketNodes : [])
    .map((node) => {
      const team1 = toOptionalNumber(node.t1);
      const team2 = toOptionalNumber(node.t2);
      const round = Number(node.r || 0);
      const matchupId = Number(node.m || 0);
      if (!team1 || !team2 || !round) {
        return null;
      }

      let winnerId = toOptionalNumber(node.w);
      let loserId = toOptionalNumber(node.l);
      const matchupResult = matchupResultsById.get(matchupId);

      if (!winnerId && matchupResult?.winnerId) {
        winnerId = matchupResult.winnerId;
      }
      if (!loserId && matchupResult?.loserId) {
        loserId = matchupResult.loserId;
      }

      if (winnerId && !loserId) {
        loserId = winnerId === team1 ? team2 : winnerId === team2 ? team1 : null;
      }
      if (loserId && !winnerId) {
        winnerId = loserId === team1 ? team2 : loserId === team2 ? team1 : null;
      }

      return {
        bracketType,
        round,
        team1,
        team2,
        winnerId: winnerId || null,
        loserId: loserId || null
      };
    })
    .filter(Boolean);
}

function findPlacementGame(resolvedNodes, teamA, teamB) {
  if (!teamA || !teamB) {
    return null;
  }

  return (
    resolvedNodes.find(
      (node) =>
        node.winnerId &&
        node.loserId &&
        ((node.team1 === teamA && node.team2 === teamB) ||
          (node.team1 === teamB && node.team2 === teamA))
    ) || null
  );
}

function assignPairPlacement(
  placementMap,
  candidates,
  betterPlace,
  worsePlace,
  resolvedNodes,
  baselineFinishByRosterId
) {
  if (!Array.isArray(candidates) || candidates.length !== 2) {
    return;
  }

  const [a, b] = candidates;
  const placementGame = findPlacementGame(resolvedNodes, a, b);
  if (placementGame?.winnerId && placementGame?.loserId) {
    placementMap.set(placementGame.winnerId, betterPlace);
    placementMap.set(placementGame.loserId, worsePlace);
    return;
  }

  const sorted = [...candidates].sort((left, right) => {
    const leftFinish = Number(baselineFinishByRosterId.get(left) || 9999);
    const rightFinish = Number(baselineFinishByRosterId.get(right) || 9999);
    return leftFinish - rightFinish;
  });
  placementMap.set(sorted[0], betterPlace);
  placementMap.set(sorted[1], worsePlace);
}

async function getPlayoffPlacementOverrides(leagueId, leagueData, baselineFinishByRosterId) {
  const playoffWeekStart = Number(
    leagueData?.settings?.playoff_week_start || leagueData?.playoff_week_start || 0
  );
  if (!playoffWeekStart) {
    return new Map();
  }

  const winnersBracket = await fetchSleeperJsonOrNull(
    `${SLEEPER_BASE_URL}/league/${leagueId}/winners_bracket`
  );
  const losersBracket = await fetchSleeperJsonOrNull(
    `${SLEEPER_BASE_URL}/league/${leagueId}/losers_bracket`
  );

  const matchupResultsById = new Map();
  for (let week = playoffWeekStart; week < playoffWeekStart + 7; week += 1) {
    const weekMatchups = await fetchSleeperJsonOrNull(
      `${SLEEPER_BASE_URL}/league/${leagueId}/matchups/${week}`
    );
    if (!Array.isArray(weekMatchups) || !weekMatchups.length) {
      continue;
    }
    mergeMatchupResults(matchupResultsById, weekMatchups);
  }

  const resolvedWinnerNodes = getResolvedBracketNodes(
    winnersBracket,
    matchupResultsById,
    "winners"
  );
  const resolvedLoserNodes = getResolvedBracketNodes(
    losersBracket,
    matchupResultsById,
    "losers"
  );
  const resolvedNodes = [...resolvedWinnerNodes, ...resolvedLoserNodes];

  if (!resolvedWinnerNodes.length) {
    return new Map();
  }

  const winnersParticipants = new Set();
  resolvedWinnerNodes.forEach((node) => {
    if (node.team1) {
      winnersParticipants.add(node.team1);
    }
    if (node.team2) {
      winnersParticipants.add(node.team2);
    }
  });

  const championshipRound = Math.max(...resolvedWinnerNodes.map((node) => node.round));
  const championshipNode =
    resolvedWinnerNodes.find(
      (node) => node.round === championshipRound && node.winnerId && node.loserId
    ) || resolvedWinnerNodes.find((node) => node.round === championshipRound);

  const placementOverrides = new Map();
  if (championshipNode?.winnerId) {
    placementOverrides.set(championshipNode.winnerId, 1);
  }
  if (championshipNode?.loserId) {
    placementOverrides.set(championshipNode.loserId, 2);
  }

  const semifinalRound = championshipRound - 1;
  const semifinalLosers = resolvedWinnerNodes
    .filter((node) => node.round === semifinalRound && node.loserId)
    .map((node) => node.loserId);

  assignPairPlacement(
    placementOverrides,
    semifinalLosers,
    3,
    4,
    resolvedNodes,
    baselineFinishByRosterId
  );

  const quarterfinalRound = semifinalRound - 1;
  const quarterfinalLosers = resolvedWinnerNodes
    .filter((node) => node.round === quarterfinalRound && node.loserId)
    .map((node) => node.loserId);

  assignPairPlacement(
    placementOverrides,
    quarterfinalLosers,
    5,
    6,
    resolvedNodes,
    baselineFinishByRosterId
  );

  // Ensure every championship-bracket participant receives a unique playoff finish.
  const unassignedParticipants = Array.from(winnersParticipants).filter(
    (rosterId) => !placementOverrides.has(rosterId)
  );
  if (unassignedParticipants.length) {
    const usedPlaces = new Set(Array.from(placementOverrides.values()));
    let nextPlace = 1;
    const sortedRemaining = unassignedParticipants.sort((left, right) => {
      const leftFinish = Number(baselineFinishByRosterId.get(left) || 9999);
      const rightFinish = Number(baselineFinishByRosterId.get(right) || 9999);
      return leftFinish - rightFinish;
    });

    sortedRemaining.forEach((rosterId) => {
      while (usedPlaces.has(nextPlace)) {
        nextPlace += 1;
      }
      placementOverrides.set(rosterId, nextPlace);
      usedPlaces.add(nextPlace);
    });
  }

  return placementOverrides;
}

function findHistoricalEntryForMember(entries, memberIdentityKeys) {
  const memberIdKeys = memberIdentityKeys.filter((key) => key.startsWith("id:"));

  if (memberIdKeys.length > 0) {
    const byIdMatch = entries.find((entry) =>
      entry.identityKeys.some((key) => memberIdKeys.includes(key))
    );
    if (byIdMatch) {
      return byIdMatch;
    }
  }

  const fallbackMatches = entries.filter((entry) =>
    entry.identityKeys.some((key) => memberIdentityKeys.includes(key))
  );
  if (fallbackMatches.length === 1) {
    return fallbackMatches[0];
  }
  return null;
}

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function getUserIdentityKeys(user = {}, explicitUserId) {
  const keys = new Set();
  const userId = explicitUserId || user.user_id;
  const username = normalizeIdentity(user.username);
  const displayName = normalizeIdentity(user.display_name);

  if (userId) {
    keys.add(`id:${userId}`);
  }
  if (username) {
    keys.add(`username:${username}`);
  }
  if (displayName) {
    keys.add(`display:${displayName}`);
  }

  return Array.from(keys);
}

async function getAutoHistoricalLeagueIds(league) {
  const previousLeagueIds = [];
  let cursorLeagueId = league.previous_league_id;

  while (cursorLeagueId) {
    previousLeagueIds.push(cursorLeagueId);
    const previousLeague = await fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${cursorLeagueId}`);
    cursorLeagueId = previousLeague.previous_league_id;
  }

  return previousLeagueIds;
}

async function fetchSleeperJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Sleeper request failed with status ${response.status}`);
  }

  return response.json();
}

app.post("/api/forums/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      res.status(400).json({
        error: "Invalid credentials payload.",
        message: "username and password are required."
      });
      return;
    }

    const userResult = await forumDbPool.query(
      `
        SELECT id, username, password_hash
        FROM forum_users
        WHERE LOWER(username) = LOWER($1)
        LIMIT 1;
      `,
      [username]
    );
    if (!userResult.rows.length) {
      res.status(401).json({ error: "Invalid username or password." });
      return;
    }

    const user = userResult.rows[0];
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      res.status(401).json({ error: "Invalid username or password." });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const ttlHours = Number.isFinite(FORUM_SESSION_TTL_HOURS) ? FORUM_SESSION_TTL_HOURS : 720;
    await forumDbPool.query(
      `
        INSERT INTO forum_sessions (token, user_id, expires_at)
        VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'));
      `,
      [token, user.id, ttlHours]
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        canPost: canForumUserPost(user.username)
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Login failed.",
      message: error.message
    });
  }
});

app.post("/api/forums/logout", async (req, res) => {
  try {
    const token = getAuthTokenFromRequest(req);
    if (token) {
      await forumDbPool.query("DELETE FROM forum_sessions WHERE token = $1;", [token]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Logout failed.",
      message: error.message
    });
  }
});

app.get("/api/forums/me", async (req, res) => {
  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  res.json({
    user: {
      ...session.user,
      canPost: canForumUserPost(session.user.username)
    }
  });
});

app.get("/api/forums/posts", async (req, res) => {
  try {
    const channel = normalizeForumChannel(req.query.channel || "announcements");
    if (!channel) {
      res.status(400).json({
        error: "Invalid channel.",
        message: "channel must be announcements or weekly-reports."
      });
      return;
    }

    const query = `
      SELECT
        fp.id,
        fp.channel,
        fp.title,
        fp.content,
        fp.created_at,
        fp.updated_at,
        fu.username AS author_username,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', fc.id,
              'content', fc.content,
              'createdAt', fc.created_at,
              'authorUsername', fcu.username
            )
            ORDER BY fc.created_at ASC
          ) FILTER (WHERE fc.id IS NOT NULL),
          '[]'::json
        ) AS comments
      FROM forum_posts fp
      JOIN forum_users fu ON fu.id = fp.author_user_id
      LEFT JOIN forum_comments fc ON fc.post_id = fp.id
      LEFT JOIN forum_users fcu ON fcu.id = fc.author_user_id
      WHERE fp.channel = $1
      GROUP BY fp.id, fu.username
      ORDER BY fp.created_at DESC;
    `;

    const { rows } = await forumDbPool.query(query, [channel]);
    const posts = rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      authorUsername: row.author_username,
      comments: Array.isArray(row.comments) ? row.comments : []
    }));

    res.json({ channel, count: posts.length, posts });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to load forum posts.",
      message: error.message
    });
  }
});

app.post("/api/forums/posts", async (req, res) => {
  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  try {
    if (!canForumUserPost(session.user.username)) {
      res.status(403).json({
        error: "Insufficient permissions.",
        message: `Only ${FORUM_POSTER_USERNAME} can create forum posts.`
      });
      return;
    }

    const channel = normalizeForumChannel(req.body?.channel);
    const title = String(req.body?.title || "").trim();
    const content = String(req.body?.content || "").trim();

    if (!channel || !title || !content) {
      res.status(400).json({
        error: "Invalid post payload.",
        message: "channel, title, and content are required."
      });
      return;
    }

    const insert = await forumDbPool.query(
      `
        INSERT INTO forum_posts (channel, title, content, author_user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id, channel, title, content, created_at, updated_at;
      `,
      [channel, title, content, session.user.id]
    );

    res.status(201).json({
      post: {
        id: insert.rows[0].id,
        channel: insert.rows[0].channel,
        title: insert.rows[0].title,
        content: insert.rows[0].content,
        createdAt: insert.rows[0].created_at,
        updatedAt: insert.rows[0].updated_at,
        authorUsername: session.user.username,
        comments: []
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to create forum post.",
      message: error.message
    });
  }
});

app.post("/api/forums/posts/:postId/comments", async (req, res) => {
  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  try {
    const postId = Number(req.params.postId || 0);
    const content = String(req.body?.content || "").trim();

    if (!postId || !content) {
      res.status(400).json({
        error: "Invalid comment payload.",
        message: "postId and content are required."
      });
      return;
    }

    const postCheck = await forumDbPool.query(
      "SELECT id FROM forum_posts WHERE id = $1 LIMIT 1;",
      [postId]
    );
    if (!postCheck.rows.length) {
      res.status(404).json({ error: "Post not found." });
      return;
    }

    const insert = await forumDbPool.query(
      `
        INSERT INTO forum_comments (post_id, content, author_user_id)
        VALUES ($1, $2, $3)
        RETURNING id, post_id, content, created_at, updated_at;
      `,
      [postId, content, session.user.id]
    );

    res.status(201).json({
      comment: {
        id: insert.rows[0].id,
        postId: insert.rows[0].post_id,
        content: insert.rows[0].content,
        createdAt: insert.rows[0].created_at,
        updatedAt: insert.rows[0].updated_at,
        authorUsername: session.user.username
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to create comment.",
      message: error.message
    });
  }
});

app.delete("/api/forums/posts/:postId", async (req, res) => {
  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  try {
    if (!canForumUserPost(session.user.username)) {
      res.status(403).json({
        error: "Insufficient permissions.",
        message: `Only ${FORUM_POSTER_USERNAME} can delete forum posts.`
      });
      return;
    }

    const postId = Number(req.params.postId || 0);
    if (!postId) {
      res.status(400).json({
        error: "Invalid post id.",
        message: "postId must be a positive integer."
      });
      return;
    }

    const del = await forumDbPool.query(
      `
        DELETE FROM forum_posts
        WHERE id = $1
        RETURNING id;
      `,
      [postId]
    );

    if (!del.rows.length) {
      res.status(404).json({ error: "Post not found." });
      return;
    }

    res.json({ success: true, deletedPostId: del.rows[0].id });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to delete forum post.",
      message: error.message
    });
  }
});

app.delete("/api/forums/comments/:commentId", async (req, res) => {
  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  try {
    if (!canForumUserPost(session.user.username)) {
      res.status(403).json({
        error: "Insufficient permissions.",
        message: `Only ${FORUM_POSTER_USERNAME} can delete forum comments.`
      });
      return;
    }

    const commentId = Number(req.params.commentId || 0);
    if (!commentId) {
      res.status(400).json({
        error: "Invalid comment id.",
        message: "commentId must be a positive integer."
      });
      return;
    }

    const del = await forumDbPool.query(
      `
        DELETE FROM forum_comments
        WHERE id = $1
        RETURNING id;
      `,
      [commentId]
    );

    if (!del.rows.length) {
      res.status(404).json({ error: "Comment not found." });
      return;
    }

    res.json({ success: true, deletedCommentId: del.rows[0].id });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to delete forum comment.",
      message: error.message
    });
  }
});

app.get("/api/matchups/current-week", async (req, res) => {
  if (!requireLeagueId(res)) {
    return;
  }

  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  try {
    const [league, users, rosters, state] = await Promise.all([
      fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}`),
      fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/users`),
      fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/rosters`),
      fetchSleeperJson(`${SLEEPER_BASE_URL}/state/nfl`)
    ]);

    const weekContext = getLeagueWeekContext(league, state);
    const season = weekContext.leagueSeason;
    const requestedWeek = Number(req.query.week || weekContext.defaultWeek);
    const week =
      Number.isFinite(requestedWeek) && requestedWeek > 0
        ? Math.min(Math.max(requestedWeek, 1), weekContext.regularSeasonMaxWeek)
        : weekContext.defaultWeek;
    const weeklyMatchups = await fetchSleeperJson(
      `${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/matchups/${week}`
    );

    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const rostersById = new Map(rosters.map((roster) => [Number(roster.roster_id), roster]));

    const groupedByMatchupId = new Map();
    weeklyMatchups.forEach((entry) => {
      const matchupId = Number(entry.matchup_id || 0);
      if (!matchupId) {
        return;
      }

      const existing = groupedByMatchupId.get(matchupId) || [];
      existing.push(entry);
      groupedByMatchupId.set(matchupId, existing);
    });

    const votesStore = await readVotesStore();
    const weekBucket = ensureWeekBucket(votesStore, season, week);

    const matchups = Array.from(groupedByMatchupId.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([matchupId, entries]) => {
        const teams = entries
          .map((entry) => {
            const rosterId = Number(entry.roster_id || 0);
            const roster = rostersById.get(rosterId) || {};
            const user = usersById.get(roster.owner_id) || {};
            return {
              rosterId,
              teamName: getTeamNameFromRoster(roster, user),
              managerName: user.display_name || user.username || "Unknown Manager",
              currentPoints: Number(toSafeNumber(entry.points, 0).toFixed(2)),
              projectedPoints: Number(extractProjection(entry).toFixed(2))
            };
          })
          .sort((left, right) => left.rosterId - right.rosterId);

        const voteSummary = summarizeMatchupVotes(weekBucket, matchupId, session.user.id);
        return {
          matchupId,
          teams,
          voteSummary
        };
      });

    res.json({
      leagueId: LEAGUE_ID,
      season,
      week,
      availableWeeks: weekContext.availableWeeks,
      count: matchups.length,
      matchups
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: "Failed to fetch current-week matchups.",
      message: error.message
    });
  }
});

app.post("/api/matchups/vote", async (req, res) => {
  if (!requireLeagueId(res)) {
    return;
  }

  const session = await requireForumSessionUser(req, res);
  if (!session) {
    return;
  }

  try {
    const season = String(req.body?.season || "").trim();
    const week = Number(req.body?.week || 0);
    const matchupId = Number(req.body?.matchupId || 0);
    const rosterId = Number(req.body?.rosterId || 0);

    if (!season || !week || !matchupId) {
      res.status(400).json({
        error: "Invalid vote payload.",
        message: "season, week, and matchupId are required."
      });
      return;
    }

    const store = await readVotesStore();
    const weekBucket = ensureWeekBucket(store, season, week);
    const matchupKey = String(matchupId);
    if (!weekBucket.matchups[matchupKey] || typeof weekBucket.matchups[matchupKey] !== "object") {
      weekBucket.matchups[matchupKey] = { votesByUserId: {} };
    }
    if (
      !weekBucket.matchups[matchupKey].votesByUserId ||
      typeof weekBucket.matchups[matchupKey].votesByUserId !== "object"
    ) {
      weekBucket.matchups[matchupKey].votesByUserId = {};
    }

    const voterKey = String(session.user.id);
    if (rosterId > 0) {
      weekBucket.matchups[matchupKey].votesByUserId[voterKey] = rosterId;
    } else {
      delete weekBucket.matchups[matchupKey].votesByUserId[voterKey];
    }

    await writeVotesStore(store);
    const summary = summarizeMatchupVotes(weekBucket, matchupId, session.user.id);
    res.json({
      matchupId,
      week,
      season,
      counts: summary.counts,
      userVote: summary.userVote
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to save vote.",
      message: error.message
    });
  }
});

app.get("/api/team-stats", async (req, res) => {
  if (!requireLeagueId(res)) {
    return;
  }

  try {
    const [league, users, rosters, state] = await Promise.all([
      fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}`),
      fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/users`),
      fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/rosters`),
      fetchSleeperJson(`${SLEEPER_BASE_URL}/state/nfl`)
    ]);

    const season = String(league.season || state.season || new Date().getFullYear());
    const currentWeek = Math.max(1, Number(state.week || 1));
    const playoffWeekStart = Number(league?.settings?.playoff_week_start || 18);
    const completedRegularSeasonWeek = Math.max(
      0,
      Math.min(currentWeek - 1, playoffWeekStart - 1)
    );

    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const divisionRecordByRosterId = new Map(
      rosters.map((roster) => [Number(roster.roster_id), { wins: 0, losses: 0, ties: 0 }])
    );
    const divisionByRosterId = new Map(
      rosters.map((roster) => [Number(roster.roster_id), getDivisionId(roster)])
    );

    for (let week = 1; week <= completedRegularSeasonWeek; week += 1) {
      const weekMatchups = await fetchSleeperJson(
        `${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/matchups/${week}`
      );
      const groupedByMatchupId = new Map();
      weekMatchups.forEach((entry) => {
        const matchupId = Number(entry.matchup_id || 0);
        if (!matchupId) {
          return;
        }
        const existing = groupedByMatchupId.get(matchupId) || [];
        existing.push(entry);
        groupedByMatchupId.set(matchupId, existing);
      });

      groupedByMatchupId.forEach((entries) => {
        if (entries.length !== 2) {
          return;
        }

        const left = entries[0];
        const right = entries[1];
        const leftRosterId = Number(left.roster_id || 0);
        const rightRosterId = Number(right.roster_id || 0);
        if (!leftRosterId || !rightRosterId) {
          return;
        }

        const leftDivision = divisionByRosterId.get(leftRosterId);
        const rightDivision = divisionByRosterId.get(rightRosterId);
        if (!leftDivision || !rightDivision || leftDivision !== rightDivision) {
          return;
        }

        const leftPoints = Number(left.points);
        const rightPoints = Number(right.points);
        if (!Number.isFinite(leftPoints) || !Number.isFinite(rightPoints)) {
          return;
        }

        const leftRecord = divisionRecordByRosterId.get(leftRosterId);
        const rightRecord = divisionRecordByRosterId.get(rightRosterId);
        if (!leftRecord || !rightRecord) {
          return;
        }

        if (leftPoints > rightPoints) {
          addRecordResult(leftRecord, "W");
          addRecordResult(rightRecord, "L");
        } else if (leftPoints < rightPoints) {
          addRecordResult(leftRecord, "L");
          addRecordResult(rightRecord, "W");
        } else {
          addRecordResult(leftRecord, "T");
          addRecordResult(rightRecord, "T");
        }
      });
    }

    const teams = rosters
      .map((roster) => {
        const rosterId = Number(roster.roster_id || 0);
        const user = usersById.get(roster.owner_id) || {};
        const settings = roster.settings || {};
        const divisionId = getDivisionId(roster);
        const divisionRecord = divisionRecordByRosterId.get(rosterId) || {
          wins: 0,
          losses: 0,
          ties: 0
        };

        const leagueWins = Number(settings.wins || 0);
        const leagueLosses = Number(settings.losses || 0);
        const leagueTies = Number(settings.ties || 0);
        const pointsScored = toPoints(settings.fpts, settings.fpts_decimal);
        const pointsAgainst = toPoints(settings.fpts_against, settings.fpts_against_decimal);

        return {
          rosterId,
          teamName: getTeamNameFromRoster(roster, user),
          managerName: user.display_name || user.username || "Unknown Manager",
          avatarUrl: buildAvatarUrl(user.avatar),
          divisionId,
          leagueRecord: formatWinLossTie(leagueWins, leagueLosses, leagueTies),
          divisionRecord: divisionId
            ? formatWinLossTie(divisionRecord.wins, divisionRecord.losses, divisionRecord.ties)
            : null,
          leagueWins,
          leagueLosses,
          leagueTies,
          pointsScored: Number(pointsScored.toFixed(2)),
          pointsAgainst: Number(pointsAgainst.toFixed(2))
        };
      })
      .sort((left, right) => {
        if (right.leagueWins !== left.leagueWins) {
          return right.leagueWins - left.leagueWins;
        }
        if (left.leagueLosses !== right.leagueLosses) {
          return left.leagueLosses - right.leagueLosses;
        }
        if (right.leagueTies !== left.leagueTies) {
          return right.leagueTies - left.leagueTies;
        }
        if (right.pointsScored !== left.pointsScored) {
          return right.pointsScored - left.pointsScored;
        }
        return left.teamName.localeCompare(right.teamName);
      });

    res.json({
      leagueId: LEAGUE_ID,
      season,
      currentWeek,
      completedRegularSeasonWeek,
      count: teams.length,
      teams
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: "Failed to fetch team stats.",
      message: error.message
    });
  }
});

app.get("/api/members", async (req, res) => {
  if (!requireLeagueId(res)) {
    return;
  }

  try {
    const leagueUrl = `${SLEEPER_BASE_URL}/league/${LEAGUE_ID}`;
    const usersUrl = `${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/users`;
    const rostersUrl = `${SLEEPER_BASE_URL}/league/${LEAGUE_ID}/rosters`;

    const [league, users, rosters] = await Promise.all([
      fetchSleeperJson(leagueUrl),
      fetchSleeperJson(usersUrl),
      fetchSleeperJson(rostersUrl)
    ]);

    const usersById = new Map(users.map((user) => [user.user_id, user]));
    const currentSeason = String(league.season || new Date().getFullYear());
    const historicalLeagueIds =
      HISTORICAL_LEAGUE_IDS.length > 0
        ? HISTORICAL_LEAGUE_IDS
        : await getAutoHistoricalLeagueIds(league);

    const historicalLeagueSummaries = [];
    for (const historicalLeagueId of historicalLeagueIds) {
      const [historicalLeague, historicalUsers, historicalRosters] = await Promise.all([
        fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${historicalLeagueId}`),
        fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${historicalLeagueId}/users`),
        fetchSleeperJson(`${SLEEPER_BASE_URL}/league/${historicalLeagueId}/rosters`)
      ]);
      const historicalUsersById = new Map(
        historicalUsers.map((historicalUser) => [historicalUser.user_id, historicalUser])
      );
      const baselineFinishByRosterId = calculateBaselineFinishByRosterId(historicalRosters);
      const playoffPlacementOverrides = await getPlayoffPlacementOverrides(
        historicalLeagueId,
        historicalLeague,
        baselineFinishByRosterId
      );

      const seasonEntries = [];

      historicalRosters.forEach((historicalRoster) => {
        if (!historicalRoster.owner_id) {
          return;
        }

        const historicalUser = historicalUsersById.get(historicalRoster.owner_id) || {};
        const identityKeys = getUserIdentityKeys(historicalUser, historicalRoster.owner_id);
        const settings = historicalRoster.settings || {};
        const wins = Number(settings.wins || 0);
        const losses = Number(settings.losses || 0);
        const ties = Number(settings.ties || 0);
        const pointsScored = toPoints(settings.fpts, settings.fpts_decimal);
        const pointsAgainst = toPoints(settings.fpts_against, settings.fpts_against_decimal);
        const gamesPlayed = wins + losses + ties;
        const rosterId = Number(historicalRoster.roster_id || 0);
        const regularSeasonFinish = baselineFinishByRosterId.get(rosterId) || 0;
        const championshipFinish = playoffPlacementOverrides.get(rosterId) || null;

        seasonEntries.push({
          rosterId,
          season: Number(historicalLeague.season || 0),
          identityKeys,
          wins,
          losses,
          ties,
          pointsScored,
          pointsAgainst,
          gamesPlayed,
          regularSeasonFinish: Number(regularSeasonFinish || 0),
          championshipFinish: championshipFinish ? Number(championshipFinish) : null
        });
      });

      historicalLeagueSummaries.push(seasonEntries);
    }

    const members = rosters.map((roster) => {
      const user = usersById.get(roster.owner_id) || {};
      const rosterMeta = roster.metadata || {};
      const userMeta = user.metadata || {};
      const settings = roster.settings || {};
      const identityKeys = getUserIdentityKeys(user, roster.owner_id);
      const allTimeParts = { wins: 0, losses: 0, ties: 0 };
      const championshipFinishes = [];
      const regularSeasonFinishes = [];
      let allTimePointsScored = 0;
      let allTimePointsAgainst = 0;
      let allTimeGamesPlayed = 0;

      historicalLeagueSummaries.forEach((seasonEntries) => {
        const matchedEntry = findHistoricalEntryForMember(seasonEntries, identityKeys);
        if (!matchedEntry) {
          return;
        }

        allTimeParts.wins += matchedEntry.wins;
        allTimeParts.losses += matchedEntry.losses;
        allTimeParts.ties += matchedEntry.ties;
        allTimePointsScored += matchedEntry.pointsScored;
        allTimePointsAgainst += matchedEntry.pointsAgainst;
        allTimeGamesPlayed += matchedEntry.gamesPlayed;
        if (matchedEntry.championshipFinish && matchedEntry.championshipFinish > 0) {
          championshipFinishes.push({
            finish: matchedEntry.championshipFinish,
            season: Number(matchedEntry.season || 0)
          });
        }
        if (matchedEntry.regularSeasonFinish && matchedEntry.regularSeasonFinish > 0) {
          regularSeasonFinishes.push({
            finish: matchedEntry.regularSeasonFinish,
            season: Number(matchedEntry.season || 0)
          });
        }
      });

      const pointsScored = toPoints(settings.fpts, settings.fpts_decimal);
      const pointsAgainst = toPoints(settings.fpts_against, settings.fpts_against_decimal);
      const fullAllTimePointsScored = allTimePointsScored + pointsScored;
      const fullAllTimePointsAgainst = allTimePointsAgainst + pointsAgainst;
      const averageFinish =
        regularSeasonFinishes.length > 0
          ? regularSeasonFinishes.reduce((sum, value) => sum + value.finish, 0) /
            regularSeasonFinishes.length
          : null;
      const highestFinishEntry =
        championshipFinishes.length > 0
          ? [...championshipFinishes].sort((a, b) => {
              if (a.finish !== b.finish) {
                return a.finish - b.finish;
              }
              return b.season - a.season;
            })[0]
          : null;
      const lowestFinishEntry =
        regularSeasonFinishes.length > 0
          ? [...regularSeasonFinishes].sort((a, b) => {
              if (a.finish !== b.finish) {
                return b.finish - a.finish;
              }
              return b.season - a.season;
            })[0]
          : null;

      return {
        rosterId: roster.roster_id,
        userId: user.user_id || roster.owner_id || null,
        memberName: user.display_name || user.username || "Unknown Member",
        teamName:
          rosterMeta.team_name ||
          userMeta.team_name ||
          user.display_name ||
          `Team ${roster.roster_id}`,
        avatar: user.avatar || null,
        avatarUrl: buildAvatarUrl(user.avatar),
        allTimeRecord: formatRecordFromParts(
          allTimeParts.wins,
          allTimeParts.losses,
          allTimeParts.ties
        ),
        highestFinish: highestFinishEntry ? highestFinishEntry.finish : null,
        highestFinishYear: highestFinishEntry ? highestFinishEntry.season : null,
        lowestFinish: lowestFinishEntry ? lowestFinishEntry.finish : null,
        lowestFinishYear: lowestFinishEntry ? lowestFinishEntry.season : null,
        averageFinish: averageFinish !== null ? Number(averageFinish.toFixed(2)) : null,
        allTimePpg:
          allTimeGamesPlayed > 0
            ? Number((allTimePointsScored / allTimeGamesPlayed).toFixed(2))
            : null,
        currentSeasonRecord: formatRecord(settings),
        wins: Number(settings.wins || 0),
        losses: Number(settings.losses || 0),
        ties: Number(settings.ties || 0),
        pointsScored,
        pointsAgainst,
        allTimePointsScored: Number(fullAllTimePointsScored.toFixed(2)),
        allTimePointsAgainst: Number(fullAllTimePointsAgainst.toFixed(2))
      };
    });

    members.sort((a, b) => {
      if (b.wins !== a.wins) {
        return b.wins - a.wins;
      }
      return b.pointsScored - a.pointsScored;
    });

    res.json({
      leagueId: LEAGUE_ID,
      currentSeason,
      historicalLeagueIdsUsed: historicalLeagueIds,
      count: members.length,
      members
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: "Failed to fetch data from Sleeper API.",
      message: error.message
    });
  }
});

app.get("*", (req, res, next) => {
  const filePath = path.join(__dirname, req.path);
  res.sendFile(filePath, (err) => {
    if (err) {
      next();
    }
  });
});

app.listen(PORT, () => {
  console.log(`Domination Leauge server running at http://localhost:${PORT}`);
});
