/**
 * Custom slash commands (Gemini CLI / Claude Code pattern): drop markdown
 * files in .zcode-ultra/commands/ (or ~/.zcode-ultra/commands/ for global)
 * and they become chat commands — in the REPL and on Discord/WhatsApp.
 *
 *   .zcode-ultra/commands/review.md
 *     ---
 *     Review the changes in $ARGUMENTS for bugs and security issues...
 *
 * `/review src/auth.ts` -> prompt with $ARGUMENTS substituted. Workspace
 * commands shadow global ones with the same name.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CustomCommand {
  name: string;
  prompt: string;
  source: "workspace" | "global";
  file: string;
}

export function loadCustomCommands(workspace: string): CustomCommand[] {
  const map = new Map<string, CustomCommand>();
  collect(map, path.join(os.homedir(), ".zcode-ultra", "commands"), "global", false);
  collect(map, path.join(workspace, ".zcode-ultra", "commands"), "workspace", true);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function collect(map: Map<string, CustomCommand>, dir: string, source: "workspace" | "global", override: boolean): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      const name = f.slice(0, -3).toLowerCase().replace(/[^a-z0-9-_]/g, "-");
      if (!name) continue;
      if (map.has(name) && !override) continue;
      const text = fs.readFileSync(path.join(dir, f), "utf8").trim();
      if (!text) continue;
      map.set(name, { name, prompt: text, source, file: path.join(dir, f) });
    }
  } catch {
    /* best-effort */
  }
}

/** Expand "$ARGUMENTS" (or fallback $1/$2...) in a command template. */
export function expandCommand(cmd: CustomCommand, args: string): string {
  return cmd.prompt.replace(/\$ARGUMENTS/g, args).replace(/\$0/g, args);
}

/** Match "/name rest..." against the command list; null when not a custom command. */
export function matchCommand(commands: CustomCommand[], input: string): { cmd: CustomCommand; expanded: string } | null {
  const m = /^\/([a-z0-9-_]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  const cmd = commands.find((c) => c.name === m[1]);
  if (!cmd) return null;
  return { cmd, expanded: expandCommand(cmd, (m[2] ?? "").trim()) };
}
