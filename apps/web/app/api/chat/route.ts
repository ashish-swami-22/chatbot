import { NextResponse } from "next/server";
import { createChatCompletion } from "../../../lib/llm/wrapper";

export async function POST(request: Request) {
  const body = await request.json();
  const reply = await createChatCompletion(body.message, body.context ?? []);

  return NextResponse.json({ reply });
}
