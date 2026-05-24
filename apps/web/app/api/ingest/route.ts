import { NextResponse } from "next/server";
import { redactPii } from "../../../lib/ingestion/pii-redaction";

export async function POST(request: Request) {
  const body = await request.json();
  const sanitized = redactPii(body);

  return NextResponse.json({ ok: true, sanitized });
}
