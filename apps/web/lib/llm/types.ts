export type ConversationStatus = "idle" | "thinking" | "canceled" | "error";

export type ConversationRecord = {
  id: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessageRecord = {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
