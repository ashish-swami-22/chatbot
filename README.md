# LLM Inference Logger

A lightweight chatbot plus inference logging and ingestion system.

The app supports:

- multi-turn conversations
- short conversational context
- conversation list, resume, and cancel actions
- a dashboard for latency, token, and error metrics
- near real-time inference log ingestion
- PII redaction before storage and logging

## Setup Instructions

### Local run

1. Install Node.js 20 or newer.
2. Set your model key.

```powershell
$env:MODEL_API_KEY="your_api_key_here"
```

3. Optionally set provider settings.

```powershell
$env:MODEL_PROVIDER="openai-compatible"
$env:MODEL_NAME="gpt-4.1-mini"
$env:MODEL_BASE_URL="https://api.openai.com/v1"
```

4. Start the app.

```powershell
npm start
```

5. Open:

```text
http://localhost:3000
```

The dashboard is available at:

```text
http://localhost:3000/dashboard
```

### Docker Compose

1. Copy `.env.example` to `.env`.
2. Fill in your values.
3. Run:

```powershell
docker compose up --build
```

## Architecture Overview

- Frontend:
  - Static chat UI in `public/`
  - Conversation list, resume, cancel, and dashboard views
- Backend:
  - Single Node HTTP server in `server.js`
  - Chat API, ingestion API, and dashboard API
  - Wraps the model call and captures inference metadata
- Storage:
  - File-backed datastore in `data/db.json` for the lightweight local implementation
  - Supabase/Postgres schema included in `supabase/migrations/0001_init.sql`

## Schema Design Decisions

The datastore is split into separate logical records:

- `conversations`
  - id, title, status, timestamps, preview, last error
- `messages`
  - conversation id, role, content, timestamp
- `inference_logs`
  - conversation id, provider, model, latency, token usage, timestamps, previews, error info
- `ingestion_events`
  - generic event stream for future event-driven processing

Why this shape:

- messages stay queryable without duplicating them inside inference logs
- inference logs remain independent from chat content
- the dashboard can aggregate metrics without recomputing from raw transcripts every time
- the schema can map directly to PostgreSQL tables later

## Tradeoffs Made

- File-backed JSON datastore instead of a full database driver:
  - no extra dependency install
  - easy to inspect locally
  - weaker concurrency and scale characteristics than Postgres
- Short context window:
  - lower latency and cost
  - older context is intentionally dropped
- Provider abstraction is OpenAI-compatible:
  - works with multiple vendors that expose the same chat-completions shape
  - not every provider is supported natively
- Logging is lightweight:
  - good for a small application
  - not a replacement for a full observability stack

## What I Would Improve With More Time

- Switch the datastore from JSON files to PostgreSQL or Supabase end-to-end
- Add background jobs for summarization and archival
- Add streaming token delivery to the UI
- Add Prometheus/Grafana dashboards backed by real metrics
- Add auth and per-user conversation ownership
- Add retries and backoff for provider and ingestion failures

## Architecture Notes

### Ingestion Flow

1. The browser sends a chat message to `/api/conversations/:id/messages`.
2. The server appends the user message to the conversation store.
3. The model wrapper measures latency and captures token usage, previews, and errors.
4. The wrapper sends the normalized inference record to `/api/ingest`.
5. The ingestion endpoint validates the payload and stores it in the datastore.
6. The dashboard reads aggregated metrics from `/api/dashboard`.

### Logging Strategy

- Structured JSON events are printed to stdout.
- Inference records store:
  - model
  - provider
  - latency
  - token usage
  - timestamps
  - request status/errors
  - conversation/session id
  - input/output previews
- PII patterns are redacted before storage and log output.

### Scaling Considerations

- The JSON datastore is single-node only.
- For horizontal scaling, move storage to PostgreSQL or Supabase.
- The ingestion endpoint can be published as a separate service later.
- If throughput rises, move dashboard aggregation into precomputed counters.

### Failure Handling Assumptions

- Provider calls can fail with timeouts, quota errors, or empty responses.
- Canceling a conversation aborts the in-flight model request.
- Ingestion validation rejects malformed payloads instead of storing bad rows.
- If the datastore write fails, the server logs the error and continues serving chat requests.

### Multi-Provider Support

- The backend uses an OpenAI-compatible model wrapper.
- Configuration is driven by:
  - `MODEL_API_KEY`
  - `MODEL_PROVIDER`
  - `MODEL_NAME`
  - `MODEL_BASE_URL`

### Streaming Responses

- The current implementation is request/response.
- Streaming can be added later with SSE or chunked responses.

### Latency + Throughput + Errors Dashboards

- `/api/dashboard` exposes:
  - total conversations
  - active conversations
  - total messages
  - total inference logs
  - error count
  - canceled count
  - average latency
  - p95 latency
  - token totals
- `public/dashboard.html` renders a simple live dashboard.

### Docker Compose One-Command Setup

- `docker compose up --build` starts the whole app locally.

### Event Based Architecture

- The server emits events like:
  - `conversation.created`
  - `message.received`
  - `message.completed`
  - `conversation.canceled`
  - `conversation.failed`
  - `inference.logged`

### PII Redaction

- Email addresses, phone-like numbers, and long numeric strings are redacted.
- Previews stored in the ingestion pipeline are also sanitized.

### Deploy Application on Self-Hosted Kubernetes

- Kubernetes manifests can be added around this app by pointing a deployment at the Node server.
- The current design already cleanly separates:
  - frontend assets
  - API routes
  - ingestion logic
  - storage

## Frontend

The UI allows:

- Cancel a conversation
- List conversations
- Resume a conversation
- Open the dashboard

## Configuration

- `MODEL_API_KEY`
  - Required. API key for the selected model provider.
- `MODEL_PROVIDER`
  - Optional. Defaults to `openai-compatible`.
- `MODEL_NAME`
  - Optional. Defaults to `gpt-4.1-mini`.
- `MODEL_BASE_URL`
  - Optional. Defaults to `https://api.openai.com/v1`.
- `PORT`
  - Optional. Defaults to `3000`.
- `SUPABASE_URL`
  - Required for a Supabase-backed deployment.
- `SUPABASE_SERVICE_ROLE_KEY`
  - Required for server-side database access and ingestion writes.

## Files

- `server.js`
  - HTTP server, chat API, ingestion API, dashboard API, and datastore persistence.
- `public/index.html`
  - Main chat UI.
- `public/dashboard.html`
  - Metrics dashboard.
- `public/app.js`
  - Conversation list, resume, cancel, and chat submission logic.
- `public/dashboard.js`
  - Dashboard rendering.
- `public/styles.css`
  - Shared styling for chat and dashboard.
- `data/db.json`
  - Lightweight local datastore.
- `supabase/migrations/0001_init.sql`
  - PostgreSQL schema for a Supabase-backed storage path.
- `apps/web/`
  - Next.js-style scaffold matching the requested folder structure.
- `ARCHITECTURE.md`
  - Short architecture notes.
