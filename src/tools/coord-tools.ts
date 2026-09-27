/**
 * Coordination tools: TodoWrite (plan tracking), Task (subagent spawning),
 * Memory (persistent notes) — the Claude Code / Hermes patterns, unified.
 */
import type { ToolDef, ToolResult } from "./types.js";
import { str } from "./types.js";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const TodoWriteTool: ToolDef = {
  name: "TodoWrite",
  description:
    "Maintain a structured task list for the current request. Call this BEFORE starting complex work " +
    "and after completing each step. Only one task should be in_progress at a time.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Full replacement list of todos",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable short id, e.g. '1' or '2-a'" },
            content: { type: "string", description: "Task description" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const todos = Array.isArray(input.todos) ? (input.todos as Array<{ id?: string; content: string; status: string }>) : [];
    const cleaned = todos
      .filter((t) => t && typeof t.content === "string" && STATUSES.has(t.status))
      .map((t, i) => ({ id: t.id ?? String(i + 1), content: t.content, status: t.status }));
    ctx.services.setTodoState(cleaned);
    const lines = cleaned.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.id}. ${t.content}`);
    return { output: `Todo list updated (${cleaned.length} items):\n${lines.join("\n") || "(empty)"}` };
  },
};

export const TaskTool: ToolDef = {
  name: "Task",
  description:
    "Launch a subagent with an isolated context window to handle a focused task autonomously. " +
    "Subagents cannot see your conversation — give them a complete, self-contained brief. " +
    "Types: 'explore' (fast read-only codebase search), 'plan' (implementation planning), " +
    "'general' (multi-step research or work). Returns the subagent's final report.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "3-5 word task summary" },
      prompt: { type: "string", description: "Complete, self-contained task brief for the subagent" },
      subagent_type: { type: "string", enum: ["explore", "plan", "general"], description: "Default: general" },
    },
    required: ["description", "prompt"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const type = str(input, "subagent_type", "general");
    const prompt = str(input, "prompt");
    const description = str(input, "description");
    if (!prompt) return { output: "Error: prompt is required", isError: true };
    ctx.onProgress?.(`spawning ${type} subagent: ${description}`);
    try {
      const result = await ctx.services.spawnSubagent(type, prompt, description);
      return { output: result };
    } catch (e) {
      return { output: `Error: subagent failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export const MemoryTool: ToolDef = {
  name: "Memory",
  description:
    "Persistent memory across sessions. Mode 'save' appends a durable note (decisions, preferences, " +
    "project facts). Mode 'search' retrieves relevant notes. Save anything worth remembering; " +
    "search before asking the user for information you may already know.",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["save", "search"], description: "save or search" },
      note: { type: "string", description: "(save) The note to remember" },
      query: { type: "string", description: "(search) What to look up" },
    },
    required: ["mode"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const mode = str(input, "mode");
    if (mode === "save") {
      const note = str(input, "note");
      if (!note) return { output: "Error: note is required for save mode", isError: true };
      await ctx.services.memoryAppend(note);
      return { output: "Saved to memory." };
    }
    const query = str(input, "query");
    if (!query) return { output: "Error: query is required for search mode", isError: true };
    const hits = await ctx.services.memorySearch(query);
    return { output: hits || "No relevant memories found." };
  },
};
