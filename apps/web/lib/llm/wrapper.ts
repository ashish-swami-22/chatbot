import type { LlmMessage } from "./providers/base";
import { OpenAiProvider } from "./providers/openai";

export async function createChatCompletion(message: string, context: unknown[] = []) {
  const provider = new OpenAiProvider({
    apiKey: process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || "",
    modelName: process.env.MODEL_NAME || "gpt-4.1-mini",
    baseUrl: process.env.MODEL_BASE_URL || "https://api.openai.com/v1",
  });

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: "You are a concise, helpful chatbot.",
    },
    ...context
      .filter(
        (item): item is { role: "user" | "assistant"; content?: unknown } =>
          typeof item === "object" &&
          item !== null &&
          "role" in item &&
          ((item as { role?: string }).role === "user" ||
            (item as { role?: string }).role === "assistant")
      )
      .map((item) => ({
        role: item.role,
        content: String(item.content || ""),
      })),
    {
      role: "user",
      content: message,
    },
  ];

  return provider.createChatCompletion(messages);
}
