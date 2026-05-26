-- CreateTable
create table if not exists "conversations" (
  "id" uuid not null default gen_random_uuid(),
  "user_id" text,
  "title" text not null,
  "status" text not null default 'idle',
  "provider" text not null default 'gemini',
  "model" text not null default 'gemini-2.5-flash',
  "preview" text not null default '',
  "last_error" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "canceled_at" timestamptz,
  "closed_at" timestamptz,

  constraint "conversations_pkey" primary key ("id")
);

create index if not exists "conversations_user_id_idx" on "conversations" ("user_id");
create index if not exists "conversations_status_updated_at_idx" on "conversations" ("status", "updated_at" desc);

-- CreateTable
create table if not exists "messages" (
  "id" uuid not null default gen_random_uuid(),
  "conversation_id" uuid not null,
  "role" text not null,
  "content" text not null,
  "content_preview" text not null default '',
  "sequence" integer not null,
  "token_count" integer,
  "created_at" timestamptz not null default now(),

  constraint "messages_pkey" primary key ("id")
);

create unique index if not exists "messages_conversation_sequence_idx" on "messages" ("conversation_id", "sequence");
create index if not exists "messages_conversation_id_created_at_idx" on "messages" ("conversation_id", "created_at" desc);

-- CreateTable
create table if not exists "inference_logs" (
  "id" uuid not null default gen_random_uuid(),
  "conversation_id" uuid not null,
  "user_id" text,
  "provider" text not null,
  "model" text not null,
  "status" text not null,
  "latency_ms" integer not null,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "total_tokens" integer,
  "started_at" timestamptz not null,
  "completed_at" timestamptz not null,
  "logged_at" timestamptz not null default now(),
  "input_preview" text not null default '',
  "output_preview" text not null default '',
  "error_message" text,
  "request_id" text,
  "metadata" jsonb not null,

  constraint "inference_logs_pkey" primary key ("id")
);

create index if not exists "inference_logs_conversation_id_logged_at_idx" on "inference_logs" ("conversation_id", "logged_at" desc);
create index if not exists "inference_logs_status_logged_at_idx" on "inference_logs" ("status", "logged_at" desc);
create index if not exists "inference_logs_model_logged_at_idx" on "inference_logs" ("model", "logged_at" desc);

-- CreateTable
create table if not exists "ingestion_events" (
  "id" uuid not null default gen_random_uuid(),
  "event_type" text not null,
  "conversation_id" uuid,
  "inference_log_id" uuid,
  "payload" jsonb not null,
  "created_at" timestamptz not null default now(),

  constraint "ingestion_events_pkey" primary key ("id")
);

create index if not exists "ingestion_events_event_type_created_at_idx" on "ingestion_events" ("event_type", "created_at" desc);
create index if not exists "ingestion_events_conversation_id_created_at_idx" on "ingestion_events" ("conversation_id", "created_at" desc);

-- AddForeignKey
alter table if exists "messages"
  add constraint "messages_conversation_id_fkey"
  foreign key ("conversation_id") references "conversations"("id") on delete cascade on update cascade;

alter table if exists "inference_logs"
  add constraint "inference_logs_conversation_id_fkey"
  foreign key ("conversation_id") references "conversations"("id") on delete cascade on update cascade;

alter table if exists "ingestion_events"
  add constraint "ingestion_events_conversation_id_fkey"
  foreign key ("conversation_id") references "conversations"("id") on delete cascade on update cascade;

alter table if exists "ingestion_events"
  add constraint "ingestion_events_inference_log_id_fkey"
  foreign key ("inference_log_id") references "inference_logs"("id") on delete cascade on update cascade;
