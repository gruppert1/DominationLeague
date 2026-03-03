const FORUM_TOKEN_KEY = "domination-league-forum-token";

function formatPoints(value) {
  return Number(value || 0).toFixed(2);
}

function formatWinPct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function authHeaders() {
  const token = window.localStorage.getItem(FORUM_TOKEN_KEY);
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function getVotePercentage(voteSummary, rosterId) {
  const counts = voteSummary?.counts || {};
  const voteValues = Object.values(counts).map((value) => Number(value || 0));
  const totalVotes = voteValues.reduce((sum, value) => sum + value, 0);
  if (totalVotes <= 0) {
    return 0;
  }

  const teamVotes = Number(counts[String(rosterId)] || 0);
  return (teamVotes / totalVotes) * 100;
}

async function submitVote(payload) {
  const response = await fetch("/api/matchups/vote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "Unable to submit vote.");
  }

  return data;
}

function buildTeamPanel(team, voteSummary, matchContext) {
  const panel = document.createElement("article");
  panel.className = "matchup-team";

  const title = document.createElement("h4");
  title.textContent = team.teamName;

  const manager = document.createElement("p");
  manager.className = "matchup-manager";
  manager.textContent = `Manager: ${team.managerName}`;

  const metrics = document.createElement("div");
  metrics.className = "matchup-metrics";

  const rows = [
    ["Projected", formatPoints(team.projectedPoints)],
    ["Current", formatPoints(team.currentPoints)],
    ["Vote %", formatWinPct(getVotePercentage(voteSummary, team.rosterId))]
  ];

  rows.forEach(([label, value]) => {
    const metric = document.createElement("div");
    metric.className = "matchup-metric";

    const metricLabel = document.createElement("p");
    metricLabel.className = "label";
    metricLabel.textContent = label;

    const metricValue = document.createElement("p");
    metricValue.className = "value";
    metricValue.textContent = value;

    metric.append(metricLabel, metricValue);
    metrics.append(metric);
  });

  const voteRow = document.createElement("div");
  voteRow.className = "vote-row";

  const voteButton = document.createElement("button");
  voteButton.type = "button";
  voteButton.className = "vote-btn";
  voteButton.textContent = "👍 Pick Winner";

  const count = Number(voteSummary?.counts?.[String(team.rosterId)] || 0);
  const voteCount = document.createElement("span");
  voteCount.className = "vote-count";
  voteCount.textContent = `${count} votes`;

  const selected = Number(voteSummary?.userVote || 0) === Number(team.rosterId);
  if (selected) {
    voteButton.classList.add("active");
  }

  voteButton.addEventListener("click", async () => {
    const currentlySelected = voteButton.classList.contains("active");
    const nextRosterId = currentlySelected ? 0 : team.rosterId;

    voteButton.disabled = true;
    try {
      const updated = await submitVote({
        season: matchContext.season,
        week: matchContext.week,
        matchupId: matchContext.matchupId,
        rosterId: nextRosterId
      });

      const updatedSummary = {
        counts: updated.counts || {},
        userVote: updated.userVote || null
      };
      matchContext.onVoteUpdate(matchContext.matchupId, updatedSummary);
    } catch (error) {
      const status = document.getElementById("matchups-status");
      status.textContent = `Vote failed: ${error.message}`;
    } finally {
      voteButton.disabled = false;
    }
  });

  voteRow.append(voteButton, voteCount);

  panel.append(title, manager, metrics, voteRow);
  return panel;
}

function renderMatchupCard(matchup, season, week, onVoteUpdate) {
  const card = document.createElement("section");
  card.className = "matchup-card panel";

  const header = document.createElement("div");
  header.className = "matchup-card-header";

  const heading = document.createElement("h3");
  heading.textContent = `Matchup ${matchup.matchupId}`;
  header.append(heading);

  const teamsWrap = document.createElement("div");
  teamsWrap.className = "matchup-teams";

  const [leftTeam, rightTeam] = matchup.teams;
  const context = {
    season,
    week,
    matchupId: matchup.matchupId,
    onVoteUpdate
  };

  if (leftTeam) {
    teamsWrap.append(buildTeamPanel(leftTeam, matchup.voteSummary, context));
  }

  if (rightTeam) {
    teamsWrap.append(buildTeamPanel(rightTeam, matchup.voteSummary, context));
  }

  card.append(header, teamsWrap);
  return card;
}

async function loadMatchups() {
  const status = document.getElementById("matchups-status");
  const grid = document.getElementById("matchups-grid");
  const weekFilter = document.getElementById("matchups-week-filter");
  const selectedWeek = weekFilter.value || "";

  try {
    const query = new URLSearchParams();
    if (selectedWeek) {
      query.set("week", selectedWeek);
    }
    const response = await fetch(`/api/matchups/current-week?${query.toString()}`, {
      headers: authHeaders()
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Could not load matchups.");
    }

    if (!weekFilter.options.length) {
      (data.availableWeeks || []).forEach((week) => {
        const option = document.createElement("option");
        option.value = String(week);
        option.textContent = `Week ${week}`;
        weekFilter.append(option);
      });
      weekFilter.value = String(data.week);
    } else if (selectedWeek && weekFilter.value !== selectedWeek) {
      weekFilter.value = selectedWeek;
    }

    if (!Array.isArray(data.matchups) || !data.matchups.length) {
      grid.innerHTML = "";
      status.textContent = `No matchups found for Week ${data.week}.`;
      return;
    }

    status.textContent = `Week ${data.week} matchups loaded (${data.count}).`;

    const state = {
      season: data.season,
      week: data.week,
      matchups: data.matchups
    };

    const rerender = () => {
      grid.innerHTML = "";
      state.matchups.forEach((matchup) => {
        grid.append(renderMatchupCard(matchup, state.season, state.week, onVoteUpdate));
      });
    };

    const onVoteUpdate = (matchupId, updatedSummary) => {
      const target = state.matchups.find((entry) => Number(entry.matchupId) === Number(matchupId));
      if (target) {
        target.voteSummary = updatedSummary;
      }
      rerender();
    };

    rerender();
  } catch (error) {
    status.textContent = `Unable to load matchups: ${error.message}`;
  }
}

document.getElementById("matchups-week-filter").addEventListener("change", loadMatchups);

loadMatchups();
