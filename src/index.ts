#!/usr/bin/env node
/**
 * ZCode Ultra CLI entrypoint.
 *
 *   zcode-ultra                      interactive REPL (default)
 *   zcode-ultra exec "prompt"        headless one-shot run
 *   zcode-ultra watch                watch mode: AI: comment triggers (aider)
 *   zcode-ultra resume [id]          resume the latest (or given) session
 *   zcode-ultra bot discord          start the Discord bot
 *   zcode-ultra bot whatsapp         start the WhatsApp bot (baileys|cloud)
 *   zcode-ultra setup                guided provider + bot configuration
 *   zcode-ultra doctor               environment sanity check
 *   zcode-ultra config get|set|list  manage ~/.zcode-ultra/config.json
 *   zcode-ultra sessions [id]        list / inspect sessions
 *   zcode-ultra undo                 revert the last agent git commit
 */
import path from "node:path";
import { loadConfig, saveGlobalConfig, resolveModelRef, DEFAULT_CONFIG, BUILTIN_PROVIDERS, configDirExample, type Config } from "./config/config.js";
import { Session } from "./core/session.js";
import { runRepl, resolveWorkspace, terminalApproval } from "./ui/repl.js";
import { runExec } from "./cli/exec.js";
import { VERSION, colors as C, errMessage, dataHome, atomicWrite } from "./util.js";
import { dockerAvailable, MODE_INFO } from "./safety/safety.js";
import { memoryAppend } from "./memory/memory.js";
import { undoLastAgentCommit } from "./core/git.js";
import { formatUsageLine } from "./core/cost.js";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["json", "plan", "yolo", "help", "version", "sandbox", "accept-edits", "no-open", "cloud", "no-strip"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        // explicit "true"/"false" values allowed, otherwise bare boolean
        const next = argv[i + 1];
        if (next === "true" || next === "false") {
          flags[key] = next === "true";
          i++;
        } else flags[key] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length === 2 && a !== "-") {
      const map: Record<string, string> = { p: "workspace", m: "model", s: "session", t: "timeout" };
      const key = map[a.slice(1)] ?? a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function applyFlagOverrides(cfg: Config, flags: Args["flags"]): Config {
  if (typeof flags.model === "string") cfg.model = flags.model;
  if (typeof flags.permission === "string") cfg.permissionMode = flags.permission as Config["permissionMode"];
  if (flags.yolo === true) cfg.permissionMode = "yolo";
  if (flags["accept-edits"] === true) cfg.permissionMode = "acceptEdits";
  if (flags.sandbox === true) cfg.sandbox = "docker";
  else if (typeof flags.sandbox === "string") cfg.sandbox = flags.sandbox as Config["sandbox"];
  if (typeof flags.fallback === "string") cfg.fallbackModels = flags.fallback.split(",").map((s) => s.trim()).filter(Boolean);
  else if (Array.isArray(flags.fallback)) cfg.fallbackModels = (flags.fallback as unknown) as string[];
  if (typeof flags["max-turns"] === "string") cfg.maxTurns = parseInt(flags["max-turns"], 10) || cfg.maxTurns;
  return cfg;
}

function help(): string {
  return `ZCode Ultra v${VERSION} — a lean, multi-provider, bot-native coding agent

USAGE
  zcode-ultra [options]                 interactive REPL
  zcode-ultra exec "<prompt>"           one-shot headless run (CI/bots)
  zcode-ultra watch                     watch mode: "// AI: do X" comments invoke the agent
  zcode-ultra resume [id]               resume the latest (or given) session in the REPL
  zcode-ultra bot discord               start Discord bot (slash + streaming)
  zcode-ultra bot whatsapp [--cloud]    start WhatsApp bot (Baileys QR or Cloud API)
  zcode-ultra setup                     guided configuration wizard
  zcode-ultra doctor                    check environment + providers
  zcode-ultra undo                      git-revert the last agent commit (aider /undo)
  zcode-ultra config get <key> | config set <key> <json> | config list
  zcode-ultra sessions [id]             list sessions / show a transcript
  zcode-ultra memory "note"             append a memory note
  zcode-ultra version | --help

OPTIONS
  -p, --workspace <dir>     project directory (default: cwd)
  -m, --model <ref>         provider/model, e.g. zai/glm-4.6, deepseek/deepseek-chat
      --fallback <refs>     comma-separated fallback chain
      --plan                plan mode (read-only research + plan output)
      --yolo                auto-approve everything (use with --sandbox)
      --accept-edits        auto-approve file edits only
      --sandbox             run Bash inside a Docker sandbox
  -s, --session <id>        resume session
      --max-turns <n>       agent loop safety cap (default 60)
  -t, --timeout <ms>        exec mode hard timeout
      --json                exec mode: JSON output (includes usage + cost)
      --no-strip            watch mode: keep trigger comments after runs
  -h, --help                show this help`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.positional[0] ?? "";

  if (cmd === "--help" || cmd === "-h" || cmd === "help" || args.flags.help === true) {
    console.log(help());
    return;
  }
  if (cmd === "version" || args.flags.version === true) {
    console.log(`zcode-ultra v${VERSION}`);
    return;
  }

  const workspace = resolveWorkspace(typeof args.flags.workspace === "string" ? args.flags.workspace : undefined);
  const { config: loadedCfg } = loadConfig(workspace);
  const cfg = applyFlagOverrides(loadedCfg, args.flags);

  switch (cmd) {
    case "": {
      const planMode = args.flags.plan === true || cfg.permissionMode === "plan";
      const session = typeof args.flags.session === "string" ? (Session.load(args.flags.session) ?? new Session(workspace, cfg.model)) : new Session(workspace, cfg.model);
      await runRepl({ cfg, workspace, planMode, session });
      break;
    }
    case "resume": {
      const id = args.positional[1] ?? Session.list()[0]?.id;
      if (!id) {
        console.error("No sessions found. Start one with: zcode-ultra");
        process.exit(1);
      }
      const s = Session.load(id);
      if (!s) {
        console.error(`Session not found: ${id}`);
        process.exit(1);
      }
      const planMode = args.flags.plan === true || cfg.permissionMode === "plan";
      console.log(C.dim(`resuming ${s.id} — ${s.meta.title} (${s.history.length} messages)`));
      await runRepl({ cfg, workspace, planMode, session: s });
      break;
    }
    case "watch": {
      const { runWatch } = await import("./cli/watch.js");
      await runWatch({
        workspace,
        noStrip: args.flags["no-strip"] === true,
        triggers: typeof args.flags.triggers === "string" ? args.flags.triggers.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      break;
    }
    case "undo": {
      const r = await undoLastAgentCommit(workspace, cfg.git.commitPrefix || "zcu");
      console.log(r.ok ? C.green(r.detail) : C.yellow(r.detail));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "exec": {
      const prompt = args.positional.slice(1).join(" ") || (typeof args.flags.prompt === "string" ? args.flags.prompt : "");
      if (!prompt) {
        console.error('Usage: zcode-ultra exec "<prompt>"');
        process.exit(64);
      }
      const planMode = args.flags.plan === true;
      const exit = await runExec({
        cfg,
        workspace,
        prompt,
        planMode,
        json: args.flags.json === true,
        sessionId: typeof args.flags.session === "string" ? args.flags.session : undefined,
        maxTurns: cfg.maxTurns,
        timeoutMs: typeof args.flags.timeout === "string" ? parseInt(args.flags.timeout, 10) : undefined,
      });
      process.exit(exit);
      break;
    }
    case "bot": {
      const which = args.positional[1] ?? "";
      if (which === "discord") {
        const { startDiscordBot } = await import("./bots/discord.js");
        await startDiscordBot({ cfg, workspace, args });
      } else if (which === "whatsapp") {
        const { startWhatsAppBot } = await import("./bots/whatsapp.js");
        await startWhatsAppBot({ cfg, workspace, args });
      } else {
        console.error("Usage: zcode-ultra bot <discord|whatsapp>");
        process.exit(64);
      }
      break;
    }
    case "setup": {
      const { runSetup } = await import("./cli/setup.js");
      await runSetup(cfg);
      break;
    }
    case "doctor": {
      await doctor(cfg, workspace);
      break;
    }
    case "config": {
      configCmd(args, cfg);
      break;
    }
    case "sessions": {
      const id = args.positional[1];
      if (id) {
        const s = Session.load(id);
        if (!s) {
          console.error(`Session not found: ${id}`);
          process.exit(1);
        }
        console.log(JSON.stringify({ meta: s.meta, messages: s.history }, null, 2));
      } else {
        const list = Session.list();
        for (const s of list) {
          const usage = s.usage ?? {};
          console.log(`${C.cyan(s.id)}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${C.dim(`${s.totalTokens} tok`)}  ${C.dim(formatUsageLine(usage, costTable(cfg)))}  ${s.title}`);
        }
        if (list.length === 0) console.log("(no sessions yet)");
      }
      break;
    }
    case "memory": {
      const note = args.positional.slice(1).join(" ");
      if (!note) {
        console.error('Usage: zcode-ultra memory "note to remember"');
        process.exit(64);
      }
      memoryAppend(note);
      console.log(C.green("saved."));
      break;
    }
    default:
      console.log(help());
      if (cmd) console.error(`\nUnknown command: ${cmd}`);
      process.exit(cmd ? 64 : 0);
  }
}

function costTable(cfg: Config): Record<string, { in: number; out: number }> {
  const table: Record<string, { in: number; out: number }> = {};
  for (const [id, p] of Object.entries({ ...BUILTIN_PROVIDERS, ...cfg.providers })) {
    if (p.cost) table[id] = p.cost;
  }
  return table;
}

async function doctor(cfg: Config, workspace: string): Promise<void> {
  console.log(`${C.bold("ZCode Ultra doctor")} v${VERSION}\n`);
  const checks: Array<[string, boolean | string, string]> = [];
  checks.push(["Node.js >= 20.10", parseInt(process.versions.node, 10) >= 20, process.versions.node]);
  const primary = cfg.model.split("/")[0]!;
  let keyOk = false;
  let keyDetail = "";
  try {
    const r = resolveModelRef(cfg, cfg.model);
    keyOk = Boolean(r.apiKey) || /^(ollama|lmstudio|vllm)$/.test(primary);
    keyDetail = keyOk ? "key found" : `missing API key (${primary})`;
  } catch (e) {
    keyDetail = errMessage(e);
  }
  checks.push([`Primary provider "${primary}"`, keyOk, keyDetail]);
  checks.push(["Docker (optional sandbox)", dockerAvailable(), dockerAvailable() ? "available" : "not found — sandbox mode unavailable"]);
  checks.push(["Discord bot", process.env[cfg.discord.tokenEnv] ? "token present" : false, cfg.discord.enabled ? "enabled" : "disabled — see docs/DISCORD.md"]);
  checks.push(["WhatsApp bot", cfg.whatsapp.enabled, cfg.whatsapp.mode === "off" ? "off — see docs/WHATSAPP.md" : `mode: ${cfg.whatsapp.mode}`]);
  checks.push(["Data dir", true, dataHome()]);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    const passed = ok === true || ok === "token present";
    const mark = passed ? C.green("✓") : C.yellow("·");
    if (!passed) failed++;
    console.log(`  ${mark} ${name}  ${C.dim(String(detail))}`);
  }
  console.log(`\n  config: ${configDirExample()}`);
  console.log(`  mode: ${cfg.permissionMode} — ${MODE_INFO[cfg.permissionMode]}`);
  if (failed > 2) console.log(`\n${C.yellow("Run")} zcode-ultra setup ${C.yellow("to configure providers.")}`);
}

function configCmd(args: Args, cfg: Config): void {
  const sub = args.positional[1] ?? "list";
  if (sub === "list") {
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  if (sub === "get") {
    const key = args.positional[2] ?? "";
    const val = key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), cfg);
    console.log(JSON.stringify(val, null, 2));
    return;
  }
  if (sub === "set") {
    const key = args.positional[2];
    const rawVal = args.positional.slice(3).join(" ");
    if (!key || !rawVal) {
      console.error("Usage: zcode-ultra config set <dotted.key> <json-or-string>");
      process.exit(64);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawVal);
    } catch {
      parsed = rawVal;
    }
    const target: Record<string, unknown> = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    const keys = key.split(".");
    let node = target;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]!] = parsed;
    const saved = saveGlobalConfig(target as unknown as Config);
    console.log(C.green(`saved to ${saved}`));
    return;
  }
  if (sub === "providers") {
    console.log("Built-in providers:\n");
    for (const [id, p] of Object.entries(BUILTIN_PROVIDERS) as Array<[string, NonNullable<Config["providers"][string]>]>) {
      console.log(`  ${C.cyan(id.padEnd(12))} ${p.model ?? ""}  ${C.dim(p.baseUrl)}`);
    }
    console.log(`\nSet keys via env (e.g. ZAI_API_KEY, DEEPSEEK_API_KEY) or config providers.<id>.apiKey`);
  }
}

main().catch((e) => {
  console.error(C.red(`fatal: ${errMessage(e)}`));
  process.exit(1);
});

// keep referenced imports used
void terminalApproval;
void path;
