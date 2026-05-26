const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");

function getSelectedProvider() {
  return (process.env.LLM_PROVIDER || process.env.GEMINI_PROVIDER || "gemini").trim().toLowerCase() || "gemini";
}

function getProviderDefaultModel(provider) {
  switch (String(provider || "").trim().toLowerCase()) {
    case "openai":
      return "gpt-4.1-mini";
    case "deepseek":
      return "deepseek-chat";
    case "grok":
      return "grok-2-latest";
    case "gemini":
    default:
      return "gemini-2.5-flash";
  }
}

function getProviderDefaultBaseUrl(provider) {
  switch (String(provider || "").trim().toLowerCase()) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "grok":
      return "https://api.x.ai/v1";
    case "gemini":
    default:
      return "https://generativelanguage.googleapis.com/v1beta/openai/";
  }
}

function getConfigValue(provider, key, fallback = "") {
  const upper = String(provider || "").trim().toUpperCase();
  const candidateKeys = [
    `${upper}_${key}`,
    `LLM_${key}`,
    `GEMINI_${key}`,
    `OPENAI_${key}`,
    `DEEPSEEK_${key}`,
    `GROK_${key}`,
  ];

  for (const envKey of candidateKeys) {
    const value = process.env[envKey];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return fallback;
}

function resolveModelConfig() {
  const provider = getSelectedProvider();
  const model = getConfigValue(provider, "MODEL", getProviderDefaultModel(provider));
  const apiKey = getConfigValue(provider, "API_KEY", "");
  const baseUrl = getConfigValue(provider, "BASE_URL", getProviderDefaultBaseUrl(provider)).replace(/\/+$/, "");

  return {
    provider,
    model,
    apiKey,
    baseUrl,
  };
}

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

const MODEL_CONFIG = resolveModelConfig();
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_PROVIDER = MODEL_CONFIG.provider;
const DEFAULT_MODEL_NAME = MODEL_CONFIG.model;
const DEFAULT_API_KEY = MODEL_CONFIG.apiKey;
const DEFAULT_BASE_URL = MODEL_CONFIG.baseUrl;
const MAX_CONTEXT_MESSAGES = 10;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATION_TITLE_CHARS = 48;

const conversations = new Map();
const inFlightRequests = new Map();
const dbState = {
  conversations: [],
  messages: [],
  inferenceLogs: [],
  events: [],
};

const prismaGlobal = globalThis;
const prisma = prismaGlobal.prisma || new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") {
  prismaGlobal.prisma = prisma;
}

let dbWriteChain = Promise.resolve();
let cleanupInterval = null;

function queueDbOperation(operation, label) {
  dbWriteChain = dbWriteChain
    .then(operation)
    .catch((error) => {
      console.error(`Failed to persist ${label}`, error);
    });
  return dbWriteChain;
}

function queueConversationPersist(record) {
  return queueDbOperation(async () => {
    await prisma.conversation.upsert({
      where: { id: record.id },
      create: {
        id: record.id,
        userId: record.userId || null,
        title: record.title,
        status: record.status,
        provider: record.provider || DEFAULT_PROVIDER,
        model: record.model || DEFAULT_MODEL_NAME,
        preview: record.preview || "",
        lastError: record.lastError || null,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
        canceledAt: record.canceledAt ? new Date(record.canceledAt) : null,
        closedAt: record.closedAt ? new Date(record.closedAt) : null,
      },
      update: {
        userId: record.userId || null,
        title: record.title,
        status: record.status,
        provider: record.provider || DEFAULT_PROVIDER,
        model: record.model || DEFAULT_MODEL_NAME,
        preview: record.preview || "",
        lastError: record.lastError || null,
        updatedAt: new Date(record.updatedAt),
        canceledAt: record.canceledAt ? new Date(record.canceledAt) : null,
        closedAt: record.closedAt ? new Date(record.closedAt) : null,
      },
    });
  }, "conversation");
}

function queueMessagePersist(record) {
  return queueDbOperation(async () => {
    await prisma.message.upsert({
      where: {
        conversationId_sequence: {
          conversationId: record.conversationId,
          sequence: record.sequence,
        },
      },
      create: {
        id: record.id,
        conversationId: record.conversationId,
        role: record.role,
        content: record.content,
        contentPreview: record.contentPreview || previewText(record.content),
        sequence: record.sequence,
        tokenCount: record.tokenCount ?? null,
        createdAt: new Date(record.createdAt),
      },
      update: {
        role: record.role,
        content: record.content,
        contentPreview: record.contentPreview || previewText(record.content),
        tokenCount: record.tokenCount ?? null,
      },
    });
  }, "message");
}

function queueInferenceLogPersist(record) {
  return queueDbOperation(async () => {
    await prisma.inferenceLog.upsert({
      where: { id: record.id },
      create: {
        id: record.id,
        conversationId: record.conversationId,
        userId: record.userId || null,
        provider: record.provider,
        model: record.model,
        status: record.status,
        latencyMs: record.latencyMs,
        promptTokens: record.promptTokens ?? null,
        completionTokens: record.completionTokens ?? null,
        totalTokens: record.totalTokens ?? null,
        startedAt: new Date(record.startedAt),
        completedAt: new Date(record.completedAt),
        loggedAt: new Date(record.loggedAt),
        inputPreview: record.inputPreview || "",
        outputPreview: record.outputPreview || "",
        errorMessage: record.errorMessage || null,
        requestId: record.requestId || null,
        metadata: record.metadata || {},
      },
      update: {
        userId: record.userId || null,
        provider: record.provider,
        model: record.model,
        status: record.status,
        latencyMs: record.latencyMs,
        promptTokens: record.promptTokens ?? null,
        completionTokens: record.completionTokens ?? null,
        totalTokens: record.totalTokens ?? null,
        startedAt: new Date(record.startedAt),
        completedAt: new Date(record.completedAt),
        loggedAt: new Date(record.loggedAt),
        inputPreview: record.inputPreview || "",
        outputPreview: record.outputPreview || "",
        errorMessage: record.errorMessage || null,
        requestId: record.requestId || null,
        metadata: record.metadata || {},
      },
    });
  }, "inference log");
}

function queueEventPersist(record) {
  return queueDbOperation(async () => {
    await prisma.ingestionEvent.create({
      data: {
        id: record.id,
        eventType: record.type,
        conversationId: record.payload?.conversationId || null,
        inferenceLogId: record.payload?.inferenceLogId || null,
        payload: record.payload || {},
        createdAt: new Date(record.createdAt),
      },
    });
  }, "event");
}

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
  queueEventPersist(record);
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
    userId: conversation.userId || null,
    provider: conversation.provider || DEFAULT_PROVIDER,
    model: conversation.model || DEFAULT_MODEL_NAME,
    lastError: conversation.lastError || "",
  };
  const index = dbState.conversations.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    dbState.conversations[index] = record;
  } else {
    dbState.conversations.push(record);
  }
  queueConversationPersist(record);
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
  queueMessagePersist(record);
  return record;
}

function upsertInferenceLog(logRecord) {
  const tokenUsage = logRecord.tokenUsage || {};
  const normalizedRecord = {
    ...logRecord,
    promptTokens: logRecord.promptTokens ?? tokenUsage.prompt_tokens ?? tokenUsage.promptTokens ?? null,
    completionTokens:
      logRecord.completionTokens ?? tokenUsage.completion_tokens ?? tokenUsage.completionTokens ?? null,
    totalTokens: logRecord.totalTokens ?? tokenUsage.total_tokens ?? tokenUsage.totalTokens ?? null,
    metadata: logRecord.metadata || {
      tokenUsage,
    },
  };
  const index = dbState.inferenceLogs.findIndex((item) => item.id === logRecord.id);
  if (index >= 0) {
    dbState.inferenceLogs[index] = normalizedRecord;
  } else {
    dbState.inferenceLogs.push(normalizedRecord);
  }
  queueInferenceLogPersist(normalizedRecord);
}

function schedulePersist() {
  return dbWriteChain;
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
  const [conversationRows, messageRows, inferenceLogRows, eventRows] = await Promise.all([
    prisma.conversation.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.message.findMany({ orderBy: [{ conversationId: "asc" }, { sequence: "asc" }] }),
    prisma.inferenceLog.findMany({ orderBy: { loggedAt: "asc" } }),
    prisma.ingestionEvent.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  dbState.conversations = conversationRows.map((row) => ({
    id: row.id,
    userId: row.userId || null,
    title: row.title,
    status: row.status,
    provider: row.provider || DEFAULT_PROVIDER,
    model: row.model || DEFAULT_MODEL_NAME,
    preview: row.preview || "",
    lastError: row.lastError || "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  }));

  dbState.messages = messageRows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    contentPreview: row.contentPreview || previewText(row.content),
    sequence: row.sequence,
    tokenCount: row.tokenCount ?? null,
    createdAt: row.createdAt.toISOString(),
  }));

  dbState.inferenceLogs = inferenceLogRows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    userId: row.userId || null,
    provider: row.provider,
    model: row.model,
    status: row.status,
    latencyMs: Number(row.latencyMs || 0),
    promptTokens: row.promptTokens ?? null,
    completionTokens: row.completionTokens ?? null,
    totalTokens: row.totalTokens ?? null,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    loggedAt: row.loggedAt.toISOString(),
    inputPreview: row.inputPreview || "",
    outputPreview: row.outputPreview || "",
    errorMessage: row.errorMessage || null,
    requestId: row.requestId || null,
    metadata: row.metadata || {},
    tokenUsage: {
      prompt_tokens: row.promptTokens ?? null,
      completion_tokens: row.completionTokens ?? null,
      total_tokens: row.totalTokens ?? null,
    },
  }));

  dbState.events = eventRows.map((row) => ({
    id: row.id,
    type: row.eventType,
    payload: row.payload || {},
    createdAt: row.createdAt.toISOString(),
  }));

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
  const provider = sanitizeText(payload.provider) || DEFAULT_PROVIDER;
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
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
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

async function safeIngestInferenceLog(payload) {
  try {
    return await ingestInferenceLog(payload);
  } catch (error) {
    console.error("Failed to ingest inference log", error);
    return null;
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

async function callModel(messages, signal) {
  if (!DEFAULT_API_KEY) {
    throw new Error(`Set ${DEFAULT_PROVIDER.toUpperCase()}_API_KEY or LLM_API_KEY to enable model responses.`);
  }

  const startedAt = Date.now();
  const response = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEFAULT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL_NAME,
      messages,
      temperature: 0.7,
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
    const detail = data?.error?.message || data?.error || data?.raw || rawText || `HTTP ${response.status}`;
    const error = new Error(`Gemini request failed: ${detail}`);
    error.statusCode = response.status;
    error.latencyMs = latencyMs;
    throw error;
  }

  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    const error = new Error("The model returned an empty response.");
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

function cleanupExpiredConversations() {
  const now = Date.now();
  for (const [conversationId, conversation] of conversations.entries()) {
    if (now - new Date(conversation.updatedAt).getTime() > SESSION_TTL_MS) {
      conversations.delete(conversationId);
      dbState.conversations = dbState.conversations.filter((item) => item.id !== conversationId);
      dbState.messages = dbState.messages.filter((item) => item.conversationId !== conversationId);
      dbState.inferenceLogs = dbState.inferenceLogs.filter((item) => item.conversationId !== conversationId);
      dbState.events = dbState.events.filter((item) => item.payload?.conversationId !== conversationId);
      queueDbOperation(async () => {
        await prisma.conversation.deleteMany({ where: { id: conversationId } });
      }, "expired conversation delete");
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
    userId: null,
    status: "idle",
    provider: DEFAULT_PROVIDER,
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
    userId: null,
    status: "idle",
    provider: DEFAULT_PROVIDER,
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
  targetConversation.provider = DEFAULT_PROVIDER;
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
  const inferenceProvider = DEFAULT_PROVIDER;
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
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL to use PostgreSQL.");
  }

  if (!DEFAULT_API_KEY) {
    throw new Error(`Set ${DEFAULT_PROVIDER.toUpperCase()}_API_KEY or LLM_API_KEY to enable model responses.`);
  }

  await loadDatastore();
  server.listen(PORT, () => {
    console.log(`ChatBot running at http://localhost:${PORT}`);
  });

  cleanupInterval = setInterval(() => {
    cleanupExpiredConversations();
  }, 10 * 60 * 1000);
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  await new Promise((resolve) => server.close(resolve));
  await dbWriteChain;
  await prisma.$disconnect();
}

process.on("SIGINT", () => {
  shutdown("SIGINT")
    .catch((error) => console.error("Graceful shutdown failed", error))
    .finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM")
    .catch((error) => console.error("Graceful shutdown failed", error))
    .finally(() => process.exit(0));
});

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
