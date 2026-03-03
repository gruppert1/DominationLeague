const FORUM_TOKEN_KEY = "domination-league-forum-token";

const state = {
  channel: "announcements",
  token: null,
  user: null,
  posts: []
};

const el = {
  status: document.getElementById("forums-status"),
  posts: document.getElementById("forums-posts"),
  tabs: Array.from(document.querySelectorAll(".forum-tab")),
  currentUser: document.getElementById("forum-current-user"),
  postPermission: document.getElementById("forum-post-permission"),
  postForm: document.getElementById("forum-post-form"),
  postTitle: document.getElementById("forum-post-title"),
  postContent: document.getElementById("forum-post-content")
};

function setStatus(message) {
  el.status.textContent = message;
}

function saveToken(token) {
  try {
    if (token) {
      window.localStorage.setItem(FORUM_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(FORUM_TOKEN_KEY);
    }
  } catch (error) {
    // ignore storage failures
  }
}

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  return headers;
}

async function apiGet(url) {
  const response = await fetch(url, { headers: authHeaders() });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || "Request failed.");
  }
  return data;
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || "Request failed.");
  }
  return data;
}

async function apiDelete(url) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: authHeaders()
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || "Request failed.");
  }
  return data;
}

function canCurrentUserPost() {
  return state.user?.canPost === true;
}

function setAuthUi() {
  if (!state.user) {
    el.currentUser.textContent = "Unknown";
    el.postPermission.textContent = "";
    el.postForm.hidden = true;
    el.postForm.style.display = "none";
    return;
  }

  el.currentUser.textContent = state.user.username;

  if (canCurrentUserPost()) {
    el.postPermission.textContent = "Posting enabled for this account.";
    el.postForm.hidden = false;
    el.postForm.style.display = "grid";
  } else {
    el.postPermission.textContent =
      "Only gaberupps can create new posts. You can still comment on all posts.";
    el.postForm.hidden = true;
    el.postForm.style.display = "none";
  }
}

function activateTab(channel) {
  state.channel = channel;
  el.tabs.forEach((tab) => {
    const isActive = tab.dataset.forumTab === channel;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function createCommentItem(comment) {
  const item = document.createElement("li");
  item.className = "forum-comment-item";

  const metaRow = document.createElement("div");
  metaRow.className = "forum-item-meta-row";

  const meta = document.createElement("p");
  meta.className = "post-meta";
  meta.textContent = `${comment.authorUsername} • ${formatDate(comment.createdAt)}`;

  const content = document.createElement("p");
  content.textContent = comment.content;

  metaRow.append(meta);

  if (canCurrentUserPost()) {
    const deleteCommentBtn = document.createElement("button");
    deleteCommentBtn.type = "button";
    deleteCommentBtn.className = "forum-icon-btn";
    deleteCommentBtn.title = "Delete comment";
    deleteCommentBtn.setAttribute("aria-label", "Delete comment");
    deleteCommentBtn.textContent = "🗑";

    deleteCommentBtn.addEventListener("click", async () => {
      const confirmed = window.confirm("Delete this comment?");
      if (!confirmed) {
        return;
      }

      deleteCommentBtn.disabled = true;
      try {
        await apiDelete(`/api/forums/comments/${comment.id}`);
        await loadPosts();
        setStatus("Comment deleted.");
      } catch (error) {
        setStatus(`Unable to delete comment: ${error.message}`);
      } finally {
        deleteCommentBtn.disabled = false;
      }
    });

    metaRow.append(deleteCommentBtn);
  }

  item.append(metaRow, content);
  return item;
}

function buildPostElement(post) {
  const article = document.createElement("article");
  article.className = "forum-post";

  const titleRow = document.createElement("div");
  titleRow.className = "forum-item-title-row";

  const title = document.createElement("h3");
  title.textContent = post.title;
  titleRow.append(title);

  if (canCurrentUserPost()) {
    const deletePostBtn = document.createElement("button");
    deletePostBtn.type = "button";
    deletePostBtn.className = "forum-icon-btn";
    deletePostBtn.title = "Delete post";
    deletePostBtn.setAttribute("aria-label", "Delete post");
    deletePostBtn.textContent = "🗑";

    deletePostBtn.addEventListener("click", async () => {
      const confirmed = window.confirm("Delete this post and all of its comments?");
      if (!confirmed) {
        return;
      }

      deletePostBtn.disabled = true;
      try {
        await apiDelete(`/api/forums/posts/${post.id}`);
        await loadPosts();
        setStatus("Post deleted.");
      } catch (error) {
        setStatus(`Unable to delete post: ${error.message}`);
      } finally {
        deletePostBtn.disabled = false;
      }
    });

    titleRow.append(deletePostBtn);
  }

  const meta = document.createElement("p");
  meta.className = "post-meta";
  meta.textContent = `${post.authorUsername} • ${formatDate(post.createdAt)}`;

  const content = document.createElement("p");
  content.textContent = post.content;

  const commentList = document.createElement("ul");
  commentList.className = "forum-comments";
  (post.comments || []).forEach((comment) => {
    commentList.append(createCommentItem(comment));
  });

  const commentForm = document.createElement("form");
  commentForm.className = "forum-comment-form";

  const commentInput = document.createElement("textarea");
  commentInput.rows = 2;
  commentInput.placeholder = "Add a comment";
  commentInput.required = true;

  const commentSubmit = document.createElement("button");
  commentSubmit.type = "submit";
  commentSubmit.className = "forum-action-btn forum-secondary-btn";
  commentSubmit.textContent = "Post Comment";

  commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = commentInput.value.trim();
    if (!text) {
      return;
    }

    commentSubmit.disabled = true;
    try {
      await apiPost(`/api/forums/posts/${post.id}/comments`, { content: text });
      commentInput.value = "";
      await loadPosts();
      setStatus("Comment posted.");
    } catch (error) {
      setStatus(`Unable to post comment: ${error.message}`);
    } finally {
      commentSubmit.disabled = false;
    }
  });

  commentForm.append(commentInput, commentSubmit);

  article.append(titleRow, meta, content, commentList, commentForm);
  return article;
}

function renderPosts() {
  el.posts.innerHTML = "";
  if (!state.posts.length) {
    const empty = document.createElement("p");
    empty.className = "footer-note";
    empty.textContent = "No posts yet in this channel.";
    el.posts.append(empty);
    return;
  }

  state.posts.forEach((post) => {
    el.posts.append(buildPostElement(post));
  });
}

async function loadPosts() {
  const data = await apiGet(`/api/forums/posts?channel=${encodeURIComponent(state.channel)}`);
  state.posts = data.posts || [];
  renderPosts();
}

el.tabs.forEach((tab) => {
  tab.addEventListener("click", async () => {
    activateTab(tab.dataset.forumTab);
    setStatus("Loading posts...");
    try {
      await loadPosts();
      setStatus(`Showing ${state.channel === "announcements" ? "General Announcements" : "Weekly Reports"}.`);
    } catch (error) {
      setStatus(`Unable to load posts: ${error.message}`);
    }
  });
});

el.postForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canCurrentUserPost()) {
    setStatus("You do not have permission to create posts.");
    return;
  }

  const title = el.postTitle.value.trim();
  const content = el.postContent.value.trim();
  if (!title || !content) {
    return;
  }

  try {
    setStatus("Publishing post...");
    await apiPost("/api/forums/posts", {
      channel: state.channel,
      title,
      content
    });
    el.postTitle.value = "";
    el.postContent.value = "";
    await loadPosts();
    setStatus("Post published.");
  } catch (error) {
    setStatus(`Unable to publish post: ${error.message}`);
  }
});

async function initForums() {
  activateTab(state.channel);
  state.token = window.__FORUM_AUTH__?.token || window.localStorage.getItem(FORUM_TOKEN_KEY);

  try {
    const me = window.__FORUM_AUTH__?.user ? { user: window.__FORUM_AUTH__.user } : await apiGet("/api/forums/me");
    state.user = me.user;
    setAuthUi();
    setStatus("Loading posts...");
    await loadPosts();
    setStatus("Forums ready.");
  } catch (error) {
    saveToken(null);
    window.location.replace("login.html");
  }
}

initForums();
