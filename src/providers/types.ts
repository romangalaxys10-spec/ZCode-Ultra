/**
 * Provider-agnostic message and tool types (the "harness contract").
 * All providers normalize to these shapes — the DeepSeek-harness idea that
 * the session log is the single source of truth for model history.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON object of arguments */
  arguments: Record<string, unknown>;
  /** raw JSON string as delivered by the model */
  rawArguments?: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image_url";
  image_url: { url: string }; // data: or https:
}

export type MessageContent = string | Array<TextContent | ImageContent>;

export interface ChatMessage {
  role: Role;
  content: MessageContent | null;
  /** assistant-only */
  toolCalls?: ToolCall[];
  /** tool role only */
  toolCallId?: string;
  /** tool role only: human-readable tool name for logs */
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  model: string;
  maxTokens: number;
  temperature?: number;
  /** abort signal for cancellation */
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface DeltaEvent {
  type: "text" | "toolCall" | "done" | "error";
  text?: string;
  toolCall?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  usage?: Usage;
  error?: string;
}

export interface ProviderClient {
  /** Streaming completion; yields normalized delta events. */
  stream(req: CompletionRequest): AsyncGenerator<DeltaEvent>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public providerId?: string,
    public retryable = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
