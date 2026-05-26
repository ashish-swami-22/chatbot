# Architecture Notes

## Runtime Flow

1. The browser submits a message to the Node server.
2. The server stores conversations and messages in PostgreSQL through Prisma.
3. The server sends the user prompt and recent context to the selected model provider.
4. The reply, token usage, metadata, and timing information are stored in PostgreSQL.
5. The dashboard reads aggregated metrics from the same database.

## Ingestion Flow

1. The application creates a normalized inference record after each model call.
2. The record is written to the `inference_logs` table.
3. A second event record is written to `ingestion_events` for auditability.
4. The dashboard reads the processed data from PostgreSQL instead of depending on live model traffic.

## Logging Strategy

- Capture model, provider, latency, status, token usage, timestamps, request ID, and previews.
- Redact obvious PII patterns before storing previews.
- Keep the raw conversation content in `messages` and use `inputPreview` / `outputPreview` for operational views.
- Preserve event payloads so ingestion can be inspected after the fact.

## Storage

- PostgreSQL is the source of truth.
- Prisma models the database and handles migrations.
- Conversations, messages, inference logs, and ingestion events are stored in separate tables.

## Deployment

- Local infrastructure uses Docker Compose with PostgreSQL.
- Kubernetes manifests are provided for app deployment.
- Secrets are injected through environment variables or Kubernetes Secrets.

## Security

- Provider API keys never reach the browser.
- Database URLs and API keys are server-side only.
- Example secret files are included only as templates.

## Scaling Considerations

- The current server keeps the in-memory conversation cache small and reconstructs it from PostgreSQL on startup.
- The ingestion path is synchronous enough for a small demo, but a queue would be better if log volume increased.
- The dashboard polls the API every few seconds, which is practical for local use but not ideal for a high-traffic installation.
- The app currently runs one Node process, so horizontal scaling would require careful handling of conversation state and cleanup jobs.

## Failure Handling Assumptions

- If the model call fails, the conversation is marked as errored and the failure is logged.
- If the request is canceled, the conversation is marked as canceled and the result is stored as a canceled inference record.
- If the database write fails, the server logs the error and continues serving, but operational data can be lost.
- If the database is unavailable at startup, the app exits rather than serving in a degraded state.
