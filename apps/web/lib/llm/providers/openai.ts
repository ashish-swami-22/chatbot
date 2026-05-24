import type { LlmMessage, LlmProvider, LlmProviderConfig } from "./base";

export class OpenAiProvider implements LlmProvider {
  constructor(private readonly config: LlmProviderConfig) {}

  async createChatCompletion(messages: LlmMessage[]) {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.modelName,
        messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with HTTP ${response.status}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content ?? "";
  }
}
