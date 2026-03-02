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

function avatarStorageKey(member) {
  return `domination-league-avatar-${member.rosterId}`;
}

function readUploadedAvatar(member) {
  try {
    return window.localStorage.getItem(avatarStorageKey(member));
  } catch (error) {
    return null;
  }
}

function writeUploadedAvatar(member, dataUrl) {
  try {
    window.localStorage.setItem(avatarStorageKey(member), dataUrl);
    return true;
  } catch (error) {
    return false;
  }
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

function setAvatarDisplay(avatarImg, avatarFallback, source) {
  if (source) {
    avatarImg.src = source;
    avatarImg.hidden = false;
    avatarFallback.hidden = true;
    return;
  }

  avatarImg.removeAttribute("src");
  avatarImg.hidden = true;
  avatarFallback.hidden = false;
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

  const managerInfo = document.createElement("div");
  managerInfo.className = "manager-info";

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "avatar-wrap";

  const avatarImg = document.createElement("img");
  avatarImg.className = "manager-avatar";
  avatarImg.alt = `${member.memberName} profile picture`;
  avatarImg.loading = "lazy";
  avatarImg.referrerPolicy = "no-referrer";
  avatarImg.hidden = true;

  const avatarFallback = document.createElement("div");
  avatarFallback.className = "manager-avatar manager-avatar-fallback";
  avatarFallback.textContent = getInitials(member.memberName);
  avatarFallback.hidden = false;

  avatarWrap.append(avatarImg, avatarFallback);

  const managerMeta = document.createElement("div");
  managerMeta.className = "manager-meta";

  const managerChip = document.createElement("span");
  managerChip.className = "chip";
  managerChip.textContent = `Manager: ${member.memberName}`;

  const uploadButton = document.createElement("button");
  uploadButton.className = "avatar-upload-btn";
  uploadButton.type = "button";
  uploadButton.textContent = "Upload Photo";

  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.accept = "image/*";
  uploadInput.className = "avatar-upload-input";
  uploadInput.hidden = true;

  const initialAvatar = readUploadedAvatar(member) || member.avatarUrl || null;
  setAvatarDisplay(avatarImg, avatarFallback, initialAvatar);

  avatarImg.addEventListener("error", () => {
    setAvatarDisplay(avatarImg, avatarFallback, readUploadedAvatar(member));
  });

  uploadButton.addEventListener("click", () => {
    uploadInput.click();
  });

  uploadInput.addEventListener("change", () => {
    const [file] = uploadInput.files || [];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        return;
      }

      const saved = writeUploadedAvatar(member, dataUrl);
      if (saved) {
        setAvatarDisplay(avatarImg, avatarFallback, dataUrl);
      }
    };
    reader.readAsDataURL(file);
  });

  managerMeta.append(managerChip, uploadButton, uploadInput);
  managerInfo.append(avatarWrap, managerMeta);

  header.append(teamName, managerInfo);

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
