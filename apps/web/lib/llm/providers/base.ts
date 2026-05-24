export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmProviderConfig = {
  apiKey: string;
  modelName: string;
  baseUrl: string;
};

export interface LlmProvider {
  createChatCompletion(messages: LlmMessage[]): Promise<string>;
}
