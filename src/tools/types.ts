/**
 * Tool contract. Every tool gets an immutable context and returns plain text
 * output — the model-visible surface is scrubbed and budgeted (tool-result
 * pruning happens at the compaction seam, not here).
 */
import type { SafetyContext } from "../safety/safety.js";
import type { Config } from "../config/config.js";

export interface ToolResult {
  /** text returned to the model */
  output: string;
  /** mark as error (models treat errors differently) */
  isError?: boolean;
  /** extra display payload kept out of model context */
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  workspace: string;
  cfg: Config;
  safety: SafetyContext;
  signal?: AbortSignal;
  /** emit progress to the UI (not to the model) */
  onProgress?: (line: string) => void;
  /** runtime services injected by the agent */
  services: {
    spawnSubagent: (agentType: string, prompt: string, description: string) => Promise<string>;
    todoState: () => Array<{ id: string; content: string; status: string }>;
    setTodoState: (todos: Array<{ id?: string; content: string; status: string }>) => void;
    memoryAppend: (note: string) => Promise<void>;
    memorySearch: (query: string) => Promise<string>;
    /** checkpoint a file before it is mutated (Cline pattern); optional */
    beforeFileWrite?: (file: string) => void;
    /** syntax-lint a file after Write/Edit; returns error text or null (SWE-agent ACI) */
    afterFileWrite?: (file: string) => string | null;
    /** mark a file dirty for the turn-end git auto-commit (Aider pattern) */
    markDirty?: (file: string) => void;
  };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** read-only tools never need approval and run in plan mode */
  readOnly?: boolean;
  /** tools that modify state; default true for non-readOnly */
  mutates?: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function str(input: Record<string, unknown>, key: string, fallback = ""): string {
  const v = input[key];
  return typeof v === "string" ? v : fallback;
}

export function num(input: Record<string, unknown>, key: string, fallback: number): number {
  const v = input[key];
  return typeof v === "number" ? v : fallback;
}

export function bool(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = input[key];
  return typeof v === "boolean" ? v : fallback;
}
