const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type IncomingContextItem = {
  role?: string;
  content?: unknown;
};

type SupportedContextItem = {
  role: "user" | "assistant";
  content?: unknown;
};

async function callModel(messages: ChatMessage[]) {
  const apiKey = Deno.env.get("MODEL_API_KEY") || Deno.env.get("OPENAI_API_KEY") || "";
  const modelName = Deno.env.get("MODEL_NAME") || "gpt-4.1-mini";
  const baseUrl = (Deno.env.get("MODEL_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");

  if (!apiKey) {
    throw new Error("Missing MODEL_API_KEY.");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      temperature: 0.7,
    }),
  });

  const text = await response.text();
  let data:
    | {
        error?: { message?: unknown };
        raw?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
      }
    | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as {
        error?: { message?: unknown };
        raw?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
      };
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const detail = String(data?.error?.message || data?.raw || text || `HTTP ${response.status}`);
    throw new Error(detail);
  }

  const choices = data?.choices || [];
  const reply = choices[0]?.message?.content;
  if (!reply) {
    throw new Error("Empty model response.");
  }

  return String(reply).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = (await req.json()) as {
      message?: unknown;
      context?: unknown;
    };
    const message = payload.message;
    const context = payload.context;

    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Message is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a concise, helpful chatbot. Keep replies short, natural, and conversational.",
      },
      ...(
        Array.isArray(context)
          ? context
              .filter(
                (item): item is SupportedContextItem =>
                  typeof item === "object" &&
                  item !== null &&
                  "role" in item &&
                  ((item as IncomingContextItem).role === "user" ||
                    (item as IncomingContextItem).role === "assistant")
              )
              .map((item) => ({
                role: item.role,
                content: String(item.content || ""),
              }))
              .slice(-10)
          : []
      ),
      { role: "user", content: message },
    ];

    const reply = await callModel(messages);

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unexpected error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
