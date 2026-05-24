import type { IngestEvent } from "./schema";

export async function ingestEvent(event: IngestEvent) {
  await fetch("/api/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
}
