(function () {
  const TOKEN_KEY = "domination-league-forum-token";
  const PUBLIC_PAGES = new Set(["login.html", "blog.html"]);
  const currentPage = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();

  if (PUBLIC_PAGES.has(currentPage)) {
    return;
  }

  const token = window.localStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.replace(`login.html?next=${encodeURIComponent(window.location.pathname)}`);
    return;
  }

  fetch("/api/forums/me", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("Unauthorized");
      }
      return response.json();
    })
    .then((data) => {
      window.__FORUM_AUTH__ = {
        token,
        user: data.user || null
      };
    })
    .catch(() => {
      window.localStorage.removeItem(TOKEN_KEY);
      window.location.replace(`login.html?next=${encodeURIComponent(window.location.pathname)}`);
    });
})();
