/**
 * Cost & token accounting (Aider /cost pattern).
 *
 * Tracks per-model input/output usage for a session and estimates cost using
 * the provider cost table (USD per 1M tokens) from the provider presets and
 * user config. Local providers (ollama/lmstudio/vllm) cost 0 by default, so
 * local-first users see $0.00 honestly.
 */

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export type UsageMap = Record<string, ModelUsage>;

export function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
}

export function addUsage(map: UsageMap, modelRef: string, inputTokens: number, outputTokens: number): void {
  const u = (map[modelRef] ??= emptyUsage());
  u.inputTokens += inputTokens;
  u.outputTokens += outputTokens;
  u.requests += 1;
}

export function totalUsage(map: UsageMap): ModelUsage {
  const t = emptyUsage();
  for (const u of Object.values(map)) {
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
    t.requests += u.requests;
  }
  return t;
}

/** Cost table lookup: "provider/model" -> USD per 1M in/out. */
export function costFor(
  table: Record<string, { in: number; out: number }>,
  modelRef: string
): { in: number; out: number } {
  const providerId = modelRef.split("/")[0] ?? "";
  return table[providerId] ?? { in: 0, out: 0 };
}

export function estimateCost(
  map: UsageMap,
  table: Record<string, { in: number; out: number }>
): number {
  let cents = 0;
  for (const [ref, u] of Object.entries(map)) {
    const c = costFor(table, ref);
    cents += (u.inputTokens / 1_000_000) * c.in + (u.outputTokens / 1_000_000) * c.out;
  }
  return cents;
}

/** Human-readable cost line, e.g. "$0.0423 · 12.4k in / 1.8k out · 14 requests". */
export function formatUsageLine(
  map: UsageMap,
  table: Record<string, { in: number; out: number }>
): string {
  const t = totalUsage(map);
  const cost = estimateCost(map, table);
  const kIn = t.inputTokens >= 1000 ? `${(t.inputTokens / 1000).toFixed(1)}k` : String(t.inputTokens);
  const kOut = t.outputTokens >= 1000 ? `${(t.outputTokens / 1000).toFixed(1)}k` : String(t.outputTokens);
  const dollars = cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
  return `${dollars} · ${kIn} in / ${kOut} out · ${t.requests} request${t.requests === 1 ? "" : "s"}`;
}

/** Multi-line per-model breakdown for /cost. */
export function formatUsageBreakdown(
  map: UsageMap,
  table: Record<string, { in: number; out: number }>
): string {
  const entries = Object.entries(map);
  if (entries.length === 0) return "(no usage recorded yet)";
  const lines: string[] = [];
  for (const [ref, u] of entries.sort()) {
    const c = costFor(table, ref);
    const modelCost = (u.inputTokens / 1_000_000) * c.in + (u.outputTokens / 1_000_000) * c.out;
    lines.push(
      `  ${ref.padEnd(28)} ${String(u.requests).padStart(4)} req  ${String(u.inputTokens).padStart(9)} in  ${String(u.outputTokens).padStart(8)} out  ~$${modelCost.toFixed(4)}`
    );
  }
  const t = totalUsage(map);
  lines.push(`  ${"TOTAL".padEnd(28)} ${String(t.requests).padStart(4)} req  ${String(t.inputTokens).padStart(9)} in  ${String(t.outputTokens).padStart(8)} out  ~$${estimateCost(map, table).toFixed(4)}`);
  return lines.join("\n");
}
