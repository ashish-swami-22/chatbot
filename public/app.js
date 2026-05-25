const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chatForm");
const inputEl = document.getElementById("messageInput");
const sendButtonEl = document.getElementById("sendButton");
const resetButtonEl = document.getElementById("resetButton");
const cancelButtonEl = document.getElementById("cancelButton");
const newConversationButtonEl = document.getElementById("newConversationButton");
const conversationListEl = document.getElementById("conversationList");
const activeConversationTitleEl = document.getElementById("activeConversationTitle");
const activeConversationSubtitleEl = document.getElementById("activeConversationSubtitle");

const STORAGE_KEY = "chatbot.conversationId";
const STARTER_TEXT = "Select a conversation or create a new one to start chatting.";

let conversations = [];
let activeConversationId = localStorage.getItem(STORAGE_KEY) || "";
let currentAbortController = null;
let currentReplyNode = null;

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatRelativeTime(value) {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000));

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function renderMessage(role, text, meta = false) {
  const node = document.createElement("div");
  node.className = meta ? "message meta" : `message ${role}`;
  node.textContent = text;
  messagesEl.appendChild(node);
  scrollToBottom();
  return node;
}

function renderConversationMessages(conversation) {
  messagesEl.innerHTML = "";

  if (!conversation || !Array.isArray(conversation.messages) || conversation.messages.length === 0) {
    renderMessage("assistant", STARTER_TEXT);
    return;
  }

  for (const message of conversation.messages) {
    renderMessage(message.role, message.content);
  }
}

function getConversationById(conversationId) {
  return conversations.find((conversation) => conversation.id === conversationId) || null;
}

function renderConversationList() {
  conversationListEl.innerHTML = "";

  if (conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "conversation-item";
    empty.textContent = "No conversations yet";
    conversationListEl.appendChild(empty);
    return;
  }

  for (const conversation of conversations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `conversation-item${conversation.id === activeConversationId ? " active" : ""}`;

    const title = document.createElement("div");
    title.className = "conversation-name";
    title.textContent = conversation.title || "Conversation";

    const meta = document.createElement("div");
    meta.className = "conversation-meta";
    meta.textContent = `${conversation.messageCount || 0} messages | ${formatRelativeTime(
      conversation.updatedAt
    )} | ${conversation.status || "idle"}`;

    const preview = document.createElement("div");
    preview.className = "conversation-preview";
    preview.textContent = conversation.preview || "No messages yet";

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(preview);
    item.addEventListener("click", () => {
      void loadConversation(conversation.id);
    });
    conversationListEl.appendChild(item);
  }
}

function setActiveConversation(conversation, { preserveInput = false } = {}) {
  activeConversationId = conversation.id;
  localStorage.setItem(STORAGE_KEY, activeConversationId);
  activeConversationTitleEl.textContent = conversation.title || "Conversation";
  activeConversationSubtitleEl.textContent = `${conversation.messageCount || 0} messages, ${
    conversation.status || "idle"
  }`;
  renderConversationMessages(conversation);
  renderConversationList();

  if (!preserveInput) {
    inputEl.value = "";
    autosize();
  }
}

async function fetchJson(url, options = {}) {
  const { headers: customHeaders = {}, ...rest } = options;
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...customHeaders,
    },
    ...rest,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
  }

  return data;
}

async function refreshConversations({ selectIfMissing = true } = {}) {
  const data = await fetchJson("/api/conversations");
  conversations = data.conversations || [];
  renderConversationList();

  if (conversations.length === 0) {
    return null;
  }

  const existingActive = getConversationById(activeConversationId);
  if (existingActive) {
    return existingActive;
  }

  if (selectIfMissing) {
    const fallback = conversations[0];
    await loadConversation(fallback.id, { fromRefresh: true });
    return fallback;
  }

  return conversations[0];
}

async function loadConversation(conversationId, { fromRefresh = false } = {}) {
  if (!conversationId) {
    return;
  }

  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  const data = await fetchJson(`/api/conversations/${conversationId}`);
  const conversation = data.conversation;
  const existingIndex = conversations.findIndex((item) => item.id === conversation.id);
  if (existingIndex >= 0) {
    conversations[existingIndex] = conversation;
  } else {
    conversations.unshift(conversation);
  }

  setActiveConversation(conversation, { preserveInput: fromRefresh });
}

async function createConversation() {
  const data = await fetchJson("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "New chat" }),
  });

  const conversation = data.conversation;
  conversations.unshift(conversation);
  renderConversationList();
  await loadConversation(conversation.id);
}

function setBusy(isBusy) {
  sendButtonEl.disabled = isBusy;
  resetButtonEl.disabled = isBusy;
  cancelButtonEl.disabled = !isBusy;
  newConversationButtonEl.disabled = isBusy;
  inputEl.disabled = isBusy;
  conversationListEl.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
}

async function submitMessage(message) {
  try {
    if (!getConversationById(activeConversationId)) {
      await createConversation();
    }

    const targetConversation = getConversationById(activeConversationId);
    if (!targetConversation) {
      throw new Error("No active conversation available.");
    }

    currentAbortController = new AbortController();
    setBusy(true);
    renderMessage("user", message);
    currentReplyNode = renderMessage("assistant", "Thinking...");
    activeConversationSubtitleEl.textContent = `${targetConversation.messageCount || 0} messages, thinking`;

    const data = await fetchJson(`/api/conversations/${targetConversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
      signal: currentAbortController.signal,
    });

    const updatedConversation = data.conversation;
    const index = conversations.findIndex((item) => item.id === updatedConversation.id);
    if (index >= 0) {
      conversations[index] = updatedConversation;
    } else {
      conversations.unshift(updatedConversation);
    }

    if (currentReplyNode) {
      currentReplyNode.textContent = data.reply;
      currentReplyNode = null;
    }

    activeConversationId = updatedConversation.id;
    localStorage.setItem(STORAGE_KEY, activeConversationId);
    activeConversationTitleEl.textContent = updatedConversation.title || "Conversation";
    activeConversationSubtitleEl.textContent = `${updatedConversation.messageCount || 0} messages, ${
      updatedConversation.status || "idle"
    }`;
    renderConversationList();
  } catch (error) {
    if (error.name === "AbortError") {
      if (currentReplyNode) {
        currentReplyNode.textContent = "Conversation canceled.";
      }
      await refreshConversations({ selectIfMissing: false }).catch(() => {});
    } else {
      if (currentReplyNode) {
        currentReplyNode.textContent = `Error: ${error.message}`;
      } else {
        renderMessage("assistant", `Error: ${error.message}`, true);
      }
    }
  } finally {
    currentAbortController = null;
    currentReplyNode = null;
    setBusy(false);
    inputEl.focus();
    autosize();
  }
}

async function cancelConversation() {
  if (currentAbortController) {
    currentAbortController.abort();
  }

  if (!activeConversationId) {
    return;
  }

  await fetchJson(`/api/conversations/${activeConversationId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  }).catch(() => {});

  await refreshConversations({ selectIfMissing: false }).catch(() => {});
}

async function clearThread() {
  if (currentAbortController) {
    currentAbortController.abort();
  }

  messagesEl.innerHTML = "";
  activeConversationTitleEl.textContent = "Conversation";
  activeConversationSubtitleEl.textContent = "Select a thread or start a new one.";
  activeConversationId = "";
  localStorage.removeItem(STORAGE_KEY);
  await createConversation().catch(() => {});
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message || currentAbortController) {
    return;
  }

  inputEl.value = "";
  autosize();
  await submitMessage(message);
});

inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

cancelButtonEl.addEventListener("click", () => {
  void cancelConversation();
});

resetButtonEl.addEventListener("click", () => {
  void clearThread();
});

newConversationButtonEl.addEventListener("click", () => {
  void createConversation();
});

window.addEventListener("beforeunload", () => {
  if (currentAbortController) {
    currentAbortController.abort();
  }
});

async function initialize() {
  try {
    await refreshConversations({ selectIfMissing: true });
    if (!activeConversationId && conversations[0]) {
      await loadConversation(conversations[0].id);
    }
    if (!conversations.length) {
      await createConversation();
    }
  } catch (error) {
    messagesEl.innerHTML = "";
    renderMessage("assistant", `Error loading conversations: ${error.message}`, true);
  }
}

autosize();
initialize().catch((error) => {
  messagesEl.innerHTML = "";
  renderMessage("assistant", `Initialization error: ${error.message}`, true);
});
