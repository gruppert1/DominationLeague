const TOKEN_KEY = "domination-league-forum-token";
const form = document.getElementById("login-form");
const usernameEl = document.getElementById("login-username");
const passwordEl = document.getElementById("login-password");
const statusEl = document.getElementById("login-status");

const query = new URLSearchParams(window.location.search);
const nextPath = query.get("next") || "index.html";

async function checkExistingSession() {
  const token = window.localStorage.getItem(TOKEN_KEY);
  if (!token) {
    return;
  }

  const response = await fetch("/api/forums/me", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (response.ok) {
    window.location.replace(nextPath);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    return;
  }

  statusEl.textContent = "Signing in...";

  try {
    const response = await fetch("/api/forums/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || data.error || "Login failed.");
    }

    window.localStorage.setItem(TOKEN_KEY, data.token);
    window.location.replace(nextPath);
  } catch (error) {
    statusEl.textContent = `Login failed: ${error.message}`;
  }
});

checkExistingSession().catch(() => {
  // ignore preload errors
});
