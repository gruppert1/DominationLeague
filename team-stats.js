function formatPoints(value) {
  return Number(value || 0).toFixed(2);
}

function getInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) {
    return "?";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function createAvatarCell(managerName, avatarUrl) {
  const wrap = document.createElement("div");
  wrap.className = "table-manager";

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "avatar-wrap table-avatar-wrap";

  const avatarImg = document.createElement("img");
  avatarImg.className = "manager-avatar";
  avatarImg.alt = `${managerName} profile picture`;
  avatarImg.loading = "lazy";

  const fallback = document.createElement("div");
  fallback.className = "manager-avatar manager-avatar-fallback";
  fallback.textContent = getInitials(managerName);

  if (avatarUrl) {
    avatarImg.src = avatarUrl;
    avatarImg.addEventListener("error", () => {
      avatarImg.hidden = true;
      fallback.hidden = false;
    });
    fallback.hidden = true;
  } else {
    avatarImg.hidden = true;
    fallback.hidden = false;
  }

  avatarWrap.append(avatarImg, fallback);

  const managerNameEl = document.createElement("span");
  managerNameEl.textContent = managerName;

  wrap.append(avatarWrap, managerNameEl);
  return wrap;
}

function buildRow(team, index) {
  const tr = document.createElement("tr");

  const rank = document.createElement("td");
  rank.textContent = String(index + 1);

  const teamName = document.createElement("td");
  teamName.textContent = team.teamName;

  const manager = document.createElement("td");
  manager.append(createAvatarCell(team.managerName, team.avatarUrl));

  const division = document.createElement("td");
  division.textContent = team.divisionId ? `Division ${team.divisionId}` : "N/A";

  const leagueRecord = document.createElement("td");
  leagueRecord.textContent = team.leagueRecord;

  const divisionRecord = document.createElement("td");
  divisionRecord.textContent = team.divisionRecord || "N/A";

  const pf = document.createElement("td");
  pf.textContent = formatPoints(team.pointsScored);

  const pa = document.createElement("td");
  pa.textContent = formatPoints(team.pointsAgainst);

  tr.append(rank, teamName, manager, division, leagueRecord, divisionRecord, pf, pa);
  return tr;
}

async function loadTeamStats() {
  const statusEl = document.getElementById("team-stats-status");
  const bodyEl = document.getElementById("team-stats-body");

  try {
    const response = await fetch("/api/team-stats");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Could not load team stats.");
    }

    bodyEl.innerHTML = "";
    data.teams.forEach((team, index) => {
      bodyEl.append(buildRow(team, index));
    });

    statusEl.textContent = `Loaded ${data.count} teams for ${data.season}. Standings use points scored as tiebreaker.`;
  } catch (error) {
    statusEl.textContent = `Unable to load team stats: ${error.message}`;
  }
}

loadTeamStats();
