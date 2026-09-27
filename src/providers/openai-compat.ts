/**
 * OpenAI-compatible adapter. Covers OpenAI, Z.ai GLM, Zhipu, DeepSeek,
 * Moonshot, Qwen, Ollama, vLLM, LM Studio, Groq, Together, OpenRouter —
 * one protocol, many providers (the OpenCode multi-provider pattern).
 */
import type {
  ChatMessage,
  CompletionRequest,
  DeltaEvent,
  ProviderClient,
  ToolSpec,
  Usage,
} from "./types.js";
import { ProviderError } from "./types.js";

interface OAMessage {
  role: string;
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

function toOAMessages(messages: ChatMessage[]): OAMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        tool_call_id: m.toolCallId ?? "",
        name: m.name,
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content) : null,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.rawArguments ?? JSON.stringify(tc.arguments) },
        })),
      };
    }
    // system / user — pass through (string or multimodal array)
    return { role: m.role, content: m.content as OAMessage["content"] };
  });
}

function toOATools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OpenAICompatClient implements ProviderClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private extraHeaders: Record<string, string> = {},
    private providerId = "openai-compat"
  ) {}

  async *stream(req: CompletionRequest): AsyncGenerator<DeltaEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOAMessages(req.messages),
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length > 0) {
      body.tools = toOATools(req.tools);
      body.tool_choice = "auto";
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    }).catch((e) => {
      throw new ProviderError(`Network error: ${(e as Error).message}`, undefined, this.providerId, true);
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(
        `${this.providerId} HTTP ${res.status}: ${text.slice(0, 400)}`,
        res.status,
        this.providerId,
        retryable
      );
    }

    // SSE parse
    const decoder = new TextDecoder();
    let buf = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage | undefined;

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          // flush accumulated tool calls in index order
          const indexes = [...toolAcc.keys()].sort((a, b) => a - b);
          for (const idx of indexes) {
            const t = toolAcc.get(idx)!;
            yield { type: "toolCall", toolCall: { index: idx, id: t.id, name: t.name, argumentsDelta: t.args } };
          }
          yield { type: "done", usage };
          return;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.usage) {
          usage = {
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
          };
        }
        const choices: any[] = json.choices ?? [];
        const choice = choices[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
        }
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
          const indexes = [...toolAcc.keys()].sort((a, b) => a - b);
          for (const idx of indexes) {
            const t = toolAcc.get(idx)!;
            yield { type: "toolCall", toolCall: { index: idx, id: t.id, name: t.name, argumentsDelta: t.args } };
          }
          toolAcc.clear();
        }
      }
    }
    yield { type: "done", usage };
  }
}
