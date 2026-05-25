const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_EDGE_FUNCTION_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/chatbot` : "";
const DEFAULT_MODEL_NAME = "gemini-2.5-flash";
const MAX_CONTEXT_MESSAGES = 10;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATION_TITLE_CHARS = 48;
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const conversations = new Map();
const inFlightRequests = new Map();
const dbState = {
  conversations: [],
  messages: [],
  inferenceLogs: [],
  events: [],
};

let persistChain = Promise.resolve();

function getContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".yaml":
    case ".yml":
      return "text/yaml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getErrorStatusCode(error, fallbackStatusCode = 500) {
  const statusCode = Number(error && error.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }
  return fallbackStatusCode;
}

function getClientErrorMessage(error, fallbackMessage) {
  const statusCode = getErrorStatusCode(error, 500);
  if (statusCode < 500 && error && error.message) {
    return error.message;
  }
  return fallbackMessage;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(createHttpError("Request body too large.", 413));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sanitizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function redactPii(text) {
  const input = String(text || "");
  return input
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-phone]")
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, "[redacted-number]");
}

function logEvent(event, details = {}) {
  const redactedDetails = JSON.parse(
    JSON.stringify(details, (_key, value) => (typeof value === "string" ? redactPii(value) : value))
  );
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...redactedDetails,
    })
  );
}

function emitEvent(type, payload = {}) {
  const record = {
    id: randomUUID(),
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
  dbState.events.push(record);
  return record;
}

function createConversationTitle(firstUserMessage) {
  const cleaned = sanitizeText(firstUserMessage).replace(/\n+/g, " ");
  if (!cleaned) {
    return "New chat";
  }

  if (cleaned.length <= MAX_CONVERSATION_TITLE_CHARS) {
    return cleaned;
  }

  return `${cleaned.slice(0, MAX_CONVERSATION_TITLE_CHARS - 1).trimEnd()}...`;
}

function serializeConversation(conversation, includeMessages = false) {
  const displayLastError =
    conversation.status === "error"
      ? "Request failed."
      : conversation.status === "canceled"
        ? "Request canceled."
        : conversation.lastError || null;

  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastError: displayLastError,
    messageCount: conversation.messages.length,
    preview: conversation.preview || "",
    ...(includeMessages
      ? {
          messages: conversation.messages.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          })),
        }
      : {}),
  };
}

function touchConversation(conversation) {
  conversation.updatedAt = new Date().toISOString();
}

function getConversation(conversationId) {
  const key = String(conversationId || "").trim();
  if (!key) {
    return null;
  }

  const conversation = conversations.get(key);
  if (conversation) {
    touchConversation(conversation);
    return conversation;
  }

  return null;
}

function upsertConversationRecord(conversation) {
  const record = {
    ...serializeConversation(conversation),
    provider: conversation.provider || "gemini-edge",
    model: conversation.model || DEFAULT_MODEL_NAME,
    lastError: conversation.lastError || "",
  };
  const index = dbState.conversations.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    dbState.conversations[index] = record;
  } else {
    dbState.conversations.push(record);
  }
}

function getNextMessageSequence(conversationId) {
  const highestSequence = dbState.messages.reduce((max, message) => {
    if (message.conversationId !== conversationId) {
      return max;
    }

    const sequence = Number(message.sequence || 0);
    return Number.isFinite(sequence) && sequence > max ? sequence : max;
  }, 0);

  return highestSequence + 1;
}

function appendMessageRecord(conversationId, role, content, tokenCount = null) {
  const record = {
    id: randomUUID(),
    conversationId,
    role,
    content,
    contentPreview: previewText(content),
    sequence: getNextMessageSequence(conversationId),
    tokenCount,
    createdAt: new Date().toISOString(),
  };
  dbState.messages.push(record);
  return record;
}

function upsertInferenceLog(logRecord) {
  const normalizedRecord = {
    ...logRecord,
    tokenUsage: logRecord.tokenUsage || {
      prompt_tokens: logRecord.promptTokens ?? null,
      completion_tokens: logRecord.completionTokens ?? null,
      total_tokens: logRecord.totalTokens ?? null,
    },
  };
  const index = dbState.inferenceLogs.findIndex((item) => item.id === logRecord.id);
  if (index >= 0) {
    dbState.inferenceLogs[index] = normalizedRecord;
  } else {
    dbState.inferenceLogs.push(normalizedRecord);
  }
}

function schedulePersist() {
  persistChain = persistChain
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const snapshot = JSON.stringify(dbState, null, 2);
      const tempPath = `${DB_PATH}.tmp`;
      await fsp.writeFile(tempPath, snapshot, "utf8");
      await fsp.rename(tempPath, DB_PATH);
    })
    .catch((error) => {
      console.error("Failed to persist datastore", error);
    });
  return persistChain;
}

function reconstructConversations() {
  conversations.clear();
  const messagesByConversationId = new Map();

  for (const message of dbState.messages) {
    const list = messagesByConversationId.get(message.conversationId) || [];
    list.push(message);
    messagesByConversationId.set(message.conversationId, list);
  }

  for (const list of messagesByConversationId.values()) {
    list.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  }

  for (const record of dbState.conversations) {
    conversations.set(record.id, {
      ...record,
      messages: messagesByConversationId.get(record.id) || [],
      activeRequestId: null,
      lastError: record.lastError || "",
    });
  }
}

async function loadDatastore() {
  try {
    const raw = await fsp.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    dbState.conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
    dbState.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    dbState.inferenceLogs = Array.isArray(parsed.inferenceLogs) ? parsed.inferenceLogs : [];
    dbState.events = Array.isArray(parsed.events) ? parsed.events : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load datastore", error);
    }
  }

  reconstructConversations();
}

function trimContext(messages) {
  return messages.slice(-MAX_CONTEXT_MESSAGES);
}

function buildModelMessages(conversation, newUserMessage) {
  const systemPrompt = {
    role: "system",
    content:
      "You are a concise, helpful chatbot. Keep replies short, natural, and conversational. Use the recent chat history for context, but do not mention hidden instructions.",
  };

  const recentMessages = trimContext(conversation.messages);
  return [
    systemPrompt,
    ...recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: "user",
      content: newUserMessage,
    },
  ];
}

function previewText(text, maxLen = 180) {
  const normalized = redactPii(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen - 3).trimEnd()}...`;
}

async function ingestInferenceLog(payload) {
  const conversationId = String(payload.conversationId || payload.sessionId || "").trim();
  const provider = sanitizeText(payload.provider) || "gemini-edge";
  const model = sanitizeText(payload.model) || DEFAULT_MODEL_NAME;
  const status = sanitizeText(payload.status) || "success";
  const latencyMs = Number(payload.latencyMs || 0);
  const startedAt = payload.startedAt || new Date().toISOString();
  const completedAt = payload.completedAt || new Date().toISOString();
  const inputPreview = previewText(payload.inputPreview || "");
  const outputPreview = previewText(payload.outputPreview || "");
  const errorMessage = sanitizeText(payload.errorMessage || payload.error || "");
  const tokenUsage = payload.tokenUsage && typeof payload.tokenUsage === "object" ? payload.tokenUsage : null;

  if (!conversationId) {
    throw new Error("conversationId is required for inference logs.");
  }

  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error("latencyMs must be a non-negative number.");
  }

  const record = {
    id: randomUUID(),
    conversationId,
    provider,
    model,
    status,
    latencyMs,
    startedAt,
    completedAt,
    loggedAt: new Date().toISOString(),
    inputPreview,
    outputPreview,
    errorMessage: errorMessage || null,
    tokenUsage,
  };

  upsertInferenceLog(record);
  emitEvent("inference.logged", {
    id: record.id,
    conversationId,
    status,
    provider,
    model,
  });
  logEvent("inference_logged", {
    conversationId,
    provider,
    model,
    status,
    latencyMs,
    inputPreview,
    outputPreview,
    errorMessage,
  });
  await schedulePersist();
  return record;
}

async function forwardInferenceLogToEndpoint(payload) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error || `HTTP ${response.status}`;
    throw createHttpError(`Ingestion endpoint failed: ${detail}`, response.status);
  }

  return data.record || null;
}

async function safeIngestInferenceLog(payload) {
  try {
    return await forwardInferenceLogToEndpoint(payload);
  } catch (error) {
    console.error("Failed to ingest inference log via endpoint", error);
    try {
      return await ingestInferenceLog(payload);
    } catch (fallbackError) {
      console.error("Fallback ingestion failed", fallbackError);
      return null;
    }
  }
}

function validateIngestPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw createHttpError("Payload must be an object.", 400);
  }

  if (payload.type && payload.type !== "inference_log" && payload.type !== "inference") {
    throw createHttpError("Unsupported ingest type.", 400);
  }

  if (!String(payload.conversationId || payload.sessionId || "").trim()) {
    throw createHttpError("conversationId is required.", 400);
  }

  return payload;
}

function aggregateDashboardMetrics() {
  const inferenceLogs = dbState.inferenceLogs;
  const totalLogs = inferenceLogs.length;
  const errors = inferenceLogs.filter((item) => item.status === "error").length;
  const canceled = inferenceLogs.filter((item) => item.status === "canceled").length;
  const latencies = inferenceLogs.map((item) => Number(item.latencyMs || 0)).filter(Number.isFinite);
  const totalLatency = latencies.reduce((sum, value) => sum + value, 0);
  const avgLatencyMs = latencies.length ? Math.round(totalLatency / latencies.length) : 0;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p95LatencyMs = sortedLatencies.length
    ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.ceil(sortedLatencies.length * 0.95) - 1)]
    : 0;
  const totalPromptTokens = inferenceLogs.reduce(
    (sum, item) => sum + Number(item.tokenUsage?.prompt_tokens || item.tokenUsage?.promptTokens || 0),
    0
  );
  const totalCompletionTokens = inferenceLogs.reduce(
    (sum, item) => sum + Number(item.tokenUsage?.completion_tokens || item.tokenUsage?.completionTokens || 0),
    0
  );
  const totalTokens = inferenceLogs.reduce(
    (sum, item) => sum + Number(item.tokenUsage?.total_tokens || item.tokenUsage?.totalTokens || 0),
    0
  );

  return {
    totalConversations: conversations.size,
    activeConversations: [...conversations.values()].filter((item) => item.status === "thinking").length,
    totalMessages: dbState.messages.length,
    totalInferenceLogs: totalLogs,
    errorCount: errors,
    canceledCount: canceled,
    avgLatencyMs,
    p95LatencyMs,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    recentLogs: inferenceLogs.slice(-20).reverse(),
  };
}

async function callSupabaseEdgeFunction(messages, signal) {
  if (!SUPABASE_EDGE_FUNCTION_URL) {
    throw createHttpError("Set SUPABASE_URL to enable the Supabase Edge Function path.", 500);
  }

  const userMessage = messages[messages.length - 1]?.content || "";
  const context = messages
    .slice(1, -1)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: item.role,
      content: item.content,
    }));

  const startedAt = Date.now();
  const response = await fetch(SUPABASE_EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: userMessage,
      context,
    }),
    signal,
  });

  const rawText = await response.text();
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }
  }

  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const detail = data?.error || data?.raw || `HTTP ${response.status}`;
    const error = new Error(`Supabase edge function failed: ${detail}`);
    error.statusCode = response.status;
    error.latencyMs = latencyMs;
    throw error;
  }

  const reply = data?.reply;
  if (!reply) {
    const error = new Error("The edge function returned an empty response.");
    error.statusCode = 502;
    error.latencyMs = latencyMs;
    throw error;
  }

  return {
    reply: String(reply).trim(),
    usage: data?.usage || null,
    model: sanitizeText(data?.model) || DEFAULT_MODEL_NAME,
    latencyMs,
  };
}

async function callModel(messages, signal) {
  const edgeResult = await callSupabaseEdgeFunction(messages, signal);
  return {
    ...edgeResult,
    provider: "gemini-edge",
  };
}

function cleanupExpiredConversations() {
  const now = Date.now();
  for (const [conversationId, conversation] of conversations.entries()) {
    if (now - new Date(conversation.updatedAt).getTime() > SESSION_TTL_MS) {
      conversations.delete(conversationId);
      dbState.conversations = dbState.conversations.filter((item) => item.id !== conversationId);
      dbState.messages = dbState.messages.filter((item) => item.conversationId !== conversationId);
      dbState.inferenceLogs = dbState.inferenceLogs.filter((item) => item.conversationId !== conversationId);
      dbState.events = dbState.events.filter((item) => item.payload?.conversationId !== conversationId);
      void schedulePersist();
    }
  }
}

async function readJson(req) {
  const body = await readRequestBody(req);
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw createHttpError("Invalid JSON payload.", 400);
  }
}

async function handleListConversations(req, res) {
  const items = [...conversations.values()]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .map((conversation) => serializeConversation(conversation));
  return sendJson(res, 200, { conversations: items });
}

async function handleCreateConversation(req, res) {
  const payload = await readJson(req);
  const title = sanitizeText(payload.title) || "New chat";
  const conversation = {
    id: randomUUID(),
    title,
    status: "idle",
    provider: "gemini-edge",
    model: DEFAULT_MODEL_NAME,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preview: "",
    lastError: "",
    messages: [],
    activeRequestId: null,
  };

  conversations.set(conversation.id, conversation);
  upsertConversationRecord(conversation);
  emitEvent("conversation.created", { conversationId: conversation.id, title: conversation.title });
  logEvent("conversation_created", {
    conversationId: conversation.id,
    title: conversation.title,
  });
  await schedulePersist();
  return sendJson(res, 201, { conversation: serializeConversation(conversation, true) });
}

async function handleGetConversation(conversationId, res) {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return sendJson(res, 404, { error: "Conversation not found." });
  }

  return sendJson(res, 200, { conversation: serializeConversation(conversation, true) });
}

async function handleCancelConversation(conversationId, res) {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return sendJson(res, 404, { error: "Conversation not found." });
  }

  const request = inFlightRequests.get(conversation.id);
  if (request) {
    request.controller.abort();
    inFlightRequests.delete(conversation.id);
  }

  conversation.status = "canceled";
  conversation.lastError = "";
  touchConversation(conversation);
  upsertConversationRecord(conversation);
  emitEvent("conversation.canceled", { conversationId: conversation.id });
  logEvent("conversation_cancel_requested", {
    conversationId: conversation.id,
  });
  await schedulePersist();
  return sendJson(res, 200, { conversation: serializeConversation(conversation) });
}

async function handleSendMessage(conversationId, req, res) {
  const conversation = conversations.get(conversationId) || null;
  const targetConversation = conversation || {
    id: conversationId,
    title: "New chat",
    status: "idle",
    provider: "gemini-edge",
    model: DEFAULT_MODEL_NAME,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preview: "",
    lastError: "",
    messages: [],
    activeRequestId: null,
  };

  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, targetConversation);
    upsertConversationRecord(targetConversation);
    await schedulePersist();
  }

  const payload = await readJson(req);
  const message = sanitizeText(payload.message);

  if (!message) {
    return sendJson(res, 400, { error: "Message is required." });
  }

  const inputPreview = previewText(message);
  const userMessage = {
    role: "user",
    content: redactPii(message),
    createdAt: new Date().toISOString(),
  };

  appendMessageRecord(targetConversation.id, "user", userMessage.content);
  targetConversation.messages.push(userMessage);
  if (!targetConversation.title || targetConversation.title === "New chat") {
    targetConversation.title = createConversationTitle(message);
  }
  targetConversation.preview = inputPreview;
  targetConversation.status = "thinking";
  targetConversation.lastError = "";
  targetConversation.provider = "gemini-edge";
  targetConversation.model = DEFAULT_MODEL_NAME;
  touchConversation(targetConversation);
  upsertConversationRecord(targetConversation);
  emitEvent("message.received", {
    conversationId: targetConversation.id,
    message: inputPreview,
  });
  logEvent("message_received", {
    conversationId: targetConversation.id,
    message,
  });
  await schedulePersist();

  const modelMessages = buildModelMessages(targetConversation, message);
  const controller = new AbortController();
  const requestId = randomUUID();
  targetConversation.activeRequestId = requestId;
  inFlightRequests.set(targetConversation.id, { controller, requestId });
  const inferenceProvider = "gemini-edge";
  let modelName = DEFAULT_MODEL_NAME;

  const abortOnClose = () => controller.abort();
  req.on("close", abortOnClose);

  const startedAt = new Date().toISOString();
  try {
    const modelResult = await callModel(modelMessages, controller.signal);
    const reply = redactPii(modelResult.reply);
    modelName = modelResult.model || DEFAULT_MODEL_NAME;
    targetConversation.model = modelName;

    appendMessageRecord(targetConversation.id, "assistant", reply);
    targetConversation.messages.push({
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    });
    targetConversation.preview = previewText(reply);
    targetConversation.status = "idle";
    touchConversation(targetConversation);
    upsertConversationRecord(targetConversation);
    emitEvent("message.completed", {
      conversationId: targetConversation.id,
      reply: previewText(reply),
    });

    const inferenceLog = await safeIngestInferenceLog({
      conversationId: targetConversation.id,
      provider: inferenceProvider,
      model: modelName,
      status: "success",
      latencyMs: modelResult.latencyMs,
      startedAt,
      completedAt: new Date().toISOString(),
      tokenUsage: modelResult.usage,
      inputPreview,
      outputPreview: reply,
    });

    await schedulePersist();
    return sendJson(res, 200, {
      conversation: serializeConversation(targetConversation, true),
      reply,
      inferenceLog,
    });
  } catch (error) {
    const latencyMs = error?.latencyMs || 0;
    if (controller.signal.aborted) {
      targetConversation.status = "canceled";
      targetConversation.lastError = "Request canceled.";
      touchConversation(targetConversation);
      upsertConversationRecord(targetConversation);
      emitEvent("conversation.canceled", { conversationId: targetConversation.id });
      logEvent("conversation_canceled", {
        conversationId: targetConversation.id,
      });
      await safeIngestInferenceLog({
        conversationId: targetConversation.id,
        provider: inferenceProvider,
        model: modelName,
        status: "canceled",
        latencyMs,
        startedAt,
        completedAt: new Date().toISOString(),
        inputPreview,
        outputPreview: "",
        errorMessage: "Request canceled.",
      });
      await schedulePersist();
      return sendJson(res, 499, {
        error: "Conversation canceled.",
        conversation: serializeConversation(targetConversation, true),
      });
    }

    targetConversation.status = "error";
    targetConversation.lastError = error instanceof Error ? error.message : "Unexpected error";
    touchConversation(targetConversation);
    upsertConversationRecord(targetConversation);
    emitEvent("conversation.failed", {
      conversationId: targetConversation.id,
      error: targetConversation.lastError,
    });
    logEvent("conversation_error", {
      conversationId: targetConversation.id,
      error: targetConversation.lastError,
    });
    await safeIngestInferenceLog({
      conversationId: targetConversation.id,
      provider: inferenceProvider,
      model: modelName,
      status: "error",
      latencyMs,
      startedAt,
      completedAt: new Date().toISOString(),
      inputPreview,
      outputPreview: "",
      errorMessage: targetConversation.lastError,
    });
    await schedulePersist();
    return sendJson(res, 500, {
      error: "Failed to generate a reply.",
      conversation: serializeConversation(targetConversation, true),
    });
  } finally {
    req.off("close", abortOnClose);
    const current = inFlightRequests.get(targetConversation.id);
    if (current?.requestId === requestId) {
      inFlightRequests.delete(targetConversation.id);
      targetConversation.activeRequestId = null;
    }
  }
}

async function handleIngest(req, res) {
  const payload = await readJson(req);
  const normalized = validateIngestPayload(payload);
  const record = await ingestInferenceLog(normalized);
  return sendJson(res, 200, { ok: true, record });
}

async function handleDashboard(req, res) {
  return sendJson(res, 200, { ok: true, dashboard: aggregateDashboardMetrics() });
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (safePath === "/dashboard") {
    safePath = "/dashboard.html";
  }
  const filePath = path.join(__dirname, "public", safePath);
  const publicRoot = path.join(__dirname, "public");

  if (!filePath.startsWith(publicRoot)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        return sendText(res, 404, "Not found");
      }
      return sendText(res, 500, "Server error");
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    return handleDashboard(req, res).catch((error) =>
      sendJson(res, getErrorStatusCode(error, 500), {
        error: getClientErrorMessage(error, "Failed to load dashboard."),
      })
    );
  }

  if (req.method === "POST" && url.pathname === "/api/ingest") {
    return handleIngest(req, res).catch((error) =>
      sendJson(res, getErrorStatusCode(error, 500), {
        error: getClientErrorMessage(error, "Failed to ingest log."),
      })
    );
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    return handleListConversations(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/conversations") {
    return handleCreateConversation(req, res).catch((error) =>
      sendJson(res, getErrorStatusCode(error, 500), {
        error: getClientErrorMessage(error, "Failed to create conversation."),
      })
    );
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/conversations/")) {
    const [conversationId] = url.pathname.split("/").slice(3);
    return handleGetConversation(conversationId, res);
  }

  if (req.method === "POST" && url.pathname.endsWith("/messages")) {
    const [conversationId] = url.pathname.split("/").slice(3, 4);
    return handleSendMessage(conversationId, req, res).catch((error) =>
      sendJson(res, getErrorStatusCode(error, 500), {
        error: getClientErrorMessage(error, "Failed to generate a reply."),
      })
    );
  }

  if (req.method === "POST" && url.pathname.endsWith("/cancel")) {
    const [conversationId] = url.pathname.split("/").slice(3, 4);
    return handleCancelConversation(conversationId, res).catch((error) =>
      sendJson(res, getErrorStatusCode(error, 500), {
        error: getClientErrorMessage(error, "Failed to cancel conversation."),
      })
    );
  }

  if (req.method === "GET") {
    return serveStatic(req, res);
  }

  return sendText(res, 405, "Method not allowed");
});

async function bootstrap() {
  if (!SUPABASE_URL) {
    throw new Error("Set SUPABASE_URL to use the Supabase Edge Function path.");
  }

  await loadDatastore();
  server.listen(PORT, () => {
    console.log(`ChatBot running at http://localhost:${PORT}`);
    console.log(`Using Supabase Edge Function: ${SUPABASE_EDGE_FUNCTION_URL}`);
  });

  setInterval(() => {
    cleanupExpiredConversations();
  }, 10 * 60 * 1000);
}

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
