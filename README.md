# Gemini Chatbot

A compact LLM inference logging and chat application built for local Docker development and Kubernetes deployment.

## Features

- Chat UI with conversation history
- Server-side Gemini calls
- PostgreSQL persistence through Prisma
- Inference logging and dashboard metrics
- Docker Compose and Kubernetes deployment paths

## Environment Variables

Create a local `.env` from `.env.example` and set:

```powershell
PORT=3000
DATABASE_URL=postgresql://chatbot:chatbot@localhost:5432/chatbot?schema=public
LLM_PROVIDER=gemini
LLM_API_KEY=your_api_key_here
LLM_MODEL=gemini-2.5-flash
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
```

## Local Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Install dependencies.
4. Run Prisma migrations.
5. Start the app.

```powershell
npm install
npm run prisma:generate
npm run prisma:migrate:dev
npm start
```

Open:

```text
http://localhost:3000
```

Dashboard:

```text
http://localhost:3000/dashboard
```

## Docker Compose

Docker Compose brings up:

- the app
- PostgreSQL with a persistent volume

Run:

```powershell
docker compose up --build
```

If you want to run migrations manually first:

```powershell
docker compose run --rm chatbot npx prisma migrate deploy
```

## Prisma

Schema: [`prisma/schema.prisma`](./prisma/schema.prisma)

Migration: [`prisma/migrations/0001_init/migration.sql`](./prisma/migrations/0001_init/migration.sql)

Useful commands:

```powershell
npm run prisma:generate
npm run prisma:migrate:dev
npm run prisma:migrate:deploy
npm run prisma:studio
```

## Kubernetes

Example manifests are in [`k8s/`](./k8s).

Provided examples:

- [`k8s/app-deployment.yaml`](./k8s/app-deployment.yaml)
- [`k8s/app-service.yaml`](./k8s/app-service.yaml)
- [`k8s/app-secret.example.yaml`](./k8s/app-secret.example.yaml)
- [`k8s/postgres.yaml`](./k8s/postgres.yaml)

Notes:

- `k8s/postgres.yaml` deploys a self-hosted PostgreSQL instance for the app.
- Store `DATABASE_URL` and `GEMINI_API_KEY` in a Kubernetes Secret.
- The example service is `ClusterIP`, so use `kubectl port-forward` or add an Ingress for external access.
- You can use either the included PostgreSQL StatefulSet or a managed PostgreSQL instance.

Suggested apply order:

```powershell
copy k8s\app-secret.example.yaml k8s\app-secret.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/app-secret.yaml
kubectl apply -f k8s/app-deployment.yaml
kubectl apply -f k8s/app-service.yaml
```

If you use a managed PostgreSQL instance instead of the included StatefulSet, skip `k8s/postgres.yaml` and set `DATABASE_URL` accordingly before applying the app secret.

## Security Notes

- Do not commit `.env` or `k8s/app-secret.yaml`.
- Keep API keys only in server-side environment variables or Kubernetes Secrets.
- The browser never receives the Gemini API key.

## Architecture

- The Node server serves the UI and API.
- Prisma writes chat data, messages, inference logs, and ingestion events to PostgreSQL.
- The server calls Gemini from backend code only.
- Docker Compose is the local infrastructure path.
- Kubernetes manifests are included for container deployment.

## Schema Design

The database is intentionally split into four tables:

- `conversations` stores the top-level chat session state and summary fields.
- `messages` stores the ordered chat turns for each conversation.
- `inference_logs` stores model-call metadata, latency, token counts, status, and previews.
- `ingestion_events` stores the normalized event payloads received by the ingestion path.

Why this shape:

- It keeps the conversation view fast because the UI can read one conversation without joining everything.
- It keeps the inference log history queryable for dashboards and debugging.
- It preserves ingestion payloads for auditability without forcing the UI schema to match the raw request format.

## Tradeoffs

- The inference wrapper is embedded in the main server instead of a standalone package. That keeps the assignment lightweight, but it is less reusable than a separate SDK.
- The app uses an OpenAI-compatible Gemini endpoint shape. That minimizes code, but it is still single-provider in practice.
- The dashboard favors simple aggregated metrics over a full analytics stack. That makes it easy to run locally and in Kubernetes, but limits historical analysis.
- The current startup path runs Prisma migrations on boot. That is convenient for demos, but a stricter production setup would separate migrations from app startup.

## Improvements With More Time

- Extract the logging wrapper into a reusable SDK module.
- Add multi-provider routing so the same wrapper can send to Gemini, OpenAI, Claude, or other OpenAI-compatible APIs.
- Add streaming token responses.
- Add time-series charts for throughput, latency percentiles, and error rate.
- Add a proper ingress and external secret management for Kubernetes.
- Split migration execution into a separate init job or release step.

## Demo

- Hosted link / Loom: not included in this repo.
- Screenshots: not included in this repo.
