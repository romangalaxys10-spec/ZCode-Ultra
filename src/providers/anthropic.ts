/**
 * Native Anthropic adapter (/v1/messages with SSE streaming).
 */
import type { ChatMessage, CompletionRequest, DeltaEvent, ProviderClient, ToolSpec, Usage } from "./types.js";
import { ProviderError } from "./types.js";

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: { type: string; media_type: string; data: string };
}

function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          } as unknown as AnthropicBlock,
        ],
      });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    if (typeof m.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") blocks.push({ type: "text", text: part.text });
        else if (part.type === "image_url") {
          const url = part.image_url.url;
          const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(url);
          if (match) {
            blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } } as unknown as AnthropicBlock);
          }
        }
      }
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments } as unknown as AnthropicBlock);
      }
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "(empty)" });
    // merge consecutive same-role messages (Anthropic requires alternation)
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

export class AnthropicClient implements ProviderClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private extraHeaders: Record<string, string> = {},
    private providerId = "anthropic"
  ) {}

  async *stream(req: CompletionRequest): AsyncGenerator<DeltaEvent> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");

    const body: Record<string, unknown> = {
      model: req.model,
      system,
      messages: toAnthropicMessages(req.messages),
      max_tokens: req.maxTokens,
      stream: true,
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map(
        (t: ToolSpec) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      ...this.extraHeaders,
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    }).catch((e) => {
      throw new ProviderError(`Network error: ${(e as Error).message}`, undefined, this.providerId, true);
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `${this.providerId} HTTP ${res.status}: ${text.slice(0, 400)}`,
        res.status,
        this.providerId,
        res.status === 429 || res.status >= 500
      );
    }

    const decoder = new TextDecoder();
    let buf = "";
    let usage: Usage | undefined;
    const tools = new Map<string, { name: string; input: string }>();
    let emittedToolIds = new Set<string>();

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        switch (json.type) {
          case "content_block_start":
            if (json.content_block?.type === "tool_use") {
              tools.set(json.content_block.id, {
                name: json.content_block.name,
                input: "",
              });
            }
            break;
          case "content_block_delta":
            if (json.delta?.type === "text_delta" && json.delta.text) {
              yield { type: "text", text: json.delta.text };
            } else if (json.delta?.type === "input_json_delta" && json.delta.partial_json) {
              const lastId = [...tools.keys()].pop();
              if (lastId) tools.get(lastId)!.input += json.delta.partial_json;
            }
            break;
          case "message_delta":
            if (json.usage) {
              usage = {
                inputTokens: json.usage.input_tokens ?? 0,
                outputTokens: json.usage.output_tokens ?? 0,
              };
            }
            break;
          case "message_start":
            if (json.message?.usage) {
              usage = {
                inputTokens: json.message.usage.input_tokens ?? 0,
                outputTokens: json.message.usage.output_tokens ?? 0,
              };
            }
            break;
          case "message_stop": {
            for (const [id, t] of tools) {
              if (!emittedToolIds.has(id)) {
                emittedToolIds.add(id);
                let args: Record<string, unknown> = {};
                try {
                  args = t.input ? JSON.parse(t.input) : {};
                } catch {
                  args = {};
                }
                yield { type: "toolCall", toolCall: { index: 0, id, name: t.name, argumentsDelta: JSON.stringify(args) } };
              }
            }
            yield { type: "done", usage };
            return;
          }
          case "error":
            yield { type: "error", error: json.error?.message ?? "unknown anthropic error" };
            return;
        }
      }
    }
    yield { type: "done", usage };
  }
}
