# Architecture Notes

## Ingestion Flow

1. The UI submits a user message to the chat API.
2. The server stores the user message and builds a short context window.
3. The model wrapper measures latency and captures token usage, previews, and errors.
4. The wrapper sends a normalized inference record to the ingestion endpoint.
5. The ingestion endpoint validates the payload and stores it in the datastore.
6. The dashboard reads aggregated metrics from the stored logs.

## Logging Strategy

- Structured JSON logs are emitted to stdout.
- Each inference log includes:
  - model
  - provider
  - latency
  - token usage
  - timestamps
  - request status/errors
  - conversation/session id
  - input/output previews
- PII is redacted before storage and logging.

## Scaling Considerations

- The default datastore is file-backed and suitable for a lightweight demo.
- For horizontal scaling, move the same schema to PostgreSQL or Supabase.
- Dashboard aggregates are computed on read for simplicity.
- If volume grows, precompute counters or push logs to a queue.

## Failure Handling Assumptions

- Provider failures can happen due to timeouts, rate limits, or invalid responses.
- Canceling a conversation aborts the in-flight request.
- Malformed ingestion payloads are rejected.
- If persistence fails, the app logs the error and keeps serving chat requests when possible.
