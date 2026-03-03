const TOKEN_KEY = "domination-league-forum-token";

const currentUserEl = document.getElementById("home-current-user");
const logoutBtn = document.getElementById("home-logout-btn");

function getToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function loadCurrentUser() {
  const token = getToken();
  if (!token) {
    window.location.replace("login.html");
    return;
  }

  try {
    const response = await fetch("/api/forums/me", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error("Session expired");
    }

    const data = await response.json();
    currentUserEl.textContent = data.user?.username || "Unknown";
  } catch (error) {
    clearToken();
    window.location.replace("login.html");
  }
}

logoutBtn.addEventListener("click", async () => {
  const token = getToken();
  try {
    await fetch("/api/forums/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : ""
      },
      body: JSON.stringify({})
    });
  } catch (error) {
    // proceed with local logout
  }

  clearToken();
  window.location.replace("login.html");
});

loadCurrentUser();
