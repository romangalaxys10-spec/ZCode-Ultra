/**
 * Tool registry — aggregates built-in tools, applies permission-mode
 * filtering (plan mode hides mutators) and exposes OpenAI/Anthropic specs.
 */
import type { ToolDef, ToolContext } from "./types.js";
import { ReadTool, WriteTool, EditTool, LSTool, GlobTool, GrepTool } from "./fs-tools.js";
import { BashTool, NotebookEditTool } from "./bash.js";
import { WebFetchTool, WebSearchTool } from "./web-tools.js";
import { TodoWriteTool, TaskTool, MemoryTool } from "./coord-tools.js";
import type { ToolSpec } from "../providers/types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Specs visible to the model for the current mode. */
  specs(planMode: boolean): ToolSpec[] {
    return [...this.tools.values()]
      .filter((t) => (planMode ? t.readOnly || t.name === "TodoWrite" || t.name === "Task" : true))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext) {
    const def = this.tools.get(name);
    if (!def) return { output: `Error: unknown tool "${name}". Available: ${this.names().join(", ")}`, isError: true };
    try {
      return await def.execute(input, ctx);
    } catch (e) {
      return { output: `Error: tool ${name} crashed: ${(e as Error).message}`, isError: true };
    }
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of [
    ReadTool, WriteTool, EditTool, LSTool, GlobTool, GrepTool,
    BashTool, NotebookEditTool,
    WebFetchTool, WebSearchTool,
    TodoWriteTool, TaskTool, MemoryTool,
  ]) {
    reg.register(t);
  }
  return reg;
}

export type { ToolContext };
