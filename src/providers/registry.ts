/**
 * Provider registry + resilient router.
 *
 * - Resolves "provider/model" refs against built-in presets + user config.
 * - Fallback chains (user pattern: ["deepseek/deepseek-chat", ...]) are tried
 *   in order on retryable failures (429/5xx/network) — a lightweight version
 *   of the DeepSeek-harness "capability seam" for providers.
 */
import type { CompletionRequest, DeltaEvent, ProviderClient, Usage } from "./types.js";
import { ProviderError } from "./types.js";
import { OpenAICompatClient } from "./openai-compat.js";
import { AnthropicClient } from "./anthropic.js";
import { resolveModelRef, type Config } from "../config/config.js";
import { estimateTokens } from "../util.js";

export function makeClient(cfg: Config, ref: string): { client: ProviderClient; providerId: string; model: string; cost?: { in: number; out: number } } {
  const r = resolveModelRef(cfg, ref);
  if (r.protocol === "anthropic") {
    return {
      client: new AnthropicClient(r.baseUrl, r.apiKey, r.headers, r.providerId),
      providerId: r.providerId,
      model: r.model,
      cost: r.extra.cost,
    };
  }
  return {
    client: new OpenAICompatClient(r.baseUrl, r.apiKey, r.headers, r.providerId),
    providerId: r.providerId,
    model: r.model,
    cost: r.extra.cost,
  };
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; rawArguments?: string }>;
  usage: Usage;
  /** the "provider/model" ref that actually served this completion */
  modelRef?: string;
}

export interface RouterOptions {
  cfg: Config;
  /** refs tried in order; first entry is the primary model */
  chain: string[];
  /** per-attempt retry with backoff for retryable errors */
  retriesPerModel?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Stream one model, normalizing tool-call accumulation, with retries. */
async function streamOnce(opts: RouterOptions, ref: string, req: CompletionRequest): Promise<TurnResult> {
  const { client, providerId, model } = makeClient(opts.cfg, ref);
  const retries = opts.retriesPerModel ?? 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    try {
      let text = "";
      const toolBuf = new Map<number, { id?: string; name?: string; args: string }>();
      let usage: Usage = { inputTokens: estimateTokens(JSON.stringify(req.messages)), outputTokens: 0 };

      for await (const ev of client.stream({ ...req, model, signal: opts.signal })) {
        if (ev.type === "text" && ev.text) {
          text += ev.text;
          opts.onText?.(ev.text);
        } else if (ev.type === "toolCall" && ev.toolCall) {
          const idx = ev.toolCall.index;
          const acc = toolBuf.get(idx) ?? { args: "" };
          if (ev.toolCall.id) acc.id = ev.toolCall.id;
          if (ev.toolCall.name) acc.name = ev.toolCall.name;
          if (ev.toolCall.argumentsDelta) acc.args += ev.toolCall.argumentsDelta;
          toolBuf.set(idx, acc);
        } else if (ev.type === "done" && ev.usage) {
          usage = ev.usage;
        } else if (ev.type === "error") {
          throw new ProviderError(ev.error ?? "provider stream error", undefined, providerId);
        }
      }

      const toolCalls = [...toolBuf.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, t]) => {
          let arguments_: Record<string, unknown> = {};
          try {
            arguments_ = t.args.trim() ? JSON.parse(t.args) : {};
          } catch {
            arguments_ = { _raw: t.args };
          }
          return { id: t.id ?? `call_${idx}_${Date.now()}`, name: t.name ?? "unknown", arguments: arguments_, rawArguments: t.args };
        });

      return { text, toolCalls, usage };
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ProviderError ? e.retryable : false;
      if (opts.signal?.aborted || !retryable || attempt === retries) break;
    }
  }
  throw lastErr;
}

/**
 * Route a completion across the fallback chain.
 * Throws AggregateError-ish message if every model in the chain fails.
 */
export async function routeCompletion(opts: RouterOptions, req: CompletionRequest): Promise<TurnResult> {
  const chain = opts.chain.filter(Boolean);
  if (chain.length === 0) throw new Error("Empty model chain — set config.model");
  const errors: string[] = [];
  for (const ref of chain) {
    try {
      const result = await streamOnce(opts, ref, req);
      return { ...result, modelRef: ref };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const msg = `${ref}: ${(e as Error).message}`;
      errors.push(msg);
    }
  }
  throw new Error(`All models failed.\n${errors.map((e) => ` - ${e}`).join("\n")}`);
}
