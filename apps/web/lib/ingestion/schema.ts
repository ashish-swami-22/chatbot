export type IngestEvent = {
  event: "conversation.created" | "message.received" | "message.completed" | "conversation.canceled" | "conversation.failed";
  conversationId: string;
  timestamp: string;
  payload?: Record<string, unknown>;
};
