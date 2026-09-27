/**
 * Background tasks (Claude Code run_in_background + OpenHands long-running
 * commands pattern): the Bash tool can start a command in the background and
 * return immediately; TaskOutput polls/collects output, TaskStop kills it.
 *
 * Registry is module-level: one Node process hosts one REPL/bot, tasks die
 * with the process. `stopAllTasks()` is called on agent shutdown.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { truncate } from "../util.js";
import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { str, num } from "./types.js";

export interface BgTask {
  id: string;
  command: string;
  workspace: string;
  status: "running" | "completed" | "failed" | "killed" | "timeout";
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  stdout: string;
  stderr: string;
  child: ChildProcess | null;
}

const tasks = new Map<string, BgTask>();
let seq = 0;
const MAX_TASKS = 50;
const MAX_CAPTURE = 200_000;

export function startTask(workspace: string, command: string, shellFile: string, shellArgs: string[], timeoutMs: number): BgTask {
  // prune finished tasks when over budget
  if (tasks.size >= MAX_TASKS) {
    for (const [id, t] of tasks) {
      if (t.status !== "running") tasks.delete(id);
      if (tasks.size < MAX_TASKS) break;
    }
  }
  seq += 1;
  const id = `bg_${seq}_${Date.now().toString(36)}`;
  const task: BgTask = {
    id,
    command,
    workspace,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    stdout: "",
    stderr: "",
    child: null,
  };
  tasks.set(id, task);

  try {
    const child = spawn(shellFile, [...shellArgs, command], {
      cwd: workspace,
      env: { ...process.env, ZCODE_ULTRA: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    task.child = child;
    child.stdout?.on("data", (d: Buffer) => {
      task.stdout = (task.stdout + d.toString()).slice(-MAX_CAPTURE);
    });
    child.stderr?.on("data", (d: Buffer) => {
      task.stderr = (task.stderr + d.toString()).slice(-MAX_CAPTURE);
    });
    child.on("close", (code, signalTerminated) => {
      task.finishedAt = Date.now();
      if (task.status === "killed") return;
      if (signalTerminated === "SIGTERM") {
        task.status = "timeout";
        task.exitCode = null;
        return;
      }
      task.exitCode = code;
      task.status = code === 0 ? "completed" : "failed";
    });
    child.on("error", () => {
      task.finishedAt = Date.now();
      task.status = "failed";
      task.exitCode = -1;
    });
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (task.status === "running") killTask(id, "timeout");
      }, timeoutMs).unref?.();
    }
  } catch (e) {
    task.status = "failed";
    task.exitCode = -1;
    task.stderr = String((e as Error).message);
    task.finishedAt = Date.now();
  }
  return task;
}

export function getTask(id: string): BgTask | undefined {
  return tasks.get(id);
}

export function killTask(id: string, reason: "killed" | "timeout" = "killed"): boolean {
  const t = tasks.get(id);
  if (!t) return false;
  if (t.status === "running") {
    t.status = reason;
    t.finishedAt = Date.now();
    try {
      t.child?.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (t.child?.exitCode === null) t.child?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    } catch {
      /* ignore */
    }
  }
  return true;
}

export function stopAllTasks(): void {
  for (const id of [...tasks.keys()]) killTask(id);
}

function renderTask(t: BgTask, maxOutput = 6000): string {
  const dur = ((t.finishedAt ?? Date.now()) - t.startedAt) / 1000;
  const lines = [
    `task ${t.id}`,
    `status: ${t.status}${t.exitCode !== null ? ` (exit ${t.exitCode})` : ""} after ${dur.toFixed(1)}s`,
    `command: ${truncate(t.command, 200)}`,
  ];
  const out = t.stdout.trim();
  const err = t.stderr.trim();
  if (out) lines.push(`--- stdout ---\n${truncate(out, maxOutput)}`);
  if (err) lines.push(`--- stderr ---\n${truncate(err, Math.floor(maxOutput / 2))}`);
  if (!out && !err && t.status === "running") lines.push("(no output yet — poll again with TaskOutput)");
  return lines.join("\n");
}

/** Tool definitions: poll output / stop background tasks. */
export const TaskOutputTool: ToolDef = {
  name: "TaskOutput",
  description:
    "Retrieve output and status of a background task started with the Bash tool (run_in_background=true). " +
    "Returns current status (running/completed/failed), exit code when finished, and captured stdout/stderr. " +
    "Poll repeatedly while a task is still running.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id returned by the Bash tool, e.g. bg_1_abc" },
      max_output: { type: "number", description: "Max output characters (default 6000)" },
    },
    required: ["task_id"],
  },
  async execute(input): Promise<ToolResult> {
    const id = str(input, "task_id").trim();
    const t = getTask(id);
    if (!t) {
      const known = [...tasks.keys()].slice(-5).join(", ");
      return { output: `Error: unknown task "${id}".${known ? ` Recent tasks: ${known}` : ""}`, isError: true };
    }
    return { output: renderTask(t, Math.min(20_000, Math.max(500, num(input, "max_output", 6000)))) };
  },
};

export const TaskStopTool: ToolDef = {
  name: "TaskStop",
  description: "Stop (kill) a running background task started with the Bash tool (run_in_background=true).",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id to stop" },
    },
    required: ["task_id"],
  },
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const id = str(input, "task_id").trim();
    const t = getTask(id);
    if (!t) return { output: `Error: unknown task "${id}"`, isError: true };
    if (t.status !== "running") return { output: `Task ${id} already finished (status: ${t.status}).` };
    killTask(id);
    ctx.onProgress?.(`stopped ${id}`);
    return { output: `Task ${id} stopped.` };
  },
};

export const bgRender = renderTask;
export const bgRegistry = tasks;

/** Start a background task using the same shell policy as the Bash tool. */
export async function startTaskWithShell(
  workspace: string,
  command: string,
  shellForWindows: () => Promise<{ file: string; args: string[] }>,
  timeoutMs: number
): Promise<BgTask> {
  const shell = process.platform === "win32" ? await shellForWindows() : { file: "/bin/bash", args: ["-c"] };
  return startTask(workspace, command, shell.file, shell.args, timeoutMs);
}
