/**
 * Compaction seam (DeepSeek-harness pattern, as a pluggable subsystem):
 * pressure-triggered summarization with tool-result pruning BEFORE asking
 * the model to summarize — cheap tokens first, then a distilled summary.
 */
import type { ChatMessage } from "../providers/types.js";
import { estimateTokens, truncate } from "../util.js";
import type { Config } from "../config/config.js";

/** Prune old tool results to a stub — the biggest context consumer.
 *  Messages matching cfg.compactPreserve regexes (OpenHands condenser
 *  preserve-list) are kept verbatim instead of being pruned. */
export function pruneToolResults(messages: ChatMessage[], keepRecent: number, preserve: RegExp[] = []): ChatMessage[] {
  const cut = Math.max(0, messages.length - keepRecent);
  return messages.map((m, i) => {
    if (i < cut && m.role === "tool") {
      const original = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (preserve.some((re) => re.test(original))) return m; // preserved verbatim
      return { ...m, content: `[pruned tool result: ${truncate(original, 80)}]` };
    }
    return m;
  });
}

export function compilePreserve(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      /* skip invalid pattern */
    }
  }
  return out;
}

export function estimateHistoryTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) total += estimateTokens(JSON.stringify(m.content));
    if (m.toolCalls) total += estimateTokens(JSON.stringify(m.toolCalls));
  }
  return total;
}

export interface CompactDecision {
  needed: boolean;
  reason: string;
}

export function shouldCompact(messages: ChatMessage[], cfg: Config): CompactDecision {
  if (!cfg.autoCompact) return { needed: false, reason: "disabled" };
  const est = estimateHistoryTokens(messages);
  if (est > cfg.compactThreshold) {
    return { needed: true, reason: `history ~${est.toLocaleString()} tokens > threshold ${cfg.compactThreshold.toLocaleString()}` };
  }
  return { needed: false, reason: `history ~${est.toLocaleString()} tokens` };
}

/** Build the summarization request shown to the model when compacting. */
export function compactionPrompt(history: ChatMessage[], keepRecent: number, preserve: RegExp[] = []): { summaryRequest: string; keep: ChatMessage[] } {
  const keep = history.slice(-keepRecent);
  const toSummarize = history.slice(0, Math.max(0, history.length - keepRecent));
  const pruned = pruneToolResults(toSummarize, 0, preserve);
  const transcript = pruned
    .map((m) => {
      const role = m.role.toUpperCase();
      let content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      content = truncate(content ?? "", 400);
      if (m.toolCalls?.length) content += ` [tool calls: ${m.toolCalls.map((t) => t.name).join(", ")}]`;
      return `${role}: ${content}`;
    })
    .join("\n")
    .slice(0, 90_000);

  const summaryRequest = `Your conversation history is being compacted. Below is the older portion of the conversation. Produce a dense working summary (max 600 words) with these sections:
- Goal: what the user asked for
- Done: completed work with file paths
- In progress: current state (exact file/line where work stopped)
- Key decisions: choices made and why
- Next steps: precisely what remains
- Context: errors hit, constraints, user preferences

OLDER CONVERSATION:
${transcript}`;
  return { summaryRequest, keep };
}
