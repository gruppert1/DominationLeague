function formatPoints(value) {
  const numericValue = Number(value || 0);
  return numericValue.toFixed(2);
}

function formatMetric(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }
  return Number(value).toFixed(2);
}

function formatHighestFinish(value, year) {
  if (value === null || value === undefined) {
    return "N/A";
  }
  if (year === null || year === undefined || Number(year) <= 0) {
    return String(value);
  }
  return `${value} (${year})`;
}

function formatFinishWithYear(value, year) {
  if (value === null || value === undefined) {
    return "N/A";
  }
  if (year === null || year === undefined || Number(year) <= 0) {
    return String(value);
  }
  return `${value} (${year})`;
}

function createStat(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "member-stat";

  const labelEl = document.createElement("p");
  labelEl.className = "label";
  labelEl.textContent = label;

  const valueEl = document.createElement("p");
  valueEl.className = "value";
  valueEl.textContent = value;

  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function renderMemberCard(member, currentSeason) {
  const card = document.createElement("article");
  card.className = "member-card panel";

  const header = document.createElement("header");
  header.className = "member-head";

  const teamName = document.createElement("h3");
  teamName.textContent = member.teamName;

  const managerChip = document.createElement("span");
  managerChip.className = "chip";
  managerChip.textContent = `Manager: ${member.memberName}`;

  header.append(teamName, managerChip);

  const allTimeRecord = member.allTimeRecord || member.record || "0-0";
  const currentRecord = member.currentSeasonRecord || member.record || "0-0";

  const stats = document.createElement("div");
  stats.className = "member-stats";
  stats.append(
    createStat("All Time Record", allTimeRecord),
    createStat(`${currentSeason} Record`, currentRecord),
    createStat("Highest Finish", formatHighestFinish(member.highestFinish, member.highestFinishYear)),
    createStat("Lowest Finish", formatFinishWithYear(member.lowestFinish, member.lowestFinishYear)),
    createStat("Average Finish", formatMetric(member.averageFinish)),
    createStat("All Time PPG", formatMetric(member.allTimePpg)),
    createStat("Points Scored", formatPoints(member.pointsScored)),
    createStat("Points Against", formatPoints(member.pointsAgainst))
  );

  card.append(header, stats);

  return card;
}

async function loadMembers() {
  const statusEl = document.getElementById("members-status");
  const gridEl = document.getElementById("members-grid");

  try {
    const response = await fetch("/api/members");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Could not load member data.");
    }

    statusEl.textContent = `Loaded ${data.count} member cards from Sleeper league ${data.leagueId}.`;

    if (!data.members.length) {
      statusEl.textContent = "No member data was returned for this league.";
      return;
    }

    data.members.forEach((member) => {
      gridEl.appendChild(renderMemberCard(member, data.currentSeason || "Current"));
    });
  } catch (error) {
    statusEl.textContent = `Unable to load members: ${error.message}`;
  }
}

loadMembers();
